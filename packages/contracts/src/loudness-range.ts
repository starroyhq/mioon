import {z} from 'zod';

/** Separate from the persisted BS.1770 integrated/true-peak observation profile. */
export const LOUDNESS_RANGE_PROFILE = 'ebu3342-2023-48k-stereo-3s-100ms-complete-v1';
export const LOUDNESS_RANGE_LIMITS = Object.freeze({sampleRate: 48000, channels: 2,
  durationSeconds: 60, sampleFrames: 2_880_000, pcmBytes: 23_040_000,
  windowFrames: 144_000, hopFrames: 4_800, shortTermBlocks: 571,
  durationToleranceSeconds: 0.1});

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const count = z.number().int().min(0).max(LOUDNESS_RANGE_LIMITS.shortTermBlocks);
const db = z.number().finite().nullable();
export const loudnessRangeMeasurementSchema = z.object({
  profile: z.literal(LOUDNESS_RANGE_PROFILE),
  sampleRate: z.literal(48000), channels: z.literal(2),
  sampleFrames: z.number().int().min(1).max(LOUDNESS_RANGE_LIMITS.sampleFrames),
  decodedDurationSeconds: z.number().finite().positive().max(LOUDNESS_RANGE_LIMITS.durationSeconds),
  state: z.enum(['valid', 'too_short', 'digital_silence', 'below_gate']),
  samplePeakLinear: z.number().finite().min(0).max(3.4028234663852886e38),
  loudnessRangeLu: z.number().finite().min(0).nullable(),
  lowPercentileLufs: db, highPercentileLufs: db,
  shortTermBlockCount: count, absoluteGatedBlockCount: count, relativeGatedBlockCount: count,
  relativeGateLufs: db,
}).strict().superRefine((v, c) => {
  const fail = (path: string, message: string): void => c.addIssue({code: z.ZodIssueCode.custom, path: [path], message});
  if (!near(v.decodedDurationSeconds, v.sampleFrames / LOUDNESS_RANGE_LIMITS.sampleRate))
    fail('decodedDurationSeconds', 'Duration must include exactly the decoded frames.');
  const blocks = v.sampleFrames < LOUDNESS_RANGE_LIMITS.windowFrames ? 0 :
    1 + Math.floor((v.sampleFrames - LOUDNESS_RANGE_LIMITS.windowFrames) / LOUDNESS_RANGE_LIMITS.hopFrames);
  if (v.shortTermBlockCount !== blocks) fail('shortTermBlockCount', 'Only complete three-second windows at 100ms hops count.');
  if (v.relativeGatedBlockCount > v.absoluteGatedBlockCount || v.absoluteGatedBlockCount > blocks)
    fail('absoluteGatedBlockCount', 'Gate membership counts must be nested.');
  if (v.absoluteGatedBlockCount === 0 ? v.relativeGateLufs !== null : v.relativeGateLufs === null || v.relativeGateLufs < -90 - 1e-9)
    fail('relativeGateLufs', 'The relative threshold requires absolute-gated short-term energy.');
  if (v.relativeGateLufs !== null && v.relativeGateLufs <= -70 && v.relativeGatedBlockCount !== v.absoluteGatedBlockCount)
    fail('relativeGatedBlockCount', 'The lower relative threshold cannot exclude an absolute-gated window.');
  const state = blocks === 0 ? 'too_short' : v.samplePeakLinear === 0 ? 'digital_silence' :
    v.absoluteGatedBlockCount === 0 ? 'below_gate' : 'valid';
  if (v.state !== state) fail('state', 'Short input, silence and gated signals remain distinct.');
  if (v.samplePeakLinear === 0 && (v.absoluteGatedBlockCount !== 0 || v.relativeGateLufs !== null))
    fail('samplePeakLinear', 'Digital silence has no qualified windows.');
  if (state === 'valid') {
    if (!v.relativeGatedBlockCount || v.relativeGateLufs === null || v.loudnessRangeLu === null ||
        v.lowPercentileLufs === null || v.highPercentileLufs === null) {
      fail('loudnessRangeLu', 'A range requires both gated percentiles.');
    } else {
      if (v.lowPercentileLufs < Math.max(-70, v.relativeGateLufs) - 1e-9 || v.highPercentileLufs < v.lowPercentileLufs)
        fail('lowPercentileLufs', 'Percentiles must be ordered and pass both gates.');
      if (!near(v.loudnessRangeLu, v.highPercentileLufs - v.lowPercentileLufs))
        fail('loudnessRangeLu', 'The range must equal the difference between the 95th and 10th percentiles.');
      if (v.relativeGatedBlockCount === 1 && v.loudnessRangeLu !== 0)
        fail('loudnessRangeLu', 'A single qualified window has no distribution spread.');
    }
  } else if (v.loudnessRangeLu !== null || v.lowPercentileLufs !== null || v.highPercentileLufs !== null || v.relativeGatedBlockCount !== 0)
    fail('loudnessRangeLu', 'Unqualified measurements cannot carry a range or percentile result.');
});
export type LoudnessRangeMeasurement = z.infer<typeof loudnessRangeMeasurementSchema>;
