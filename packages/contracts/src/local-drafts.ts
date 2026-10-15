import {z} from 'zod';
import {clipAudioRoleSchema} from './timeline-audio-role.ts';
import {clipColourSchema} from './timeline-colour.ts';
import {VOLUME_ENVELOPE_PROFILE} from './timeline-volume-envelope.mjs';

// UI-only local input. This is deliberately not a business-operation schema.
export const LOCAL_DRAFT_LIMITS = Object.freeze({slots:128, rowBytes:8192, envelopeBytes:2*1024*1024, httpBytes:12*1024, urlBytes:2048});
const id=z.string().uuid(), revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const unicode=z.string().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u);
const rawNumber=z.union([z.number().finite(),unicode.max(48)]);
export const clipDraftKeySchema=z.object({projectId:id,timelineId:id,clipId:id}).strict();
export const clipDraftSourceSchema=z.object({assetId:id,assetSha256:hash,versionId:id.optional(),shotId:id.optional(),jobId:id.optional()}).strict();
// Frozen legacy v1 input: adding fields here would make old readers unsafe.
export const clipDraftRawV1Schema=z.object({
  name:unicode.max(200),trackId:id,startFrame:rawNumber,durationFrames:rawNumber,sourceInFrame:rawNumber,
  rect:z.object({x:rawNumber,y:rawNumber,width:rawNumber,height:rawNumber}).strict(),gain:rawNumber,
  fadeInFrames:rawNumber.optional(),fadeOutFrames:rawNumber.optional(),
  colour:clipColourSchema.nullable().optional(),
  audioRole:clipAudioRoleSchema.optional(),
}).strict();
// Raw editing text is intentionally not a canonical business envelope. Empty,
// incomplete and out-of-order values remain recoverable within bounded storage.
export const clipDraftVolumeEnvelopeRawSchema=z.object({
  profileId:z.literal(VOLUME_ENVELOPE_PROFILE),
  points:z.array(z.object({
    frame:z.string().max(8).regex(/^[0-9eE+.-]*$/),
    multiplier:z.string().max(32).regex(/^[0-9eE+.-]*$/),
  }).strict()).max(16),
}).strict();
export const clipDraftRawSchema=clipDraftRawV1Schema.extend({volumeEnvelope:clipDraftVolumeEnvelopeRawSchema.nullable().optional()}).strict();
export const clipDraftValueV1Schema=z.object({baseRevision:revision.min(1),source:clipDraftSourceSchema,raw:clipDraftRawV1Schema,updatedAt:z.string().datetime()}).strict();
export const clipDraftValueSchema=z.object({baseRevision:revision.min(1),source:clipDraftSourceSchema,raw:clipDraftRawSchema,updatedAt:z.string().datetime()}).strict();
export const clipDraftProjectSchema=z.object({projectId:id}).strict();
// The backend companion has a separate format. Main workspace SQLite remains
// untouched; an unknown/corrupt companion format is never repaired on a read.
export const clipDraftSlotSchema=clipDraftKeySchema.extend({revision:revision.min(1),draft:clipDraftValueSchema.nullable()}).strict();
export const clipDraftSlotV1Schema=clipDraftKeySchema.extend({revision:revision.min(1),draft:clipDraftValueV1Schema.nullable()}).strict();
export const clipDraftDiskV1Schema=z.object({version:z.literal(1),workspaceScope:hash,entries:z.array(clipDraftSlotV1Schema).max(128)}).strict();
export const clipDraftDiskV2Schema=z.object({version:z.literal(2),workspaceScope:hash,entries:z.array(clipDraftSlotSchema).max(128)}).strict();
export const clipDraftDiskSchema=z.discriminatedUnion('version',[clipDraftDiskV1Schema,clipDraftDiskV2Schema]);
const authority={workspaceScope:hash,instanceId:id};
const cas={...authority,...clipDraftKeySchema.shape,expectedRevision:revision};
export const clipDraftWriteSchema=z.object({...cas,baseRevision:revision.min(1),source:clipDraftSourceSchema,raw:clipDraftRawSchema}).strict();
export const clipDraftDeleteSchema=z.object({...cas,expectedRevision:revision.min(1)}).strict();
export const clipDraftUnsupportedSchema=z.object({supported:z.literal(false),reason:z.literal('RESTORED_WORKSPACE_UNSUPPORTED')}).strict();
const targetStatus=z.enum(['matching','changed','missing']);
export const clipDraftEnvelopeSchema=z.union([clipDraftUnsupportedSchema,z.object({
  supported:z.literal(true),...authority,key:clipDraftKeySchema,revision,targetStatus,draft:clipDraftValueSchema.nullable(),
}).strict()]);
export const clipDraftSummarySchema=z.object({key:clipDraftKeySchema,name:unicode.max(200),baseRevision:revision.min(1),updatedAt:z.string().datetime(),targetStatus}).strict();
export const clipDraftListSchema=z.union([clipDraftUnsupportedSchema,z.object({
  supported:z.literal(true),...authority,projectId:id,limit:z.literal(128),items:z.array(clipDraftSummarySchema).max(128),
}).strict()]);
export type ClipDraftKey=z.infer<typeof clipDraftKeySchema>;
export type ClipDraftSource=z.infer<typeof clipDraftSourceSchema>;
export type ClipDraftVolumeEnvelopeRaw=z.infer<typeof clipDraftVolumeEnvelopeRawSchema>;
export type ClipDraftRawV1=z.infer<typeof clipDraftRawV1Schema>;
export type ClipDraftRaw=z.infer<typeof clipDraftRawSchema>;
export type ClipDraftValue=z.infer<typeof clipDraftValueSchema>;
export type ClipDraftWrite=z.infer<typeof clipDraftWriteSchema>;
export type ClipDraftDelete=z.infer<typeof clipDraftDeleteSchema>;
export type ClipDraftEnvelope=z.infer<typeof clipDraftEnvelopeSchema>;
export type ClipDraftList=z.infer<typeof clipDraftListSchema>;
export type ClipDraftSlot=z.infer<typeof clipDraftSlotSchema>;
export type ClipDraftDisk=z.infer<typeof clipDraftDiskSchema>;
export type LocalClipDraftKey=ClipDraftKey;
export type LocalClipDraftRaw=ClipDraftRaw;
export type LocalClipDraftSource=ClipDraftSource;
export type LocalClipDraftEnvelope=ClipDraftEnvelope;
export const validateLocalClipDraftEnvelope=(value:unknown):value is LocalClipDraftEnvelope=>clipDraftEnvelopeSchema.safeParse(value).success;
