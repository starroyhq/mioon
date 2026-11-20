/** Seeded format-5 project used by the real-RPC headless UI-E2 acceptance.
 * The project is a normal kernel store; the browser talks to it through the
 * real project service entry, never through a mocked RPC. */
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `90000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const WIRE_IDS = {
  project: id(1), root: id(2), shotA: id(3), shotB: id(4), imageNode: id(5), video: id(60), video2: id(61), audio: id(62),
  assetA: id(10), assetB: id(11), imageAsset: id(12), audioAsset: id(13), versionA: id(20), versionB: id(21),
  clipA: id(30), clipA2: id(31), clipB: id(32), imageClip: id(33), groupA: id(40), groupB: id(41), groupImage: id(42),
  timeline: id(50), edge1: id(80), edge2: id(81), edge3: id(82),
} as const;
const sha = (letter: string): string => letter.repeat(64);
export async function createEditUiWireFixture(options: {width?: number; height?: number} = {}): Promise<{store: ProjectStore; services: ReturnType<typeof createServices>;
  library: ReturnType<typeof openAppLibrary>; projectId: string; root: string}> {
  const width = options.width ?? 720, height = options.height ?? 1280;
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-edit-ui-wire-'));
  const store = createProjectStore({projectId: WIRE_IDS.project, projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const projectId = store.projectId;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const tracks = [
    {id: WIRE_IDS.video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: WIRE_IDS.video2, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
    {id: WIRE_IDS.audio, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false},
  ];
  const clips = [
    {id: WIRE_IDS.clipA, trackId: WIRE_IDS.video, name: '镜头 A 左', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width, height}, gain: 1, assetId: WIRE_IDS.assetA, versionId: WIRE_IDS.versionA,
      shotId: WIRE_IDS.shotA, sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: WIRE_IDS.shotA,
        segmentGroupId: WIRE_IDS.groupA, versionMode: 'follow'}},
    {id: WIRE_IDS.clipA2, trackId: WIRE_IDS.video, name: '镜头 A 右', startFrame: 30, durationFrames: 30, sourceInFrame: 30,
      rect: {x: 0, y: 0, width, height}, gain: 1, assetId: WIRE_IDS.assetA, versionId: WIRE_IDS.versionA,
      shotId: WIRE_IDS.shotA, sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: WIRE_IDS.shotA,
        segmentGroupId: WIRE_IDS.groupA, versionMode: 'follow'}},
    {id: WIRE_IDS.clipB, trackId: WIRE_IDS.video, name: '占位镜头 B', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width, height}, gain: 1, assetId: null, versionId: null, jobId: null,
      sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: WIRE_IDS.shotB, segmentGroupId: WIRE_IDS.groupB, versionMode: 'follow'}},
    {id: WIRE_IDS.imageClip, trackId: WIRE_IDS.video, name: '图片', startFrame: 90, durationFrames: 60, sourceInFrame: 0,
      rect: {x: 0, y: 0, width, height}, gain: 1, assetId: WIRE_IDS.imageAsset,
      sourceState: 'ready', sequenceSource: {kind: 'media', nodeId: WIRE_IDS.imageNode, segmentGroupId: WIRE_IDS.groupImage}},
  ];
  const timeline = {id: WIRE_IDS.timeline, projectId, revision: 1, width, height, fps: 30, durationFrames: 150,
    createdAt: at, updatedAt: at, mainTrack: {trackId: WIRE_IDS.video, sequenceNodeId: WIRE_IDS.root}, tracks, clips};
  const baseline = {version: 1,
    board: [{nodeId: WIRE_IDS.shotA, kind: 'shot', selectedVersionId: WIRE_IDS.versionA},
      {nodeId: WIRE_IDS.shotB, kind: 'shot', selectedVersionId: null},
      {nodeId: WIRE_IDS.imageNode, kind: 'media', assetId: WIRE_IDS.imageAsset}],
    track: [{nodeId: WIRE_IDS.shotA, segmentGroupId: WIRE_IDS.groupA, clipId: WIRE_IDS.clipA, kind: 'shot',
      versionMode: 'follow', appliedVersionId: WIRE_IDS.versionA},
      {nodeId: WIRE_IDS.shotB, segmentGroupId: WIRE_IDS.groupB, clipId: WIRE_IDS.clipB, kind: 'shot',
        versionMode: 'follow', appliedVersionId: null},
      {nodeId: WIRE_IDS.imageNode, segmentGroupId: WIRE_IDS.groupImage, clipId: WIRE_IDS.imageClip, kind: 'media',
        assetId: WIRE_IDS.imageAsset}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'UI-E2 无头夹具', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: WIRE_IDS.assetA, projectId, name: '镜头A.mp4', mimeType: 'video/mp4', duration: 2, hasAudio: true, sha256: sha('a'), sizeBytes: 10});
    store.put('assets', {id: WIRE_IDS.assetB, projectId, name: '镜头B.mp4', mimeType: 'video/mp4', duration: 3, sha256: sha('b'), sizeBytes: 10});
    store.put('assets', {id: WIRE_IDS.imageAsset, projectId, name: '图片.png', mimeType: 'image/png', duration: null, sha256: sha('c'), sizeBytes: 10});
    store.put('assets', {id: WIRE_IDS.audioAsset, projectId, name: '声音.wav', mimeType: 'audio/wav', duration: 2, sha256: sha('f'), sizeBytes: 10});
    store.put('jobs', {id: id(71), projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: WIRE_IDS.shotA, createdAt: at, updatedAt: at});
    store.put('jobs', {id: id(72), projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: WIRE_IDS.shotB, createdAt: at, updatedAt: at});
    store.put('versions', {id: WIRE_IDS.versionA, projectId, jobId: id(71), shotId: WIRE_IDS.shotA, number: 1,
      assetId: WIRE_IDS.assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: WIRE_IDS.versionB, projectId, jobId: id(72), shotId: WIRE_IDS.shotB, number: 2,
      assetId: WIRE_IDS.assetB, sha256: sha('b'), createdAt: at});
    const shots = [
      {id: WIRE_IDS.shotA, projectId, title: '窗口剪影', orderIndex: 0, selectedVersionId: WIRE_IDS.versionA, duration: 2, createdAt: at, updatedAt: at,
        dialogue: [{id: id(91), text: '我们回不去了。'}]},
      {id: WIRE_IDS.shotB, projectId, title: '占位镜头', orderIndex: 1, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at},
    ];
    for (const shot of shots) store.put('shots', shot);
    store.put('nodes', node(WIRE_IDS.root, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(WIRE_IDS.imageNode, 'image', {assetId: WIRE_IDS.imageAsset, label: '图片'}));
    store.put('edges', {id: WIRE_IDS.edge1, projectId, kind: 'sequence', source: WIRE_IDS.root, target: WIRE_IDS.shotA, createdAt: at});
    store.put('edges', {id: WIRE_IDS.edge2, projectId, kind: 'sequence', source: WIRE_IDS.shotA, target: WIRE_IDS.shotB, createdAt: at});
    store.put('edges', {id: WIRE_IDS.edge3, projectId, kind: 'sequence', source: WIRE_IDS.shotB, target: WIRE_IDS.imageNode, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(WIRE_IDS.timeline, projectId, WIRE_IDS.root, 1, JSON.stringify(baseline));
  });
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {})});
  return {store, services, library, projectId, root};
}
