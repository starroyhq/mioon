import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {clipTimingSchema, speedProcessingKindSchema, speedProcessingReasonSchema} from './timeline-speed.ts';
import type {ClipTiming} from './timeline-speed.ts';

export const processingDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const mapHash = z.string().regex(/^[0-9a-f]{16}$/u);
const integer = z.number().int().safe().nonnegative();
const timebase = z.object({fpsNumerator: integer.positive(), fpsDenominator: integer.positive()}).strict();
const window = z.object({startFrame: integer, endFrame: integer.positive(), frameCount: integer.positive(),
  direction: z.enum(['forward', 'reverse']), outputFromFrame: integer, outputToFrame: integer.positive()}).strict();
const audioWindow = z.object({fromSample: integer, toSample: integer.positive()}).strict()
  .refine(value => value.toSample > value.fromSample);
const timing: z.ZodType<ClipTiming> = clipTimingSchema;
const opticalWindow = z.object({timing: clipTimingSchema.options[0], beforeFrames: integer, afterFrames: integer,
  sourceFrames: integer.positive()}).strict();
export const processingInputSchema = z.object({
  version: z.literal(1), kind: speedProcessingKindSchema, timelineId: projectIdSchema,
  assetId: projectIdSchema.nullable(), sourceIdentity: processingDigestSchema.nullable(), sourceSha256: processingDigestSchema.nullable(),
  sourceStat: processingDigestSchema.optional(),
  media: z.enum(['video', 'audio']).nullable(), mapHash: mapHash.nullable(),
  sourceWindow: window.nullable(), sourceFps: timebase.nullable(), recipe: processingDigestSchema,
  audioWindow: audioWindow.optional(), pictureWindow: window.optional(), timing: timing.optional(),
  optical: opticalWindow.optional(),
}).strict()
  .refine(value => value.kind !== 'preview' || value.timing !== undefined, {path: ['timing']})
  .refine(value => value.kind === 'reverse' || value.pictureWindow === undefined, {path: ['pictureWindow']});
export type ProcessingInput = z.infer<typeof processingInputSchema>;
export const processingReasonSchema = speedProcessingReasonSchema;
const taskState = z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']);
export type ProcessingTaskState = z.infer<typeof taskState>;
export const processingResultSchema = z.object({cacheKey: processingDigestSchema, sourceSha256: processingDigestSchema,
  sourceStat: processingDigestSchema.optional(), verifiedProxy: processingDigestSchema.optional(),
}).strict();
export type ProcessingTaskResult = z.infer<typeof processingResultSchema>;
export const processingRowSchema = z.object({
  id: projectIdSchema, projectId: projectIdSchema, kind: speedProcessingKindSchema, demandKey: processingDigestSchema,
  state: taskState, revision: integer.positive(), requestId: z.string().min(8).max(200),
  input: z.string().max(65536), progress: integer.max(100).nullable(), errorCode: processingReasonSchema.nullable(),
  result: z.string().max(16384).nullable(), updatedAt: z.string().length(24),
}).strict();
export type ProcessingTaskRow = z.infer<typeof processingRowSchema>;
export const processingInputWithClipSchema = z.object({
  clipId: projectIdSchema, frozen: processingInputSchema, outcomeReason: z.literal('INTERPOLATION_UNAVAILABLE').optional(),
}).strict();
export type ProcessingInputWithClip = z.infer<typeof processingInputWithClipSchema>;

export const PROCESSING_REVERSE_PROXY_PROFILE = 'timeline-reverse-source-v1';
export const PROCESSING_PREVIEW_PROXY_PROFILE = 'timeline-preview-output-v1';
const reverseFileName = z.enum(['proxy.mkv', 'clock.json', 'frames.jsonl', 'video.raw', 'audio.f32le']);
const previewFileName = z.enum(['preview.mp4', 'clock.json']);
const opticalFileName = z.enum(['proxy.mkv', 'clock.json']);
export const processingProxyResultSchema = z.discriminatedUnion('profileId', [
  z.object({profileId: z.literal(PROCESSING_REVERSE_PROXY_PROFILE), mapHash, frameCount: integer, sampleCount: integer,
    files: z.array(z.object({fileName: reverseFileName, bytes: integer, sha256: processingDigestSchema}).strict()).min(2).max(5),
  }).strict(),
  z.object({profileId: z.literal(PROCESSING_PREVIEW_PROXY_PROFILE), mapHash, frameCount: integer.positive(), sampleCount: z.literal(0),
    files: z.array(z.object({fileName: previewFileName, bytes: integer.positive(), sha256: processingDigestSchema}).strict()).length(2),
  }).strict(),
  z.object({profileId: z.literal('timeline-optical-output-v1'), mapHash, frameCount: integer.positive(),
    firstOutputFrame: z.number().int().safe(), sampleCount: z.literal(0),
    files: z.array(z.object({fileName: opticalFileName, bytes: integer, sha256: processingDigestSchema}).strict()).length(2),
  }).strict(),
]).refine(value => new Set(value.files.map(file => file.fileName)).size === value.files.length &&
  value.files.some(file => file.fileName === 'clock.json') && (value.profileId !== PROCESSING_REVERSE_PROXY_PROFILE ||
    value.files.some(file => ['proxy.mkv', 'video.raw', 'audio.f32le'].includes(file.fileName))));
export type ProcessingProxyProfile = z.infer<typeof processingProxyResultSchema>['profileId'];
export const processingCacheReceiptSchema = z.object({
  version: z.literal(1), projectId: projectIdSchema, cacheKey: processingDigestSchema, result: processingProxyResultSchema,
}).strict();
export type ProcessingCacheReceipt = z.infer<typeof processingCacheReceiptSchema>;
export const PROCESSING_CACHE_MAX_ENTRIES = 4096;
export const processingCachePinsSchema = z.array(processingDigestSchema).max(PROCESSING_CACHE_MAX_ENTRIES);

const stagePid = integer.positive().max(0x7fffffff);
const storageIdentity = z.string().min(1).max(160);
export const processingStageOwnershipSchema = z.object({
  version: z.literal(1),
  projectId: projectIdSchema, taskId: projectIdSchema, requestId: z.string().min(8).max(200), cacheKey: processingDigestSchema,
  stage: z.string().regex(/^stage-[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/u),
  directoryIdentity: storageIdentity, directoryBirthtime: z.number().finite().positive().nullable(),
  rootIdentity: storageIdentity, hostPid: stagePid,
  writers: z.array(z.object({id: projectIdSchema, pid: stagePid.nullable()}).strict()).max(16),
}).strict().refine(value => new Set(value.writers.map(writer => writer.id)).size === value.writers.length);
export type ProcessingStageOwnership = z.infer<typeof processingStageOwnershipSchema>;
export const processingStageMarkerSchema = z.object({ownership: processingStageOwnershipSchema, mac: processingDigestSchema}).strict();
