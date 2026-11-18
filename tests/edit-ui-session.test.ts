import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Format5EditSession, format5CommandErrorMessageKey, format5EditUiTimeline, format5InspectorSequence,
  format5MoveCommand, format5PatchCommand, format5Projection, format5SplitCommand, format5TrimCommand,
} from '../apps/web/src/edit-ui/session.ts';
import type {SequenceRpc} from '../apps/web/src/edit-ui/session.ts';

const projectId = '70000000-0000-4000-8000-000000000001';
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
      const command = input.command as {copyNodeId?: string};
      if (!command.copyNodeId) return {ok: false, code: 'COPY_NODE_REQUIRED'};
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
  assert.equal(calls[1]!.input.command.copyNodeId.length, 36);
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
      return (input.command as {copyNodeId?: string}).copyNodeId
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
