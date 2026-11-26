import {z} from 'zod';
import {
  TIMELINE_TIME_MAP_BASIS_PROFILE,
  TIMELINE_TIME_MAP_INTERPOLATION,
  TIMELINE_TIME_MAP_LIMITS,
} from './timeline-time-map.ts';
import type {TimeMapBasis, TimeMapSpeed, TimeMapViewBoundary, TimeMapOutputWindow} from './timeline-time-map.ts';

export type SpeedInterpolation = 'off' | 'blend' | 'optical';

/** 片段上保存的时间映射（格式 6）。片段没有 timing = 1×、正放、保持音调、不补帧。 */
export type ClipTiming =
  | {profile: 'timeline-speed-v1'; basis: TimeMapBasis;
     view: {loTime: TimeMapViewBoundary; hiTime: TimeMapViewBoundary; direction: 'forward' | 'reverse'};
     outputWindow: TimeMapOutputWindow; pitchShift: boolean; interpolation: SpeedInterpolation}
  | {profile: 'timeline-freeze-v1'; sourceFrame: number; sourceVersionId: string | null; sourceSha256: string};

/** 写入用：用户在界面上设的值。曲线点用素材的绝对源帧（片段原始时间）。 */
export interface SpeedSetting {
  speed: TimeMapSpeed;               // constant：rate 0.1–10；curve：presetId + points（含两端，≤32）
  direction: 'forward' | 'reverse';
  pitchShift: boolean;               // false = 保持音调（默认）
  interpolation: SpeedInterpolation; // 有效速率 ≥ 1 时后端按 'off' 保存
}

/** sequence.preview / sequence.commit 新增的意图，和 propertiesIntent 等并列。 */
export interface SequenceEditSpeedIntent {
  side: 'timeline';
  operation:
    | {kind: 'clip-speed'; clipId: string; setting: SpeedSetting}
    | {kind: 'freeze-frame'; clipId: string; atFrame: number; durationFrames?: number};
      // atFrame：时间线帧，在片段 [startFrame, startFrame+durationFrames) 内；durationFrames 默认 60（2 秒）
}

export type SpeedProcessingReason =
  'SOURCE_UNAVAILABLE' | 'DISK_FULL' | 'CACHE_LIMIT' | 'UNSUPPORTED_FORMAT' | 'PROCESSING_FAILED';
export interface SpeedProcessingItem {
  taskId: string; clipId: string; kind: 'reverse' | 'optical';
  status: 'queued' | 'running' | 'failed' | 'ready';
  progress?: number;                 // 0–100，running 时给
  reason?: SpeedProcessingReason;    // failed 时给
}

// ---------------------------------------------------------------------------
// Zod schemas (contract validation only; not wired into persistence schemas).
// ---------------------------------------------------------------------------

const safeNonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safePositiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const signedIntText = z.string().regex(/^-?(?:0|[1-9][0-9]{0,39})$/u);
const positiveIntText = z.string().regex(/^[1-9][0-9]{0,39}$/u);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);

export const speedInterpolationSchema: z.ZodType<SpeedInterpolation> = z.enum(['off', 'blend', 'optical']);

export const timeMapSpeedRateSchema = z.object({
  numerator: z.number().int().min(1).max(TIMELINE_TIME_MAP_LIMITS.maxRateTerm),
  denominator: z.number().int().min(1).max(TIMELINE_TIME_MAP_LIMITS.maxRateTerm),
}).strict();

export const timeMapTimebaseSchema = z.object({
  fpsNumerator: z.number().int().min(1).max(10_000),
  fpsDenominator: z.number().int().min(1).max(10_000),
}).strict();

export const timeMapSourceBoundarySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rational'),
    numerator: signedIntText,
    denominator: positiveIntText,
  }).strict(),
  z.object({
    kind: z.literal('q64'),
    ticks: signedIntText,
  }).strict(),
]);

export const timeMapSourceRangeSchema = z.object({
  start: timeMapSourceBoundarySchema,
  end: timeMapSourceBoundarySchema,
}).strict();

export const timeMapCurvePointSchema = z.object({
  sourceFrame: safeNonNegativeInt,
  rate: timeMapSpeedRateSchema,
}).strict();

export const timeMapSpeedSchema: z.ZodType<TimeMapSpeed> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('constant'),
    rate: timeMapSpeedRateSchema,
  }).strict(),
  z.object({
    kind: z.literal('curve'),
    interpolation: z.literal(TIMELINE_TIME_MAP_INTERPOLATION),
    presetId: z.string().min(1).max(64),
    points: z.array(timeMapCurvePointSchema).min(2).max(TIMELINE_TIME_MAP_LIMITS.maxCurvePoints),
  }).strict(),
]);

export const timeMapBasisSchema: z.ZodType<TimeMapBasis> = z.object({
  profile: z.literal(TIMELINE_TIME_MAP_BASIS_PROFILE),
  sourceFps: timeMapTimebaseSchema,
  outputFps: timeMapTimebaseSchema,
  sourceRange: timeMapSourceRangeSchema,
  speed: timeMapSpeedSchema,
}).strict();

export const timeMapViewBoundarySchema: z.ZodType<TimeMapViewBoundary> = z.object({
  anchor: z.enum(['start', 'end']),
  offsetOutputFrames: z.number().int().min(-TIMELINE_TIME_MAP_LIMITS.maxOutputFrames).max(TIMELINE_TIME_MAP_LIMITS.maxOutputFrames),
}).strict();

export const timeMapOutputWindowSchema: z.ZodType<TimeMapOutputWindow> = z.object({
  fromFrame: safeNonNegativeInt,
  toFrame: safePositiveInt,
}).strict().refine(value => value.toFrame > value.fromFrame, 'outputWindow.toFrame must exceed fromFrame');

export const clipTimingSchema: z.ZodType<ClipTiming> = z.discriminatedUnion('profile', [
  z.object({
    profile: z.literal('timeline-speed-v1'),
    basis: timeMapBasisSchema,
    view: z.object({
      loTime: timeMapViewBoundarySchema,
      hiTime: timeMapViewBoundarySchema,
      direction: z.enum(['forward', 'reverse']),
    }).strict(),
    outputWindow: timeMapOutputWindowSchema,
    pitchShift: z.boolean(),
    interpolation: speedInterpolationSchema,
  }).strict(),
  z.object({
    profile: z.literal('timeline-freeze-v1'),
    sourceFrame: safeNonNegativeInt,
    sourceVersionId: z.string().min(1).nullable(),
    sourceSha256: sha256Hex,
  }).strict(),
]);

export const speedSettingSchema: z.ZodType<SpeedSetting> = z.object({
  speed: timeMapSpeedSchema,
  direction: z.enum(['forward', 'reverse']),
  pitchShift: z.boolean(),
  interpolation: speedInterpolationSchema,
}).strict();

export const sequenceEditSpeedIntentSchema: z.ZodType<SequenceEditSpeedIntent> = z.object({
  side: z.literal('timeline'),
  operation: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('clip-speed'),
      clipId: z.string().min(1),
      setting: speedSettingSchema,
    }).strict(),
    z.object({
      kind: z.literal('freeze-frame'),
      clipId: z.string().min(1),
      atFrame: safeNonNegativeInt,
      durationFrames: z.number().int().min(1).max(TIMELINE_TIME_MAP_LIMITS.maxOutputFrames).optional(),
    }).strict(),
  ]),
}).strict();

export const speedProcessingReasonSchema: z.ZodType<SpeedProcessingReason> = z.enum([
  'SOURCE_UNAVAILABLE',
  'DISK_FULL',
  'CACHE_LIMIT',
  'UNSUPPORTED_FORMAT',
  'PROCESSING_FAILED',
]);

export const speedProcessingItemSchema: z.ZodType<SpeedProcessingItem> = z.object({
  taskId: z.string().min(1),
  clipId: z.string().min(1),
  kind: z.enum(['reverse', 'optical']),
  status: z.enum(['queued', 'running', 'failed', 'ready']),
  progress: z.number().finite().min(0).max(100).optional(),
  reason: speedProcessingReasonSchema.optional(),
}).strict();

export const speedProcessingListResponseSchema = z.object({
  items: z.array(speedProcessingItemSchema),
}).strict();
