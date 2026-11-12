import {validateClipTransform, type ClipTransform, type ClipTransformRect} from './timeline-clip-transform.ts';
import {timelineOutputPreset, type TimelineOutputPreset} from './timeline-output-geometry.ts';

export const CLIP_LAYOUT_PROFILE = 'mioon-clip-layout-v2';

export interface ClipLayout {
  readonly profileId: typeof CLIP_LAYOUT_PROFILE;
  readonly basisPresetId: TimelineOutputPreset['id'];
}

interface StoredClipPlacement {
  readonly rect: ClipTransformRect;
  readonly durationFrames: number;
  readonly transform?: unknown;
  readonly layout?: unknown;
}

export interface ProjectedClipLayout {
  readonly rect: ClipTransformRect;
  readonly transform: Omit<ClipTransform, 'profileId'> | null;
  readonly basisScaleX: number;
  readonly basisScaleY: number;
}

function exactFields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).length === keys.length
    && keys.every(key => Object.hasOwn(fields, key) && fields[key]!.enumerable && Object.hasOwn(fields[key]!, 'value'));
}

/** A missing layout uses the enclosing historical frame. An explicit layout
 * always uses its saved basis, including when the current frame is smaller. */
export function clipLayoutBasis(clip: {readonly layout?: unknown}, frame: unknown): TimelineOutputPreset | null {
  const property = Object.getOwnPropertyDescriptor(clip, 'layout');
  if (!property) return timelineOutputPreset(frame);
  const layout: unknown = property.value;
  if (!property.enumerable || !Object.hasOwn(property, 'value') || !exactFields(layout, ['profileId', 'basisPresetId'])
      || layout.profileId !== CLIP_LAYOUT_PROFILE || typeof layout.basisPresetId !== 'string') return null;
  return timelineOutputPreset(layout.basisPresetId);
}

export function isClipLayoutRect(clip: {readonly layout?: unknown; readonly rect?: unknown}, frame: unknown): boolean {
  const basis = clipLayoutBasis(clip, frame);
  const rect = clip.rect;
  if (!basis || !exactFields(rect, ['x', 'y', 'width', 'height'])) return false;
  const {x, y, width, height} = rect;
  const even = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value % 2 === 0;
  return even(x) && even(y) && even(width) && even(height) && x >= 0 && y >= 0 && width >= 2 && height >= 2
    && x + width <= basis.width && y + height <= basis.height;
}

/** Derived frame pixels are never written back to the saved clip. Validate
 * v1 limits in the basis first, then keep projected offsets at full precision. */
export function projectClipLayout(clip: StoredClipPlacement, frame: {readonly fps: number; readonly width: number; readonly height: number}): ProjectedClipLayout {
  const basis = clipLayoutBasis(clip, frame);
  if (!basis || !timelineOutputPreset(frame) || !isClipLayoutRect(clip, frame)) {
    throw Object.assign(new Error('Invalid clip layout or rectangle.'), {code: 'INVALID_TIMELINE_SNAPSHOT'});
  }
  const scaleX = frame.width / basis.width, scaleY = frame.height / basis.height;
  const {x, y, width, height} = clip.rect;
  const saved = validateClipTransform(clip.transform ?? null, clip.durationFrames);
  return {
    rect: {x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY},
    transform: saved && {crop: saved.crop, rotation: saved.rotation,
      keyframes: saved.keyframes.map(point => ({...point, x: point.x * scaleX, y: point.y * scaleY}))},
    basisScaleX: scaleX,
    basisScaleY: scaleY,
  };
}
