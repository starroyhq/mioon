import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  applySequenceEditTimelineDelta, moveSequenceSyncHistory, previewSequenceSync, readSequenceSyncProjection, runSequenceSync,
} from '../packages/business/src/format5-sequence-sync.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';
import type {
  SequenceEditCommitResult, SequenceEditEnvelope, SequenceEditHistoryCommand, SequenceEditPatch,
  SequenceEditTimelineCommit, SequenceEditTransactionFailure,
} from '../packages/contracts/src/sequence-edit.ts';
import {applySequenceEditBaselineChange, invertSequenceEditPatch} from '../packages/contracts/src/sequence-edit.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const rootId = id(2), shotA = id(3), shotB = id(4), imageNode = id(5);
const videoTrack = id(60), audioTrack = id(61);
const assetA = id(10), assetB = id(11), imageAsset = id(12), audioAsset = id(13);
const versionA = id(20), versionB = id(21), jobA = id(70), jobB = id(71);
const clipA = id(30), clipB = id(31), clipImage = id(32), clipAudio = id(33), cueId = id(34);
const groupA = id(40), groupB = id(41), groupImage = id(42);
const timelineId = id(50);
const sha = (letter: string): string => letter.repeat(64);
type Result = SequenceEditCommitResult;

function fixture(t: test.TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-sync-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const shot = (shotId: string, orderIndex: number, selectedVersionId: string | null, duration: number) =>
    ({id: shotId, projectId, orderIndex, selectedVersionId, duration, createdAt: at, updatedAt: at});
  const edge = (edgeId: string, source: string, target: string) =>
    ({id: edgeId, projectId, kind: 'sequence', source, target, createdAt: at});
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 150,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}],
    clips: [
      {id: clipA, trackId: videoTrack, name: 'Shot A', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
        sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
      {id: clipB, trackId: videoTrack, name: 'Shot B', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
      {id: clipImage, trackId: videoTrack, name: 'Image', startFrame: 90, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: imageAsset,
        sourceState: 'ready', sequenceSource: {kind: 'media', nodeId: imageNode, segmentGroupId: groupImage}},
      {id: clipAudio, trackId: audioTrack, name: 'Audio', startFrame: 65, durationFrames: 20, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: audioAsset, sourceState: 'ready',
        anchor: {clipId: clipB, offsetFrames: 5}},
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: [{id: cueId, text: '示例', startFrame: 66, durationFrames: 2,
      anchor: {clipId: clipB, offsetFrames: 6}}]},
  };
  const baseline = {version: 1,
    board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionA}, {nodeId: shotB, kind: 'shot', selectedVersionId: null},
      {nodeId: imageNode, kind: 'media', assetId: imageAsset}],
    track: [{nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot', versionMode: 'follow', appliedVersionId: versionA},
      {nodeId: shotB, segmentGroupId: groupB, clipId: clipB, kind: 'shot', versionMode: 'follow', appliedVersionId: null},
      {nodeId: imageNode, segmentGroupId: groupImage, clipId: clipImage, kind: 'media', assetId: imageAsset}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic TS sync', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a'), hasAudio: true,
      hasVideo: true, name: 'Shot A.mp4'});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    store.put('assets', {id: imageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('c')});
    store.put('assets', {id: audioAsset, projectId, mimeType: 'audio/wav', duration: 1, sha256: sha('d')});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: shotB, number: 1, assetId: assetB, sha256: sha('b'), createdAt: at});
    store.put('shots', shot(shotA, 0, versionA, 2));
    store.put('shots', shot(shotB, 1, null, 1));
    store.put('nodes', node(rootId, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(imageNode, 'image', {assetId: imageAsset}));
    store.put('edges', edge(id(80), rootId, shotA));
    store.put('edges', edge(id(81), shotA, shotB));
    store.put('edges', edge(id(82), shotB, imageNode));
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  return store;
}

function envelopeFor(store: ProjectStore, command: SequenceSyncCommand, requestId: string): SequenceEditEnvelope {
  const preview = previewSequenceSync(store, command, {requestId});
  assert.ok('envelope' in preview, 'preview must succeed');
  return preview.envelope;
}
function apply(store: ProjectStore, command: SequenceSyncCommand, requestId = `request-${Math.random().toString(16).slice(2, 10)}`): Result {
  const result = runSequenceSync(store, envelopeFor(store, command, requestId));
  assert.ok(result.ok, `command ${command.kind} failed: ${'code' in result ? result.code : ''}`);
  return result as Result;
}
function attempt(store: ProjectStore, command: SequenceSyncCommand): SequenceEditTransactionFailure {
  const result = runSequenceSync(store, envelopeFor(store, command, `request-${Math.random().toString(16).slice(2, 10)}`));
  assert.equal(result.ok, false);
  return result as SequenceEditTransactionFailure;
}
function state(store: ProjectStore) {
  const projection = readSequenceSyncProjection(store);
  return {timeline: projection,
    clips: store.db.prepare('SELECT data FROM project.timeline_clips ORDER BY startFrame,id').all().map(row => JSON.parse(String(row.data))),
    sync: store.db.prepare('SELECT revision,baseline FROM project.sequence_sync_state WHERE timelineId=?').get(timelineId) as Record<string, any>,
    history: store.db.prepare('SELECT position,revision FROM main.editor_history_state WHERE projectId=?').get(store.projectId) as Record<string, any>,
    entries: Number(store.db.prepare('SELECT count(*) AS n FROM main.editor_history_entries WHERE projectId=?').get(store.projectId)?.n),
    receipts: Number(store.db.prepare('SELECT count(*) AS n FROM main.editor_requests WHERE projectId=?').get(store.projectId)?.n)};
}
const historyCommand = (result: Result, direction: 'undo' | 'redo'): SequenceEditHistoryCommand => ({
  projectId: id(1) === result.receipt.projectId ? result.receipt.projectId : result.receipt.projectId,
  requestId: `history-${Math.random().toString(16).slice(2, 12)}`,
  actionId: result.actionId, direction,
  expected: {position: direction === 'undo' ? result.receipt.history.position : result.receipt.history.position,
    revision: result.receipt.history.revision},
});

/** Insert one occupied audio clip through the same production delta writer the
 * separate-sound plan uses; this keeps the fixture honest (no raw SQL rows). */
function occupyAudioGap(store: ProjectStore, clipId: string): void {
  store.tx(() => {
    // A two-second audio bed covers the whole first clip on the existing track.
    store.put('assets', {id: id(14), projectId: store.projectId, mimeType: 'audio/wav', duration: 2,
      sha256: sha('e'), hasAudio: true, hasVideo: false});
    applySequenceEditTimelineDelta(store, {clips: [{id: clipId, trackId: audioTrack, name: 'Bed', startFrame: 0,
      durationFrames: 60, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
      assetId: id(14), sourceState: 'ready', anchor: {clipId: clipA, offsetFrames: 0}}],
      cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged' as const}});
  });
}
function separatePreview(store: ProjectStore, requestId: string, clipId = clipA) {
  return createFormat5SequenceEditService(store).preview({projectId: store.projectId, requestId,
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId}}}) as
    | {ok: false; code: string; ids?: readonly string[]}
    | {envelope: SequenceEditEnvelope; planDigest: string; warnings: readonly {code: string}[]};
}
function separateCommit(store: ProjectStore, prepared: {envelope: SequenceEditEnvelope; planDigest: string}): Result {
  try {
    const receipt = createFormat5SequenceEditService(store).commit({projectId: store.projectId,
      envelope: prepared.envelope, expectedPlanDigest: prepared.planDigest}) as {actionId: string; operation: string};
    return {ok: true, actionId: receipt.actionId, operation: receipt.operation, patch: null, receipt} as unknown as Result;
  } catch (error) {throw new Error(`separate-sound commit failed: ${JSON.stringify({code: (error as {code?: string}).code, message: (error as Error).message, details: (error as {details?: unknown}).details})}`, {cause: error});}
}

test('a format-5 projection reads the root association, chain order and both sides of the baseline', t => {
  const store = fixture(t);
  const projection = readSequenceSyncProjection(store);
  assert.deepEqual(projection.chainNodeIds, [shotA, shotB, imageNode]);
  assert.equal(projection.syncRevision, 1);
  assert.equal(projection.timelineRevision, 1);
  assert.deepEqual(projection.floatingNodeIds, [rootId]);
  assert.deepEqual(projection.track.map(clip => [clip.nodeId, clip.versionMode, clip.versionId]),
    [[shotA, 'follow', versionA], [shotB, 'follow', null], [imageNode, 'locked', imageAsset]]);
});

test('a placeholder takes the full source length of its first version and downstream/anchored items shift', t => {
  const store = fixture(t);
  const before = state(store);
  const result = apply(store, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  const receipt = result.receipt;
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.operation, 'board.version');
  assert.equal(receipt.syncRevision, before.timeline.syncRevision + 1);
  assert.equal(receipt.timelineRevision, before.timeline.timelineRevision + 1);
  assert.equal(receipt.affected.nodes, 1, 'one shot source row changed');
  assert.equal(receipt.affected.mainTrackClips, 2, 'the placeholder and the downstream image clip');
  assert.ok(receipt.history.undo);
  assert.equal(result.patch.after.timeline.baseline.kind, 'set');
  const restored = applySequenceEditBaselineChange(
    (result.patch.after.timeline.baseline as {kind: 'set'; value: any}).value, result.patch.before.timeline.baseline);
  assert.deepEqual(restored, before.timeline && JSON.parse(String(before.sync.baseline)));
  assert.deepEqual(invertSequenceEditPatch(result.patch).before, result.patch.after);
  const after = state(store);
  const clip = after.clips.find(value => value.id === clipB)!;
  assert.equal(clip.versionId, versionB);
  assert.equal(clip.assetId, assetB);
  assert.equal(clip.sourceInFrame, 0);
  assert.equal(clip.durationFrames, 90);
  assert.equal(clip.sourceState, 'ready');
  const image = after.clips.find(value => value.id === clipImage)!;
  assert.equal(image.startFrame, 150, 'the image after the replaced placeholder moves to the new end');
  const audio = after.clips.find(value => value.id === clipAudio)!;
  assert.equal(audio.startFrame, 65, 'the anchored audio keeps its offset from the owner start');
  const shot = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotB)!;
  assert.equal(JSON.parse(String(shot.data)).selectedVersionId, versionB);
  const sync = JSON.parse(String(after.sync.baseline)) as {board: {nodeId: string; selectedVersionId?: string | null}[];
    track: {clipId: string; appliedVersionId: string | null}[]};
  assert.equal(sync.board.find(item => item.nodeId === shotB)!.selectedVersionId, versionB);
  assert.equal(sync.track.find(item => item.clipId === clipB)!.appliedVersionId, versionB);
  assert.equal(after.entries, 1);
  assert.equal(after.history.position, 1);
});

test('selecting a short version keeps the old applied length and reports SOURCE_TOO_SHORT in the shared receipt', t => {
  const store = fixture(t);
  store.tx(() => {
    store.put('assets', {id: id(14), projectId: store.projectId, mimeType: 'video/mp4', duration: 1, sha256: sha('e')});
    store.put('versions', {id: id(22), projectId: store.projectId, jobId: id(72), shotId: shotA, number: 2, assetId: id(14), sha256: sha('e'), createdAt: at});
  });
  const result = apply(store, {kind: 'board-version', nodeId: shotA, versionId: id(22)});
  assert.equal(result.receipt.warnings?.length, 1);
  assert.equal(result.receipt.warnings?.[0]?.code, 'SOURCE_TOO_SHORT');
  const clip = state(store).clips.find(value => value.id === clipA)!;
  assert.equal(clip.versionId, versionA, 'the applied source must not be replaced');
  assert.equal(clip.durationFrames, 60);
});

test('locking pins one clip while a later board selection still follows the unlocked clips', t => {
  const store = fixture(t);
  const locked = apply(store, {kind: 'clip-version', clipId: clipA, versionId: versionA, mode: 'locked'});
  assert.equal(locked.receipt.operation, 'timeline.clip.version');
  assert.equal(state(store).clips.find(value => value.id === clipA)!.sequenceSource.versionMode, 'locked');
  store.tx(() => {
    store.put('assets', {id: id(15), projectId: store.projectId, mimeType: 'video/mp4', duration: 4, sha256: sha('f')});
    store.put('versions', {id: id(23), projectId: store.projectId, jobId: id(73), shotId: shotA, number: 3, assetId: id(15), sha256: sha('f'), createdAt: at});
  });
  const followed = apply(store, {kind: 'board-version', nodeId: shotA, versionId: id(23)});
  assert.equal(followed.receipt.status, 'applied');
  assert.equal(state(store).clips.find(value => value.id === clipA)!.versionId, versionA);
  const unlocked = apply(store, {kind: 'clip-version', clipId: clipA, versionId: id(23), mode: 'follow'});
  assert.equal(unlocked.receipt.status, 'applied');
  const clip = state(store).clips.find(value => value.id === clipA)!;
  assert.equal(clip.versionId, id(23));
  assert.equal(clip.sequenceSource.versionMode, 'follow');
  assert.equal(clip.durationFrames, 60, 'the clip keeps its cut length when following');
});

test('an exact retry returns the immutable receipt; a changed expectation is rejected; a no-op stores no stack', t => {
  const store = fixture(t);
  const envelope = envelopeFor(store, {kind: 'board-version', nodeId: shotB, versionId: versionB}, 'replay-request-1');
  const first = runSequenceSync(store, envelope);
  assert.ok(first.ok);
  const afterFirst = state(store);
  const retry = runSequenceSync(store, envelope);
  assert.deepEqual(retry, first);
  assert.deepEqual(state(store), afterFirst);
  assert.equal(attempt(store, {kind: 'board-version', nodeId: shotB, versionId: versionB}).code, 'SEQUENCE_EDIT_NOOP');
  assert.equal(state(store).entries, afterFirst.entries, 'no history entry for a no-op');
  // Same request id, different input: immutable receipt is never overwritten.
  const reused = runSequenceSync(store, {...envelope, intents: [envelope.intents[0]!]});
  assert.ok(reused.ok);
  const mismatch = runSequenceSync(store, {...envelope, actionId: id(90)});
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'SEQUENCE_EDIT_REQUEST_REUSED');
});

test('stale revisions and unknown envelopes are rejected atomically before any write', t => {
  const store = fixture(t);
  const envelope = envelopeFor(store, {kind: 'board-version', nodeId: shotB, versionId: versionB}, 'stale-request-1');
  const stale = runSequenceSync(store, {...envelope, baseline: {...envelope.baseline, timelineRevision: envelope.baseline.timelineRevision + 5}});
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'SEQUENCE_EDIT_REVISION_CONFLICT');
  assert.equal(state(store).entries, 0);
  const invalid = runSequenceSync(store, {...envelope, contractVersion: 2 as never});
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, 'SEQUENCE_EDIT_CONTRACT_INVALID');
});

test('one undo and one redo move the shared cursor in a single step', t => {
  const store = fixture(t);
  const before = state(store);
  const result = apply(store, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  const undone = moveSequenceSyncHistory(store, historyCommand(result, 'undo'));
  assert.ok(undone.ok);
  assert.equal(undone.receipt.status, 'applied');
  assert.equal(undone.receipt.history.position, 0);
  const afterUndo = state(store);
  assert.equal(afterUndo.clips.find(value => value.id === clipB)!.sourceState, 'placeholder');
  assert.equal(afterUndo.clips.find(value => value.id === clipImage)!.startFrame, 90);
  assert.equal(JSON.parse(String(store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotB)!.data)).selectedVersionId, null);
  assert.equal(afterUndo.history.position, 0);
  assert.equal(afterUndo.entries, 1);
  assert.equal(before.timeline.syncRevision + 2, afterUndo.timeline.syncRevision);
  const redone = moveSequenceSyncHistory(store, {...historyCommand(result, 'redo'), actionId: result.actionId,
    expected: {position: undone.receipt.history.position, revision: undone.receipt.history.revision}});
  assert.ok(redone.ok);
  const afterRedo = state(store);
  assert.equal(afterRedo.clips.find(value => value.id === clipB)!.versionId, versionB);
  assert.equal(afterRedo.history.position, 1);
});

test('format 3 and 4 stores are untouched and require a format-5 envelope', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-sync-f4-'));
  const store = createProjectStore({projectId: id(90), projectFile: path.join(root, 'project.mioon'), format4: {},
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  assert.throws(() => readSequenceSyncProjection(store), {code: 'SEQUENCE_EDIT_CONTRACT_INVALID'});
  const preview = previewSequenceSync(store, {kind: 'sync-board'}, {requestId: 'format4-request-1'});
  assert.equal('ok' in preview && preview.ok, false);
});

test('the shared history module is the only writer and replay keeps one receipt per request', t => {
  const store = fixture(t);
  const first = apply(store, {kind: 'board-version', nodeId: shotB, versionId: versionB}, 'single-writer-1');
  const second = apply(store, {kind: 'clip-version', clipId: clipB, versionId: versionB, mode: 'locked'}, 'single-writer-2');
  assert.equal(state(store).entries, 2);
  assert.equal(state(store).receipts, 2);
  assert.equal(first.receipt.history.undo?.actionId, first.actionId);
  assert.equal(second.receipt.history.undo?.actionId, second.actionId);
  assert.equal(second.receipt.history.position, 2);
});

test('separate-sound expands one intent into a muted source and an anchored sound-only clip', t => {
  const store = fixture(t);
  const prepared = separatePreview(store, 'separate-one');
  assert.ok(!('ok' in prepared) || prepared.ok !== false, 'separate-sound preview must succeed');
  const {envelope} = prepared as {envelope: SequenceEditEnvelope};
  const operation = envelope.soundIntent!.operation;
  assert.equal(envelope.intents.length, 0);
  assert.equal(operation.kind, 'separate-sound');
  assert.equal(operation.clipId, clipA);
  assert.ok(operation.audioClipId && operation.audioTrackId);
  assert.equal(operation.createdTrackId, undefined, 'the existing audio track has a gap');
  assert.equal(operation.audioTrackId, audioTrack);
  assert.equal(operation.name, 'Shot A · Sound');
  assert.deepEqual(envelope.impact.mainTrackClipIds, [clipA]);
  assert.ok(envelope.impact.otherTrackItemIds.includes(operation.audioClipId!));
  const result = separateCommit(store, prepared as {envelope: SequenceEditEnvelope; planDigest: string});
  assert.ok(result.ok);
  assert.equal(result.operation, 'timeline.clip.separateSound');
  assert.equal(result.receipt.history.position, 1);
  const timeline = readFormat5TimelineRecord(store.db, 'project')!;
  const source = timeline.clips.find(clip => clip.id === clipA)!;
  const sound = timeline.clips.find(clip => clip.id === operation.audioClipId)!;
  assert.equal(source.muted, true);
  assert.equal(source.gain, 1);
  assert.equal(sound.muted, undefined);
  assert.equal(sound.soundOnly, true);
  assert.equal(sound.assetId, assetA);
  assert.equal(sound.trackId, audioTrack);
  assert.equal(sound.startFrame, source.startFrame);
  assert.equal(sound.durationFrames, source.durationFrames);
  assert.equal(sound.sourceInFrame, source.sourceInFrame);
  assert.deepEqual(sound.anchor, {clipId: clipA, offsetFrames: 0});
  assert.equal(sound.name, 'Shot A · Sound');
  assert.equal(state(store).entries, 1);
  // One undo restores the exact previous rows and removes the sound clip.
  const originalSource = {...readFormat5TimelineRecord(store.db, 'project')!.clips.find(clip => clip.id === clipA)!} as Record<string, unknown>;
  delete originalSource.muted;
  const beforeUndo = state(store);
  const undone = moveSequenceSyncHistory(store, historyCommand(result, 'undo'));
  assert.ok(undone.ok);
  const afterUndo = state(store);
  assert.equal(afterUndo.clips.some(clip => clip.id === operation.audioClipId), false);
  assert.equal(afterUndo.history.position, 0);
  assert.equal(readFormat5TimelineRecord(store.db, 'project')!.tracks.find(track => track.id === audioTrack)!.muted, false);
  assert.equal(Object.hasOwn(afterUndo.clips.find(clip => clip.id === clipA) as Record<string, unknown>, 'muted'), false);
  const undoneSource = {...afterUndo.clips.find(clip => clip.id === clipA)!} as Record<string, unknown>;
  assert.deepEqual(undoneSource, originalSource);
  assert.equal(readFormat5TimelineRecord(store.db, 'project')!.tracks.length, 2);
  const redone = moveSequenceSyncHistory(store, {...historyCommand(result, 'redo'), actionId: result.actionId,
    expected: {position: undone.receipt.history.position, revision: undone.receipt.history.revision}});
  assert.ok(redone.ok);
  assert.equal(state(store).clips.find(clip => clip.id === clipA)!.muted, true);
  assert.ok(state(store).clips.some(clip => clip.id === operation.audioClipId && clip.soundOnly === true));
});

test('separate-sound creates one audio track in the same intent when no audio track has a gap', t => {
  const store = fixture(t);
  occupyAudioGap(store, id(35));
  const prepared = separatePreview(store, 'separate-new-track') as {envelope: SequenceEditEnvelope; planDigest: string};
  const operation = prepared.envelope.soundIntent!.operation;
  assert.ok(operation.createdTrackId, 'an occupied audio track forces a new one');
  assert.equal(operation.createdTrackId, operation.audioTrackId);
  assert.deepEqual(prepared.envelope.impact.trackIds, [operation.createdTrackId]);
  const result = separateCommit(store, prepared);
  assert.ok(result.ok);
  assert.equal(result.receipt.affected.tracks, 1);
  const timeline = readFormat5TimelineRecord(store.db, 'project')!;
  assert.equal(timeline.tracks.length, 3);
  const created = timeline.tracks.find(track => track.id === operation.createdTrackId)!;
  assert.equal(created.kind, 'audio');
  assert.equal(created.orderIndex, 2);
  const sound = timeline.clips.find(clip => clip.id === operation.audioClipId)!;
  assert.equal(sound.trackId, operation.createdTrackId);
  // One undo removes both the created track and the sound clip.
  const undone = moveSequenceSyncHistory(store, historyCommand(result, 'undo'));
  assert.ok(undone.ok);
  const afterUndo = readFormat5TimelineRecord(store.db, 'project')!;
  assert.equal(afterUndo.tracks.length, 2);
  assert.equal(afterUndo.clips.some(clip => clip.trackId === operation.createdTrackId), false);
  assert.equal(afterUndo.clips.find(clip => clip.id === clipA)!.muted, undefined);
});

test('the separated audio follows its owner and stays muted after the audio clip is removed', t => {
  const store = fixture(t);
  const prepared = separatePreview(store, 'separate-follow') as {envelope: SequenceEditEnvelope; planDigest: string};
  const operation = prepared.envelope.soundIntent!.operation;
  const result = separateCommit(store, prepared);
  assert.ok(result.ok);
  // Reorder the main track (media segment to the front) so clipA starts at
  // frame 60; the anchored sound clip must move with its owner.

  const move = apply(store, {kind: 'clip-move', clipId: clipImage, beforeClipId: clipA});
  const afterMove = state(store);
  const owner = afterMove.clips.find(clip => clip.id === clipA)!;
  const sound = afterMove.clips.find(clip => clip.id === operation.audioClipId)!;
  assert.equal(owner.startFrame, 60);
  assert.equal(sound.startFrame, owner.startFrame);
  assert.deepEqual(sound.anchor, {clipId: clipA, offsetFrames: 0});
  // Removing the separated audio is a separate action and never unmutes the source.
  const removed = apply(store, {kind: 'clip-remove', clipId: operation.audioClipId!});
  assert.ok(removed.ok);
  assert.equal(state(store).clips.some(clip => clip.id === operation.audioClipId), false);
  assert.equal(state(store).clips.find(clip => clip.id === clipA)!.muted, true);
});

test('separate-sound refuses silent sources, placeholders, audio clips and format 4', t => {
  const store = fixture(t);
  const service = createFormat5SequenceEditService(store);
  const preview = (clipId: string) => service.preview({projectId: store.projectId, requestId: `separate-bad-${clipId}`,
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId}}}) as {ok: false; code: string};
  assert.equal(preview(clipB).code, 'SEQUENCE_EDIT_SOUND_INVALID');       // placeholder
  assert.equal(preview(clipImage).code, 'SEQUENCE_EDIT_SOUND_INVALID');   // image
  assert.equal(preview(clipAudio).code, 'SEQUENCE_EDIT_SOUND_INVALID');   // audio-track clip
  assert.equal(state(store).entries, 0);
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-sound-f4-'));
  const format4 = createProjectStore({projectId: id(91), projectFile: path.join(root, 'project.mioon'), format4: {},
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {format4.close(); rmSync(root, {recursive: true, force: true});});
  assert.throws(() => createFormat5SequenceEditService(format4).preview({projectId: id(91), requestId: 'separate-format4',
    soundIntent: {side: 'timeline', operation: {kind: 'separate-sound', clipId: clipA}}}), {code: 'SEQUENCE_EDIT_CONTRACT_INVALID'});
});
