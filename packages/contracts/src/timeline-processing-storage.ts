import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {clipTimingSchema} from './timeline-speed.ts';

export const processingDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const mapHash = z.string().regex(/^[0-9a-f]{16}$/u);
const integer = z.number().int().safe().nonnegative();
const timebase = z.object({fpsNumerator: integer.positive(), fpsDenominator: integer.positive()}).strict();
const window = z.object({startFrame: integer, endFrame: integer.positive(), frameCount: integer.positive(),
  direction: z.enum(['forward', 'reverse']), outputFromFrame: integer, outputToFrame: integer.positive()}).strict();
const opticalTiming = clipTimingSchema.options[0];
const opticalWindow = z.object({timing: opticalTiming, beforeFrames: integer, afterFrames: integer,
  sourceFrames: integer.positive()}).strict();
export const processingInputSchema = z.object({
  version: z.literal(1), kind: z.enum(['reverse', 'optical']), timelineId: projectIdSchema,
  assetId: projectIdSchema.nullable(), sourceIdentity: processingDigestSchema.nullable(), sourceSha256: processingDigestSchema.nullable(),
  sourceStat: processingDigestSchema.optional(),
  media: z.enum(['video', 'audio']).nullable(), mapHash: mapHash.nullable(),
  sourceWindow: window.nullable(), sourceFps: timebase.nullable(), recipe: processingDigestSchema,
  optical: opticalWindow.optional(),
}).strict();
export type ProcessingInput = z.infer<typeof processingInputSchema>;
export const processingReasonSchema = z.enum(['SOURCE_UNAVAILABLE', 'DISK_FULL', 'CACHE_LIMIT', 'UNSUPPORTED_FORMAT', 'PROCESSING_FAILED']);
const taskState = z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']);
export type ProcessingTaskState = z.infer<typeof taskState>;
export const processingResultSchema = z.object({cacheKey: processingDigestSchema, sourceSha256: processingDigestSchema,
  verifiedProxy: processingDigestSchema.optional()}).strict();
export type ProcessingTaskResult = z.infer<typeof processingResultSchema>;
export const processingRowSchema = z.object({
  id: projectIdSchema, projectId: projectIdSchema, kind: z.enum(['reverse', 'optical']), demandKey: processingDigestSchema,
  state: taskState, revision: integer.positive(), requestId: z.string().min(8).max(200),
  input: z.string().max(65536), progress: integer.max(100).nullable(), errorCode: processingReasonSchema.nullable(),
  result: z.string().max(16384).nullable(), updatedAt: z.string().length(24),
}).strict();
export type ProcessingTaskRow = z.infer<typeof processingRowSchema>;
export const processingInputWithClipSchema = z.object({
  clipId: projectIdSchema, frozen: processingInputSchema, outcomeReason: z.literal('INTERPOLATION_UNAVAILABLE').optional(),
}).strict();
export type ProcessingInputWithClip = z.infer<typeof processingInputWithClipSchema>;

const payloadName = z.enum(['proxy.mkv', 'clock.json', 'frames.jsonl', 'video.raw', 'audio.f32le']);
const payload = z.object({fileName: payloadName, bytes: integer, sha256: processingDigestSchema}).strict();
const reverseProxy = z.object({
  profileId: z.literal('timeline-reverse-source-v1'), mapHash, frameCount: integer, sampleCount: integer,
  files: z.array(payload).min(2).max(5),
}).strict();
const opticalProxy = z.object({
  profileId: z.literal('timeline-optical-output-v1'), mapHash, frameCount: integer.positive(),
  firstOutputFrame: z.number().int().safe(), sampleCount: z.literal(0), files: z.array(payload).length(2),
}).strict();
export const processingProxyResultSchema = z.discriminatedUnion('profileId', [reverseProxy, opticalProxy]).refine(value =>
  new Set(value.files.map(file => file.fileName)).size === value.files.length &&
  value.files.some(file => file.fileName === 'clock.json') &&
  value.files.some(file => value.profileId === 'timeline-optical-output-v1' ? file.fileName === 'proxy.mkv'
    : ['proxy.mkv', 'video.raw', 'audio.f32le'].includes(file.fileName)));
export const processingCacheReceiptSchema = z.object({
  version: z.literal(1), projectId: projectIdSchema, cacheKey: processingDigestSchema, result: processingProxyResultSchema,
}).strict();
export type ProcessingCacheReceipt = z.infer<typeof processingCacheReceiptSchema>;
export const PROCESSING_CACHE_MAX_ENTRIES = 4096;
export const processingCachePinsSchema = z.array(processingDigestSchema).max(PROCESSING_CACHE_MAX_ENTRIES);
