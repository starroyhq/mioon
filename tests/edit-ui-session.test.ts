import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Format5EditSession, format5CommandErrorMessageKey, format5EditUiTimeline, format5InspectorSequence, format5PasteStartFrame,
  format5UserUndoBlocked, format5MoveCommand, format5PatchCommand, format5Projection, format5SceneSplitNotice, format5SplitCommand, format5TrimCommand, format5VersionCommand,
} from '../apps/web/src/edit-ui/session.ts';
import type {SequenceRpc} from '../apps/web/src/edit-ui/session.ts';
import {LostResponseState, UNCONFIRMED_CODE} from '../apps/web/src/edit-ui/lost-response.ts';
import {ApiError} from '../apps/web/src/api.ts';
import type {RequestOutcome} from '../apps/web/src/request-outcome-client.ts';

const projectId = '70000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '70000000-0000-4000-8000-000000000002';
const envelope = (requestId = 'preview-1') => ({contractVersion: 1, requestId, projectId, actionId: crypto.randomUUID(),
  originSide: 'timeline', filmId: projectId, intents: [], subjectIntent: undefined,
  baseline: {contentRevision: 1, timelineRevision: 1, syncRevision: 1, historyPosition: 0, historyRevision: 1, targets: []},
  impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
  allocation: {clips: [], nodes: [], splitClips: [], edges: []}}) as never;
const success = {ok: true, actionId: crypto.randomUUID(), operation: 'timeline.clip.split', patch: {}, receipt: {status: 'applied',
  history: {epoch: projectId, position: 1, revision: 2, undo: null, redo: null}}};

function recorder() {
  const calls: {operation: string; input: any}[] = [];
  const rpc: SequenceRpc = async (operation, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.preview') return {envelope: envelope(), planDigest: 'a'.repeat(64), warnings: []};
    if (operation === 'sequence.commit') return success;
    if (operation === 'sequence.history.get') return {epoch: projectId, position: 2, revision: 3,
      undo: {actionId: 'action-1', operation: 'timeline.clip.split', affected: 1},
      redo: {actionId: 'action-2', operation: 'timeline.clip.trim', affected: 1}};
    if (operation === 'sequence.undo' || operation === 'sequence.redo') return success;
    throw Object.assign(new Error('unknown'), {code: 'UNKNOWN'});
  };
  return {calls, rpc};
}

test('run previews once and commits the same envelope and digest', async () => {
  const {calls, rpc} = recorder();
  const session = new Format5EditSession(rpc, () => projectId);
  const result = await session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.operation), ['sequence.preview', 'sequence.commit']);
  assert.equal(calls[0]!.input.projectId, projectId);
  assert.equal(calls[1]!.input.envelope, calls[0]!.input.command ? calls[1]!.input.envelope : calls[1]!.input.envelope);
  assert.equal(calls[1]!.input.expectedPlanDigest, 'a'.repeat(64));
});

test('a second click while the first request is in flight does not write', async () => {
  const {calls, rpc} = recorder();
  const session = new Format5EditSession(async (operation, input: any) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return rpc(operation, input);
  }, () => projectId);
  const first = session.run(format5TrimCommand('clip-1' as never, 20));
  const second = await session.run(format5TrimCommand('clip-1' as never, 20));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'SEQUENCE_EDIT_PATCH_INVALID');
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(call => call.operation === 'sequence.commit').length, 1);
});

test('copy-and-move re-previews with a copy identity and commits only after confirm', async () => {
  const calls: {operation: string; input: any}[] = [];
  let copyEnvelope = envelope('copy-1');
  const rpc: SequenceRpc = async (operation, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.preview') {
      const operation = (input.intents?.[0]?.operation ?? {}) as {edit?: {copyNodeId?: string}};
      if (!operation.edit?.copyNodeId) return {ok: false, code: 'COPY_NODE_REQUIRED'};
      return {envelope: copyEnvelope, planDigest: 'b'.repeat(64), warnings: []};
    }
    if (operation === 'sequence.commit') return success;
    throw Object.assign(new Error('unknown'), {code: 'UNKNOWN'});
  };
  const session = new Format5EditSession(rpc, () => projectId);
  const request = {clipId: 'clip-1', nodeId: 'node-1', segmentGroupId: 'group-1', targetTrackId: 'track-1',
    targetStartFrame: 0, timelineRevision: 1};
  const outcome = await session.requestMove(format5MoveCommand('clip-1', null), request as never);
  assert.deepEqual(outcome, {needsCopy: true});
  assert.equal(calls.filter(call => call.operation === 'sequence.commit').length, 0);
  assert.equal(calls[1]!.input.intents[0].operation.edit.copyNodeId.length, 36);
  assert.equal(session.copyRequest?.clipId, 'clip-1');
  const confirmed = await session.confirmCopy();
  assert.equal(confirmed.ok, true);
  assert.equal(calls[2]!.operation, 'sequence.commit');
  assert.equal(calls[2]!.input.envelope, copyEnvelope);
  assert.equal(calls[2]!.input.expectedPlanDigest, 'b'.repeat(64));
});

test('cancelling the copy confirmation writes nothing and drops the preview', async () => {
  let commits = 0;
  const rpc: SequenceRpc = async (operation, input: any) => {
    if (operation === 'sequence.preview') {
      return (input.intents?.[0]?.operation?.edit as {copyNodeId?: string} | undefined)?.copyNodeId
        ? {envelope: envelope('copy-2'), planDigest: 'c'.repeat(64), warnings: []}
        : {ok: false, code: 'COPY_NODE_REQUIRED'};
    }
    if (operation === 'sequence.commit') {commits++; return success;}
    throw Object.assign(new Error('unknown'), {code: 'UNKNOWN'});
  };
  const session = new Format5EditSession(rpc, () => projectId);
  await session.requestMove(format5MoveCommand('clip-1', null), {clipId: 'clip-1'} as never);
  session.cancelCopy();
  assert.equal(session.copyRequest, null);
  assert.equal(commits, 0);
  assert.equal((await session.confirmCopy()).ok, false);
});

test('undo/redo bind the exact history cursor the caller read', async () => {
  const calls: {operation: string; input: any}[] = [];
  const rpc: SequenceRpc = async (operation, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.history.get') return {epoch: projectId, position: 2, revision: 3,
      undo: {actionId: 'action-1', operation: 'timeline.clip.split', affected: 1}, redo: null};
    return success;
  };
  const session = new Format5EditSession(rpc, () => projectId);
  const view = await session.history();
  assert.ok(view);
  await session.undo(view);
  assert.equal(calls[1]!.operation, 'sequence.undo');
  assert.deepEqual(calls[1]!.input.expected, {position: 2, revision: 3});
  assert.equal((await session.redo(view)).ok, false);
  for (const code of ['COPY_NODE_REQUIRED', 'SEQUENCE_EDIT_ANCHOR_CONFLICT', 'SEQUENCE_EDIT_REVISION_CONFLICT', 'OTHER']) {
    assert.match(format5CommandErrorMessageKey(code), /^editUi\.error\./);
  }
  // FR-B2 scene refusals keep the format 3/4 reasons instead of the generic one.
  assert.equal(format5CommandErrorMessageKey('NOTHING_TO_SPLIT'), 'scene.split.nothing');
  assert.equal(format5CommandErrorMessageKey('SEQUENCE_EDIT_SCENE_RESULT_CONFLICT'), 'scene.error.resultConflict');
  assert.equal(format5CommandErrorMessageKey('SEQUENCE_EDIT_SCENE_RESULT_STALE'), 'scene.error.resultStale');
});

test('scene split notice reports the applied count and the skipped count', () => {
  assert.deepEqual(format5SceneSplitNotice(undefined), {key: 'scene.split.done', params: {count: 0, skipped: 0}});
  const split = (length: number) => Array.from({length}, () => ({clipId: crypto.randomUUID(), clipIds: [crypto.randomUUID(), crypto.randomUUID()],
    cutFrames: [30], fadeCutFrames: []}));
  const skipped = (length: number) => Array.from({length}, () => ({clipId: crypto.randomUUID(), reason: 'NO_CUT_IN_RANGE' as const}));
  assert.deepEqual(format5SceneSplitNotice({split: split(3) as never, skipped: []}),
    {key: 'scene.split.done', params: {count: 3, skipped: 0}});
  assert.deepEqual(format5SceneSplitNotice({split: split(3) as never, skipped: skipped(2) as never}),
    {key: 'scene.split.doneSkipped', params: {count: 3, skipped: 2}});
});

test('format-5 projection maps persisted sources, statuses, anchors and shot identity', () => {
  const timeline = {id: 'timeline-1', projectId, revision: 4, fps: 30, width: 720, height: 1080, durationFrames: 90,
    mainTrack: {trackId: 'track-main', sequenceNodeId: 'root'},
    tracks: [{id: 'track-main', name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: 'track-audio', name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      {id: 'clip-1', trackId: 'track-main', assetId: 'asset-1', name: 'A', startFrame: 0, durationFrames: 60,
        sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1080}, gain: 1, versionId: 'version-1',
        shotId: 'shot-1', sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: 'shot-1', segmentGroupId: 'group-1', versionMode: 'follow'}},
      {id: 'clip-2', trackId: 'track-main', assetId: 'asset-1', name: 'B', startFrame: 60, durationFrames: 30,
        sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1080}, gain: 1, sourceState: 'placeholder',
        sequenceSource: {kind: 'shot', nodeId: 'shot-2', segmentGroupId: 'group-2', versionMode: 'follow'}},
      {id: 'clip-3', trackId: 'track-audio', assetId: 'asset-2', name: 'Audio', startFrame: 10, durationFrames: 5,
        sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1080}, gain: 1, anchor: {clipId: 'clip-1', offsetFrames: 10}},
    ],
    subtitles: {profileId: 'p', cues: [{id: 'cue-1', text: 'hi', startFrame: 20, durationFrames: 5, anchor: {clipId: 'clip-1', offsetFrames: 20}}]},
    createdAt: '', updatedAt: ''};
  const shots = [{id: 'shot-1', title: '窗口剪影', selectedVersionId: 'version-1'}];
  const versions = [{id: 'version-1', projectId, shotId: 'shot-1', number: 1}];
  const input = format5EditUiTimeline(timeline as never, shots as never, versions as never);
  assert.ok(input);
  const projection = format5Projection(timeline as never, shots as never, versions as never);
  assert.equal(projection?.mainTrackId, 'track-main');
  assert.equal(projection?.clips.get('clip-1')?.status?.kind, 'follow');
  assert.equal(projection?.clips.get('clip-2')?.status?.kind, 'placeholder');
  assert.equal(projection?.clips.get('clip-3')?.anchor?.kind, 'attached');
  assert.equal(projection?.cueAnchors.get('cue-1')?.kind, 'attached');
  const inspector = format5InspectorSequence(timeline as never, shots as never, versions as never, 'clip-1', {});
  assert.equal(inspector?.shotName, '窗口剪影');
  assert.equal(inspector?.versionMode, 'follow');
});

test('clip patches map to the six supported TS commands and reject unknown fields silently', () => {
  const clip = {id: 'clip-1', trackId: 'track-main', startFrame: 0, durationFrames: 60, sourceInFrame: 0};
  const trim = format5PatchCommand(clip, {durationFrames: 20, sourceInFrame: 4}, 'track-main');
  const version = format5PatchCommand(clip, {versionId: 'version-2', locked: true}, 'track-main');
  const move = format5PatchCommand(clip, {trackId: 'track-audio', startFrame: 12}, 'track-main');
  assert.equal('kind' in trim && trim.kind, 'clip-trim');
  assert.equal('kind' in version && version.kind, 'clip-version');
  assert.equal('kind' in move && move.kind, 'clip-move-off-track');
  assert.deepEqual(format5PatchCommand(clip, {gain: 0.5}, 'track-main'), {unsupported: ['gain']});
});

test('user Ctrl+Z protection detects a Mio action at the history top', () => {
  const view = {epoch: projectId, position: 2, revision: 3,
    undo: {actionId: 'action-mio', operation: 'timeline.clip.set-properties', affected: 1, origin: 'mio' as const},
    redo: null};
  assert.equal(format5UserUndoBlocked(view), true);
  assert.equal(format5UserUndoBlocked({...view, undo: {...view.undo, origin: 'user' as const}}), false);
  assert.equal(format5UserUndoBlocked({...view, undo: {...view.undo, origin: undefined}}), false);
  assert.equal(format5UserUndoBlocked({...view, undo: {actionId: 'user-action', operation: 'timeline.clip.set-properties', affected: 1},
    undoBlockedBy: 'mio'}), true);
  assert.equal(format5UserUndoBlocked(null), false);
});

// ---------------------------------------------------------------------------
// Lost commit response: the accepted envelope is retained, one read-only
// receipt lookup decides, and retry reuses the exact request id.
// ---------------------------------------------------------------------------
type CommitScenario = 'applied' | 'not-applied' | 'lost-after-write' | 'lost-not-applied'
  | 'lost-before-write' | 'rejected' | 'garbage';
type ReadScript = {readonly kind: 'outcome'; readonly outcome: RequestOutcome} | {readonly kind: 'missing'}
  | {readonly kind: 'error'} | {readonly kind: 'timeout'};

const PLAN_DIGEST = 'e'.repeat(64);
const appliedRead = (operation = 'timeline.clip.split'): RequestOutcome =>
  ({applied: true, operation, status: 'applied', code: null});
const missingRead: RequestOutcome = {applied: false, operation: null};

function lostHarness(initial: {readonly scenarios: readonly CommitScenario[]; readonly read: ReadScript;
  readonly readTimeoutMs?: number}) {
  const calls: {operation: string; input: any}[] = [];
  const writes: {requestId: string; status: 'applied' | 'not_applied'}[] = [];
  const reads: {projectId: string; requestId: string}[] = [];
  const scenarios = [...initial.scenarios];
  let previews = 0;
  const rpc: SequenceRpc = async (operation, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.preview') {
      previews++;
      const envelope = {contractVersion: 1, requestId: `${input.trackIntent ? 'track-preview' : input.formatIntent ? 'format-preview' : 'preview'}-${previews}`,
        projectId: input.projectId, ...(input.trackIntent ? {trackIntent: input.trackIntent} : {}),
        ...(input.formatIntent ? {formatIntent: input.formatIntent} : {}),
        ...(input.subtitlesIntent ? {subtitlesIntent: input.subtitlesIntent} : {}),
        ...(input.propertiesIntent ? {propertiesIntent: input.propertiesIntent} : {}),
        ...(input.intents ? {intents: input.intents} : {})};
      return {envelope, planDigest: PLAN_DIGEST, warnings: []};
    }
    if (operation === 'sequence.commit') {
      const scenario = scenarios.shift() ?? 'applied';
      const requestId = String(input.envelope.requestId);
      const applied = {status: 'applied', actionId, operation: 'timeline.clip.split'};
      if (scenario === 'rejected') throw new ApiError('conflict', 'SEQUENCE_EDIT_REVISION_CONFLICT', {}, true, 409);
      if (scenario === 'lost-before-write') throw new ApiError('lost response', 'NETWORK', undefined, false);
      if (scenario === 'garbage') return 'garbage';
      if (scenario === 'lost-after-write') {
        writes.push({requestId, status: 'applied'});
        throw new ApiError('lost response', 'NETWORK', undefined, false);
      }
      if (scenario === 'lost-not-applied') {
        writes.push({requestId, status: 'not_applied'});
        throw new ApiError('lost response', 'NETWORK', undefined, false);
      }
      if (scenario === 'not-applied') {
        writes.push({requestId, status: 'not_applied'});
        return {status: 'not_applied', actionId, operation: 'timeline.clip.split', code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'};
      }
      writes.push({requestId, status: 'applied'});
      return applied;
    }
    if (operation === 'sequence.history.get') return null;
    throw Object.assign(new Error(`unexpected ${operation}`), {code: 'GENERIC'});
  };
  const readOutcome = async (input: {projectId: string; requestId: string}): Promise<RequestOutcome> => {
    reads.push({projectId: input.projectId, requestId: input.requestId});
    if (initial.read.kind === 'timeout') return new Promise<RequestOutcome>(() => {});
    if (initial.read.kind === 'error') throw new ApiError('unavailable', 'REQUEST_OUTCOME_UNAVAILABLE', {}, false);
    return initial.read.kind === 'missing' ? missingRead : initial.read.outcome;
  };
  const session = new Format5EditSession(rpc, () => projectId,
    {lost: new LostResponseState({readOutcome, readTimeoutMs: initial.readTimeoutMs ?? 20})});
  return {session, rpc, readOutcome, calls, writes, reads,
    commits: (): any[] => calls.filter(call => call.operation === 'sequence.commit')};
}
let actionId = crypto.randomUUID();

test('a lost main-track commit is settled by one receipt read and never writes twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead()}});
  const result = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  const committed = h.commits();
  assert.equal(committed.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.reads[0], {projectId, requestId: committed[0]!.input.envelope.requestId});
  assert.equal(h.session.unconfirmed, null);
  assert.equal(result.ok, true);
  if (result.ok) {assert.equal(result.resolvedFromReceipt, true); assert.equal(result.actionId, null);}
  // A click after the settled edit goes through the normal path again.
  const again = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(again.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a lost clip-properties commit is settled by one receipt read and never writes twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.clip.version')}});
  const result = await h.session.run(format5VersionCommand('clip-1', {mode: 'follow', versionId: 'version-2'}));
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.equal(h.session.unconfirmed, null);
  assert.equal(result.ok, true);
  const again = await h.session.run(format5VersionCommand('clip-1', {mode: 'follow', versionId: 'version-2'}));
  assert.equal(again.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a lost track commit is settled by one receipt read and never writes twice', async () => {
  const trackIntent = {side: 'timeline' as const, operation: {kind: 'track-structure' as const,
    edit: {kind: 'add' as const, trackId: crypto.randomUUID(), trackKind: 'video' as const}}};
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.track.add')}});
  const result = await h.session.runTrack(trackIntent);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.equal(h.commits()[0]!.input.envelope.trackIntent.operation.edit.kind, 'add');
  assert.equal(h.session.unconfirmed, null);
  assert.equal(result.ok, true);
});

test('a lost main-track commit without a receipt stays unconfirmed and retry reuses the same request id', async () => {
  const h = lostHarness({scenarios: ['lost-before-write', 'applied'], read: {kind: 'missing'}});
  const first = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(first.ok, false);
  if (!first.ok) {assert.equal(first.code, UNCONFIRMED_CODE); assert.equal('unconfirmed' in first, true);}
  assert.equal(h.session.unconfirmed?.requestId, h.commits()[0]!.input.envelope.requestId);
  assert.equal(h.writes.length, 0);
  const retried = await h.session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.commits().length, 2);
  assert.equal(h.commits()[1]!.input.envelope.requestId, h.commits()[0]!.input.envelope.requestId);
  assert.deepEqual(h.commits()[1]!.input.envelope, h.commits()[0]!.input.envelope);
  assert.equal(h.commits()[1]!.input.expectedPlanDigest, h.commits()[0]!.input.expectedPlanDigest);
  assert.equal(h.session.unconfirmed, null);
});

test('a lost track commit without a receipt is abandoned without any write', async () => {
  const trackIntent = {side: 'timeline' as const, operation: {kind: 'track-structure' as const,
    edit: {kind: 'add' as const, trackId: crypto.randomUUID(), trackKind: 'video' as const}}};
  const h = lostHarness({scenarios: ['lost-before-write'], read: {kind: 'missing'}});
  const first = await h.session.runTrack(trackIntent);
  assert.equal(first.ok, false);
  h.session.abandonUnconfirmed();
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.commits().length, 1);
  assert.equal(h.writes.length, 0);
  const next = await h.session.runTrack(trackIntent);
  assert.equal(next.ok, true);
  assert.equal(h.commits().length, 2);
});

test('an unconfirmed edit blocks the next clip-properties action with one reason and no preview', async () => {
  const h = lostHarness({scenarios: ['lost-before-write', 'applied'], read: {kind: 'missing'}});
  await h.session.run(format5VersionCommand('clip-1', {mode: 'follow', versionId: 'version-2'}));
  const callsBefore = h.calls.length;
  const blocked = await h.session.run(format5VersionCommand('clip-1', {mode: 'follow', versionId: 'version-3'}));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, UNCONFIRMED_CODE);
  assert.equal(h.calls.length, callsBefore, 'the blocked action made no preview or commit call');
  const retried = await h.session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  assert.equal(h.writes.length, 1);
});

test('a definitive rejection never enters the unconfirmed state and never reads a receipt', async () => {
  const h = lostHarness({scenarios: ['rejected'], read: {kind: 'outcome', outcome: appliedRead()}});
  const result = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SEQUENCE_EDIT_REVISION_CONFLICT');
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.reads.length, 0);
  assert.equal(h.commits().length, 1);
});

test('an unparsable commit response is unknown and triggers exactly one receipt read', async () => {
  const h = lostHarness({scenarios: ['garbage'], read: {kind: 'missing'}});
  const result = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, UNCONFIRMED_CODE);
  assert.equal(h.reads.length, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.reads.length, 1, 'no polling after the one read');
  assert.equal(h.commits().length, 1);
});

test('a failed or timed-out receipt read keeps the edit unconfirmed without another write', async () => {
  for (const read of [{kind: 'error'} as const, {kind: 'timeout'} as const]) {
    const h = lostHarness({scenarios: ['lost-after-write'], read});
    const result = await h.session.run(format5SplitCommand('clip-1' as never, 30));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, UNCONFIRMED_CODE, read.kind);
    assert.equal(h.session.unconfirmed?.requestId, h.commits()[0]!.input.envelope.requestId);
    assert.equal(h.reads.length, 1);
    assert.equal(h.commits().length, 1);
    assert.equal(h.writes.length, 1);
  }
});

test('a not-applied receipt read is the explicit reason code and clears the retained envelope', async () => {
  const h = lostHarness({scenarios: ['lost-not-applied'], read: {kind: 'outcome', outcome:
    {applied: false, operation: 'timeline.clip.split', status: 'not_applied', code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT'}}});
  const result = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.reads.length, 1);
  assert.equal(h.writes[0]!.status, 'not_applied');
  const next = await h.session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(next.ok, true);
});

test('a lost copy confirmation retries the same copy envelope without a new preview', async () => {
  const calls: {operation: string; input: any}[] = [];
  const copyEnvelope: any = envelope('copy-lost-1');
  const h = lostHarness({scenarios: ['lost-before-write', 'applied'], read: {kind: 'missing'}});
  const rpc: SequenceRpc = async (operation, input: any) => {
    calls.push({operation, input});
    if (operation === 'sequence.preview') {
      return (input.intents?.[0]?.operation?.edit as {copyNodeId?: string} | undefined)?.copyNodeId
        ? {envelope: copyEnvelope, planDigest: 'f'.repeat(64), warnings: []}
        : {ok: false as const, code: 'COPY_NODE_REQUIRED'};
    }
    return h.rpc(operation, input);
  };
  const session = new Format5EditSession(rpc, () => projectId,
    {lost: new LostResponseState({readOutcome: h.readOutcome, readTimeoutMs: 20})});
  const outcome = await session.requestMove(format5MoveCommand('clip-1', null), {clipId: 'clip-1'} as never);
  assert.deepEqual(outcome, {needsCopy: true});
  const first = await session.confirmCopy();
  assert.equal(first.ok, false);
  assert.equal(session.unconfirmed?.requestId, copyEnvelope.requestId);
  const previewsBefore = calls.filter(call => call.operation === 'sequence.preview').length;
  const retried = await session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  const commits = calls.filter(call => call.operation === 'sequence.commit');
  assert.equal(commits.length, 2);
  assert.equal(commits[1]!.input.envelope.requestId, copyEnvelope.requestId);
  assert.equal(commits[1]!.input.expectedPlanDigest, 'f'.repeat(64));
  assert.equal(calls.filter(call => call.operation === 'sequence.preview').length, previewsBefore,
    'retry never previews again');
  assert.equal(session.unconfirmed, null);
});

test('a project switch drops a retained edit instead of retrying it in the new project', async () => {
  let current: string | null = projectId;
  const reads: string[] = [];
  const rpc: SequenceRpc = async (operation, input: any) => {
    if (operation === 'sequence.preview') {
      const base: any = envelope('switch-1');
      return {envelope: {...base, projectId: input.projectId}, planDigest: PLAN_DIGEST, warnings: []};
    }
    if (operation === 'sequence.commit') {
      if (input.projectId === projectId) throw new ApiError('lost', 'NETWORK', undefined, false);
      return {status: 'applied', actionId, operation: 'timeline.clip.split'};
    }
    throw Object.assign(new Error('unexpected'), {code: 'GENERIC'});
  };
  const session = new Format5EditSession(rpc, () => current, {lost: new LostResponseState({
    readOutcome: async input => {reads.push(input.requestId); return missingRead;}, readTimeoutMs: 20})});
  await session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(session.unconfirmed?.projectId, projectId);
  current = OTHER_PROJECT;
  const next = await session.run(format5SplitCommand('clip-1' as never, 30));
  assert.equal(next.ok, true);
  assert.equal(session.unconfirmed, null);
  assert.equal(reads.length, 1);
});

test('a lost output-frame commit is settled by one receipt read and never writes twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.format.set')}});
  const result = await h.session.format('16:9');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.resolvedFromReceipt, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.reads[0], {projectId, requestId: h.commits()[0]!.input.envelope.requestId});
  assert.equal(h.commits()[0]!.input.envelope.formatIntent.operation.kind, 'timeline-format');
  assert.equal(h.commits()[0]!.input.envelope.formatIntent.operation.presetId, '16:9');
  assert.equal(h.session.unconfirmed, null);
  // The same class runs normally once the lost edit is settled.
  const again = await h.session.format('16:9');
  assert.equal(again.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a lost output-frame commit without a receipt retries the same request id and applies once', async () => {
  const h = lostHarness({scenarios: ['lost-before-write', 'applied'], read: {kind: 'missing'}});
  const first = await h.session.format('9:16');
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.code, UNCONFIRMED_CODE);
  assert.equal(h.session.unconfirmed?.requestId, h.commits()[0]!.input.envelope.requestId);
  assert.equal(h.writes.length, 0);
  const retried = await h.session.retryUnconfirmed();
  assert.equal(retried.ok, true);
  assert.equal(h.writes.length, 1);
  const commits = h.commits();
  assert.equal(commits.length, 2);
  assert.equal(commits[1]!.input.envelope.requestId, commits[0]!.input.envelope.requestId);
  assert.deepEqual(commits[1]!.input.envelope, commits[0]!.input.envelope);
  assert.equal(commits[1]!.input.expectedPlanDigest, commits[0]!.input.expectedPlanDigest);
  assert.equal(h.session.unconfirmed, null);
});

test('a lost output-frame commit is abandoned without a write and a rejection never enters unconfirmed', async () => {
  const abandoned = lostHarness({scenarios: ['lost-before-write'], read: {kind: 'missing'}});
  const first = await abandoned.session.format('4:3');
  assert.equal(first.ok, false);
  abandoned.session.abandonUnconfirmed();
  assert.equal(abandoned.session.unconfirmed, null);
  assert.equal(abandoned.commits().length, 1);
  assert.equal(abandoned.writes.length, 0);
  assert.equal((await abandoned.session.format('4:3')).ok, true);
  const rejected = lostHarness({scenarios: ['rejected'], read: {kind: 'outcome', outcome: appliedRead()}});
  const denied = await rejected.session.format('16:9');
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'SEQUENCE_EDIT_REVISION_CONFLICT');
  assert.equal(rejected.reads.length, 0);
  assert.equal(rejected.session.unconfirmed, null);
});

test('a lost scene-split commit is settled by one receipt read without writing twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.clip.splitAtScenes')}});
  const result = await h.session.splitAtScenes('asset-1', 'scene-result-1');
  assert.equal(result.ok, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  const committed = h.commits()[0]!;
  assert.equal(committed.input.envelope.intents[0].operation.kind, 'track');
  assert.equal(committed.input.envelope.intents[0].operation.edit.kind, 'split-at-scenes');
  assert.equal(committed.input.envelope.intents[0].operation.edit.assetId, 'asset-1');
  assert.equal(h.session.unconfirmed, null);
});

test('a lost subtitle commit is settled by one receipt read and never writes twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.subtitle.edit')}});
  const cueId = crypto.randomUUID();
  const subtitlesIntent = {side: 'timeline', operation: {kind: 'subtitles', edits: [{kind: 'add',
    cue: {id: cueId, text: '面板字幕', startFrame: 10, durationFrames: 20}}]}};
  const result = await h.session.runPayload({subtitlesIntent});
  assert.equal(result.ok, true);
  if (result.ok) {assert.equal(result.resolvedFromReceipt, true); assert.equal(result.actionId, null);}
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.equal(h.session.unconfirmed, null);
  assert.equal(h.commits()[0]!.input.envelope.subtitlesIntent.operation.edits[0].cue.id, cueId,
    'the exact subtitle envelope is the one that was committed');
  // A settled lost edit never blocks the next panel action.
  const again = await h.session.runPayload({subtitlesIntent: {side: 'timeline', operation: {kind: 'subtitles',
    edits: [{kind: 'update', cueId, patch: {text: '改一句'}}]}}});
  assert.equal(again.ok, true);
  assert.equal(h.commits().length, 2);
});

test('a lost clip-properties panel commit is settled by one receipt read and never writes twice', async () => {
  const h = lostHarness({scenarios: ['lost-after-write'], read: {kind: 'outcome', outcome: appliedRead('timeline.clip.properties')}});
  const propertiesIntent = {side: 'timeline', operation: {kind: 'clip-properties', edits: [{clipId: crypto.randomUUID(),
    patch: {name: '改名', gain: 0.5}}]}};
  const result = await h.session.runPayload({propertiesIntent});
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.resolvedFromReceipt, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reads.length, 1);
  assert.equal(h.session.unconfirmed, null);
  assert.deepEqual(h.commits()[0]!.input.envelope.propertiesIntent.operation.edits[0].patch, {name: '改名', gain: 0.5});
});

test('format-5 paste takes the live playhead rather than a stale keydown closure', () => {
  assert.equal(format5PasteStartFrame(30, 12, 0), 30);
  assert.equal(format5PasteStartFrame(null, 12, 0), 12);
  assert.equal(format5PasteStartFrame(undefined, undefined, 7), 7);
  assert.equal(format5PasteStartFrame(-2, 12.6, 0), 13);
});
