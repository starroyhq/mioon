/** FR-G «save clip sound as an audio asset»: local background task.
 *
 * The task rides the existing `exports` background-task channel with
 * `mode: 'clip-audio'`. Acceptance freezes the clip's current source range and
 * source hash in the row itself; the worker re-verifies the exact managed bytes,
 * extracts the audio with FFmpeg (stream-copying AAC or transcoding to the
 * export AAC profile), verifies the produced M4A, publishes it into the project
 * `素材` folder and registers one new audio asset with portable provenance.
 *
 * The source asset and clip are never modified. `assets` rows carry the source
 * record (`clipAudioSource`) so project copies/backups keep the provenance
 * without this task row.
 */
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, rmSync} from 'node:fs';
import path from 'node:path';
import {AppError, sourceFrameCount} from '@mioon/contracts';
import {createPrivateTemporaryDirectory} from '@mioon/contracts/private-storage';
import {
  CLIP_AUDIO_EXPORT_MODE, clipAudioExportRecordSchema, clipAudioExportSchemas,
} from '../../contracts/src/clip-audio-export.ts';
import type {ClipAudioExportRecord, ClipAudioExportRequest} from '../../contracts/src/clip-audio-export.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';
import {validAssetLocator} from './asset-reference-record.ts';
import {verifiedManagedHash} from './managed-media.ts';
import {fileInfo, probe} from './media.ts';
import {runStreaming} from './media-runtime.ts';
import {
  assertPublishedProjectOutput, markProjectOutputRegistered, publishProjectOutput,
  registerVerifiedProjectOutputs,
} from './project-output-publication.ts';
import {clipAudioAssetName, recordOutputLocale} from './output-asset-names.ts';
import {bindAgentTaskJobInside} from './agent/task-effects-v2.ts';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const isFormat5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function invalid(message: string, details: Row = {}): never {
  throw new AppError('INVALID_MEDIA', message, 409, details);
}
export function clipAudioExportRequestHash(input: ClipAudioExportRequest): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries({operation: 'clip.audio.export', input})
    .sort(([left], [right]) => left.localeCompare(right))));
  return createHash('sha256').update(canonical).digest('hex');
}

interface FrozenSource {
  readonly clipId: string; readonly clipName: string; readonly assetId: string; readonly assetSha256: string;
  readonly sizeBytes: number; readonly name: string; readonly mimeType: string;
  readonly sourceInFrame: number; readonly durationFrames: number; readonly fps: 30;
}

/** Freeze the clip's current source range and the exact owned bytes. */
export function freezeClipAudioSource(store: ProjectStore, clipId: string): FrozenSource {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) throw new AppError('NOT_FOUND', '片段不存在', 404, {clipId});
  const track = timeline.tracks.find(item => item.id === clip.trackId);
  if (!track || track.kind !== 'video') invalid('只有画面轨片段可以另存声音', {clipId});
  if (clip.sourceState !== 'ready') invalid('占位片段没有可另存的声音', {clipId});
  if (!uuid(clip.assetId)) invalid('片段没有可用的素材', {clipId});
  const row = store.db.prepare('SELECT id,data FROM project.assets WHERE id=?').get(clip.assetId) as {data?: unknown} | undefined;
  let asset: Row | null = null;
  try { asset = typeof row?.data === 'string' ? JSON.parse(row.data) as Row : null; } catch { asset = null; }
  if (!asset || asset.id !== clip.assetId || asset.projectId !== store.projectId || !validAssetLocator(store.db, asset)
    || asset.mimeType !== undefined && typeof asset.mimeType !== 'string' || !String(asset.mimeType ?? '').startsWith('video/')
    || asset.hasAudio !== true || !sha256(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || Number(asset.sizeBytes) < 1) {
    invalid('这个片段没有可另存的声音', {clipId, assetId: clip.assetId});
  }
  const frames = sourceFrameCount(asset.duration as never) ?? 0;
  if (clip.durationFrames < 1 || clip.sourceInFrame + clip.durationFrames > frames) invalid('片段范围超出素材', {clipId});
  return {clipId: clip.id, clipName: clip.name.slice(0, 200), assetId: clip.assetId as string,
    assetSha256: String(asset.sha256), sizeBytes: Number(asset.sizeBytes), name: String(asset.name ?? '').slice(0, 200),
    mimeType: String(asset.mimeType), sourceInFrame: clip.sourceInFrame, durationFrames: clip.durationFrames, fps: 30};
}

function readRecord(store: ProjectStore, exportId: string, projectId: string): ClipAudioExportRecord | null {
  const row = store.db.prepare('SELECT data FROM exports WHERE id=? AND projectId=? AND length(CAST(data AS BLOB))<=4194304')
    .get(exportId, projectId) as {data?: unknown} | undefined;
  let value: unknown = null;
  try { value = typeof row?.data === 'string' ? JSON.parse(row.data) : null; } catch { value = null; }
  const parsed = clipAudioExportRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Start one clip-audio export task. Replays the exact accepted row for the same
 * request id; a changed reuse conflicts instead of writing a second task. */
export function startClipAudioExport(store: ProjectStore, raw: unknown): ClipAudioExportRecord {
  const input = clipAudioExportSchemas['clip.audio.export'].parse(raw);
  if (input.projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
  const requestHash = clipAudioExportRequestHash(input);
  const replay = (): ClipAudioExportRecord | null => {
    const row = store.db.prepare("SELECT requestHash,resourceId FROM idempotency WHERE scope='clip-audio-export' AND requestId=?")
      .get(input.requestId) as {requestHash?: unknown; resourceId?: unknown} | undefined;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', '同一请求 ID 已用于不同内容', 409, {requestId: input.requestId});
    const existing = readRecord(store, String(row.resourceId), input.projectId);
    if (!existing) throw new AppError('IDEMPOTENCY_CONFLICT', '原任务记录不可用', 409, {requestId: input.requestId});
    return existing;
  };
  const accepted = replay();
  if (accepted) return accepted;
  return store.tx(() => {
    const again = replay();
    if (again) return again;
    const source = freezeClipAudioSource(store, input.clipId);
    const id = randomUUID(), createdAt = now();
    const record: ClipAudioExportRecord = {version: 1, id, projectId: input.projectId, requestId: input.requestId,
      mode: CLIP_AUDIO_EXPORT_MODE, status: 'queued', phase: 'preparing', progress: null, error: null,
      source, output: null, assetId: null, url: null, createdAt, updatedAt: createdAt};
    clipAudioExportRecordSchema.parse(record);
    store.put('exports', record);
    store.db.prepare("INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES('clip-audio-export',?,?,?)")
      .run(input.requestId, requestHash, id);
    recordOutputLocale(store.db, id, requestHash, input.outputLocale);
    bindAgentTaskJobInside(store.db, 'export', id);
    return record;
  });
}

export interface ClipAudioExportView {
  readonly record: ClipAudioExportRecord;
  readonly activity: {readonly projectId: string; readonly exportId: string; readonly status: string;
    readonly stage: 'queued' | 'preparing' | 'encoding' | 'finalizing' | 'complete' | 'failed' | 'cancelled';
    readonly progress: number | null; readonly elapsedSeconds: number; readonly cancelled: boolean};
}
/** Read the accepted task plus the same bounded activity descriptor the export
 * toast uses. No work is scheduled or resumed. */
export function getClipAudioExport(store: ProjectStore, raw: unknown): ClipAudioExportView {
  const input = clipAudioExportSchemas['clip.audio.export.get'].parse(raw);
  if (input.projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
  const record = readRecord(store, input.exportId, input.projectId);
  if (!record) throw new AppError('NOT_FOUND', '另存为音频素材任务不存在', 404);
  const finished = record.status === 'succeeded' || record.status === 'failed';
  const cancelled = record.status === 'failed' && record.error.code === 'EXPORT_CANCELLED';
  const stage = record.status === 'queued' ? 'queued' : record.status === 'succeeded' ? 'complete'
    : record.status === 'failed' ? (cancelled ? 'cancelled' : 'failed') : record.phase === 'preparing' ? 'preparing'
      : record.phase === 'finalizing' ? 'finalizing' : 'encoding';
  const start = Date.parse(record.createdAt), end = finished ? Date.parse(record.updatedAt) : Date.now();
  return {record, activity: {projectId: input.projectId, exportId: input.exportId, status: record.status, stage,
    progress: record.status === 'succeeded' ? 100 : record.status === 'queued' ? 0
      : record.status === 'failed' ? null : record.progress,
    elapsedSeconds: Math.max(0, (end - start) / 1000), cancelled}};
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const AAC_PROFILE = Object.freeze({codec: 'aac', bitrate: '128k', sampleRate: 48000, channels: 2});
const seconds = (frames: number): string => (frames / 30).toFixed(6);

function audioCodecOf(probeResult: Awaited<ReturnType<typeof probe>>): string | undefined {
  const stream = probeResult.probe.streams.find(item => item.codec_type === 'audio');
  return typeof stream?.codec_name === 'string' ? stream.codec_name : undefined;
}

export interface ClipAudioExportHooks {
  /** Fence before every file or child-process effect. */
  readonly beforeEffect: () => void;
  /** Owned row reader for this exact task id/request identity. */
  readonly latest: () => ClipAudioExportRecord | null;
  /** Guarded write while the task is still running; re-check inside the txn. */
  readonly save: (values: Row) => void;
  /** Atomic success write: the new asset row and the succeeded export row. */
  readonly succeed: (asset: Row, record: ClipAudioExportRecord) => void;
  readonly signal: AbortSignal;
}

function failureOf(error: unknown): {code: string; message: string; retryable: boolean} {
  const value = error as {code?: unknown; message?: unknown} | null;
  const code = typeof value?.code === 'string' ? value.code : '';
  if (code.startsWith('MANAGED_') || ['MEDIA_MISSING', 'MEDIA_CHANGED', 'MEDIA_CHANGED_DURING_READ', 'MEDIA_NOT_MEDIA'].includes(code)) {
    return {code: 'CLIP_AUDIO_SOURCE_UNAVAILABLE', message: '源素材不可用或已改变', retryable: true};
  }
  if (code === 'MEDIA_PROCESS_FAILED' || code === 'MEDIA_TIMEOUT' || code === 'MEDIA_SPAWN_FAILED') {
    return {code: 'CLIP_AUDIO_ENCODE_FAILED', message: '音频编码没有完成', retryable: true};
  }
  if (code === 'MEDIA_INVALID_METADATA' || code === 'MEDIA_NO_STREAM' || code === 'MEDIA_INVALID_CONFIGURATION') {
    return {code: 'CLIP_AUDIO_UNSUPPORTED', message: '这个片段的声音格式不支持', retryable: false};
  }
  const message = typeof value?.message === 'string' && value.message.length <= 600 ? value.message : '音频素材没有生成';
  return {code: code || 'CLIP_AUDIO_ENCODE_FAILED', message, retryable: true};
}

/** FFmpeg `-progress` reports `out_time_ms` in microseconds: its historical name
 * is misleading and `out_time_us` carries the same microsecond value. Read
 * either key so the reported elapsed time is never mistaken for milliseconds. */
export function clipAudioProgressMicroseconds(line: string): number | null {
  const match = /^out_time_(?:us|ms)=(\d+)$/u.exec(line);
  return match ? Number(match[1]) : null;
}

/** Bounded integer percentage of the frozen clip duration for one elapsed
 * microsecond reading; 99 is the ceiling while the task is still encoding. */
export function clipAudioEncodeProgress(outTimeMicroseconds: number, totalMs: number): number {
  if (!Number.isFinite(outTimeMicroseconds) || outTimeMicroseconds < 0 || !Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor(outTimeMicroseconds / 1000 / totalMs * 100)));
}

/** One accepted task. Re-verifies source bytes, extracts/copies the sound,
 * verifies the produced file, publishes it and registers the asset. The export
 * row is only marked succeeded in the publication registration transaction. */
export async function runClipAudioExport(store: ProjectStore, record: ClipAudioExportRecord, hooks: ClipAudioExportHooks): Promise<void> {
  const {signal} = hooks;
  let work: string | undefined;
  const save = (values: Row): void => hooks.save({...values, updatedAt: now()});
  try {
    hooks.beforeEffect();
    const sourceRow = store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(record.source.assetId) as {data?: unknown} | undefined;
    let asset: Row | null = null;
    try { asset = typeof sourceRow?.data === 'string' ? JSON.parse(sourceRow.data) as Row : null; } catch { asset = null; }
    if (!asset || asset.id !== record.source.assetId || asset.projectId !== store.projectId
      || !validAssetLocator(store.db, asset) || asset.sha256 !== record.source.assetSha256
      || asset.sizeBytes !== record.source.sizeBytes) invalid('源素材与已接受的任务不一致', {assetId: record.source.assetId});
    const verified = await verifiedManagedHash(store.root, asset as never, {signal, beforeEffect: hooks.beforeEffect,
      maxBytes: 8 * 1024 ** 3});
    const codec = audioCodecOf(await probe(verified.file, {signal, beforeEffect: hooks.beforeEffect}));
    if (!codec) invalid('源素材没有音频流', {assetId: record.source.assetId});
    const mode = codec === 'aac' ? 'copy' as const : 'transcode' as const;
    save({phase: mode === 'copy' ? 'copying' : 'encoding'});
    work = createPrivateTemporaryDirectory(store.tempDir, 'clip-audio-');
    const stage = path.join(work, 'clip-sound.m4a');
    const totalMs = (record.source.durationFrames / 30) * 1000;
    let lastReported = 0;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', seconds(record.source.sourceInFrame), '-t', seconds(record.source.durationFrames),
      '-i', verified.file, '-vn', '-map', '0:a:0', '-progress', 'pipe:1', '-nostats',
      ...(mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', AAC_PROFILE.codec, '-b:a', AAC_PROFILE.bitrate,
        '-ar', String(AAC_PROFILE.sampleRate), '-ac', String(AAC_PROFILE.channels)]),
      '-movflags', '+faststart', stage];
    let pending = '';
    await runStreaming('ffmpeg', args, {signal, beforeEffect: hooks.beforeEffect,
      onStdout: (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const microseconds = clipAudioProgressMicroseconds(line);
          if (microseconds === null) continue;
          const progress = clipAudioEncodeProgress(microseconds, totalMs);
          if (progress > lastReported) {lastReported = progress; save({progress});}
        }
      }});
    hooks.beforeEffect();
    // The publication path accepts only an owner-private staging file; FFmpeg
    // creates its output under the process umask, so pin the mode here.
    chmodSync(stage, 0o600);
    const info = await fileInfo(stage, {signal, beforeEffect: hooks.beforeEffect});
    const outputProbe = await probe(stage, {signal, beforeEffect: hooks.beforeEffect});
    const outputCodec = audioCodecOf(outputProbe);
    const expectedSeconds = record.source.durationFrames / 30;
    if (!outputProbe.hasAudio || outputProbe.hasVideo || outputCodec !== 'aac' || info.sizeBytes < 1
      || Math.abs(outputProbe.duration - expectedSeconds) > Math.max(0.25, 3 / 30)) {
      invalid('生成的音频文件无法核对', {assetId: record.source.assetId});
    }
    save({phase: 'finalizing', progress: 99});
    const assetId = randomUUID();
    const owner = {kind: 'export' as const, id: record.id, requestId: record.requestId,
      inputHash: createHash('sha256').update(JSON.stringify([record.id, record.requestId, record.source]))
        .digest('hex')};
    const displayName = clipAudioAssetName(store.db, {id: record.id, projectId: record.projectId},
      record.source.name.trim() || record.source.clipName);
    const published = await publishProjectOutput(store, {owner, assetId, targetKind: 'assets', stageFile: stage,
      mimeType: 'audio/mp4', sha256: info.sha256, sizeBytes: info.sizeBytes, displayName}, {signal, beforeEffect: hooks.beforeEffect});
    const createdAt = now();
    const clipAudioSource = {clipId: record.source.clipId, sourceAssetId: record.source.assetId,
      sourceHash: record.source.assetSha256, sourceInFrame: record.source.sourceInFrame,
      durationFrames: record.source.durationFrames, fps: 30 as const, taskId: record.id, mode};
    const assetRow: Row = {id: assetId, projectId: record.projectId, name: displayName, mimeType: 'audio/mp4',
      reference: published.reference, referenceRevision: 1, sizeBytes: published.sizeBytes, sha256: published.sha256,
      duration: outputProbe.duration, hasAudio: true, hasVideo: false, publication: published.publication,
      provenance: 'clip-audio', clipAudioSource, url: `/media/${assetId}`, createdAt};
    const success: ClipAudioExportRecord = {...record, status: 'succeeded', phase: 'finalizing', progress: 100,
      error: null, output: {assetId, sha256: published.sha256, sizeBytes: published.sizeBytes, mimeType: 'audio/mp4',
        mode, durationSeconds: outputProbe.duration}, assetId, url: `/media/${assetId}`, updatedAt: now()};
    clipAudioExportRecordSchema.parse(success);
    await registerVerifiedProjectOutputs(store, {signal, beforeEffect: hooks.beforeEffect}, () => {
      assertPublishedProjectOutput(store, published.publication);
      hooks.succeed(assetRow, success);
    });
    await markProjectOutputRegistered(store, published.publication, {signal, beforeEffect: hooks.beforeEffect});
  } catch (error) {
    const latest = hooks.latest();
    if (!latest || latest.status !== 'running') return;
    if (signal.aborted) {
      // Worker shutdown before publication: keep the accepted task requeueable.
      save({status: 'queued', phase: 'preparing', progress: null, error: null});
      return;
    }
    const failure = failureOf(error);
    save({status: 'failed', error: failure});
  } finally {
    if (work) {try {rmSync(work, {recursive: true, force: true});} catch { /* keep the private staging */ }}
  }
}
