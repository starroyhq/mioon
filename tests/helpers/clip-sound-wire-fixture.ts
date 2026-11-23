/** Real format-5 fixture for the «clip sound» headless acceptance.
 *
 * One real format-5 project file with synthetic FFmpeg media imported through
 * the production `asset.import` handler (real probe, hash and publication). The
 * main track holds a real AAC video, a real non-AAC (MP3 in MP4) video, a
 * placeholder and a silent video; V2 holds an image; A1 is empty so the first
 * separation finds a free audio track. The surrounding project service and
 * background worker are the production ones; nothing about the clip-sound
 * actions is stubbed.
 */
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createServices} from '../../packages/business/src/services.ts';
import type {OrdinaryServices} from '../../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';
import {createProviderRegistry} from '../../packages/business/src/provider-registry.ts';
import {startWorker} from '../../packages/business/src/jobs.ts';
import {mkdirSync} from 'node:fs';
import {referenceForPublishedMedia} from '../../packages/business/src/project-media-storage.ts';
import {run} from '../../packages/business/src/media-runtime.ts';


const at = '2026-01-01T00:00:00.000Z';
const id = (n: number): string => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const projectId = id(1), rootNode = id(2), timelineId = id(50);
export const mainTrackId = id(60), v2TrackId = id(61), audioTrackId = id(62);
const shotA = id(3), shotB = id(4), shotC = id(5), shotD = id(6), imageNode = id(7);
export const versionCopy = id(20), versionTranscode = id(21), versionSilent = id(22), jobA = id(70), jobB = id(71), jobD = id(72);
export const copyClipId = id(30), transcodeClipId = id(31), placeholderClipId = id(32), silentClipId = id(33), imageClipId = id(34);
const groupA = id(40), groupB = id(41), groupC = id(42), groupD = id(43), groupImage = id(44);

export interface ClipSoundFixture {
  readonly store: ProjectStore;
  readonly services: OrdinaryServices;
  readonly library: ReturnType<typeof openAppLibrary>;
  readonly directory: string;
  readonly mediaFiles: ReadonlyMap<string, string>;
  readonly close: () => Promise<void>;
}

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    {timeout: 120000, maxStdoutBytes: 0, maxStderrBytes: 65536});
}

async function importMedia(store: ProjectStore, services: OrdinaryServices, file: string, name: string, mimeType: string): Promise<{id: string; row: Record<string, unknown>}> {
  const {readFileSync} = await import('node:fs');
  const bytes = readFileSync(file);
  const row = await services.call('asset.import', {projectId, requestId: randomUUID(), name, mimeType,
    dataBase64: bytes.toString('base64')}) as Record<string, unknown>;
  if (typeof row?.id !== 'string') throw new TypeError('Asset import did not return an asset id');
  // Read the persisted row: the RPC projection may omit private reference fields
  // but the version join needs the exact stored full hash.
  const persisted = store.get('assets', row.id) as Record<string, unknown>;
  return {id: row.id, row: persisted};
}

export async function createClipSoundWireFixture(): Promise<ClipSoundFixture> {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-clip-sound-wire-'));
  const store = createProjectStore({projectId, projectFile: path.join(directory, 'project.mioon'), targetFormat: 5,
    locate: () => ({localDir: path.join(directory, 'records'), cacheDir: path.join(directory, 'cache'),
      tempDir: path.join(directory, 'temp')})});
  const library = openAppLibrary({dataDir: path.join(directory, 'app')});
  const providers = createProviderRegistry({db: store.db, root: store.projectDir, env: {}});
  const services = createServices(store, providers, {env: {},
    application: createProjectServiceApplication(library, undefined, {})});
  const worker = startWorker(store, services, providers);
  const incoming = path.join(directory, 'incoming');
  mkdirSync(incoming, {recursive: true, mode: 0o700});
  // The import handler writes into an existing owned project.
  store.tx(() => {
    store.put('projects', {id: projectId, name: '片段自带的声音', createdAt: at, updatedAt: at, revision: 1});
    store.put('nodes', {id: rootNode, projectId, type: 'sequence_root', name: '成片', position: {x: 0, y: 0}, createdAt: at});
  });
  const copySource = path.join(incoming, 'sound-aac.mp4');
  const transcodeSource = path.join(incoming, 'sound-mp3.mp4');
  const silentSource = path.join(incoming, 'silent.mp4');
  const imageSource = path.join(incoming, 'still.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', copySource]);
  await ffmpeg(['-f', 'lavfi', '-i', 'smptebars=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'mp3', '-shortest', transcodeSource]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x204060:s=320x180:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-an', silentSource]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xd0b040:s=320x180', '-frames:v', '1', imageSource]);
  let copy = await importMedia(store, services, copySource, 'AAC 城市.mp4', 'video/mp4');
  let transcode = await importMedia(store, services, transcodeSource, 'MP3 窗口.mp4', 'video/mp4');
  let silent = await importMedia(store, services, silentSource, '无声素材.mp4', 'video/mp4');
  let image = await importMedia(store, services, imageSource, '画面.png', 'image/png');
  // The public upload projection keeps a sampled reference. A project reference
  // is admitted by the owned-media graph after its full hash is prepared; the
  // version join and the clip-audio worker both require that exact full hash.
  const mediaFiles = new Map<string, string>();
  const strengthen = async (asset: {id: string; row: Record<string, unknown>}): Promise<void> => {
    const persisted = store.get('assets', asset.id) as Record<string, unknown>;
    const relativePath = (persisted.reference as {path?: string} | undefined)?.path;
    if (!relativePath) throw new TypeError('Imported asset has no project reference');
    const file = path.join(store.projectDir, relativePath);
    const published = await referenceForPublishedMedia(store, file);
    store.tx(() => store.put('assets', {...persisted, reference: published.reference, referenceRevision: 1,
      sizeBytes: published.sizeBytes, sha256: published.sha256}));
    mediaFiles.set(asset.id, file);
    asset.row = store.get('assets', asset.id) as Record<string, unknown>;
  };
  await strengthen(copy);
  await strengthen(transcode);
  await strengthen(silent);
  await strengthen(image);
  const durationOf = (row: Record<string, unknown>): number => typeof row.duration === 'number' ? row.duration : 2;
  const timelineClips = [
    {id: copyClipId, trackId: mainTrackId, name: '01 城市夜景', startFrame: 0, durationFrames: 60, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: copy.id, versionId: versionCopy, shotId: shotA,
      sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
    {id: transcodeClipId, trackId: mainTrackId, name: '02 窗口剪辑', startFrame: 60, durationFrames: 60, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: transcode.id, versionId: versionTranscode, shotId: shotB,
      sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
    {id: placeholderClipId, trackId: mainTrackId, name: '03 待生成', startFrame: 120, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
      sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotC, segmentGroupId: groupC, versionMode: 'follow'}},
    {id: silentClipId, trackId: mainTrackId, name: '04 无声片段', startFrame: 150, durationFrames: 60, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: silent.id, versionId: versionSilent, shotId: shotD,
      sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotD, segmentGroupId: groupD, versionMode: 'follow'}},
    {id: imageClipId, trackId: v2TrackId, name: '叠加画面', startFrame: 10, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: image.id, sourceState: 'ready',
      anchor: {clipId: copyClipId, offsetFrames: 10}},
  ];
  const tracks = [{id: mainTrackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: v2TrackId, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false},
    {id: audioTrackId, name: 'A1', kind: 'audio', orderIndex: 2, hidden: false, muted: false}];
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 210,
    createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootNode}, tracks, clips: timelineClips};
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const shot = (shotId: string, orderIndex: number, selectedVersionId: string | null, duration: number) =>
    ({id: shotId, projectId, orderIndex, selectedVersionId, duration, createdAt: at, updatedAt: at});
  const versionRow = (versionId: string, shotId: string, jobId: string, assetId: string, sha256: string) =>
    ({id: versionId, projectId, jobId, shotId, number: 1, assetId, sha256, createdAt: at});
  const shaOf = (row: Record<string, unknown>): string => String(row.sha256);
  const baseline = {version: 1,
    board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionCopy},
      {nodeId: shotB, kind: 'shot', selectedVersionId: versionTranscode},
      {nodeId: shotC, kind: 'shot', selectedVersionId: null},
      {nodeId: shotD, kind: 'shot', selectedVersionId: versionSilent}],
    track: [
      {nodeId: shotA, segmentGroupId: groupA, clipId: copyClipId, kind: 'shot', versionMode: 'follow', appliedVersionId: versionCopy},
      {nodeId: shotB, segmentGroupId: groupB, clipId: transcodeClipId, kind: 'shot', versionMode: 'follow', appliedVersionId: versionTranscode},
      {nodeId: shotC, segmentGroupId: groupC, clipId: placeholderClipId, kind: 'shot', versionMode: 'follow', appliedVersionId: null},
      {nodeId: shotD, segmentGroupId: groupD, clipId: silentClipId, kind: 'shot', versionMode: 'follow', appliedVersionId: versionSilent}]};
  const jobRow = (jobId: string, shotId: string, versionId: string) =>
    ({id: jobId, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId,
      versionId, createdAt: at, updatedAt: at});
  store.tx(() => {
    store.put('jobs', jobRow(jobA, shotA, versionCopy));
    store.put('jobs', jobRow(jobB, shotB, versionTranscode));
    store.put('jobs', jobRow(jobD, shotD, versionSilent));
    store.put('versions', versionRow(versionCopy, shotA, jobA, copy.id, shaOf(copy.row)));
    store.put('versions', versionRow(versionTranscode, shotB, jobB, transcode.id, shaOf(transcode.row)));
    store.put('versions', versionRow(versionSilent, shotD, jobD, silent.id, shaOf(silent.row)));
    store.put('shots', shot(shotA, 0, versionCopy, durationOf(copy.row)));
    store.put('shots', shot(shotB, 1, versionTranscode, durationOf(transcode.row)));
    store.put('shots', shot(shotC, 2, null, 1));
    store.put('shots', shot(shotD, 3, versionSilent, durationOf(silent.row)));
    store.put('nodes', node(imageNode, 'image', {assetId: image.id}));
    for (const [index, [from, to]] of [[rootNode, shotA], [shotA, shotB], [shotB, shotC], [shotC, shotD]].entries())
      store.put('edges', {id: id(80 + index), projectId, kind: 'sequence', source: from, target: to, createdAt: at});
  });
  // The timeline header and its native clip rows are committed separately so a
  // fence failure leaves the board provenance inspectable.
  store.tx(() => {
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootNode, 1, JSON.stringify(baseline));
  });
  const close = async (): Promise<void> => {
    await worker.stop();
    await services.drain();
    store.close();
    library.close();
    rmSync(directory, {recursive: true, force: true});
  };
  return {store, services, library, directory, mediaFiles, close};
}
