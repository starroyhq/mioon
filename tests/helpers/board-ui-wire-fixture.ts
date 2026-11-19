/** Real format-5 project for the UI-B2 headless acceptance. The browser talks
 * to the normal project service over HTTP; only the surrounding workbench shell
 * is a fixture. Thumbnails are synthetic data URLs because the fixture carries
 * no renderable media files, but every board row, version, edge and receipt is
 * produced by the real kernel/RPC. */
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';
import {createVideoSettings} from '../../packages/business/src/video/settings.ts';
import {defaultVideoModels} from '../../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration} from '../../packages/contracts/src/video-providers.ts';
import {createTestSecretCodec, testSecretStorage} from './secret-codec.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `70000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const BOARD_IDS = {
  project: id(1), root: id(2), shotA: id(3), shotB: id(4), imageNode: id(5), textNode: id(6), video: id(60), audio: id(61),
  assetA: id(10), assetB: id(11), imageAsset: id(12), assetV2: id(13), versionA: id(20), versionB: id(21), versionA2: id(22),
  jobA: id(70), jobB: id(71), jobV2: id(72), clipA: id(30), clipB: id(31), imageClip: id(32), groupA: id(40), groupB: id(41),
  groupImage: id(42), timeline: id(50), edge1: id(80), edge2: id(81), edge3: id(82), referenceEdge: id(83),
  subjectCharacter: id(90), subjectLook: id(91), subjectCharacterVersion: id(92), subjectLookVersion: id(93),
  arkConnection: id(100), wanConnection: id(101),
  imageNode2: id(7), audioNode: id(8), subjectCard: id(9),
  imageAsset2: id(14), audioAsset: id(15), subjectBinding: id(94), subjectEdge: id(84),
} as const;
const sha = (letter: string): string => letter.repeat(64);
export async function createBoardUiWireFixture(): Promise<{store: ProjectStore; services: ReturnType<typeof createServices>;
  library: ReturnType<typeof openAppLibrary>; settings: Awaited<ReturnType<typeof createVideoSettings>>;
  projectId: string; root: string}> {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-board-ui-wire-'));
  const store = createProjectStore({projectId: BOARD_IDS.project, projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const projectId = store.projectId;
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, revision: 1, createdAt: at, ...extra});
  const tracks = [
    {id: BOARD_IDS.video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: BOARD_IDS.audio, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false},
  ];
  const clips = [
    {id: BOARD_IDS.clipA, trackId: BOARD_IDS.video, name: '窗口剪影', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: BOARD_IDS.assetA, versionId: BOARD_IDS.versionA,
      shotId: BOARD_IDS.shotA, sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: BOARD_IDS.shotA,
        segmentGroupId: BOARD_IDS.groupA, versionMode: 'follow'}},
    {id: BOARD_IDS.clipB, trackId: BOARD_IDS.video, name: '占位镜头', startFrame: 60, durationFrames: 120, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
      sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: BOARD_IDS.shotB,
        segmentGroupId: BOARD_IDS.groupB, versionMode: 'follow'}},
  ];
  const timeline = {id: BOARD_IDS.timeline, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 180,
    createdAt: at, updatedAt: at, mainTrack: {trackId: BOARD_IDS.video, sequenceNodeId: BOARD_IDS.root}, tracks, clips};
  const baseline = {version: 1,
    board: [{nodeId: BOARD_IDS.shotA, kind: 'shot', selectedVersionId: BOARD_IDS.versionA},
      {nodeId: BOARD_IDS.shotB, kind: 'shot', selectedVersionId: null}],
    track: [{nodeId: BOARD_IDS.shotA, segmentGroupId: BOARD_IDS.groupA, clipId: BOARD_IDS.clipA, kind: 'shot',
      versionMode: 'follow', appliedVersionId: BOARD_IDS.versionA},
      {nodeId: BOARD_IDS.shotB, segmentGroupId: BOARD_IDS.groupB, clipId: BOARD_IDS.clipB, kind: 'shot',
        versionMode: 'follow', appliedVersionId: null}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'UI-B2 无头夹具', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: BOARD_IDS.assetA, projectId, name: '镜头A.mp4', mimeType: 'video/mp4', duration: 2, sha256: sha('a'), sizeBytes: 10});
    store.put('assets', {id: BOARD_IDS.assetB, projectId, name: '镜头B.mp4', mimeType: 'video/mp4', duration: 4, sha256: sha('b'), sizeBytes: 10});
    store.put('assets', {id: BOARD_IDS.assetV2, projectId, name: '镜头A v2.mp4', mimeType: 'video/mp4', duration: 3, sha256: sha('d'), sizeBytes: 10});
    store.put('assets', {id: BOARD_IDS.imageAsset, projectId, name: '参考图.png', mimeType: 'image/png', duration: null, sha256: sha('c'), sizeBytes: 10});
    store.put('assets', {id: BOARD_IDS.imageAsset2, projectId, name: '参考图 B.png', mimeType: 'image/png', duration: null, sha256: sha('e'), sizeBytes: 10});
    store.put('assets', {id: BOARD_IDS.audioAsset, projectId, name: '对白.wav', mimeType: 'audio/wav', duration: 5, sha256: sha('f'), sizeBytes: 10});
    const subjectVersionData = (versionId: string, subjectId: string, assetId: string = BOARD_IDS.imageAsset): string => JSON.stringify({id: versionId,
      projectId, subjectId, number: 1, assetId, sha256: 'c'.repeat(64), mimeType: 'image/png',
      width: 1080, height: 1920, createdAt: at,
      provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}});
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(BOARD_IDS.subjectCharacter, projectId, 'character', '阿琦', 1,
      BOARD_IDS.subjectCharacterVersion, at, at);
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(BOARD_IDS.subjectLook, projectId, 'look', '霓虹', 1,
      BOARD_IDS.subjectLookVersion, at, at);
    store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
      .run(BOARD_IDS.subjectCharacterVersion, projectId, BOARD_IDS.subjectCharacter, 1, BOARD_IDS.imageAsset,
        subjectVersionData(BOARD_IDS.subjectCharacterVersion, BOARD_IDS.subjectCharacter));
    store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
      .run(BOARD_IDS.subjectLookVersion, projectId, BOARD_IDS.subjectLook, 1, BOARD_IDS.imageAsset,
        subjectVersionData(BOARD_IDS.subjectLookVersion, BOARD_IDS.subjectLook));
    store.put('jobs', {id: BOARD_IDS.jobA, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: BOARD_IDS.shotA, createdAt: at, updatedAt: at});
    store.put('jobs', {id: BOARD_IDS.jobB, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: BOARD_IDS.shotB, createdAt: at, updatedAt: at});
    store.put('jobs', {id: BOARD_IDS.jobV2, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: BOARD_IDS.shotA, createdAt: at, updatedAt: at});
    store.put('versions', {id: BOARD_IDS.versionA, projectId, jobId: BOARD_IDS.jobA, shotId: BOARD_IDS.shotA, number: 1,
      assetId: BOARD_IDS.assetA, sha256: sha('a'), createdAt: at});
    store.put('versions', {id: BOARD_IDS.versionB, projectId, jobId: BOARD_IDS.jobB, shotId: BOARD_IDS.shotB, number: 1,
      assetId: BOARD_IDS.assetB, sha256: sha('b'), createdAt: at});
    store.put('versions', {id: BOARD_IDS.versionA2, projectId, jobId: BOARD_IDS.jobV2, shotId: BOARD_IDS.shotA, number: 2,
      assetId: BOARD_IDS.assetV2, sha256: sha('d'), createdAt: at});
    store.put('shots', {id: BOARD_IDS.shotA, projectId, title: '窗口剪影', orderIndex: 0, selectedVersionId: BOARD_IDS.versionA,
      duration: 2, position: {x: 110, y: 40}, aspectRatio: '16:9', revision: 1, createdAt: at, updatedAt: at});
    store.put('shots', {id: BOARD_IDS.shotB, projectId, title: '路口俯拍', orderIndex: 1, selectedVersionId: null,
      duration: 4, position: {x: 430, y: 40}, aspectRatio: '9:16', revision: 1, createdAt: at, updatedAt: at});
    store.put('nodes', node(BOARD_IDS.root, 'sequence_root', {name: '成片', position: {x: -230, y: 40}}));
    store.put('nodes', node(BOARD_IDS.imageNode, 'image', {assetId: BOARD_IDS.imageAsset, label: '参考图 · 街景',
      position: {x: 90, y: 330}}));
    store.put('nodes', node(BOARD_IDS.imageNode2, 'image', {assetId: BOARD_IDS.imageAsset2, label: '参考图 B',
      position: {x: 300, y: 330}}));
    store.put('nodes', node(BOARD_IDS.audioNode, 'audio', {assetId: BOARD_IDS.audioAsset, label: '对白.wav',
      position: {x: 510, y: 330}}));

    store.put('nodes', node(BOARD_IDS.textNode, 'text', {label: '文字', text: '第二幕：由街景过渡到霓虹特写，节奏放慢。',
      position: {x: 40, y: 580}}));
    store.put('edges', {id: BOARD_IDS.edge1, projectId, kind: 'sequence', source: BOARD_IDS.root, target: BOARD_IDS.shotA, createdAt: at});
    store.put('edges', {id: BOARD_IDS.edge2, projectId, kind: 'sequence', source: BOARD_IDS.shotA, target: BOARD_IDS.shotB, createdAt: at});
    store.put('edges', {id: BOARD_IDS.referenceEdge, projectId, kind: 'reference', role: 'first_frame',
      source: BOARD_IDS.imageNode, target: BOARD_IDS.shotA, sourceAssetId: BOARD_IDS.imageAsset, createdAt: at});
    // RI-b source cards stay reference-connected so the UI-B2 floating-label
    // baseline (only the text card is detached) does not change.
    store.put('edges', {id: id(85), projectId, kind: 'reference', role: 'reference_image',
      source: BOARD_IDS.imageNode2, target: BOARD_IDS.shotB, sourceAssetId: BOARD_IDS.imageAsset2, orderIndex: 0, createdAt: at});
    store.put('edges', {id: id(86), projectId, kind: 'reference', role: 'reference_audio',
      source: BOARD_IDS.audioNode, target: BOARD_IDS.shotB, sourceAssetId: BOARD_IDS.audioAsset, orderIndex: 1, createdAt: at});

    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(BOARD_IDS.timeline, projectId, BOARD_IDS.root, 1, JSON.stringify(baseline));
  });
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  // RI-b: two real configured video connections so the property panel can show
  // a supported multi-reference service (Ark Seedance 2.5) and one that refuses
  // reference audio (Wan 3.0). Credentials are synthetic test values.
  const settings = await createVideoSettings({directory: path.join(root, 'video-settings'), privateRoot: root,
    secretCodec: createTestSecretCodec(), storage: testSecretStorage});
  const ark: VideoConnectionConfiguration = {id: BOARD_IDS.arkConnection, providerId: 'ark', name: '火山方舟',
    region: 'cn-beijing', workspaceId: '', enabled: true, archived: false, outputHosts: ['output.example'],
    models: defaultVideoModels('ark')};
  const wan: VideoConnectionConfiguration = {id: BOARD_IDS.wanConnection, providerId: 'wan', name: '通义万相',
    region: 'cn-beijing', workspaceId: '', enabled: true, archived: false, outputHosts: ['output.example'],
    models: defaultVideoModels('wan')};
  await settings.put({action: 'save', expectedRevision: 0, configuration: ark,
    secret: {action: 'replace', value: 'synthetic-ark-key', storage: 'persistent'}});
  await settings.put({action: 'save', expectedRevision: 1, configuration: wan,
    secret: {action: 'replace', value: 'synthetic-wan-key', storage: 'persistent'}});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {}),
    videoSettings: settings});
  return {store, services, library, settings, projectId, root};
}

/** 500-shot stress project for the UI-B2 board frame-rate measurement. */
export async function createBoardUiWireStressFixture(): Promise<{store: ProjectStore; services: ReturnType<typeof createServices>;
  library: ReturnType<typeof openAppLibrary>; projectId: string; root: string}> {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-board-ui-wire-stress-'));
  const store = createProjectStore({projectId: id(1), projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const projectId = store.projectId, rootId = id(102), timelineId = id(103), video = id(104), imageAsset = id(105);
  const shotIds = Array.from({length: 500}, (_, index) => `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const imageIds = Array.from({length: 100}, (_, index) => `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const clips = shotIds.map((shotId, index) => ({id: `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    trackId: video, name: `镜头 ${index + 1}`, startFrame: index * 15, durationFrames: 15, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
    sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotId,
      segmentGroupId: `74000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, versionMode: 'follow'}}));
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 500 * 15, createdAt: at, updatedAt: at,
    mainTrack: {trackId: video, sequenceNodeId: rootId},
    tracks: [{id: video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips};
  const sequenceEdges = shotIds.map((shotId, index) => ({id: `75000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    projectId, kind: 'sequence', source: index === 0 ? rootId : shotIds[index - 1], target: shotId, createdAt: at}));
  const referenceEdges = imageIds.flatMap((imageId, imageIndex) => [0, 1].map(offset => {
    const shotIndex = (imageIndex * 2 + offset) % shotIds.length;
    return {id: `76000000-0000-4000-8000-${String(imageIndex * 2 + offset + 1).padStart(12, '0')}`,
      projectId, kind: 'reference', role: 'reference_image', source: imageId, target: shotIds[shotIndex],
      sourceAssetId: imageAsset, createdAt: at};
  }));
  const baseline = {version: 1,
    board: shotIds.map(shotId => ({nodeId: shotId, kind: 'shot', selectedVersionId: null})),
    track: clips.map(clip => ({nodeId: clip.sequenceSource.nodeId, segmentGroupId: clip.sequenceSource.segmentGroupId,
      clipId: clip.id, kind: 'shot', versionMode: 'follow', appliedVersionId: null}))};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'UI-B2 500 镜头压力夹具', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: imageAsset, projectId, name: '参考图.png', mimeType: 'image/png', duration: null,
      sha256: 'c'.repeat(64), sizeBytes: 10});
    shotIds.forEach((shotId, index) => store.put('shots', {id: shotId, projectId, title: `镜头 ${index + 1}`,
      orderIndex: index, selectedVersionId: null, duration: 1, position: {x: (index % 25) * 280, y: Math.floor(index / 25) * 240},
      aspectRatio: '9:16', revision: 1, createdAt: at, updatedAt: at}));
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', revision: 1, name: '成片',
      position: {x: -300, y: -100}, createdAt: at});
    imageIds.forEach((imageId, index) => store.put('nodes', {id: imageId, projectId, type: 'image', assetId: imageAsset, revision: 1,
      label: `参考图 ${index + 1}`, position: {x: (index % 20) * 260, y: 4000 + Math.floor(index / 20) * 220}, createdAt: at}));
    for (const edge of sequenceEdges) store.put('edges', edge);
    for (const edge of referenceEdges) store.put('edges', edge);
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baseline));
  });
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {})});
  return {store, services, library, projectId, root};
}
