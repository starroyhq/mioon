import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/db.mjs';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.mjs';
import {AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
// Only this owned synthetic process is killed. It has no network transport,
// real credentials, UI, or media work. Trace is outside the SQLite transaction
// so rollback cannot hide an inspection read that already happened.
const CHILD = String.raw`
import {createTestAuthorizations,authorizeTestScope} from './tests/helpers/agent-authorizations.mjs';
import {appendFileSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {openStore} from './packages/business/src/db.mjs';
import {createInspectionServices} from './packages/business/src/inspection.mjs';
import {createChatRuntime} from './packages/business/src/agent/chat-runtime.mjs';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE} from './packages/business/src/agent/settings.mjs';
import {deriveAgentEndpoint} from '@mioon/contracts';
const {FIXTURE_ROOT: root, FIXTURE_PROTOCOL: protocol, FIXTURE_BOUNDARY: boundary} = process.env;
const trace = entry => appendFileSync(path.join(root, 'trace.jsonl'), JSON.stringify(entry) + '\n');
const crash = where => { trace({kind: 'crash', where}); process.kill(process.pid, 'SIGKILL'); };
const store = openStore(root), projectId = randomUUID();
const project = {id: projectId, name: 'Synthetic crash fixture', description: 'Saved metadata', revision: 1};
store.put('projects', project);
const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
const configuration = {presetId: 'ollama', platformId: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', protocol};
await settings.put({expectedRevision: 0, configuration, secret: {action: 'remove'}});
const shared = createInspectionServices(store);
const inspection = {createContext: shared.createContext, dispatch(...args) {
  const value = shared.dispatch(...args); trace({kind: 'read', operation: args[1]});
  if (boundary === 'after-read-before-capture') crash(boundary);
  return value;
}};
const suppliedSettings = {get: (...args) => settings.get(...args), [AGENT_CREDENTIAL_ACQUIRE](...args) {
  trace({kind: 'acquire'}); return settings[AGENT_CREDENTIAL_ACQUIRE](...args);
}};
const gateway = async function* ({readTools}) {
  trace({kind: 'model', phase: readTools.phase});
  if (readTools.phase === 'answer') throw Error('Unexpected second model entry before crash boundary');
  const id = 'synthetic_call', name = 'mioon_project_inspect', argumentsJson = '{}';
  const toolCall = {id, name, arguments: {}, argumentsJson, ...(protocol === 'responses' ? {itemId: 'synthetic_item'} : {})};
  yield {type: 'done', finishReason: 'tool_calls', toolCall,
    providerOutput: protocol === 'chat_completions' ? {role: 'assistant', content: null,
      tool_calls: [{id, type: 'function', function: {name, arguments: argumentsJson}}]} :
      [{id: toolCall.itemId, type: 'function_call', call_id: id, name, arguments: argumentsJson, status: 'completed'}]};
};
const authorizations=createTestAuthorizations(store,settings);
await authorizeTestScope(authorizations,'project_inspection');
const runtime = createChatRuntime({store,authorizations, agentSettings: suppliedSettings, inspection, gateway, selfPort: () => 4318, mode: 'simulated'});
const originalTx = store.tx;
store.tx = operation => {
  const value = originalTx(operation);
  if (boundary === 'committed-intent' && store.db.prepare("SELECT 1 FROM agent_chat_steps WHERE kind='tool' AND status='intent'").get()) crash(boundary);
  if (boundary === 'before-continuation-post' && store.db.prepare("SELECT 1 FROM agent_chat_steps WHERE position=3 AND status='dispatch_started'").get()) crash(boundary);
  return value;
};
const snapshot = await runtime.snapshot(projectId), {available, ...policy} = snapshot.inspection;
if (!available) throw Error('Synthetic inspection profile unavailable');
const input = {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
  expectedConversationRevision: snapshot.revision, message: 'Inspect synthetic saved metadata',
  consent: {destination: deriveAgentEndpoint(configuration), protocol, model: configuration.model, context: 'project_inspection', projectId, ...policy}};
writeFileSync(path.join(root, 'receipt.json'), JSON.stringify({project, input}));
await runtime.send(projectId, input);
await new Promise((_, reject) => setTimeout(() => reject(Error('Crash boundary was not reached')), 10000));
`;

async function crashFixture(t, protocol, boundary) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-tool-crash-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {cwd,
    env: {...process.env, FIXTURE_ROOT: root, FIXTURE_PROTOCOL: protocol, FIXTURE_BOUNDARY: boundary}, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '', stdout = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; }); child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal})); });
  assert.equal(result.signal, 'SIGKILL', `owned fixture did not crash at ${boundary}: ${stderr}\n${stdout}`);
  const trace = () => readFileSync(path.join(root, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const receipt = JSON.parse(readFileSync(path.join(root, 'receipt.json'), 'utf8'));
  assert.equal(trace().at(-1).where, boundary);
  return {root, trace, ...receipt};
}

for (const protocol of ['chat_completions', 'responses']) for (const boundary of ['committed-intent', 'after-read-before-capture', 'before-continuation-post']) {
  test(`${protocol}: actual SIGKILL at ${boundary} preserves evidence and startup never resumes`, {timeout: 20000}, async t => {
    const f = await crashFixture(t, protocol, boundary), trace = f.trace();
    assert.equal(trace.filter(item => item.kind === 'acquire').length, 1);
    assert.equal(trace.filter(item => item.kind === 'model').length, 1);
    assert.equal(trace.filter(item => item.kind === 'read').length, boundary === 'committed-intent' ? 0 : 1);
    const store = openStore(f.root); t.after(() => store.close());
    const persisted = store.db.prepare('SELECT data FROM agent_chat_runs').get();
    const runBefore = JSON.parse(persisted.data);
    const stepsBefore = store.db.prepare('SELECT data FROM agent_chat_steps ORDER BY position').all().map(row => JSON.parse(row.data));
    assert.equal(runBefore.status, 'running'); assert.equal(stepsBefore[0].status, 'completed');
    assert.equal(stepsBefore[0].output.toolCall.id, 'synthetic_call');
    assert.equal(stepsBefore[1].status, boundary === 'committed-intent' ? 'intent' : boundary === 'after-read-before-capture' ? 'dispatch_started' : 'completed');
    assert.equal(Object.hasOwn(stepsBefore[1], 'observation'), boundary === 'before-continuation-post');
    if (boundary === 'before-continuation-post') {
      assert.equal(stepsBefore[2].status, 'dispatch_started'); assert.deepEqual(JSON.parse(stepsBefore[2].request.body).tools, []);
    }
    let acquisitions = 0, reads = 0, models = 0;
    const runtime = createChatRuntime({store, selfPort: () => 4318, mode: 'simulated',
      agentSettings: {get() { throw Error('No settings read required for replay'); }, [AGENT_CREDENTIAL_ACQUIRE]() { acquisitions++; throw Error('No recovery acquisition'); }},
      inspection: {createContext() { throw Error('No recovery scope'); }, dispatch() { reads++; throw Error('No recovery read'); }},
      gateway: async function* () { models++; throw Error('No recovery inference'); }});
    t.after(() => runtime.close());
    const found = runtime.lookup(f.project.id, f.input.requestId);
    assert.equal(found.run.status, 'interrupted'); assert.equal(found.run.modelRequestState, 'unknown');
    assert.equal(found.run.activity[1].status, boundary === 'before-continuation-post' ? 'completed' : 'unknown');
    if (boundary === 'before-continuation-post') assert.equal(found.run.activity[2].status, 'unknown');
    const events = [];
    runtime.subscribe(f.project.id, found.run.id, found.instanceId, 0, event => events.push(event));
    assert.equal(events.at(-1).run.status, 'interrupted'); assert.equal(events[0].run.activity[0].status, 'not_started');
    assert.equal(runtime.history(f.project.id).runs.length, 1);
    await assert.rejects(runtime.send(f.project.id, f.input), {code: 'AGENT_CHAT_SESSION_EXPIRED'});
    assert.equal(acquisitions, 0); assert.equal(reads, 0); assert.equal(models, 0); assert.deepEqual(f.trace(), trace);
    assert.deepEqual(store.get('projects', f.project.id), f.project);
    assert.equal(store.db.prepare('SELECT count(*) n FROM agent_chat_requests').get().n, 1);
    assert.equal(store.db.prepare('SELECT reservedBytes n FROM agent_chat_quota').get().n, 0);
  });
}
