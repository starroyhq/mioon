/** Bounded Mio/MT write actions for the unified format-5 sequence RPC.
 *
 * The model names inspected targets and one action; it never supplies an
 * envelope, allocation or receipt. The tool implementation builds and previews
 * the shared envelope server-side, obtains approval for the stable impact, then
 * commits exactly that envelope + plan digest. */
import {z} from 'zod';
import {sequenceEditClipPropertiesIntentSchema} from './sequence-edit.ts';
import {FORMAT5_REFERENCE_ROLES} from './project-format5.ts';
import {PREVIS_LIMITS, previsSceneSchema} from './previs.ts';

const uuid = z.string().uuid();
const offset = z.number().int().min(0).max(9007199254740991);
export const MIO_SEQUENCE_ACTION_LIMITS = Object.freeze({maxTargets: 50, maxText: 120});

const boardEdge = {fromId: uuid, toId: uuid} as const;
const referenceRole = z.enum(FORMAT5_REFERENCE_ROLES);
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
  z.object({kind: z.literal('board-node-create'), type: z.enum(['image', 'video', 'audio', 'text']),
    name: z.string().min(1).max(150), position: point, assetId: uuid.optional(),
    text: z.string().max(5000).optional()}).strict(),
  z.object({kind: z.literal('board-shot-update'), shotId: uuid, expectedRevision: z.number().int().safe().min(1),
    patch: z.object({title: z.string().min(1).max(500).optional(), prompt: z.string().max(20_000).optional(),
      duration: z.number().finite().min(0.05).max(600).optional(), aspectRatio: z.enum(['9:16', '16:9']).optional(),
      position: point.optional()}).strict()}).strict(),
  z.object({kind: z.literal('board-node-update'), nodeId: uuid, expectedRevision: z.number().int().safe().min(1),
    patch: z.object({name: z.string().min(1).max(150).optional(), text: z.string().max(5000).optional(),
      position: point.optional()}).strict()}).strict(),
  z.object({kind: z.literal('board-restore'), targets: z.array(z.object({kind: z.enum(['shot', 'node']),
    id: uuid}).strict()).min(1).max(50)}).strict(),
  z.object({kind: z.literal('board-duplicate'), targets: z.array(z.object({kind: z.enum(['shot', 'node']),
    id: uuid}).strict()).min(1).max(50), viewport: z.object({x: z.number().finite(), y: z.number().finite(),
      width: z.number().finite().positive(), height: z.number().finite().positive()}).strict().optional()}).strict(),
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
  // MT-5: every material reference line of one shot in order; the first
  // reference image is the primary image. The server checks the list is the
  // complete current set, so a stale list is rejected rather than reordered.
  z.object({kind: z.literal('reference-reorder'), shotId: uuid,
    edgeIds: z.array(uuid).min(1).max(48).refine(ids => new Set(ids).size === ids.length, 'Duplicate edge id')}).strict(),
  // MT-5: subject cards. The node id is allocated by the server; the model may
  // suggest a canvas position, otherwise the server places it on free board space.
  z.object({kind: z.literal('subject-card-create'), subjectId: uuid, position: point.optional()}).strict(),
  z.object({kind: z.literal('subject-card-delete'), nodeId: uuid}).strict(),
  // MT-5: format-5 previs writes through the unified entry. `previs-create`
  // builds the default scene server-side; `previs-scene-set` carries the whole
  // bounded scene (16 KiB) and the scene revision it was read at.
  z.object({kind: z.literal('previs-create'), label: z.string().max(PREVIS_LIMITS.labelLength),
    position: point.optional()}).strict(),
  z.object({kind: z.literal('previs-scene-set'), nodeId: uuid,
    expectedSceneRevision: z.number().int().safe().min(1), scene: previsSceneSchema}).strict(),
  z.object({kind: z.literal('clip-properties'),
    edits: sequenceEditClipPropertiesIntentSchema.shape.operation.shape.edits}).strict(),
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
