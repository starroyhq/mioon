import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, isTimelineRenderRecord, hasRequestNotAppliedProof, timelineOutputPreset } from '@mioon/contracts';
import * as submissions from '../apps/web/src/submissions.js';
import * as mutations from '../apps/web/src/mutation-submissions.js';
import { isReferenceOperation } from '../apps/web/src/reference-connections.js';

const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const runSource = source.slice(source.indexOf('async function runSession('), source.indexOf('async function inspect(')).replace('async function runSession(', 'async function run(');
const refreshSource = source.slice(source.indexOf('const refresh = useCallback('), source.indexOf('async function selectProject('));
const id = n => `82000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), otherProjectId = id(2), trackId = id(3), clipId = id(4), assetId = id(5);
const operations = ['timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.remove',
  'timeline.clip.split', 'timeline.clip.replaceSource', 'timeline.seed', 'timeline.undo', 'timeline.redo', 'timeline.render', 'timeline.format.set'];
const clone = value => structuredClone(value);
function storage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
  return values;
}
function inputFor(operation, patch = {}) {
  const fields = {
    'timeline.track.add': { kind: 'audio', name: 'Sound' },
    'timeline.track.update': { trackId, patch: { muted: true, name: 'Edited track' } },
    'timeline.clip.add': { trackId, assetId: id(9), name: 'Added', startFrame: 100, durationFrames: 40, sourceInFrame: 11, gain: 0.5 },
    'timeline.clip.update': { clipId, patch: { gain: 0.5, rect: { x: 100, y: 200, width: 300, height: 400 } } },
    'timeline.clip.remove': { clipId }, 'timeline.clip.split': { clipId, atFrame: 50 },
    'timeline.clip.replaceSource': { clipId, assetId: id(9) }, 'timeline.render': { purpose: 'preview' },
    'timeline.format.set': { expectedProjectRevision: 3, presetId: 'landscape_720' },
  };
  return { projectId, expectedRevision: 7, requestId: `original-${operation}`, ...fields[operation], ...patch };
}
function recoverableInput(operation) {
  return operation.startsWith('timeline.') ? inputFor(operation) : { projectId, requestId: `original-${operation}`, expectedShotRevision: 7,
    ...(operation === 'reference.attach' ? { sourceNodeId: id(11), targetShotId: id(12), expectedSourceRevision: 3, role: 'first_frame' } : { edgeId: id(13) }) };
}
function timeline(revision = 8, owner = projectId) {
  return { id: id(6), projectId: owner, revision, fps: 30, width: 720, height: 1280, durationFrames: 90,
    tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
    clips: [{ id: clipId, trackId, assetId, name: 'Original', startFrame: 10, durationFrames: 80, sourceInFrame: 11,
      rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 }],
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:01.000Z' };
}
function acknowledged(operation, input) {
  const value = timeline(input.expectedRevision + 1, input.projectId);
  if (operation === 'timeline.format.set') {
    const { fps, width, height } = timelineOutputPreset(input.presetId);
    Object.assign(value, { fps, width, height, clips: [], durationFrames: 0 });
  }
  if (operation === 'timeline.track.add') value.tracks.push({ id: id(7), name: input.name, kind: input.kind, orderIndex: 1, hidden: false, muted: false });
  if (operation === 'timeline.track.update') Object.assign(value.tracks[0], input.patch);
  if (operation === 'timeline.clip.add') {
    value.clips.push({ ...clone(value.clips[0]), id: id(8), trackId: input.trackId, assetId: input.assetId, name: input.name,
      startFrame: input.startFrame, durationFrames: input.durationFrames, sourceInFrame: input.sourceInFrame, gain: input.gain });
    value.durationFrames = 140;
  }
  if (operation === 'timeline.clip.update') Object.assign(value.clips[0], input.patch);
  if (operation === 'timeline.clip.remove') { value.clips = []; value.durationFrames = 0; }
  if (operation === 'timeline.clip.replaceSource') value.clips[0].assetId = input.assetId;
  if (operation === 'timeline.clip.split') {
    const right = { ...clone(value.clips[0]), id: id(8), startFrame: input.atFrame, durationFrames: 40, sourceInFrame: 51 };
    value.clips[0].durationFrames = 40; value.clips.push(right);
  }
  if (operation !== 'timeline.render') return value;
  value.revision = input.expectedRevision;
  return { id: id(10), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose,
    timelineRevision: input.expectedRevision, snapshot: { timeline: value,
      assets: [{ id: assetId, sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 10, width: 720, height: 1280, hasAudio: true }] },
    status: 'queued', assetId: null, url: null, error: null, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function harness(dispatch, { projectSnapshot } = {}) {
  const state = { epoch: 0, calls: [], notices: [], refreshes: [], pending: submissions.pendingForProject(projectId), jobs: false, auth: true };
  const currentProject = { current: projectId }, busy = new Set();
  const dataRef = { current: { project: { id: projectId }, timeline: timeline(7), timelineHistory: { revision: 7 } } };
  const scope = { ...submissions, ...mutations, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, isReferenceOperation,
    currentProject, dataRef, context: () => ({ projectId: currentProject.current, epoch: state.epoch }),
    isCurrent: owner => owner.projectId === currentProject.current && owner.epoch === state.epoch,
    isBusy: (key, owner) => busy.has(`${owner}:${key}`), markBusy: (owner, key, value) => value ? busy.add(`${owner}:${key}`) : busy.delete(`${owner}:${key}`),
    requestCounter: { current: 0 }, setData: update => { dataRef.current = typeof update === 'function' ? update(dataRef.current) : update; },
    setPending: entries => { state.pending = entries; }, setShowJobs: value => { state.jobs = value; }, setAuth: value => { state.auth = value; },
    readableError: error => error.message, clipReplacementErrorMessage: error => error.message,
    notify: (message, type) => state.notices.push({ message, type }), refresh: async owner => { state.refreshes.push(owner); },
    rpc: async (operation, input) => {
      if (projectSnapshot && operation === 'project.get') return projectSnapshot(input.projectId);
      if (projectSnapshot && operation === 'provider.list') return [];
      state.calls.push({ operation, input: clone(input) }); return dispatch(operation, input);
    },
  };
  if (projectSnapshot) {
    const refreshScope = { ...scope, useCallback: callback => callback, emptyData: {}, projectEpoch: { current: 1 },
      setProviders() {}, setLastSync() {}, setOnline() {}, reconcileWorkspaceState: value => value,
      viewRef: { current: {} }, viewReady: { current: false }, setView() {}, preferencesRef: { current: {} } };
    delete refreshScope.refresh;
    scope.refresh = Function(...Object.keys(refreshScope), `${refreshSource}; return refresh;`)(...Object.values(refreshScope));
  }
  return { state, currentProject, dataRef, busy, run: Function(...Object.keys(scope), `${runSource}; return run;`)(...Object.values(scope)) };
}
const keyFor = operation => operation === 'timeline.render' ? 'timeline:render:preview' : 'timeline:mutation';
const error = (code, details = {}, definitive = true) => Object.assign(Error('Synthetic failure'), { code, details, definitive });

test('actual App legacy session runner guards exactly the twelve timeline writes and accepts their complete matching acknowledgements', async t => {
  storage(t); assert.deepEqual(new Set(TIMELINE_MUTATION_OPERATIONS), new Set(operations));
  const h = harness(acknowledged);
  for (const operation of operations) {
    const input = inputFor(operation), expected = acknowledged(operation, input), key = keyFor(operation);
    assert.equal(isTimelineMutationResponse(operation, input, expected), true, `${operation} fixture`);
    assert.deepEqual(await h.run(key, operation, input), expected, operation);
    assert.equal(submissions.readPending(projectId, key), null, operation);
  }
  assert.equal(h.state.calls.length, operations.length); assert.equal(h.busy.size, 0);
  assert.match(runSource, /const timeline = TIMELINE_MUTATION_OPERATIONS\.includes\(operation\)/);
  assert.doesNotMatch(runSource, /operation\.startsWith\('timeline\.'\)/);
});

test('format recovery preserves expected project revision and absent-timeline revision zero in the original session intent', async t => {
  storage(t);
  const operation = 'timeline.format.set', exact = inputFor(operation, { expectedRevision: 0, presetId: 'square_720' });
  const expected = acknowledged(operation, exact); let lost = true;
  assert.equal(isTimelineMutationResponse(operation, exact, expected), true); assert.equal(expected.revision, 1);
  assert.deepEqual([expected.width, expected.height, expected.fps, expected.durationFrames, expected.clips.length], [720, 720, 30, 0, 0]);
  const h = harness((op, input) => { if (lost) throw Error('Lost format response'); return acknowledged(op, input); });
  await h.run('timeline:mutation', operation, exact);
  const original = submissions.readPending(projectId, 'timeline:mutation');
  assert.deepEqual(original.input, exact);
  lost = false;
  await h.run('timeline:mutation', operation, { ...exact, expectedProjectRevision: 99, presetId: 'landscape_720', requestId: 'changed-format-intent' });
  assert.equal(h.state.calls.length, 1); assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  assert.deepEqual(await h.run(original.key, operation, original.input, undefined, { replay: true }), expected);
  assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null);
  assert.deepEqual(h.state.calls, [{ operation, input: exact }, { operation, input: exact }]);
});

test('every timeline write retains the exact original receipt after loss, 404/409 and corrupt ACK until explicit valid replay', async t => {
  storage(t);
  for (const operation of operations) {
    let failure = Error('Response lost'), result;
    const h = harness(() => { if (failure) throw failure; return result; });
    const input = inputFor(operation), originalBytes = JSON.stringify(input), key = keyFor(operation);
    await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key); assert.ok(original, operation); assert.equal(h.state.jobs, true);
    for (const code of ['NOT_FOUND', 'TRACK_NOT_FOUND', 'CLIP_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED']) {
      failure = error(code); await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: ${code}`);
    }
    failure = null;
    for (const invalid of [null, {}, { projectId, revision: 8 }, { ...acknowledged(operation, input), projectId: otherProjectId }]) {
      result = invalid; await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: corrupt ACK`);
    }
    const calls = h.state.calls.length;
    await h.run(key, operation, { ...input, expectedRevision: 99, requestId: 'must-not-resubmit' });
    assert.equal(h.state.calls.length, calls, 'A new edit or preview cannot implicitly replay');
    assert.deepEqual(submissions.readPending(projectId, key), original);
    result = acknowledged(operation, input); await h.run(key, operation, input, undefined, { replay: true });
    assert.equal(submissions.readPending(projectId, key), null);
    assert.ok(h.state.calls.every(call => JSON.stringify(call.input) === originalBytes));
    assert.equal(h.busy.size, 0);
  }
});

test('timeline rollback requires matching request-bound proof and rejects forbidden or contradictory claims', async t => {
  storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), key = keyFor(operation);
    let failure = Error('Response lost');
    const h = harness(() => { throw failure; }); await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key);
    const proof = { mutationOutcome: 'not_applied', requestId: input.requestId, ...(operation === 'timeline.format.set' ? { operation, projectId: input.projectId } : {}) };
    for (const invalid of [error('REVISION_CONFLICT', { ...proof, requestId: 'wrong-request' }), error('REVISION_CONFLICT', proof, false),
      error('REVISION_CONFLICT', { ...proof, mutationOutcome: 'applied' }), error('UNAUTHORIZED', proof), error('IDEMPOTENCY_CONFLICT', proof),
      error('BACKEND_PROTOCOL_ERROR', proof), ...(operation === 'timeline.format.set' ? [
        error('REVISION_CONFLICT', { ...proof, operation: 'timeline.clip.update' }),
        error('REVISION_CONFLICT', { ...proof, projectId: otherProjectId }),
        error('REVISION_CONFLICT', { mutationOutcome: 'not_applied', requestId: input.requestId }),
      ] : [])]) {
      failure = invalid; await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: ${failure.code}`);
    }
    failure = error('REVISION_CONFLICT', proof); await h.run(key, operation, input, undefined, { replay: true });
    assert.equal(submissions.readPending(projectId, key), null, operation);
  }
});

test('fresh proven timeline rejection releases the key for a new user intent', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let reject = true;
  const h = harness((op, value) => { if (reject) throw error('SOURCE_BOUNDS', { mutationOutcome: 'not_applied', requestId: value.requestId }); return acknowledged(op, value); });
  await h.run('timeline:mutation', operation, input); assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null);
  reject = false; const corrected = { ...input, requestId: 'corrected-user-intent' };
  assert.ok(await h.run('timeline:mutation', operation, corrected)); assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[1].input.requestId, corrected.requestId);
});

test('same-session reload rediscovers exact pending writes without automatically submitting or accepting newer project state', async t => {
  const values = storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  const first = harness(() => { throw Error('Lost after commit'); }); await first.run('timeline:mutation', operation, input);
  const original = submissions.readPending(projectId, 'timeline:mutation'), bytes = [...values.values()][0];
  const reloaded = harness(acknowledged);
  assert.deepEqual(reloaded.state.pending, [original]); assert.equal(reloaded.state.calls.length, 0);
  submissions.reconcilePending(projectId, { timeline: timeline(99), exports: [{ requestId: input.requestId }], jobs: [{ requestId: input.requestId }] });
  assert.equal([...values.values()][0], bytes); assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  await reloaded.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.deepEqual(reloaded.state.calls, [{ operation, input }]); assert.equal(submissions.readPending(projectId, original.key), null);
});

test('late timeline results preserve project/navigation fences and release only their original busy key', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let release; const held = new Promise(resolve => { release = resolve; });
  const h = harness((_op, value) => value.projectId === projectId ? held : acknowledged(operation, value));
  const pending = h.run('timeline:mutation', operation, input, 'Old success');
  assert.equal(await h.run('timeline:mutation', operation, input), null); assert.equal(h.state.calls.length, 1);
  h.currentProject.current = otherProjectId; h.state.epoch++; h.dataRef.current = { project: { id: otherProjectId }, timeline: timeline(7, otherProjectId) };
  const other = { ...input, projectId: otherProjectId, requestId: 'other-project-edit' };
  assert.ok(await h.run('timeline:mutation', operation, other));
  release(acknowledged(operation, input)); assert.equal(await pending, null);
  assert.deepEqual(h.state.refreshes, [otherProjectId]); assert.equal(h.state.notices.some(item => item.message === 'Old success'), false);
  assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null); assert.equal(h.busy.size, 0);
});

test('late same-project ACK respects draft navigation epoch while an opted-in mounted inspector can receive its own ACK', async t => {
  storage(t);
  for (const returnAfterNavigation of [false, true]) {
    let release; const held = new Promise(resolve => { release = resolve; });
    const h = harness(() => held), input = inputFor('timeline.clip.update'), draft = { gain: 0.75 };
    const pending = h.run('timeline:mutation', 'timeline.clip.update', input, 'Old success', { returnAfterNavigation });
    h.state.epoch++; const expected = acknowledged('timeline.clip.update', input); release(expected);
    assert.deepEqual(await pending, returnAfterNavigation ? expected : null); assert.deepEqual(draft, { gain: 0.75 });
    assert.equal(h.state.notices.length, 0); assert.equal(submissions.readPending(projectId, 'timeline:mutation'), null);
  }
});

test('late loss after project navigation retains only the original project receipt for explicit recovery', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let reject; const held = new Promise((_resolve, fail) => { reject = fail; });
  const h = harness(() => held), pending = h.run('timeline:mutation', operation, input);
  const original = submissions.readPending(projectId, 'timeline:mutation');
  h.currentProject.current = otherProjectId; h.state.epoch++;
  reject(Error('Response lost after leaving project')); assert.equal(await pending, null);
  assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  assert.equal(submissions.readPending(otherProjectId, 'timeline:mutation'), null);
  assert.deepEqual(h.state.refreshes, []); assert.deepEqual(h.state.notices, []); assert.equal(h.busy.size, 0);
  const returned = harness(acknowledged);
  assert.deepEqual(returned.state.pending, [original]); assert.equal(returned.state.calls.length, 0);
  await returned.run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.deepEqual(returned.state.calls, [{ operation, input }]);
});

test('retained timeline and reference callbacks reject old-project input before any persistence or RPC', async t => {
  const values = storage(t);
  for (const operation of [...operations, 'reference.attach', 'reference.detach']) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input, createdAt: '2026-10-10T00:00:00.000Z' });
    const bytes = [...values.entries()]; let reads = 0;
    const h = harness(() => { throw Error('Stale callbacks must not dispatch'); }, { projectSnapshot: () => { reads++; return {}; } });
    h.currentProject.current = otherProjectId; h.state.epoch++; h.dataRef.current = { project: { id: otherProjectId }, timeline: timeline(7, otherProjectId) };
    for (const replay of [false, true]) assert.equal(await h.run(key, operation, input, undefined, { replay }), null, operation);
    assert.equal(h.state.calls.length, 0, operation); assert.equal(reads, 0, operation); assert.equal(h.busy.size, 0);
    assert.deepEqual([...values.entries()], bytes, 'Neither project receives a new or changed receipt');
    assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.equal(submissions.readPending(otherProjectId, key), null);
    submissions.clearPending(projectId, key);
  }
});

test('missing timeline and reference Tasks receipts cannot be recreated by an obsolete replay callback', async t => {
  const values = storage(t);
  for (const operation of [...operations, 'reference.attach', 'reference.detach']) {
    const input = recoverableInput(operation), key = `pending:${operation}`; let reads = 0;
    const h = harness(() => { throw Error('Missing receipts must not dispatch'); }, { projectSnapshot: () => { reads++; return {}; } });
    assert.equal(await h.run(key, operation, input, undefined, { replay: true }), null, operation);
    assert.equal(values.size, 0, operation); assert.equal(h.state.calls.length, 0, operation); assert.equal(reads, 0, operation);
    assert.equal(h.busy.size, 0); assert.match(h.state.notices.at(-1).message, /原请求记录已变化或不再可用/);
  }
});

test('changed timeline and reference replay inputs or operation cannot replace the original saved request', async t => {
  const values = storage(t);
  for (const operation of [...operations, 'reference.attach', 'reference.detach']) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input });
    const bytes = [...values.entries()]; const h = harness(() => { throw Error('Changed replay must not dispatch'); });
    for (const changed of [{ ...input, requestId: 'changed-request' }, { ...input, [operation.startsWith('timeline.') ? 'expectedRevision' : 'expectedShotRevision']: 99 }])
      assert.equal(await h.run(key, operation, changed, undefined, { replay: true }), null);
    const otherOperation = operation === 'timeline.undo' ? 'timeline.redo' : 'timeline.undo';
    assert.equal(await h.run(key, otherOperation, input, undefined, { replay: true }), null);
    assert.equal(h.state.calls.length, 0); assert.deepEqual(h.state.refreshes, []); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original); assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('stored timeline or reference input with a different owner stays intact and is never dispatched', async t => {
  const values = storage(t);
  for (const operation of [...operations, 'reference.attach', 'reference.detach']) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input: { ...input, projectId: otherProjectId } });
    const bytes = [...values.entries()]; const h = harness(() => { throw Error('Wrong-owner receipt must not dispatch'); });
    for (const replay of [false, true]) assert.equal(await h.run(key, operation, input, undefined, { replay }), null);
    assert.equal(h.state.calls.length, 0); assert.deepEqual(h.state.refreshes, []); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original); assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('fresh timeline and reference actions cannot dispatch a different operation stored under the same key', async t => {
  const values = storage(t);
  for (const [operation, storedOperation] of [
    ['reference.attach', 'timeline.clip.update'], ['reference.detach', 'timeline.render'],
    ['reference.attach', 'reference.detach'], ['reference.detach', 'reference.attach'],
    ['timeline.clip.update', 'reference.attach'], ['timeline.render', 'timeline.undo'],
  ]) {
    const key = `pending:${operation}`, input = recoverableInput(operation);
    const original = submissions.prepareSubmission({ projectId, key, operation: storedOperation, input: recoverableInput(storedOperation) });
    const bytes = [...values.entries()]; let reads = 0;
    const h = harness(() => { throw error('REVISION_CONFLICT'); }, { projectSnapshot: () => { reads++; return {}; } });
    for (const replay of [false, true]) assert.equal(await h.run(key, operation, input, undefined, { replay }), null);
    assert.equal(h.state.calls.length, 0, `${operation} must not dispatch stored ${storedOperation}`);
    assert.equal(reads, 0); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('preview and export keys remain independent while pending preview cannot silently resubmit', async t => {
  storage(t); let fail = true;
  const h = harness((operation, input) => { if (fail) throw Error('Lost response'); return acknowledged(operation, input); });
  const preview = inputFor('timeline.render'), exported = { ...preview, requestId: 'original-export', purpose: 'export' };
  await h.run('timeline:render:preview', 'timeline.render', preview);
  await h.run('timeline:render:export', 'timeline.render', exported);
  assert.equal(h.state.calls.length, 2); assert.equal(submissions.pendingForProject(projectId).length, 2);
  fail = false;
  await h.run('timeline:render:preview', 'timeline.render', { ...preview, requestId: 'new-preview' }); assert.equal(h.state.calls.length, 2);
  await h.run('timeline:render:preview', 'timeline.render', preview, undefined, { replay: true });
  assert.equal(submissions.readPending(projectId, 'timeline:render:preview'), null);
  assert.deepEqual(submissions.readPending(projectId, 'timeline:render:export').input, exported);
});

test('digest-bound render stays pending on matching public refresh and clears only after explicit exact replay', async t => {
  storage(t); const operation = 'timeline.render', key = 'timeline:render:export';
  const input = inputFor(operation, { purpose: 'export', preflightSnapshotHash: 'b'.repeat(64) });
  let fail = true;
  const h = harness((op, value) => { if (fail) throw Error('Lost after commit'); return acknowledged(op, value); });
  await h.run(key, operation, input);
  const original = submissions.readPending(projectId, key);
  submissions.reconcilePending(projectId, { exports: [acknowledged(operation, input)] });
  assert.deepEqual(submissions.readPending(projectId, key), original);
  assert.equal(h.state.calls.length, 1);
  fail = false; await h.run(key, operation, input, undefined, { replay: true });
  assert.equal(submissions.readPending(projectId, key), null);
  assert.deepEqual(h.state.calls, [{ operation, input }, { operation, input }]);
});

test('actual App catch and project refresh cannot erase a render receipt after source-ownership or receipt rejection', async t => {
  storage(t);
  for (const digest of [undefined, 'b'.repeat(64)]) {
    const operation = 'timeline.render', key = 'timeline:render:export';
    const input = inputFor(operation, { purpose: 'export', ...(digest ? { preflightSnapshotHash: digest } : {}) });
    const record = acknowledged(operation, input);
    record.status = 'succeeded'; record.assetId = id(20); record.url = `/media/${id(20)}`;
    assert.equal(isTimelineRenderRecord(record, input), true, 'The stale public record looks fully valid');
    let failure = Error('Lost after commit'), refreshes = 0;
    const h = harness((op, value) => { if (failure) throw failure; return acknowledged(op, value); }, {
      projectSnapshot: owner => { refreshes++; return { project: { id: owner }, timeline: timeline(99), jobs: [], exports: [record] }; },
    });
    await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key); assert.ok(original);
    for (const code of ['TIMELINE_SOURCE_UNAVAILABLE', 'INVALID_TIMELINE_SNAPSHOT', 'IDEMPOTENCY_CONFLICT']) {
      failure = error(code); await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, code);
      assert.deepEqual(h.state.pending, [original], code);
    }
    assert.equal(refreshes, 4); assert.equal(h.state.calls.length, 4);
    assert.ok(h.state.calls.every(call => JSON.stringify(call.input) === JSON.stringify(input)));
    failure = null; await h.run(key, operation, input, undefined, { replay: true });
    assert.equal(submissions.readPending(projectId, key), null);
  }
});

test('pending timeline and reference cards disclose session-only recovery without broadening generation copy', () => {
  const cardSource = readFileSync(new URL('../apps/web/src/PendingSubmission.jsx', import.meta.url), 'utf8');
  const code = transformSync(cardSource, { loader: 'jsx', format: 'cjs' }).code, module = { exports: {} };
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const require = name => name === 'react' ? { ...react, default: react }
    : name === '@mioon/contracts' ? { TIMELINE_MUTATION_OPERATIONS }
      : name.endsWith('mutation-submissions.js') ? mutations
        : name.endsWith('reference-connections.js') ? { isReferenceOperation }
          : new Proxy({}, { get: (_target, property) => String(property) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  for (const operation of [...operations, 'reference.attach', 'reference.detach', 'shot.update', 'generation.submit', 'export.create']) {
    const tree = nodes(module.exports.default({ entry: { operation, createdAt: '2026-10-10T00:00:00.000Z' }, busy: false, onReplay() {} }));
    const warning = tree.find(node => node.props?.['data-testid'] === 'mutation-recovery-storage');
    assert.equal(Boolean(warning), !['generation.submit', 'export.create'].includes(operation), operation);
    if (warning) {
      assert.match(warning.props.children.join(''), /恢复记录仅存于当前浏览器会话，未经保险库加密/);
      assert.match(warning.props.children.join(''), /关闭窗口或重建应用会话可能丢失记录/);
    }
  }
});

test('reference attach and detach retain ordinary 4xx without proof and unrelated matching records cannot clear them', async t => {
  storage(t);
  for (const operation of ['reference.attach', 'reference.detach']) {
    const key = operation, input = { projectId, requestId: `original-${operation}`, expectedShotRevision: 7,
      ...(operation === 'reference.attach' ? { sourceNodeId: id(11), targetShotId: id(12), expectedSourceRevision: 3, role: 'first_frame' } : { edgeId: id(13) }) };
    let failure = Error('Lost reference response'); const h = harness(() => { throw failure; }); await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key);
    for (const code of ['NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED']) {
      failure = error(code); await h.run(key, operation, input, undefined, { replay: true });
      submissions.reconcilePending(projectId, { jobs: [{ requestId: input.requestId }], exports: [{ requestId: input.requestId }] });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: ${code}`);
    }
    failure = error('REVISION_CONFLICT', { mutationOutcome: 'not_applied', requestId: 'unrelated-request' });
    await h.run(key, operation, input, undefined, { replay: true }); assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.ok(h.state.calls.every(call => JSON.stringify(call.input) === JSON.stringify(input))); assert.equal(h.state.jobs, true);
    submissions.clearPending(projectId, key);
  }
});
