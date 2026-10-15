import { VOLUME_ENVELOPE_PROFILE, VOLUME_ENVELOPE_LIMITS, validateVolumeEnvelope } from '../../../packages/contracts/src/timeline-volume-envelope.ts';
import type { VolumeEnvelope, VolumeEnvelopeClip } from '../../../packages/contracts/src/timeline-volume-envelope.ts';

/** Dormant form values, NOT the production local-draft schema. */
export const RAW_VOLUME_ENVELOPE_LIMITS = Object.freeze({ frame: 8, multiplier: 32, points: 16 });
export type RawVolumePoint = { frame: string; multiplier: string };
export type RawVolumeEnvelope = { profileId: typeof VOLUME_ENVELOPE_PROFILE; points: RawVolumePoint[] };
export type RawVolumeEnvelopeFields = { volumeEnvelope?: RawVolumeEnvelope | null };
export type VolumeEnvelopeFields = { volumeEnvelope?: VolumeEnvelope | null };
export type VolumePointField = keyof RawVolumePoint;
/** Parent must synchronously treat pending as dirty and block Save, close and
 * owner/navigation changes. Transient text is NOT admitted or persisted input.
 * Bind callbacks to owner/serial; never clear this protection merely on unmount. */
export type VolumeEnvelopeComposition = { session: symbol; pending: true; dirty: true; row: number; field: VolumePointField; text: string } | { session: symbol; pending: false; dirty: false };
const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);
const record = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => own(v, k));
export function acceptsVolumeEnvelopeText(field: VolumePointField, value: string): boolean {
  return value.length <= RAW_VOLUME_ENVELOPE_LIMITS[field] && /^[0-9eE+.\-]*$/.test(value);
}
/** Lexical admission intentionally accepts incomplete numerals and zero points. */
export function isRawVolumeEnvelope(value: unknown): value is RawVolumeEnvelope {
  return record(value, ['profileId', 'points']) && value.profileId === VOLUME_ENVELOPE_PROFILE && Array.isArray(value.points) &&
    value.points.length <= RAW_VOLUME_ENVELOPE_LIMITS.points && Array.from(value.points).every(p => record(p, ['frame', 'multiplier']) &&
      typeof p.frame === 'string' && typeof p.multiplier === 'string' && acceptsVolumeEnvelopeText('frame', p.frame) && acceptsVolumeEnvelopeText('multiplier', p.multiplier));
}
export function rawVolumeEnvelopeFields(saved: VolumeEnvelopeClip): RawVolumeEnvelopeFields {
  if (!own(saved, 'volumeEnvelope')) return {};
  const value = validateVolumeEnvelope(saved.volumeEnvelope, saved.durationFrames);
  return { volumeEnvelope: value === null ? null : { profileId: value.profileId, points: value.points.map(p => ({ frame: String(p.frame), multiplier: String(p.multiplier) })) } };
}
const numeral = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export type VolumeEnvelopeValidation = { valid: true; fields: VolumeEnvelopeFields } | { valid: false; reason: 'duration' | 'shape' | 'points' };
/** Uses proposed duration even when the envelope itself was not changed. */
export function validateRawVolumeEnvelope(fields: RawVolumeEnvelopeFields, proposedDuration: number): VolumeEnvelopeValidation {
  if (!Number.isSafeInteger(proposedDuration) || proposedDuration < 1 || proposedDuration > VOLUME_ENVELOPE_LIMITS.frames) return { valid: false, reason: 'duration' };
  if (!own(fields, 'volumeEnvelope')) return { valid: true, fields: {} };
  if (fields.volumeEnvelope === null) return { valid: true, fields: { volumeEnvelope: null } };
  if (!isRawVolumeEnvelope(fields.volumeEnvelope)) return { valid: false, reason: 'shape' };
  const points = fields.volumeEnvelope.points;
  if (!points.every(p => numeral.test(p.frame) && numeral.test(p.multiplier))) return { valid: false, reason: 'points' };
  try {
    const value = validateVolumeEnvelope({ profileId: VOLUME_ENVELOPE_PROFILE, points: points.map(p => ({ frame: Number(p.frame), multiplier: Number(p.multiplier) })) }, proposedDuration);
    return { valid: true, fields: { volumeEnvelope: value } };
  } catch { return { valid: false, reason: 'points' }; }
}
function sameEnvelope(a: RawVolumeEnvelope | VolumeEnvelope | null | undefined, b: RawVolumeEnvelope | VolumeEnvelope | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.profileId !== b.profileId || a.points.length !== b.points.length) return false;
  return a.points.every((point, i) => Object.is(point.frame, b.points[i].frame) && Object.is(point.multiplier, b.points[i].multiplier));
}
export function rawVolumeEnvelopeChanged(a: RawVolumeEnvelopeFields, b: RawVolumeEnvelopeFields): boolean {
  return own(a, 'volumeEnvelope') !== own(b, 'volumeEnvelope') || !sameEnvelope(a.volumeEnvelope, b.volumeEnvelope);
}
/** Pure changed-field projection. Caller owns atomic merge with duration, Save,
 * capability checks and complete ACK validation (including omitted fields). */
export function volumeEnvelopeChange(raw: RawVolumeEnvelopeFields, saved: VolumeEnvelopeClip, proposedDuration: number): VolumeEnvelopeValidation {
  const result = validateRawVolumeEnvelope(raw, proposedDuration);
  if (!result.valid) return result;
  const a = result.fields;
  if (own(a, 'volumeEnvelope') === own(saved, 'volumeEnvelope') && sameEnvelope(a.volumeEnvelope, saved.volumeEnvelope)) return { valid: true, fields: {} };
  // Absence cannot remove an existing value through an update patch. Clear is null.
  if (!own(a, 'volumeEnvelope') && own(saved, 'volumeEnvelope')) return { valid: false, reason: 'shape' };
  return result;
}
