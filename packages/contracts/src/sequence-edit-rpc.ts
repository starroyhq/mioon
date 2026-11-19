/** The single public RPC entry for format-5 sequence editing.
 *
 * UI-B2, UI-E2 and MT all use the same five operations. `sequence.preview` takes
 * any intent (board, timeline or subject binding) and returns the exact shared
 * envelope plus its plan digest; `sequence.commit` accepts only that envelope
 * with the digest it was previewed with. History/undo/redo are the one
 * implementation in `format5-editor-history.ts` (through the CS coordinator),
 * including oldest-entry eviction and `atEarliest`.
 */
import {z} from 'zod';
import {sequenceEditClipPropertiesIntentSchema, sequenceEditEnvelopeSchema, sequenceEditReferenceIntentSchema,
  sequenceEditSubjectIntentSchema, sequenceEditSubtitlesIntentSchema} from './sequence-edit.ts';
import {sequenceEditIntentPayloadSchema} from './sequence-editing.ts';
import {sequenceEditingSchemas} from './sequence-editing.ts';
import type {SequenceEditIntent} from './sequence-edit.ts';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const allocationSchema = z.object({
  clips: z.array(z.object({nodeId: uuid, clipId: uuid}).strict()).max(500).optional(),
  nodes: z.array(z.object({fromNodeId: uuid, nodeId: uuid}).strict()).max(500).optional(),
  splitClips: z.array(z.object({clipId: uuid, rightClipId: uuid}).strict()).max(500).optional(),
  edges: z.array(z.object({id: uuid, fromId: uuid, toId: uuid}).strict()).max(2000).optional(),
}).strict();
export const sequencePreviewRequestSchema = z.object({
  projectId: uuid,
  requestId: z.string().min(8).max(200),
  actionId: uuid.optional(),
  originSide: z.enum(['board', 'timeline']).optional(),
  origin: z.enum(['user', 'mio']).optional(),
  intents: z.array(sequenceEditIntentPayloadSchema).min(1).max(64).optional(),
  subjectIntent: sequenceEditSubjectIntentSchema.optional(),
  referenceIntent: sequenceEditReferenceIntentSchema.optional(),
  propertiesIntent: sequenceEditClipPropertiesIntentSchema.optional(),
  subtitlesIntent: sequenceEditSubtitlesIntentSchema.optional(),
  allocation: allocationSchema.optional(),
}).strict().superRefine((value, context) => {
  const families = [value.intents !== undefined, value.subjectIntent !== undefined,
    value.referenceIntent !== undefined, value.propertiesIntent !== undefined,
    value.subtitlesIntent !== undefined].filter(Boolean).length;
  if (families !== 1) context.addIssue({code: z.ZodIssueCode.custom, path: ['intents'],
    message: 'Provide exactly one of intents, subjectIntent, referenceIntent, propertiesIntent and subtitlesIntent.'});
});
export const sequenceCommitRequestSchema = z.object({
  projectId: uuid,
  envelope: sequenceEditEnvelopeSchema,
  expectedPlanDigest: digest,
}).strict();
export const sequenceHistoryGetRequestSchema = sequenceEditingSchemas['sequence.history.get'];
export const sequenceHistoryCommandRequestSchema = sequenceEditingSchemas['sequence.undo'];
/** Read-only board mounting data: unified sync revision/order state plus the
 * archived board rows UI-B2 can restore. Board graph/content rows themselves
 * come from `project.get`; this operation never plans or writes. */
export const sequenceBoardGetRequestSchema = z.object({projectId: uuid}).strict();
const boardPoint = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
const subjectVersionBoard = z.object({id: uuid, number: z.number().int().positive(), assetId: uuid}).strict();
const subjectBoard = z.object({
  id: uuid, name: z.string().min(1).max(500), kind: z.enum(['character', 'product', 'location', 'look']),
  headVersionId: uuid, headNumber: z.number().int().positive(), headAssetId: uuid,
  versions: z.array(subjectVersionBoard).max(200),
}).strict();
const bindingBoard = z.object({
  id: uuid, shotId: uuid, subjectId: uuid, role: z.enum(['subject', 'style']),
  bindingMode: z.enum(['follow', 'locked', 'detached']), subjectVersionId: uuid.nullable(), edgeId: uuid.nullable(),
}).strict();
export const sequenceBoardGetResponseSchema = z.object({
  projectId: uuid,
  timelineRevision: z.number().int().positive(),
  syncRevision: z.number().int().positive(),
  inSync: z.boolean(),
  archived: z.array(z.object({
    id: uuid, kind: z.enum(['shot', 'node']), name: z.string().min(1).max(500),
    position: boardPoint.nullable(),
  }).strict()).max(500),
  subjects: z.array(subjectBoard).max(500),
  bindings: z.array(bindingBoard).max(500),
}).strict();
export type SequenceBoardGetRequest = z.infer<typeof sequenceBoardGetRequestSchema>;
export type SequenceBoardGetResponse = z.infer<typeof sequenceBoardGetResponseSchema>;
export const sequencePreviewResponseSchema = z.object({
  envelope: sequenceEditEnvelopeSchema,
  planDigest: digest,
  warnings: z.array(z.object({code: z.string().min(1).max(80)}).passthrough()).max(500),
}).strict();
export const sequenceEditRpcSchemas = Object.freeze({
  'sequence.preview': sequencePreviewRequestSchema,
  'sequence.commit': sequenceCommitRequestSchema,
  'sequence.history.get': sequenceEditingSchemas['sequence.history.get'],
  'sequence.undo': sequenceEditingSchemas['sequence.undo'],
  'sequence.redo': sequenceEditingSchemas['sequence.redo'],
  'sequence.board.get': sequenceBoardGetRequestSchema,
});
export type SequencePreviewRequest = z.infer<typeof sequencePreviewRequestSchema>;
export type SequenceCommitRequest = z.infer<typeof sequenceCommitRequestSchema>;
export {sequenceEditingSchemas, sequenceEditIntentPayloadSchema} from './sequence-editing.ts';
export type SequenceRpcIntent = SequenceEditIntent;
export type {SequenceEditIntent};
