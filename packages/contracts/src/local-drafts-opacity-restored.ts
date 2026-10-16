/** Current-origin restored43 companion only. It never admits a source42 v3
 * file, promotes a captured draft or authorizes a timeline operation. */
import {z} from 'zod';
import {LOCAL_DRAFT_LIMITS, clipDraftKeySchema, clipDraftProjectSchema, clipDraftDeleteSchema, clipDraftListSchema} from './local-drafts.ts';
import {clipDraftOpacityCandidateWriteSchema, clipDraftOpacityCandidateEnvelopeSchema,
  clipDraftOpacityCandidateDiskV3Schema, captureClipDraftOpacityCandidateSlot} from './local-drafts-opacity-candidate.ts';

export const OPACITY_RESTORED_DRAFT_PROFILE = 'mioon-opacity-restored-draft-v1' as const;
export const OPACITY_RESTORED_DRAFT_CAPABILITY = Object.freeze({schemaVersion: 1 as const,
  profileId: OPACITY_RESTORED_DRAFT_PROFILE, policy: 'new-origin-only' as const});
export const opacityRestoredDraftCapabilitySchema = z.object({schemaVersion: z.literal(1),
  profileId: z.literal(OPACITY_RESTORED_DRAFT_PROFILE), policy: z.literal('new-origin-only')}).strict();
const origin = z.string().length(36).uuid();
const invocation = {schemaVersion: z.literal(1), expectedWorkspaceOrigin: origin};
const response = {schemaVersion: z.literal(1), profileId: z.literal(OPACITY_RESTORED_DRAFT_PROFILE), workspaceOrigin: origin};
export const clipDraftOpacityRestoredReadSchema = clipDraftKeySchema.extend(invocation).strict();
export const clipDraftOpacityRestoredProjectSchema = clipDraftProjectSchema.extend(invocation).strict();
export const clipDraftOpacityRestoredWriteSchema = clipDraftOpacityCandidateWriteSchema.extend(invocation).strict();
export const clipDraftOpacityRestoredDeleteSchema = clipDraftDeleteSchema.extend(invocation).strict();
export const clipDraftOpacityRestoredEnvelopeSchema = clipDraftOpacityCandidateEnvelopeSchema.options[1].extend(response).strict();
export const clipDraftOpacityRestoredListSchema = clipDraftListSchema.options[1].extend(response).strict();
export const clipDraftOpacityRestoredDiskSchema = clipDraftOpacityCandidateDiskV3Schema.extend({
  version: z.literal(1), profileId: z.literal(OPACITY_RESTORED_DRAFT_PROFILE), workspaceOrigin: origin,
}).strict();
export type ClipDraftOpacityRestoredRead = z.infer<typeof clipDraftOpacityRestoredReadSchema>;
export type ClipDraftOpacityRestoredProject = z.infer<typeof clipDraftOpacityRestoredProjectSchema>;
export type ClipDraftOpacityRestoredWrite = z.infer<typeof clipDraftOpacityRestoredWriteSchema>;
export type ClipDraftOpacityRestoredDelete = z.infer<typeof clipDraftOpacityRestoredDeleteSchema>;
export type ClipDraftOpacityRestoredEnvelope = z.infer<typeof clipDraftOpacityRestoredEnvelopeSchema>;
export type ClipDraftOpacityRestoredList = z.infer<typeof clipDraftOpacityRestoredListSchema>;
export type ClipDraftOpacityRestoredDisk = z.infer<typeof clipDraftOpacityRestoredDiskSchema>;

/** The fixed root origin/profile binds all original v3-shaped slots. Full
 * row, duplicate-key and disk-byte checks precede exposing any saved input. */
export function captureClipDraftOpacityRestoredDisk(value: unknown) {
  const disk = clipDraftOpacityRestoredDiskSchema.parse(value), keys = new Set<string>();
  for (const slot of disk.entries) {
    captureClipDraftOpacityCandidateSlot(slot);
    const key = JSON.stringify([slot.projectId, slot.timelineId, slot.clipId]);
    if (keys.has(key)) throw Object.assign(new Error('Duplicate restored draft key.'), {code: 'OPACITY_RESTORED_DRAFT_DUPLICATE_KEY'});
    keys.add(key);
  }
  const text = JSON.stringify(disk) + '\n', bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > LOCAL_DRAFT_LIMITS.envelopeBytes) throw Object.assign(new Error('Restored draft disk exceeds its byte limit.'), {code: 'OPACITY_RESTORED_DRAFT_DISK_LIMIT'});
  return {disk, text, bytes};
}
