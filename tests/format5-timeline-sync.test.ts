import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {readSequenceSyncProjection, runSequenceSync, undoSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import type {SequenceSyncCommand} from '../packages/contracts/src/sequence-sync.ts';

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

function fixture(t: test.TestContext): {store: ProjectStore; timeline: Record<string, unknown>} {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-sync-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const timestamp = at;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: timestamp, ...extra});
  const shot = (shotId: string, orderIndex: number, selectedVersionId: string | null, duration: number) =>
    ({id: shotId, projectId, orderIndex, selectedVersionId, duration, createdAt: timestamp, updatedAt: timestamp});
  const edge = (edgeId: string, source: string, target: string) =>
    ({id: edgeId, projectId, kind: 'sequence', source, target, createdAt: timestamp});
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 150,
    createdAt: timestamp, updatedAt: timestamp,
    mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
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
    store.put('projects', {id: projectId, name: 'Synthetic TS sync', createdAt: timestamp, updatedAt: timestamp, revision: 1});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    store.put('assets', {id: imageAsset, projectId, mimeType: 'image/png', duration: null, sha256: sha('c')});
    store.put('assets', {id: audioAsset, projectId, mimeType: 'audio/wav', duration: 1, sha256: sha('d')});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: timestamp});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: shotB, number: 1, assetId: assetB, sha256: sha('b'), createdAt: timestamp});
    store.put('shots', shot(shotA, 0, versionA, 2));
    store.put('shots', shot(shotB, 1, null, 1));
    store.put('nodes', node(rootId, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(imageNode, 'image', {assetId: imageAsset}));
    store.put('edges', edge(id(80), rootId, shotA));
    store.put('edges', edge(id(81), shotA, shotB));
    store.put('edges', edge(id(82), shotB, imageNode));
    store.put('timelines', {...timeline, subtitles: {...timeline.subtitles, cues: timeline.subtitles.cues}});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  return {store, timeline};
}

function envelopeFor(store: ProjectStore): {syncRevision: number; timelineRevision: number} {
  const projection = readSequenceSyncProjection(store);
  return {syncRevision: projection.syncRevision, timelineRevision: projection.timelineRevision};
}
function requestId(seed: string): string { return `format5-sync-${seed}-${Math.random().toString(16).slice(2, 10)}`; }

function run(store: ProjectStore, command: SequenceSyncCommand, expected = envelopeFor(store)) {
  return runSequenceSync(store, {requestId: requestId(command.kind), expected}, command);
}
function state(store: ProjectStore) {
  const timeline = readSequenceSyncProjection(store);
  const clips = store.db.prepare('SELECT data FROM project.timeline_clips ORDER BY startFrame,id').all().map(row => JSON.parse(String(row.data)));
  return {timeline, clips,
    sync: store.db.prepare('SELECT revision,baseline FROM project.sequence_sync_state WHERE timelineId=?').get(timelineId),
    history: store.db.prepare('SELECT position,revision FROM main.editor_history_state WHERE projectId=?').get(store.projectId),
    entries: store.db.prepare('SELECT count(*) AS n FROM main.editor_history_entries WHERE projectId=?').get(store.projectId)?.n,
    receipts: store.db.prepare('SELECT count(*) AS n FROM main.editor_requests WHERE projectId=?').get(store.projectId)?.n};
}

test('a format-5 projection reads the root association, chain order and both sides of the baseline', t => {
  const {store} = fixture(t);
  const projection = readSequenceSyncProjection(store);
  assert.deepEqual(projection.chainNodeIds, [shotA, shotB, imageNode]);
  assert.equal(projection.syncRevision, 1);
  assert.equal(projection.timelineRevision, 1);
  assert.deepEqual(projection.floatingNodeIds, [rootId]);
  assert.deepEqual(projection.track.map(clip => [clip.nodeId, clip.versionMode, clip.versionId]),
    [[shotA, 'follow', versionA], [shotB, 'follow', null], [imageNode, 'locked', imageAsset]]);
});

test('a placeholder takes the full source length of its first version and downstream/anchored items shift', t => {
  const {store} = fixture(t);
  const before = state(store);
  const receipt = run(store, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  assert.equal(receipt.changed, true);
  assert.equal(receipt.operation, 'board-version');
  assert.equal(receipt.syncRevision, before.timeline.syncRevision + 1);
  assert.equal(receipt.timelineRevision, before.timeline.timelineRevision + 1);
  assert.deepEqual(receipt.clips, {created: [], updated: [clipB, clipImage].sort(), removed: []});
  assert.ok(receipt.history);
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
  const sync = JSON.parse(String(after.sync!.baseline)) as {board: {nodeId: string; selectedVersionId?: string | null}[];
    track: {clipId: string; appliedVersionId: string | null}[]};
  assert.equal(sync.board.find(item => item.nodeId === shotB)!.selectedVersionId, versionB);
  assert.equal(sync.track.find(item => item.clipId === clipB)!.appliedVersionId, versionB);
  assert.equal(after.entries, 1);
  assert.equal(after.history!.position, 1);
});

test('selecting a short version keeps the old applied length and reports SOURCE_TOO_SHORT', t => {
  const {store} = fixture(t);
  // A new version whose frame count cannot cover the existing 60-frame clip.
  store.tx(() => {
    store.put('assets', {id: id(14), projectId: store.projectId, mimeType: 'video/mp4', duration: 1, sha256: sha('e')});
    store.put('versions', {id: id(22), projectId: store.projectId, jobId: id(72), shotId: shotA, number: 2, assetId: id(14), sha256: sha('e'), createdAt: at});
  });
  const receipt = run(store, {kind: 'board-version', nodeId: shotA, versionId: id(22)});
  assert.equal(receipt.changed, true);
  assert.equal(receipt.warnings.length, 1);
  assert.equal(receipt.warnings[0]!.code, 'SOURCE_TOO_SHORT');
  const clip = state(store).clips.find(value => value.id === clipA)!;
  assert.equal(clip.versionId, versionA, 'the applied source must not be replaced');
  assert.equal(clip.durationFrames, 60);
});

test('locking pins one clip while a later board selection still follows the unlocked clips', t => {
  const {store} = fixture(t);
  const locked = run(store, {kind: 'clip-version', clipId: clipA, versionId: versionA, mode: 'locked'});
  assert.equal(locked.changed, true);
  assert.equal(state(store).clips.find(value => value.id === clipA)!.sequenceSource.versionMode, 'locked');
  // A new selected version on the board updates the board projection but not the locked clip.
  store.tx(() => {
    store.put('assets', {id: id(15), projectId: store.projectId, mimeType: 'video/mp4', duration: 4, sha256: sha('f')});
    store.put('versions', {id: id(23), projectId: store.projectId, jobId: id(73), shotId: shotA, number: 3, assetId: id(15), sha256: sha('f'), createdAt: at});
  });
  const followed = run(store, {kind: 'board-version', nodeId: shotA, versionId: id(23)});
  assert.equal(followed.changed, true);
  assert.equal(state(store).clips.find(value => value.id === clipA)!.versionId, versionA);
  // Unlocking follows the newly selected version.
  const unlocked = run(store, {kind: 'clip-version', clipId: clipA, versionId: null, mode: 'follow'});
  assert.equal(unlocked.changed, true);
  const clip = state(store).clips.find(value => value.id === clipA)!;
  assert.equal(clip.versionId, id(23));
  assert.equal(clip.sequenceSource.versionMode, 'follow');
  assert.equal(clip.durationFrames, 60, 'the clip keeps its cut length when following');
});

test('an exact retry returns the immutable receipt; a changed expectation is rejected; a no-op writes no stack', t => {
  const {store} = fixture(t);
  const expected = envelopeFor(store);
  const request = requestId('replay');
  const first = runSequenceSync(store, {requestId: request, expected}, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  const revisions = state(store);
  const retry = runSequenceSync(store, {requestId: request, expected}, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  assert.deepEqual(retry, first);
  assert.deepEqual(state(store), revisions);
  assert.throws(() => runSequenceSync(store, {requestId: request, expected}, {kind: 'sync-board'}),
    {code: 'SEQUENCE_SYNC_REQUEST_CONFLICT'});
  // Re-selecting the already selected version is a true no-op.
  const noopExpected = envelopeFor(store);
  const noop = run(store, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  assert.equal(noop.changed, false);
  assert.equal(noop.history, null);
  assert.equal(noop.syncRevision, noopExpected.syncRevision);
  assert.equal(noop.timelineRevision, noopExpected.timelineRevision);
  assert.equal(state(store).entries, revisions.entries, 'no history entry for a no-op');
});

test('clearing the board selection keeps the applied clip and records the new baseline', t => {
  const {store} = fixture(t);
  const receipt = run(store, {kind: 'board-version', nodeId: shotA, versionId: null});
  assert.equal(receipt.changed, true);
  const clip = state(store).clips.find(value => value.id === clipA)!;
  assert.equal(clip.versionId, versionA, 'clearing selection does not throw away the applied source');
  const board = JSON.parse(String(state(store).sync!.baseline)).board as {nodeId: string; selectedVersionId: string | null}[];
  assert.equal(board.find(item => item.nodeId === shotA)!.selectedVersionId, null);
  assert.equal(board.find(item => item.nodeId === shotB)!.selectedVersionId, null);
});

test('stale revisions are rejected atomically before any write', t => {
  const {store} = fixture(t);
  const before = state(store);
  assert.throws(() => runSequenceSync(store, {requestId: requestId('stale'), expected: {syncRevision: 0, timelineRevision: 0}},
    {kind: 'board-version', nodeId: shotB, versionId: versionB}), {code: 'SEQUENCE_SYNC_STALE_REVISION'});
  assert.deepEqual(state(store), before);
});

test('one command undoes the version change in a single inverse action', t => {
  const {store} = fixture(t);
  const before = state(store);
  const receipt = run(store, {kind: 'board-version', nodeId: shotB, versionId: versionB});
  const sync = state(store);
  const undone = undoSequenceSync(store, {requestId: requestId('undo'), expected: envelopeFor(store), actionId: receipt.actionId});
  assert.equal(undone.changed, true);
  assert.equal(undone.syncRevision, envelopeForAfter(sync) + 1);
  const after = state(store);
  assert.equal(after.clips.find(value => value.id === clipB)!.sourceState, 'placeholder');
  assert.equal(after.clips.find(value => value.id === clipB)!.durationFrames, 30);
  assert.equal(after.clips.find(value => value.id === clipImage)!.startFrame, 90);
  assert.equal(JSON.parse(String(store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(shotB)!.data)).selectedVersionId, null);
  assert.equal(after.history!.position, 0);
  assert.equal(after.entries, 1);
  assert.equal(before.timeline.syncRevision + 2, after.timeline.syncRevision);
});

function envelopeForAfter(snapshot: ReturnType<typeof state>): number { return snapshot.timeline.syncRevision; }

test('format 3 and 4 stores are untouched and require the explicit format-5 entry', t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-sync-f4-'));
  const store = createProjectStore({projectId: id(90), projectFile: path.join(root, 'project.mioon'), format4: {},
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  assert.throws(() => readSequenceSyncProjection(store), {code: 'SEQUENCE_SYNC_FORMAT_REQUIRED'});
  assert.throws(() => runSequenceSync(store, {requestId: requestId('f4'), expected: {syncRevision: 0, timelineRevision: 0}},
    {kind: 'sync-board'}), {code: 'SEQUENCE_SYNC_FORMAT_REQUIRED'});
});
