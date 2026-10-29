import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';
import {CLIP_TRANSFORM_LIMITS, CLIP_TRANSFORM_PROFILE, canonicalClipTransform, type ClipTransform} from './timeline-clip-transform.ts';

type Rec = Record<string, unknown>;
// Sets or clears one visual clip's transform as one keyed timeline edit with
// one history entry. Clip updates never carry a transform, so Mio's clip tools
// keep their schemas; this operation is not offered to Mio.
export const TIMELINE_CLIP_TRANSFORM_OPERATION = 'timeline.clip.setTransform';
// The timeline record plus the previous and the new transform.
export const TIMELINE_CLIP_TRANSFORM_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 8 * 1024;
/** Pre-write rejections whose rollback the backend can prove. Their proofs bind
 * operation, project and request.
 * CLIP_TRANSFORM_UNSUPPORTED: the clip is on an audio track or its source is audio.
 * CLIP_TRANSFORM_INVALID: a keyframe lies past the clip's last frame.
 * CLIP_TRANSFORM_UNCHANGED: the clip already has exactly this transform.
 * CLIP_TRANSFORM_LIMIT: the saved timeline would exceed its size limit.
 * CLIP_TRANSFORM_WORKSPACE_REQUIRED: the workspace predates schema70. */
export const TIMELINE_CLIP_TRANSFORM_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'CLIP_NOT_FOUND',
  'CLIP_TRANSFORM_UNSUPPORTED', 'CLIP_TRANSFORM_INVALID', 'CLIP_TRANSFORM_UNCHANGED', 'CLIP_TRANSFORM_LIMIT', 'CLIP_TRANSFORM_WORKSPACE_REQUIRED'] as const);

export interface TimelineClipTransformResponse {
  operation: typeof TIMELINE_CLIP_TRANSFORM_OPERATION; requestId: string; timeline: Rec; clipId: string;
  previousTransform: ClipTransform | null; transform: ClipTransform | null;
}

const id = z.string().uuid();
const limit = CLIP_TRANSFORM_LIMITS.offset;
const offset = (axis: string) => z.number().finite().min(-limit).max(limit).describe(`Horizontal or vertical offset of the content centre from the clip rectangle centre in timeline pixels (${axis}).`);
const crop = z.number().finite().min(0).max(CLIP_TRANSFORM_LIMITS.crop);
export const clipTransformSchema = z.object({
  profileId: z.literal(CLIP_TRANSFORM_PROFILE),
  keyframes: z.array(z.object({
    frame: z.number().int().min(0).max(CLIP_TRANSFORM_LIMITS.frames).describe('Clip-local frame; at most the clip duration.'),
    x: offset('x'), y: offset('y'),
    scale: z.number().finite().min(CLIP_TRANSFORM_LIMITS.minScale).max(CLIP_TRANSFORM_LIMITS.maxScale).describe('Multiplier of the size the source has after fitting the clip rectangle.'),
  }).strict()).min(1).max(CLIP_TRANSFORM_LIMITS.keyframes)
    .refine(list => list.every((point, index) => index === 0 || point.frame > list[index - 1]!.frame), 'keyframe frames must increase'),
  rotation: z.number().finite().min(-CLIP_TRANSFORM_LIMITS.rotation).max(CLIP_TRANSFORM_LIMITS.rotation).describe('Static clockwise degrees around the content centre.'),
  crop: z.object({left: crop, top: crop, right: crop, bottom: crop}).strict()
    .refine(value => value.left + value.right <= CLIP_TRANSFORM_LIMITS.crop && value.top + value.bottom <= CLIP_TRANSFORM_LIMITS.crop, 'crop must leave a tenth of the source'),
}).strict();
export const timelineClipTransformSchemas = Object.freeze({
  [TIMELINE_CLIP_TRANSFORM_OPERATION]: z.object({projectId: id, expectedRevision: z.number().int().positive(), requestId: z.string().min(8).max(200),
    clipId: id, transform: clipTransformSchema.nullable().describe('The new transform, or null to remove it.')}).strict(),
});
export const timelineClipTransformDescriptions = Object.freeze({
  [TIMELINE_CLIP_TRANSFORM_OPERATION]: '按时间线版本设置或清除一个视频轨片段的变换：位置和缩放关键帧（片段内帧，最多16个，点间线性变化），以及静态旋转和裁切；音频轨片段或音频素材会被拒绝，关键帧超出片段时长或变换没有变化时不写入；记一条历史，撤销一次复原；不处理媒体；使用必填稳定requestId精确重放',
});

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exactKeys = (value: Rec, required: readonly string[]): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name));
const same = (left: unknown, right: unknown): boolean => {
  try {return JSON.stringify(canonicalClipTransform((left ?? null) as ClipTransform | null)) === JSON.stringify(canonicalClipTransform((right ?? null) as ClipTransform | null));} catch {return false;}
};
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_CLIP_TRANSFORM_RESPONSE_BYTES;} catch {return false;}
}
/** Binds every identity field of a not-applied proof, as clip gains do. */
export function hasTimelineClipTransformNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    if (operation !== TIMELINE_CLIP_TRANSFORM_OPERATION || !timelineClipTransformSchemas[TIMELINE_CLIP_TRANSFORM_OPERATION].safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_CLIP_TRANSFORM_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}

/** Uses the single established timeline validator. The saved clip must carry
 * exactly the requested transform (none when it was cleared), and the previous
 * transform must differ from it. */
export function createTimelineClipTransformContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function isTimelineClipTransformResponse(value: unknown, input: unknown): value is TimelineClipTransformResponse {
    try {
      const parsed = timelineClipTransformSchemas[TIMELINE_CLIP_TRANSFORM_OPERATION].safeParse(input);
      if (!parsed.success || !object(value) || !bounded(value) || !exactKeys(value, ['operation', 'requestId', 'timeline', 'clipId', 'previousTransform', 'transform']) ||
        value.operation !== TIMELINE_CLIP_TRANSFORM_OPERATION || value.requestId !== parsed.data.requestId || value.clipId !== parsed.data.clipId ||
        parsed.data.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value.timeline, {projectId: parsed.data.projectId}) ||
        !object(value.timeline) || value.timeline.revision !== parsed.data.expectedRevision + 1 || !same(value.transform, parsed.data.transform) ||
        value.previousTransform !== null && !clipTransformSchema.safeParse(value.previousTransform).success || same(value.previousTransform, value.transform)) return false;
      const clips = (value.timeline as {clips?: unknown}).clips;
      const clip = Array.isArray(clips) ? clips.find(item => object(item) && item.id === parsed.data.clipId) as Rec | undefined : undefined;
      return !!clip && (parsed.data.transform === null ? !Object.hasOwn(clip, 'transform') : same(clip.transform, parsed.data.transform));
    } catch {return false;}
  }
  return {isTimelineClipTransformResponse};
}
