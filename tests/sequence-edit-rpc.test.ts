import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createFormat5ExportTicket} from '../packages/business/src/format5-timeline-export.ts';
import {operationEffects} from '../packages/contracts/src/operation-effects.ts';
import {
  sequenceCommitRequestSchema, sequencePreviewRequestSchema, sequenceHistoryGetRequestSchema,
  sequenceEditingSchemas, sequenceEditIntentPayloadSchema,
} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import {schemas} from '../packages/contracts/src/index.ts';
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

function fixture(t: test.TestContext): ProjectStore {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-tsb-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), format5: true,
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


const service = (store: ProjectStore) => createFormat5SequenceEditService(store);
const projectId = (store: ProjectStore): string => store.projectId;

test('sequence RPC schemas accept one bounded command and reject extra fields', () => {
  const split = sequenceSyncIntent({kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: id(91)});
  assert.equal(sequenceEditIntentPayloadSchema.safeParse(split).success, true);
  assert.equal(sequenceEditIntentPayloadSchema.safeParse({...split, extra: true}).success, false);
  const preview = {projectId: id(1), requestId: 'preview-request-1', intents: [split]};
  assert.equal(sequencePreviewRequestSchema.safeParse(preview).success, true);
  assert.equal(sequencePreviewRequestSchema.safeParse({...preview, extra: 1}).success, false);
  assert.equal(sequenceHistoryGetRequestSchema.safeParse({projectId: id(1)}).success, true);
  assert.equal(sequenceEditingSchemas['sequence.undo'].safeParse({projectId: id(1), requestId: 'undo-request-1',
    actionId: id(20), expected: {position: 1, revision: 2}}).success, true);
  for (const operation of ['sequence.preview', 'sequence.commit', 'sequence.history.get', 'sequence.undo', 'sequence.redo']) {
    assert.ok(operation in schemas, `${operation} missing from RPC schemas`);
    assert.ok(operation in operationEffects, `${operation} missing from operation effects`);
  }
});

test('preview, commit, history and undo/redo share the same receipt and history row', t => {
  const store = fixture(t);
  const edit = service(store);
  const command = {kind: 'clip-split', clipId: clipA, offsetFrames: 24, rightClipId: id(91)} as const;
  const preview = edit.preview({projectId: projectId(store), requestId: 'ui-preview-1',
    intents: [sequenceSyncIntent(command)]}) as any;
  assert.ok(preview.envelope);
  assert.equal(typeof preview.planDigest, 'string');
  assert.equal(sequenceCommitRequestSchema.safeParse({projectId: projectId(store), envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}).success, true);
  const committed = edit.commit({projectId: projectId(store), envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest}) as any;
  assert.equal(committed.status, 'applied');
  const history = edit.history({projectId: projectId(store)}) as any;
  assert.equal(history.position, 1);
  assert.equal(history.undo?.actionId, committed.actionId);
  assert.equal(history.redo, null);
  const undone = edit.undo({projectId: projectId(store), requestId: 'ui-undo-1', actionId: committed.actionId,
    expected: {position: history.position, revision: history.revision}}) as any;
  assert.equal(undone.status, 'applied');
  const afterUndo = edit.history({projectId: projectId(store)}) as any;
  assert.equal(afterUndo.position, 0);
  assert.equal(afterUndo.redo?.actionId, committed.actionId);
  const redone = edit.redo({projectId: projectId(store), requestId: 'ui-redo-1', actionId: committed.actionId,
    expected: {position: afterUndo.position, revision: afterUndo.revision}}) as any;
  assert.equal(redone.status, 'applied');
});

test('format-5 export ticket reports a placeholder in the selected range', t => {
  const store = fixture(t);
  const ticket = createFormat5ExportTicket(store);
  assert.ok(ticket.blockers.some(blocker => blocker.code === 'PLACEHOLDER_CLIP'));
  const firstOnly = createFormat5ExportTicket(store, {startFrame: 0, endFrame: 60});
  assert.equal(firstOnly.blockers.some(blocker => blocker.code === 'PLACEHOLDER_CLIP'), false);
});
