import {z} from 'zod';
import {isVolumeEnvelope, isVolumeEnvelopeProcessingSnapshot, VOLUME_ENVELOPE_PROCESSING_PROFILE} from './timeline-volume-envelope-processing.ts';
import type {TimelineVolumeEnvelope} from './timeline-volume-envelope-processing.ts';
import {audioPreviewPlanInputSchema, AUDIO_PREVIEW_LIMITS} from './timeline-audio-preview.ts';

/** V2 is a pull session, separate from the frozen twenty-second V1 resource.
 * Blocks contain the complete saved mix before device output, never partial
 * tracks. No path, filter, codec, or output destination is caller selectable. */
export const CONTINUOUS_AUDIO_PROFILE = 'saved-timeline-audio-continuous-f32le-48k-stereo-v2';
export const CONTINUOUS_AUDIO_ENDPOINT = '/api/timeline-audio-preview/continuous';
export const CONTINUOUS_AUDIO_LIMITS = Object.freeze({
  blockFrames: 60, sampleRate: 48000, channels: 2, samplesPerFrame: 1600,
  memoryBytes: AUDIO_PREVIEW_LIMITS.memoryBytes,
  hashReadBytes: AUDIO_PREVIEW_LIMITS.hashReadBytes,
  sourceBytes: AUDIO_PREVIEW_LIMITS.sourceBytes, sourceSeconds: 600,
  timelineFrames: 18000, tracks: 12, clips: 100,
  decodeWorkFrames: 218400, sessionDecodeWorkFrames: 873600,
  decodeSegments: 2400, generations: 256, requests: 10000,
  prepareTimeoutMs: 120000, sessionTimeoutMs: 30 * 60 * 1000,
} as const);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = (min: number, max: number) => z.number().finite().int().min(min).max(max);
/** Backend projection only. Public callers cannot submit saved snapshots. */
const snapshotId = z.string().uuid(), snapshotFrame = integer(0, 18000);
export const continuousAudioSnapshotSchema = z.object({volumeEnvelopeProfile: z.literal(VOLUME_ENVELOPE_PROCESSING_PROFILE).optional(), timeline: z.object({id: snapshotId, projectId: snapshotId,
  revision: integer(1, Number.MAX_SAFE_INTEGER), fps: z.literal(30), durationFrames: snapshotFrame,
  tracks: z.array(z.object({id: snapshotId, kind: z.enum(['video', 'audio']), orderIndex: integer(0, 11),
    hidden: z.boolean(), muted: z.boolean()}).strict()).min(1).max(12),
  clips: z.array(z.object({id: snapshotId, trackId: snapshotId, assetId: snapshotId, startFrame: snapshotFrame,
    durationFrames: integer(1, 18000), sourceInFrame: integer(0, Number.MAX_SAFE_INTEGER - 18000),
    gain: z.number().finite().min(0).max(2), fadeInFrames: snapshotFrame.optional(), fadeOutFrames: snapshotFrame.optional(),
    volumeEnvelope: z.custom<TimelineVolumeEnvelope|null>().optional()}).strict().refine(clip =>
      !Object.hasOwn(clip, 'volumeEnvelope') || isVolumeEnvelope(clip.volumeEnvelope, clip.durationFrames), 'Invalid volume envelope.')).max(100),
}).strict(), assets: z.array(z.object({id: snapshotId, projectId: snapshotId, sha256: digest,
  sizeBytes: integer(1, Number.MAX_SAFE_INTEGER),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
  duration: z.number().finite().nonnegative().nullable(), hasAudio: z.boolean().nullable().optional(),
}).strict()).max(100)}).strict().refine(isVolumeEnvelopeProcessingSnapshot, 'Invalid volume envelope processing profile.');
export type ContinuousAudioSnapshot = z.infer<typeof continuousAudioSnapshotSchema>;
export const continuousAudioPlanInputSchema = audioPreviewPlanInputSchema;
export type ContinuousAudioPlanInput = z.infer<typeof continuousAudioPlanInputSchema>;
export const continuousAudioPlanSchema = z.object({
  schemaVersion: z.literal(2), status: z.literal('planned'), profileId: z.literal(CONTINUOUS_AUDIO_PROFILE),
  volumeEnvelopeProfile: z.literal(VOLUME_ENVELOPE_PROCESSING_PROFILE).optional(),
  projectId: z.string().uuid(), timelineId: z.string().uuid(), timelineRevision: integer(1, Number.MAX_SAFE_INTEGER),
  startFrame: integer(0, 17999), durationFrames: integer(1, 18000),
  blockFrames: z.literal(60), sampleRate: z.literal(48000), channels: z.literal(2),
  admittedBytes: z.literal(AUDIO_PREVIEW_LIMITS.memoryBytes), snapshotHash: digest, planHash: digest,
}).strict().refine(plan => !Object.hasOwn(plan, 'volumeEnvelopeProfile') || plan.volumeEnvelopeProfile === VOLUME_ENVELOPE_PROCESSING_PROFILE,
  'Invalid volume envelope processing profile.').refine(plan => plan.startFrame < plan.durationFrames, 'Start must precede the saved end.');
export type ContinuousAudioPlan = z.infer<typeof continuousAudioPlanSchema>;
export const continuousAudioBlockInputSchema = audioPreviewPlanInputSchema.extend({
  planHash: digest, sessionId: z.string().uuid(),
  generation: integer(1, CONTINUOUS_AUDIO_LIMITS.generations),
  sequence: integer(1, CONTINUOUS_AUDIO_LIMITS.requests), blockStartFrame: integer(0, 17999),
}).strict();
export type ContinuousAudioBlockInput = z.infer<typeof continuousAudioBlockInputSchema>;
export const continuousAudioSchemas = Object.freeze({'timeline.audioPreview.continuousPlan': continuousAudioPlanInputSchema});
export const CONTINUOUS_AUDIO_HEADERS = Object.freeze({
  profile: 'X-Mioon-Audio-Profile', planHash: 'X-Mioon-Audio-Plan-Hash',
  session: 'X-Mioon-Audio-Session', generation: 'X-Mioon-Audio-Generation', sequence: 'X-Mioon-Audio-Sequence',
  startFrame: 'X-Mioon-Audio-Start-Frame', endFrame: 'X-Mioon-Audio-End-Frame', sampleFrames: 'X-Mioon-Audio-Sample-Frames',
});

/** Fixed property order is shared by HTTP validation and native signatures. */
export function continuousAudioQuery(input: ContinuousAudioBlockInput): string {
  const checked = continuousAudioBlockInputSchema.parse(input);
  return new URLSearchParams({projectId: checked.projectId, timelineId: checked.timelineId,
    expectedRevision: String(checked.expectedRevision), startFrame: String(checked.startFrame),
    planHash: checked.planHash, sessionId: checked.sessionId, generation: String(checked.generation),
    sequence: String(checked.sequence), blockStartFrame: String(checked.blockStartFrame)}).toString();
}
export function continuousAudioPlanDigestMaterial(raw: ContinuousAudioPlan): string {
  const {planHash: omitted, ...plan} = continuousAudioPlanSchema.parse(raw);
  void omitted;
  return JSON.stringify(Object.fromEntries(Object.keys(plan).sort().map(key => [key, plan[key as keyof typeof plan]])));
}
export function isContinuousAudioPlan(raw: unknown, input: ContinuousAudioPlanInput): raw is ContinuousAudioPlan {
  try {
    const plan = continuousAudioPlanSchema.safeParse(raw), request = continuousAudioPlanInputSchema.safeParse(input);
    return plan.success && request.success && plan.data.projectId === request.data.projectId &&
      plan.data.timelineId === request.data.timelineId && plan.data.timelineRevision === request.data.expectedRevision &&
      plan.data.startFrame === request.data.startFrame;
  } catch { return false; }
}
