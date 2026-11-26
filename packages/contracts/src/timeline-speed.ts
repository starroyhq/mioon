import {z} from 'zod';
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
  speed: TimeMapSpeed;
  direction: 'forward' | 'reverse';
  pitchShift: boolean;
  interpolation: SpeedInterpolation;
}

export interface SequenceEditSpeedIntent {
  side: 'timeline';
  operation:
    | {kind: 'clip-speed'; clipId: string; setting: SpeedSetting}
    | {kind: 'freeze-frame'; clipId: string; atFrame: number; durationFrames?: number};
}

export type SpeedProcessingReason =
  'SOURCE_UNAVAILABLE' | 'DISK_FULL' | 'CACHE_LIMIT' | 'UNSUPPORTED_FORMAT' | 'PROCESSING_FAILED'
  | 'INTERPOLATION_UNAVAILABLE';
export const speedProcessingReasonSchema = z.enum([
  'SOURCE_UNAVAILABLE', 'DISK_FULL', 'CACHE_LIMIT', 'UNSUPPORTED_FORMAT', 'PROCESSING_FAILED', 'INTERPOLATION_UNAVAILABLE',
]) satisfies z.ZodType<SpeedProcessingReason>;
export interface SpeedProcessingItem {
  taskId: string; clipId: string; kind: 'reverse' | 'optical' | 'preview';
  status: 'queued' | 'running' | 'failed' | 'ready';
  progress?: number;
  reason?: SpeedProcessingReason;
}

const id = z.string().uuid();
const frame = z.number().int().safe();
const direction = z.enum(['forward', 'reverse']);
const interpolation = z.enum(['off', 'blend', 'optical']);
const rate = z.object({numerator: z.number().finite(), denominator: z.number().finite()}).strict();
// The compiler owns rate/point semantics and their specific failure codes.
const speed = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('constant'), rate}).strict(),
  z.object({kind: z.literal('curve'), interpolation: z.literal('log-pchip-v1'),
    presetId: z.string().max(80),
    points: z.array(z.object({sourceFrame: frame, rate}).strict()).max(256)}).strict(),
]);
const boundary = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('rational'), numerator: z.string().regex(/^(0|-?[1-9]\d{0,38})$/u),
    denominator: z.string().regex(/^[1-9]\d{0,38}$/u)}).strict(),
  z.object({kind: z.literal('q64'), ticks: z.string().regex(/^-?\d{1,39}$/u)}).strict(),
]);
const timebase = z.object({fpsNumerator: frame, fpsDenominator: frame}).strict();
const viewBoundary = z.object({anchor: z.enum(['start', 'end']), offsetOutputFrames: frame}).strict();
export const clipTimingSchema = z.discriminatedUnion('profile', [
  z.object({profile: z.literal('timeline-speed-v1'), basis: z.object({
    profile: z.literal('timeline-speed-v1'), speed, sourceFps: timebase, outputFps: timebase,
    sourceRange: z.object({start: boundary, end: boundary}).strict(),
  }).strict(),
  view: z.object({loTime: viewBoundary, hiTime: viewBoundary, direction}).strict(),
  outputWindow: z.object({fromFrame: frame, toFrame: frame}).strict(),
  pitchShift: z.boolean(), interpolation}).strict(),
  z.object({profile: z.literal('timeline-freeze-v1'), sourceFrame: frame.nonnegative(),
    sourceVersionId: id.nullable(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),
]);

export const speedSettingSchema = z.object({speed, direction, pitchShift: z.boolean(), interpolation}).strict();
export const clipSpeedOperationSchema = z.object({
  kind: z.literal('clip-speed'), clipId: id, setting: speedSettingSchema,
}).strict();
export const freezeFrameOperationSchema = z.object({
  kind: z.literal('freeze-frame'), clipId: id, atFrame: frame.nonnegative(),
  durationFrames: frame.positive().optional(),
}).strict();
export const sequenceEditSpeedIntentSchema = z.object({
  side: z.literal('timeline'),
  operation: z.discriminatedUnion('kind', [clipSpeedOperationSchema, freezeFrameOperationSchema]),
}).strict();
