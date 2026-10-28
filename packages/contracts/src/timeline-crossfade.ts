import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';
import {VOLUME_ENVELOPE_PROFILE, type VolumeEnvelope} from './timeline-volume-envelope.ts';

type Rec = Record<string, unknown>;
// Crossfades the sound of two clips on different tracks where the outgoing
// clip's tail overlaps the incoming clip's head. Both linear curves are written
// in one keyed timeline edit with one history entry, so one undo restores both.
export const TIMELINE_CROSSFADE_OPERATION = 'timeline.clip.crossfade';
// The timeline record plus the crossfade summary.
export const TIMELINE_CROSSFADE_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 1024;
/** Pre-write rejections whose rollback the backend can prove. Their proofs bind
 * operation, project and request.
 * CROSSFADE_GEOMETRY: the clips share a track, or the incoming clip does not
 * start within the outgoing one, or it ends before the outgoing one ends.
 * CROSSFADE_AUDIO_UNSUPPORTED: either source is an image or has no sound.
 * CROSSFADE_ENVELOPE_EXISTS: either clip already has a volume envelope; the
 * first version never merges into or replaces a user curve. Gain and fades are
 * kept and still multiply the new curves. */
export const TIMELINE_CROSSFADE_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'CLIP_NOT_FOUND', 'CROSSFADE_SAME_CLIP',
  'CROSSFADE_GEOMETRY', 'CROSSFADE_AUDIO_UNSUPPORTED', 'CROSSFADE_ENVELOPE_EXISTS'] as const);

/** startFrame: the timeline frame where the incoming clip starts; durationFrames:
 * the overlap up to the outgoing clip's end. */
export interface TimelineCrossfadeSummary {outgoingClipId: string; incomingClipId: string; startFrame: number; durationFrames: number}
export interface TimelineCrossfadeResponse {
  operation: typeof TIMELINE_CROSSFADE_OPERATION; requestId: string; timeline: Rec; crossfade: TimelineCrossfadeSummary;
}
interface CrossfadeClip {id: string; trackId: string; startFrame: number; durationFrames: number}

const id = z.string().uuid();
export const timelineCrossfadeSchemas = Object.freeze({
  [TIMELINE_CROSSFADE_OPERATION]: z.object({projectId: id, expectedRevision: z.number().int().positive(), requestId: z.string().min(8).max(200),
    outgoingClipId: id.describe('The earlier clip, which fades out over the overlap.'),
    incomingClipId: id.describe('The later clip on another track, which fades in over the overlap.')}).strict(),
});
export const timelineCrossfadeDescriptions = Object.freeze({
  [TIMELINE_CROSSFADE_OPERATION]: '按时间线版本为不同轨道上的两个有声片段做交叉淡化：后一段的开头落在前一段之内（可以同时开始），且后一段不早于前一段结束；重叠区间从后一段的开头到前一段的结尾，前一段在区间内线性淡出到0，后一段线性淡入到1（线性，不是等功率），原有音量和淡入淡出仍与曲线相乘；两段都不能已有音量包络；两条曲线一次写入并记一条历史，撤销一次两段一起复原；使用必填稳定requestId精确重放，不处理媒体',
});

/** The overlap of a legal pair, or null: out.start <= in.start < out.end <=
 * in.end on two tracks. Pure geometry; audio and existing curves are checked
 * separately. */
export function timelineCrossfadeOverlap(outgoing: CrossfadeClip, incoming: CrossfadeClip): {startFrame: number; durationFrames: number} | null {
  const outgoingEnd = outgoing.startFrame + outgoing.durationFrames, incomingEnd = incoming.startFrame + incoming.durationFrames;
  if (outgoing.id === incoming.id || outgoing.trackId === incoming.trackId ||
    !(outgoing.startFrame <= incoming.startFrame && incoming.startFrame < outgoingEnd && outgoingEnd <= incomingEnd)) return null;
  return {startFrame: incoming.startFrame, durationFrames: outgoingEnd - incoming.startFrame};
}
/** The two linear curves, in each clip's local frames. Their sum is 1 at every
 * sample of the overlap. */
export function timelineCrossfadeEnvelopes(outgoing: CrossfadeClip, incoming: CrossfadeClip): {outgoing: VolumeEnvelope; incoming: VolumeEnvelope} | null {
  const overlap = timelineCrossfadeOverlap(outgoing, incoming);
  if (!overlap) return null;
  return {
    outgoing: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: overlap.startFrame - outgoing.startFrame, multiplier: 1}, {frame: outgoing.durationFrames, multiplier: 0}]},
    incoming: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 0}, {frame: overlap.durationFrames, multiplier: 1}]},
  };
}

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exactKeys = (value: Rec, required: readonly string[]): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name));
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_CROSSFADE_RESPONSE_BYTES;} catch {return false;}
}
const sameEnvelope = (value: unknown, expected: VolumeEnvelope): boolean => object(value) && exactKeys(value, ['profileId', 'points']) &&
  value.profileId === expected.profileId && Array.isArray(value.points) && value.points.length === expected.points.length &&
  value.points.every((point, index) => object(point) && exactKeys(point, ['frame', 'multiplier']) &&
    point.frame === expected.points[index].frame && point.multiplier === expected.points[index].multiplier);
/** Binds every identity field of a not-applied proof, as scene split does. */
export function hasTimelineCrossfadeNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    if (operation !== TIMELINE_CROSSFADE_OPERATION || !timelineCrossfadeSchemas[TIMELINE_CROSSFADE_OPERATION].safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_CROSSFADE_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}

/** Uses the single established timeline validator. The summary must describe a
 * legal pair of the saved timeline, and both clips must carry exactly the two
 * linear curves for that overlap. */
export function createTimelineCrossfadeContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function isTimelineCrossfadeResponse(value: unknown, input: unknown): value is TimelineCrossfadeResponse {
    try {
      const parsed = timelineCrossfadeSchemas[TIMELINE_CROSSFADE_OPERATION].safeParse(input);
      if (!parsed.success || !object(value) || !bounded(value) || !exactKeys(value, ['operation', 'requestId', 'timeline', 'crossfade']) ||
        value.operation !== TIMELINE_CROSSFADE_OPERATION || value.requestId !== parsed.data.requestId ||
        parsed.data.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value.timeline, {projectId: parsed.data.projectId}) ||
        !object(value.timeline) || value.timeline.revision !== parsed.data.expectedRevision + 1) return false;
      const summary = value.crossfade, clips = (value.timeline as {clips?: unknown}).clips;
      if (!object(summary) || !exactKeys(summary, ['outgoingClipId', 'incomingClipId', 'startFrame', 'durationFrames']) ||
        summary.outgoingClipId !== parsed.data.outgoingClipId || summary.incomingClipId !== parsed.data.incomingClipId || !Array.isArray(clips)) return false;
      const find = (clipId: string): Rec | undefined => clips.find(clip => object(clip) && clip.id === clipId) as Rec | undefined;
      const outgoing = find(parsed.data.outgoingClipId), incoming = find(parsed.data.incomingClipId);
      if (!outgoing || !incoming) return false;
      const pair = [outgoing, incoming] as unknown as CrossfadeClip[];
      const overlap = timelineCrossfadeOverlap(pair[0], pair[1]), curves = timelineCrossfadeEnvelopes(pair[0], pair[1]);
      return Boolean(overlap && curves && summary.startFrame === overlap.startFrame && summary.durationFrames === overlap.durationFrames &&
        sameEnvelope(outgoing.volumeEnvelope, curves.outgoing) && sameEnvelope(incoming.volumeEnvelope, curves.incoming));
    } catch {return false;}
  }
  return {isTimelineCrossfadeResponse};
}
