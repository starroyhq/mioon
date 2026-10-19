import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {readToolsQaAudit} from './agent-tools-qa-audit.mjs';
import {startToolsQaMock, TOOLS_QA_HOSTILE_MARKER} from './agent-tools-qa-mock.mjs';
import {streamAgentResponse, buildAgentRequest} from '../packages/business/src/agent/agent-gateway.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-tools-qa-')), mock = await startToolsQaMock({directory, delayMs: 0, ...options});
  t.after(async () => { await mock.close(); await rm(directory, {recursive: true, force: true}); });
  return {directory, mock, configuration: protocol => ({protocol, presetId: 'ollama', platformId: 'local', baseUrl: mock.baseUrl, model: 'qwen3:8b'})};
}
const messages = prompt => [{role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: prompt}];
async function collect(options) { const events = []; for await (const event of streamAgentResponse({...options, selfPort: 4318})) events.push(event); return events; }
function answer(done, operation, data) { return {phase: 'answer', toolCall: done.toolCall, providerOutput: done.providerOutput, result: JSON.stringify({kind: 'untrusted_project_inspection', projectId: 'synthetic-project-id', operation, data})}; }
async function waitFor(predicate) { for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(5); } throw Error('Synthetic fixture did not reach expected boundary'); }

for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: QA mock requests each real function wire and final text reflects the supplied observation`, async t => {
    const {mock, configuration} = await fixture(t);
    for (const operation of ['project', 'asset', 'shot', 'timeline']) {
      const options = {configuration: configuration(protocol), messages: messages(`mock:${operation} synthetic QA`), readTools: {phase: 'request'}};
      const done = (await collect(options)).at(-1); assert.equal(done.toolCall.name, `mioon_${operation}_inspect`);
      assert.equal(done.finishReason, 'tool_calls');
      const data = operation === 'project' ? {name: 'Actual synthetic saved project 🎬', counts: {assets: 3, shots: 2}} : operation === 'timeline' ? null : {items: [{name: `Actual saved ${operation} marker`}], nextCursor: null};
      const final = await collect({...options, readTools: answer(done, `${operation}.inspect`, data)});
      const text = final.filter(event => event.type === 'delta').map(event => event.text).join('');
      assert.ok(text.includes('本地模拟服务，无真实模型调用')); assert.ok(text.includes(JSON.stringify(data))); assert.equal(final.at(-1).finishReason, 'stop');
      assert.equal(mock.snapshot().requests.at(-1).phase, 'answer');
    }
    await waitFor(() => mock.snapshot().closeCount === 8);
    assert.equal(mock.snapshot().calls, 8); assert.equal(mock.snapshot().active, 0);
  });
  test(`${protocol}: typed and explicit no-call requests never invent project access`, async t => {
    const {mock, configuration} = await fixture(t);
    for (const mode of ['typed', 'nocall', 'hostile']) {
      const events = await collect({configuration: configuration(protocol), messages: messages(`mock:${mode}`), ...(mode === 'typed' ? {} : {readTools: {phase: 'request'}})});
      assert.equal(events.at(-1).toolCall, undefined);
      const text = events.filter(event => event.type === 'delta').map(event => event.text).join('');
      assert.ok(text.includes('没有读取项目'));
      if (mode === 'hostile') assert.ok(text.includes('<img src='));
    }
    assert.equal(mock.snapshot().calls, 3);
  });
  test(`${protocol}: invalid scope, unknown function, provider error and incomplete request are genuine safe adapter failures`, async t => {
    const {mock, configuration} = await fixture(t);
    for (const [mode, code] of [['invalidforeignargs', 'AGENT_CHAT_PROTOCOL_ERROR'], ['unknown', 'AGENT_CHAT_TOOLS_UNSUPPORTED'], ['error', 'AGENT_CHAT_PROVIDER_ERROR'], ['incomplete', 'AGENT_CHAT_TRUNCATED']]) {
      await assert.rejects(collect({configuration: configuration(protocol), messages: messages(`mock:${mode}`), readTools: {phase: 'request'}}), {code});
    }
    assert.equal(mock.snapshot().calls, 4); assert.equal(mock.snapshot().requests.every(record => record.phase === 'request'), true);
  });
  test(`${protocol}: Stop during fragmented first tool and partial second answer closes the actual sockets`, async t => {
    const {mock, configuration} = await fixture(t);
    const controller = new AbortController(), options = {configuration: configuration(protocol), messages: messages('mock:toolsfragmenthold'), readTools: {phase: 'request'}, signal: controller.signal};
    const first = collect(options); await waitFor(() => mock.snapshot().active === 1); controller.abort();
    await assert.rejects(first, {code: 'AGENT_CHAT_ABORTED'}); await waitFor(() => mock.snapshot().closeCount === 1);
    const next = {...options, messages: messages('mock:slowanswer'), signal: undefined};
    const done = (await collect(next)).at(-1), stop = new AbortController(), events = [];
    await assert.rejects(async () => { for await (const event of streamAgentResponse({...next, readTools: answer(done, 'project.inspect', {name: 'Saved value'}), signal: stop.signal, selfPort: 4318})) { events.push(event); stop.abort(); } }, {code: 'AGENT_CHAT_ABORTED'});
    assert.equal(events.length, 1); assert.equal(events[0].type, 'delta'); await waitFor(() => mock.snapshot().active === 0);
    assert.equal(mock.snapshot().calls, 3); assert.equal(mock.snapshot().closeCount, 3);
  });
  test(`${protocol}: explicit hold releases preserve function completion and native result linkage`, async t => {
    const {mock, configuration} = await fixture(t), options = {configuration: configuration(protocol), messages: messages('mock:slowfirst'), readTools: {phase: 'request'}};
    const pending = collect(options); await waitFor(() => mock.snapshot().active === 1); await mock.release('first');
    const done = (await pending).at(-1); assert.equal(done.toolCall.name, 'mioon_project_inspect');
    const next = {...options, messages: messages('mock:slowanswer'), readTools: answer(done, 'project.inspect', {name: 'Released saved result'})};
    const final = collect(next); await waitFor(() => mock.snapshot().requests.some(record => record.phase === 'answer')); await mock.release('answer');
    const events = await final; assert.equal(events.at(-1).finishReason, 'stop'); assert.ok(events.some(event => event.text?.includes('Released saved result')));
  });
}

test('QA logs retain exact body hash and safe marker booleans, never body contents, result text or keys', async t => {
  const {mock, directory, configuration} = await fixture(t);
  const options = {configuration: configuration('responses'), messages: messages('mock:hostileresult private-body-marker'), readTools: {phase: 'request'}, apiKey: 'synthetic-do-not-log-key'};
  const done = (await collect(options)).at(-1), readTools = answer(done, 'project.inspect', {name: TOOLS_QA_HOSTILE_MARKER, description: 'private-result-marker'});
  const text = (await collect({...options, readTools})).filter(event => event.text).map(event => event.text).join('');
  assert.ok(text.includes(TOOLS_QA_HOSTILE_MARKER)); assert.ok(text.includes('<img src=')); assert.ok(text.includes('private-result-marker'));
  await waitFor(() => mock.snapshot().closeCount === 2);
  const records = mock.snapshot().requests, expected = createHash('sha256').update(buildAgentRequest(options).body).digest('hex');
  assert.equal(records[0].requestHash, expected); assert.equal(records[0].authorizationPresent, true); assert.equal(records[0].containsInspectionMarker, false);
  assert.equal(records[1].containsInspectionMarker, true); assert.equal(records[1].containsInspectionResult, true);
  const log = await readFile(path.join(directory, 'mock-requests.jsonl'), 'utf8');
  for (const privateValue of ['private-body-marker', 'private-result-marker', 'synthetic-do-not-log-key', TOOLS_QA_HOSTILE_MARKER]) assert.equal(log.includes(privateValue), false);
});

test('tools QA plumbing is additive and leaves existing chat/Responses/durable fixture defaults available', async () => {
  const runtime = await readFile(new URL('./agent-chat-qa-runtime.mjs', import.meta.url), 'utf8');
  const native = await readFile(new URL('./agent-chat-qa-native.mjs', import.meta.url), 'utf8');
  const client = await readFile(new URL('./agent-chat-qa-client.mjs', import.meta.url), 'utf8');
  for (const source of [runtime, native]) { assert.ok(source.includes("process.argv.includes('--tools')")); assert.ok(source.includes('toolsQa ? startToolsQaMock : startChatQaMock')); }
  assert.ok(runtime.includes("toolsQa ? 'evidence/agent-tools'")); assert.ok(runtime.includes('toolsQa ? 4893 : durableQa ? 4892'));
  assert.ok(client.includes("['chat', 'responses', 'durable', 'tools']")); assert.ok(client.includes('releaseToolBoundary'));
});


test('readonly QA ledger projection correlates exact request/result hashes without exposing bodies', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.deepEqual(readToolsQaAudit(db), {runs: [], truncated: false});
    db.exec('CREATE TABLE agent_chat_runs(id TEXT, projectId TEXT, status TEXT, position INTEGER, data TEXT); CREATE TABLE agent_chat_steps(id TEXT, runId TEXT, kind TEXT, status TEXT, position INTEGER, data TEXT)');
    const provenance = {category: 'project_saved_text_metadata', projectId: 'project-1', sourceRunIds: []};
    db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?)').run('run-1', 'project-1', 'completed', 1, JSON.stringify({contextMode: 'project_inspection', provenance, modelRequestState: 'completed', userText: 'never expose private body'}));
    const body = '{"model":"synthetic","input":"never expose private body"}', resultJson = '{"data":{"name":"never expose private result"}}';
    const insert = db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?)');
    insert.run('model-1', 'run-1', 'model', 'completed', 1, JSON.stringify({ordinal: 1, request: {body}}));
    insert.run('tool-1', 'run-1', 'tool', 'completed', 2, JSON.stringify({ordinal: 1, observation: {resultJson}}));
    const before = db.prepare('SELECT data FROM agent_chat_steps ORDER BY position').all();
    const audit = readToolsQaAudit(db), run = audit.runs[0];
    assert.deepEqual(run.provenance, provenance); assert.equal(run.steps[0].bodyHash, createHash('sha256').update(body).digest('hex'));
    assert.equal(run.steps[1].resultHash, createHash('sha256').update(resultJson).digest('hex'));
    assert.equal(JSON.stringify(audit).includes('never expose private'), false); assert.deepEqual(db.prepare('SELECT data FROM agent_chat_steps ORDER BY position').all(), before);
    for (let index = 2; index < 203; index++) db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?)').run(`run-${index}`, 'project-1', 'completed', index, JSON.stringify({modelRequestState: 'completed'}));
    const bounded = readToolsQaAudit(db); assert.equal(bounded.runs.length, 200); assert.equal(bounded.truncated, true);
  } finally { db.close(); }
});
