import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {composeProjectRuntime, type ProjectRuntime} from './helpers/test-server.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createAppCompanionDocuments} from '../packages/business/src/companion-scope.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import type {ServiceApplicationPorts} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {timelineSnapshotHash} from '../packages/business/src/timeline-preflight.ts';
import {validateProjectRetainedRows} from '../packages/business/src/project-retained-validation.ts';
import {validateTimelineAudioRoleRows} from '../packages/business/src/timeline-retained-audio-role.ts';
import {validateTimelineColourRows} from '../packages/business/src/timeline-retained-colour.ts';
import {validateTimelineVolumeEnvelopeRows} from '../packages/business/src/timeline-retained-volume-envelope.ts';
import {clipAudioExportRecordSchema} from '../packages/contracts/src/clip-audio-export.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

/** A real format-5 project file re-opened through the production server
 * assembly. It carries every row the «clip sound» card writes: a muted source
 * clip, the separated `soundOnly` audio clip anchored to it, one timeline video
 * export record whose frozen snapshot contains both, and one succeeded plus one
 * failed «save clip sound» task in the shared `exports` table. The three
 * retained-row scanners (volume envelope, audio role, colour) read this file
 * again on open, so the format-5-only clip flags must survive that admission. */
const projectId = '92000000-0000-4000-8000-000000000001';
const rootId = '92000000-0000-4000-8000-000000000002';
const shotId = '92000000-0000-4000-8000-000000000003';
const jobId = '92000000-0000-4000-8000-000000000004';
const versionId = '92000000-0000-4000-8000-000000000005';
const assetId = '92000000-0000-4000-8000-000000000006';
const timelineId = '92000000-0000-4000-8000-000000000007';
const videoTrack = '92000000-0000-4000-8000-000000000008';
const audioTrack = '92000000-0000-4000-8000-000000000009';
const groupId = '92000000-0000-4000-8000-00000000000a';
const videoClip = '92000000-0000-4000-8000-00000000000b';
const soundClip = '92000000-0000-4000-8000-00000000000c';
const edgeId = '92000000-0000-4000-8000-00000000000d';
const succeededTaskId = '92000000-0000-4000-8000-00000000000f';
const failedTaskId = '92000000-0000-4000-8000-000000000010';
const sourceSha = 'a'.repeat(64);
const audioSha = 'b'.repeat(64);
const at = '2026-01-01T00:00:00.000Z';
const envelope = Object.freeze({profileId: 'mioon-clip-linear-attenuation-v1', points: Object.freeze([{frame: 0, multiplier: 1}])});

const temporary = (): string => mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-clip-sound-reopen-'));
function testApplication(library: ReturnType<typeof openAppLibrary>): ServiceApplicationPorts {
  const configuration = createWorkspaceConfiguration({root: library.dataDir, documents: createAppCompanionDocuments(library)});
  const assertOwner = createProjectServiceApplication(library).assertMutationAllowed;
  return {configuration, outsidePaths: library.outsidePaths, receipts: library.receipts, assertMutationAllowed() {
    assertOwner(); assert.equal(library.db.isOpen, true, 'the real application connection must still own admission');
  }};
}
interface RuntimeFixture {runtime: ProjectRuntime; library: ReturnType<typeof openAppLibrary>; shutdown: AbortController;
  close(): Promise<void>}
async function composeExisting(t: TestContext, store: ReturnType<typeof openProjectStore>,
  root: string): Promise<RuntimeFixture> {
  mkdirSync(path.join(root, 'cache'), {recursive: true, mode: 0o700});
  mkdirSync(path.join(root, 'tmp'), {recursive: true, mode: 0o700});
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const shutdown = new AbortController();
  const identity = library.projectFileIdentity(store.projectFile);
  assert.ok(identity);
  library.registry.upsert({projectId: store.projectId, projectFile: store.projectFile, fileIdentity: identity,
    name: 'Format 5 clip sound', lastOpenedAt: null, summary: null});
  const deletionGate = createProjectDeletionGate({signal: shutdown.signal, subscribeMedia: onMediaProcess,
    busy: () => { throw new Error('project busy'); }});
  const runtime = await composeProjectRuntime({store, shutdown, deletionGate, port: 4319,
    serverPort: () => 4319, listeningPort: () => 4319, comfyModule: 'skip' as const,
    privateMediaDirectories: [library.dataDir, path.join(root, 'cache'), path.join(root, 'tmp')],
    application: library, serviceApplication: testApplication(library)});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    runtime.taskRuntimeV2?.close(); runtime.taskHttpV2?.close();
    await runtime.serviceDrain(); await runtime.editTasks.drain(); await runtime.closeSettings();
    runtime.taskToolsV2?.dispose();
    try {store.close();} finally {library.close();}
  };
  t.after(close);
  return {runtime, library, shutdown, close};
}

/** The seeded rows mirror the accepted service output: same asset/version/job
 * ownership, one main-track video clip and one anchored sound-only audio clip. */
function seed(store: ReturnType<typeof createProjectStore>): void {
  store.tx(() => {
    store.put('projects', {id: projectId, name: '片段自带的声音重开', description: '', revision: 1, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotId, projectId, title: 'Shot A', prompt: '', referenceAssetIds: [], aspectRatio: '9:16',
      duration: 2, parameters: {}, position: {x: 0, y: 0}, orderIndex: 0, revision: 1, selectedVersionId: versionId,
      createdAt: at, updatedAt: at});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    store.put('edges', {id: edgeId, projectId, kind: 'sequence', source: rootId, target: shotId, createdAt: at});
    store.put('jobs', {id: jobId, projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock',
      shotId, createdAt: at, updatedAt: at});
    store.put('assets', {id: assetId, projectId, name: 'take.mp4', mimeType: 'video/mp4', duration: 2,
      sha256: sourceSha, sizeBytes: 1024, hasAudio: true, hasVideo: true, referenceRevision: 1,
      reference: {pathForm: 'relative', path: 'media/take.mp4', volume: null, sizeBytes: 1024, mtimeMs: 0,
        sampledSha256: sourceSha, fullSha256: sourceSha}});
    store.put('versions', {id: versionId, projectId, jobId, shotId, number: 1, assetId, sha256: sourceSha, createdAt: at});
    // The real service output: the source clip is muted and keeps its gain,
    // envelope and audio role; the separated clip only takes the sound of the
    // same video asset and is anchored to its owner.
    store.put('timelines', {id: timelineId, projectId, revision: 1, fps: 30, width: 720, height: 1280,
      durationFrames: 60, createdAt: at, updatedAt: at,
      mainTrack: {trackId: videoTrack, sequenceNodeId: rootId},
      tracks: [
        {id: videoTrack, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
        {id: audioTrack, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false},
      ],
      clips: [
        {id: videoClip, trackId: videoTrack, name: 'Shot A', assetId, versionId, shotId, startFrame: 0,
          durationFrames: 60, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
          sourceState: 'ready', muted: true, audioRole: 'human', volumeEnvelope: envelope,
          sequenceSource: {kind: 'shot', nodeId: shotId, segmentGroupId: groupId, versionMode: 'locked'}},
        {id: soundClip, trackId: audioTrack, name: 'Shot A · 声音', assetId, startFrame: 0, durationFrames: 60,
          sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, sourceState: 'ready',
          soundOnly: true, audioRole: 'human', volumeEnvelope: envelope, anchor: {clipId: videoClip, offsetFrames: 0}},
      ]});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1,
        board: [{nodeId: shotId, kind: 'shot', selectedVersionId: versionId}],
        track: [{nodeId: shotId, segmentGroupId: groupId, clipId: videoClip, kind: 'shot',
          versionMode: 'locked', appliedVersionId: versionId}]}));
  });
  // Queue the real timeline.render receipt through the production handler, then
  // terminal-fail it so the re-open worker never dispatches a synthetic render.
  const timeline = store.get('timelines', timelineId) as {revision: number};
  const services = createTimelineServices(store as never, {
    required: (table: string, id: string) => {const value = store.get(table, id); if (!value) throw new AppError('NOT_FOUND', 'Missing', 404); return value;},
    check: (value: {revision?: unknown}, revision?: unknown) => {if (value.revision !== revision) throw new AppError('REVISION_CONFLICT', 'Changed', 409);},
    hash: (value: unknown) => timelineSnapshotHash(value),
    now: () => at,
    beforeEffect: () => undefined,
  } as never);
  const render = services.handlers['timeline.render']!({projectId, expectedRevision: timeline.revision,
    requestId: 'clip-sound-reopen-render-0001', purpose: 'export'} as never, {}) as Record<string, unknown> & {
      id: string; snapshot: {timeline: {clips: Record<string, unknown>[]}}};
  const exported = render.snapshot.timeline.clips;
  assert.ok(exported.some(clip => clip.muted === true), 'the frozen export snapshot carries the muted source clip');
  assert.ok(exported.some(clip => clip.soundOnly === true), 'the frozen export snapshot carries the sound-only clip');
  store.put('exports', {...render, status: 'failed',
    error: {code: 'EXPORT_FAILED', message: '测试记录：合成渲染未运行', retryable: true},
    updatedAt: '2026-01-01T00:00:01.000Z'});
  const clipAudio = (id: string, requestId: string) => ({version: 1 as const, id, projectId, requestId,
    mode: 'clip-audio' as const,
    source: {clipId: videoClip, clipName: 'Shot A', assetId, assetSha256: sourceSha, sizeBytes: 1024,
      name: 'take.mp4', mimeType: 'video/mp4', sourceInFrame: 0, durationFrames: 60, fps: 30 as const},
    createdAt: at, updatedAt: '2026-01-01T00:00:02.000Z'});
  const succeeded = {...clipAudio(succeededTaskId, 'clip-sound-reopen-audio-0001'), status: 'succeeded' as const,
    phase: 'finalizing' as const, progress: 100 as const, error: null, output: {assetId: '92000000-0000-4000-8000-000000000011',
      sha256: audioSha, sizeBytes: 2048, mimeType: 'audio/mp4' as const, mode: 'copy' as const, durationSeconds: 2},
    assetId: '92000000-0000-4000-8000-000000000011', url: '/media/92000000-0000-4000-8000-000000000011'};
  const failed = {...clipAudio(failedTaskId, 'clip-sound-reopen-audio-0002'), status: 'failed' as const,
    phase: 'encoding' as const, progress: 42 as const,
    error: {code: 'EXPORT_FAILED', message: '音频素材写入失败', retryable: true},
    output: null, assetId: null, url: null};
  assert.ok(clipAudioExportRecordSchema.safeParse(succeeded).success);
  assert.ok(clipAudioExportRecordSchema.safeParse(failed).success);
  store.put('exports', succeeded);
  store.put('exports', failed);
}

test('a format-5 project with muted/sound-only clips, its video export and clip-audio tasks reopens', async t => {
  const root = temporary();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')};
  const store = createProjectStore({projectId, targetFormat: 5, projectFile: path.join(root, 'project.mioon'),
    locate: () => location});
  t.after(() => {try {store.close();} catch {}});
  seed(store);
  // The first assembly is the production open path; it validates the seeded
  // retained rows before the deliberate close.
  const first = await composeExisting(t, store, root);
  await first.close();
  // A second assembly on the same file is the real reopen path.
  const reopened = openProjectStore({projectFile: path.join(root, 'project.mioon'), locate: () => location});
  const second = await composeExisting(t, reopened, root);
  const project = await second.runtime.serviceCall('project.get', {projectId}) as {project: {id: string};
    timeline?: {clips: {id: string; muted?: boolean; soundOnly?: boolean; gain?: number; volumeEnvelope?: unknown; audioRole?: unknown}[]}};
  assert.equal(project.project.id, projectId);
  const clips = project.timeline?.clips ?? [];
  assert.equal(clips.find(clip => clip.id === videoClip)?.muted, true, 'the muted source clip survives the reopen');
  assert.equal(clips.find(clip => clip.id === soundClip)?.soundOnly, true, 'the separated sound-only clip survives the reopen');
  const source = clips.find(clip => clip.id === videoClip)!;
  assert.equal(source.gain, 1, 'the gain is preserved next to the mute flag');
  assert.deepEqual(source.volumeEnvelope, envelope, 'the volume envelope survives the reopen');
  assert.equal(source.audioRole, 'human', 'the audio role survives the reopen');
  const rows = reopened.db.prepare('SELECT id,data FROM exports WHERE projectId=? ORDER BY id').all(projectId)
    .map(row => JSON.parse(String(row.data)) as Record<string, unknown>);
  assert.equal(rows.length, 3, 'one video export record plus the succeeded and failed clip-audio tasks');
  const render = rows.find(row => row.mode === 'timeline');
  assert.ok(render, 'the video export record is retained in the exports table');
  assert.equal(render!.status, 'failed');
  const frozen = (render!.snapshot as {timeline?: {clips?: Record<string, unknown>[]}}).timeline?.clips ?? [];
  assert.ok(frozen.some(clip => clip.muted === true) && frozen.some(clip => clip.soundOnly === true),
    'the retained export snapshot still carries both clip sound flags');
  const clipAudio = rows.filter(row => row.mode === 'clip-audio');
  assert.equal(clipAudio.length, 2);
  assert.deepEqual(clipAudio.map(row => row.status).sort(), ['failed', 'succeeded']);
  for (const row of clipAudio) assert.ok(clipAudioExportRecordSchema.safeParse(row).success);
  // The three format-aware retained-row scanners read the same exports rows.
  assert.doesNotThrow(() => validateTimelineVolumeEnvelopeRows(reopened.db));
  assert.doesNotThrow(() => validateTimelineAudioRoleRows(reopened.db));
  assert.doesNotThrow(() => validateTimelineColourRows(reopened.db));
  assert.doesNotThrow(() => validateProjectRetainedRows(reopened));
});
