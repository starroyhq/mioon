import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.js';
import { createEditTaskClient } from '../apps/web/src/edit-task-client.js';
import * as pending from '../apps/web/src/submissions.js';
import { pinNewWorkspaceIntent, assertWorkspaceIntent, workspacePendingKey, retainWorkspaceIdentity } from '../apps/web/src/workspace-origin.js';
import { validateProjectWorkspace } from '../apps/web/src/restored-workspace.js';
import { rpc } from '../apps/web/src/api.js';
import { createWorkspacePreferences, durableWorkspaceState } from '../apps/web/src/workspace-preferences.js';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.js';
import { createExportPreflightController } from '../apps/web/src/export-preflight-state.js';
import { createWaveformController, waveformKey } from '../apps/web/src/waveform-state.js';
import { resolveTimelineExportDelivery, WAVEFORM_ALGORITHM } from '@mioon/contracts';

const id = n => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const origin = id(1), otherOrigin = id(2), projectId = id(3), taskId = id(4), trackId = id(5), instanceId = id(6), timelineId = id(7);
const workspace = { restored: true, workspaceOrigin: origin };
const stamp = '2026-10-12T00:00:00.000Z';
const operation = 'timeline.track.update';
const input = { projectId, expectedRevision: 1, requestId: 'original-edit-identity', trackId, patch: { muted: true } };
const task = patch => ({ id: taskId, projectId, operation, input: structuredClone(input), requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'unknown', revision: 3, acknowledged: false, origin: 'new', createdAt: stamp, updatedAt: stamp, ...patch });
const binding = (executionEpoch = 'captured', workspaceOrigin = origin) => ({ workspaceOrigin, executionEpoch, held: executionEpoch !== workspaceOrigin });
const envelope = (value, restore) => ({ task: value, instanceId, restore });
const list = (items, restore, workspaceOrigin = origin) => ({ items, nextCursor: null, instanceId, restore: { workspaceOrigin, tasks: items.map((value, index) => ({ taskId: value.id, executionEpoch: restore[index].executionEpoch, held: restore[index].held })) } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function memoryStorage() { const values = new Map(); return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values }; }
function session(t) { const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = memoryStorage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage }); t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage); return storage; }
const entry = () => ({ projectId, key: 'timeline:render:export', operation: 'timeline.render', input: { projectId, expectedRevision: 1, requestId: 'original-export-request', purpose: 'export' }, createdAt: stamp });

test('renderer reconnect observations cannot replace its first origin or mutate pinned policy', () => {
  const observed = { ...workspace, operationPolicy: [{ operation: 'timeline.render', available: true }] };
  const first = retainWorkspaceIdentity(null, observed);
  observed.operationPolicy[0].available = false;
  assert.equal(first.operationPolicy[0].available, true); assert.equal(Object.isFrozen(first.operationPolicy[0]), true);
  assert.equal(retainWorkspaceIdentity(first, { ...workspace, operationPolicy: [] }), first);
  for (const next of [{ restored: false }, { ...workspace, workspaceOrigin: otherOrigin }])
    assert.throws(() => retainWorkspaceIdentity(first, next), { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH' });
  assert.throws(() => retainWorkspaceIdentity({ restored: false }, workspace), { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH' });
});

test('legacy and two restored pending namespaces coexist through reload and current-only admission', t => {
  const storage = session(t), old = entry(), a = pinNewWorkspaceIntent(entry(), workspace), b = pinNewWorkspaceIntent(entry(), { restored: true, workspaceOrigin: otherOrigin });
  pending.writePending(old); pending.prepareSubmission(a); pending.prepareSubmission(b);
  const originalBytes = storage.getItem(workspacePendingKey(projectId, old.key));
  assert.equal(pending.pendingForProject(projectId).length, 3);
  assert.deepEqual(pending.pendingForProject(projectId, { workspace, activeOnly: true }), [a]);
  assert.deepEqual(pending.prepareRequestReplay(a), a);
  assert.throws(() => assertWorkspaceIntent(old, workspace), { code: 'RESTORED_RECORD_HELD' });
  assert.throws(() => pending.prepareSubmission(a), { code: 'MUTATION_PENDING' });
  pending.reconcilePending(projectId, { jobs: [], exports: [{ requestId: old.input.requestId }], restore: { workspaceOrigin: origin, heldExportIds: [] } }, { workspace });
  assert.equal(storage.getItem(workspacePendingKey(projectId, old.key)), originalBytes);
  assert.equal(pending.pendingForProject(projectId).length, 3);
});

test('strict pending scans reject corrupt slot ownership without deleting original bytes', t => {
  const storage = session(t);
  for (const pinned of [entry(), pinNewWorkspaceIntent(entry(), workspace)]) {
    const key = workspacePendingKey(projectId, 'damaged-slot', pinned.expectedWorkspaceOrigin);
    for (const value of [{ ...pinned, input: {} }, { ...pinned, projectId: id(99) }, { ...pinned, expectedWorkspaceOrigin: otherOrigin }, null]) {
      const bytes = JSON.stringify(value); storage.setItem(key, bytes);
      assert.throws(() => pending.pendingForProject(projectId, { strict: true }), /记录损坏/);
      assert.equal(storage.getItem(key), bytes, 'Corrupted intent is retained for inspection, never repaired or adopted');
      storage.removeItem(key);
    }
  }
  const foreign = { ...entry(), projectId: id(99) };
  storage.setItem(workspacePendingKey(foreign.projectId, foreign.key, origin), '{');
  assert.deepEqual(pending.pendingForProject(projectId, { strict: true }), [], 'Another project corruption does not claim the current lane');
});

test('late pending acknowledgment cannot clear a newer key or another branch', t => {
  const storage = session(t), old = entry(), a = pinNewWorkspaceIntent(entry(), workspace);
  pending.writePending(old); pending.writePending(a);
  const replacement = { ...a, input: { ...a.input, requestId: 'newer-request-identity' } };
  pending.writePending(replacement);
  assert.equal(pending.clearPending(projectId, a.key, a), false);
  assert.deepEqual(pending.readPending(projectId, a.key, a), replacement);
  assert.deepEqual(pending.readPending(projectId, old.key), old);
  assert.equal(pending.clearPending(projectId, a.key, replacement), true);
  assert.equal(storage.length, 1);
});

test('formatted normal and restored pending intents clear only after matching the complete original intent', t => {
  const storage = session(t);
  for (const retained of [entry(), pinNewWorkspaceIntent(entry(), workspace)]) {
    const key = workspacePendingKey(projectId, retained.key, retained.expectedWorkspaceOrigin);
    const raw = '\n  ' + JSON.stringify(Object.fromEntries(Object.entries(retained).reverse()), null, 2) + '\n';
    storage.setItem(key, raw);
    const read = pending.readPending(projectId, retained.key, retained);
    assert.deepEqual(read, retained); assert.equal(storage.getItem(key), raw, 'Reading preserves original formatted bytes');
    for (const changed of [
      { ...retained, operation: 'timeline.undo' },
      { ...retained, input: { ...retained.input, requestId: 'changed-request-identity' } },
      { ...retained, input: { ...retained.input, purpose: 'preview' } },
      { ...retained, createdAt: '2026-10-12T00:00:01.000Z' },
      { ...retained, projectId: id(99) }, { ...retained, key: 'another-slot' },
    ]) {
      assert.equal(pending.clearPending(projectId, retained.key, changed), false);
      assert.equal(storage.getItem(key), raw, 'Different complete intent cannot erase the original bytes');
    }
    assert.equal(pending.clearPending(projectId, retained.key, read), true);
    assert.equal(storage.getItem(key), null);
  }
});

test('raw pending CAS retains a replacement between semantic read and deletion in both workspace profiles', t => {
  const storage = session(t), get = storage.getItem.bind(storage);
  for (const retained of [entry(), pinNewWorkspaceIntent(entry(), workspace)]) {
    const key = workspacePendingKey(projectId, retained.key, retained.expectedWorkspaceOrigin);
    const raw = '\n' + JSON.stringify(retained, null, 2) + '\n';
    const replacement = JSON.stringify({ ...retained, input: { ...retained.input, requestId: 'replacement-after-read' } });
    storage.setItem(key, raw); let reads = 0;
    storage.getItem = selected => {
      if (selected === key && ++reads === 2) storage.setItem(key, replacement);
      return get(selected);
    };
    assert.equal(pending.clearPending(projectId, retained.key, retained), false);
    assert.equal(get(key), replacement, 'CAS must not erase a newly replaced request');
    storage.getItem = get; storage.removeItem(key);
  }
});

test('malformed and cross-origin formatted pending records remain byte-exact on acknowledgement', t => {
  const storage = session(t), retained = pinNewWorkspaceIntent(entry(), workspace), key = workspacePendingKey(projectId, retained.key, origin);
  for (const raw of ['{', 'null', '[]', JSON.stringify({ ...retained, expectedWorkspaceOrigin: otherOrigin }), JSON.stringify({ ...retained, input: null })]) {
    storage.setItem(key, raw);
    assert.equal(pending.clearPending(projectId, retained.key, retained), false);
    assert.equal(storage.getItem(key), raw);
  }
});

test('pending acknowledgement preserves malformed equal records and explicit missing-origin distinctions', t => {
  const storage = session(t), original = entry(), key = workspacePendingKey(projectId, original.key);
  const bytes = '\n' + JSON.stringify(original, null, 2);
  storage.setItem(key, bytes);
  assert.equal(pending.clearPending(projectId, original.key, { ...original, expectedWorkspaceOrigin: undefined }), false);
  const inherited = Object.assign(Object.create({ projectId }), original); delete inherited.projectId;
  assert.equal(pending.clearPending(projectId, original.key, inherited), false);
  assert.equal(storage.getItem(key), bytes);
  for (const malformed of [{ ...original, operation: 'arbitrary.execute' }, { ...original, input: {} }, { ...original, input: { requestId: 42 } }]) {
    const raw = JSON.stringify(malformed); storage.setItem(key, raw);
    assert.equal(pending.clearPending(projectId, original.key, malformed), false);
    assert.equal(storage.getItem(key), raw);
  }
});

test('restored task load preserves every captured status and acknowledgment without blocking current lanes', async () => {
  const items = ['prepared', 'dispatching', 'unknown', 'applied', 'not_applied'].map((status, index) => task({ id: id(20 + index), status, acknowledged: ['applied', 'not_applied'].includes(status) }));
  const before = JSON.stringify(items), calls = [];
  const controller = createEditTaskController({ getWorkspace: () => workspace, client: { list: async value => { calls.push(value); return list(items, items.map(() => binding())); } } });
  await controller.load(projectId);
  assert.equal(controller.getState(projectId).phase, 'ready'); assert.equal(controller.getState(projectId).items.length, 5);
  assert.equal(controller.getState(projectId).heldIds.length, 5); assert.equal(controller.blocked(projectId, 'timeline:mutation'), false);
  for (const value of items) {
    await assert.rejects(controller.recover(value), { code: 'RESTORED_RECORD_HELD' });
    if (value.acknowledged) await assert.rejects(controller.acknowledge(value), { code: 'RESTORED_RECORD_HELD' });
  }
  assert.equal(JSON.stringify(items), before); assert.deepEqual(calls, [{ projectId, limit: 50, pendingOnly: false }]);
  await assert.rejects(controller.adopt({ ...entry(), operation, input }), { code: 'RESTORED_RECORD_HELD' });
});

test('new task invocation pins once and captured lane coexistence does not rewrite task input', async () => {
  const old = task(), created = task({ id: id(30), input: { ...input, requestId: 'new-current-origin-request' }, requestId: 'new-current-origin-request', status: 'prepared', revision: 1 });
  const calls = [], current = binding(origin);
  const controller = createEditTaskController({ getWorkspace: () => workspace, client: {
    list: async () => list([old], [binding()]),
    prepare: async (value, options) => { calls.push(['prepare', structuredClone(value), { ...options }]); return envelope(created, current); },
    execute: async (value, options) => { calls.push(['execute', value, options]); throw Error('Synthetic lost response'); },
  } });
  await controller.load(projectId);
  await assert.rejects(controller.submit({ projectId, operation, input: created.input }), { code: 'RESTORED_RECORD_HELD' });
  await assert.rejects(controller.submit({ projectId, operation, input: created.input, expectedWorkspaceOrigin: origin }), /Synthetic/);
  assert.equal(calls.length, 2); for (const call of calls) assert.deepEqual(call[2], { expectedWorkspaceOrigin: origin });
  assert.deepEqual(calls[0][1], { projectId, operation, input: created.input, origin: 'new' });
  assert.equal(controller.getState(projectId).items.length, 2); assert.deepEqual(controller.getState(projectId).heldIds, [old.id]);
  assert.equal(controller.blocked(projectId, 'timeline:mutation'), true);
});

test('same-project restored task caches stay separate and wrong-origin replies cannot erase old identity', async () => {
  let live = workspace, response = list([task()], [binding()]);
  const controller = createEditTaskController({ getWorkspace: () => live, client: { list: async () => response } });
  await controller.load(projectId);
  live = { restored: true, workspaceOrigin: otherOrigin };
  await controller.load(projectId);
  assert.equal(controller.getState(projectId).phase, 'error'); assert.equal(controller.getState(projectId).items.length, 0);
  live = workspace; assert.equal(controller.getState(projectId).items[0].requestId, input.requestId);
  response = { items: [], nextCursor: null, instanceId };
  await controller.load(projectId); assert.equal(controller.getState(projectId).phase, 'error');
  assert.equal(controller.getState(projectId).items[0].requestId, input.requestId);
});

test('task HTTP and web RPC keep outer context out of immutable intent and preserve refusal ambiguity', async t => {
  const sent = [], raw = { projectId, operation, input, origin: 'new' };
  const client = createEditTaskClient({ fetcher: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ ok: true, data: envelope(task(), binding()) }) }; } });
  await client.prepare(raw, { expectedWorkspaceOrigin: origin }); assert.deepEqual(sent, [{ ...raw, expectedWorkspaceOrigin: origin }]); assert.equal(Object.hasOwn(input, 'expectedWorkspaceOrigin'), false);
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  for (const code of ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH']) {
    globalThis.fetch = async (_url, options) => { assert.deepEqual(JSON.parse(options.body), { operation, input, expectedWorkspaceOrigin: origin }); return { ok: false, status: 409, json: async () => ({ ok: false, error: { code, message: 'Held', details: { mutationOutcome: 'not_applied', requestId: input.requestId } } }) }; };
    await assert.rejects(rpc(operation, input, { expectedWorkspaceOrigin: origin }), error => error.code === code && error.definitive === false && !Object.hasOwn(error.details, 'mutationOutcome'));
  }
});

test('outer project export hold projection validates exact workspace and returned ID subset', () => {
  const snapshot = { exports: [{ id: taskId }], restore: { workspaceOrigin: origin, heldExportIds: [taskId] } };
  assert.equal(validateProjectWorkspace(snapshot, workspace), snapshot);
  for (const restore of [undefined, { workspaceOrigin: otherOrigin, heldExportIds: [taskId] }, { workspaceOrigin: origin, heldExportIds: [id(99)] }, { workspaceOrigin: origin, heldExportIds: [taskId, taskId] }])
    assert.throws(() => validateProjectWorkspace({ ...snapshot, restore }, workspace), { code: 'BACKEND_PROTOCOL_ERROR' });
});

test('restored preferences never bootstrap a PUT and explicit queued writes keep their origin', async () => {
  const storage = memoryStorage(), calls = [], wait = deferred(); let live = workspace;
  const controller = createWorkspacePreferences({ storage, getWorkspace: () => live, setTimeout: () => 1, clearTimeout: () => {}, requestTimeoutMs: 0,
    fetchImpl: async (_url, options) => {
      calls.push({ method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === 'GET') return { ok: true, json: async () => ({ ok: true, data: { projectId, revision: 0, state: null } }) };
      await wait.promise;
      const body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, data: { projectId, revision: body.expectedRevision + 1, state: body.state } }) };
    } });
  await controller.load(projectId); await controller.flush(); assert.deepEqual(calls.map(call => call.method), ['GET']);
  const state = defaultWorkspaceState(); state.activeMode = 'editing';
  controller.update(projectId, state, { immediate: true, expectedWorkspaceOrigin: origin }); await tick();
  assert.equal(calls[1].body.expectedWorkspaceOrigin, origin); assert.deepEqual(calls[1].body.state, durableWorkspaceState(state));
  live = { restored: true, workspaceOrigin: otherOrigin }; await controller.load(projectId);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  wait.resolve(); await controller.flush();
  assert.equal(calls[1].body.expectedWorkspaceOrigin, origin);
  assert.ok([...storage.values.keys()].some(key => key.includes(origin)));
  assert.ok([...storage.values.keys()].some(key => key.includes(otherOrigin)));
});

test('two-step preflight keeps the first explicit invocation across awaited capability result', async () => {
  const wait = deferred(), seen = []; let currentOrigin = origin;
  const settings = { profileId: 'mp4_h264_v1', resolution: 'short_360', rateControl: { mode: 'crf', quality: 'standard' } };
  const context = { scope: 'unchanged', projectId, timelineId, revision: 1, connected: true, exportSettings: settings, settingsVersion: 0 };
  const controller = createExportPreflightController({ getContext: () => context, getInvocation: () => ({ expectedWorkspaceOrigin: currentOrigin }),
    readCapabilities: async (input, options) => { seen.push(options.expectedWorkspaceOrigin); await wait.promise; return { ...input, timelineId, timelineRevision: 1, delivery: resolveTimelineExportDelivery({ fps: 30, width: 720, height: 1280 }, settings), checkedAt: stamp, status: 'available', issues: [] }; },
    read: async (_input, options) => { seen.push(options.expectedWorkspaceOrigin); throw Error('End after observing transport'); } });
  controller.setContext(context); const run = controller.check(); currentOrigin = otherOrigin; wait.resolve(); await run;
  assert.deepEqual(seen, [origin, origin]);
});

test('read-only waveform view never requests or polls captured pending states', async () => {
  for (const status of ['missing', 'queued', 'running', 'interrupted']) {
    const calls = [], timers = [];
    const controller = createWaveformController({ api: async (operation, input) => { calls.push(operation); return { projectId, assetId: input.assetId, status, algorithm: WAVEFORM_ALGORITHM, binsPerSecond: 100 };  }, setTimer: (...args) => { timers.push(args); return 1; }, clearTimer: () => {} });
    const item = { assetId: id(80), sourceStartFrame: 0, sourceEndFrame: 30, points: 10 }; item.key = waveformKey(item);
    controller.setView({ projectId, active: true, windows: [item], readOnly: true, workspaceOrigin: origin }); controller.setEnabled(true); await tick(); controller.retryVisible(); await tick();
    assert.deepEqual(calls, ['asset.waveform.get']); assert.equal(timers.length, 0); assert.equal(controller.snapshot().retryable, false); assert.equal(controller.snapshot().entries.get(item.key).status, status); assert.equal(controller.snapshot().entries.get(item.key).held, true);
    controller.disconnect();
  }
});
