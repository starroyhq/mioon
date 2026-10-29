import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';

type Rec = Record<string, unknown>;
// Sets the gain of several sounding clips in one keyed timeline edit with one
// history entry, so one undo restores every clip. The dialogue loudness match
// applies the gains it measured through this operation; the server itself
// measures nothing and accepts any gain a clip update would accept.
export const TIMELINE_CLIP_GAINS_OPERATION = 'timeline.clip.setGains';
export const TIMELINE_CLIP_GAINS_LIMITS = Object.freeze({clips: 100});
// The timeline record plus one change per clip.
export const TIMELINE_CLIP_GAINS_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 16 * 1024;
/** Pre-write rejections whose rollback the backend can prove. Their proofs bind
 * operation, project and request.
 * CLIP_GAINS_AUDIO_UNSUPPORTED: a listed source is an image or has no sound.
 * CLIP_GAINS_UNCHANGED: every listed clip already has its listed gain. */
export const TIMELINE_CLIP_GAINS_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'CLIP_NOT_FOUND',
  'CLIP_GAINS_AUDIO_UNSUPPORTED', 'CLIP_GAINS_UNCHANGED'] as const);

/** One listed clip, in request order; previousGain is its gain before the edit. */
export interface TimelineClipGainChange {clipId: string; previousGain: number; gain: number}
export interface TimelineClipGainsResponse {
  operation: typeof TIMELINE_CLIP_GAINS_OPERATION; requestId: string; timeline: Rec; gains: TimelineClipGainChange[];
}

const id = z.string().uuid();
// The same bounds as a clip update's gain.
const gain = z.number().finite().min(0).max(2);
export const timelineClipGainsSchemas = Object.freeze({
  [TIMELINE_CLIP_GAINS_OPERATION]: z.object({projectId: id, expectedRevision: z.number().int().positive(), requestId: z.string().min(8).max(200),
    gains: z.array(z.object({clipId: id, gain: gain.describe('The new linear gain of the clip, 0 to 2.')}).strict())
      .min(1).max(TIMELINE_CLIP_GAINS_LIMITS.clips)
      .refine(list => new Set(list.map(item => item.clipId)).size === list.length, 'each clip may be listed once')}).strict(),
});
export const timelineClipGainsDescriptions = Object.freeze({
  [TIMELINE_CLIP_GAINS_OPERATION]: '按时间线版本一次设置多个有声片段的增益（0–2，与片段更新相同）：每个片段最多出现一次，图片或无声素材会被拒绝，所列片段的增益都没有变化时不写入；所有增益一次写入并记一条历史，撤销一次全部复原；不测量也不处理媒体，响度匹配的建议增益由调用方先用片段响度测量得到；使用必填稳定requestId精确重放',
});

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exactKeys = (value: Rec, required: readonly string[]): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name));
const isGain = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2;
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_CLIP_GAINS_RESPONSE_BYTES;} catch {return false;}
}
/** Binds every identity field of a not-applied proof, as the crossfade does. */
export function hasTimelineClipGainsNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    if (operation !== TIMELINE_CLIP_GAINS_OPERATION || !timelineClipGainsSchemas[TIMELINE_CLIP_GAINS_OPERATION].safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_CLIP_GAINS_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}

/** Uses the single established timeline validator. The changes must list the
 * requested clips in request order with their requested gains, at least one
 * gain must differ from before, and the saved clips must carry the new gains. */
export function createTimelineClipGainsContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function isTimelineClipGainsResponse(value: unknown, input: unknown): value is TimelineClipGainsResponse {
    try {
      const parsed = timelineClipGainsSchemas[TIMELINE_CLIP_GAINS_OPERATION].safeParse(input);
      if (!parsed.success || !object(value) || !bounded(value) || !exactKeys(value, ['operation', 'requestId', 'timeline', 'gains']) ||
        value.operation !== TIMELINE_CLIP_GAINS_OPERATION || value.requestId !== parsed.data.requestId ||
        parsed.data.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value.timeline, {projectId: parsed.data.projectId}) ||
        !object(value.timeline) || value.timeline.revision !== parsed.data.expectedRevision + 1) return false;
      const changes = value.gains, clips = (value.timeline as {clips?: unknown}).clips;
      if (!Array.isArray(changes) || changes.length !== parsed.data.gains.length || !Array.isArray(clips)) return false;
      let changed = false;
      for (const [index, requested] of parsed.data.gains.entries()) {
        const change = changes[index];
        if (!object(change) || !exactKeys(change, ['clipId', 'previousGain', 'gain']) || change.clipId !== requested.clipId ||
          change.gain !== requested.gain || !isGain(change.previousGain)) return false;
        const clip = clips.find(item => object(item) && item.id === requested.clipId) as Rec | undefined;
        if (!clip || clip.gain !== requested.gain) return false;
        if (change.previousGain !== change.gain) changed = true;
      }
      return changed;
    } catch {return false;}
  }
  return {isTimelineClipGainsResponse};
}
