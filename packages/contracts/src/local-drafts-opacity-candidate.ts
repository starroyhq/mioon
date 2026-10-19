/** Dormant local-draft v3 contract. Importing this module does not select a
 * companion format, upgrade saved bytes or enable a timeline operation. The
 * existing v1/v2 readers and their persistence/authority guards stay separate.
 * These schemas validate ordinary decoded data, not getters or Proxy objects.
 */
import {z} from 'zod';
import {
  LOCAL_DRAFT_LIMITS,
  clipDraftRawSchema,
  clipDraftValueSchema,
  clipDraftSlotSchema,
  clipDraftDiskV2Schema,
  clipDraftWriteSchema,
  clipDraftEnvelopeSchema,
} from './local-drafts.ts';
import {OPACITY_ENVELOPE_PROFILE,OPACITY_ENVELOPE_LIMITS} from './timeline-opacity-envelope.ts';

export const LOCAL_DRAFT_OPACITY_CANDIDATE_VERSION = 3 as const;

// Editing text is deliberately wider than the canonical effect. Empty,
// unfinished, duplicated or out-of-order point values remain recoverable.
export const clipDraftOpacityCandidateEnvelopeRawSchema = z.object({
  profileId:z.literal(OPACITY_ENVELOPE_PROFILE),
  points:z.array(z.object({
    frame:z.string().max(8).regex(/^[0-9eE+.-]*$/),
    opacity:z.string().max(32).regex(/^[0-9eE+.-]*$/),
  }).strict()).max(OPACITY_ENVELOPE_LIMITS.points),
}).strict();

// Extend the frozen schemas without modifying or replacing their validators.
// Serialized row/request/disk budgets remain separate admission checks.
export const clipDraftOpacityCandidateRawSchema = clipDraftRawSchema.extend({
  opacityEnvelope:clipDraftOpacityCandidateEnvelopeRawSchema.nullable().optional(),
}).strict();
export const clipDraftOpacityCandidateValueSchema = clipDraftValueSchema.extend({
  raw:clipDraftOpacityCandidateRawSchema,
}).strict();
export const clipDraftOpacityCandidateSlotSchema = clipDraftSlotSchema.extend({
  draft:clipDraftOpacityCandidateValueSchema.nullable(),
}).strict();
export const clipDraftOpacityCandidateDiskV3Schema = clipDraftDiskV2Schema.extend({
  version:z.literal(LOCAL_DRAFT_OPACITY_CANDIDATE_VERSION),
  entries:z.array(clipDraftOpacityCandidateSlotSchema).max(LOCAL_DRAFT_LIMITS.slots),
}).strict();
export const clipDraftOpacityCandidateWriteSchema = clipDraftWriteSchema.extend({
  raw:clipDraftOpacityCandidateRawSchema,
}).strict();
export const clipDraftOpacityCandidateEnvelopeSchema = z.union([
  clipDraftEnvelopeSchema.options[0],
  clipDraftEnvelopeSchema.options[1].extend({
    draft:clipDraftOpacityCandidateValueSchema.nullable(),
  }).strict(),
]);

export type ClipDraftOpacityCandidateEnvelopeRaw = z.infer<typeof clipDraftOpacityCandidateEnvelopeRawSchema>;
export type ClipDraftOpacityCandidateRaw = z.infer<typeof clipDraftOpacityCandidateRawSchema>;
export type ClipDraftOpacityCandidateValue = z.infer<typeof clipDraftOpacityCandidateValueSchema>;
export type ClipDraftOpacityCandidateSlot = z.infer<typeof clipDraftOpacityCandidateSlotSchema>;
export type ClipDraftOpacityCandidateDiskV3 = z.infer<typeof clipDraftOpacityCandidateDiskV3Schema>;
export type ClipDraftOpacityCandidateWrite = z.infer<typeof clipDraftOpacityCandidateWriteSchema>;
export type ClipDraftOpacityCandidateEnvelope = z.infer<typeof clipDraftOpacityCandidateEnvelopeSchema>;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;
function fail(code: string): never {
  throw Object.assign(new Error('The dormant opacity draft candidate exceeds its retained storage boundary.'), {code});
}
function slotSerialization(slot: ClipDraftOpacityCandidateSlot): {text: string; bytes: number} {
  const text = JSON.stringify(slot), size = bytes(text);
  if (size > LOCAL_DRAFT_LIMITS.rowBytes) fail('OPACITY_DRAFT_CANDIDATE_ROW_LIMIT');
  return {text, bytes: size};
}

/** Complete candidate row admission for ordinary decoded JSON. Zod returns a
 * detached value; this is neither a hostile-object ingress nor a save action. */
export function captureClipDraftOpacityCandidateSlot(value: unknown) {
  const slot = clipDraftOpacityCandidateSlotSchema.parse(value);
  return {slot, ...slotSerialization(slot)};
}

/** Verify the whole v3 companion before returning any detached data. This
 * selects no format and never upgrades v1/v2 input. The disk count includes
 * the newline used by the existing companion serializer. With 128 rows capped
 * at 8192 bytes, accepted rows plus fixed metadata cannot reach 2 MiB; retain
 * that complete-serialization fence without increasing the existing limit. */
export function captureClipDraftOpacityCandidateDiskV3(value: unknown) {
  const disk = clipDraftOpacityCandidateDiskV3Schema.parse(value), keys = new Set<string>();
  for (const slot of disk.entries) {
    slotSerialization(slot);
    const key = JSON.stringify([slot.projectId, slot.timelineId, slot.clipId]);
    if (keys.has(key)) fail('OPACITY_DRAFT_CANDIDATE_DUPLICATE_KEY');
    keys.add(key);
  }
  const text = JSON.stringify(disk) + '\n', size = bytes(text);
  if (size > LOCAL_DRAFT_LIMITS.envelopeBytes) fail('OPACITY_DRAFT_CANDIDATE_DISK_LIMIT');
  return {disk, text, bytes: size};
}
