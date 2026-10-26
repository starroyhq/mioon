import type {captureTaskWorkspaceIntent as CapturedIntent} from '../apps/web/src/task-workspace-intent.ts';
import type {PendingEntry} from '../apps/web/src/submissions.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSourceTypes } from './helpers/eval-source.ts';
import { prepareMutation, isMutationOperation, assertMutationOwner, mutationNotApplied, validateMutationResponse } from '../apps/web/src/mutation-submissions.ts';
import { prepareSubmission, readPending, clearPending, pendingForProject } from '../apps/web/src/submissions.ts';
import { ApiError } from '../apps/web/src/api.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';
const taskIntentModule = {exports:{} as {captureTaskWorkspaceIntent:typeof CapturedIntent}};
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
const runSource = section('async function runSession(', 'async function inspect(').replace('async function runSession(', 'async function run(');
const structureSource = section('async function addStructure()', 'async function addNode(');
function compile(code: string, name: string, scope: { [s: string]: unknown; }|ArrayLike<unknown>) { scope = { msg, ...createI18nTestContext(), localizedError: (value?: string|DisplayMessage|null|undefined) => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }), ...scope }; return Function(...Object.keys(scope), `${stripSourceTypes(code,{loader:'tsx'})}; return ${name};`)(...Object.values(scope)); }
function storage(t: { after: (arg0: () => boolean|typeof globalThis) => void; }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map<string,string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: (i:number) => [...values.keys()][i], getItem: (k:string) => values.get(k) ?? null, setItem: (k:string,v:string) => values.set(k, String(v)), removeItem: (k:string) => values.delete(k) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
}
interface HarnessState {epoch:number;calls:{operation:string;input:Record<string,unknown>}[];notices:{message:string;type:string}[];refreshes:string[];pending:PendingEntry[];jobs:boolean;auth:boolean}
interface HarnessData {project:{id:string};shots:{id:string;projectId:string}[];nodes:{id:string;projectId:string}[]}
function harness(t:test.TestContext,dispatch:(operation:string,input:Record<string,unknown>,state:HarnessState)=>unknown) {
  storage(t);
  const state:HarnessState = {epoch: 0, calls: [], notices: [], refreshes: [], pending: [], jobs: false, auth: true };
  const currentProject = { current: 'project-a' }, busy = new Set();
  const scope = {
    shotTextRef: { current: null }, currentProject, context: () => ({ projectId: currentProject.current, epoch: state.epoch }),
    isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key:string,id:string) => busy.has(`${id}:${key}`), markBusy: (id:string,key:string,value:boolean) => value ? busy.add(`${id}:${key}`) : busy.delete(`${id}:${key}`),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, setPending: (value:PendingEntry[]) => { state.pending = value; },
    rpc: async (operation:string,input:Record<string,unknown>) => { state.calls.push({ operation, input: structuredClone(input) }); return dispatch(operation, input, state); },
    refresh: async (id:string) => { state.refreshes.push(id); }, notify: (message:DisplayMessage|string,type:string) => state.notices.push({ message: renderCoreMessage('zh-Hans', message), type }),
    openTasks: (canReveal: () => unknown = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: (value: boolean) => { state.auth = value; }, readableError: (error:Error) => error.message,
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, dataRef: {current: {project:{id:'project-a'},shots:[{id:'shot-a',projectId:'project-a'}],nodes:[]} as HarnessData}, setData: () => {},
  };
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify((captured as typeof captured & {workspace?:unknown}).workspace || 'test-workspace') }; } });
  return { state, currentProject, busy, dataRef: scope.dataRef, run: compile(runSource, 'run', scope) };
}
const input = { shotId: 'shot-a', expectedRevision: 3, patch: { prompt: 'Original draft' } };
const saved = { id: 'shot-a', projectId: 'project-a', revision: 4, prompt: 'Original draft' };

test('actual App legacy session runner keeps changed draft blocked until explicit original replay, with no automatic POST', async t => {
  let fail = true;
  const h = harness(t, async () => { if (fail) throw Error('Response lost'); return saved; });
  assert.equal(await h.run('save:shot-a', 'shot.update', input), null);
  const original = readPending('project-a', 'save:shot-a');
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.jobs, true);
  const changedDraft = { ...input, expectedRevision: 9, patch: { prompt: 'Later unsaved draft' } };
  assert.equal(await h.run('save:shot-a', 'shot.update', changedDraft), null);
  assert.equal(h.state.calls.length, 1); assert.deepEqual(changedDraft.patch, { prompt: 'Later unsaved draft' });
  fail = false;
  assert.equal(await h.run((original)!.key, (original)!.operation, (original)!.input, 'Recovered', { replay: true, returnAfterNavigation: true }), null);
  assert.equal(h.state.calls.length, 2); assert.deepEqual(h.state.calls[0], h.state.calls[1]);
  assert.equal(readPending('project-a', (original)!.key), null);
  assert.deepEqual(changedDraft.patch, { prompt: 'Later unsaved draft' });
  assert.equal(h.busy.size, 0);
});

test('actual App legacy session runner retains auth/ID-conflict/protocol failures and clears only bound rollback proof', async t => {
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
  let release!:(value:typeof saved)=>void;
  const held = new Promise<typeof saved>(resolve => { release = resolve; });
  const h = harness(t, async (_op, current) => current.shotId === 'shot-a' ? held : ({ id: 'node-b', projectId: 'project-b', revision: 2 }));
  const pending = h.run('save:shot-a', 'shot.update', input, 'Must not appear');
  assert.equal(h.state.calls.length, 1);
  assert.equal(await h.run('other-key', 'node.update', { nodeId: 'node-a', expectedRevision: 1, patch: { text: 'blocked while in flight' } }), null);
  assert.equal(h.state.calls.length, 1);
  h.currentProject.current = 'project-b'; h.state.epoch++;
  h.dataRef.current = { project: { id: 'project-b' }, shots: [], nodes: [{ id: 'node-b', projectId: 'project-b' }] };
  assert.deepEqual(await h.run('save:node-b', 'node.update', { nodeId: 'node-b', expectedRevision: 1, patch: { text: 'Other project' } }), { id: 'node-b', projectId: 'project-b', revision: 2 });
  (release)!(saved); assert.equal(await pending, null);
  assert.deepEqual(h.state.refreshes, ['project-b']);
  assert.equal(h.state.notices.some(item => item.message === 'Must not appear'), false);
  assert.equal(h.busy.size, 0); assert.equal(readPending('project-a', 'save:shot-a'), null);
});

interface StructureState {project:{id:string};shots:{id:string}[];nodes:{id:string}[];assets:unknown[]}
interface StructureOptions {results?:({id:string}|null)[];afterGuard?:(state:StructureState,project:{current:string})=>void;afterRun?:(state:StructureState,project:{current:string},count:number)=>void}
function structureHarness({ results = [{ id: 'first' }, null], afterGuard, afterRun }:StructureOptions = {}) {
  const state:StructureState = {project:{id:'project-a'},shots:[],nodes:[],assets:[]};
  const currentProject = { current: 'project-a' }, dataRef = { current: state }, calls:unknown[][] = [], notices:[string,...unknown[]][] = [];
  const scope = { data: state, dataRef, currentProject, isBusy: () => false,
    guardNavigation: async () => { afterGuard?.(state, currentProject); return true; },
    context: () => ({ projectId: currentProject.current }), isCurrent: (captured: { projectId: string; }) => captured.projectId === currentProject.current,
    markBusy: () => {}, run: async (...args:unknown[]) => { calls.push(args); const result = results[calls.length - 1]; afterRun?.(state, currentProject, calls.length); return result; },
    notify: (value:DisplayMessage|string,...args:unknown[]) => notices.push([renderCoreMessage('zh-Hans', value), ...args]), refresh: async () => state, inspect: async () => true, revealCanvas: () => {}, readableError: (error:Error) => error.message,
  };
  return { run: compile(structureSource, 'addStructure', scope), calls, notices, currentProject, state };
}

test('actual structure action stops on first unacknowledged step and reports partial count', async () => {
  const h = structureHarness(); await h.run();
  assert.equal(h.calls.length, 2); assert.equal(h.calls.every(call => call[1] === 'shot.create'), true);
  assert.match(h.notices[0][0], /已确认 1\/3.*其余镜头不会自动创建/);
});

test('actual structure action rejects stale, now-nonempty and late-navigation continuations', async () => {
  for (const afterGuard of [(state: { shots: { id: string; }[]; }) => { state.shots.push({ id: 'external' }); }, (state: { nodes: { id: string; }[]; }) => { state.nodes.push({ id: 'external' }); }, (_state:StructureState,project:{current:string}) => { project.current = 'project-b'; }]) {
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
  await h.run((original)!.key, (original)!.operation, (original)!.input, undefined, { replay: true });
  assert.equal(h.state.calls.length, 2); assert.deepEqual(h.state.calls[0], h.state.calls[1]);
});
