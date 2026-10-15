import {validateVolumeEnvelope, volumeEnvelopeFieldsAfterEdit, VOLUME_ENVELOPE_PROFILE} from './timeline-volume-envelope.ts';
import type {VolumeEnvelope, VolumeEnvelopeClip} from './timeline-volume-envelope.ts';
export type TimelineVolumeEnvelope = VolumeEnvelope;
export type TimelineVolumeEnvelopeClip = VolumeEnvelopeClip;
export const VOLUME_ENVELOPE_PROCESSING_PROFILE = VOLUME_ENVELOPE_PROFILE;
export const VOLUME_ENVELOPE_PROCESSING_SNAPSHOT_BYTES = 256 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Bounded ordinary-data processing projection, not Node ingress or authority. */
export function volumeEnvelopeField(clip: unknown): {volumeEnvelope?: VolumeEnvelope|null} {
  if (!object(clip)) throw new Error('Invalid envelope clip.');
  return volumeEnvelopeFieldsAfterEdit(clip as unknown as VolumeEnvelopeClip, {});
}
export function isVolumeEnvelope(value: unknown, durationFrames: number): value is VolumeEnvelope|null {
  try {validateVolumeEnvelope(value, durationFrames); return true;} catch {return false;}
}
export function volumeEnvelopeProcessingProfile(clips: readonly unknown[]): typeof VOLUME_ENVELOPE_PROFILE|undefined {
  let active = false;
  for (const clip of clips) {const fields = volumeEnvelopeField(clip); if (fields.volumeEnvelope != null) active = true;}
  return active ? VOLUME_ENVELOPE_PROFILE : undefined;
}
export function volumeEnvelopeSnapshotFields(timeline: {clips: readonly unknown[]}): {volumeEnvelopeProfile?: typeof VOLUME_ENVELOPE_PROFILE} {
  const profile = volumeEnvelopeProcessingProfile(timeline.clips);
  return profile === undefined ? {} : {volumeEnvelopeProfile: profile};
}
/** Exact dispatch, with a complete-wrapper budget only for the new field path.
 * Historical snapshots keep their original validation and byte behavior. */
export function isVolumeEnvelopeProcessingSnapshot(snapshot: unknown): boolean {
  if (!object(snapshot)) return false;
  if (!object(snapshot.timeline) || !Array.isArray(snapshot.timeline.clips)) return !Object.hasOwn(snapshot, 'volumeEnvelopeProfile');
  const clips = snapshot.timeline.clips;
  if (!clips.some(clip => object(clip) && Object.hasOwn(clip, 'volumeEnvelope')))
    return !Object.hasOwn(snapshot, 'volumeEnvelopeProfile');
  if (clips.length > 100) return false;
  try {
    const expected = volumeEnvelopeProcessingProfile(clips);
    if (Object.hasOwn(snapshot, 'volumeEnvelopeProfile') !== (expected !== undefined) || snapshot.volumeEnvelopeProfile !== expected) return false;
    return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= VOLUME_ENVELOPE_PROCESSING_SNAPSHOT_BYTES;
  } catch {return false;}
}
/** Trusted bounded reader adapter. Missing profile is derived; an explicitly
 * supplied profile is evidence and must never be normalized or overwritten. */
export function volumeEnvelopeReadSnapshot<T extends Record<string, unknown>>(raw: T): T & {volumeEnvelopeProfile?: typeof VOLUME_ENVELOPE_PROFILE} {
  if (!object(raw.timeline) || !Array.isArray(raw.timeline.clips)) throw new Error('Invalid processing timeline.');
  const fields = volumeEnvelopeSnapshotFields({clips: raw.timeline.clips});
  if (Object.hasOwn(raw, 'volumeEnvelopeProfile') &&
      (fields.volumeEnvelopeProfile === undefined || raw.volumeEnvelopeProfile !== fields.volumeEnvelopeProfile))
    throw new Error('Mismatched volume envelope processing profile.');
  const snapshot = fields.volumeEnvelopeProfile === undefined ? raw : {...raw, ...fields};
  if (!isVolumeEnvelopeProcessingSnapshot(snapshot)) throw new Error('Invalid volume envelope processing snapshot or byte budget.');
  return snapshot as T & {volumeEnvelopeProfile?: typeof VOLUME_ENVELOPE_PROFILE};
}
