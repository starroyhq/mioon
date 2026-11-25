import type {captureTaskWorkspaceIntent as CapturedIntent} from '../apps/web/src/task-workspace-intent.ts';
import type {PendingEntry} from '../apps/web/src/submissions.ts';
import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import { isGenerationAspectNotApplied, isGenerationAspectResponse } from '../packages/contracts/src/generation-aspect.ts';
import { timelineOutputRatio } from '../packages/contracts/src/timeline-output-geometry.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSourceTypes } from './helpers/eval-source.ts';
import { prepareMutation, isMutationOperation, assertMutationOwner, mutationNotApplied, validateMutationResponse } from '../apps/web/src/mutation-submissions.ts';
import { prepareSubmission, prepareRequestReplay, readPending, clearPending, pendingForProject, reconcilePending } from '../apps/web/src/submissions.ts';
import { ApiError } from '../apps/web/src/api.ts';
import { generationAspectError } from '../apps/web/src/generation-settings.ts';
import { format5CommandErrorMessageKey, format5SceneSplitNotice } from '../apps/web/src/edit-ui/session.ts';
import type { GenerationFrame } from '../apps/web/src/generation-settings.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';
const taskIntentModule = {exports:{} as {captureTaskWorkspaceIntent:typeof CapturedIntent}};
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
const runSource = section('async function runSession(', 'async function inspect(').replace('async function runSession(', 'async function run(');
const addShotSource = section('async function addShot()', 'async function addStructure()');
const structureSource = section('async function addStructure()', 'async function addNode(');
function compile(code: string, name: string, scope: { [s: string]: unknown; }|ArrayLike<unknown>) { scope = { msg, ...createI18nTestContext(), localizedError: (value?: string|DisplayMessage|null|undefined) => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }), ...scope }; return Function(...Object.keys(scope), `${stripSourceTypes(code,{loader:'tsx'})}; return ${name};`)(...Object.values(scope)); }
function storage(t: { after: (arg0: () => boolean|typeof globalThis) => void; }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map<string,string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: (i:number) => [...values.keys()][i], getItem: (k:string) => values.get(k) ?? null, setItem: (k:string,v:string) => values.set(k, String(v)), removeItem: (k:string) => values.delete(k) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
}
interface HarnessState {epoch:number;calls:{operation:string;input:Record<string,unknown>;outputLocale?:string}[];notices:{message:string;type:string}[];refreshes:string[];pending:PendingEntry[];jobs:boolean;auth:boolean}
interface HarnessData {project:{id:string};projectFormatVersion?:number;shots:{id:string;projectId:string}[];nodes:{id:string;projectId:string}[]}
function harness(t:test.TestContext,dispatch:(operation:string,input:Record<string,unknown>,state:HarnessState)=>unknown) {
  storage(t);
  const state:HarnessState = {epoch: 0, calls: [], notices: [], refreshes: [], pending: [], jobs: false, auth: true };
  const currentProject = { current: 'project-a' }, busy = new Set();
  const scope = {
    shotTextRef: { current: null }, currentProject, context: () => ({ projectId: currentProject.current, epoch: state.epoch }),
    isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key:string,id:string) => busy.has(`${id}:${key}`), markBusy: (id:string,key:string,value:boolean) => value ? busy.add(`${id}:${key}`) : busy.delete(`${id}:${key}`),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse, prepareSubmission, prepareRequestReplay, clearPending, pendingForProject,
    generationAspectError, isGenerationAspectNotApplied, isGenerationAspectResponse,
    isReferenceOperation: () => false, setPending: (value:PendingEntry[]) => { state.pending = value; },
    rpc: async (operation:string,input:Record<string,unknown>,options?:{outputLocale?:string}) => { state.calls.push({ operation, input: structuredClone(input), ...(options?.outputLocale?{outputLocale:options.outputLocale}:{}) }); return dispatch(operation, input, state); },
    refresh: async (id:string) => { state.refreshes.push(id); }, notify: (message:DisplayMessage|string,type:string) => state.notices.push({ message: renderCoreMessage('zh-Hans', message), type }),
    openTasks: (canReveal: () => unknown = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: (value: boolean) => { state.auth = value; }, readableError: (error:Error) => error.message,
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, dataRef: {current: {project:{id:'project-a'},projectFormatVersion:3,shots:[{id:'shot-a',projectId:'project-a'}],nodes:[]} as HarnessData}, setData: () => {},
  };
  Object.assign(scope, { format5BoardSession: () => ({run: async () => ({ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'})}),
    captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify((captured as typeof captured & {workspace?:unknown}).workspace || 'test-workspace') }; } });
  return { state, currentProject, busy, dataRef: scope.dataRef, run: compile(runSource, 'run', scope) };
}
const input = { shotId: 'shot-a', expectedRevision: 3, patch: { prompt: 'Original draft' } };
const saved = { id: 'shot-a', projectId: 'project-a', revision: 4, prompt: 'Original draft' };

test('lost output response retains the original locale separately from the exact RPC input',async t=>{
  const h=harness(t,async()=>{throw Error('Response lost');});
  const input={projectId:'project-a',requestId:'original-export-request'};
  await h.run('export','export.create',input,undefined,{outputLocale:'ja'});
  const original=readPending(input.projectId,'export');
  assert.ok(original);
  assert.equal(original.outputLocale,'ja');
  assert.deepEqual(original.input,input);
  await h.run(original.key,original.operation,original.input,undefined,{replay:true,outputLocale:'en'});
  assert.deepEqual(h.state.calls,[{operation:'export.create',input,outputLocale:'ja'},{operation:'export.create',input,outputLocale:'ja'}]);
  assert.deepEqual(readPending(input.projectId,'export'),original);

  clearPending(input.projectId,'export');
  const legacy=prepareSubmission({projectId:input.projectId,key:'export',operation:'export.create',input,createdAt:'2026-10-10T00:00:00Z'});
  await h.run(legacy.key,legacy.operation,legacy.input,undefined,{replay:true,outputLocale:'en'});
  assert.deepEqual(h.state.calls.at(-1),{operation:'export.create',input});
  assert.deepEqual(readPending(input.projectId,'export'),legacy);
});

test('a new frame confirmation cannot replay an uncertain generation; exact recovery reports the stale frame', async t => {
  let error: Error = new Error('Response lost');
  const h = harness(t, () => { throw error; });
  const key = 'generate:shot-a', operation = 'generation.submit';
  const original = { shotId: 'shot-a', requestId: 'confirmed-portrait', aspectSource: { kind: 'project', expectedTimelineRevision: 2, aspectRatio: '9:16' } };
  const current = { ...original, requestId: 'confirmed-landscape', aspectSource: { kind: 'project', expectedTimelineRevision: 3, aspectRatio: '16:9' } };
  await h.run(key, operation, original);
  await h.run(key, operation, current);
  assert.deepEqual(h.state.calls, [{ operation, input: original }]);
  assert.equal(h.state.notices.at(-1)?.message, translate('zh-Hans', 'shell.error.generationRequestPending'));
  await h.run(key, operation, current, undefined, { replay: true });
  await h.run(key, operation, { shotId: original.shotId, requestId: 'an-older-legacy-key' }, undefined, { replay: true });
  assert.equal(h.state.calls.length, 1, 'Only the exact saved request can be replayed');
  assert.deepEqual(readPending('project-a', key)?.input, original);
  error = new ApiError('Frame changed', 'PROJECT_ASPECT_CHANGED', {
    mutationOutcome: 'not_applied', projectId: 'other-project', shotId: original.shotId, requestId: original.requestId, timelineRevision: 3, projectAspectRatio: '16:9',
  }, true, 409);
  await h.run(key, operation, original, undefined, { replay: true });
  assert.deepEqual(readPending('project-a', key)?.input, original, 'An unrelated 409 does not release this confirmation');
  error = new ApiError('Frame changed', 'PROJECT_ASPECT_CHANGED', {
    ...((error as ApiError).details as Record<string, unknown>), projectId: 'project-a',
  }, true, 409);
  await h.run(key, operation, original, undefined, { replay: true });
  assert.deepEqual(h.state.calls.slice(1), [{ operation, input: original }, { operation, input: original }]);
  assert.equal(h.state.notices.at(-1)?.message, translate('zh-Hans', 'shell.generationFrameChanged'));
  assert.equal(readPending('project-a', key), null);
});

test('aspect-aware generation requires an owned job with the confirmed frame before releasing its request', async t => {
  const key = 'generate:shot-a', operation = 'generation.submit', projectId = 'project-a';
  const input = { shotId: 'shot-a', expectedRevision: 3, requestId: 'confirmed-portrait', providerId: 'mock',
    aspectSource: { kind: 'project', expectedTimelineRevision: 2, aspectRatio: '9:16' } };
  const accepted = { id: '00000000-0000-4000-8000-000000000021', projectId, shotId: input.shotId,
    requestId: input.requestId, providerId: input.providerId, model: 'mock-motion-v1', retryOfJobId: null,
    snapshot: { shotId: input.shotId, shotRevision: 3, providerId: input.providerId, model: 'mock-motion-v1', aspectRatio: '9:16' } };
  const otherRatio = { ...accepted, snapshot: { ...accepted.snapshot, aspectRatio: '16:9' } };
  const h = harness(t, () => otherRatio);
  await h.run(key, operation, input);
  const pending = readPending(projectId, key);
  assert.deepEqual(pending?.input, input);
  for (const jobs of [[{ requestId: input.requestId }], [otherRatio], [{ ...accepted, projectId: 'project-b' }], [accepted, accepted]]) {
    reconcilePending(projectId, { jobs });
    assert.deepEqual(readPending(projectId, key), pending);
  }
  reconcilePending(projectId, { jobs: [accepted] });
  assert.equal(readPending(projectId, key), null);
});

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

interface StructureState {project:{id:string};projectFormatVersion?:number;shots:{id:string}[];nodes:{id:string}[];assets:unknown[];timeline?:GenerationFrame;timelineFrameTransaction?:boolean}
interface StructureOptions {results?:({id:string}|null)[];timeline?:GenerationFrame;timelineFrameTransaction?:boolean;afterGuard?:(state:StructureState,project:{current:string})=>void;afterRun?:(state:StructureState,project:{current:string},count:number)=>void}
function structureHarness({ results = [{ id: 'first' }, null], timeline, timelineFrameTransaction, afterGuard, afterRun }:StructureOptions = {}) {
  const state:StructureState = {project:{id:'project-a'},projectFormatVersion:4,shots:[],nodes:[],assets:[],timeline,timelineFrameTransaction};
  const currentProject = { current: 'project-a' }, dataRef = { current: state }, calls:unknown[][] = [], notices:[string,...unknown[]][] = [];
  const scope = { data: state, dataRef, currentProject, timelineOutputRatio, isBusy: () => false, chooseCanvasPosition: () => ({ x: 0, y: 0 }),
    guardNavigation: async () => { afterGuard?.(state, currentProject); return true; },
    context: () => ({ projectId: currentProject.current }), isCurrent: (captured: { projectId: string; }) => captured.projectId === currentProject.current,
    markBusy: () => {}, run: async (...args:unknown[]) => { calls.push(args); const result = results[calls.length - 1]; afterRun?.(state, currentProject, calls.length); return result; },
    notify: (value:DisplayMessage|string,...args:unknown[]) => notices.push([renderCoreMessage('zh-Hans', value), ...args]), refresh: async () => state, inspect: async () => true, revealCanvas: () => {}, readableError: (error:Error) => error.message,
    format5BoardSession: () => ({run: async () => ({ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'})}),
  };
  return { run: compile(structureSource, 'addStructure', scope), addShot: compile(addShotSource, 'addShot', scope), calls, notices, currentProject, state };
}

test('actual structure action stops on first unacknowledged step and reports partial count', async () => {
  const h = structureHarness(); await h.run();
  assert.equal(h.calls.length, 2); assert.equal(h.calls.every(call => call[1] === 'shot.create'), true);
  assert.match(h.notices[0][0], /已确认 1\/3.*其余镜头不会自动创建/);
});

test('new canvas and structure shots use the current frame only in format 4', async () => {
  const portrait = { fps: 30, width: 1080, height: 1920, revision: 2 };
  const wide = { fps: 30, width: 2520, height: 1080, revision: 3 };
  const h = structureHarness({ results: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], timeline: portrait, timelineFrameTransaction: true,
    afterGuard: state => { state.timeline = wide; } });
  await h.addShot();
  assert.equal((h.calls[0]?.[2] as {aspectRatio?: string}).aspectRatio, '21:9');
  h.calls.length = 0;
  await h.run();
  assert.deepEqual(h.calls.map(call => (call[2] as {aspectRatio?: string}).aspectRatio), ['21:9', '21:9', '21:9']);
  const legacy = structureHarness({ results: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], timelineFrameTransaction: false,
    timeline: { fps: 30, width: 1920, height: 1080, revision: 4 } });
  await legacy.addShot();
  assert.equal((legacy.calls[0]?.[2] as {aspectRatio?: string}).aspectRatio, '9:16');
  legacy.calls.length = 0;
  await legacy.run();
  assert.deepEqual(legacy.calls.map(call => (call[2] as {aspectRatio?: string}).aspectRatio), ['9:16', '9:16', '9:16']);
  const switched = structureHarness({ timeline: portrait, afterGuard: (_, owner) => { owner.current = 'project-b'; } });
  await switched.addShot();
  assert.equal(switched.calls.length, 0);
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
  const save = compile(section('async function saveShot(', 'async function saveNode('), 'saveShot', { run: h.run, referenceWorkBlocked: () => false,
    dataRef: h.dataRef, format5BoardSession: () => ({run: async () => ({ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'})}),
    refresh: async () => {}, notify: () => {}, currentProject: h.currentProject });
  const nodeSave = compile(section('async function saveNode(', 'async function savePosition('), 'saveNode', { run: h.run,
    dataRef: h.dataRef, format5BoardSession: () => ({run: async () => ({ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'})}),
    refresh: async () => {}, notify: () => {}, currentProject: h.currentProject });
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

// ---------------------------------------------------------------------------
// Actual format-5 lost-response entry points: the unconfirmed bar's two actions
// and the action guard, compiled from the shipped App source.
// ---------------------------------------------------------------------------
interface Format5LostCalls {refresh: number; history: number; board: number; retries: number; abandons: number;
  notices: {message: string; type: string}[]; notice: {id: string; message: string} | null;
  noticeActionId: string | null | undefined}
function format5LostHarness(retryResult: unknown) {
  const calls: Format5LostCalls = {refresh: 0, history: 0, board: 0, retries: 0, abandons: 0, notices: [],
    notice: null, noticeActionId: undefined};
  const tracker = {retry: async () => {calls.retries++; return retryResult;},
    abandon: () => {calls.abandons++;}};
  const scope = {
    format5Unresolved: {projectId: 'project-a', requestId: 'preview-1'}, format5LostRef: {current: tracker},
    currentProject: {current: 'project-a'},
    setFormat5Notice: (notice: {id: string; message: string} | null) => {calls.notice = notice;},
    setFormat5NoticeActionId: (id: string | null) => {calls.noticeActionId = id;},
    refresh: async () => {calls.refresh++; }, format5RefreshHistory: async () => {calls.history++; },
    format5LoadBoard: async () => {calls.board++; },
    notify: (message: DisplayMessage | string, type: string) => calls.notices.push({message: renderCoreMessage('zh-Hans', message), type}),
    format5CommandErrorMessageKey,
  };
  return {calls,
    retry: compile(section('async function format5RetryUnconfirmed(', '/** Drop the retained envelope without writing or refreshing. */'),
      'format5RetryUnconfirmed', scope),
    abandon: compile(section('function format5AbandonUnconfirmed(): void', 'async function splitTimelineClip('),
      'format5AbandonUnconfirmed', scope)};
}

test('actual format-5 retry entry refreshes the project, history and board exactly once on applied', async () => {
  const h = format5LostHarness({ok: true, actionId: null});
  const result = await h.retry();
  assert.deepEqual(result, {ok: true, actionId: null});
  assert.equal(h.calls.retries, 1);
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.history, 1);
  assert.equal(h.calls.board, 1);
  assert.equal(h.calls.notice?.message, '已应用');
  assert.equal(h.calls.noticeActionId, null);
  assert.deepEqual(h.calls.notices, []);
});

test('actual format-5 retry entry reports one reason on a definite rejection and stays silent while unconfirmed', async () => {
  const rejected = format5LostHarness({ok: false, code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'});
  await rejected.retry();
  assert.equal(rejected.calls.refresh, 0);
  assert.equal(rejected.calls.notices.length, 1);
  assert.match(rejected.calls.notices[0]!.message, /副轨或字幕会重叠/u);
  const unconfirmed = format5LostHarness({ok: false, code: 'EDIT_RESULT_UNCONFIRMED', unconfirmed: true});
  await unconfirmed.retry();
  assert.deepEqual(unconfirmed.calls.notices, [], 'still-unknown retry only keeps the bar');
  assert.equal(unconfirmed.calls.refresh, 0);
});

test('actual format-5 abandon entry drops the retained edit without any write', async () => {
  const h = format5LostHarness({ok: true, actionId: null});
  assert.equal(h.abandon(), undefined);
  assert.equal(h.calls.abandons, 1);
  assert.equal(h.calls.retries, 0);
  assert.equal(h.calls.refresh + h.calls.history + h.calls.board, 0);
});

test('actual format-5 action entry keeps one unconfirmed state and reports one reason when blocked', async () => {
  let outcome: unknown = {ok: false, code: 'EDIT_RESULT_UNCONFIRMED', unconfirmed: true};
  const notices: string[] = [];
  const scope = {
    format5SessionBusy: false, setFormat5SessionBusy: () => {},
    format5Session: () => ({run: async () => outcome}),
    format5ClipName: () => '片段', format5NoticeMessage: () => null, format5CommandErrorMessageKey,
    setFormat5Notice: () => {}, setFormat5NoticeActionId: () => {},
    refresh: async () => {notices.push('refresh');}, format5RefreshHistory: async () => {notices.push('history');},
    notify: (message: DisplayMessage | string) => notices.push(renderCoreMessage('zh-Hans', message)),
    clearFormat5ConflictToast: () => {},
    notifyFormat5CommandFailure: (result: {code?: string}) => notices.push(renderCoreMessage('zh-Hans', translate('zh-Hans', format5CommandErrorMessageKey(result.code) as never))),
  };
  const runPolicy = compile(section('async function format5RunPolicy(', 'async function format5RemoveTimelineClip('),
    'format5RunPolicy', scope);
  await runPolicy({kind: 'clip-split', clipId: 'clip-1'});
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /上一次编辑结果未确认/u);
  notices.length = 0;
  outcome = {ok: false, code: 'EDIT_RESULT_UNCONFIRMED'};
  await runPolicy({kind: 'clip-split', clipId: 'clip-1'});
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /上一次编辑结果未确认/u);
});

// ---------------------------------------------------------------------------
// Actual FR-B2 scene-split entry: a successful format-5 split closes the
// detection dialog and keeps one undo bar with the real applied and skipped
// counts, reports the mapped reason on refusal, and leaves the format 3/4
// branch on its dialog, toast and mutation operation.
// ---------------------------------------------------------------------------
interface SceneSplitCalls {notices: {message: string; type: string}[]; notice: {id: string; message: string} | null;
  noticeActionId: string | null | undefined; sceneTarget: unknown; refresh: number; history: number; mutations: unknown[][]}
function sceneSplitHarness(outcome: unknown, format: 3 | 5 = 5) {
  const calls: SceneSplitCalls = {notices: [], notice: null, noticeActionId: undefined, sceneTarget: 'open', refresh: 0, history: 0, mutations: []};
  const scope = {
    dataRef: {current: {projectFormatVersion: format, timeline: {clips: []}, assets: []} as {projectFormatVersion: number}},
    format5Session: () => ({splitAtScenes: async () => outcome}),
    mutateTimeline: async (...args: unknown[]) => {calls.mutations.push(args); return format === 3 ? {split: [1, 2], skipped: []} : null;},
    sceneSplitError: (error: Error) => error.message,
    notify: (message: DisplayMessage | string, type = 'info') => calls.notices.push({message: renderCoreMessage('zh-Hans', message), type}),
    clearFormat5ConflictToast: () => {},
    notifyFormat5CommandFailure: (result: {code?: string}) => calls.notices.push({message: renderCoreMessage('zh-Hans', translate('zh-Hans', format5CommandErrorMessageKey(result.code) as never)), type: 'error'}),
    setFormat5Notice: (notice: {id: string; message: string} | null) => {calls.notice = notice;},
    setFormat5NoticeActionId: (id: string | null) => {calls.noticeActionId = id;},
    setSceneTarget: (target: unknown) => {calls.sceneTarget = target;},
    refresh: async () => {calls.refresh++;}, format5RefreshHistory: async () => {calls.history++;},
    format5CommandErrorMessageKey, format5SceneSplitNotice, currentProject: {current: 'project-a'},
  };
  return {calls, split: compile(section('async function splitTimelineAtScenes(', '  // Storyboards. A built one is selected as one batch'),
    'splitTimelineAtScenes', scope)};
}
const sceneSplitRow = (id: string) => ({clipId: id, clipIds: [id, crypto.randomUUID()], cutFrames: [30], fadeCutFrames: []});

test('a successful scene split closes the dialog and leaves only the undo bar', async () => {
  const applied = sceneSplitHarness({ok: true, actionId: 'action-scene-1', operation: 'sequence.edit',
    receipt: {status: 'applied', sceneSplit: {split: [sceneSplitRow('clip-a'), sceneSplitRow('clip-b'), sceneSplitRow('clip-c')], skipped: []}}});
  assert.equal(await applied.split('asset-1', 'result-1'), undefined);
  // The dialog would cover the bar, so a successful format-5 split closes it
  // and the bar is the only result surface: no duplicate toast.
  assert.deepEqual(applied.calls.notices, []);
  assert.equal(applied.calls.sceneTarget, null, 'the detection dialog closes on success');
  assert.equal(applied.calls.notice?.id, 'action-scene-1');
  assert.equal(applied.calls.notice?.message, '已在切点处分割 3 个片段');
  assert.equal(applied.calls.noticeActionId, 'action-scene-1');
  assert.equal(applied.calls.refresh, 1);
  assert.equal(applied.calls.history, 1);
  const skipped = sceneSplitHarness({ok: true, actionId: 'action-scene-2', operation: 'sequence.edit',
    receipt: {status: 'applied', sceneSplit: {split: [sceneSplitRow('clip-a')], skipped: [{clipId: 'clip-b', reason: 'NO_CUT_IN_RANGE'}]}}});
  await skipped.split('asset-1', 'result-1');
  assert.deepEqual(skipped.calls.notices, []);
  assert.equal(skipped.calls.sceneTarget, null);
  assert.match(skipped.calls.notice!.message, /已在切点处分割 1 个片段；另有 1 个片段的源区间内没有可用切点/u);
});

test('actual scene-split entry reports the mapped refusal and keeps a recovered applied result silent', async () => {
  const refused = sceneSplitHarness({ok: false, code: 'NOTHING_TO_SPLIT'});
  await refused.split('asset-1', 'result-1');
  assert.equal(refused.calls.notice, null);
  assert.equal(refused.calls.noticeActionId, undefined);
  assert.equal(refused.calls.sceneTarget, 'open', 'a refusal keeps the dialog open');
  assert.equal(refused.calls.notices.length, 1);
  assert.match(refused.calls.notices[0]!.message, /源区间内都没有可用的切点/u);
  assert.equal(refused.calls.refresh + refused.calls.history, 0);
  // Settled by the receipt read, not by the lost commit response: no action id
  // exists for an undo step, so the bar reports the applied result without one.
  const resolved = sceneSplitHarness({ok: true, resolvedFromReceipt: true, actionId: 'action-scene-3'});
  await resolved.split('asset-1', 'result-1');
  assert.deepEqual(resolved.calls.notices, []);
  assert.equal(resolved.calls.sceneTarget, null);
  assert.equal(resolved.calls.notice?.message, '已应用');
  assert.equal(resolved.calls.noticeActionId, null);
  assert.equal(resolved.calls.refresh, 1);
  assert.equal(resolved.calls.history, 1);
});

test('the format 3/4 scene split keeps its own mutation operation and toast', async () => {
  const legacy = sceneSplitHarness({ok: false, code: 'NOTHING_TO_SPLIT'}, 3);
  await legacy.split('asset-1', 'result-1');
  assert.equal(legacy.calls.mutations.length, 1);
  assert.equal(legacy.calls.mutations[0]![0], 'timeline.clip.splitAtScenes');
  assert.deepEqual(legacy.calls.mutations[0]![1], {assetId: 'asset-1', resultId: 'result-1'});
  assert.equal(legacy.calls.notice, null);
  assert.equal(legacy.calls.sceneTarget, 'open', 'format 3/4 keeps the dialog open');
  assert.deepEqual(legacy.calls.notices, [{message: '已在切点处分割 2 个片段', type: 'info'}]);
});
