import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createMioTestFixture} from './helpers/mio-runtime-fixture.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {selectTaskModelTools, sourceTaskModelToolLoadMode, sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME, AGENT_TASK_LOADABLE_TOOL_GROUP_IDS} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';

const worker = fileURLToPath(new URL('./helpers/mio-runtime-fault-worker.ts', import.meta.url));
const points = ['intent-before-commit', 'intent-after-commit', 'dispatch-before-commit', 'dispatch-after-commit', 'first-delta', 'completion-before-commit', 'completion-after-commit'] as const;
const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const;
function object(value: unknown): Record<string, AgentTaskJson> {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, AgentTaskJson>;}
function modelOutput(protocol: AgentProtocol, calls: AgentTaskToolCall[] = []): TaskModelOutput {
  const text = 'Synthetic tool response.';
  const providerOutput: AgentTaskJson = protocol === 'chat_completions'
    ? {role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}
    : protocol === 'responses'
      ? [{type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]}, ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'}))]
      : {role: 'assistant', content: [{type: 'text', text}, ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]};
  return {text, toolCalls: calls, providerOutput};
}
function tempRoot(t: {after: (callback: () => void) => void}, suffix: string): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), `mioon-r1-${suffix}-`));
  t.after(() => rmSync(root, {recursive: true, force: true})); return root;
}

for (const point of points) test(`SIGKILL at ${point} preserves a complete request lifecycle and never resends on reopen`, {timeout: 60_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-runtime-kill-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const marker = path.join(root, 'ready');
  // A synchronous file barrier stops inside the real transaction or gateway;
  // no child output stream is interpreted as a control protocol.
  const child = spawn(process.execPath, [worker], {stdio: ['ignore', 'ignore', 'inherit'], env: {...process.env, MIO_RUNTIME_ROOT: root, MIO_RUNTIME_POINT: point, MIO_RUNTIME_MARKER: marker}});
  const closed = once(child, 'close');
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    assert.equal(child.exitCode, null, 'The fault worker exited before its barrier');
    assert.equal(child.signalCode, null, 'The fault worker stopped before its barrier');
    assert.ok(Date.now() < deadline, `The runtime did not reach ${point}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  child.kill('SIGKILL');
  const [exitCode, signal] = await closed;
  assert.equal(exitCode, null); assert.equal(signal, 'SIGKILL');
  const store = openStore(root), records = createMioRecords(store);
  let runId = '';
  try {
    const runs = store.db.prepare('SELECT id FROM mio_runs').all();
    assert.equal(runs.length, 1); runId = String(runs[0]!.id);
    const steps = records.steps(runId), requests = store.db.prepare('SELECT id FROM mio_requests').all();
    if (point === 'intent-before-commit') {
      assert.equal(steps.length, 0); assert.equal(requests.length, 0);
    } else {
      assert.equal(steps.length, 1); assert.equal(requests.length, 1);
      const step = steps[0]!, request = records.request(String(requests[0]!.id));
      assert.equal(step.currentRequestId, request.id);
      if (point === 'completion-after-commit') {
        assert.equal(step.status, 'completed'); assert.equal(request.state, 'completed');
        assert.equal(request.originalBody, null); assert.equal(step.partialText, null);
        assert.ok(step.resultEntryId); assert.equal(records.entry(step.resultEntryId).kind, 'model_output');
      } else {
        assert.equal(request.state, ['intent-after-commit', 'dispatch-before-commit'].includes(point) ? 'intent' : 'dispatch_started');
        assert.ok(request.originalBody); assert.equal(step.resultEntryId, null);
        if (point === 'first-delta' || point === 'completion-before-commit') assert.match(step.partialText ?? '', /PARTIAL_CHECKPOINT_/u);
        if (existsSync(path.join(root, 'gateway-body.txt'))) assert.equal(request.originalBody, readFileSync(path.join(root, 'gateway-body.txt'), 'utf8'));
      }
    }
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM mio_entries WHERE runId=? AND kind=\'model_output\'').get(runId)!.count, point === 'completion-after-commit' ? 1 : 0);
    assert.equal(store.db.prepare('PRAGMA main.foreign_key_check').all().length, 0);
  } finally {store.close();}
  let dispatches = 0;
  const reopened = await createMioTestFixture(root, async function* () {dispatches++; throw new Error('Opening history must not dispatch');});
  try {
    await reopened.runtime.drain();
    assert.equal(dispatches, 0);
    const snapshot = reopened.runtime.get(reopened.store.projectId, runId);
    assert.equal(snapshot.run.status, point === 'completion-after-commit' ? 'completed' : 'interrupted');
    if (point !== 'intent-before-commit') {
      assert.equal(snapshot.steps[0]!.status, point === 'completion-after-commit' ? 'completed' : ['intent-after-commit', 'dispatch-before-commit'].includes(point) ? 'intent' : 'unknown');
    }
  } finally {await reopened.close();}
});

for (const protocol of protocols) test(`${protocol}: clearing a successful source body cannot authorize an undisclosed edit loaded in the same batch`, {timeout: 30_000}, async t => {
  const root = tempRoot(t, 'source-batch'), requests: string[] = [];
  const shotId = randomUUID(), editId = 'hidden_same_batch';
  const f = await createMioTestFixture(root, async function* (request) {
    request.beforeSubmit?.(); requests.push(request.body);
    yield {type: 'done', output: modelOutput(protocol, requests.length === 1 ? [
      {id: 'load_canvas', name: AGENT_TASK_TOOLS_LOAD_NAME, arguments: {names: ['mioon_shot_update']}},
      {id: editId, name: 'mioon_shot_update', arguments: {shotId, expectedRevision: 1, patch: {prompt: 'Must remain hidden'}}},
    ] : [])};
  }, undefined, protocol);
  try {
    const at = '2026-11-02T00:00:00.000Z';
    f.store.put('shots', {id: shotId, projectId: f.store.projectId, title: 'Original', prompt: 'Keep original', referenceAssetIds: [], aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 0, y: 0}, orderIndex: 0, revision: 1, selectedVersionId: null, createdAt: at, updatedAt: at});
    const prepared: string[] = [], prepare = f.tools.prepare;
    f.tools.prepare = input => {prepared.push(input.operation); return prepare(input);};
    const sent = await f.runtime.send(f.store.projectId, {requestId: randomUUID(), expectedSettingsRevision: 1, text: 'Load and inspect.'});
    await f.runtime.drain();
    const done = f.runtime.get(f.store.projectId, sent.run.id), rejected = done.steps.find(step => step.toolCall?.id === editId);
    assert.equal(done.run.status, 'completed'); assert.equal(rejected?.status, 'rejected');
    assert.equal(object(object(rejected?.result).error).code, 'TOOL_NOT_LOADED');
    assert.deepEqual(prepared, [AGENT_TASK_TOOLS_LOAD_NAME]);
    assert.equal(object(f.store.get('shots', shotId)).prompt, 'Keep original');
    const model = f.records.steps(sent.run.id).find(step => step.kind === 'model')!;
    const source = f.records.request(model.currentRequestId!);
    assert.equal(source.originalBody, null);
    assert.equal(object(f.assembly.hydrate(source)).body, requests[0]);
    assert.ok(!sourceTaskModelToolNames(protocol, f.assembly.hydrate(source)).includes('mioon_shot_update'));
    assert.ok(sourceTaskModelToolNames(protocol, {body: requests[1]!}).includes('mioon_shot_update'));
  } finally {await f.close();}
});

for (const protocol of protocols) for (const accepted of [true, false]) test(`${protocol}: a frozen groups loader retains its schema after successful cleanup (${accepted ? 'groups accepted' : 'names rejected'})`, {timeout: 30_000}, async t => {
  const root = tempRoot(t, 'source-groups'), requests: string[] = [];
  const f = await createMioTestFixture(root, async function* (request) {
    request.beforeSubmit?.(); requests.push(request.body);
    yield {type: 'done', output: modelOutput(protocol, requests.length === 1 ? [{id: 'old_group_loader', name: AGENT_TASK_TOOLS_LOAD_NAME, arguments: accepted ? {groups: ['canvas']} : {names: ['mioon_shot_update']}}] : [])};
  }, undefined, protocol);
  try {
    const settings = await f.settings.get(), history: AgentTaskJson[] = [{role: 'user', content: 'Continue the frozen group-loader intent.'}];
    const body = object(JSON.parse(buildTaskModelRequest(settings.configuration, history, selectTaskModelTools(f.tools.list()), 4318)));
    assert.ok(Array.isArray(body.tools));
    for (const value of body.tools) {
      const wire = object(value), tool = protocol === 'chat_completions' ? object(wire.function) : wire;
      if (tool.name !== AGENT_TASK_TOOLS_LOAD_NAME) continue;
      const schema = object(tool[protocol === 'anthropic_messages' ? 'input_schema' : 'parameters']), properties = object(schema.properties);
      schema.properties = {groups: {type: 'array', items: {type: 'string', enum: [...AGENT_TASK_LOADABLE_TOOL_GROUP_IDS]}, minItems: 1, maxItems: AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.length}, ...(properties._mio_step ? {_mio_step: properties._mio_step} : {})};
      schema.required = ['groups'];
    }
    const original = JSON.stringify(body);
    const created = f.runtime.journal.create({projectId: f.store.projectId, requestId: randomUUID(), text: 'Continue the frozen group-loader intent.', configuration: {...settings.configuration}, settingsRevision: settings.revision, context: history});
    const source = f.runtime.journal.beginModelStep(created.run.id, {request: {body: original, history}, data: {baseline: f.runtime.journal.revisionSnapshot(f.store.projectId).map(({kind, id, revision}) => ({kind, id, revision}))}}, []);
    f.restart();
    await f.runtime.action(f.store.projectId, created.run.id, {requestId: randomUUID(), expectedRevision: f.runtime.get(f.store.projectId, created.run.id).run.revision, action: 'resume'});
    await f.runtime.drain();
    const done = f.runtime.get(f.store.projectId, created.run.id), loader = done.steps.find(step => step.toolCall?.id === 'old_group_loader');
    assert.equal(done.run.status, 'completed'); assert.equal(loader?.status, accepted ? 'completed' : 'rejected');
    if (!accepted) assert.equal(loader?.error?.code, 'VALIDATION_ERROR');
    const request = f.records.request(f.records.step(source.id).currentRequestId!);
    assert.equal(request.originalBody, null);
    const hydrated = f.assembly.hydrate(request);
    assert.equal(object(hydrated).body, original); assert.equal(requests[0], original);
    assert.equal(sourceTaskModelToolLoadMode(protocol, hydrated), 'groups');
    assert.equal(sourceTaskModelToolLoadMode(protocol, {body: requests[1]!}), 'names');
  } finally {await f.close();}
});
