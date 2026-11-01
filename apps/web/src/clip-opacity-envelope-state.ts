import { OPACITY_ENVELOPE_PROFILE, OPACITY_ENVELOPE_LIMITS, validateOpacityEnvelope } from '../../../packages/contracts/src/timeline-opacity-envelope.ts';
import type { OpacityEnvelope, OpacityEnvelopeClip } from '../../../packages/contracts/src/timeline-opacity-envelope.ts';

/** Raw keyframe form text is bounded and grants no capability. */
export const RAW_OPACITY_ENVELOPE_LIMITS = Object.freeze({ frame: 8, opacity: 32, points: OPACITY_ENVELOPE_LIMITS.points });
export type RawOpacityEnvelope = { profileId: typeof OPACITY_ENVELOPE_PROFILE; points: { frame: string; opacity: string }[] };
export type RawOpacityPoint = RawOpacityEnvelope['points'][number];
export type RawOpacityEnvelopeFields = { opacityEnvelope?: RawOpacityEnvelope | null };
export type OpacityEnvelopeFields = { opacityEnvelope?: OpacityEnvelope | null };
export type OpacityPointField = keyof RawOpacityPoint;
/** Parent synchronously marks pending as dirty and blocks Save, close and owner
 * changes. Bind the session to that owner; unmount alone must not release it. */
export type OpacityEnvelopeComposition = { session: symbol; pending: true; dirty: true; row: number; field: OpacityPointField; text: string } | { session: symbol; pending: false; dirty: false };
const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => own(value, key));
export function acceptsOpacityEnvelopeText(field: OpacityPointField, value: string): boolean {
  return value.length <= RAW_OPACITY_ENVELOPE_LIMITS[field] && /^[0-9eE+.\-]*$/.test(value);
}
/** Empty/incomplete numerals and zero points remain recoverable draft text. */
export function isRawOpacityEnvelope(value: unknown): value is RawOpacityEnvelope {
  return record(value, ['profileId', 'points']) && value.profileId === OPACITY_ENVELOPE_PROFILE && Array.isArray(value.points) &&
    value.points.length <= RAW_OPACITY_ENVELOPE_LIMITS.points && Array.from(value.points).every(point => record(point, ['frame', 'opacity']) &&
      typeof point.frame === 'string' && typeof point.opacity === 'string' && acceptsOpacityEnvelopeText('frame', point.frame) && acceptsOpacityEnvelopeText('opacity', point.opacity));
}
export function rawOpacityEnvelopeFields(saved: OpacityEnvelopeClip): RawOpacityEnvelopeFields {
  if (!own(saved, 'opacityEnvelope')) return {};
  const value = validateOpacityEnvelope(saved.opacityEnvelope, saved.durationFrames);
  return { opacityEnvelope: value === null ? null : { profileId: value.profileId, points: value.points.map(point => ({ frame: String(point.frame), opacity: String(point.opacity) })) } };
}
const numeral = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export type OpacityEnvelopeValidation = { valid: true; fields: OpacityEnvelopeFields } | { valid: false; reason: 'duration' | 'shape' | 'points' };
/** Validate against proposed duration even when only another field was edited. */
export function validateRawOpacityEnvelope(fields: RawOpacityEnvelopeFields, proposedDuration: number): OpacityEnvelopeValidation {
  if (!Number.isSafeInteger(proposedDuration) || proposedDuration < 1 || proposedDuration > OPACITY_ENVELOPE_LIMITS.frames) return { valid: false, reason: 'duration' };
  if (!own(fields, 'opacityEnvelope')) return { valid: true, fields: {} };
  if (fields.opacityEnvelope === null) return { valid: true, fields: { opacityEnvelope: null } };
  if (!isRawOpacityEnvelope(fields.opacityEnvelope)) return { valid: false, reason: 'shape' };
  const points = fields.opacityEnvelope.points;
  if (!points.every(point => numeral.test(point.frame) && numeral.test(point.opacity))) return { valid: false, reason: 'points' };
  try {
    const value = validateOpacityEnvelope({ profileId: OPACITY_ENVELOPE_PROFILE, points: points.map(point => ({ frame: Number(point.frame), opacity: Number(point.opacity) })) }, proposedDuration);
    return { valid: true, fields: { opacityEnvelope: value } };
  } catch { return { valid: false, reason: 'points' }; }
}
function sameEnvelope(a: RawOpacityEnvelope | OpacityEnvelope | null | undefined, b: RawOpacityEnvelope | OpacityEnvelope | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.profileId !== b.profileId || a.points.length !== b.points.length) return false;
  return a.points.every((point, index) => Object.is(point.frame, b.points[index].frame) && Object.is(point.opacity, b.points[index].opacity));
}
export function rawOpacityEnvelopeChanged(a: RawOpacityEnvelopeFields, b: RawOpacityEnvelopeFields): boolean {
  return own(a, 'opacityEnvelope') !== own(b, 'opacityEnvelope') || !sameEnvelope(a.opacityEnvelope, b.opacityEnvelope);
}
/** Caller atomically merges this projection with duration/other clip edits, and
 * owns capability checks, persistence and full response validation. */
export function opacityEnvelopeChange(raw: RawOpacityEnvelopeFields, saved: OpacityEnvelopeClip, proposedDuration: number): OpacityEnvelopeValidation {
  const result = validateRawOpacityEnvelope(raw, proposedDuration);
  if (!result.valid) return result;
  const fields = result.fields;
  if (own(fields, 'opacityEnvelope') === own(saved, 'opacityEnvelope') && sameEnvelope(fields.opacityEnvelope, saved.opacityEnvelope)) return { valid: true, fields: {} };
  if (!own(fields, 'opacityEnvelope') && own(saved, 'opacityEnvelope')) return { valid: false, reason: 'shape' };
  return result;
}
