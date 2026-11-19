import {z} from 'zod';
import {
  SEQUENCE_EDIT_SIDES, isSequenceEditRequestId, sequenceEditAffectedCountsSchema, sequenceEditEnvelopeSchema,
  sequenceEditHistoryActionSchema, sequenceEditHistoryViewSchema, sequenceEditReceiptSchema,
} from './sequence-edit.ts';
import type {
  SequenceEditEnvelope, SequenceEditHistoryCursor, SequenceEditHistoryView, SequenceEditReceipt,
} from './sequence-edit.ts';

/** Service-operation surface for the board sequence editor (CS).
 *
 * These operations are only registered for a format-5 project that explicitly
 * admits format-5 editing. UI-B2/UI-E2 and the Mio tools (MT) call the same
 * `sequence.edit` envelope; the confirmed impact is re-checked inside the
 * transaction and a repeated request id replays its immutable receipt. */

const uuid = z.string().uuid();
export const sequenceHistoryCursorSchema = z.object({
  position: z.number().int().safe().min(0), revision: z.number().int().safe().min(1),
}).strict();

export const sequenceEditingSchemas = Object.freeze({
  'sequence.edit': sequenceEditEnvelopeSchema,
  'sequence.history.get': z.object({projectId: uuid, origin: z.enum(['user', 'mio']).optional()}).strict(),
  'sequence.undo': z.object({projectId: uuid, requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'),
    actionId: uuid, expected: sequenceHistoryCursorSchema, origin: z.enum(['user', 'mio']).optional()}).strict(),
  'sequence.redo': z.object({projectId: uuid, requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'),
    actionId: uuid, expected: sequenceHistoryCursorSchema, origin: z.enum(['user', 'mio']).optional()}).strict(),
});
export type SequenceEditingOperation = keyof typeof sequenceEditingSchemas;
export type SequenceEditInput = z.infer<typeof sequenceEditingSchemas['sequence.edit']>;
export type SequenceHistoryGetInput = z.infer<typeof sequenceEditingSchemas['sequence.history.get']>;
/** Undo and redo address one recorded action; they never apply when the cursor
 * moved (`SEQUENCE_EDIT_HISTORY_CONFLICT`). */
export type SequenceHistoryInput = Omit<z.infer<typeof sequenceEditingSchemas['sequence.undo']>, 'projectId'> & {readonly projectId?: string};

export const sequenceEditingWrites = Object.freeze(['sequence.edit', 'sequence.undo', 'sequence.redo'] as const);
export const isSequenceEditingOperation = (value: string): value is SequenceEditingOperation => Object.hasOwn(sequenceEditingSchemas, value);
export const isSequenceEditingWrite = (operation: string): boolean => (sequenceEditingWrites as readonly string[]).includes(operation);

/** Cursor projection for the shared undo bar and shortcuts (UI-B2/UI-E2). */
export const sequenceHistoryViewResponseSchema = z.object({
  projectId: uuid, epoch: uuid, position: z.number().int().safe().min(0), revision: z.number().int().safe().min(1),
  undo: sequenceEditHistoryActionSchema.nullable(), redo: sequenceEditHistoryActionSchema.nullable(),
  conflict: z.boolean(), undoConflict: z.boolean(), redoConflict: z.boolean(),
  undoBlockedBy: z.enum(['user', 'mio']).nullable(), redoBlockedBy: z.enum(['user', 'mio']).nullable(),
  undoAvailable: z.boolean(), redoAvailable: z.boolean(),
  /** Lowest retained history position, or null while the stack is empty. */
  earliestPosition: z.number().int().safe().min(1).nullable(),
  /** No retained action can be undone any further. */
  atEarliest: z.boolean(),
}).strict();
export interface SequenceHistoryViewResponse extends SequenceEditHistoryView {
  readonly projectId: string;
  readonly conflict: boolean;
  readonly undoConflict: boolean;
  readonly redoConflict: boolean;
  readonly undoBlockedBy: 'user' | 'mio' | null;
  readonly redoBlockedBy: 'user' | 'mio' | null;
  readonly undoAvailable: boolean;
  readonly redoAvailable: boolean;
  readonly earliestPosition: number | null;
  readonly atEarliest: boolean;
}

export const sequenceEditingResponses = Object.freeze({
  'sequence.edit': sequenceEditReceiptSchema,
  'sequence.history.get': sequenceHistoryViewResponseSchema,
  'sequence.undo': sequenceEditReceiptSchema,
  'sequence.redo': sequenceEditReceiptSchema,
});
export type SequenceEditingResponse<Operation extends SequenceEditingOperation> =
  z.infer<(typeof sequenceEditingResponses)[Operation]>;

export type {SequenceEditEnvelope, SequenceEditHistoryCursor, SequenceEditHistoryView, SequenceEditReceipt};
export {SEQUENCE_EDIT_SIDES, sequenceEditAffectedCountsSchema};

// ---------------------------------------------------------------------------
// Operation payloads
// ---------------------------------------------------------------------------

/** Strict payload validation for the operation carried by an intent. The plan
 * still validates semantics through SA; this schema guarantees the shape and
 * frame/identity bounds before a transaction starts. */
const operationUuid = z.string().uuid();
const operationFrame = z.number().int().safe().min(0).max(9007199254740991);
const operationVersion = z.object({id: operationUuid, sourceFrames: operationFrame.nullable()}).strict();
const boardEditSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('connect'), fromId: operationUuid, toId: operationUuid}).strict(),
  z.object({kind: z.literal('disconnect'), fromId: operationUuid, toId: operationUuid}).strict(),
  z.object({kind: z.literal('insert'), fromId: operationUuid, toId: operationUuid, nodeId: operationUuid}).strict(),
  z.object({kind: z.literal('delete'), nodeId: operationUuid}).strict(),
]);
const trackClipSchema = z.object({
  id: operationUuid, nodeId: operationUuid, versionId: operationUuid.nullable(), versionLocked: z.boolean(),
  startFrame: operationFrame, durationFrames: operationFrame.positive(), sourceInFrame: operationFrame,
  splitGroupId: operationUuid.optional(),
}).strict();
const trackEditSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('move'), clipId: operationUuid, beforeClipId: operationUuid.nullable(), copyNodeId: operationUuid.optional()}).strict(),
  z.object({kind: z.literal('move-off-track'), clipId: operationUuid, trackId: operationUuid, startFrame: operationFrame,
    copyNodeId: operationUuid.optional()}).strict(),
  z.object({kind: z.literal('remove'), clipId: operationUuid}).strict(),
  z.object({kind: z.literal('add'), clip: trackClipSchema, beforeClipId: operationUuid.nullable(),
    media: z.object({nodeId: operationUuid, selectedVersion: operationVersion.nullable(), durationFrames: operationFrame.positive()}).strict().optional(),
    nodeKind: z.enum(['shot', 'video', 'image']).optional()}).strict(),
  z.object({kind: z.literal('split'), clipId: operationUuid, offsetFrames: operationFrame.positive(),
    rightClipId: operationUuid, rightSourceInFrame: operationFrame.optional()}).strict(),
  z.object({kind: z.literal('trim'), clipId: operationUuid, durationFrames: operationFrame.positive(),
    sourceInFrame: operationFrame.optional()}).strict(),
  z.object({kind: z.literal('version'), clipId: operationUuid, version: operationVersion.nullable(), locked: z.boolean()}).strict(),
]);
const boardPositionSchema = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
export const sequenceEditOperationSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('board'), edit: boardEditSchema}).strict(),
  z.object({kind: z.literal('sync-board'), newClipIds: z.record(operationUuid, operationUuid).optional()}).strict(),
  z.object({kind: z.literal('board-version'), nodeId: operationUuid, version: operationVersion.nullable()}).strict(),
  z.object({kind: z.literal('board.root.create'), nodeId: operationUuid, name: z.string().min(1).max(150),
    position: boardPositionSchema}).strict(),
  z.object({kind: z.literal('board.shot.append'), nodeId: operationUuid, name: z.string().min(1).max(150),
    position: boardPositionSchema.optional()}).strict(),
  z.object({kind: z.literal('board.layout.move'), moves: z.array(z.object({nodeId: operationUuid, x: z.number().finite(),
    y: z.number().finite()}).strict()).min(1).max(500)}).strict(),
  z.object({kind: z.literal('board.node.create'), nodeId: operationUuid,
    nodeType: z.enum(['image', 'video', 'audio', 'text']), name: z.string().min(1).max(150),
    position: boardPositionSchema, assetId: operationUuid.optional(), text: z.string().max(5000).optional()}).strict(),
  z.object({kind: z.literal('board.shot.update'), shotId: operationUuid,
    patch: z.object({title: z.string().min(1).max(500).optional(), prompt: z.string().max(20_000).optional(),
      duration: z.number().finite().min(0.05).max(600).optional(), aspectRatio: z.enum(['9:16', '16:9']).optional(),
      position: boardPositionSchema.optional()}).strict()}).strict(),
  z.object({kind: z.literal('board.node.update'), nodeId: operationUuid,
    patch: z.object({name: z.string().min(1).max(150).optional(), text: z.string().max(5000).optional(),
      position: boardPositionSchema.optional()}).strict()}).strict(),
  z.object({kind: z.literal('board.archive'), items: z.array(z.object({kind: z.enum(['shot', 'node']),
    id: operationUuid}).strict()).min(1).max(50)}).strict(),
  z.object({kind: z.literal('board.restore'), items: z.array(z.object({kind: z.enum(['shot', 'node']),
    id: operationUuid}).strict()).min(1).max(50)}).strict(),
  z.object({kind: z.literal('board.paste'), documentId: operationUuid, snapshotId: operationUuid,
    viewport: z.object({x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(),
      height: z.number().finite().positive()}).strict()}).strict(),
  z.object({kind: z.literal('board.duplicate'), items: z.array(z.object({kind: z.enum(['shot', 'node']),
    id: operationUuid}).strict()).min(1).max(50),
    viewport: z.object({x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(),
      height: z.number().finite().positive()}).strict().optional()}).strict(),
  z.object({kind: z.literal('track'), edit: trackEditSchema}).strict(),
]);
export type SequenceEditOperationInput = z.infer<typeof sequenceEditOperationSchema>;
/** Parsed envelope with typed operations; the plan still validates semantics. */
export const sequenceEditIntentPayloadSchema = z.object({
  side: z.enum(SEQUENCE_EDIT_SIDES), operation: sequenceEditOperationSchema,
}).strict();
