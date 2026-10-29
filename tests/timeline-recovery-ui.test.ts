type RecoveryInput=Record<string,unknown>&{projectId:string;expectedRevision:number;requestId:string};
import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {ServiceResponse} from './helpers/strict-service-responses.ts';
import type {TestTree,TestNode,TestModule} from './helpers/strict-timeline-ui-types.ts';
import test from 'node:test';
import { message as messageKey, renderMessage, type DisplayMessage } from '../packages/i18n/src/index.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, isTimelineRenderRecord, hasRequestNotAppliedProof, timelineOutputPreset } from '@mioon/contracts';
import * as submissions from '../apps/web/src/submissions.ts';
import * as mutations from '../apps/web/src/mutation-submissions.ts';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.ts';
import * as restoredWorkspace from '../apps/web/src/restored-workspace.ts';
import * as projectOpening from '../apps/web/src/project-open-state.ts';
import { defaultWorkspaceState, reconcileWorkspaceState } from '../apps/web/src/workspace-state.ts';
import { readGenerationProviderDirectory } from '../apps/web/src/video-provider-directory.ts';
import { isReferenceOperation } from '../apps/web/src/reference-connections.ts';
import { loudnessApplyFixture } from './fixtures/timeline-loudness-apply.ts';
import { shotSyncFixture } from './fixtures/timeline-shot-sync.ts';
import { sceneSplitFixture } from './fixtures/timeline-scene-split.ts';
import { crossfadeFixture } from './fixtures/timeline-crossfade.ts';
import { clipGainsFixture } from './fixtures/timeline-clip-gains.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { creationParameter } from '../apps/web/src/creation-i18n.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const taskIntentModule = { exports: {} as typeof import('../apps/web/src/task-workspace-intent.ts') };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const runSource = source.slice(source.indexOf('async function runSession('), source.indexOf('async function inspect(')).replace('async function runSession(', 'async function run(');
const refreshSource = source.slice(source.indexOf('const refresh = useCallback('), source.indexOf('async function revealImageAsset('));
const id = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), otherProjectId = id(2), trackId = id(3), clipId = id(4), assetId = id(5);
const operations = (['timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.remove', 'timeline.clip.rippleRemove',
  'timeline.clip.split', 'timeline.clip.replaceSource', 'timeline.seed', 'timeline.undo', 'timeline.redo', 'timeline.render', 'timeline.format.set', 'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove', 'timeline.loudness.apply',
  'timeline.clip.refreshSources', 'timeline.shots.append', 'timeline.clip.splitAtScenes', 'timeline.clip.crossfade', 'timeline.clip.setGains'] as const);
const shotSync = (operation: string) => operation === 'timeline.clip.refreshSources' || operation === 'timeline.shots.append';
const clone = <T>(value: T): T => structuredClone(value);
const loudnessApply = await loudnessApplyFixture({projectId, expectedRevision: 7, requestId: 'original-timeline.loudness.apply'});
function storage(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key?: unknown) => values.get(key) ?? null, setItem: (key?: unknown, value?: unknown) => values.set(key, String(value)), removeItem: (key?: unknown) => values.delete(key),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
  return values;
}
function inputFor(operation: string, patch: {expectedRevision?: number; presetId?: string; purpose?: string; preflightSnapshotHash?: unknown;} = {}):RecoveryInput {
  if (operation === 'timeline.loudness.apply') return ({...clone(loudnessApply.input), ...patch} as unknown as RecoveryInput);
  if (shotSync(operation)) return ({...shotSyncFixture(operation, {projectId, expectedRevision: 7, requestId: `original-${operation}`}).input, ...patch} as unknown as RecoveryInput);
  if (operation === 'timeline.clip.splitAtScenes') return ({...sceneSplitFixture({projectId, expectedRevision: 7, requestId: `original-${operation}`}).input, ...patch} as unknown as RecoveryInput);
  if (operation === 'timeline.clip.crossfade') return ({...crossfadeFixture({projectId, expectedRevision: 7, requestId: `original-${operation}`}).input, ...patch} as unknown as RecoveryInput);
  if (operation === 'timeline.clip.setGains') return ({...clipGainsFixture({projectId, expectedRevision: 7, requestId: `original-${operation}`}).input, ...patch} as unknown as RecoveryInput);
  const fields:Record<string,Record<string,unknown>> = {
    'timeline.track.add': { kind: 'audio', name: 'Sound' },
    'timeline.track.update': { trackId, patch: { muted: true, name: 'Edited track' } },
    'timeline.clip.add': { trackId, assetId: id(9), name: 'Added', startFrame: 100, durationFrames: 40, sourceInFrame: 11, gain: 0.5 },
    'timeline.clip.update': { clipId, patch: { gain: 0.5, rect: { x: 100, y: 200, width: 300, height: 400 } } },
    'timeline.clip.remove': { clipId }, 'timeline.clip.rippleRemove': { clipId }, 'timeline.clip.split': { clipId, atFrame: 50 },
    'timeline.clip.replaceSource': { clipId, assetId: id(9) }, 'timeline.render': { purpose: 'preview' },
    'timeline.format.set': { expectedProjectRevision: 3, presetId: 'landscape_720' },
    'timeline.subtitle.add': { text: '字幕', startFrame: 0, durationFrames: 30 },
    'timeline.subtitle.update': { cueId: id(20), patch: { text: '更新字幕' } },
    'timeline.subtitle.remove': { cueId: id(20) },
  };
  return ({ projectId, expectedRevision: 7, requestId: `original-${operation}`, ...fields[operation], ...patch } as unknown as RecoveryInput);
}
function recoverableInput(operation: string) {
  return operation.startsWith('timeline.') ? inputFor(operation) : { projectId, requestId: `original-${operation}`, expectedShotRevision: 7,
    ...(operation === 'reference.attach' ? { sourceNodeId: id(11), targetShotId: id(12), expectedSourceRevision: 3, role: 'first_frame' } : { edgeId: id(13) }) };
}
function timeline(revision: number = 8, owner: string|undefined = projectId) {
  return { id: id(6), projectId: owner, revision, fps: 30, width: 720, height: 1280, durationFrames: 90,
    tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
    clips: [{ id: clipId, trackId, assetId, name: 'Original', startFrame: 10, durationFrames: 80, sourceInFrame: 11,
      rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 }],
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:01.000Z' };
}
function acknowledgedValue(operation: string, input: { projectId: string|undefined; expectedRevision: number; requestId: string; presetId: unknown; name: unknown; kind: unknown; patch: { text: unknown; }; trackId: unknown; assetId: string; startFrame: unknown; durationFrames: unknown; sourceInFrame: unknown; gain: unknown; clipId: string; atFrame: unknown; cueId: unknown; text: unknown; purpose: unknown; }) {
  if (shotSync(operation)) return shotSyncFixture(operation, {projectId: ((input.projectId) as unknown as string), expectedRevision: input.expectedRevision, requestId: ((input.requestId) as unknown as string)}).response;
  if (operation === 'timeline.clip.splitAtScenes') return sceneSplitFixture({projectId: ((input.projectId) as unknown as string), expectedRevision: input.expectedRevision, requestId: ((input.requestId) as unknown as string)}).response;
  if (operation === 'timeline.clip.crossfade') return crossfadeFixture({projectId: ((input.projectId) as unknown as string), expectedRevision: input.expectedRevision, requestId: ((input.requestId) as unknown as string)}).response;
  if (operation === 'timeline.clip.setGains') return clipGainsFixture({projectId: ((input.projectId) as unknown as string), expectedRevision: input.expectedRevision, requestId: ((input.requestId) as unknown as string)}).response;
  if (operation === 'timeline.loudness.apply') {
    const value = clone(loudnessApply.response);
    value.requestId = input.requestId;
    Object.assign(value.timeline, {projectId: input.projectId, revision: input.expectedRevision + 1});
    Object.assign(value.application, {beforeRevision: input.expectedRevision, afterRevision: input.expectedRevision + 1});
    return value;
  }
  const value = timeline(input.expectedRevision + 1, input.projectId);
  if (operation === 'timeline.format.set') {
    const { fps, width, height } = timelineOutputPreset(input.presetId)!;
    Object.assign(value, { fps, width, height, clips: [], durationFrames: 0 });
  }
  if (operation === 'timeline.track.add') value.tracks.push({ id: id(7), name: ((input.name) as unknown as string), kind: ((input.kind) as unknown as string), orderIndex: 1, hidden: false, muted: false });
  if (operation === 'timeline.track.update') Object.assign(value.tracks[0], input.patch);
  if (operation === 'timeline.clip.add') {
    value.clips.push({ ...clone(value.clips[0]), id: id(8), trackId: ((input.trackId) as unknown as string), assetId: input.assetId, name: ((input.name) as unknown as string),
      startFrame: ((input.startFrame) as unknown as number), durationFrames: ((input.durationFrames) as unknown as number), sourceInFrame: ((input.sourceInFrame) as unknown as number), gain: ((input.gain) as unknown as number) });
    value.durationFrames = 140;
  }
  if (operation === 'timeline.clip.update') Object.assign(value.clips[0], input.patch);
  if (operation === 'timeline.clip.remove') { value.clips = []; value.durationFrames = 0; }
  if (operation === 'timeline.clip.rippleRemove') { value.clips = value.clips.filter(clip => clip.id !== input.clipId); value.durationFrames = 0; }
  if (operation === 'timeline.clip.replaceSource') value.clips[0].assetId = input.assetId;
  if (operation === 'timeline.clip.split') {
    const right = { ...clone(value.clips[0]), id: id(8), startFrame: input.atFrame, durationFrames: 40, sourceInFrame: 51 };
    value.clips[0].durationFrames = 40; value.clips.push(((right) as unknown as Parameters<typeof value.clips.push>[0]));
  }
  if (operation.startsWith('timeline.subtitle.')) (value as typeof value & {subtitles:({ profileId: string; cues: { id: {}; text: unknown; startFrame: number; durationFrames: number; }[]; })}).subtitles = { profileId: 'bottom_cjk_v1', cues: operation === 'timeline.subtitle.remove' ? [] : [{ id: input.cueId ?? id(20), text: input.patch?.text ?? input.text, startFrame: 0, durationFrames: 30 }] };
  if (operation !== 'timeline.render') return value;
  value.revision = input.expectedRevision;
  return { id: id(10), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose,
    timelineRevision: input.expectedRevision, snapshot: { timeline: value,
      assets: [{ id: assetId, sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 10, width: 720, height: 1280, hasAudio: true }] },
    status: 'queued', assetId: null, url: null, error: null, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
const acknowledged = acknowledgedValue as <O extends string>(operation:O,input:Record<string,unknown>)=>ServiceResponse<O>;

function harness(dispatch:(operation:string,input:Record<string,unknown>)=>unknown, {projectSnapshot,workspace={restored:false}}:{projectSnapshot?:(projectId?:unknown)=>unknown;workspace?:workspaceOrigin.WorkspaceIdentity}={}) {
  const state: {projectReady:boolean;epoch:number;calls:{operation:string;input:Record<string,unknown>}[];reads:{operation:string;input?:unknown}[];notices:{message:string;type:unknown}[];refreshes:unknown[];pending:submissions.PendingEntry[];jobs:boolean;auth:boolean;online:unknown;providers:unknown} = { projectReady: true, epoch: 0, calls: [], reads: [], notices: [], refreshes: [], pending: submissions.pendingForProject(projectId), jobs: false, auth: true, online: null, providers: null };
  const currentProject = { current: projectId }, workspaceRef = { current: workspace }, busy = new Set();
  const dataRef: {current:{project:{id:string};timeline:ReturnType<typeof timeline>;timelineHistory?:{revision:number}}} = { current: { project: { id: projectId }, timeline: timeline(7), timelineHistory: { revision: 7 } } };
  const scope = { ...submissions, ...mutations, ...workspaceOrigin, ...restoredWorkspace, msg: messageKey, localizedError: (value?: string|DisplayMessage|null|undefined) => Object.assign(new Error(renderMessage('zh-Hans', value)), {displayMessage: value}), TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof, isReferenceOperation,
    shotTextRef: { current: null }, currentProject, workspaceRef, dataRef, context: () => ({ projectId: currentProject.current, epoch: state.epoch, workspace: workspaceRef.current }),
    isCurrent: (owner: { projectId: string; epoch: number; workspace: workspaceOrigin.WorkspaceIdentity|null|undefined; }) => owner.projectId === currentProject.current && owner.epoch === state.epoch && workspaceOrigin.workspaceOriginScope(owner.workspace) === workspaceOrigin.workspaceOriginScope(workspaceRef.current),
    isBusy: (key?: unknown, owner?: unknown) => busy.has(`${owner}:${key}`), markBusy: (owner?: unknown, key?: unknown, value?: unknown) => value ? busy.add(`${owner}:${key}`) : busy.delete(`${owner}:${key}`),
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, setData: (update: typeof dataRef.current|((value:typeof dataRef.current)=>typeof dataRef.current)) => { dataRef.current = typeof update === 'function' ? update(dataRef.current) : update; },
    setPending: (entries: submissions.PendingEntry[]) => { state.pending = entries; }, openTasks: (canReveal: () => unknown = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: (value: boolean) => { state.auth = value; },
    readableError: (error?: Error&{ code: string; status?: number; details?: { mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];[key: string]: unknown; }; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; }) => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message, clipReplacementErrorDescriptor: (error?: Error&{ code: string; status?: number; details?: { mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];[key: string]: unknown; }; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; }) => (error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).message,
    notify: (message?: string|DisplayMessage|null|undefined, type?: unknown) => state.notices.push((({ message: typeof message === 'string' ? message : renderMessage('zh-Hans', message), type }) as unknown as Parameters<typeof state.notices.push>[0])), refresh: async (owner?: unknown) => { state.refreshes.push(((owner) as unknown as Parameters<typeof state.refreshes.push>[0])); },
    rpc: async (operation: string, input: { projectId: unknown; }) => {
      if (projectSnapshot && operation === 'project.get') { state.reads.push((({ operation, input: clone(input) }) as unknown as Parameters<typeof state.reads.push>[0])); return projectSnapshot(input.projectId); }
      if (projectSnapshot && operation === 'provider.list') { state.reads.push((({ operation }) as unknown as Parameters<typeof state.reads.push>[0])); return []; }
      if (projectSnapshot && operation === 'video.connection.list') { state.reads.push((({ operation }) as unknown as Parameters<typeof state.reads.push>[0])); return []; }
      state.calls.push((({ operation, input: clone(input) }) as unknown as Parameters<typeof state.calls.push>[0])); return dispatch(operation, input);
    },
  };
  if (projectSnapshot) {
    const refreshScope = { ...scope, ...projectOpening, application: null, clipDraftRef: { current: null }, projectSessionReady: () => state.projectReady, importSession: { current: { active: true } }, useCallback: (callback?: unknown) => callback, emptyData: {}, projectEpoch: { current: 1 },
      setProviders: (value: null) => { state.providers = value; }, setVideoDirectoryUnavailable() {}, setLastSync() {}, setOnline: (value: null) => { state.online = value; }, reconcileWorkspaceState, readGenerationProviderDirectory,
      viewRef: { current: defaultWorkspaceState() }, viewReady: { current: false }, setView() {}, preferencesRef: { current: {} } };
    delete (refreshScope as {refresh?: unknown}).refresh;
    scope.refresh = Function(...Object.keys(refreshScope), `${refreshSource}; return refresh;`)(...Object.values(refreshScope)) as typeof scope.refresh;
  }
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify(captured.workspace || 'test-workspace') }; } });
  return { state, currentProject, workspaceRef, dataRef, busy, refresh: scope.refresh, run: Function(...Object.keys(scope), `${runSource}; return run;`)(...Object.values(scope)) as (key: string, operation: string, input?: unknown, after?: (value?: unknown)=>void, options?: {replay?: boolean})=>Promise<unknown> };
}
const keyFor = (operation: string) => operation === 'timeline.render' ? 'timeline:render:preview' : 'timeline:mutation';
const error = (code: string, details: {requestId?: unknown; operation?: unknown; projectId?: unknown; mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];} = {}, definitive: boolean|undefined = true) => Object.assign(Error('Synthetic failure'), { code, details, definitive });

test('actual App legacy session runner guards exactly the twenty-two timeline writes and accepts their complete matching acknowledgements', async t => {
  storage(t); assert.deepEqual(new Set(TIMELINE_MUTATION_OPERATIONS), new Set(operations));
  const h = harness(((acknowledged) as unknown as Parameters<typeof harness>[0]));
  for (const operation of operations) {
    const input = inputFor(operation), expected = acknowledged(operation, input), key = keyFor(operation);
    assert.equal(isTimelineMutationResponse(operation, input, expected), true, `${operation} fixture`);
    assert.deepEqual(await h.run(key, operation, input), expected, operation);
    assert.equal((submissions.readPending(projectId, key) as unknown), null, operation);
  }
  assert.equal(h.state.calls.length, operations.length); assert.equal(h.busy.size, 0);
  assert.match(runSource, /const timeline = TIMELINE_MUTATION_OPERATIONS\.includes\(operation\)/);
  assert.doesNotMatch(runSource, /operation\.startsWith\('timeline\.'\)/);
});

test('format recovery preserves expected project revision and absent-timeline revision zero in the original session intent', async t => {
  storage(t);
  const operation = 'timeline.format.set', exact = inputFor(operation, { expectedRevision: 0, presetId: 'square_720' });
  const expected = acknowledged(operation, exact); let lost = true;
  assert.equal(isTimelineMutationResponse(operation, exact, expected), true); assert.equal((expected as typeof expected & {revision:(number)}).revision, 1);
  assert.deepEqual([expected.width, expected.height, expected.fps, (expected as typeof expected & {durationFrames:(140)|(0)|(40)}).durationFrames, (expected as typeof expected & {clips:(never[])|({ id: string; trackId: string; assetId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; rect: { x: number; y: number; width: number; height: number; }; gain: number; }[])}).clips.length], [720, 720, 30, 0, 0]);
  const h = harness((((op?: unknown, input?: unknown) => { if (lost) throw Error('Lost format response'); return acknowledged(((op) as unknown as Parameters<NonNullable<typeof acknowledged>>[0]), ((input) as unknown as Parameters<NonNullable<typeof acknowledged>>[1])); }) as unknown as Parameters<typeof harness>[0]));
  await h.run('timeline:mutation', operation, exact);
  const original = submissions.readPending(projectId, 'timeline:mutation');
  assert.deepEqual((original)!.input, exact);
  lost = false;
  await h.run('timeline:mutation', operation, { ...exact, expectedProjectRevision: 99, presetId: 'landscape_720', requestId: 'changed-format-intent' });
  assert.equal(h.state.calls.length, 1); assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  assert.deepEqual(await h.run((original)!.key, operation, (original)!.input, undefined, { replay: true }), expected);
  assert.equal((submissions.readPending(projectId, 'timeline:mutation') as unknown), null);
  assert.deepEqual(h.state.calls, [{ operation, input: exact }, { operation, input: exact }]);
});

test('every timeline write retains the exact original receipt after loss, 404/409 and corrupt ACK until explicit valid replay', async t => {
  storage(t);
  for (const operation of operations) {
    let failure:(Error & {code?:string})|null = Error('Response lost'), result!: unknown;
    const h = harness(((() => { if (failure) throw failure; return result; }) as unknown as Parameters<typeof harness>[0]));
    const input = inputFor(operation), originalBytes = JSON.stringify(input), key = keyFor(operation);
    await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key); assert.ok(original, operation); assert.equal(h.state.jobs, true);
    for (const code of (['NOT_FOUND', 'TRACK_NOT_FOUND', 'CLIP_NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED'] as const)) {
      failure = error(code); await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: ${code}`);
    }
    failure = null;
    const expected = acknowledged(operation, input);
    for (const invalid of ([null, {}, { projectId, revision: 8 }, { ...expected, projectId: otherProjectId },
      ...(operation === 'timeline.loudness.apply' || shotSync(operation) || operation === 'timeline.clip.splitAtScenes' || operation === 'timeline.clip.crossfade' || operation === 'timeline.clip.setGains' ? [(expected as {timeline:FixtureTimeline}).timeline, {...expected, timeline: {...(expected as {timeline:FixtureTimeline}).timeline, projectId: otherProjectId}}] : [])] as const)) {
      result = invalid; await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: corrupt ACK`);
    }
    const calls = h.state.calls.length;
    await h.run(key, operation, { ...input, expectedRevision: 99, requestId: 'must-not-resubmit' });
    assert.equal(h.state.calls.length, calls, 'A new edit or preview cannot implicitly replay');
    assert.deepEqual(submissions.readPending(projectId, key), original);
    result = acknowledged(operation, input); await h.run(key, operation, input, undefined, { replay: true });
    assert.equal((submissions.readPending(projectId, key) as unknown), null);
    assert.ok(h.state.calls.every(call => JSON.stringify(call.input) === originalBytes));
    assert.equal(h.busy.size, 0);
  }
});

test('timeline rollback requires matching request-bound proof and rejects forbidden or contradictory claims', async t => {
  storage(t);
  for (const operation of operations) {
    const input = inputFor(operation), key = keyFor(operation);
    let failure:(Error & {code?:string})|null = Error('Response lost');
    const h = harness(() => { throw failure; }); await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key);
    const strictOwnerProof = operation === 'timeline.loudness.apply' || operation === 'timeline.format.set' || operation.startsWith('timeline.subtitle.') || shotSync(operation) || operation === 'timeline.clip.splitAtScenes' || operation === 'timeline.clip.crossfade' || operation === 'timeline.clip.setGains';
    const proof = { mutationOutcome: 'not_applied', requestId: input.requestId, ...(strictOwnerProof ? { operation, projectId: input.projectId } : {}) };
    for (const invalid of ([error('REVISION_CONFLICT', { ...proof, requestId: 'wrong-request' }), error('REVISION_CONFLICT', proof, false),
      error('REVISION_CONFLICT', { ...proof, mutationOutcome: 'applied' }), error('UNAUTHORIZED', proof), error('IDEMPOTENCY_CONFLICT', proof),
      error('BACKEND_PROTOCOL_ERROR', proof), ...(strictOwnerProof ? [
        error('REVISION_CONFLICT', { ...proof, operation: 'timeline.clip.update' }),
        error('REVISION_CONFLICT', { ...proof, projectId: otherProjectId }),
        error('REVISION_CONFLICT', { mutationOutcome: 'not_applied', requestId: input.requestId }),
      ] : [])] as const)) {
      failure = invalid; await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, `${operation}: ${failure.code}`);
    }
    failure = error('REVISION_CONFLICT', proof); await h.run(key, operation, input, undefined, { replay: true });
    assert.equal((submissions.readPending(projectId, key) as unknown), null, operation);
  }
});

test('fresh proven timeline rejection releases the key for a new user intent', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let reject = true;
  const h = harness((((op: unknown, value: { requestId: unknown; }) => { if (reject) throw error('SOURCE_BOUNDS', { mutationOutcome: 'not_applied', requestId: value.requestId }); return acknowledged(((op) as unknown as Parameters<NonNullable<typeof acknowledged>>[0]), value); }) as unknown as Parameters<typeof harness>[0]));
  await h.run('timeline:mutation', operation, input); assert.equal((submissions.readPending(projectId, 'timeline:mutation') as unknown), null);
  reject = false; const corrected = { ...input, requestId: 'corrected-user-intent' };
  assert.ok(await h.run('timeline:mutation', operation, corrected)); assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[1].input.requestId, corrected.requestId);
});

test('same-session reload rediscovers exact pending writes without automatically submitting or accepting newer project state', async t => {
  const values = storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  const first = harness(() => { throw Error('Lost after commit'); }); await first.run('timeline:mutation', operation, input);
  const original = submissions.readPending(projectId, 'timeline:mutation'), bytes = [...values.values()][0];
  const reloaded = harness(((acknowledged) as unknown as Parameters<typeof harness>[0]));
  assert.deepEqual(reloaded.state.pending, [original]); assert.equal(reloaded.state.calls.length, 0);
  submissions.reconcilePending(projectId, { timeline: timeline(99), exports: [{ requestId: input.requestId }], jobs: [{ requestId: input.requestId }] });
  assert.equal([...values.values()][0], bytes); assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  await reloaded.run((original)!.key, (original)!.operation, (original)!.input, undefined, { replay: true });
  assert.deepEqual(reloaded.state.calls, [{ operation, input }]); assert.equal((submissions.readPending(projectId, (original)!.key) as unknown), null);
});

test('late timeline results preserve project/navigation fences and release only their original busy key', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let release!: (value?:unknown)=>void; const held = new Promise(resolve => { release = resolve; });
  const h = harness((((_op: unknown, value: { projectId: string; }) => value.projectId === projectId ? held : acknowledged(operation, value)) as unknown as Parameters<typeof harness>[0]));
  const pending = h.run('timeline:mutation', operation, input, (('Old success') as unknown as Parameters<NonNullable<(typeof h)["run"]>>[3]));
  assert.equal((await h.run('timeline:mutation', operation, input) as unknown), null); assert.equal(h.state.calls.length, 1);
  h.currentProject.current = otherProjectId; h.state.epoch++; h.dataRef.current = { project: { id: otherProjectId }, timeline: timeline(7, otherProjectId) };
  const other = { ...input, projectId: otherProjectId, requestId: 'other-project-edit' };
  assert.ok(await h.run('timeline:mutation', operation, other));
  (release)!(acknowledged(operation, input)); assert.equal((await pending as unknown), null);
  assert.deepEqual(h.state.refreshes, [otherProjectId]); assert.equal(h.state.notices.some(item => item.message === 'Old success'), false);
  assert.equal((submissions.readPending(projectId, 'timeline:mutation') as unknown), null); assert.equal(h.busy.size, 0);
});

test('late same-project ACK respects draft navigation epoch while an opted-in mounted inspector can receive its own ACK', async t => {
  storage(t);
  for (const returnAfterNavigation of ([false, true] as const)) {
    let release!: (value?:unknown)=>void; const held = new Promise(resolve => { release = resolve; });
    const h = harness(((() => held) as unknown as Parameters<typeof harness>[0])), input = inputFor('timeline.clip.update'), draft = { gain: 0.75 };
    const pending = h.run('timeline:mutation', 'timeline.clip.update', input, (('Old success') as unknown as Parameters<NonNullable<(typeof h)["run"]>>[3]), (({ returnAfterNavigation }) as unknown as Parameters<NonNullable<(typeof h)["run"]>>[4]));
    h.state.epoch++; const expected = acknowledged('timeline.clip.update', input); (release)!(expected);
    assert.deepEqual(await pending, returnAfterNavigation ? expected : null); assert.deepEqual(draft, { gain: 0.75 });
    assert.equal(h.state.notices.length, 0); assert.equal((submissions.readPending(projectId, 'timeline:mutation') as unknown), null);
  }
});

test('late loss after project navigation retains only the original project receipt for explicit recovery', async t => {
  storage(t); const operation = 'timeline.clip.update', input = inputFor(operation);
  let reject!:(reason?:unknown)=>void; const held = new Promise<never>((_resolve, fail) => { reject = fail; });
  const h = harness(((() => held) as unknown as Parameters<typeof harness>[0])), pending = h.run('timeline:mutation', operation, input);
  const original = submissions.readPending(projectId, 'timeline:mutation');
  h.currentProject.current = otherProjectId; h.state.epoch++;
  (reject)!(Error('Response lost after leaving project')); assert.equal((await pending as unknown), null);
  assert.deepEqual(submissions.readPending(projectId, 'timeline:mutation'), original);
  assert.equal((submissions.readPending(otherProjectId, 'timeline:mutation') as unknown), null);
  assert.deepEqual((h.state.refreshes as unknown), []); assert.deepEqual((h.state.notices as unknown), []); assert.equal(h.busy.size, 0);
  const returned = harness(((acknowledged) as unknown as Parameters<typeof harness>[0]));
  assert.deepEqual(returned.state.pending, [original]); assert.equal(returned.state.calls.length, 0);
  await returned.run((original)!.key, (original)!.operation, (original)!.input, undefined, { replay: true });
  assert.deepEqual(returned.state.calls, [{ operation, input }]);
});

test('retained timeline and reference callbacks reject old-project input before any persistence or RPC', async t => {
  const values = storage(t);
  for (const operation of ([...operations, 'reference.attach', 'reference.detach'] as const)) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input, createdAt: '2026-10-10T00:00:00.000Z' });
    const bytes = [...values.entries()]; let reads = 0;
    const h = harness(() => { throw Error('Stale callbacks must not dispatch'); }, (({ projectSnapshot: () => { reads++; return {}; } }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
    h.currentProject.current = otherProjectId; h.state.epoch++; h.dataRef.current = { project: { id: otherProjectId }, timeline: timeline(7, otherProjectId) };
    for (const replay of ([false, true] as const)) assert.equal((await h.run(key, operation, input, undefined, { replay }) as unknown), null, operation);
    assert.equal(h.state.calls.length, 0, operation); assert.equal(reads, 0, operation); assert.equal(h.busy.size, 0);
    assert.deepEqual([...values.entries()], bytes, 'Neither project receives a new or changed receipt');
    assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.equal((submissions.readPending(otherProjectId, key) as unknown), null);
    submissions.clearPending(projectId, key);
  }
});

test('missing timeline and reference Tasks receipts cannot be recreated by an obsolete replay callback', async t => {
  const values = storage(t);
  for (const operation of ([...operations, 'reference.attach', 'reference.detach'] as const)) {
    const input = recoverableInput(operation), key = `pending:${operation}`; let reads = 0;
    const h = harness(() => { throw Error('Missing receipts must not dispatch'); }, (({ projectSnapshot: () => { reads++; return {}; } }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
    assert.equal((await h.run(key, operation, input, undefined, { replay: true }) as unknown), null, operation);
    assert.equal(values.size, 0, operation); assert.equal(h.state.calls.length, 0, operation); assert.equal(reads, 0, operation);
    assert.equal(h.busy.size, 0); assert.match((h.state.notices.at(-1))!.message, /原请求记录已变化或不再可用/);
  }
});

test('changed timeline and reference replay inputs or operation cannot replace the original saved request', async t => {
  const values = storage(t);
  for (const operation of ([...operations, 'reference.attach', 'reference.detach'] as const)) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input });
    const bytes = [...values.entries()]; const h = harness(() => { throw Error('Changed replay must not dispatch'); });
    for (const changed of ([{ ...input, requestId: 'changed-request' }, { ...input, [operation.startsWith('timeline.') ? 'expectedRevision' : 'expectedShotRevision']: 99 }] as const))
      assert.equal((await h.run(key, operation, changed, undefined, { replay: true }) as unknown), null);
    const otherOperation = operation === 'timeline.undo' ? 'timeline.redo' : 'timeline.undo';
    assert.equal((await h.run(key, otherOperation, input, undefined, { replay: true }) as unknown), null);
    assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original); assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('stored timeline or reference input with a different owner stays intact and is never dispatched', async t => {
  const values = storage(t);
  for (const operation of ([...operations, 'reference.attach', 'reference.detach'] as const)) {
    const input = recoverableInput(operation), key = `pending:${operation}`;
    const original = submissions.prepareSubmission({ projectId, key, operation, input: { ...input, projectId: otherProjectId } });
    const bytes = [...values.entries()]; const h = harness(() => { throw Error('Wrong-owner receipt must not dispatch'); });
    for (const replay of ([false, true] as const)) assert.equal((await h.run(key, operation, input, undefined, { replay }) as unknown), null);
    assert.equal(h.state.calls.length, 0); assert.deepEqual((h.state.refreshes as unknown), []); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original); assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('fresh timeline and reference actions cannot dispatch a different operation stored under the same key', async t => {
  const values = storage(t);
  for (const [operation, storedOperation] of ([
    ['reference.attach', 'timeline.clip.update'], ['reference.detach', 'timeline.render'],
    ['reference.attach', 'reference.detach'], ['reference.detach', 'reference.attach'],
    ['timeline.clip.update', 'reference.attach'], ['timeline.render', 'timeline.undo'],
  ] as const)) {
    const key = `pending:${operation}`, input = recoverableInput(operation);
    const original = submissions.prepareSubmission({ projectId, key, operation: storedOperation, input: recoverableInput(storedOperation) });
    const bytes = [...values.entries()]; let reads = 0;
    const h = harness(() => { throw error('REVISION_CONFLICT'); }, (({ projectSnapshot: () => { reads++; return {}; } }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
    for (const replay of ([false, true] as const)) assert.equal((await h.run(key, operation, input, undefined, { replay }) as unknown), null);
    assert.equal(h.state.calls.length, 0, `${operation} must not dispatch stored ${storedOperation}`);
    assert.equal(reads, 0); assert.equal(h.busy.size, 0);
    assert.deepEqual(submissions.readPending(projectId, key), original);
    assert.deepEqual([...values.entries()], bytes);
    submissions.clearPending(projectId, key);
  }
});

test('preview and export keys remain independent while pending preview cannot silently resubmit', async t => {
  storage(t); let fail = true;
  const h = harness((((operation?: unknown, input?: unknown) => { if (fail) throw Error('Lost response'); return acknowledged(((operation) as unknown as Parameters<NonNullable<typeof acknowledged>>[0]), ((input) as unknown as Parameters<NonNullable<typeof acknowledged>>[1])); }) as unknown as Parameters<typeof harness>[0]));
  const preview = inputFor('timeline.render'), exported = { ...preview, requestId: 'original-export', purpose: 'export' };
  await h.run('timeline:render:preview', 'timeline.render', preview);
  await h.run('timeline:render:export', 'timeline.render', exported);
  assert.equal(h.state.calls.length, 2); assert.equal(submissions.pendingForProject(projectId).length, 2);
  fail = false;
  await h.run('timeline:render:preview', 'timeline.render', { ...preview, requestId: 'new-preview' }); assert.equal(h.state.calls.length, 2);
  await h.run('timeline:render:preview', 'timeline.render', preview, undefined, { replay: true });
  assert.equal((submissions.readPending(projectId, 'timeline:render:preview') as unknown), null);
  assert.deepEqual((submissions.readPending(projectId, 'timeline:render:export'))!.input, exported);
});

test('digest-bound render stays pending on matching public refresh and clears only after explicit exact replay', async t => {
  storage(t); const operation = 'timeline.render', key = 'timeline:render:export';
  const input = inputFor(operation, { purpose: 'export', preflightSnapshotHash: 'b'.repeat(64) });
  let fail = true;
  const h = harness((((op?: unknown, value?: unknown) => { if (fail) throw Error('Lost after commit'); return acknowledged(((op) as unknown as Parameters<NonNullable<typeof acknowledged>>[0]), ((value) as unknown as Parameters<NonNullable<typeof acknowledged>>[1])); }) as unknown as Parameters<typeof harness>[0]));
  await h.run(key, operation, input);
  const original = submissions.readPending(projectId, key);
  submissions.reconcilePending(projectId, { exports: [acknowledged(operation, input)] });
  assert.deepEqual(submissions.readPending(projectId, key), original);
  assert.equal(h.state.calls.length, 1);
  fail = false; await h.run(key, operation, input, undefined, { replay: true });
  assert.equal((submissions.readPending(projectId, key) as unknown), null);
  assert.deepEqual(h.state.calls, [{ operation, input }, { operation, input }]);
});

test('actual App catch and project refresh cannot erase a render receipt after source-ownership or receipt rejection', async t => {
  storage(t);
  for (const digest of ([undefined, 'b'.repeat(64)] as const)) {
    const operation = 'timeline.render', key = 'timeline:render:export';
    const input = inputFor(operation, { purpose: 'export', ...(digest ? { preflightSnapshotHash: digest } : {}) });
    const record = acknowledged(operation, input);
    (record as typeof record & {status:("succeeded")}).status = 'succeeded'; (record as typeof record & {assetId:(string)}).assetId = id(20); (record as typeof record & {url:(string)}).url = `/media/${id(20)}`;
    assert.equal(isTimelineRenderRecord(record, input), true, 'The stale public record looks fully valid');
    let failure:(Error & {code?:string})|null = Error('Lost after commit'), refreshes = 0;
    const h = harness((((op?: unknown, value?: unknown) => { if (failure) throw failure; return acknowledged(((op) as unknown as Parameters<NonNullable<typeof acknowledged>>[0]), ((value) as unknown as Parameters<NonNullable<typeof acknowledged>>[1])); }) as unknown as Parameters<typeof harness>[0]), (({
      projectSnapshot: (owner?: unknown) => { refreshes++; return { project: { id: owner }, timeline: timeline(99), jobs: [], exports: [record] }; },
    }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
    await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key); assert.ok(original);
    for (const code of (['TIMELINE_SOURCE_UNAVAILABLE', 'INVALID_TIMELINE_SNAPSHOT', 'IDEMPOTENCY_CONFLICT'] as const)) {
      failure = error(code); await h.run(key, operation, input, undefined, { replay: true });
      assert.deepEqual(submissions.readPending(projectId, key), original, code);
      assert.deepEqual(h.state.pending, [original], code);
    }
    assert.equal(refreshes, 4); assert.equal(h.state.calls.length, 4);
    assert.equal(h.state.reads.filter(call => call.operation === 'provider.list').length, 4, 'normal workspace refresh still reads provider capabilities');
    assert.equal(h.state.reads.filter(call => call.operation === 'video.connection.list').length, 4, 'normal workspace refresh still reads video connections');
    assert.ok(h.state.calls.every(call => JSON.stringify(call.input) === JSON.stringify(input)));
    failure = null; await h.run(key, operation, input, undefined, { replay: true });
    assert.equal((submissions.readPending(projectId, key) as unknown), null);
  }
});

test('actual App refresh validates restored identity and held exports before changing data or reconciling receipts', async t => {
  const values = storage(t), workspace = { restored: true, workspaceOrigin: id(40) };
  const operation = 'timeline.render', input = inputFor(operation, { purpose: 'export' }), record = acknowledged(operation, input);
  const original = submissions.prepareSubmission({ projectId, key: 'timeline:render:export', operation, input });
  const current = submissions.prepareSubmission(((workspaceOrigin.pinNewWorkspaceIntent({ projectId, key: 'timeline:render:current', operation,
    input: { ...input, requestId: 'current-restored-export' } }, workspace)) as unknown as Parameters<typeof submissions.prepareSubmission>[0]));
  const historicalGeneration = submissions.prepareSubmission({ projectId, key: 'generate:historical', operation: 'generation.submit', input: { requestId: 'captured-generation-request' } });
  const originalBytes = [...values.entries()], restore = { workspaceOrigin: workspace.workspaceOrigin, heldExportIds: [record.id] };
  for (const [name, activeWorkspace, metadata, valid] of ([
    ['matching branch', workspace, restore, true],
    ['missing metadata', workspace, undefined, false],
    ['different origin', workspace, { ...restore, workspaceOrigin: id(41) }, false],
    ['unknown held export', workspace, { ...restore, heldExportIds: [id(42)] }, false],
    ['duplicate held export', workspace, { ...restore, heldExportIds: [record.id, record.id] }, false],
    ['extra metadata field', workspace, { ...restore, accepted: true }, false],
    ['restored reply to normal workspace', { restored: false }, restore, false],
  ] as const)) {
    const next = { project: { id: projectId }, timeline: timeline(99), exports: [record], jobs: [{ requestId: historicalGeneration.input.requestId }],
      ...(metadata === undefined ? {} : { restore: metadata }) };
    const h = harness(() => assert.fail('refresh must not dispatch a write'), (({ workspace: ((activeWorkspace) as unknown as { restored: boolean; } | undefined), projectSnapshot: () => next }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
    const before = h.dataRef.current;
    assert.equal(await (h.refresh as (owner:unknown,options?:unknown)=>Promise<unknown>)(projectId, false), valid ? next : null, name);
    assert.equal(h.dataRef.current === before, !valid, name);
    assert.equal(h.state.online, valid, name); assert.deepEqual(h.state.providers, valid ? [] : null, name);
    assert.deepEqual(h.state.reads.map(call => call.operation), (activeWorkspace)!.restored ? ['project.get'] : ['project.get', 'provider.list', 'video.connection.list'], name);
    assert.deepEqual((h.state.calls as unknown), [], name);
    assert.equal(h.state.notices.length, valid ? 0 : 1, name);
    if (!valid) assert.equal(h.state.notices[0].type, 'error', name);
    assert.deepEqual([...values.entries()], originalBytes, `${name}: refresh cannot rewrite or acknowledge retained requests`);
    assert.deepEqual(submissions.readPending(projectId, original.key), original);
    assert.deepEqual(submissions.readPending(projectId, current.key, current), current);
    assert.deepEqual(submissions.readPending(projectId, historicalGeneration.key), historicalGeneration);
  }
});

test('actual App refresh discards a late same-project snapshot after restored origin changes', ((async (t: test.TestContext) => {
  const values = storage(t), workspace = { restored: true, workspaceOrigin: id(40) };
  const original = submissions.prepareSubmission(((workspaceOrigin.pinNewWorkspaceIntent({ projectId, key: 'timeline:render:export', operation: 'timeline.render', input: inputFor('timeline.render') }, workspace)) as unknown as Parameters<typeof submissions.prepareSubmission>[0]));
  const originalBytes = [...values.entries()]; let release!: (value?:unknown)=>void;
  const held = new Promise(resolve => { release = resolve; });
  const h = harness(() => assert.fail('refresh must not dispatch a write'), (({ workspace, projectSnapshot: () => held }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
  const before = h.dataRef.current, pending = (h.refresh as (owner:unknown,options?:unknown)=>Promise<unknown>)(projectId, false);
  h.workspaceRef.current = { ...workspace, workspaceOrigin: id(41) };
  (release)!({ project: { id: projectId }, timeline: timeline(99), exports: [], restore: { workspaceOrigin: workspace.workspaceOrigin, heldExportIds: [] } });
  assert.equal((await pending as unknown), null); assert.equal(h.dataRef.current, before);
  assert.equal((h.state.online as unknown), null); assert.equal((h.state.providers as unknown), null); assert.deepEqual((h.state.notices as unknown), []);
  assert.deepEqual(h.state.reads, [{ operation: 'project.get', input: { projectId } }]); assert.deepEqual((h.state.calls as unknown), []);
  assert.deepEqual([...values.entries()], originalBytes); assert.deepEqual(submissions.readPending(projectId, original.key, original), original);
}) as unknown as test.TestFn));

test('pending timeline and reference cards disclose session-only recovery without broadening generation copy', () => {
  const cardSource = readFileSync(new URL('../apps/web/src/PendingSubmission.tsx', import.meta.url), 'utf8');
  const code = transformSync(cardSource, { loader: 'tsx', format: 'cjs' }).code, module = {exports:{} as TestModule['exports']};
  const react = { createElement: (type?: unknown, props?: Record<string,unknown>, ...children: unknown[]) => ({ type, props: { ...(props as Record<string, unknown>), children } }) };
  const require = (name: string) => name === 'react' ? { ...react, default: react }
    : name === './i18n/I18nProvider.tsx' ? i18nTestModule()
    : name === './creation-i18n.ts' ? { creationParameter }
    : name === '@mioon/contracts' ? { TIMELINE_MUTATION_OPERATIONS }
      : name.endsWith('mutation-submissions.ts') ? mutations
        : name.endsWith('reference-connections.ts') ? { isReferenceOperation }
          : new Proxy({}, { get: (_target, property) => String(property) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const nodes = (value:TestTree):TestNode[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
  for (const operation of ([...operations, 'reference.attach', 'reference.detach', 'shot.update', 'generation.submit', 'export.create'] as const)) {
    const tree = nodes(module.exports.default({ entry: { operation, createdAt: '2026-10-10T00:00:00.000Z' }, busy: false, onReplay() {} }));
    const warning = tree.find((node) => node.props?.['data-testid'] === 'mutation-recovery-storage');
    assert.equal(Boolean(warning), !['generation.submit', 'export.create'].includes(operation), operation);
    if (warning) {
      assert.match(warning.props.children.join(''), /恢复记录仅存于当前浏览器会话，未经保险库加密/);
      assert.match(warning.props.children.join(''), /关闭窗口或重建应用会话可能丢失记录/);
    }
  }
});

test('reference attach and detach retain ordinary 4xx without proof and unrelated matching records cannot clear them', async t => {
  storage(t);
  for (const operation of (['reference.attach', 'reference.detach'] as const)) {
    const key = operation, input = { projectId, requestId: `original-${operation}`, expectedShotRevision: 7,
      ...(operation === 'reference.attach' ? { sourceNodeId: id(11), targetShotId: id(12), expectedSourceRevision: 3, role: 'first_frame' } : { edgeId: id(13) }) };
    let failure:(Error & {code?:string})|null = Error('Lost reference response'); const h = harness(() => { throw failure; }); await h.run(key, operation, input);
    const original = submissions.readPending(projectId, key);
    for (const code of (['NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED'] as const)) {
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


test('a project that has not opened cannot publish a recovery refresh', async t => {
  storage(t);
  let reads = 0; const h = harness(() => assert.fail('No mutation'), (({ projectSnapshot: () => { reads++; return { project: { id: projectId } }; } }) as unknown as Parameters<NonNullable<typeof harness>>[1]));
  h.state.projectReady = false; const before = structuredClone(h.dataRef.current);
  assert.equal((await h.refresh(projectId) as unknown), null); assert.equal(reads, 0); assert.deepEqual(h.dataRef.current, before);
});
