/** Seeded format-5 project for the real-RPC headless scene-split acceptance.
 *
 * Unlike the UI-E2 wire fixture this project carries three verified video
 * assets: their files are synthesized with FFmpeg at setup time (hard cuts from
 * full-frame overlays on the main stream's frame number, never `concat`), then
 * imported through the production `asset.import` entry, hashed through
 * `asset.media.prepare`, and detected through the production `scene.detect`
 * queue. The detected cuts are asserted here before the browser starts, so the
 * acceptance never works from hand-written cut lists.
 *
 * The dedicated timeline covers the scene-split semantics the service tests
 * cover: one asset split on the main track, the same asset on the main track in
 * two pieces, one full-other-track copy, and two clips that must be skipped
 * (a cut inside the fade-in and a source range with no cut). */
import {mkdirSync, mkdtempSync, realpathSync, rmSync, statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';
import {run} from '../../packages/business/src/media-runtime.ts';
import {mediaReferenceSchema} from '../../packages/contracts/src/media-reference.ts';

type Row = Record<string, unknown>;
const at = '2026-01-01T00:00:00.000Z';
const id = (number: number): string => `93000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const SCENE_SPLIT_IDS = {
  project: id(1), root: id(2), shotSingle: id(3), shotMulti: id(4), shotDetect: id(5),
  versionSingle: id(20), versionMulti: id(21), versionDetect: id(22),
  jobSingle: id(23), jobMulti: id(24), jobDetect: id(25),
  clipSingle: id(30), clipMultiLeft: id(31), clipMultiRight: id(32), clipDetect: id(33),
  clipMultiV2: id(34), clipFade: id(35), clipNoCut: id(36),
  groupSingle: id(40), groupMulti: id(41), groupDetect: id(42),
  timeline: id(50),
  video: id(60), video2: id(61), video3: id(62), audio: id(63),
  edge1: id(80), edge2: id(81), edge3: id(82),
} as const;
/** The cut frames the production detector must report for every synthesized asset. */
export const SCENE_SPLIT_CUTS = [30, 60, 90] as const;
const assetNames = {single: 'scene-single.mp4', multi: 'scene-multi.mp4', detect: 'scene-detect.mp4'} as const;
const small = 's=320x180';
const perlin = (seed: number): string =>
  `perlin=${small}:r=30:octaves=4:persistence=0.6:tscale=0.3:random_mode=seed:seed=${seed},format=gbrp,colorchannelmixer=rr=1:gg=0.75:bb=0.45`;
/** Four visually distinct shots on the main stream; each later one is a
 * full-frame overlay switched by the main stream's frame number. */
const filterGraph = (sources: readonly [string, string, string, string], tint: string): string => {
  const [first, second, third, fourth] = sources;
  return [
    `${first}[a]`, `${second}[b]`, `${third}[c]`, `${fourth}[d]`,
    `[a][b]overlay=shortest=1:enable='between(n,30,59)'[ab]`,
    `[ab][c]overlay=shortest=1:enable='between(n,60,89)'[abc]`,
    `[abc][d]overlay=shortest=1:enable='gte(n,90)',setsar=1,format=yuv420p,colorchannelmixer=${tint}[v]`,
  ].join(';');
};
const graphs = {
  single: filterGraph([`testsrc2=${small}:r=30,trim=end_frame=120`, perlin(3),
    `smptehdbars=${small}:r=30,noise=alls=12:allf=t+u`, `mandelbrot=${small}:r=30,trim=end_frame=120`], 'rr=1:gg=1:bb=1'),
  multi: filterGraph([`smptehdbars=${small}:r=30,noise=alls=8:allf=t+u`, perlin(5),
    `testsrc2=${small}:r=30,trim=end_frame=120`, `mandelbrot=${small}:r=30:start_scale=2:end_scale=0.5,trim=end_frame=120`],
  'rr=0.85:gg=1:bb=0.8'),
  detect: filterGraph([`mandelbrot=${small}:r=30:start_scale=3:end_scale=1,trim=end_frame=120`, perlin(7),
    `smptehdbars=${small}:r=30,noise=alls=20:allf=t+u`, `testsrc2=${small}:r=30,trim=end_frame=120`], 'rr=1:gg=0.9:bb=0.7'),
} as const;
type AssetKey = keyof typeof assetNames;
export interface SceneSplitWireFixture {
  store: ProjectStore;
  services: ReturnType<typeof createServices>;
  library: ReturnType<typeof openAppLibrary>;
  projectId: string;
  root: string;
  assets: Record<AssetKey, string>;
  /** Absolute verified file per asset, for the runner's media route. */
  mediaFiles: Record<string, string>;
  scene: {results: Record<'single' | 'multi', {resultId: string; cuts: number[]; frameCount: number}>; cuts: number[]};
  ids: typeof SCENE_SPLIT_IDS;
  /** Everything the acceptance script needs, without any path outside the card. */
  summary: Row;
  /** Removes the temporary project directory after the store is closed. */
  cleanup(): void;
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function synthesize(root: string, key: AssetKey): Promise<string> {
  const file = path.join(root, 'media', assetNames[key]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex', graphs[key],
    '-map', '[v]', '-frames:v', '120', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '2',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], {timeout: 60000});
  if (statSync(file).size <= 0) throw new Error(`The synthesized ${key} source is empty`);
  return file;
}
function referenceFile(root: string, reference: unknown): string {
  const parsed = mediaReferenceSchema.parse(reference);
  const form = parsed.pathForm === 'relative' ? path.join(root, parsed.path) : parsed.path;
  if (!path.isAbsolute(form)) throw new Error('The import reference must resolve inside the project');
  return form;
}

/** Polls the production detect task until it settles and returns the saved result. */
async function detect(services: ReturnType<typeof createServices>, projectId: string, assetId: string, sourceHash: string): Promise<{resultId: string; cuts: number[]; frameCount: number}> {
  const ack = await services.call('scene.detect', {projectId, sourceAssetId: assetId, sourceHash, requestId: randomUUID()}) as Row;
  const taskId = String(ack.id);
  for (let attempt = 0; attempt < 600; attempt++) {
    const task = await services.call('scene.task.get', {projectId, taskId}) as Row;
    if (task.state === 'succeeded' && task.result) {
      const saved = await services.call('scene.result.get', {projectId, assetId}) as Row;
      const result = (saved.result ?? null) as Row | null;
      if (!result || result.id !== (task.result as Row).id) throw new Error('The detection task and the saved result disagree');
      const cuts = (result.cuts as Row[]).map(cut => Number(cut.frame));
      if (JSON.stringify(cuts) !== JSON.stringify(SCENE_SPLIT_CUTS) || result.frameCount !== 120) {
        throw new Error(`The synthesized ${assetId} source detected ${JSON.stringify({cuts, frameCount: result.frameCount})}, not the expected 3 cuts at 30/60/90`);
      }
      return {resultId: String(result.id), cuts, frameCount: Number(result.frameCount)};
    }
    if (task.state === 'failed' || task.state === 'interrupted') throw new Error(`Real scene detection failed: ${String(task.errorCode)}`);
    await delay(20);
  }
  throw new Error('Real scene detection did not settle in time');
}

export async function createSceneSplitWireFixture(): Promise<SceneSplitWireFixture> {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-scene-split-wire-'));
  const projectId = SCENE_SPLIT_IDS.project;
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  // No sceneOptions: the real local decoder and the production queue run.
  const services = createServices(store, new Map(), {env: {}, application: createProjectServiceApplication(library, undefined, {})});
  store.tx(() => store.put('projects', {id: projectId, name: '按场景切开无头夹具', createdAt: at, updatedAt: at, revision: 1}));
  mkdirSync(path.join(root, 'media'), {recursive: true});
  const assets = {} as Record<AssetKey, string>;
  try {
    // The production flow: import the real file, then compute its full hash the
    // way the open-detection entry does (`asset.media.prepare`, purpose scene).
    for (const key of Object.keys(assetNames) as AssetKey[]) {
      const source = await synthesize(root, key);
      const imported = await services.call('asset.import', {projectId, requestId: randomUUID(), sourcePath: source}) as Row;
      assets[key] = String(imported.id);
    }
    await services.call('asset.media.prepare', {projectId, purpose: 'scene', assets: (Object.keys(assetNames) as AssetKey[])
      .map(key => ({assetId: assets[key], referenceRevision: 1}))});
    const mediaFiles: Record<string, string> = {};
    for (const assetId of Object.values(assets)) {
      const asset = store.get('assets', assetId) as Row | null;
      if (!asset) throw new Error('The production import did not save the asset');
      if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new Error('The prepared asset has no full hash');
      if (typeof asset.reference !== 'object' || asset.reference === null || Object.hasOwn(asset, 'relativePath')) throw new Error('The prepared asset is not a project reference');
      const reference = asset.reference as Row;
      if (asset.sha256 !== reference.fullSha256 || asset.sizeBytes !== reference.sizeBytes) throw new Error('The asset fingerprint and its reference disagree');
      mediaFiles[assetId] = referenceFile(root, reference);
    }
    const hashOf = (key: AssetKey): string => String((store.get('assets', assets[key]) as Row).sha256);
    const single = await detect(services, projectId, assets.single, hashOf('single'));
    const multi = await detect(services, projectId, assets.multi, hashOf('multi'));
    const video = (trackId: string, clipId: string, name: string, startFrame: number, durationFrames: number, sourceInFrame: number,
      extra: Row): Row => ({id: clipId, trackId, name, startFrame, durationFrames, sourceInFrame,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, sourceState: 'ready', ...extra});
    const shotSource = (nodeId: string, segmentGroupId: string): Row => ({kind: 'shot', nodeId, segmentGroupId, versionMode: 'follow'});
    const tracks = [
      {id: SCENE_SPLIT_IDS.video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: SCENE_SPLIT_IDS.video2, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
      {id: SCENE_SPLIT_IDS.video3, name: 'V3', kind: 'video', orderIndex: 2, hidden: false, muted: false},
      {id: SCENE_SPLIT_IDS.audio, name: 'A1', kind: 'audio', orderIndex: 3, hidden: false, muted: false},
    ];
    const clips = [
      video(SCENE_SPLIT_IDS.video, SCENE_SPLIT_IDS.clipSingle, '镜头 S', 0, 120, 0, {assetId: assets.single,
        versionId: SCENE_SPLIT_IDS.versionSingle, shotId: SCENE_SPLIT_IDS.shotSingle,
        sequenceSource: shotSource(SCENE_SPLIT_IDS.shotSingle, SCENE_SPLIT_IDS.groupSingle)}),
      video(SCENE_SPLIT_IDS.video, SCENE_SPLIT_IDS.clipMultiLeft, '镜头 M 左', 120, 60, 0, {assetId: assets.multi,
        versionId: SCENE_SPLIT_IDS.versionMulti, shotId: SCENE_SPLIT_IDS.shotMulti,
        sequenceSource: shotSource(SCENE_SPLIT_IDS.shotMulti, SCENE_SPLIT_IDS.groupMulti)}),
      video(SCENE_SPLIT_IDS.video, SCENE_SPLIT_IDS.clipMultiRight, '镜头 M 右', 180, 60, 60, {assetId: assets.multi,
        versionId: SCENE_SPLIT_IDS.versionMulti, shotId: SCENE_SPLIT_IDS.shotMulti,
        sequenceSource: shotSource(SCENE_SPLIT_IDS.shotMulti, SCENE_SPLIT_IDS.groupMulti)}),
      video(SCENE_SPLIT_IDS.video, SCENE_SPLIT_IDS.clipDetect, '镜头 D', 240, 120, 0, {assetId: assets.detect,
        versionId: SCENE_SPLIT_IDS.versionDetect, shotId: SCENE_SPLIT_IDS.shotDetect,
        sequenceSource: shotSource(SCENE_SPLIT_IDS.shotDetect, SCENE_SPLIT_IDS.groupDetect)}),
      video(SCENE_SPLIT_IDS.video2, SCENE_SPLIT_IDS.clipMultiV2, 'M 副轨', 120, 120, 0, {assetId: assets.multi, anchor: null}),
      video(SCENE_SPLIT_IDS.video3, SCENE_SPLIT_IDS.clipFade, 'M 淡入段', 120, 45, 0, {assetId: assets.multi,
        fadeInFrames: 35, anchor: null}),
      video(SCENE_SPLIT_IDS.video3, SCENE_SPLIT_IDS.clipNoCut, 'M 无切点段', 165, 20, 100, {assetId: assets.multi, anchor: null}),
    ];
    const timeline = {id: SCENE_SPLIT_IDS.timeline, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 360,
      createdAt: at, updatedAt: at, mainTrack: {trackId: SCENE_SPLIT_IDS.video, sequenceNodeId: SCENE_SPLIT_IDS.root}, tracks, clips};
    const baseline = {version: 1,
      board: [{nodeId: SCENE_SPLIT_IDS.shotSingle, kind: 'shot', selectedVersionId: SCENE_SPLIT_IDS.versionSingle},
        {nodeId: SCENE_SPLIT_IDS.shotMulti, kind: 'shot', selectedVersionId: SCENE_SPLIT_IDS.versionMulti},
        {nodeId: SCENE_SPLIT_IDS.shotDetect, kind: 'shot', selectedVersionId: SCENE_SPLIT_IDS.versionDetect}] as Row[],
      track: [
        {nodeId: SCENE_SPLIT_IDS.shotSingle, segmentGroupId: SCENE_SPLIT_IDS.groupSingle, clipId: SCENE_SPLIT_IDS.clipSingle,
          kind: 'shot', versionMode: 'follow', appliedVersionId: SCENE_SPLIT_IDS.versionSingle},
        {nodeId: SCENE_SPLIT_IDS.shotMulti, segmentGroupId: SCENE_SPLIT_IDS.groupMulti, clipId: SCENE_SPLIT_IDS.clipMultiLeft,
          kind: 'shot', versionMode: 'follow', appliedVersionId: SCENE_SPLIT_IDS.versionMulti},
        {nodeId: SCENE_SPLIT_IDS.shotMulti, segmentGroupId: SCENE_SPLIT_IDS.groupMulti, clipId: SCENE_SPLIT_IDS.clipMultiRight,
          kind: 'shot', versionMode: 'follow', appliedVersionId: SCENE_SPLIT_IDS.versionMulti},
        {nodeId: SCENE_SPLIT_IDS.shotDetect, segmentGroupId: SCENE_SPLIT_IDS.groupDetect, clipId: SCENE_SPLIT_IDS.clipDetect,
          kind: 'shot', versionMode: 'follow', appliedVersionId: SCENE_SPLIT_IDS.versionDetect},
      ]};
    const node = (nodeId: string, type: string, extra: Row = {}): Row => ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
    const shots = [
      {id: SCENE_SPLIT_IDS.shotSingle, projectId, title: '单片段镜头', orderIndex: 0, selectedVersionId: SCENE_SPLIT_IDS.versionSingle, duration: 4,
        referenceAssetIds: [], aspectRatio: '9:16', parameters: {}, position: {x: 0, y: 0}, createdAt: at, updatedAt: at},
      {id: SCENE_SPLIT_IDS.shotMulti, projectId, title: '两段镜头', orderIndex: 1, selectedVersionId: SCENE_SPLIT_IDS.versionMulti, duration: 4,
        referenceAssetIds: [], aspectRatio: '9:16', parameters: {}, position: {x: 240, y: 0}, createdAt: at, updatedAt: at},
      {id: SCENE_SPLIT_IDS.shotDetect, projectId, title: '检测后切开镜头', orderIndex: 2, selectedVersionId: SCENE_SPLIT_IDS.versionDetect, duration: 4,
        referenceAssetIds: [], aspectRatio: '9:16', parameters: {}, position: {x: 480, y: 0}, createdAt: at, updatedAt: at},
    ];
    store.tx(() => {
      for (const [key, shotId, versionId, jobId] of [['single', SCENE_SPLIT_IDS.shotSingle, SCENE_SPLIT_IDS.versionSingle, SCENE_SPLIT_IDS.jobSingle],
        ['multi', SCENE_SPLIT_IDS.shotMulti, SCENE_SPLIT_IDS.versionMulti, SCENE_SPLIT_IDS.jobMulti],
        ['detect', SCENE_SPLIT_IDS.shotDetect, SCENE_SPLIT_IDS.versionDetect, SCENE_SPLIT_IDS.jobDetect]] as const) {
        store.put('jobs', {id: jobId, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock',
          shotId, versionId, createdAt: at, updatedAt: at});
        store.put('versions', {id: versionId, projectId, jobId, shotId, number: 1, assetId: assets[key],
          sha256: hashOf(key), createdAt: at});
      }
      for (const shot of shots) store.put('shots', shot);
      store.put('nodes', node(SCENE_SPLIT_IDS.root, 'sequence_root', {name: 'Film'}));
      store.put('edges', {id: SCENE_SPLIT_IDS.edge1, projectId, kind: 'sequence', source: SCENE_SPLIT_IDS.root, target: SCENE_SPLIT_IDS.shotSingle, createdAt: at});
      store.put('edges', {id: SCENE_SPLIT_IDS.edge2, projectId, kind: 'sequence', source: SCENE_SPLIT_IDS.shotSingle, target: SCENE_SPLIT_IDS.shotMulti, createdAt: at});
      store.put('edges', {id: SCENE_SPLIT_IDS.edge3, projectId, kind: 'sequence', source: SCENE_SPLIT_IDS.shotMulti, target: SCENE_SPLIT_IDS.shotDetect, createdAt: at});
      store.put('timelines', timeline);
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(SCENE_SPLIT_IDS.timeline, projectId, SCENE_SPLIT_IDS.root, 1, JSON.stringify(baseline));
    });
    const scene = {results: {single, multi}, cuts: [...SCENE_SPLIT_CUTS]};
    const summary = {
      projectId, assets, mainTrackId: SCENE_SPLIT_IDS.video, track2Id: SCENE_SPLIT_IDS.video2, track3Id: SCENE_SPLIT_IDS.video3,
      ids: SCENE_SPLIT_IDS, scene, timeline: {id: SCENE_SPLIT_IDS.timeline, durationFrames: 360, clips: clips.length},
    };
    return {store, services, library, projectId, root, assets, mediaFiles, scene, ids: SCENE_SPLIT_IDS, summary,
      cleanup: () => rmSync(root, {recursive: true, force: true})};
  } catch (error) {
    await services.drain().catch(() => {});
    library.close();
    store.close();
    throw error;
  }
}
