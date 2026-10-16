/** Pure clip-local opacity values and curve algebra. This module grants no
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
export interface OpacityEnvelopeClip {
  readonly durationFrames: number;
  readonly opacityEnvelope?: OpacityEnvelope | null;
}
export type OpacityEnvelopeFields = {readonly opacityEnvelope?: OpacityEnvelope | null};
export interface OpacityEnvelopeEvaluator {
  readonly limitAtFrame: (frame: number) => number;
  readonly atFrame: (frame: number) => number;
}

type Value = Record<string, unknown>;
type CapturedField = {readonly present: false} | {readonly present: true; readonly value: OpacityEnvelope | null};
interface CapturedClip {readonly durationFrames: number; readonly field: CapturedField}
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

function captureClip(value: unknown): CapturedClip {
  const clip = dataRecord(value);
  if (!own(clip, 'durationFrames')) return fail('Missing clip duration.');
  const durationFrames = duration(clip.durationFrames);
  return {durationFrames, field: own(clip, 'opacityEnvelope')
    ? {present: true, value: captureEnvelope(clip.opacityEnvelope, durationFrames)}
    : {present: false}};
}

function opacity(points: readonly OpacityEnvelopePoint[], frame: number): number {
  const first = points[0]!;
  if (frame <= first.frame) return first.opacity;
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1]!, right = points[index]!;
    if (frame === right.frame) return right.opacity;
    if (frame < right.frame) return left.opacity + (right.opacity - left.opacity) * ((frame - left.frame) / (right.frame - left.frame));
  }
  return points[points.length - 1]!.opacity;
}

/** Evaluates integer clip-local frames from an immutable detached capture.
 * limitAtFrame includes durationFrames for boundary algebra; atFrame observes
 * half-open playback membership [0,durationFrames), returning zero outside it. */
export function createOpacityEnvelopeEvaluator(clip: unknown): Readonly<OpacityEnvelopeEvaluator> {
  const captured = captureClip(clip), end = captured.durationFrames;
  const points = captured.field.present ? captured.field.value?.points : undefined;
  return Object.freeze({
    limitAtFrame(frame: number): number {
      if (!integer(frame, 0, end)) return fail('Invalid endpoint frame.');
      return points ? opacity(points, frame) : 1;
    },
    atFrame(frame: number): number {
      if (!integer(frame, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return fail('Invalid playback frame.');
      return frame < 0 || frame >= end ? 0 : points ? opacity(points, frame) : 1;
    },
  });
}

/** Preserve clip-local anchors across start/source edits. Shrinking past an
 * anchor requires a replacement or explicit null in this same patch. Returned
 * fields are detached and preserve absent/null/value without adding defaults. */
export function opacityEnvelopeFieldsAfterEdit(clip: unknown, patch: unknown): OpacityEnvelopeFields {
  const captured = captureClip(clip), submitted = dataRecord(patch);
  const durationFrames = own(submitted, 'durationFrames') ? duration(submitted.durationFrames) : captured.durationFrames;
  if (own(submitted, 'opacityEnvelope')) return {opacityEnvelope: captureEnvelope(submitted.opacityEnvelope, durationFrames)};
  return captured.field.present ? {opacityEnvelope: captureEnvelope(captured.field.value, durationFrames)} : {};
}

/** Split only this field. Interpolated inner endpoints join continuously;
 * held regions omit redundant anchors, so neither side exceeds the point cap. */
export function splitOpacityEnvelopeFields(clip: unknown, cutFrame: number): readonly [OpacityEnvelopeFields, OpacityEnvelopeFields] {
  const captured = captureClip(clip);
  if (!integer(cutFrame, 1, captured.durationFrames - 1)) return fail('Split must be inside clip.');
  if (!captured.field.present) return [{}, {}];
  if (captured.field.value === null) return [{opacityEnvelope: null}, {opacityEnvelope: null}];
  const points = captured.field.value.points, value = opacity(points, cutFrame);
  const left = points.filter(point => point.frame <= cutFrame).map(point => ({...point}));
  const right = points.filter(point => point.frame >= cutFrame).map(point => ({frame: point.frame - cutFrame, opacity: point.opacity}));
  if (left.length === 0) left.push({frame: cutFrame, opacity: value});
  else if (left[left.length - 1]!.frame < cutFrame && points[points.length - 1]!.frame > cutFrame) left.push({frame: cutFrame, opacity: value});
  if (right.length === 0) right.push({frame: 0, opacity: value});
  else if (right[0]!.frame > 0 && points[0]!.frame < cutFrame) right.unshift({frame: 0, opacity: value});
  return [
    {opacityEnvelope: captureEnvelope({profileId: OPACITY_ENVELOPE_PROFILE, points: left}, cutFrame)},
    {opacityEnvelope: captureEnvelope({profileId: OPACITY_ENVELOPE_PROFILE, points: right}, captured.durationFrames - cutFrame)},
  ];
}
