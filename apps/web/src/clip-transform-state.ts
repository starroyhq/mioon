import { CLIP_TRANSFORM_LIMITS, CLIP_TRANSFORM_PROFILE, clipTransformAt, isClipTransform, type ClipTransform, type ClipTransformKeyframe } from '@mioon/contracts';

// Numeric keyframe editing for the clip inspector. Each action produces the
// complete next transform for timeline.clip.setTransform; nothing is drafted.
export interface TransformClip { readonly durationFrames: number; readonly transform?: unknown }
export interface TransformFields { readonly x: string; readonly y: string; readonly scale: string }
export type TransformIssue = 'clip.transform.invalid' | 'clip.transform.full' | '';

const IDENTITY_CROP = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
/** The saved transform, or null when the clip has none or an unreadable one. */
export function savedClipTransform(clip: TransformClip): ClipTransform | null {
  return Object.hasOwn(clip, 'transform') && isClipTransform(clip.transform, clip.durationFrames) ? clip.transform as ClipTransform | null : null;
}
const round = (value: number, digits: number): number => Number(value.toFixed(digits));
/** The clip-local frame the playhead points at, clamped into the clip. */
export function transformFrame(clip: { startFrame: number; durationFrames: number }, playhead: number): number {
  return Math.min(clip.durationFrames, Math.max(0, Math.round(playhead) - clip.startFrame));
}
/** Values shown at a frame: a keyframe's own values, or those its keyframes give there (held or interpolated). */
export function transformFields(clip: TransformClip, frame: number): TransformFields {
  const value = clipTransformAt({ durationFrames: clip.durationFrames, transform: savedClipTransform(clip) }, frame);
  return { x: String(round(value.x, 2)), y: String(round(value.y, 2)), scale: String(round(value.scale * 100, 2)) };
}
export function keyframeAt(clip: TransformClip, frame: number): ClipTransformKeyframe | null {
  return savedClipTransform(clip)?.keyframes.find(point => point.frame === frame) ?? null;
}
function parse(fields: TransformFields): { x: number; y: number; scale: number } | null {
  const [x, y, percent] = [fields.x, fields.y, fields.scale].map(value => value.trim() === '' ? NaN : Number(value));
  const scale = percent! / 100, offset = CLIP_TRANSFORM_LIMITS.offset;
  if (![x, y, percent].every(Number.isFinite) || Math.abs(x!) > offset || Math.abs(y!) > offset ||
      scale < CLIP_TRANSFORM_LIMITS.minScale || scale > CLIP_TRANSFORM_LIMITS.maxScale) return null;
  // Negative zero is not a stored value.
  return { x: x! + 0, y: y! + 0, scale };
}
export function transformIssue(clip: TransformClip, frame: number, fields: TransformFields): TransformIssue {
  if (!parse(fields)) return 'clip.transform.invalid';
  const saved = savedClipTransform(clip);
  return saved && saved.keyframes.length >= CLIP_TRANSFORM_LIMITS.keyframes && !keyframeAt(clip, frame) ? 'clip.transform.full' : '';
}
/** Adds a keyframe at the frame, or replaces the one already there. */
export function withKeyframe(clip: TransformClip, frame: number, fields: TransformFields): ClipTransform | null {
  const value = parse(fields);
  if (!value || transformIssue(clip, frame, fields)) return null;
  const saved = savedClipTransform(clip);
  const keyframes = [...(saved?.keyframes ?? []).filter(point => point.frame !== frame), { frame, ...value }].sort((a, b) => a.frame - b.frame);
  return { profileId: CLIP_TRANSFORM_PROFILE, keyframes, rotation: saved?.rotation ?? 0, crop: saved?.crop ?? IDENTITY_CROP };
}
/** Removes the keyframe at the frame. Without keyframes the transform ends,
 * unless it still rotates or crops: then the identity keyframe stays. */
export function withoutKeyframe(clip: TransformClip, frame: number): ClipTransform | null {
  const saved = savedClipTransform(clip);
  if (!saved) return null;
  const keyframes = saved.keyframes.filter(point => point.frame !== frame);
  if (keyframes.length) return { ...saved, keyframes };
  const staticPart = saved.rotation !== 0 || Object.values(saved.crop).some(edge => edge !== 0);
  return staticPart ? { ...saved, keyframes: [{ frame: 0, x: 0, y: 0, scale: 1 }] } : null;
}
