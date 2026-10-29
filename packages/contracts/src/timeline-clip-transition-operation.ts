import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';
import {CLIP_TRANSITION_KINDS, CLIP_TRANSITION_LIMITS, CLIP_TRANSITION_PROFILE, canonicalClipTransition, type ClipTransition} from './timeline-clip-transition.ts';

type Rec = Record<string, unknown>;
// Sets or clears the transition at the cut before one visual clip as one keyed
// timeline edit with one history entry. Clip updates never carry a transition,
// so Mio's clip tools keep their schemas; this operation is not offered to Mio.
export const TIMELINE_CLIP_TRANSITION_OPERATION = 'timeline.clip.setTransition';
// The timeline record plus the previous and the new transition.
export const TIMELINE_CLIP_TRANSITION_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 1024;
/** Pre-write rejections whose rollback the backend can prove. Their proofs bind
 * operation, project and request.
 * CLIP_TRANSITION_UNSUPPORTED: the clip is not on a video track or its source is audio.
 * CLIP_TRANSITION_NO_CUT: no clip on the same track ends where this one starts.
 * CLIP_TRANSITION_INVALID: the transition value is malformed.
 * CLIP_TRANSITION_ROOM: source handles or clip lengths are too short; details.maxFrames.
 * CLIP_TRANSITION_UNCHANGED: the cut already has exactly this transition.
 * CLIP_TRANSITION_LIMIT: the composition or the saved timeline would exceed its limit.
 * CLIP_TRANSITION_WORKSPACE_REQUIRED: the workspace predates schema72. */
export const TIMELINE_CLIP_TRANSITION_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'CLIP_NOT_FOUND',
  'CLIP_TRANSITION_UNSUPPORTED', 'CLIP_TRANSITION_NO_CUT', 'CLIP_TRANSITION_INVALID', 'CLIP_TRANSITION_ROOM', 'CLIP_TRANSITION_UNCHANGED',
  'CLIP_TRANSITION_LIMIT', 'CLIP_TRANSITION_WORKSPACE_REQUIRED'] as const);

export interface TimelineClipTransitionResponse {
  operation: typeof TIMELINE_CLIP_TRANSITION_OPERATION; requestId: string; timeline: Rec; clipId: string;
  previousTransition: ClipTransition | null; transition: ClipTransition | null;
}

const id = z.string().uuid();
export const clipTransitionSchema = z.object({
  profileId: z.literal(CLIP_TRANSITION_PROFILE),
  kind: z.enum(CLIP_TRANSITION_KINDS).describe('dissolve, dipToBlack, wipeLeft, wipeRight, pushLeft or pushRight.'),
  durationFrames: z.number().int().min(CLIP_TRANSITION_LIMITS.minFrames).max(CLIP_TRANSITION_LIMITS.maxFrames)
    .describe('Timeline frames, centred on the cut: half before it from the incoming clip, the rest after it from the outgoing clip.'),
}).strict();
export const timelineClipTransitionSchemas = Object.freeze({
  [TIMELINE_CLIP_TRANSITION_OPERATION]: z.object({projectId: id, expectedRevision: z.number().int().positive(), requestId: z.string().min(8).max(200),
    clipId: id.describe('The incoming clip: the cut is where it starts.'), transition: clipTransitionSchema.nullable().describe('The new transition, or null to remove it.')}).strict(),
});
export const timelineClipTransitionDescriptions = Object.freeze({
  [TIMELINE_CLIP_TRANSITION_OPERATION]: '按时间线版本设置或清除同一视频轨上首尾相接两段之间的画面转场（溶解、黑场、向左或向右擦除、向左或向右推移，2–60帧），挂在后一段上、居中跨在切点：切点前用后一段入点前的素材余量，切点后用前一段出点后的余量；没有相接的前一段、余量或片段长度不够、转场没有变化时不写入；声音保持硬切；记一条历史，撤销一次复原；不处理媒体；使用必填稳定requestId精确重放',
});

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exactKeys = (value: Rec, required: readonly string[]): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name));
const same = (left: unknown, right: unknown): boolean => {
  try {return JSON.stringify(canonicalClipTransition((left ?? null) as ClipTransition | null)) === JSON.stringify(canonicalClipTransition((right ?? null) as ClipTransition | null));} catch {return false;}
};
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_CLIP_TRANSITION_RESPONSE_BYTES;} catch {return false;}
}
/** Binds every identity field of a not-applied proof, as clip transforms do. */
export function hasTimelineClipTransitionNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    if (operation !== TIMELINE_CLIP_TRANSITION_OPERATION || !timelineClipTransitionSchemas[TIMELINE_CLIP_TRANSITION_OPERATION].safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_CLIP_TRANSITION_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}

/** Uses the single established timeline validator. The saved clip must carry
 * exactly the requested transition (none when it was cleared), and the previous
 * transition must differ from it. */
export function createTimelineClipTransitionContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function isTimelineClipTransitionResponse(value: unknown, input: unknown): value is TimelineClipTransitionResponse {
    try {
      const parsed = timelineClipTransitionSchemas[TIMELINE_CLIP_TRANSITION_OPERATION].safeParse(input);
      if (!parsed.success || !object(value) || !bounded(value) || !exactKeys(value, ['operation', 'requestId', 'timeline', 'clipId', 'previousTransition', 'transition']) ||
        value.operation !== TIMELINE_CLIP_TRANSITION_OPERATION || value.requestId !== parsed.data.requestId || value.clipId !== parsed.data.clipId ||
        parsed.data.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value.timeline, {projectId: parsed.data.projectId}) ||
        !object(value.timeline) || value.timeline.revision !== parsed.data.expectedRevision + 1 || !same(value.transition, parsed.data.transition) ||
        value.previousTransition !== null && !clipTransitionSchema.safeParse(value.previousTransition).success || same(value.previousTransition, value.transition)) return false;
      const clips = (value.timeline as {clips?: unknown}).clips;
      const clip = Array.isArray(clips) ? clips.find(item => object(item) && item.id === parsed.data.clipId) as Rec | undefined : undefined;
      return !!clip && (parsed.data.transition === null ? !Object.hasOwn(clip, 'transitionIn') : same(clip.transitionIn, parsed.data.transition));
    } catch {return false;}
  }
  return {isTimelineClipTransitionResponse};
}
