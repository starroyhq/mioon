import {
  splitVolumeEnvelopeFields, validateVolumeEnvelope, VOLUME_ENVELOPE_LIMITS, VOLUME_ENVELOPE_PROFILE,
  type VolumeEnvelope, type VolumeEnvelopeClip, type VolumeEnvelopeFields,
} from './timeline-volume-envelope.ts';

function invalid(message: string): never {
  throw Object.assign(Error(message), {code: 'INVALID_VOLUME_ENVELOPE'});
}

function checkDuration(durationFrames: number, maxFrames: number): void {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1 || !(durationFrames <= maxFrames)) {
    invalid('Invalid clip duration.');
  }
}

function ownDataFields<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
}

/** Format 6 can store envelopes on long outputs without expanding the
 * calibrated legacy processing profile. Validate their actual frame domain
 * and reuse the legacy validator for every other part of the envelope. */
export function validateEditingVolumeEnvelope(value: unknown, durationFrames: number,
  maxFrames: number = VOLUME_ENVELOPE_LIMITS.frames): VolumeEnvelope | null {
  checkDuration(durationFrames, maxFrames);
  if (durationFrames <= VOLUME_ENVELOPE_LIMITS.frames) return validateVolumeEnvelope(value, durationFrames);
  if (value === null) return null;
  if (!ownDataFields(value, ['profileId', 'points']) || !Array.isArray(value.points) ||
      Object.getPrototypeOf(value.points) !== Array.prototype || value.points.length > VOLUME_ENVELOPE_LIMITS.points) {
    invalid('Invalid envelope shape or point count.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value.points);
  if (Reflect.ownKeys(descriptors).length !== value.points.length + 1) invalid('Invalid point list.');
  const boundedPoints: {frame: number; multiplier: unknown}[] = [];
  let previous = -1;
  for (let index = 0; index < value.points.length; index++) {
    const descriptor = descriptors[index];
    const point: unknown = descriptor?.value;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
        !ownDataFields(point, ['frame', 'multiplier'])) invalid('Invalid point list.');
    const {frame, multiplier} = point;
    if (typeof frame !== 'number' || !Number.isSafeInteger(frame) || Object.is(frame, -0) ||
        frame <= previous || frame > durationFrames) invalid('Invalid point time or multiplier.');
    previous = frame;
    boundedPoints.push({frame: index, multiplier});
  }
  validateVolumeEnvelope({profileId: value.profileId, points: boundedPoints}, VOLUME_ENVELOPE_LIMITS.frames);
  return value as VolumeEnvelope;
}

export function isEditingVolumeEnvelope(value: unknown, durationFrames: number, maxFrames?: number): value is VolumeEnvelope | null {
  try {validateEditingVolumeEnvelope(value, durationFrames, maxFrames); return true;} catch {return false;}
}

function multiplierAtCut(points: VolumeEnvelope['points'], cutFrame: number): number {
  const nextIndex = points.findIndex(point => point.frame >= cutFrame);
  if (nextIndex < 0) return points.at(-1)!.multiplier;
  const next = points[nextIndex]!;
  if (nextIndex === 0 || next.frame === cutFrame) return next.multiplier;
  const previous = points[nextIndex - 1]!;
  return previous.multiplier + (next.multiplier - previous.multiplier) *
    ((cutFrame - previous.frame) / (next.frame - previous.frame));
}

/** Keep the same local-frame and interpolated endpoint rules when the
 * editable duration exceeds the legacy rendering limit. */
export function splitEditingVolumeEnvelopeFields(clip: VolumeEnvelopeClip, cutFrame: number,
  maxFrames: number = VOLUME_ENVELOPE_LIMITS.frames): [VolumeEnvelopeFields, VolumeEnvelopeFields] {
  if (!clip || typeof clip !== 'object') invalid('Invalid clip.');
  checkDuration(clip.durationFrames, maxFrames);
  if (clip.durationFrames <= VOLUME_ENVELOPE_LIMITS.frames) return splitVolumeEnvelopeFields(clip, cutFrame);
  if (!Number.isSafeInteger(cutFrame) || cutFrame < 1 || cutFrame >= clip.durationFrames) invalid('Split must be inside clip.');
  const descriptor = Object.getOwnPropertyDescriptor(clip, 'volumeEnvelope');
  if (descriptor === undefined) return [{}, {}];
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('Invalid envelope field.');
  const envelope = validateEditingVolumeEnvelope(descriptor.value, clip.durationFrames, maxFrames);
  if (envelope === null) return [{volumeEnvelope: null}, {volumeEnvelope: null}];
  const {points} = envelope;
  const left = points.filter(point => point.frame <= cutFrame).map(point => ({...point}));
  const right = points.filter(point => point.frame >= cutFrame)
    .map(point => ({frame: point.frame - cutFrame, multiplier: point.multiplier}));
  const multiplier = multiplierAtCut(points, cutFrame);
  if (!left.length || left.at(-1)!.frame < cutFrame && points.at(-1)!.frame > cutFrame) left.push({frame: cutFrame, multiplier});
  if (!right.length || right[0]!.frame > 0 && points[0]!.frame < cutFrame) right.unshift({frame: 0, multiplier});
  return [
    {volumeEnvelope: validateEditingVolumeEnvelope({profileId: VOLUME_ENVELOPE_PROFILE, points: left}, cutFrame, maxFrames)},
    {volumeEnvelope: validateEditingVolumeEnvelope({profileId: VOLUME_ENVELOPE_PROFILE, points: right}, clip.durationFrames - cutFrame, maxFrames)},
  ];
}
