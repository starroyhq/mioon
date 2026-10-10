import test from 'node:test';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMutation, isMutationOperation, assertMutationOwner, mutationNotApplied, validateMutationResponse } from '../apps/web/src/mutation-submissions.js';
import { prepareSubmission, readPending, clearPending, pendingForProject } from '../apps/web/src/submissions.js';
import { ApiError } from '../apps/web/src/api.js';
const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const runSource = section('async function run(', 'async function inspect(');
const structureSource = section('async function addStructure()', 'async function addNode(');
function compile(code, name, scope) { return Function(...Object.keys(scope), `${code}; return ${name};`)(...Object.values(scope)); }
function storage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
}
function harness(t, dispatch) {
  storage(t);
  const state = { epoch: 0, calls: [], notices: [], refreshes: [], pending: [], jobs: false, auth: true };
  const currentProject = { current: 'project-a' }, busy = new Set();
  const scope = {
    currentProject, context: () => ({ projectId: currentProject.current, epoch: state.epoch }),
    isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key, id) => busy.has(`${id}:${key}`), markBusy: (id, key, value) => value ? busy.add(`${id}:${key}`) : busy.delete(`${id}:${key}`),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, setPending: value => { state.pending = value; },
    rpc: async (operation, input) => { state.calls.push({ operation, input: structuredClone(input) }); return dispatch(operation, input, state); },
    refresh: async id => { state.refreshes.push(id); }, notify: (message, type) => state.notices.push({ message, type }),
    setShowJobs: value => { state.jobs = value; }, setAuth: value => { state.auth = value; }, readableError: error => error.message,
    requestCounter: { current: 0 }, dataRef: { current: { project: { id: 'project-a' }, shots: [{ id: 'shot-a', projectId: 'project-a' }], nodes: [] } }, setData: () => {},
  };
  return { state, currentProject, busy, dataRef: scope.dataRef, run: compile(runSource, 'run', scope) };
}
const input = { shotId: 'shot-a', expectedRevision: 3, patch: { prompt: 'Original draft' } };
const saved = { id: 'shot-a', projectId: 'project-a', revision: 4, prompt: 'Original draft' };

test('actual App run keeps changed draft blocked until explicit original replay, with no automatic POST', async t => {
  let fail = true;
  const h = harness(t, async () => { if (fail) throw Error('Response lost'); return saved; });
  assert.equal(await h.run('save:shot-a', 'shot.update', input), null);
  const original = readPending('project-a', 'save:shot-a');
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.jobs, true);
  const changedDraft = { ...input, expectedRevision: 9, patch: { prompt: 'Later unsaved draft' } };
  assert.equal(await h.run('save:shot-a', 'shot.update', changedDraft), null);
  assert.equal(h.state.calls.length, 1); assert.deepEqual(changedDraft.patch, { prompt: 'Later unsaved draft' });
  fail = false;
  assert.equal(await h.run(original.key, original.operation, original.input, 'Recovered', { replay: true, returnAfterNavigation: true }), null);
  assert.equal(h.state.calls.length, 2); assert.deepEqual(h.state.calls[0], h.state.calls[1]);
  assert.equal(readPending('project-a', original.key), null);
  assert.deepEqual(changedDraft.patch, { prompt: 'Later unsaved draft' });
  assert.equal(h.busy.size, 0);
});

test('actual App run retains auth/ID-conflict/protocol failures and clears only bound rollback proof', async t => {
  let error = new ApiError('Expired', 'UNAUTHORIZED', {}, true);
  const h = harness(t, async () => { throw error; });
  await h.run('save:shot-a', 'shot.update', input);
  const original = readPending('project-a', 'save:shot-a'); assert.ok(original); assert.equal(h.state.auth, false);
  for (const next of [new ApiError('Conflict', 'IDEMPOTENCY_CONFLICT', {}, true), new ApiError('Protocol', 'BACKEND_PROTOCOL_ERROR'), new ApiError('Unbound proof', 'REVISION_CONFLICT', { mutationOutcome: 'not_applied', requestId: 'wrong-id' }, true)]) {
    error = next; await h.run(original.key, original.operation, original.input, undefined, { replay: true });
    assert.deepEqual(readPending('project-a', original.key), original);
  }
  error = new ApiError('Proven rollback', 'REVISION_CONFLICT', { mutationOutcome: 'not_applied', requestId: original.input.requestId }, true);
  await h.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.equal(readPending('project-a', original.key), null); assert.equal(h.state.calls.length, 5);
});

test('malformed six-op success is not acknowledged and remains explicitly recoverable', async t => {
  const h = harness(t, async () => ({ id: 'wrong-shot', projectId: 'project-a', revision: 4 }));
  assert.equal(await h.run('save:shot-a', 'shot.update', input), null);
  assert.ok(readPending('project-a', 'save:shot-a')); assert.equal(h.state.calls.length, 1);
});

test('late project A success cannot refresh or navigate project B and mutation locks are isolated', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = harness(t, async (_op, current) => current.shotId === 'shot-a' ? held : ({ id: 'node-b', projectId: 'project-b', revision: 2 }));
  const pending = h.run('save:shot-a', 'shot.update', input, 'Must not appear');
  assert.equal(h.state.calls.length, 1);
  assert.equal(await h.run('other-key', 'node.update', { nodeId: 'node-a', expectedRevision: 1, patch: { text: 'blocked while in flight' } }), null);
  assert.equal(h.state.calls.length, 1);
  h.currentProject.current = 'project-b'; h.state.epoch++;
  h.dataRef.current = { project: { id: 'project-b' }, shots: [], nodes: [{ id: 'node-b', projectId: 'project-b' }] };
  assert.deepEqual(await h.run('save:node-b', 'node.update', { nodeId: 'node-b', expectedRevision: 1, patch: { text: 'Other project' } }), { id: 'node-b', projectId: 'project-b', revision: 2 });
  release(saved); assert.equal(await pending, null);
  assert.deepEqual(h.state.refreshes, ['project-b']);
  assert.equal(h.state.notices.some(item => item.message === 'Must not appear'), false);
  assert.equal(h.busy.size, 0); assert.equal(readPending('project-a', 'save:shot-a'), null);
});

function structureHarness({ results = [{ id: 'first' }, null], afterGuard, afterRun } = {}) {
  const state = { project: { id: 'project-a' }, shots: [], nodes: [], assets: [] };
  const currentProject = { current: 'project-a' }, dataRef = { current: state }, calls = [], notices = [];
  const scope = { data: state, dataRef, currentProject, isBusy: () => false,
    guardNavigation: async () => { afterGuard?.(state, currentProject); return true; },
    context: () => ({ projectId: currentProject.current }), isCurrent: captured => captured.projectId === currentProject.current,
    markBusy: () => {}, run: async (...args) => { calls.push(args); const result = results[calls.length - 1]; afterRun?.(state, currentProject, calls.length); return result; },
    notify: (...args) => notices.push(args), refresh: async () => state, inspect: async () => true, revealCanvas: () => {}, readableError: error => error.message,
  };
  return { run: compile(structureSource, 'addStructure', scope), calls, notices, currentProject, state };
}

test('actual structure action stops on first unacknowledged step and reports partial count', async () => {
  const h = structureHarness(); await h.run();
  assert.equal(h.calls.length, 2); assert.equal(h.calls.every(call => call[1] === 'shot.create'), true);
  assert.match(h.notices[0][0], /已确认 1\/3.*其余镜头不会自动创建/);
});

test('actual structure action rejects stale, now-nonempty and late-navigation continuations', async () => {
  for (const afterGuard of [state => { state.shots.push({ id: 'external' }); }, state => { state.nodes.push({ id: 'external' }); }, (_state, project) => { project.current = 'project-b'; }]) {
    const h = structureHarness({ afterGuard }); await h.run(); assert.equal(h.calls.length, 0);
  }
  const stale = structureHarness(); stale.currentProject.current = 'project-b'; await stale.run(); assert.equal(stale.calls.length, 0);
  const late = structureHarness({ afterRun: (_state, project) => { project.current = 'project-b'; } }); await late.run(); assert.equal(late.calls.length, 1); assert.equal(late.notices.length, 0);
});

test('retained old Inspector save and version-selection callbacks cannot write after project switch', async t => {
  const h = harness(t, async () => { throw Error('Stale callbacks must never reach RPC'); });
  const save = compile(section('async function saveShot(', 'async function saveNode('), 'saveShot', { run: h.run, referenceWorkBlocked: () => false });
  const nodeSave = compile(section('async function saveNode(', 'async function savePosition('), 'saveNode', { run: h.run });
  const select = compile(section('async function selectVersion(', 'async function reorder('), 'selectVersion', { run: h.run });
  h.currentProject.current = 'project-b'; h.state.epoch++;
  h.dataRef.current = { project: { id: 'project-b' }, shots: [{ id: 'shot-b', projectId: 'project-b' }], nodes: [{ id: 'node-b', projectId: 'project-b' }] };
  assert.equal(await save('shot-a', 3, { prompt: 'Stale old draft' }), null);
  assert.equal(await nodeSave('node-a', 3, { text: 'Stale old note' }), null);
  assert.equal(await select({ id: 'shot-a', revision: 3 }, 'version-a'), null);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.pending.length, 0);
  assert.equal(h.state.notices.length, 3);
  assert.equal(h.state.notices.every(item => /项目或编辑目标已变化/.test(item.message)), true);
});

test('explicit stored replay survives removal of target from current snapshot without wrong-project admission', async t => {
  let fail = true;
  const h = harness(t, async () => { if (fail) throw Error('Lost response'); return saved; });
  await h.run('save:shot-a', 'shot.update', input);
  const original = readPending('project-a', 'save:shot-a');
  h.dataRef.current.shots = []; fail = false;
  await h.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.equal(h.state.calls.length, 2); assert.deepEqual(h.state.calls[0], h.state.calls[1]);
});
