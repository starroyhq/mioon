/** Strict clip-local opacity envelope values. This module grants no
 * source eligibility, workspace compatibility or rendering capability. */
export const OPACITY_ENVELOPE_PROFILE = 'mioon-clip-linear-opacity-v1';
// Seven points add 24 nodes. The largest existing update is 99 nodes;
// prepare's four-node outer shell makes 127, within the unchanged 128 cap.
// Eight points would make 130. Full byte/shape admission remains separate.
export const OPACITY_ENVELOPE_LIMITS = Object.freeze({points: 7, frames: 18000});

export interface OpacityEnvelopePoint {readonly frame: number; readonly opacity: number}
export interface OpacityEnvelope {
  readonly profileId: typeof OPACITY_ENVELOPE_PROFILE;
  readonly points: readonly OpacityEnvelopePoint[];
}

type Value = Record<string, unknown>;
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const fail = (message: string): never => {
  throw Object.assign(new Error(message), {code: 'INVALID_OPACITY_ENVELOPE'});
};
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
function duration(value: unknown): number {
  if (!integer(value, 1, OPACITY_ENVELOPE_LIMITS.frames)) return fail('Invalid clip duration.');
  return value;
}

/** Capture own data descriptors before reading values. Other clip/patch fields
 * remain caller-owned: this is not a complete timeline or operation validator.
 * Proxy rejection belongs to the platform ingress; portable JS cannot detect a
 * transparent proxy without invoking its traps. */
function dataRecord(value: unknown, keys?: readonly string[]): Value {
  if (value === null || typeof value !== 'object') return fail('Invalid ordinary record.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail('Invalid ordinary record.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (keys && (names.length !== keys.length || keys.some(key => !own(descriptors, key)))) return fail('Invalid record fields.');
  const result: Value = Object.create(null);
  for (const name of names) {
    if (typeof name !== 'string') return fail('Invalid record fields.');
    const descriptor = descriptors[name];
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) return fail('Invalid data field.');
    result[name] = descriptor.value;
  }
  return result;
}

/** Detached, validated capture; never sorts, clamps, defaults or mutates input. */
function captureEnvelope(value: unknown, durationFrames: number): OpacityEnvelope | null {
  if (value === null) return null;
  const record = dataRecord(value, ['profileId', 'points']);
  if (record.profileId !== OPACITY_ENVELOPE_PROFILE || !Array.isArray(record.points) ||
      Object.getPrototypeOf(record.points) !== Array.prototype) return fail('Invalid envelope profile or points.');
  const descriptors = Object.getOwnPropertyDescriptors(record.points as object);
  const length: unknown = descriptors.length?.value;
  if (!integer(length, 1, OPACITY_ENVELOPE_LIMITS.points) || Reflect.ownKeys(descriptors).length !== length + 1) return fail('Invalid point count.');
  const points: OpacityEnvelopePoint[] = [];
  let previous = -1;
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) return fail('Invalid point list.');
    const point = dataRecord(descriptor.value, ['frame', 'opacity']);
    if (!integer(point.frame, 0, durationFrames) || point.frame <= previous ||
        typeof point.opacity !== 'number' || !Number.isFinite(point.opacity) || Object.is(point.opacity, -0) ||
        point.opacity < 0 || point.opacity > 1) return fail('Invalid point frame or opacity.');
    points.push({frame: point.frame, opacity: point.opacity});
    previous = point.frame;
  }
  return {profileId: OPACITY_ENVELOPE_PROFILE, points};
}

/** Returns the exact original value after validation, including explicit null. */
export function validateOpacityEnvelope(value: unknown, durationFrames: number): OpacityEnvelope | null {
  captureEnvelope(value, duration(durationFrames));
  return value as OpacityEnvelope | null;
}
