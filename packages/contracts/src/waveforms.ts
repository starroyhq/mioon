import {z} from 'zod';
import {sourceFrameCount} from './source-range.ts';

// These are source peaks in the editing timebase, never timeline/post-mix audio.
export const WAVEFORM_ALGORITHM = 'peak-u16-48k-100hz-v1';
export const WAVEFORM_FPS = 30;
export const WAVEFORM_SAMPLE_RATE = 48_000;
export const WAVEFORM_BINS_PER_SECOND = 100;
export const WAVEFORM_MAX_DURATION = 600;
export const WAVEFORM_MAX_SOURCE_FRAMES = WAVEFORM_FPS * WAVEFORM_MAX_DURATION;
export const WAVEFORM_MAX_POINTS = 2048;
export const WAVEFORM_DEFAULT_POINTS = 512;
export const WAVEFORM_STATUSES = Object.freeze(['missing','queued','running','ready','interrupted','error','unsupported']);

const id = z.string().uuid();
const sourceStartFrame = z.number().int().min(0).max(WAVEFORM_MAX_SOURCE_FRAMES - 1);
const sourceEndFrame = z.number().int().min(1).max(WAVEFORM_MAX_SOURCE_FRAMES);
export const waveformSchemas = Object.freeze({
  'asset.waveform.request': z.object({
    projectId: id,
    assetId: id,
    retry: z.boolean().default(false).describe('Explicitly retry an interrupted or failed attempt. Ordinary repeats reuse queued, running or ready cache work. No durable mutation replay key is used; an evicted cache may be rebuilt.'),
  }).strict(),
  'asset.waveform.get': z.object({
    projectId: id,
    assetId: id,
    sourceStartFrame: sourceStartFrame.default(0).describe('Inclusive source position in the 30fps editing timebase, not a native/VFR frame index. Reading never starts or repairs waveform work.'),
    sourceEndFrame: sourceEndFrame.optional().describe('Exclusive source position; defaults to the available source end and must be greater than sourceStartFrame.'),
    points: z.number().int().min(1).max(WAVEFORM_MAX_POINTS).default(WAVEFORM_DEFAULT_POINTS).describe('Maximum returned source peak count. Null bins indicate missing decoded coverage; numeric values are normalized absolute amplitudes from the first audio stream, before timeline gain, mute or fades.'),
  }).strict().refine(value => value.sourceEndFrame === undefined || value.sourceEndFrame > value.sourceStartFrame,
    {path: ['sourceEndFrame'], message: 'Waveform source end must be greater than source start.'}),
});

// Strict public cache acknowledgement: no source hashes, filenames, URLs,
// commands or raw decoder diagnostics cross the transport boundary.
export const waveformResponseSchema = z.object({
  projectId: id,
  assetId: id,
  algorithm: z.literal(WAVEFORM_ALGORITHM),
  status: z.enum(WAVEFORM_STATUSES),
  reason: z.object({code: z.string().min(1).max(100), message: z.string().min(1).max(500)}).strict().optional(),
  attemptId: id.optional(),
  duration: z.number().finite().positive().max(WAVEFORM_MAX_DURATION).optional(),
  sourceFrames: sourceEndFrame.optional(),
  decodedSampleFrames: z.number().int().min(1).max(WAVEFORM_SAMPLE_RATE * WAVEFORM_MAX_DURATION).optional(),
  binsPerSecond: z.literal(WAVEFORM_BINS_PER_SECOND),
  sourceStartFrame: sourceStartFrame.optional(),
  sourceEndFrame: sourceEndFrame.optional(),
  peaks: z.array(z.number().finite().min(0).max(1).nullable()).min(1).max(WAVEFORM_MAX_POINTS).optional(),
  clipped: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const fail = (path, message) => context.addIssue({code: z.ZodIssueCode.custom, path: [path], message});
  if (value.status === 'ready') {
    for (const key of ['duration','sourceFrames','decodedSampleFrames','clipped','attemptId'])
      if (value[key] === undefined) fail(key, 'Ready waveforms require confirmed source and decoded-coverage metadata.');
    if (value.sourceFrames !== sourceFrameCount(value.duration))
      fail('sourceFrames', 'Source frames must match the 30fps asset duration.');
    if (Math.abs(value.decodedSampleFrames / WAVEFORM_SAMPLE_RATE - value.duration) > 0.1 + 1e-6)
      fail('decodedSampleFrames', 'Decoded coverage must stay within 100ms of the source duration.');
  }
  if ((value.sourceStartFrame === undefined) !== (value.sourceEndFrame === undefined))
    fail('sourceEndFrame', 'Waveform source bounds must be returned together.');
  if (value.sourceEndFrame !== undefined && (value.sourceEndFrame <= value.sourceStartFrame ||
      (value.sourceFrames !== undefined && value.sourceEndFrame > value.sourceFrames)))
    fail('sourceEndFrame', 'Waveform source bounds must stay inside the source duration.');
  if (value.peaks !== undefined && (value.status !== 'ready' || value.sourceStartFrame === undefined || value.sourceFrames === undefined || value.decodedSampleFrames === undefined))
    fail('peaks', 'Waveform peaks require ready state, confirmed source bounds and decoded sample coverage.');
});

export function isWaveformResponse(value, input) {
  if (!waveformResponseSchema.safeParse(value).success) return false;
  return !input || (value.projectId === input.projectId && value.assetId === input.assetId &&
    (value.peaks === undefined || (value.peaks.length <= (input.points ?? WAVEFORM_DEFAULT_POINTS) &&
      value.sourceStartFrame === (input.sourceStartFrame ?? 0) &&
      value.sourceEndFrame === (input.sourceEndFrame ?? value.sourceFrames))));
}
