type ReferenceInput=ReturnType<typeof inputFor>;
type ReferenceSnapshot=ReturnType<typeof snapshot>;
type ReferenceFailure=Error&{code?:string};
type ReferenceFailureDetails={dispatched:boolean;rejected:boolean};
type ReferenceRun=(key:string,operation:string,input:Record<string,unknown>,success?:string,options?:{replay?:boolean;onFailure?:(error:ReferenceFailure,details:ReferenceFailureDetails)=>void})=>Promise<unknown>;
import { message as msg, renderMessage } from './helpers/i18n.ts';
import test from 'node:test';
import { transformSync } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import * as submissions from '../apps/web/src/submissions.ts';
import * as mutations from '../apps/web/src/mutation-submissions.ts';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.ts';
import * as restoredWorkspace from '../apps/web/src/restored-workspace.ts';
import * as projectOpening from '../apps/web/src/project-open-state.ts';
import { defaultWorkspaceState, reconcileWorkspaceState, type WorkspaceState } from '../apps/web/src/workspace-state.ts';
import { readGenerationProviderDirectory } from '../apps/web/src/video-provider-directory.ts';

import { lenientFunction } from './helpers/eval-source.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';
const Function = lenientFunction;
const taskIntentModule = {exports:{}} as {exports:typeof import('../apps/web/src/task-workspace-intent.ts')};
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const runSource = source.slice(source.indexOf('async function runSession('), source.indexOf('async function inspect(')).replace('async function runSession(', 'async function run(');
const refreshSource = source.slice(source.indexOf('const refresh = useCallback('), source.indexOf('async function selectProject('));
const id = (number: number) => `83000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const projectId = id(1), otherProjectId = id(2), sourceNodeId = id(3), shotId = id(4), edgeId = id(5), assetId = id(6);
const key = 'reference:mutation', operations = ['reference.attach', 'reference.detach'];
const clone = <T>(value: T): T => structuredClone(value);
const timestamp = '2026-10-10T00:00:00.000Z';
function storage(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map<string,string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index:number) => [...values.keys()][index] ?? null,
    getItem: (name:string) => values.get(name) ?? null, setItem: (name:string, value: unknown) => values.set(name, String(value)), removeItem: (name:string) => values.delete(name),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as Partial<typeof globalThis>).sessionStorage);
  return values;
}
function inputFor(operation:string, patch:Record<string,unknown> = {}) {
  return { projectId, requestId: `original-${operation}`, expectedShotRevision: 7,
    ...(operation === 'reference.attach' ? { sourceNodeId, targetShotId: shotId, expectedSourceRevision: 3, role: 'first_frame' } : { edgeId }), ...patch };
}
function shot(owner = projectId, revision = 7, referenceAssetIds:string[] = []) {
  return { id: shotId, projectId: owner, title: 'First frame', prompt: 'Original saved prompt', referenceAssetIds, aspectRatio: '9:16',
    duration: 2, parameters: {}, position: { x: 300, y: 100 }, orderIndex: 0, revision, selectedVersionId: null, createdAt: timestamp, updatedAt: timestamp };
}
function acknowledged(operation:string, input: { sourceNodeId: string; targetShotId: string; expectedSourceRevision: number; role: string; projectId: string; requestId: string; expectedShotRevision: number; }|{ edgeId: string; projectId: string; requestId: string; expectedShotRevision: number; }, { noop = false } = {}) {
  const edge = { id: edgeId, projectId: input.projectId, source: sourceNodeId, target: shotId, kind: 'reference', role: 'first_frame', sourceAssetId: assetId, createdAt: timestamp };
  return { edge, shot: shot(input.projectId, input.expectedShotRevision + (noop ? 0 : 1), operation === 'reference.attach' ? [assetId] : []),
    ...(operation === 'reference.detach' ? { detached: true } : {}) };
}
function snapshot(owner = projectId) {
  return { project: { id: owner }, assets: [], shots: [shot(owner)], nodes: [{ id: sourceNodeId, projectId: owner }, { id: id(7), projectId: owner }],
    edges: [], jobs: [], versions: [], exports: [], timeline: null, timelineHistory: null };
}
function save(operation: string, input = inputFor(operation)) {
  return submissions.prepareSubmission({ projectId, key, operation, input, createdAt: timestamp });
}
function harness(dispatch: (operation:string,input:ReferenceInput)=>unknown, { projectSnapshot }: {projectSnapshot?:(owner:string)=>unknown} = {}) {
  const state = { projectReady: true, epoch: 0, calls:[] as {operation:string;input:{projectId:string}&Record<string,unknown>}[], refreshes:[] as unknown[], notices:[] as {message:string;type:unknown}[], pending: submissions.pendingForProject(projectId), pendingUpdates: ([] as (submissions.PendingEntry[])[]),
    jobs: false, auth: true, dataWrites:[] as ReferenceSnapshot[], preferenceWrites: ([] as (unknown[])[]), draft: { prompt: 'A newer unsaved inspector draft' } };
  const currentProject = { current: projectId }, projectEpoch = { current: 1 }, busy = new Set();
  const dataRef = { current: snapshot() }, viewRef = { current: defaultWorkspaceState() };
  viewRef.current.canvas.selectedId = id(7);
  const scope = { msg, localizedError: (value: string|DisplayMessage|null|undefined) => Object.assign(new Error(renderMessage('zh-Hans', value)), { displayMessage: value }), ...submissions, ...mutations, ...workspaceOrigin, ...restoredWorkspace, workspaceRef: { current: { restored: false } }, TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse,
    REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, shotTextRef: { current: null }, currentProject, dataRef,
    context: () => ({ projectId: currentProject.current, epoch: state.epoch }),
    isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (name: unknown, owner: unknown) => busy.has(`${owner}:${name}`),
    markBusy: (owner: unknown, name: unknown, value: unknown) => value ? busy.add(`${owner}:${name}`) : busy.delete(`${owner}:${name}`),
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, setData: (update: ReferenceSnapshot|((old:ReferenceSnapshot)=>ReferenceSnapshot)) => { dataRef.current = typeof update === 'function' ? update(dataRef.current) : update; state.dataWrites.push(clone(dataRef.current)); },
    setPending: (entries: submissions.PendingEntry[]) => { state.pending = entries; state.pendingUpdates.push(clone(entries)); },
    openTasks: (canReveal = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: (value: boolean) => { state.auth = value; },
    readableError: (error: { message: unknown; }) => error.message, clipReplacementErrorDescriptor: (error: { message: unknown; }) => error.message,
    notify: (message:string|DisplayMessage|null|undefined,type:unknown) => state.notices.push({ message: renderMessage('zh-Hans', message), type }), refresh: async (owner:unknown):Promise<void> => { state.refreshes.push(owner); },
    rpc: async (operation: string, input:{projectId:string}&Record<string,unknown>) => {
      if (projectSnapshot && operation === 'project.get') { state.refreshes.push(input.projectId); return projectSnapshot(input.projectId); }
      if (projectSnapshot && operation === 'provider.list') return [];
      if (projectSnapshot && operation === 'video.connection.list') return [];
      state.calls.push({ operation, input: clone(input) }); return dispatch(operation,input as ReferenceInput);
    },
  };
  if (projectSnapshot) {
    const refreshScope = { ...scope, ...projectOpening, application: null, clipDraftRef: { current: null }, projectSessionReady: () => state.projectReady, importSession: { current: { active: true } }, useCallback: (callback: unknown) => callback, emptyData: {}, projectEpoch,
      setProviders() {}, setVideoDirectoryUnavailable() {}, setLastSync() {}, setOnline() {}, reconcileWorkspaceState, readGenerationProviderDirectory, viewRef, viewReady: { current: true },
      // The fixture registers no editing owners, matching the real empty wait.
      refreshAgentEditingTargets: async () => { await Promise.allSettled([]); },
      setView: (value: WorkspaceState) => { viewRef.current = value; }, preferencesRef: { current: { update: (...args: unknown[]) => state.preferenceWrites.push(args) } } };
    delete (refreshScope as Partial<typeof refreshScope>).refresh;
    scope.refresh = Function(...Object.keys(refreshScope), `${refreshSource}; return refresh;`)(...Object.values(refreshScope)) as typeof scope.refresh;
  }
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify((captured as typeof captured&{workspace?:unknown}).workspace || 'test-workspace') }; } });
  return { state, currentProject, projectEpoch, dataRef, viewRef, busy, refresh: scope.refresh, run: Function(...Object.keys(scope), `${runSource}; return run;`)(...Object.values(scope)) as ReferenceRun };
}
const failure = (code: string, details = {}, definitive = true) => Object.assign(Error('Synthetic reference rejection'), { code, details, definitive });
const proofFor = (operation: string, input: { sourceNodeId: string; targetShotId: string; expectedSourceRevision: number; role: string; projectId: string; requestId: string; expectedShotRevision: number; }|{ edgeId: string; projectId: string; requestId: string; expectedShotRevision: number; }) => ({ mutationOutcome: 'not_applied', operation, projectId: input.projectId, requestId: input.requestId });

test('actual App legacy session runner validates both reference writes and preserves existing-binding attach no-op acknowledgements', async t => {
  storage(t); assert.deepEqual(new Set(REFERENCE_MUTATION_OPERATIONS), new Set(operations));
  for (const [operation, noop] of [['reference.attach', false], ['reference.attach', true], ['reference.detach', false]] as const) {
    const input = inputFor(operation), result = acknowledged(operation, input, { noop });
    const h = harness(() => result);
    assert.equal(isReferenceMutationResponse(operation, input, result), true, 'Complete historical fixture');
    assert.deepEqual(await h.run(key, operation, input, 'Acknowledged'), result);
    assert.equal(submissions.readPending(projectId, key), null); assert.deepEqual((h.state.pending as unknown), []);
    assert.equal(h.state.calls.length, 1); assert.deepEqual(h.state.refreshes, [projectId]); assert.equal(h.busy.size, 0);
    assert.equal(h.state.notices.at(-1)!.message, 'Acknowledged');
  }
});

test('malformed 200 responses retain exact reference receipts until a complete explicit acknowledgement', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), expected = acknowledged(operation, input);
    const bad = [null, {}, { ...expected, edge: null }, { ...expected, shot: null },
      { ...expected, edge: { ...expected.edge, projectId: otherProjectId } },
      { ...expected, shot: { ...expected.shot, projectId: otherProjectId } },
      { ...expected, edge: { ...expected.edge, target: id(99) } },
      { ...expected, edge: { ...expected.edge, kind: 'decorative' } },
      { ...expected, edge: { ...expected.edge, role: 'last_frame' } },
      { ...expected, shot: { ...expected.shot, id: id(99) } },
      { ...expected, shot: { ...expected.shot, revision: 99 } },
      { ...expected, shot: { ...expected.shot, referenceAssetIds: [id(99)] } }];
    if (operation === 'reference.attach') bad.push({ ...expected, edge: { ...expected.edge, source: id(99) } });
    else bad.push({ ...expected, detached: false }, { edge: expected.edge, shot: expected.shot }, { ...expected, edge: { ...expected.edge, id: id(99) } });
    let result = bad[0]; const failures:{error:ReferenceFailure;dispatched:boolean;rejected:boolean}[] = [], h = harness(() => result);
    assert.equal(await h.run(key, operation, input, undefined, { onFailure: (error:ReferenceFailure,details:ReferenceFailureDetails) => failures.push({ error, ...details }) }), null);
    const original = submissions.readPending(projectId, key), bytes = [...values.entries()];
    for (result of bad.slice(1)) {
      assert.equal(await h.run(key, operation, input, undefined, { replay: true, onFailure: (error:ReferenceFailure,details:ReferenceFailureDetails) => failures.push({ error, ...details }) }), null);
      assert.deepEqual(submissions.readPending(projectId, key), original);
      assert.deepEqual([...values.entries()], bytes, 'Malformed success cannot alter the saved key or input bytes');
    }
    assert.equal(h.state.jobs, true); assert.ok(h.state.notices.every(notice => notice.type === 'error' && /提交结果尚未确认.*原请求已保留/.test(notice.message)));
    assert.ok(failures.every(item => item.error.code === 'BACKEND_PROTOCOL_ERROR' && item.dispatched && !item.rejected));
    result = expected; assert.deepEqual(await h.run(key, operation, input, undefined, { replay: true }), expected);
    assert.equal(submissions.readPending(projectId, key), null); assert.equal(h.busy.size, 0);
    assert.ok(h.state.calls.every(call => call.operation === operation && JSON.stringify(call.input) === JSON.stringify(input)));
  }
});

test('reference rollback proof requires its exact operation, project, request and reference rejection code', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), proof = proofFor(operation, input);
    let error:ReferenceFailure = Error('Lost after commit'); const h = harness(() => { throw error; });
    await h.run(key, operation, input); const original = submissions.readPending(projectId, key), bytes = [...values.entries()];
    const { operation: _operation, ...noOperation } = proof, { projectId: _project, ...noProject } = proof;
    const invalid = [failure('REVISION_CONFLICT'), failure('REVISION_CONFLICT', { ...proof, requestId: 'unrelated-request' }),
      failure('REVISION_CONFLICT', { ...proof, operation: operation === 'reference.attach' ? 'reference.detach' : 'reference.attach' }),
      failure('REVISION_CONFLICT', { ...proof, projectId: otherProjectId }), failure('REVISION_CONFLICT', noOperation), failure('REVISION_CONFLICT', noProject),
      failure('REVISION_CONFLICT', { ...proof, mutationOutcome: 'applied' }), failure('REVISION_CONFLICT', proof, false),
      ...['TIMELINE_LIMIT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED', 'FORBIDDEN', 'BACKEND_PROTOCOL_ERROR', 'NOT_FOUND', 'CROSS_PROJECT_REFERENCE'].map(code => failure(code, proof))];
    for (error of invalid) {
      assert.equal(await h.run(key, operation, input, undefined, { replay: true }), null);
      assert.deepEqual(submissions.readPending(projectId, key), original, error.code); assert.deepEqual([...values.entries()], bytes);
    }
    error = failure('REVISION_CONFLICT', proof); assert.equal(await h.run(key, operation, input, undefined, { replay: true }), null);
    assert.equal(submissions.readPending(projectId, key), null); assert.equal(h.busy.size, 0);
  }
});

test('a fresh proven reference rejection releases only its original key for a corrected intent', async t => {
  storage(t);
  for (const operation of operations) {
    let reject = true; const input = inputFor(operation);
    const h = harness((op:string, value: { sourceNodeId: string; targetShotId: string; expectedSourceRevision: number; role: string; projectId: string; requestId: string; expectedShotRevision: number; }|{ edgeId: string; projectId: string; requestId: string; expectedShotRevision: number; }) => { if (reject) throw failure('REVISION_CONFLICT', proofFor(op, value)); return acknowledged(op, value); });
    assert.equal(await h.run(key, operation, input), null); assert.equal(submissions.readPending(projectId, key), null);
    assert.equal(h.state.jobs, false); assert.doesNotMatch(h.state.notices.at(-1)!.message, /提交结果尚未确认/);
    reject = false; const corrected = { ...input, requestId: 'corrected-reference-intent', expectedShotRevision: 12 };
    assert.ok(await h.run(key, operation, corrected)); assert.deepEqual(h.state.calls.map(call => call.input), [input, corrected]);
  }
});

test('fresh same-operation reference callbacks cannot implicitly replay a pending input, even unchanged', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), original = save(operation, input), bytes = [...values.entries()];
    const h = harness(() => { throw Error('Fresh callbacks must not dispatch'); });
    for (const changed of [input, { ...input, requestId: 'new-request-must-not-dispatch' }, { ...input, expectedShotRevision: 99 },
      { ...input, [operation === 'reference.attach' ? 'sourceNodeId' : 'edgeId']: id(99) }]) {
      assert.equal(await h.run(key, operation, changed), null);
      assert.deepEqual(submissions.readPending(projectId, key), original); assert.deepEqual([...values.entries()], bytes);
    }
    assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.state.jobs, true); assert.equal(h.busy.size, 0);
    assert.match(h.state.notices.at(-1)!.message, /首帧参考请求.*任务面板恢复同一请求/);
    submissions.clearPending(projectId, key);
  }
});

test('stale-project reference callbacks cannot write either owner or perform any RPC', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), original = save(operation, input), bytes = [...values.entries()];
    const h = harness(() => { throw Error('Stale owner must not dispatch'); });
    h.currentProject.current = otherProjectId; h.state.epoch++; h.projectEpoch.current++; h.dataRef.current = snapshot(otherProjectId);
    for (const replay of [false, true]) assert.equal(await h.run(key, operation, input, undefined, { replay }), null);
    assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.busy.size, 0);
    assert.deepEqual([...values.entries()], bytes); assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.equal(submissions.readPending(otherProjectId, key), null); submissions.clearPending(projectId, key);
  }
});

test('missing, changed, cross-operation and wrong-owner Tasks receipts never create replacement reference requests', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), h = harness(() => { throw Error('Obsolete Tasks callback must not dispatch'); });
    assert.equal(await h.run(key, operation, input, undefined, { replay: true }), null); assert.equal(values.size, 0);
    const original = save(operation, input), bytes = [...values.entries()];
    for (const changed of [{ ...input, requestId: 'changed-request' }, { ...input, expectedShotRevision: 99 }])
      assert.equal(await h.run(key, operation, changed, undefined, { replay: true }), null);
    const otherOperation = operation === 'reference.attach' ? 'reference.detach' : 'reference.attach';
    assert.equal(await h.run(key, otherOperation, inputFor(otherOperation), undefined, { replay: true }), null);
    assert.deepEqual([...values.entries()], bytes);
    for (const changed of [{ ...original, input: { ...input, requestId: 'newer-saved-receipt' } }, { ...original, input: { ...input, projectId: otherProjectId } }]) {
      submissions.writePending(changed); const changedBytes = [...values.entries()];
      assert.equal(await h.run(key, operation, input, undefined, { replay: true }), null);
      assert.deepEqual([...values.entries()], changedBytes, 'An old callback cannot restore its superseded receipt');
    }
    assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.busy.size, 0);
    submissions.clearPending(projectId, key);
  }
});

test('same-session reload recovers original request bytes only through explicit Tasks replay', async t => {
  const values = storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), first = harness(() => { throw Error('Lost reference response'); });
    await first.run(key, operation, input); const original = submissions.readPending(projectId, key), bytes = [...values.entries()];
    const reloaded = harness(acknowledged); assert.deepEqual(reloaded.state.pending, [original]); assert.equal(reloaded.state.calls.length, 0);
    submissions.reconcilePending(projectId, { jobs: [{ requestId: input.requestId }], exports: [{ requestId: input.requestId }],
      shots: [acknowledged(operation, input).shot], edges: [acknowledged(operation, input).edge] });
    assert.deepEqual([...values.entries()], bytes); assert.equal(reloaded.state.calls.length, 0);
    const reorderedInput = Object.fromEntries(Object.entries(input).reverse());
    assert.ok(await reloaded.run(original!.key, original!.operation, reorderedInput, undefined, { replay: true }));
    assert.equal(JSON.stringify(reloaded.state.calls[0].input), JSON.stringify(input), 'Replay dispatches persisted property order and values');
    assert.equal(reloaded.state.calls[0].operation, operation); assert.equal(submissions.readPending(projectId, key), null);
  }
});

test('historical attach and detach recovery do not require today’s edge and preserve newer selection and draft', async t => {
  storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), original = save(operation, input), latest = snapshot();
    latest.shots[0] = { ...shot(projectId, 99, [id(88)]), prompt: 'Later saved prompt' };
    const h = harness(acknowledged, { projectSnapshot: () => latest });
    const draft = clone(h.state.draft), view = clone(h.viewRef.current);
    assert.ok(await h.run(original.key, original.operation, original.input, undefined, { replay: true }));
    assert.equal(h.dataRef.current.shots[0].revision, 99); assert.deepEqual((h.dataRef.current.edges as unknown), []);
    assert.deepEqual(h.state.draft, draft); assert.deepEqual(h.viewRef.current, view); assert.deepEqual((h.state.preferenceWrites as unknown), []);
    assert.equal(submissions.readPending(projectId, key), null); assert.equal(h.state.calls.length, 1);
  }
});

test('late reference ACK after project navigation changes no foreign data, pending view, selection or notice', async t => {
  storage(t);
  for (const operation of operations) {
    let release:((value:unknown)=>void)|undefined; const held = new Promise(resolve => { release = resolve; });
    const input = inputFor(operation), h = harness((_op: unknown, value: { sourceNodeId: string; targetShotId: string; expectedSourceRevision: number; role: string; projectId: string; requestId: string; expectedShotRevision: number; }|{ edgeId: string; projectId: string; requestId: string; expectedShotRevision: number; }) => value.projectId === projectId ? held : acknowledged(operation, value));
    const pending = h.run(key, operation, input, 'Old project success');
    assert.equal(await h.run(key, operation, input), null); assert.equal(h.state.calls.length, 1);
    h.currentProject.current = otherProjectId; h.state.epoch++; h.projectEpoch.current++; h.dataRef.current = snapshot(otherProjectId);
    const foreign = clone(h.dataRef.current), draft = clone(h.state.draft), view = clone(h.viewRef.current);
    const other = { ...input, projectId: otherProjectId, requestId: 'other-project-reference' };
    assert.ok(await h.run(key, operation, other));
    const updates = h.state.pendingUpdates.length; release!(acknowledged(operation, input)); assert.equal(await pending, null);
    assert.deepEqual(h.dataRef.current, foreign); assert.deepEqual(h.state.draft, draft); assert.deepEqual(h.viewRef.current, view);
    assert.equal(h.state.pendingUpdates.length, updates); assert.deepEqual(h.state.refreshes, [otherProjectId]);
    assert.equal(h.state.notices.some(notice => notice.message === 'Old project success'), false); assert.deepEqual((h.state.dataWrites as unknown), []);
    assert.equal(submissions.readPending(projectId, key), null); assert.equal(submissions.readPending(otherProjectId, key), null); assert.equal(h.busy.size, 0);
  }
});

test('late same-project reference ACK respects navigation epoch and keeps a newer inspector draft', async t => {
  storage(t);
  for (const operation of operations) {
    let release:((value:unknown)=>void)|undefined; const held = new Promise(resolve => { release = resolve; });
    const input = inputFor(operation), h = harness(() => held), draft = clone(h.state.draft), view = clone(h.viewRef.current);
    const pending = h.run(key, operation, input, 'Old selection success');
    h.state.epoch++; release!(acknowledged(operation, input)); assert.equal(await pending, null);
    assert.deepEqual(h.state.draft, draft); assert.deepEqual(h.viewRef.current, view); assert.deepEqual((h.state.notices as unknown), []);
    assert.equal(submissions.readPending(projectId, key), null); assert.equal(h.busy.size, 0);
  }
});

test('an old reference refresh cannot overwrite a reopened project epoch or its newer selection', async t => {
  storage(t); const operation = 'reference.attach', input = inputFor(operation);
  let release:((value:unknown)=>void)|undefined,started!:(value?:unknown)=>void; const held = new Promise(resolve => { release = resolve; }), refreshing = new Promise(resolve => { started = resolve; });
  const h = harness(acknowledged, { projectSnapshot: () => { started(); return held; } });
  const pending = h.run(key, operation, input, 'Old epoch success'); await refreshing;
  h.state.epoch++; h.projectEpoch.current++; h.dataRef.current = snapshot(); h.dataRef.current.shots[0].revision = 99;
  const latest = clone(h.dataRef.current), view = clone(h.viewRef.current); release!(snapshot());
  assert.equal(await pending, null); assert.deepEqual(h.dataRef.current, latest); assert.deepEqual(h.viewRef.current, view);
  assert.deepEqual((h.state.dataWrites as unknown), []); assert.deepEqual((h.state.notices as unknown), []); assert.equal(submissions.readPending(projectId, key), null);
});

test('late reference loss keeps only the original owner receipt without touching the foreign project', async t => {
  const values = storage(t);
  for (const operation of operations) {
    let reject; const held = new Promise((_resolve, fail) => { reject = fail; });
    const input = inputFor(operation), h = harness(() => held), pending = h.run(key, operation, input);
    const original = submissions.readPending(projectId, key), bytes = [...values.entries()];
    h.currentProject.current = otherProjectId; h.state.epoch++; h.projectEpoch.current++; h.dataRef.current = snapshot(otherProjectId);
    const foreign = clone(h.dataRef.current); reject!(Error('Response lost after leaving')); assert.equal(await pending, null);
    assert.deepEqual([...values.entries()], bytes); assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.equal(submissions.readPending(otherProjectId, key), null); assert.deepEqual(h.dataRef.current, foreign);
    assert.deepEqual((h.state.refreshes as unknown), []); assert.deepEqual((h.state.notices as unknown), []); assert.equal(h.busy.size, 0);
    const returned = harness(acknowledged); assert.deepEqual(returned.state.pending, [original]);
    assert.ok(await returned.run(original!.key, original!.operation, original!.input, undefined, { replay: true }));
    assert.deepEqual(returned.state.calls, [{ operation, input }]);
  }
});

test('unavailable session storage prevents reference dispatch and never creates an alternate key', async t => {
  const values = storage(t); sessionStorage.setItem = () => { throw Error('Storage denied'); };
  const h = harness(() => { throw Error('No durable receipt means no RPC'); });
  for (const operation of operations) assert.equal(await h.run(key, operation, inputFor(operation)), null);
  assert.equal(values.size, 0); assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.busy.size, 0);
  assert.ok(h.state.notices.every(notice => /无法保存请求恢复记录/.test(notice.message)));
});


test('a project that has not opened cannot publish a recovery refresh', async t => {
  storage(t);
  let reads = 0; const h = harness(() => assert.fail('No mutation'), { projectSnapshot: () => { reads++; return { project: { id: projectId } }; } });
  h.state.projectReady = false; const before = structuredClone(h.dataRef.current);
  assert.equal(await h.refresh(projectId), null); assert.equal(reads, 0); assert.deepEqual(h.dataRef.current, before);
});
