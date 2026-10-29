import { CLIP_TRANSFORM_LIMITS, clipTransformGeometry } from '@mioon/contracts';
import { savedClipTransform, transformFields, withKeyframe, type TransformFields } from './clip-transform-state.ts';

// The transform box over the rendered timeline preview. Everything here is in
// client pixels relative to the box layer: the <video> shows the whole timeline
// frame contained in its content box, and timeline pixels scale onto that picture.
export interface BoxRect { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
export interface BoxPoint { readonly x: number; readonly y: number }
export interface BoxClip {
  readonly startFrame: number; readonly durationFrames: number; readonly transform?: unknown;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}
export interface BoxValues { readonly x: number; readonly y: number; readonly scale: number }
export interface BoxView { readonly center: BoxPoint; readonly width: number; readonly height: number; readonly rotation: number; readonly factor: number }

/** Pointer travel below this many client pixels is a click, not a drag. */
export const BOX_DRAG_THRESHOLD = 3;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The picture a media element with object-fit: contain shows in its content box. */
export function containedPicture(content: BoxRect, media: { readonly width: number; readonly height: number }): BoxRect | null {
  if (![content.width, content.height, media.width, media.height].every(positive)) return null;
  const factor = Math.min(content.width / media.width, content.height / media.height), width = media.width * factor, height = media.height * factor;
  return { left: content.left + (content.width - width) / 2, top: content.top + (content.height - height) / 2, width, height };
}
/** The clip-local frame under the playhead while the clip is on screen, otherwise null. */
export function boxFrame(clip: { readonly startFrame: number; readonly durationFrames: number }, playhead: number): number | null {
  const frame = Math.round(playhead) - clip.startFrame;
  return frame >= 0 && frame < clip.durationFrames ? frame : null;
}
/** The saved values at a frame, which a drag starts from. */
export function boxValues(clip: BoxClip, frame: number): BoxValues {
  const fields = transformFields(clip, frame);
  return { x: Number(fields.x), y: Number(fields.y), scale: Number(fields.scale) / 100 };
}
export function boxFields(values: BoxValues): TransformFields {
  return { x: String(values.x), y: String(values.y), scale: String(Number((values.scale * 100).toFixed(2))) };
}
export function sameBoxValues(a: BoxValues, b: BoxValues): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale;
}
/** Where the content sits on the picture at a frame; `values` previews a
 * keyframe at that frame before it is saved. */
export function transformBoxView(clip: BoxClip, source: { readonly width?: unknown; readonly height?: unknown } | null | undefined,
  timeline: { readonly width: number; readonly height: number }, picture: BoxRect, frame: number, values?: BoxValues | null): BoxView | null {
  if (!source || !positive(source.width) || !positive(source.height) || !positive(timeline.width) || !positive(timeline.height)) return null;
  const factor = picture.width / timeline.width;
  // A picture of another shape was rendered before a format change.
  if (Math.abs(picture.height / timeline.height - factor) > factor * 0.01) return null;
  const transform = (values ? withKeyframe(clip, frame, boxFields(values)) : null) ?? savedClipTransform(clip);
  const geometry = clipTransformGeometry({ durationFrames: clip.durationFrames, rect: clip.rect, ...(transform ? { transform } : {}) }, { width: source.width, height: source.height }, frame);
  return { center: { x: picture.left + geometry.centerX * factor, y: picture.top + geometry.centerY * factor },
    width: geometry.width * factor, height: geometry.height * factor, rotation: geometry.rotation, factor };
}
/** Dragging the body moves the offset by the pointer travel in timeline pixels. */
export function movedBoxValues(start: BoxValues, travel: BoxPoint, factor: number): BoxValues {
  const limit = CLIP_TRANSFORM_LIMITS.offset;
  // `+ 0` turns a rounded negative zero into zero.
  return { ...start, x: clamp(Math.round(start.x + travel.x / factor), -limit, limit) + 0, y: clamp(Math.round(start.y + travel.y / factor), -limit, limit) + 0 };
}
/** Dragging a corner scales about the content centre by the ratio of the
 * pointer's distances from it, in whole percent. */
export function scaledBoxValues(start: BoxValues, center: BoxPoint, from: BoxPoint, to: BoxPoint): BoxValues {
  const before = Math.hypot(from.x - center.x, from.y - center.y), after = Math.hypot(to.x - center.x, to.y - center.y);
  if (before < BOX_DRAG_THRESHOLD) return start;
  const percent = clamp(Math.round(start.scale * 100 * after / before), CLIP_TRANSFORM_LIMITS.minScale * 100, CLIP_TRANSFORM_LIMITS.maxScale * 100);
  return { ...start, scale: percent / 100 };
}
