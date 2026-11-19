/** Bounded Mio/MT write actions for the unified format-5 sequence RPC.
 *
 * The model names inspected targets and one action; it never supplies an
 * envelope, allocation or receipt. The tool implementation builds and previews
 * the shared envelope server-side, obtains approval for the stable impact, then
 * commits exactly that envelope + plan digest. */
import {z} from 'zod';
import {sequenceEditClipPropertiesIntentSchema, sequenceEditFormatIntentSchema} from './sequence-edit.ts';
import {FORMAT5_REFERENCE_ROLES} from './project-format5.ts';

const uuid = z.string().uuid();
const offset = z.number().int().min(0).max(9007199254740991);
export const MIO_SEQUENCE_ACTION_LIMITS = Object.freeze({maxTargets: 50, maxText: 120});

const boardEdge = {fromId: uuid, toId: uuid} as const;
const referenceRole = z.enum(FORMAT5_REFERENCE_ROLES);
const subtitleCue = z.object({text: z.string().max(256), startFrame: z.number().int().min(0).max(300000),
  durationFrames: z.number().int().min(1).max(300000), anchor: z.unknown().optional(),
  dialogueRef: z.unknown().optional()}).strict();
const subtitleEdit = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('add'), cue: subtitleCue}).strict(),
  z.object({kind: z.literal('update'), cueId: uuid, patch: z.record(z.unknown())}).strict(),
  z.object({kind: z.literal('remove'), cueId: uuid}).strict(),
]);
const subjectEdit = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('create'), shotId: uuid, subjectId: uuid, role: z.enum(['subject', 'style'])}).strict(),
  z.object({kind: z.literal('set-mode'), bindingId: uuid, bindingMode: z.enum(['follow', 'locked']), subjectVersionId: uuid.nullable()}).strict(),
  z.object({kind: z.literal('detach'), bindingId: uuid}).strict(),
  z.object({kind: z.literal('restore'), bindingId: uuid, bindingMode: z.enum(['follow', 'locked']), subjectVersionId: uuid.nullable()}).strict(),
]);
const point = z.object({x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000)}).strict();
export const mioSequenceActionSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('board-root-create'), name: z.string().min(1).max(200), position: point}).strict(),
  z.object({kind: z.literal('board-shot-append'), name: z.string().min(1).max(200), position: point.optional()}).strict(),
  z.object({kind: z.literal('board-layout-move'), moves: z.array(z.object({nodeId: uuid}).merge(point)).min(1).max(50)}).strict(),
  z.object({kind: z.literal('connect'), ...boardEdge}).strict(),
  z.object({kind: z.literal('disconnect'), ...boardEdge}).strict(),
  z.object({kind: z.literal('insert'), ...boardEdge, nodeId: uuid}).strict(),
  z.object({kind: z.literal('delete-node'), nodeId: uuid}).strict(),
  z.object({kind: z.literal('reorder'), clipId: uuid, beforeClipId: uuid.nullable()}).strict(),
  z.object({kind: z.literal('remove'), clipId: uuid}).strict(),
  z.object({kind: z.literal('split'), clipId: uuid, offsetFrames: z.number().int().min(1).max(18000)}).strict(),
  z.object({kind: z.literal('set-mode'), clipId: uuid, mode: z.enum(['follow', 'locked']),
    versionId: uuid.nullable().optional()}).strict(),
  z.object({kind: z.literal('copy-move'), clipId: uuid, beforeClipId: uuid.nullable()}).strict(),
  z.object({kind: z.literal('subject-binding'), edit: subjectEdit}).strict(),
  z.object({kind: z.literal('reference-attach'), sourceNodeId: uuid, shotId: uuid, role: referenceRole.optional()}).strict(),
  z.object({kind: z.literal('reference-set-role'), edgeId: uuid, shotId: uuid, role: referenceRole}).strict(),
  z.object({kind: z.literal('reference-detach'), edgeId: uuid, shotId: uuid}).strict(),
  z.object({kind: z.literal('clip-properties'),
    edits: sequenceEditClipPropertiesIntentSchema.shape.operation.shape.edits}).strict(),
  z.object({kind: z.literal('subtitles'), edits: z.array(subtitleEdit).min(1).max(100)}).strict(),
  z.object({kind: z.literal('format-set'),
    presetId: sequenceEditFormatIntentSchema.shape.operation.shape.presetId}).strict(),
  z.object({kind: z.literal('split-at-scenes'), assetId: uuid, resultId: uuid}).strict(),
  z.object({kind: z.literal('track-add'), trackKind: z.enum(['video', 'audio']), name: z.string().min(1).max(150).optional()}).strict(),
  z.object({kind: z.literal('track-update'), trackId: uuid, patch: z.object({
    name: z.string().min(1).max(150).optional(), hidden: z.boolean().optional(), muted: z.boolean().optional(),
    orderIndex: z.number().int().min(0).max(11).optional()}).strict()
    .refine(value => Object.keys(value).length > 0, 'At least one track field is required')}).strict(),
]);
export type MioSequenceAction = z.infer<typeof mioSequenceActionSchema>;
export const mioSequenceEditSchemas = Object.freeze({
  'sequence.tool.edit': mioSequenceActionSchema,
  'sequence.tool.undo': z.object({actionId: uuid.optional()}).strict(),
});
export type MioSequenceToolOperation = keyof typeof mioSequenceEditSchemas;
