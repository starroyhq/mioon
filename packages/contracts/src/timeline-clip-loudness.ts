import {VOLUME_ENVELOPE_PROFILE} from './timeline-volume-envelope.ts';
import {z} from 'zod';
import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, exportLoudnessMeasurementSchema} from './export-loudness.ts';

export const TIMELINE_CLIP_LOUDNESS_OPERATION = 'timeline.clip.loudness';
export const TIMELINE_CLIP_LOUDNESS_PROFILE = 'timeline-isolated-clip-float-v1';
export const TIMELINE_CLIP_LOUDNESS_LIMITS = Object.freeze({sourceBytes: EXPORT_LOUDNESS_LIMITS.inputBytes,
  hashBytes: EXPORT_LOUDNESS_LIMITS.totalHashedBytes, pcmBytes: 23_040_000,
  timelineFrames: 18000, clipFrames: 1800, clipSeconds: 60, decodeWorkFrames: 1801, timeoutMs: EXPORT_LOUDNESS_LIMITS.timeoutMs,
  clientTimeoutMs: EXPORT_LOUDNESS_LIMITS.clientTimeoutMs, reportBytes: 8192} as const);
const id = z.string().uuid().length(36), hash = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const count = (max: number, min = 0) => z.number().finite().int().min(min).max(max);
export const timelineClipLoudnessInputSchema = z.object({projectId: id, timelineId: id,
  expectedRevision: count(Number.MAX_SAFE_INTEGER, 1), clipId: id, expectedAssetSha256: hash,
  measurementProfile: z.literal(EXPORT_LOUDNESS_PROFILE)}).strict();
export type TimelineClipLoudnessInput = z.infer<typeof timelineClipLoudnessInputSchema>;
export const timelineClipLoudnessSchemas = Object.freeze({[TIMELINE_CLIP_LOUDNESS_OPERATION]: timelineClipLoudnessInputSchema});
export const timelineClipLoudnessResponseSchema = z.object({...timelineClipLoudnessInputSchema.shape,
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
    return request.success && Object.entries(request.data).every(([key, val]) => parsed.data[key as keyof TimelineClipLoudnessInput] === val);
  } catch {return false;}
}
