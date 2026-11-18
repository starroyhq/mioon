import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools, projectAgentTaskUndo} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import type {TaskModelOutput, TaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskJson, AgentTaskSnapshot, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {beginFixtureToolStep, mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';
import {putTestAgentConfiguration, testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {authorizeTestScope, createTestAuthorizations} from './helpers/agent-authorizations.ts';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const viewport = {x: 0, y: 0, width: 3000, height: 3000};
const call = (name: string, args: AgentTaskToolCall['arguments'] = {}): AgentTaskToolCall => ({id: randomUUID(), name, arguments: args});
const output = (calls: AgentTaskToolCall[] = []): TaskModelOutput => ({text: '完成', toolCalls: calls,
  providerOutput: calls.map(item => ({type: 'function_call', call_id: item.id, name: item.name, arguments: JSON.stringify(item.arguments), status: 'completed'}))});

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-task-canvas-copy-'));
  const projectFile = path.join(root, 'Film.mioon'), format4 = {};
  createProjectFile(projectFile, {format4});
  const store = openServerTestStore({projectFile, format4, locate: () => ({localDir: path.join(root, 'local'),
    cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})}, path.join(root, 'app'));
  const services = createServices(store, new Map());
  const project = object(await services.call('project.create', {name: 'Canvas copy integration'})), projectId = String(project.id);
  const journal = createAgentTaskJournal(store), tools = createAgentTaskTools({store, services});
  const run = journal.create({requestId: randomUUID(), projectId, text: 'Synthetic canvas edit', configuration: mioFixtureConfiguration}).run;
  const first = object(await services.call('node.create', {projectId, requestId: randomUUID(), type: 'text', position: {x: 0, y: 0}, text: 'Saved source'}));
  const second = object(await services.call('node.create', {projectId, requestId: randomUUID(), type: 'text', position: {x: 400, y: 0}, text: 'Saved peer'}));
  const selected = [{kind: 'node' as const, id: String(first.id)}, {kind: 'node' as const, id: String(second.id)}];
  const edgeId = randomUUID();
  store.put('edges', {id: edgeId, projectId, source: selected[0]!.id, target: selected[1]!.id, kind: 'decorative'});
  const cleanup: Array<() => void | Promise<void>> = [];
  t.after(async () => {for (const close of cleanup) await close(); tools.dispose(); await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  function stage(operation: string, input: Record<string, unknown>, selectedTools = tools) {
    const tool = selectedTools.list().find(item => item.operation === operation); assert.ok(tool);
    const step = beginFixtureToolStep(journal, run.id, {toolCall: call(tool.name, input as AgentTaskJson)});
    const prepared = selectedTools.prepare({projectId, operation, input, canvasRequester: {runId: run.id, stepId: step.id}});
    assert.ok(prepared.canvasCopy);
    journal.updateStep(run.id, step.id, {targets: prepared.targets, tier: prepared.risk,
      data: {...object(journal.step(step.id).data), canvasCopyProof: prepared.canvasCopy.proof}});
    journal.markDispatch(run.id, step.id);
    return {step, prepared};
  }
  async function execute(operation: string, input: Record<string, unknown>, options: {failRecord?: boolean} = {}) {
    const {step, prepared} = stage(operation, input);
    const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
      beforeEffect: () => journal.assertTargets(projectId, prepared.targets), recordInside(result, changes) {
        if (options.failRecord) throw Object.assign(new Error('Synthetic receipt failure'), {code: 'SQLITE_FULL'});
        journal.completeStepInside(run.id, step.id, {result, changes});
      }});
    return {step: journal.step(step.id), outcome, changes: journal.snapshot(run.id).changes.filter(change => change.stepId === step.id)};
  }
  const counts = () => (['nodes', 'edges'] as const).map(table => Number(store.db.prepare(`SELECT count(*) AS total FROM project.${table} WHERE archivedAt IS NULL`).get()!.total));
  return {root, store, services, projectId, journal, tools, run, selected, edgeId, stage, execute, counts, cleanup};
}

async function runtimeFixture(t: TestContext) {
  const f = await fixture(t), settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  f.journal.transition(f.run.id, f.journal.run(f.run.id).revision, 'stopped');
  const initial = await settings.get();
  await putTestAgentConfiguration(settings, {expectedRevision: initial.revision, configuration: {...DEFAULT_AGENT_CONFIGURATION, protocol: 'responses'},
    secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_LOCAL_TEST_ONLY'}});
  const authorizations = createTestAuthorizations(() => f.store, settings); await authorizeTestScope(authorizations, 'project_agent');
  let script: (index: number) => AgentTaskToolCall[] = () => [], index = 0;
  const required = ['mioon_canvas_copy_snapshot', 'mioon_canvas_paste', 'mioon_canvas_duplicate'];
  const gateway = async function* (request: TaskModelRequest) {
    const visible = sourceTaskModelToolNames('responses', {body: request.body}), missing = required.filter(name => !visible.includes(name));
    yield {type: 'done' as const, output: output(missing.length ? [call(AGENT_TASK_TOOLS_LOAD_NAME, {names: missing})] : script(++index))};
  };
  const runtime = createAgentTaskRuntime({store: f.store, agentSettings: settings, authorizations, tools: f.tools, gateway, selfPort: () => 4318});
  f.cleanup.push(async () => {runtime.close(); await settings.close();});
  return {...f, runtime, settings, script(value: typeof script) {script = value;},
    async send() {return runtime.send(f.projectId, {requestId: randomUUID(), text: 'Edit the selected canvas cards', expectedSettingsRevision: testAgentExecution(await settings.get()).revision});},
    async settle(runId: string) {await runtime.drain(); return runtime.get(f.projectId, runId);},
    action(snapshot: AgentTaskSnapshot, action: 'approve' | 'deny' | 'undo_all', stepId?: string) {
      return runtime.action(f.projectId, snapshot.run.id, {requestId: randomUUID(), expectedRevision: snapshot.run.revision, action, ...(stepId ? {stepId} : {})});
    }};
}

test('real canvas copy and paste record one group Change and a single whole-group undo', async t => {
  const f = await fixture(t), baseline = f.counts();
  const copied = await f.execute('canvas.copy.snapshot', {targets: f.selected});
  assert.equal(copied.changes.length, 0); assert.deepEqual(f.counts(), baseline);
  const snapshotId = object(copied.outcome.result).snapshotId; assert.equal(typeof snapshotId, 'string');
  const pasted = await f.execute('canvas.paste', {snapshotId, viewport});
  assert.equal(pasted.outcome.recorded, true); assert.equal(pasted.changes.length, 1);
  const change = pasted.changes[0]!;
  assert.equal(change.targets.length, 3); assert.equal(change.undo && Array.isArray(change.undo) ? change.undo.length : 0, 1);
  assert.ok(change.targets.every(target => !f.selected.some(source => source.id === target.id) && target.id !== f.edgeId));
  assert.deepEqual(f.counts(), [4, 2]);
  assert.equal(projectAgentTaskUndo(f.store, f.projectId, [change]).get(change.id)?.undoDisposition, 'undo');
  f.tools.undo(change, {beforeEffect() {}, recordInside(item) {f.journal.markChangeRevertedInside(item.id);},
    retainInside() {assert.fail('This unchanged copied group must undo as one unit');}});
  assert.deepEqual(f.counts(), baseline); assert.equal(f.journal.snapshot(f.run.id).changes[0]!.status, 'reverted');
});

test('real duplicate rolls all copied cards and its Change back when the atomic receipt fails', async t => {
  const f = await fixture(t), baseline = f.counts();
  await assert.rejects(f.execute('canvas.duplicate', {targets: f.selected, viewport}, {failRecord: true}), {code: 'SQLITE_FULL'});
  assert.deepEqual(f.counts(), baseline); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  const step = f.journal.snapshot(f.run.id).steps.find(item => item.toolCall?.name === 'mioon_canvas_duplicate'); assert.ok(step);
  f.journal.updateStep(f.run.id, step.id, {status: 'unknown'});
  assert.deepEqual(f.tools.recoverLocalUnknown({projectId: f.projectId, runId: f.run.id, stepId: step.id, requestId: step.id}),
    {outcome: 'not_applied', reason: 'atomic_receipt_absent'});
});

test('tool preparation rejects another owner snapshot and blocks skipped explicit and implicit targets', async t => {
  const f = await fixture(t), copied = await f.execute('canvas.copy.snapshot', {targets: f.selected});
  const foreignTools = createAgentTaskTools({store: f.store, services: f.services}); t.after(() => foreignTools.dispose());
  assert.throws(() => foreignTools.prepare({projectId: f.projectId, operation: 'canvas.paste', input: {snapshotId: object(copied.outcome.result).snapshotId, viewport}}),
    {code: 'CANVAS_CLIPBOARD_UNAVAILABLE'});
  for (const blockedId of [f.selected[0]!.id, f.edgeId]) {
    const blocked = Object.assign(new Error('User skipped target'), {code: 'AGENT_TASK_TARGET_SKIPPED'});
    assert.throws(() => f.tools.prepare({projectId: f.projectId, operation: 'canvas.copy.snapshot', input: {targets: f.selected},
      beforeTargetRead(target) {if (target.id === blockedId) throw blocked;}}), error => error === blocked);
  }
  assert.deepEqual(f.counts(), [2, 1]); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
});

test('an explicit skipped target is rejected before reading its deleted record', async t => {
  const f = await fixture(t), target = f.selected[0]!;
  f.store.db.prepare('DELETE FROM project.nodes WHERE id=?').run(target.id);
  const baseline = f.counts(), skipped = Object.assign(new Error('User skipped target'), {code: 'AGENT_TASK_TARGET_SKIPPED'});
  const original = f.store.db.prepare;
  let rawReads = 0;
  f.store.db.prepare = function (sql) {
    if (sql.includes('FROM project.nodes WHERE id=? AND projectId=?')) rawReads++;
    return original.call(this, sql);
  };
  try {
    assert.throws(() => f.tools.prepare({projectId: f.projectId, operation: 'canvas.copy.snapshot', input: {targets: [target]},
      beforeTargetRead() {throw skipped;}}), error => error === skipped);
    assert.equal(rawReads, 0);
  } finally {f.store.db.prepare = original;}
  assert.deepEqual(f.counts(), baseline); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
});

test('canvas execute requires this exact step proof and refuses a stale prepared source', async t => {
  const f = await fixture(t), {step, prepared} = f.stage('canvas.duplicate', {targets: f.selected, viewport});
  const context = {runId: f.run.id, stepId: step.id, requestId: step.id, beforeEffect() {}, recordInside() {assert.fail('No completion can be written');}};
  const saved = object(f.journal.step(step.id).data);
  f.journal.updateStep(f.run.id, step.id, {data: {...saved, canvasCopyProof: '0'.repeat(64)}});
  await assert.rejects(f.tools.execute(prepared, context), {code: 'AGENT_TASK_STATE_CONFLICT'});
  f.journal.updateStep(f.run.id, step.id, {data: saved as AgentTaskJson});
  const source = object(f.store.get('nodes', f.selected[0]!.id));
  f.store.put('nodes', {...source, text: 'User changed source', revision: Number(source.revision) + 1});
  await assert.rejects(f.tools.execute(prepared, context), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.counts(), [2, 1]); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
});

for (const decision of ['approve', 'deny'] as const) test(`runtime ${decision} gates a canvas duplicate and preserves one-step undo`, async t => {
  const f = await runtimeFixture(t);
  f.runtime.journal.updatePolicy({...f.runtime.policy(), modes: {...f.runtime.policy().modes, local_reversible: 'confirm'}});
  f.script(index => index === 1 ? [call('mioon_canvas_duplicate', {targets: f.selected, viewport})] : []);
  const sent = await f.send(), waiting = await f.settle(sent.run.id);
  assert.equal(waiting.run.status, 'awaiting_approval'); assert.deepEqual(f.counts(), [2, 1]);
  const step = waiting.steps.find(item => item.toolCall?.name === 'mioon_canvas_duplicate' && item.status === 'awaiting_approval'); assert.ok(step);
  await f.action(waiting, decision, step.id); const done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'completed'); assert.equal(done.changes.length, decision === 'approve' ? 1 : 0);
  assert.deepEqual(f.counts(), decision === 'approve' ? [4, 2] : [2, 1]);
  if (decision === 'approve') {
    const undone = await f.action(done, 'undo_all');
    assert.equal(undone.run.status, 'reverted'); assert.deepEqual(f.counts(), [2, 1]);
  }
});

test('source changes while canvas approval waits reject the old approval without cloning', async t => {
  const f = await runtimeFixture(t);
  f.runtime.journal.updatePolicy({...f.runtime.policy(), modes: {...f.runtime.policy().modes, local_reversible: 'confirm'}});
  f.script(index => index === 1 ? [call('mioon_canvas_duplicate', {targets: f.selected, viewport})] : []);
  const sent = await f.send(), waiting = await f.settle(sent.run.id);
  const step = waiting.steps.find(item => item.toolCall?.name === 'mioon_canvas_duplicate' && item.status === 'awaiting_approval'); assert.ok(step);
  const source = object(f.store.get('nodes', f.selected[0]!.id));
  f.store.put('nodes', {...source, text: 'User changed source during approval', revision: Number(source.revision) + 1});
  await assert.rejects(f.action(waiting, 'approve', step.id), {code: 'AGENT_TASK_TARGET_CHANGED', handedBack: true});
  const done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'completed'); assert.equal(done.changes.length, 0); assert.deepEqual(f.counts(), [2, 1]);
  assert.equal(done.steps.find(item => item.id === step.id)?.error?.code, 'TARGET_CHANGED');
});

test('a user skipped canvas source prevents acceptance of its pending approval', async t => {
  const f = await runtimeFixture(t);
  f.runtime.journal.updatePolicy({...f.runtime.policy(), modes: {...f.runtime.policy().modes, local_reversible: 'confirm'}});
  f.script(index => index === 1 ? [call('mioon_canvas_duplicate', {targets: f.selected, viewport})] : []);
  const sent = await f.send(), waiting = await f.settle(sent.run.id);
  const step = waiting.steps.find(item => item.toolCall?.name === 'mioon_canvas_duplicate' && item.status === 'awaiting_approval'); assert.ok(step);
  f.store.tx(() => f.runtime.journal.skipTargetsInside(sent.run.id, [{stepId: step.id,
    target: {...f.selected[0]!, revision: f.runtime.journal.targetRevision(f.projectId, 'node', f.selected[0]!.id)}}]));
  await assert.rejects(f.action(f.runtime.get(f.projectId, sent.run.id), 'approve', step.id), {code: 'AGENT_TASK_TARGET_SKIPPED'});
  const done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'awaiting_approval'); assert.deepEqual(f.counts(), [2, 1]); assert.equal(done.changes.length, 0);
  assert.equal(done.steps.find(item => item.id === step.id)?.status, 'awaiting_approval');
});
