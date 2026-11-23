import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {previewMioSequenceAction, commitMioSequenceAction, applyMioSequenceUndo, prepareMioSequenceUndo} from '../packages/business/src/format5-mio-sequence.ts';
import {readSequenceEditHistory} from '../packages/business/src/sequence-edit.ts';
import {referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (n: number): string => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), root = id(2), shot = id(3), video = id(60), v2 = id(61), audio = id(62);
const asset = id(10), version = id(20), job = id(21), mainClip = id(30), subClip = id(31), timelineId = id(50);
const groupMain = id(40), groupSub = id(41);
const bytes = mp4HeaderFixture('synthetic-scene-source');
const sha = createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const detection = async (input: any) => {input.beforeSpawn(input.signal); return ({profileId: 'scene-cuts-v1', fps: 30, frameCount: 60,
  options: input.options, cuts: [{frame: 20, score: 0.5}, {frame: 45, score: 0.5}], segments: [],
  sourceHash: input.asset.sha256, analysis: {width: 32, height: 32, decodedFrames: 60}});};

test('format 5 scene split: all tracks, skips, anchor/group, undo and stale result', async t => {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format5-scene-'));
  const store = createProjectStore({projectId, projectFile: path.join(rootDir, 'project.mioon'), targetFormat: 5 as const,
    locate: () => ({localDir: path.join(rootDir, 'records'), cacheDir: path.join(rootDir, 'cache'), tempDir: path.join(rootDir, 'temp')})});
    const library = openAppLibrary({dataDir: path.join(rootDir, 'app')});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {}),
    sceneOptions: {detect: detection as never}});
  t.after(async () => {await services.drain(); library.close(); store.close(); rmSync(rootDir, {recursive: true, force: true});});
  mkdirSync(path.join(rootDir, 'media'), {recursive: true});
  writeFileSync(path.join(rootDir, 'media/source.mp4'), bytes);
  const sourcePath = path.join(rootDir, 'media/source.mp4');
  const published = await referenceForPublishedMedia(store, sourcePath, {sha256: sha});
  const reference = published.reference;
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: video, sequenceNodeId: root},
    tracks: [{id: video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: v2, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
      {id: audio, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false}],
    clips: [
      {id: mainClip, trackId: video, name: 'Main', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: asset, versionId: version, shotId: shot,
        sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shot, segmentGroupId: groupMain, versionMode: 'follow'}},
      {id: subClip, trackId: v2, name: 'Sub', startFrame: 0, durationFrames: 50, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: asset, versionId: version, jobId: job, shotId: shot,
        sourceState: 'ready',
        fadeInFrames: 30, anchor: {clipId: mainClip, offsetFrames: 0}},
    ]};
  const baseline = {version: 1, board: [{nodeId: shot, kind: 'shot', selectedVersionId: version}],
    track: [{nodeId: shot, segmentGroupId: groupMain, clipId: mainClip, kind: 'shot', versionMode: 'follow', appliedVersionId: version}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Scene split fixture', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: asset, projectId, name: 'source.mp4', mimeType: 'video/mp4', duration: 2, sha256: sha,
      sizeBytes: bytes.length, reference, referenceRevision: 1});
    store.put('jobs', {id: job, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock',
      shotId: shot, versionId: version, createdAt: at, updatedAt: at});
    store.put('versions', {id: version, projectId, jobId: job, shotId: shot, number: 1, assetId: asset, sha256: sha, createdAt: at});
    store.put('shots', {id: shot, projectId, title: 'Shot', orderIndex: 0, selectedVersionId: version, duration: 2,
      referenceAssetIds: [], aspectRatio: '9:16', parameters: {}, position: {x: 0, y: 0}, createdAt: at, updatedAt: at});
    store.put('nodes', {id: root, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: root, target: shot, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, root, 1, JSON.stringify(baseline));
  });
  const ack = await services.call('scene.detect', {projectId, sourceAssetId: asset, sourceHash: sha, requestId: randomUUID()}) as any;
  let resultId = '';
  for (let i = 0; i < 500; i++) {
    const value = services.handlers['scene.task.get']!({projectId, taskId: ack.id} as never) as any;
    if (value?.state === 'succeeded' && value.result) {resultId = String(value.result.id); break;}
    await delay(5);
  }
  assert.ok(resultId);
  const plan = previewMioSequenceAction(store, projectId, 'scene-split-preview', {kind: 'split-at-scenes', assetId: asset, resultId});
  const previewPairs = plan.envelope.allocation.splitClips;
  const receipt = commitMioSequenceAction(store, plan);
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.sceneSplit?.split.length, 2);
  assert.equal(receipt.sceneSplit?.skipped.length, 1);
  assert.deepEqual(receipt.sceneSplit?.skipped[0]?.reason, 'FADE_BOUNDS');
  const updated = store.get('timelines', timelineId) as any;
  const mainPieces = updated.clips.filter((clip: any) => clip.trackId === video);
  const subPieces = updated.clips.filter((clip: any) => clip.trackId === v2);
  assert.equal(mainPieces.length, 3); assert.equal(subPieces.length, 2);
  assert.ok(previewPairs.some((pair: any) => pair.rightClipId === subPieces[1].id));
  assert.equal(subPieces[1].anchor.clipId, mainPieces[2].id);
  assert.equal(subPieces[1].sequenceSource, undefined);
  assert.equal(mainPieces[1].sequenceSource.segmentGroupId, groupMain);
  const view = readSequenceEditHistory(store, 'mio');
  assert.equal(applyMioSequenceUndo(store, prepareMioSequenceUndo(store, projectId, 'scene-undo')).status, 'applied');
  const restored = store.get('timelines', timelineId) as any;
  assert.equal(restored.clips.length, 2);
  assert.equal(restored.clips.find((clip: any) => clip.id === mainClip)?.durationFrames, 60);
  // A newer detection replaces the result; the old id must conflict.
  const second = await services.call('scene.detect', {projectId, sourceAssetId: asset, sourceHash: sha, requestId: randomUUID()}) as any;
  for (let i = 0; i < 500; i++) {const value = services.handlers['scene.task.get']!({projectId, taskId: second.id} as never) as any;
    if (value?.state === 'succeeded' && value.result) break; await delay(5);}
  assert.throws(() => previewMioSequenceAction(store, projectId, 'scene-split-stale', {kind: 'split-at-scenes', assetId: asset, resultId}), {code: 'SEQUENCE_EDIT_SCENE_RESULT_CONFLICT'});
});
