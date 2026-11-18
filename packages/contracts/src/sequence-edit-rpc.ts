/** UI-B/UI-E/MT <-> project RPC boundary for the shared format-5 edit contract.
 *
 * Requests stay bounded and name one project. The envelope, receipt and patch
 * bodies are the shared `sequence-edit.ts` shapes; this file only adds the
 * transport envelopes for preview, commit, unified history and undo/redo.
 */
import {z} from 'zod';
import {sequenceEditEnvelopeSchema} from './sequence-edit.ts';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const frame = z.number().int().min(0).max(2_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.string().min(8).max(200);
const addClip = z.object({
  id: uuid, nodeId: uuid, segmentGroupId: uuid, startFrame: frame, durationFrames: frame,
  sourceInFrame: frame, versionId: uuid.nullable().optional(), locked: z.boolean().optional(),
}).strict();
export const sequenceSyncCommandSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('sync-board'), newClipIds: z.record(uuid).optional()}).strict(),
  z.object({kind: z.literal('board-version'), nodeId: uuid, versionId: uuid.nullable()}).strict(),
  z.object({kind: z.literal('clip-version'), clipId: uuid, versionId: uuid.nullable(), mode: z.enum(['follow', 'locked'])}).strict(),
  z.object({kind: z.literal('clip-remove'), clipId: uuid}).strict(),
  z.object({kind: z.literal('clip-add'), clip: addClip, beforeClipId: uuid.nullable(), nodeKind: z.enum(['shot', 'video', 'image']).optional()}).strict(),
  z.object({kind: z.literal('clip-split'), clipId: uuid, offsetFrames: frame, rightClipId: uuid, rightSourceInFrame: frame.optional()}).strict(),
  z.object({kind: z.literal('clip-trim'), clipId: uuid, durationFrames: frame, sourceInFrame: frame.optional()}).strict(),
  z.object({kind: z.literal('clip-move'), clipId: uuid, beforeClipId: uuid.nullable(), copyNodeId: uuid.optional()}).strict(),
  z.object({kind: z.literal('clip-move-off-track'), clipId: uuid, trackId: uuid, startFrame: frame, copyNodeId: uuid.optional()}).strict(),
]);
export const sequenceEditPreviewRequestSchema = z.object({
  projectId: uuid, requestId, actionId: uuid.optional(), command: sequenceSyncCommandSchema,
}).strict();
export const sequenceEditCommitRequestSchema = z.object({
  projectId: uuid, envelope: sequenceEditEnvelopeSchema, expectedPlanDigest: digest,
}).strict();
export const sequenceHistoryGetRequestSchema = z.object({projectId: uuid}).strict();
const cursor = z.object({position: frame, revision: z.number().int().positive()}).strict();
export const sequenceHistoryCommandRequestSchema = z.object({
  projectId: uuid, requestId, actionId: uuid, expected: cursor,
}).strict();
export const sequenceEditPreviewResponseSchema = z.object({
  envelope: sequenceEditEnvelopeSchema, planDigest: digest,
  warnings: z.array(z.object({code: z.string().min(1).max(80)}).passthrough()).max(500),
}).strict();
const historyAction = z.object({actionId: uuid, operation: z.string().min(1).max(80), affected: z.number().int().min(0)}).strict();
export const sequenceHistoryResponseSchema = z.object({
  epoch: uuid, position: frame, revision: z.number().int().positive(),
  undo: historyAction.nullable(), redo: historyAction.nullable(),
}).strict();
export const sequenceEditCommitResponseSchema = z.object({
  ok: z.boolean(), actionId: uuid.optional(), operation: z.string().optional(),
  code: z.string().optional(), ids: z.array(uuid).max(500).optional(),
  receipt: z.object({status: z.enum(['applied', 'not_applied']), history: sequenceHistoryResponseSchema}).passthrough().optional(),
}).strict();
export const sequenceEditRpcSchemas = Object.freeze({
  'sequence.preview': sequenceEditPreviewRequestSchema,
  'sequence.commit': sequenceEditCommitRequestSchema,
  'sequence.history.get': sequenceHistoryGetRequestSchema,
  'sequence.undo': sequenceHistoryCommandRequestSchema,
  'sequence.redo': sequenceHistoryCommandRequestSchema,
});
