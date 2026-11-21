import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {previewSequenceSync, readSequenceSyncProjection, runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import {previewTimelineFormat, runTimelineFormatSync} from '../packages/business/src/format5-format-set.ts';
import {mediaReferenceFixture, mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {withK1BenchmarkLock} from './helpers/k1-benchmark-lock.ts';
import {measureCommittedCall, summarizeTiming} from './helpers/commit-timing.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sha = (letter: string): string => letter.repeat(64);
const sceneBytes = mp4HeaderFixture('k1-scene-source');
const sceneSha = createHash('sha256').update(sceneBytes).digest('hex');

/** K1 acceptance shape: 500 shots, 500 main-track segments, 600 auxiliary
 * segments, 100 scene-split other-track segments and 500 cues. Format switch
 * and scene split are measured through the shared transaction only:
 * receipt replay, revision checks, projection read, SA plan, changed-row writes,
 * three-state baseline, one history action and commit. Envelope preview is the
 * separate read-only step a real UI/MT caller runs before confirmation. */
test('K1 format switch and scene split meet the local budgets', async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-ts-perf-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = store.projectId;
  const rootNode = id(2), videoTrack = id(3), audioTrack = id(4), timelineId = id(5), v2Track = id(15);
  const shots = 500, auxiliary = 600, cues = 500;
  const shotIds = Array.from({length: shots}, (_, index) => id(1000 + index));
  const mainClipIds = Array.from({length: shots}, (_, index) => id(3000 + index));
  const groups = Array.from({length: shots}, (_, index) => id(5000 + index));
  const targetShot = shotIds[250]!;
  const assetA = id(7), assetB = id(8), versionA = id(9), versionB = id(10), jobA = id(11), jobB = id(12);
  const timeline = {
    id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: shots * 60,
    createdAt: at, updatedAt: at, mainTrack: {trackId: videoTrack, sequenceNodeId: rootNode},
    tracks: [{id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false},
      {id: v2Track, name: 'V2', kind: 'video', orderIndex: 2, hidden: false, muted: false}],
    clips: [
      ...shotIds.map((shotId, index) => ({id: mainClipIds[index]!, trackId: videoTrack, name: `Shot ${index}`,
        startFrame: index * 60, durationFrames: 60, sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
        sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotId, segmentGroupId: groups[index]!, versionMode: 'follow'}})),
      ...Array.from({length: auxiliary}, (_, index) => ({id: id(8000 + index), trackId: audioTrack, name: `Audio ${index}`,
        startFrame: index * 30, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280},
        gain: 0.5, assetId: id(6), sourceState: 'ready',
        anchor: {clipId: mainClipIds[Math.floor(index / 2)]!, offsetFrames: (index % 2) * 30}})),
      ...Array.from({length: 100}, (_, index) => ({id: id(12000 + index), trackId: v2Track, name: `Scene ${index}`,
        startFrame: index * 30, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280},
        gain: 1, assetId: assetA, versionId: versionA, sourceState: 'ready',
        anchor: {clipId: mainClipIds[Math.floor(index / 2)]!, offsetFrames: (index % 2) * 30}})),
    ],
    subtitles: {profileId: 'bottom_cjk_v1', cues: Array.from({length: cues}, (_, index) => {
      const owner = Math.min(shots - 1, Math.floor(index * 40 / 60));
      return {id: id(9000 + index), text: `Cue ${index}`, startFrame: index * 40, durationFrames: 30,
        anchor: {clipId: mainClipIds[owner]!, offsetFrames: index * 40 - owner * 60}};
    })},
  };
  const baseline = {version: 1,
    board: shotIds.map(shotId => ({nodeId: shotId, kind: 'shot', selectedVersionId: null})),
    track: mainClipIds.map((clipId, index) => ({nodeId: shotIds[index]!, segmentGroupId: groups[index]!, clipId,
      kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
  mkdirSync(path.join(root, 'media'), {recursive: true});
  writeFileSync(path.join(root, 'media/k1-scene.mp4'), sceneBytes);
  const sceneReference = {...mediaReferenceFixture('media/k1-scene.mp4', sceneBytes.length, sceneSha),
    mtimeMs: Math.trunc(statSync(path.join(root, 'media/k1-scene.mp4')).mtimeMs)};
  const builtAt = Date.now();
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic K1', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: id(6), projectId, mimeType: 'audio/wav', duration: 1200, sha256: sha('d')});
    store.put('assets', {id: assetA, projectId, mimeType: 'video/mp4', duration: 2, sha256: sceneSha,
      sizeBytes: sceneBytes.length, reference: sceneReference, referenceRevision: 1});
    store.put('assets', {id: assetB, projectId, mimeType: 'video/mp4', duration: 3, sha256: sha('b')});
    for (const shotId of shotIds) store.put('shots', {id: shotId, projectId, orderIndex: 0, selectedVersionId: null, duration: 2,
      referenceAssetIds: [], aspectRatio: '9:16', parameters: {}, position: {x: 0, y: 0}, createdAt: at, updatedAt: at});
    store.put('jobs', {id: jobA, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock',
      shotId: targetShot, versionId: versionA, createdAt: at, updatedAt: at});
    store.put('versions', {id: versionA, projectId, jobId: jobA, shotId: targetShot, number: 1, assetId: assetA, sha256: sceneSha, createdAt: at});
    store.put('versions', {id: versionB, projectId, jobId: jobB, shotId: targetShot, number: 2, assetId: assetB, sha256: sha('b'), createdAt: at});
    store.put('nodes', {id: rootNode, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    const edges: {id: string; projectId: string; kind: 'sequence'; source: string; target: string; createdAt: string}[] = [];
    let source = rootNode;
    for (const [index, shotId] of shotIds.entries()) {
      edges.push({id: id(10000 + index), projectId, kind: 'sequence', source, target: shotId, createdAt: at});
      source = shotId;
    }
    for (const edge of edges) store.put('edges', edge);
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootNode, 1, JSON.stringify(baseline));
  });
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const detection = async (input: any) => {input.beforeSpawn(input.signal); return {profileId: 'scene-cuts-v1', fps: 30,
    frameCount: 30, options: input.options, cuts: [{frame: 10, score: 0.5}, {frame: 20, score: 0.5}], segments: [],
    sourceHash: input.asset.sha256, analysis: {width: 32, height: 32, decodedFrames: 30}};};
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {}),
    sceneOptions: {detect: detection as never}});
  const ack = await services.call('scene.detect', {projectId, sourceAssetId: assetA, sourceHash: sceneSha, requestId: randomUUID()}) as any;
  let sceneResultId = '';
  for (let i = 0; i < 500; i++) {const value = services.handlers['scene.task.get']!({projectId, taskId: ack.id} as never) as any;
    if (value?.state === 'succeeded' && value.result) {sceneResultId = String(value.result.id); break;} await delay(5);}
  assert.ok(sceneResultId, 'scene detection must produce a result');
  await services.drain(); library.close();
  const buildMs = Date.now() - builtAt;
  const projection = readSequenceSyncProjection(store);
  assert.equal(projection.chainNodeIds.length, shots);
  withK1BenchmarkLock(() => {
  // Linux CI gates the transaction body; native COMMIT is a diagnostic there.
  const formatTimings: number[] = [], formatCodePaths: number[] = [], formatCommits: number[] = [];
  for (let iteration = 0; iteration < 15; iteration++) {
    const presetId = iteration % 2 === 0 ? 'landscape_720' : 'portrait_720';
    const preview = previewTimelineFormat(store, {requestId: `k1-format-${iteration}-${Date.now()}`,
      formatIntent: {side: 'timeline', operation: {kind: 'timeline-format', presetId}}});
    assert.ok('envelope' in preview, 'format preview must succeed');
    const measured = measureCommittedCall(store, () => runTimelineFormatSync(store, preview.envelope));
    assert.equal(measured.commits, 1, `format iteration ${iteration} committed ${measured.commits} times`);
    formatTimings.push(measured.totalMs); formatCodePaths.push(measured.codePathMs); formatCommits.push(measured.commitMs);
    assert.ok(measured.value.ok, `format iteration ${iteration} failed`);
  }
  const sceneCommand = {kind: 'clip-split-scenes' as const, assetId: assetA, resultId: sceneResultId};
  const scenePreview = previewSequenceSync(store, sceneCommand, {requestId: `k1-scene-${Date.now()}`});
  assert.ok('envelope' in scenePreview, 'scene preview must succeed');
  const scene = measureCommittedCall(store, () => runSequenceSync(store, scenePreview.envelope));
  assert.equal(scene.commits, 1);
  assert.ok(scene.value.ok, 'scene commit failed');
  const formatTotal = summarizeTiming(formatTimings.slice(5)), formatCodePath = summarizeTiming(formatCodePaths.slice(5)),
    formatCommit = summarizeTiming(formatCommits.slice(5)), sceneCodePath = summarizeTiming([scene.codePathMs]),
    sceneCommit = summarizeTiming([scene.commitMs]), sceneTotal = summarizeTiming([scene.totalMs]);
  console.log(JSON.stringify({benchmark: 'format5-format-scenes', shots, mainClips: shots, auxiliaryClips: auxiliary,
    cues, buildMs, formatTotal, formatCodePath, formatCommit, sceneCodePath, sceneCommit, sceneTotal}));
  assert.ok(buildMs < 180_000, `fixture build took ${buildMs}ms`);
  if (process.platform === 'linux') {
    assert.ok(formatCodePath.p95 <= 200, `format K1 code path p95 ${formatCodePath.p95}ms exceeds 200ms`);
    assert.ok(formatCodePath.max <= 400, `format K1 code path max ${formatCodePath.max}ms exceeds 400ms`);
    assert.ok(sceneCodePath.p95 <= 400, `scene K1 code path p95 ${sceneCodePath.p95}ms exceeds 400ms`);
    assert.ok(sceneCodePath.max <= 800, `scene K1 code path max ${sceneCodePath.max}ms exceeds 800ms`);
  } else {
    assert.ok(formatTotal.p95 <= 100, `format K1 p95 ${formatTotal.p95}ms exceeds 100ms`);
    assert.ok(formatTotal.max <= 200, `format K1 max ${formatTotal.max}ms exceeds 200ms`);
    assert.ok(sceneTotal.p95 <= 200, `scene K1 p95 ${sceneTotal.p95}ms exceeds 200ms`);
    assert.ok(sceneTotal.max <= 400, `scene K1 max ${sceneTotal.max}ms exceeds 400ms`);
  }
  });
});
