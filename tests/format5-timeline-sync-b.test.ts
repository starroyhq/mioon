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
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import type {
  SequenceEditCommitResult, SequenceEditEnvelope, SequenceEditHistoryCommand, SequenceEditTransactionFailure,
} from '../packages/contracts/src/sequence-edit.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `50000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const rootId = id(2), shotA = id(3), shotB = id(4), imageNode = id(5), freeImage = id(6), videoTrack2 = id(62);
const videoTrack = id(60), audioTrack = id(61);
const assetA = id(10), assetB = id(11), imageAsset = id(12), audioAsset = id(13), freeImageAsset = id(14);
const versionA = id(20), versionB = id(21), jobA = id(70), jobB = id(71);
const clipA = id(30), clipB = id(31), clipImage = id(32), clipAudio = id(33), clipAudio2 = id(35), cueId = id(34);
const groupA = id(40), groupB = id(41), groupImage = id(42);
const timelineId = id(50);
const sha = (letter: string): string => letter.repeat(64);
type Result = SequenceEditCommitResult;

function fixture(t: test.TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-tsb-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 150,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: videoTrack2, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false}],
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
      {id: clipAudio2, trackId: audioTrack, name: 'Audio 2', startFrame: 120, durationFrames: 1, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: audioAsset, sourceState: 'ready',
        anchor: {clipId: clipImage, offsetFrames: 30}},
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
    store.put('projects', {id: projectId, name: 'Synthetic TSb', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    store.put('assets', {id: imageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('c')});
    store.put('assets', {id: audioAsset, projectId, mimeType: 'audio/wav', duration: 1, sha256: sha('d')});
    store.put('assets', {id: freeImageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('e')});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: shotB, number: 1, assetId: assetB, sha256: sha('b'), createdAt: at});
    store.put('shots', {id: shotA, projectId, orderIndex: 0, selectedVersionId: versionA, duration: 2, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotB, projectId, orderIndex: 1, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at});
    store.put('nodes', node(rootId, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(imageNode, 'image', {assetId: imageAsset}));
    store.put('nodes', node(freeImage, 'image', {assetId: freeImageAsset}));
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: rootId, target: shotA, createdAt: at});
    store.put('edges', {id: id(81), projectId, kind: 'sequence', source: shotA, target: shotB, createdAt: at});
    store.put('edges', {id: id(82), projectId, kind: 'sequence', source: shotB, target: imageNode, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  return store;
}

interface Prepared {readonly envelope: SequenceEditEnvelope; readonly planDigest: string}
function prepare(store: ProjectStore, command: SequenceSyncCommand, requestId = `tsb-${Math.random().toString(16).slice(2, 10)}`): Prepared {
  const preview = previewSequenceSync(store, command, {requestId});
  assert.ok('envelope' in preview, `preview failed: ${'code' in preview ? preview.code : ''}`);
  return preview;
}
function apply(store: ProjectStore, command: SequenceSyncCommand, requestId?: string): {result: Result; prepared: Prepared} {
  const prepared = prepare(store, command, requestId);
  const result = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: prepared.planDigest});
  assert.ok(result.ok, `command ${command.kind} failed: ${'code' in result ? result.code : ''}`);
  return {result: result as Result, prepared};
}
function attempt(store: ProjectStore, command: SequenceSyncCommand): SequenceEditTransactionFailure {
  const prepared = prepare(store, command);
  const result = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: prepared.planDigest});
  assert.equal(result.ok, false);
  return result as SequenceEditTransactionFailure;
}
function state(store: ProjectStore) {
  return {
    projection: readSequenceSyncProjection(store),
    clips: store.db.prepare('SELECT data FROM project.timeline_clips ORDER BY startFrame,id').all().map(row => JSON.parse(String(row.data))),
    edges: store.db.prepare("SELECT data FROM project.edges WHERE archivedAt IS NULL AND json_extract(data,'$.kind')='sequence' ORDER BY id").all().map(row => JSON.parse(String(row.data))),
    shots: store.db.prepare('SELECT data FROM project.shots ORDER BY id').all().map(row => JSON.parse(String(row.data))),
    nodes: store.db.prepare('SELECT data FROM project.nodes ORDER BY id').all().map(row => JSON.parse(String(row.data))),
    adoptions: store.db.prepare('SELECT shotId,versionId FROM project.shot_version_adoptions ORDER BY shotId,versionId').all(),
    history: store.db.prepare('SELECT position,revision FROM main.editor_history_state WHERE projectId=?').get(store.projectId) as Record<string, any>,
    entries: Number(store.db.prepare('SELECT count(*) AS n FROM main.editor_history_entries WHERE projectId=?').get(store.projectId)?.n),
  };
}
function undo(store: ProjectStore, result: Result): Result {
  const command: SequenceEditHistoryCommand = {projectId: result.receipt.projectId,
    requestId: `history-${Math.random().toString(16).slice(2, 12)}`, actionId: result.actionId, direction: 'undo',
    expected: {position: result.receipt.history.position, revision: result.receipt.history.revision}};
  const moved = moveSequenceSyncHistory(store, command);
  assert.ok(moved.ok, `undo failed: ${'code' in moved ? moved.code : ''}`);
  return moved as Result;
}

test('split keeps the left id, allocates the right id and rewires the chain', t => {
  const store = fixture(t);
  const before = state(store);
  const {result} = apply(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: id(90)});
  assert.equal(result.receipt.affected.mainTrackClips, 2);
  const after = state(store);
  const left = after.clips.find(clip => clip.id === clipA)!;
  const right = after.clips.find(clip => clip.id === id(90))!;
  assert.equal(left.durationFrames, 24);
  assert.equal(left.sequenceSource.segmentGroupId, left.sequenceSource.segmentGroupId);
  assert.equal(right.startFrame, 24);
  assert.equal(right.durationFrames, 36);
  assert.equal(right.sourceInFrame, 24);
  assert.equal(right.sequenceSource.segmentGroupId, left.sequenceSource.segmentGroupId);
  assert.deepEqual([...new Set(after.clips.filter(clip => clip.trackId === videoTrack).map(clip => clip.sequenceSource.nodeId))],
    [shotA, shotB, imageNode]);
  const undone = undo(store, result);
  assert.equal(undone.receipt.status, 'applied');
  assert.deepEqual(state(store).clips.map(clip => clip.id).sort(), before.clips.map(clip => clip.id).sort());
});

test('removing a middle segment compacts the track and detaches the orphaned anchors', t => {
  const store = fixture(t);
  const {result} = apply(store, {kind: 'clip-remove', clipId: clipB});
  const after = state(store);
  assert.equal(after.clips.filter(clip => clip.trackId === videoTrack).map(clip => clip.id).join(','), [clipA, clipImage].join(','));
  assert.equal(after.clips.find(clip => clip.id === clipImage)!.startFrame, 60);
  assert.equal(after.clips.find(clip => clip.id === clipAudio)!.anchor, null, 'the deleted owner detaches the anchor in place');
  assert.equal(after.clips.find(clip => clip.id === clipAudio)!.startFrame, 65);
  assert.equal(after.clips.find(clip => clip.id === clipAudio2)!.startFrame, 90);
  assert.ok(!after.edges.some(edge => edge.target === shotB || edge.source === shotB));
  undo(store, result);
  assert.deepEqual(state(store).clips.map(clip => clip.id).sort(), [clipA, clipAudio, clipAudio2, clipB, clipImage].sort());
});

test('an anchor overlap after compaction rejects the whole action with affected ids', t => {
  const store = fixture(t);
  store.tx(() => store.db.prepare("UPDATE project.timeline_clips SET data=json_set(data,'$.startFrame',90,'$.durationFrames',20,'$.anchor.offsetFrames',0) WHERE id=?")
    .run(clipAudio2));
  const before = state(store);
  const preview = previewSequenceSync(store, {kind: 'clip-remove', clipId: clipB}, {requestId: 'overlap-request-1'});
  assert.ok(!('envelope' in preview));
  assert.equal(preview.code, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
  assert.deepEqual([...preview.ids].sort(), [clipAudio, clipAudio2].sort());
  assert.deepEqual(state(store).clips, before.clips, 'nothing is written on an anchor conflict');
});

test('a cross-track drop preview reports all blockers at their compacted positions', t => {
  const store = fixture(t);
  const firstBlocker = id(36), secondBlocker = id(37), touchingClip = id(38);
  store.tx(() => applySequenceEditTimelineDelta(store, {
    clips: [
      {id: firstBlocker, startFrame: 65, anchor: {clipId: clipB, offsetFrames: 5}},
      {id: secondBlocker, startFrame: 95, anchor: {clipId: clipImage, offsetFrames: 5}},
      {id: touchingClip, startFrame: 120, anchor: {clipId: clipImage, offsetFrames: 30}},
    ].map(clip => ({...clip, trackId: videoTrack2, name: 'Overlay', durationFrames: 10, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: imageAsset, sourceState: 'ready'})),
    cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'},
  }));
  const service = createFormat5SequenceEditService(store);
  service.history({projectId: store.projectId});
  const before = state(store);
  const previewAt = (startFrame: number) => service.preview({projectId: store.projectId,
    requestId: `overlap-drop-${startFrame}`, intents: [sequenceSyncIntent({
      kind: 'clip-move-off-track', clipId: clipA, trackId: videoTrack2, startFrame,
    })]});
  // Removing clip A from the main track pulls the overlays 60 frames earlier.
  // Both blockers enter the previously empty drop range [0, 60).
  assert.deepEqual(previewAt(0), {ok: false, code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT',
    ids: [firstBlocker, secondBlocker], message: '随主轨一起移动的片段或字幕放不下，请调整它们的位置。',
    messageKey: 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT'});
  assert.equal(typeof (previewAt(70) as Prepared).planDigest, 'string', 'a drop touching an overlay endpoint is allowed');
  assert.deepEqual(state(store), before);
});

test('trimming shortens the owner, moves the suffix and detaches an out-of-range anchor in place', t => {
  const store = fixture(t);
  const {result} = apply(store, {kind: 'clip-trim', clipId: clipB, durationFrames: 4});
  const after = state(store);
  assert.equal(after.clips.find(clip => clip.id === clipB)!.durationFrames, 4);
  assert.equal(after.clips.find(clip => clip.id === clipImage)!.startFrame, 64);
  assert.equal(after.clips.find(clip => clip.id === clipAudio2)!.startFrame, 94);
  const audio = after.clips.find(clip => clip.id === clipAudio)!;
  assert.equal(audio.anchor, null, 'offset 5 is outside the 4-frame owner');
  assert.equal(audio.startFrame, 65);
  undo(store, result);
  assert.equal(state(store).clips.find(clip => clip.id === clipB)!.durationFrames, 30);
});

test('reordering a media segment rewires the chain and moves the anchored suffix', t => {
  const store = fixture(t);
  const {result} = apply(store, {kind: 'clip-move', clipId: clipImage, beforeClipId: clipA});
  const after = state(store);
  assert.deepEqual(after.clips.filter(clip => clip.trackId === videoTrack).map(clip => clip.id),
    [clipImage, clipA, clipB]);
  assert.equal(after.clips.find(clip => clip.id === clipA)!.startFrame, 60);
  assert.equal(after.clips.find(clip => clip.id === clipB)!.startFrame, 120);
  assert.deepEqual(after.edges.map(edge => `${edge.source}>${edge.target}`).sort(),
    [`${rootId}>${imageNode}`, `${imageNode}>${shotA}`, `${shotA}>${shotB}`].sort());
  undo(store, result);
  assert.deepEqual(state(store).edges.map(edge => `${edge.source}>${edge.target}`).sort(),
    [`${rootId}>${shotA}`, `${shotA}>${shotB}`, `${shotB}>${imageNode}`].sort());
});

test('moving a segment off the main track gives it an explicit anchor and keeps other items valid', t => {
  const store = fixture(t);
  const {result} = apply(store, {kind: 'clip-move-off-track', clipId: clipImage, trackId: videoTrack2, startFrame: 10});
  const after = state(store);
  const moved = after.clips.find(clip => clip.id === clipImage)!;
  assert.equal(moved.trackId, videoTrack2);
  assert.equal(moved.startFrame, 10);
  assert.ok(moved.anchor && moved.anchor.clipId === clipA && moved.anchor.offsetFrames === 10);
  assert.deepEqual(after.clips.filter(clip => clip.trackId === videoTrack).map(clip => clip.id), [clipA, clipB]);
  undo(store, result);
  assert.equal(state(store).clips.find(clip => clip.id === clipImage)!.trackId, videoTrack);
});

test('adding a free media node appends a new main-track group and its chain edge', t => {
  const store = fixture(t);
  const newClip = id(95);
  const {result} = apply(store, {kind: 'clip-add', clip: {id: newClip, nodeId: freeImage, segmentGroupId: id(43),
    startFrame: 150, durationFrames: 45, sourceInFrame: 0}, beforeClipId: null, nodeKind: 'image'});
  const after = state(store);
  const clip = after.clips.find(value => value.id === newClip)!;
  assert.equal(clip.sequenceSource.nodeId, freeImage);
  assert.deepEqual(after.clips.filter(value => value.trackId === videoTrack).map(value => value.sequenceSource.nodeId),
    [shotA, shotB, imageNode, freeImage]);
  assert.ok(after.edges.some(edge => edge.target === freeImage));
  undo(store, result);
  assert.equal(state(store).clips.some(value => value.id === newClip), false);
});

test('copy-and-move split piece carries a new shot, an adoption and the same allocation', t => {
  const store = fixture(t);
  const split = apply(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: id(91)}).result;
  const newShot = id(92);
  const command: SequenceSyncCommand = {kind: 'clip-move', clipId: id(91), beforeClipId: null, copyNodeId: newShot};
  const prepared = prepare(store, command, 'copy-move-request-1');
  assert.ok(prepared.envelope.allocation.nodes.some(item => item.fromNodeId === shotA && item.nodeId === newShot));
  const first = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: prepared.planDigest});
  assert.ok(first.ok, `copy move failed: ${'code' in first ? first.code : ''}`);
  const after = state(store);
  assert.ok(after.shots.some(shot => shot.id === newShot));
  assert.ok(after.adoptions.some(row => row.shotId === newShot && row.versionId === versionA));
  assert.equal(after.clips.filter(clip => clip.trackId === videoTrack).at(-1)!.sequenceSource.nodeId, newShot);
  const redo = undo(store, first as Result);
  assert.ok(redo.ok);
  assert.equal(state(store).shots.some(shot => shot.id === newShot), false);
  assert.equal(state(store).adoptions.some(row => row.shotId === newShot), false);
  assert.ok(split);
});

test('a changed plan digest or a reused request with different allocation is rejected', t => {
  const store = fixture(t);
  const prepared = prepare(store, {kind: 'clip-split', clipId: clipA, offsetFrames: 10, rightClipId: id(93)}, 'digest-request-1');
  const rejected = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: '0'.repeat(64)});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'SEQUENCE_EDIT_PATCH_INVALID');
  const applied = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: prepared.planDigest});
  assert.ok(applied.ok);
  const replay = runSequenceSync(store, prepared.envelope, {expectedPlanDigest: prepared.planDigest});
  assert.deepEqual(replay, applied);
});
