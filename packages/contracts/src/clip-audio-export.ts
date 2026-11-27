/** FR-G «save clip sound as an audio asset»: one local background task.
 *
 * The task rides the existing `exports` background-task channel under
 * `mode: 'clip-audio'`, so progress/elapsed/cancel, the task center and the
 * idempotent acceptance all reuse the reviewed export plumbing without a schema
 * migration. It reads the clip's current source range, copies AAC sound as-is or
 * transcodes it with the export audio profile, and publishes one new audio asset
 * into the project file with a portable source record.
 */
import {z} from 'zod';
import {outputLocaleSchema} from './output-locale.ts';
import {timelineFpsSchema} from './timeline-fps.ts';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value)));
const count = (min: number, max = Number.MAX_SAFE_INTEGER): z.ZodNumber =>
  z.number().int().safe().min(min).max(max);
const requestId = z.string().min(8).max(200);

export const CLIP_AUDIO_EXPORT_MODE = 'clip-audio' as const;
export const CLIP_AUDIO_EXPORT_MIME = 'audio/mp4' as const;

export const clipAudioExportSchemas = Object.freeze({
  'clip.audio.export': z.object({
    projectId: uuid,
    requestId,
    clipId: uuid,
    outputLocale: outputLocaleSchema.optional(),
  }).strict(),
  'clip.audio.export.get': z.object({projectId: uuid, exportId: uuid}).strict(),
});

export const clipAudioExportDescriptions: Readonly<Record<string, string>> = Object.freeze({
  'clip.audio.export': '把格式 5 片段当前范围的声音另存为项目内音频素材：AAC 原样拷贝，其他编码按导出音频设置转成 AAC。后台本地任务，可取消；完成后新增一个带来源范围与源哈希的音频素材，原素材和片段不变。不联网、不调用模型、不付费。',
  'clip.audio.export.get': '只读查询本条另存为音频素材任务的记录与本地进度；不启动、不取消、不重试任务。',
});

/** The source range is stored on the project timeline clock when the task is
 * accepted. Its saved fps keeps those frames meaningful across retries and copies. */
const sourceSchema = z.object({
  clipId: uuid,
  clipName: z.string().min(1).max(200),
  assetId: uuid,
  assetSha256: hash,
  sizeBytes: count(1),
  name: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120),
  sourceInFrame: count(0),
  durationFrames: count(1),
  fps: timelineFpsSchema,
}).strict();

const outputSchema = z.object({
  assetId: uuid,
  sha256: hash,
  sizeBytes: count(1),
  mimeType: z.literal(CLIP_AUDIO_EXPORT_MIME),
  /** `copy`: the source audio stream is AAC and was stream-copied; `transcode`:
   * it was re-encoded with the export AAC profile (128 kbps, 48 kHz, stereo). */
  mode: z.enum(['copy', 'transcode']),
  durationSeconds: z.number().finite().positive(),
}).strict();

const errorSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(600),
  retryable: z.boolean(),
}).strict();

export const clipAudioExportPhaseSchema = z.enum(['preparing', 'copying', 'encoding', 'finalizing']);
export type ClipAudioExportPhase = z.infer<typeof clipAudioExportPhaseSchema>;
export const clipAudioExportStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);

const base = {
  version: z.literal(1),
  id: uuid,
  projectId: uuid,
  requestId,
  mode: z.literal(CLIP_AUDIO_EXPORT_MODE),
  source: sourceSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const clipAudioExportRecordSchema = z.discriminatedUnion('status', [
  z.object({...base, status: z.literal('queued'), phase: z.literal('preparing'), progress: z.null(),
    error: z.null(), output: z.null(), assetId: z.null(), url: z.null()}).strict(),
  z.object({...base, status: z.literal('running'), phase: clipAudioExportPhaseSchema,
    progress: z.number().int().min(0).max(100).nullable(), error: z.null(), output: z.null(),
    assetId: z.null(), url: z.null()}).strict(),
  z.object({...base, status: z.literal('succeeded'), phase: z.literal('finalizing'), progress: z.literal(100),
    error: z.null(), output: outputSchema, assetId: uuid, url: z.string().min(1).max(4096)}).strict(),
  z.object({...base, status: z.literal('failed'), phase: clipAudioExportPhaseSchema,
    progress: z.number().int().min(0).max(100).nullable(), error: errorSchema, output: z.null(),
    assetId: z.null(), url: z.null()}).strict(),
]);
export type ClipAudioExportRecord = z.infer<typeof clipAudioExportRecordSchema>;
export const isClipAudioExportRecord = (value: unknown): value is ClipAudioExportRecord =>
  clipAudioExportRecordSchema.safeParse(value).success;
export type ClipAudioExportRequest = z.infer<(typeof clipAudioExportSchemas)['clip.audio.export']>;
export type ClipAudioExportGetRequest = z.infer<(typeof clipAudioExportSchemas)['clip.audio.export.get']>;

/** Portable provenance stored on the produced `project.assets` row itself, so a
 * project copy or backup keeps the source range without the task row. */
export const clipAudioSourceSchema = z.object({
  clipId: uuid,
  sourceAssetId: uuid,
  sourceHash: hash,
  sourceInFrame: count(0),
  durationFrames: count(1),
  fps: timelineFpsSchema,
  taskId: uuid,
  mode: z.enum(['copy', 'transcode']),
}).strict();
export type ClipAudioSource = z.infer<typeof clipAudioSourceSchema>;

/** One inert staging file name per accepted task; the publication step owns the
 * final project-relative location. */
export const clipAudioExportStageFileName = 'clip-sound.m4a';
