import {VOLUME_ENVELOPE_PROFILE} from './timeline-volume-envelope.ts';
import {z} from 'zod';
import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, exportLoudnessMeasurementSchema, exportLoudnessTargetSchema, EXPORT_LOUDNESS_ADVISORY_MARGIN_DB} from './export-loudness.ts';
import {loudnessRangeMeasurementSchema} from './loudness-range.ts';

export const TIMELINE_CLIP_LOUDNESS_OPERATION = 'timeline.clip.loudness';
export const TIMELINE_CLIP_LOUDNESS_PROFILE = 'timeline-isolated-clip-float-v1';
export const TIMELINE_CLIP_LOUDNESS_LIMITS = Object.freeze({sourceBytes: EXPORT_LOUDNESS_LIMITS.inputBytes,
  hashBytes: EXPORT_LOUDNESS_LIMITS.totalHashedBytes, pcmBytes: 23_040_000,
  timelineFrames: 18000, clipFrames: 1800, clipSeconds: 60, decodeWorkFrames: 1801, timeoutMs: EXPORT_LOUDNESS_LIMITS.timeoutMs,
  clientTimeoutMs: EXPORT_LOUDNESS_LIMITS.clientTimeoutMs, reportBytes: 8192} as const);
const id = z.string().uuid().length(36), hash = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const count = (max: number, min = 0) => z.number().finite().int().min(min).max(max);
const inputShape = {projectId: id, timelineId: id,
  expectedRevision: count(Number.MAX_SAFE_INTEGER, 1), clipId: id, expectedAssetSha256: hash,
  measurementProfile: z.literal(EXPORT_LOUDNESS_PROFILE), target: exportLoudnessTargetSchema.optional()};
export const timelineClipLoudnessInputSchema = z.object(inputShape).strict().superRefine((value, context) => {
  if (Object.hasOwn(value, 'target') && value.target === undefined)
    context.addIssue({code: z.ZodIssueCode.custom, path: ['target'], message: 'Omit an unselected target.'});
});
export type TimelineClipLoudnessInput = z.infer<typeof timelineClipLoudnessInputSchema>;
export const timelineClipLoudnessSchemas = Object.freeze({[TIMELINE_CLIP_LOUDNESS_OPERATION]: timelineClipLoudnessInputSchema});
export const TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU = 0.1;
const candidateCommon = {beforeGain: z.number().finite().positive().max(2),
  marginDb: z.literal(EXPORT_LOUDNESS_ADVISORY_MARGIN_DB), applyAllowed: z.literal(false)};
export const timelineClipLoudnessCandidateSchema = z.discriminatedUnion('status', [
  z.object({...candidateCommon, status: z.literal('unavailable'), reason: z.enum(['NO_VALID_LOUDNESS', 'GAIN_OUT_OF_RANGE']),
    requiredGainDb: z.number().finite().nullable(), gainMultiplier: z.number().finite().positive().nullable(),
    afterGain: z.null(), measurement: z.null(), measuredPcmBytes: z.literal(0), meetsTarget: z.literal(false), meetsTruePeak: z.literal(false)}).strict(),
  z.object({...candidateCommon, status: z.literal('measured'), reason: z.null(), requiredGainDb: z.number().finite(),
    gainMultiplier: z.number().finite().positive(), afterGain: z.number().finite().positive().max(2),
    measurement: exportLoudnessMeasurementSchema, measuredPcmBytes: count(TIMELINE_CLIP_LOUDNESS_LIMITS.pcmBytes, 12800),
    meetsTarget: z.boolean(), meetsTruePeak: z.boolean()}).strict(),
]);
export type TimelineClipLoudnessCandidate = z.infer<typeof timelineClipLoudnessCandidateSchema>;
export const timelineClipLoudnessResponseSchema = z.object({...inputShape,
  loudnessRange: loudnessRangeMeasurementSchema.optional(), candidate: timelineClipLoudnessCandidateSchema.optional(),
  volumeEnvelopeProcessingProfile: z.literal(VOLUME_ENVELOPE_PROFILE).optional(),
  status: z.literal('ready'), checkedAt: z.string().max(30).datetime(), applyAllowed: z.literal(false),
  processingProfile: z.literal(TIMELINE_CLIP_LOUDNESS_PROFILE), stage: z.literal('isolated_clip_post_gain_fades_pre_mix'),
  identity: z.object({volumeEnvelopeSha256: hash.optional(), snapshotSha256: hash, trackId: id, assetId: id, assetSha256: hash,
    sourceBytes: count(TIMELINE_CLIP_LOUDNESS_LIMITS.sourceBytes, 1),
    startFrame: count(17999), durationFrames: count(TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames, 1), sourceInFrame: count(18000),
    gain: z.number().finite().positive().max(2), fadeInFrames: count(TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames), fadeOutFrames: count(TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames),
    trackMuted: z.literal(false), measurementStartFrame: z.literal(0), measurementEndFrame: count(TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames, 1)}).strict(),
  measurement: exportLoudnessMeasurementSchema,
  checks: z.object({bytesHashed: count(TIMELINE_CLIP_LOUDNESS_LIMITS.hashBytes, 2),
    pcmBytes: count(TIMELINE_CLIP_LOUDNESS_LIMITS.pcmBytes, 12800),
    decodeWorkFrames: count(TIMELINE_CLIP_LOUDNESS_LIMITS.decodeWorkFrames, 2),
    segmentCount: z.literal(1), passes: z.literal(1), audioFullyDecoded: z.literal(true)}).strict(),
}).strict().superRefine((v, c) => {
  const fail = (message: string) => c.addIssue({code: z.ZodIssueCode.custom, message});
  const i = v.identity;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b));
  // Small valid gains require relative comparison; an absolute floor would
  // allow orders-of-magnitude changes to a quiet candidate's saved gain.
  const nearPositive = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-10 * Math.max(Math.abs(a), Math.abs(b));
  if (Object.hasOwn(v, 'target') && v.target === undefined || Object.hasOwn(v, 'candidate') && v.candidate === undefined ||
      Boolean(v.target) !== Boolean(v.candidate)) fail('An explicit target and its measured candidate must occur together.');
  if (Object.hasOwn(v, 'loudnessRange') && (!v.loudnessRange || v.loudnessRange.sampleFrames !== v.measurement.sampleFrames || v.loudnessRange.samplePeakLinear !== v.measurement.samplePeakLinear))
    fail('Loudness range must describe the complete same decoded clip.');
  if (v.target && v.candidate) {
    const candidate = v.candidate, original = v.measurement;
    if (candidate.beforeGain !== i.gain) fail('Candidate must bind the saved gain.');
    const valid = original.state === 'valid' && original.integratedLufs !== null;
    if (!valid) {
      if (candidate.status !== 'unavailable' || candidate.reason !== 'NO_VALID_LOUDNESS' || candidate.requiredGainDb !== null || candidate.gainMultiplier !== null)
        fail('Unqualified audio cannot produce a gain candidate.');
    } else {
      const required = v.target.integratedLufs - original.integratedLufs!, multiplier = 10 ** (required / 20), afterGain = i.gain * multiplier;
      if (candidate.requiredGainDb === null || candidate.gainMultiplier === null || !near(candidate.requiredGainDb, required) || !nearPositive(candidate.gainMultiplier, multiplier))
        fail('Candidate arithmetic must bind the explicit target.');
      if (candidate.status === 'unavailable') {
        if (candidate.reason !== 'GAIN_OUT_OF_RANGE' || Number.isFinite(afterGain) && afterGain > 0 && afterGain <= 2)
          fail('Only an unsupported saved gain can reject a valid signal before measurement.');
      } else {
        const measured = candidate.measurement;
        if (!nearPositive(candidate.afterGain, afterGain) || measured.sampleFrames !== original.sampleFrames || candidate.measuredPcmBytes !== v.checks.pcmBytes ||
            measured.samplePeakLinear !== Math.fround(original.samplePeakLinear * multiplier))
          fail('Candidate must measure every scaled clip sample with the exact supported gain.');
        if (candidate.meetsTarget !== (measured.state === 'valid' && measured.integratedLufs !== null &&
            Math.abs(measured.integratedLufs - v.target.integratedLufs) <= TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU) ||
            candidate.meetsTruePeak !== (measured.truePeakDbtp !== null && measured.truePeakDbtp <= v.target.truePeakCeilingDbtp - EXPORT_LOUDNESS_ADVISORY_MARGIN_DB))
          fail('Candidate target and true-peak qualification must match the actual second measurement.');
      }
    }
  }

  if (Object.hasOwn(v, 'volumeEnvelopeProcessingProfile') !== Object.hasOwn(i, 'volumeEnvelopeSha256') ||
      Object.hasOwn(v, 'volumeEnvelopeProcessingProfile') && (v.volumeEnvelopeProcessingProfile === undefined || i.volumeEnvelopeSha256 === undefined))
    fail('Envelope processing profile and exact envelope digest must occur together.');
  if (i.assetSha256 !== v.expectedAssetSha256) fail('The selected source must match the expected hash.');
  if (i.startFrame + i.durationFrames > 18000 || i.sourceInFrame + i.durationFrames > 18000 || i.fadeInFrames + i.fadeOutFrames > i.durationFrames ||
      i.measurementEndFrame !== i.durationFrames) fail('Saved clip and independent measurement bounds must agree.');
  if (v.measurement.sampleFrames !== i.durationFrames * 1600 || v.checks.pcmBytes !== i.durationFrames * 12800 ||
      v.checks.decodeWorkFrames !== i.durationFrames + 1 || v.checks.bytesHashed !== i.sourceBytes * 2)
    fail('The complete selected clip requires exact sample, work and two-pass hash counts.');
});
export type TimelineClipLoudnessResponse = z.infer<typeof timelineClipLoudnessResponseSchema>;

/** Bounded ordinary data only: no getters, cycles or prototype callbacks. */
export function isTimelineClipLoudnessResponse(value: unknown, input?: unknown): value is TimelineClipLoudnessResponse {
  let nodes = 256, bytes = 0;
  const ancestors = new Set<object>();
  const bounded = (v: unknown, depth = 0): boolean => {
    if (--nodes < 0 || depth > 5) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') {bytes += new TextEncoder().encode(v).length; return bytes <= TIMELINE_CLIP_LOUDNESS_LIMITS.reportBytes;}
    if (typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || ancestors.has(v)) return false;
    ancestors.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string') return false;
      bytes += key.length;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (bytes > TIMELINE_CLIP_LOUDNESS_LIMITS.reportBytes || !d?.enumerable || !Object.hasOwn(d, 'value') || !bounded(d.value, depth + 1)) return false;
    }
    ancestors.delete(v); return true;
  };
  try {
    if (!bounded(value) || new TextEncoder().encode(JSON.stringify(value)).length > TIMELINE_CLIP_LOUDNESS_LIMITS.reportBytes) return false;
    const parsed = timelineClipLoudnessResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    if (input === undefined) return true;
    const request = timelineClipLoudnessInputSchema.safeParse(input);
    return request.success && Object.entries(request.data).every(([key, val]) => key === 'target' ? Boolean(parsed.data.target && val && typeof val === 'object' && parsed.data.target.integratedLufs === (val as {integratedLufs: number}).integratedLufs && parsed.data.target.truePeakCeilingDbtp === (val as {truePeakCeilingDbtp: number}).truePeakCeilingDbtp) : parsed.data[key as keyof TimelineClipLoudnessInput] === val) && Boolean(parsed.data.target) === Boolean(request.data.target);
  } catch {return false;}
}
