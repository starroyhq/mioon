/** Pure clip transform values, keyframe algebra and geometry shared by the
 * timeline validator, the renderer and the editor. It grants no workspace
 * capability: persisted transforms are admitted from schema70 on elsewhere. */
export interface ClipTransformKeyframe {readonly frame: number; readonly x: number; readonly y: number; readonly scale: number}
export interface ClipTransformCrop {readonly left: number; readonly top: number; readonly right: number; readonly bottom: number}
export interface ClipTransform {
  readonly profileId: typeof CLIP_TRANSFORM_PROFILE;
  /** Clip-local frames 0…durationFrames, strictly increasing. Values hold before
   * the first and after the last keyframe and change linearly between them. */
  readonly keyframes: readonly ClipTransformKeyframe[];
  /** Static clockwise degrees around the content centre. */
  readonly rotation: number;
  /** Static fractions of the source removed from each edge before fitting. */
  readonly crop: ClipTransformCrop;
}
export interface ClipTransformClip {readonly durationFrames: number; readonly transform?: ClipTransform | null}
export type ClipTransformFields = {transform?: ClipTransform | null};
export interface ClipTransformValue {readonly x: number; readonly y: number; readonly scale: number}

export const CLIP_TRANSFORM_PROFILE = 'mioon-clip-transform-v1';
// x/y offset the content centre from the rectangle centre in timeline pixels;
// scale multiplies the size the cropped source has after fitting the rectangle.
export const CLIP_TRANSFORM_LIMITS = Object.freeze({keyframes: 16, frames: 18000, offset: 8192, minScale: 0.05, maxScale: 8, rotation: 180, crop: 0.9});
export const IDENTITY_CLIP_TRANSFORM_VALUE: ClipTransformValue = Object.freeze({x: 0, y: 0, scale: 1});

const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && !Object.is(value, -0) && (value as number) >= min && (value as number) <= max;
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= min && value <= max;
const fail: (message: string) => never = message => {throw Object.assign(new Error(message), {code: 'INVALID_CLIP_TRANSFORM'});};
/** Own enumerable data properties exactly matching keys, on a plain object. */
function record<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => own(descriptors, key) && descriptors[key]!.enumerable && own(descriptors[key]!, 'value'));
}
function duration(value: unknown): number {
  if (!integer(value, 1, CLIP_TRANSFORM_LIMITS.frames)) fail('Invalid clip duration.');
  return value as number;
}

/** Returns the original value; never normalizes, sorts, defaults or mutates it. */
export function validateClipTransform(value: unknown, durationFrames: number): ClipTransform | null {
  duration(durationFrames);
  if (value === null) return null;
  if (!record(value, ['profileId', 'keyframes', 'rotation', 'crop']) || value.profileId !== CLIP_TRANSFORM_PROFILE ||
      !Array.isArray(value.keyframes) || Object.getPrototypeOf(value.keyframes) !== Array.prototype ||
      value.keyframes.length < 1 || value.keyframes.length > CLIP_TRANSFORM_LIMITS.keyframes) fail('Invalid transform shape or keyframe count.');
  const list = value.keyframes as unknown[], descriptors = Object.getOwnPropertyDescriptors(list);
  if (Reflect.ownKeys(descriptors).length !== list.length + 1) fail('Invalid keyframe list.');
  let previous = -1;
  for (let index = 0; index < list.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !own(descriptor, 'value')) fail('Invalid keyframe list.');
    const point: unknown = descriptor!.value, limit = CLIP_TRANSFORM_LIMITS.offset;
    if (!record(point, ['frame', 'x', 'y', 'scale']) || !integer(point.frame, 0, durationFrames) || point.frame <= previous ||
        !finite(point.x, -limit, limit) || !finite(point.y, -limit, limit) ||
        !finite(point.scale, CLIP_TRANSFORM_LIMITS.minScale, CLIP_TRANSFORM_LIMITS.maxScale)) fail('Invalid keyframe time or value.');
    previous = (point as {frame: number}).frame;
  }
  if (!finite(value.rotation, -CLIP_TRANSFORM_LIMITS.rotation, CLIP_TRANSFORM_LIMITS.rotation)) fail('Invalid rotation.');
  const crop: unknown = value.crop, most = CLIP_TRANSFORM_LIMITS.crop;
  if (!record(crop, ['left', 'top', 'right', 'bottom']) || !(['left', 'top', 'right', 'bottom'] as const).every(edge => finite(crop[edge], 0, most)) ||
      (crop.left as number) + (crop.right as number) > most || (crop.top as number) + (crop.bottom as number) > most) fail('Invalid crop.');
  return value as unknown as ClipTransform;
}
export function isClipTransform(value: unknown, durationFrames: number): value is ClipTransform | null {
  try {validateClipTransform(value, durationFrames); return true;} catch {return false;}
}
/** A copy with keys in model order, so equal transforms serialize equally. */
export function canonicalClipTransform(value: ClipTransform | null): ClipTransform | null {
  return value === null ? null : {profileId: value.profileId, keyframes: value.keyframes.map(({frame, x, y, scale}) => ({frame, x, y, scale})),
    rotation: value.rotation, crop: {left: value.crop.left, top: value.crop.top, right: value.crop.right, bottom: value.crop.bottom}};
}
const copy = canonicalClipTransform;
function field(clip: ClipTransformClip): PropertyDescriptor | undefined {
  if (!clip || typeof clip !== 'object') fail('Invalid clip.');
  const descriptor = Object.getOwnPropertyDescriptor(clip, 'transform');
  if (descriptor && (!descriptor.enumerable || !own(descriptor, 'value'))) fail('Invalid transform field.');
  if (descriptor) validateClipTransform(descriptor.value, clip.durationFrames); else duration(clip.durationFrames);
  return descriptor;
}

function interpolate(keyframes: readonly ClipTransformKeyframe[], frame: number): ClipTransformValue {
  const first = keyframes[0]!, last = keyframes.at(-1)!;
  if (frame <= first.frame) return {x: first.x, y: first.y, scale: first.scale};
  if (frame >= last.frame) return {x: last.x, y: last.y, scale: last.scale};
  for (let index = 1; index < keyframes.length; index++) {
    const right = keyframes[index]!, left = keyframes[index - 1]!;
    if (frame === right.frame) return {x: right.x, y: right.y, scale: right.scale};
    if (frame < right.frame) {
      const share = (frame - left.frame) / (right.frame - left.frame);
      return {x: left.x + (right.x - left.x) * share, y: left.y + (right.y - left.y) * share, scale: left.scale + (right.scale - left.scale) * share};
    }
  }
  return {x: last.x, y: last.y, scale: last.scale};
}
/** The position and scale at a clip-local frame. Frames outside the clip hold
 * the nearest keyframe; a clip without a transform is the identity. */
export function clipTransformAt(clip: ClipTransformClip, frame: number): ClipTransformValue {
  const descriptor = field(clip);
  if (!Number.isFinite(frame)) fail('Invalid frame.');
  const value = descriptor?.value as ClipTransform | null | undefined;
  return value ? interpolate(value.keyframes, frame) : IDENTITY_CLIP_TRANSFORM_VALUE;
}
/** True when every frame renders exactly like a clip without a transform. */
export function isIdentityClipTransform(value: ClipTransform | null | undefined): boolean {
  return !value || value.rotation === 0 && Object.values(value.crop).every(edge => edge === 0) &&
    value.keyframes.every(point => point.x === 0 && point.y === 0 && point.scale === 1);
}
export function isAnimatedClipTransform(value: ClipTransform | null | undefined): boolean {
  return !!value && value.keyframes.some(point => point.x !== value.keyframes[0]!.x || point.y !== value.keyframes[0]!.y || point.scale !== value.keyframes[0]!.scale);
}

/** Keeps only keyframes inside 0…end. A keyframe beyond the end is replaced by
 * the interpolated value at the end, so the visible animation is unchanged. */
function truncate(keyframes: readonly ClipTransformKeyframe[], end: number): ClipTransformKeyframe[] {
  const kept = keyframes.filter(point => point.frame <= end).map(point => ({...point}));
  if (keyframes.some(point => point.frame > end) && kept.at(-1)?.frame !== end) kept.push({frame: end, ...interpolate(keyframes, end)});
  return kept;
}
/** Start, source and duration edits keep clip-local keyframe times, as volume
 * envelopes do. A shrink drops keyframes past the new end and adds the
 * interpolated end value instead, so trims never need a transform in the same
 * patch. Returns only the owned field for the caller's complete clip merge. */
export function clipTransformFieldsAfterEdit(clip: ClipTransformClip, patch: {readonly durationFrames?: number}): ClipTransformFields {
  const descriptor = field(clip);
  if (!patch || typeof patch !== 'object') fail('Invalid patch.');
  const end = duration(own(patch, 'durationFrames') ? patch.durationFrames : clip.durationFrames);
  if (!descriptor) return {};
  const value = descriptor.value as ClipTransform | null;
  if (value === null) return {transform: null};
  const next = {...copy(value)!, keyframes: truncate(value.keyframes, end)};
  return {transform: validateClipTransform(next, end)};
}
/** A split keeps every keyframe on its side, rebased for the right part, and
 * adds the interpolated value at the cut where the animation crosses it. */
export function splitClipTransformFields(clip: ClipTransformClip, cutFrame: number): [ClipTransformFields, ClipTransformFields] {
  const descriptor = field(clip);
  if (!integer(cutFrame, 1, clip.durationFrames - 1)) fail('Split must be inside clip.');
  if (!descriptor) return [{}, {}];
  const value = descriptor.value as ClipTransform | null;
  if (value === null) return [{transform: null}, {transform: null}];
  const points = value.keyframes, at = interpolate(points, cutFrame);
  const left = truncate(points, cutFrame);
  const right = points.filter(point => point.frame >= cutFrame).map(point => ({...point, frame: point.frame - cutFrame}));
  if (!right.length || right[0]!.frame > 0 && points[0]!.frame < cutFrame) right.unshift({frame: 0, ...at});
  const part = (keyframes: ClipTransformKeyframe[], length: number): ClipTransformFields =>
    ({transform: validateClipTransform({...copy(value)!, keyframes}, length)});
  return [part(left, cutFrame), part(right, clip.durationFrames - cutFrame)];
}

export interface ClipTransformRect {readonly x: number; readonly y: number; readonly width: number; readonly height: number}
export interface ClipTransformGeometry {
  /** Content centre in timeline pixels. */
  readonly centerX: number; readonly centerY: number;
  /** Content size after crop, fit and scale, before rotation. */
  readonly width: number; readonly height: number;
  readonly rotation: number;
}
/** Where a clip's content sits at a clip-local frame: crop the source, fit it
 * into the rectangle keeping its aspect ratio, then scale, rotate and offset
 * around the rectangle centre. The renderer rounds sizes and positions to
 * whole pixels; this is the exact model the editor shows. */
export function clipTransformGeometry(clip: ClipTransformClip & {readonly rect: ClipTransformRect}, source: {readonly width: number; readonly height: number}, frame: number): ClipTransformGeometry {
  const descriptor = field(clip), value = (descriptor?.value as ClipTransform | null | undefined) ?? null;
  if (!finite(source?.width, 1, Number.MAX_SAFE_INTEGER) || !finite(source?.height, 1, Number.MAX_SAFE_INTEGER)) fail('Invalid source size.');
  const crop = value?.crop ?? {left: 0, top: 0, right: 0, bottom: 0};
  const croppedWidth = source.width * (1 - crop.left - crop.right), croppedHeight = source.height * (1 - crop.top - crop.bottom);
  const fit = Math.min(clip.rect.width / croppedWidth, clip.rect.height / croppedHeight), at = clipTransformAt(clip, frame);
  return {centerX: clip.rect.x + clip.rect.width / 2 + at.x, centerY: clip.rect.y + clip.rect.height / 2 + at.y,
    width: croppedWidth * fit * at.scale, height: croppedHeight * fit * at.scale, rotation: value?.rotation ?? 0};
}
