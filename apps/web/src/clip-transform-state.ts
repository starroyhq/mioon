import { CLIP_TRANSFORM_LIMITS, CLIP_TRANSFORM_PROFILE, clipTransformAt, isClipTransform, isIdentityClipTransform, type ClipTransform, type ClipTransformKeyframe } from '@mioon/contracts';

// Numeric keyframe editing for the clip inspector. Each action produces the
// complete next transform for timeline.clip.setTransform; nothing is drafted.
export interface TransformClip { readonly durationFrames: number; readonly transform?: unknown }
export interface TransformFields { readonly x: string; readonly y: string; readonly scale: string }
export type TransformIssue = 'clip.transform.invalid' | 'clip.transform.full' | '';
/** Rotation in degrees and crop in percent of the source, as typed. */
export interface StaticFields { readonly rotation: string; readonly left: string; readonly top: string; readonly right: string; readonly bottom: string }

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
const EDGES = ['left', 'top', 'right', 'bottom'] as const;
export function staticFields(clip: TransformClip): StaticFields {
  const saved = savedClipTransform(clip), crop = saved?.crop ?? IDENTITY_CROP, percent = (value: number): string => String(round(value * 100, 2));
  return { rotation: String(round(saved?.rotation ?? 0, 2)), left: percent(crop.left), top: percent(crop.top), right: percent(crop.right), bottom: percent(crop.bottom) };
}
function parseStatic(fields: StaticFields): Pick<ClipTransform, 'rotation' | 'crop'> | null {
  const [rotation, ...percent] = [fields.rotation, ...EDGES.map(edge => fields[edge])].map(value => value.trim() === '' ? NaN : Number(value));
  const most = CLIP_TRANSFORM_LIMITS.crop;
  if (!Number.isFinite(rotation) || Math.abs(rotation!) > CLIP_TRANSFORM_LIMITS.rotation || !percent.every(value => Number.isFinite(value) && value >= 0 && value <= most * 100) ||
      percent[0]! + percent[2]! > most * 100 + 1e-9 || percent[1]! + percent[3]! > most * 100 + 1e-9) return null;
  const [left, top, right, bottom] = percent.map(value => value / 100 + 0) as [number, number, number, number];
  // Percent sums of exactly 90 can exceed 0.9 as fractions (0.34 + 0.56):
  // trim the far edge by a few ulps so the contract's own sum check holds.
  const fit = (near: number, far: number): number => { while (near + far > most && far > 0) far = Math.max(0, far - Number.EPSILON); return far; };
  return { rotation: rotation! + 0, crop: { left, top, right: fit(left, right), bottom: fit(top, bottom) } };
}
export function staticIssue(fields: StaticFields): 'clip.transform.staticInvalid' | '' {
  return parseStatic(fields) ? '' : 'clip.transform.staticInvalid';
}
/** Whether valid fields differ from the saved rotation and crop. */
export function staticChanged(clip: TransformClip, fields: StaticFields): boolean {
  const value = parseStatic(fields), saved = savedClipTransform(clip), crop = saved?.crop ?? IDENTITY_CROP;
  return Boolean(value) && (value!.rotation !== (saved?.rotation ?? 0) || EDGES.some(edge => value!.crop[edge] !== crop[edge]));
}
/** The transform with this rotation and crop; the keyframes stay. Without
 * keyframes an identity keyframe holds them, and a transform left without any
 * effect ends (null). Undefined when the fields are invalid. */
export function withStatic(clip: TransformClip, fields: StaticFields): ClipTransform | null | undefined {
  const value = parseStatic(fields);
  if (!value) return undefined;
  const next: ClipTransform = { profileId: CLIP_TRANSFORM_PROFILE, keyframes: savedClipTransform(clip)?.keyframes ?? [{ frame: 0, x: 0, y: 0, scale: 1 }], ...value };
  return isIdentityClipTransform(next) ? null : next;
}
