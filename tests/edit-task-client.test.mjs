import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditTaskClient, validateTaskEnvelope, isDurableEditOperation, taskInputKey } from '../apps/web/src/edit-task-client.js';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.js';
import { DURABLE_EDIT_OPERATIONS, isEditTaskEnvelope } from '@mioon/contracts';

const id = n => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), otherProjectId = id(2), instanceId = id(3), trackId = id(4);
const stamp = '2026-10-10T00:00:00.000Z';
const operation = 'timeline.track.update';
const input = { projectId, expectedRevision: 1, requestId: 'exact-original-task-request', trackId, patch: { muted: true } };
const makeTask = (patch = {}) => ({ id: id(5), projectId, operation, input: structuredClone(input), requestId: input.requestId,
  digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp, acknowledged: false, origin: 'new', ...patch });
const envelope = (task = makeTask(), extra = {}) => ({ task, instanceId, ...extra });
const list = (items = [], extra = {}) => ({ items, nextCursor: null, instanceId, ...extra });
const result = () => ({ id: id(6), projectId, revision: 2, fps: 30, width: 720, height: 1280, durationFrames: 0, clips: [],
  tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: true }], createdAt: stamp, updatedAt: stamp });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  let task = null, nonce = instanceId; const calls = [];
  const client = Object.fromEntries(Object.entries({
    list: async () => list(task && !task.acknowledged ? [structuredClone(task)] : [], { instanceId: nonce }),
    prepare: async value => { task ||= makeTask({ origin: value.origin, input: structuredClone(value.input), requestId: value.input.requestId,
      status: value.origin === 'legacy_session' ? 'unknown' : 'prepared' }); return envelope(structuredClone(task), { instanceId: nonce }); },
    execute: async value => {
      if (value.instanceId !== nonce) throw Object.assign(Error('Server restarted'), { code: 'EDIT_TASK_STALE_INSTANCE' });
      task = { ...task, status: 'applied', revision: task.revision + 2 };
      return envelope(structuredClone(task), { result: result(), instanceId: nonce });
    },
    get: async () => envelope(structuredClone(task), { instanceId: nonce }),
    reconcile: async () => envelope(structuredClone(task), { instanceId: nonce }),
    acknowledge: async value => {
      if (value.expectedRevision !== task.revision) throw Object.assign(Error('Stale acknowledgment'), { code: 'EDIT_TASK_CONFLICT' });
      task = { ...task, acknowledged: true, revision: task.revision + 1 }; return envelope(structuredClone(task), { instanceId: nonce });
    }, ...overrides,
  }).map(([name, fn]) => [name, async (...args) => { calls.push({ name, args: structuredClone(args) }); return fn(...args); }]));
  return { client, calls, get task() { return task; }, set task(value) { task = value; }, restart() { nonce = id(8); }, get instanceId() { return nonce; } };
}
const ready = async value => { const controller = createEditTaskController({ client: value.client }); await controller.load(projectId); return controller; };

test('the durable allowlist is exactly ten timeline metadata writes plus attach/detach', () => {
  assert.equal(DURABLE_EDIT_OPERATIONS.length, 12);
  for (const op of ['timeline.render', 'generation.submit', 'job.retry', 'export.create', 'shot.update', 'asset.range.set', 'asset.disposition.set']) assert.equal(isDurableEditOperation(op), false);
  assert.equal(isEditTaskEnvelope(envelope(makeTask({ status: 'applied' }), { result: result() })), true);
});

test('fresh edits prepare exact immutable input before execute, with no business RPC or renderer receipt', async () => {
  const f = fixture(), controller = await ready(f), draft = structuredClone(input);
  const response = await controller.submit({ projectId, operation, input: draft });
  draft.patch.muted = false;
  assert.deepEqual(f.calls.map(call => call.name), ['list', 'prepare', 'execute']);
  assert.deepEqual(f.calls[1].args[0], { projectId, operation, input, origin: 'new' });
  assert.deepEqual(f.calls[2].args[0], { projectId, taskId: id(5), digest: 'a'.repeat(64), instanceId });
  assert.deepEqual(response.task.input, input); assert.equal(Object.isFrozen(response.task.input.patch), true);
  assert.equal(controller.blocked(projectId, 'timeline:mutation'), true);
  await controller.acknowledge(response.task);
  assert.equal(controller.blocked(projectId, 'timeline:mutation'), false);
});

test('lost prepare response survives full controller destruction and loads without execution', async () => {
  const f = fixture(), save = f.client.prepare;
  f.client.prepare = async value => { await save(value); throw Error('Lost preparation ACK'); };
  const first = await ready(f);
  await assert.rejects(first.submit({ projectId, operation, input }), /Lost preparation/);
  assert.equal(first.getState(projectId).phase, 'error'); assert.equal(f.task.status, 'prepared');
  const second = await ready(f);
  assert.equal(second.getState(projectId).items[0].requestId, input.requestId);
  assert.equal(f.calls.some(call => call.name === 'execute'), false);
  f.restart(); const response = await second.recover(second.getState(projectId).items[0]);
  assert.deepEqual(f.calls.slice(-2).map(call => call.name), ['get', 'execute']);
  assert.equal(f.calls.at(-1).args[0].instanceId, f.instanceId);
  assert.equal(response.task.status, 'applied');
});

test('project or draft navigation during prepare leaves a recoverable task without dispatch', async () => {
  const hold = deferred(), f = fixture(), save = f.client.prepare; let current = true;
  f.client.prepare = async value => { const response = await save(value); await hold.promise; return response; };
  const controller = await ready(f), submitting = controller.submit({ projectId, operation, input }, { canExecute: () => current });
  await Promise.resolve(); current = false; hold.resolve();
  const response = await submitting;
  assert.equal(response.task.status, 'prepared'); assert.equal(f.calls.some(call => call.name === 'execute'), false);
  assert.equal(controller.getState(projectId).items.length, 1);
});

test('navigation during explicit recovery lookup cannot initiate a delayed execute', async () => {
  const hold = deferred(), f = fixture(); f.task = makeTask({ status: 'unknown', revision: 3 });
  const get = f.client.get; let current = true;
  f.client.get = async args => { const response = await get(args); await hold.promise; return response; };
  const controller = await ready(f), recovery = controller.recover(f.task, { canExecute: () => current });
  current = false; hold.resolve(); await recovery;
  assert.equal(f.calls.some(call => call.name === 'execute'), false);
  assert.equal(controller.getState(projectId).items[0].status, 'unknown');
});

test('old preparation nonce is never replaced automatically after a backend restart', async () => {
  const f = fixture(), save = f.client.prepare;
  f.client.prepare = async value => { const response = await save(value); f.restart(); return response; };
  const controller = await ready(f);
  await assert.rejects(controller.submit({ projectId, operation, input }), { code: 'EDIT_TASK_STALE_INSTANCE' });
  assert.equal(f.calls.filter(call => call.name === 'execute').length, 1);
  assert.equal(f.calls.at(-1).args[0].instanceId, instanceId);
  assert.deepEqual(controller.getState(projectId).uncertain, [id(5)]);
  await controller.recover(controller.getState(projectId).items[0]);
  assert.equal(f.calls.at(-1).args[0].instanceId, f.instanceId);
});

test('unknown requests block new edits and recover their persisted parameters, never the current draft', async () => {
  const f = fixture(), execute = f.client.execute;
  f.client.execute = async value => { await execute(value); throw Error('Lost committed response'); };
  const controller = await ready(f);
  await assert.rejects(controller.submit({ projectId, operation, input }), /Lost committed/);
  const calls = f.calls.length;
  await assert.rejects(controller.submit({ projectId, operation, input: { ...input, requestId: 'new-draft-request', patch: { muted: false } } }), { code: 'MUTATION_PENDING' });
  assert.equal(f.calls.length, calls);
  const response = await controller.recover(controller.getState(projectId).items[0]);
  assert.equal(response.task.status, 'applied'); assert.equal(f.calls.at(-1).name, 'get');
  assert.deepEqual(response.task.input, input);
});

test('dispatching recovery is receipt-only and never blindly resubmits an active claim', async () => {
  const f = fixture(); f.task = makeTask({ status: 'dispatching', revision: 2 });
  const controller = await ready(f); await controller.recover(f.task);
  assert.deepEqual(f.calls.map(call => call.name), ['list', 'get', 'reconcile']);
  assert.equal(controller.getState(projectId).items[0].status, 'dispatching');
});

test('stale list cannot resurrect acknowledged rows or downgrade an applied task', async () => {
  const f = fixture(), controller = await ready(f), hold = deferred();
  f.client.list = () => hold.promise;
  const loading = controller.load(projectId);
  // A load blocks new edits; recovery of an already known persisted task is
  // still explicit and verifies it individually.
  f.task = makeTask({ status: 'applied', revision: 4 });
  const applied = await controller.recover(makeTask());
  await controller.acknowledge(applied.task);
  hold.resolve(list([makeTask()])); await loading;
  assert.deepEqual(controller.getState(projectId).items, []);
  assert.equal(controller.blocked(projectId, 'timeline:mutation'), false);
});

test('a stale GET cannot downgrade terminal outcome or clear a newer task in the same lane', async () => {
  const f = fixture(), controller = await ready(f), hold = deferred(); f.task = makeTask({ status: 'unknown', revision: 2 });
  f.client.get = () => hold.promise;
  const recovery = controller.recover(f.task);
  f.client.list = async () => list([makeTask({ status: 'applied', revision: 4 }), makeTask({ id: id(20), requestId: 'newer-request-identity', input: { ...input, requestId: 'newer-request-identity' }, digest: 'b'.repeat(64) })]);
  await controller.load(projectId);
  hold.resolve(envelope(makeTask({ status: 'unknown', revision: 2 }))); const response = await recovery;
  assert.equal(response.task.status, 'applied');
  f.client.acknowledge = async args => envelope(makeTask({ status: 'applied', revision: args.expectedRevision + 1, acknowledged: true }));
  await controller.acknowledge(response.task);
  assert.deepEqual(controller.getState(projectId).items.map(task => task.id), [id(20)]);
  assert.equal(f.calls.some(call => call.name === 'execute'), false);
});

test('malformed or wrongly bound 200 cannot clear recovery identity or accept an ACK', async () => {
  for (const corrupt of [value => null, value => ({ ...value, task: { ...value.task, projectId: otherProjectId } }),
    value => ({ ...value, task: { ...value.task, digest: 'b'.repeat(64) } }), value => ({ ...value, result: {} }),
    value => ({ ...value, task: { ...value.task, acknowledged: false } }), value => ({ ...value, task: { ...value.task, revision: 3 } })]) {
    const f = fixture(), controller = await ready(f), applied = await controller.submit({ projectId, operation, input });
    f.client.acknowledge = async () => corrupt(envelope(makeTask({ status: 'applied', revision: 4, acknowledged: true })));
    await assert.rejects(controller.acknowledge(applied.task), { code: 'BACKEND_PROTOCOL_ERROR' });
    assert.equal(controller.getState(projectId).items[0].status, 'applied');
    assert.equal(controller.getState(projectId).items[0].acknowledged, false);
  }
});

test('malformed fresh prepare never executes, and malformed execute never releases its task', async () => {
  const f = fixture({ prepare: async () => ({ task: makeTask(), instanceId: 'invalid' }) }), controller = await ready(f);
  await assert.rejects(controller.submit({ projectId, operation, input }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.equal(f.calls.some(call => call.name === 'execute'), false); assert.equal(controller.getState(projectId).phase, 'error');
  const other = fixture({ execute: async () => envelope(makeTask({ status: 'applied', revision: 3 }), { result: {} }) }), next = await ready(other);
  await assert.rejects(next.submit({ projectId, operation, input }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.equal(next.getState(projectId).items[0].id, id(5)); assert.equal(next.blocked(projectId, 'timeline:mutation'), true);
});

test('loading, failing and truncated pagination cannot falsely declare an empty safe lane', async () => {
  const hold = deferred(), f = fixture({ list: () => hold.promise }), controller = createEditTaskController({ client: f.client });
  assert.equal(controller.blocked(projectId, 'timeline:mutation'), true);
  const loading = controller.load(projectId);
  await assert.rejects(controller.submit({ projectId, operation, input }), { code: 'TASK_LIST_UNAVAILABLE' });
  hold.reject(Error('Offline')); await loading;
  assert.equal(controller.getState(projectId).phase, 'error'); assert.equal(controller.blocked(projectId, 'reference:mutation'), true);
  let page = 0; f.client.list = async () => ++page === 1 ? list([makeTask()], { nextCursor: 'page-two' }) : { items: [], instanceId };
  await controller.load(projectId); assert.equal(controller.getState(projectId).phase, 'error');
  f.client.list = async () => list(); await controller.load(projectId);
  assert.equal(controller.getState(projectId).phase, 'ready');
});

test('pagination loads all valid pages once and rejects repeated cursors or changed server lifetime', async () => {
  let pages = 0; const f = fixture({ list: async args => { pages++; return args.cursor ? list([makeTask({ id: id(7) })]) : list([makeTask()], { nextCursor: 'next-page' }); } });
  const controller = await ready(f); assert.equal(pages, 2); assert.equal(controller.getState(projectId).items.length, 2);
  for (const source of [async () => list([], { nextCursor: 'same-page' }), async args => args.cursor ? list([], { instanceId: id(99) }) : list([], { nextCursor: 'next-page' })]) {
    f.client.list = source; await controller.load(projectId); assert.equal(controller.getState(projectId).phase, 'error');
    assert.equal(controller.getState(projectId).items.length, 2);
  }
});

test('obsolete load completion cannot replace a newer project refresh or hide a known unknown', async () => {
  const f = fixture(), controller = await ready(f), hold = deferred(); f.task = makeTask({ status: 'unknown', revision: 3 });
  f.client.list = () => hold.promise; const oldLoad = controller.load(projectId);
  f.client.list = async () => list([f.task]); await controller.load(projectId);
  hold.resolve(list()); await oldLoad;
  assert.equal(controller.getState(projectId).items[0].status, 'unknown');
  f.client.list = async () => list(); await controller.load(projectId);
  assert.equal(controller.getState(projectId).items[0].status, 'unknown');
});

test('legacy adoption is explicit metadata-only, exact input and original request ID retained', async () => {
  const f = fixture(), controller = await ready(f), entry = { projectId, operation, input: structuredClone(input), key: 'timeline:mutation', createdAt: stamp };
  assert.deepEqual(f.calls.map(call => call.name), ['list']);
  const response = await controller.adopt(entry);
  assert.equal(response.task.origin, 'legacy_session'); assert.equal(response.task.status, 'unknown');
  assert.deepEqual(response.task.input, input); assert.equal(response.task.requestId, input.requestId);
  assert.deepEqual(f.calls.map(call => call.name), ['list', 'prepare']);
});

test('task HTTP uses the authenticated UI endpoint, validates every 200 and never retries a POST', async () => {
  const calls = []; let payload = { ok: true, data: envelope() };
  const client = createEditTaskClient({ fetcher: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => payload }; } });
  await client.prepare({ projectId, operation, input, origin: 'new' });
  assert.equal(calls[0].url, '/api/tasks/prepare'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].options.body), { projectId, operation, input, origin: 'new' });
  for (const invalid of [null, {}, { ok: true, data: null }, { ok: true, data: envelope(makeTask({ input: { ...input, requestId: 'different-original' } })) }]) {
    payload = invalid; await assert.rejects(client.prepare({ projectId, operation, input, origin: 'new' }), { code: 'BACKEND_PROTOCOL_ERROR' });
  }
  assert.equal(calls.length, 5);
  payload = { ok: true, data: list() }; await client.list({ projectId, cursor: 'next page' });
  assert.match(calls.at(-1).url, /pendingOnly=true/); assert.match(calls.at(-1).url, /cursor=next\+page/);
  assert.doesNotThrow(() => validateTaskEnvelope(envelope(), { input: { patch: { muted: true }, trackId, requestId: input.requestId, expectedRevision: 1, projectId } }));
  assert.equal(taskInputKey(input), taskInputKey(structuredClone(input)));
});
