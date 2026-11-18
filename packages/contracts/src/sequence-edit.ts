import {z} from 'zod';
import {FORMAT5_LIMITS, FORMAT5_STORAGE_ERROR_CODES, format5SyncBaselineSchema} from './project-format5.ts';
import type {
  Format5Clip, Format5Cue, Format5ErrorCode, Format5SyncBaseline,
} from './project-format5.ts';
import type {BoardSequenceErrorCode} from './board-sequence.ts';
import type {MainTrackErrorCode} from './chain-main-track.ts';
import type {
  ChainSyncOperation, ChainSyncPlan, ChainSyncState, ChainSyncWarning,
} from './chain-sync-algorithm.ts';

/**
 * CS/TS shared action contract for the format-5 board sequence (0.3.0).
 *
 * One user action is planned by the shared SA algorithms (board-sequence /
 * chain-main-track / chain-sync-algorithm) and committed by CS (board graph)
 * and TS (main-track projection) inside one `ProjectStore.tx`. This file fixes
 * the envelope both sides exchange, the two transaction-internal entry
 * signatures, the unified undo/redo identity and the shared error-code table.
 * It contains types, constants and pure canonical/inversion helpers only: no
 * store, IO, planner or history implementation lives here.
 *
 * Boundaries:
 * - Field names and error codes already frozen by K5a (`project-format5.ts`,
 *   `format5-*` storage, history 13) are imported, never restated.
 * - Operation semantics stay in SA. The envelope validator checks identity,
 *   bounds, side/kind agreement and the allowed compound order only.
 * - The timeline half keeps a three-state synchronization baseline (unchanged /
 *   set / absent) so an action only pays for the snapshot it really changes.
 * - Storage shapes: history-13 `editor_history_entries.beforePatch/afterPatch`
 *   hold `SequenceEditStateDelta` objects; `editor_requests.response` holds a
 *   `SequenceEditReceipt`; `operation` holds `sequenceEditOperationName(...)`.
 */

export const SEQUENCE_EDIT_CONTRACT_VERSION = 1 as const;

/** Bounds mirror the frozen history-13 storage limits (K5a). */
export const SEQUENCE_EDIT_LIMITS = Object.freeze({
  /** A repair action may append its required `sync-board` projection. */
  intents: 2,
  requestIdMinBytes: 8,
  requestIdMaxBytes: 200,
  requestIdMaxUtf8Bytes: 800,
  /** history-13 `operation` column. */
  operationBytes: 200,
  /** history-13 `beforePatch` + `afterPatch` combined. */
  patchBytes: FORMAT5_LIMITS.historyEntryBytes,
  receiptBytes: FORMAT5_LIMITS.receiptResponseBytes,
  historyEntries: FORMAT5_LIMITS.historyEntries,
  historyBytes: FORMAT5_LIMITS.historyBytes,
  /** Changed ids carried by one envelope: main track + other-track items + cues. */
  impactIds: FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips + FORMAT5_LIMITS.subtitleCues,
  boardWrites: FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips,
});

export type SequenceEditSide = 'board' | 'timeline';
export const SEQUENCE_EDIT_SIDES = Object.freeze(['board', 'timeline'] as const);

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const utf8 = new TextEncoder();
export const sequenceEditUtf8Bytes = (value: string): number => utf8.encode(value).length;
export const isSequenceEditUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);
export const isSequenceEditInputDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST_PATTERN.test(value);

/** Idempotency key: the frozen history-13 request window accepts 8..200 characters
 * and at most 800 UTF-8 bytes. A repeated request with the same digest replays
 * its stored receipt; a different digest is rejected (SEQUENCE_EDIT_REQUEST_REUSED). */
export function isSequenceEditRequestId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // SQLite length() counts characters, not UTF-16 code units.
  const characters = [...value].length;
  return characters >= SEQUENCE_EDIT_LIMITS.requestIdMinBytes
    && characters <= SEQUENCE_EDIT_LIMITS.requestIdMaxBytes
    && sequenceEditUtf8Bytes(value) <= SEQUENCE_EDIT_LIMITS.requestIdMaxUtf8Bytes;
}

// ---------------------------------------------------------------------------
// Operation names
// ---------------------------------------------------------------------------

/**
 * One stable history/receipt operation name per SA edit kind. `operation` in
 * history 13 is a byte-bounded string; compound repair actions join the names
 * with `+` in intent order (`board.insert+board.sync`).
 */
export const SEQUENCE_EDIT_OPERATIONS = Object.freeze([
  'board.connect', 'board.disconnect', 'board.insert', 'board.delete', 'board.sync', 'board.version',
  'timeline.clip.move', 'timeline.clip.remove', 'timeline.clip.add', 'timeline.clip.split',
  'timeline.clip.trim', 'timeline.clip.version', 'timeline.clip.move-off-track',
] as const);
export type SequenceEditOperationName = (typeof SEQUENCE_EDIT_OPERATIONS)[number];

/** The side a plan operation belongs to. Board edits and projections are CS,
 * track edits are TS. */
export function sequenceEditIntentSide(operation: Pick<ChainSyncOperation, 'kind'>): SequenceEditSide {
  return operation.kind === 'track' ? 'timeline' : 'board';
}

export function sequenceEditIntentOperationName(operation: ChainSyncOperation): SequenceEditOperationName {
  switch (operation.kind) {
    case 'board':
      switch (operation.edit.kind) {
        case 'connect': return 'board.connect';
        case 'disconnect': return 'board.disconnect';
        case 'insert': return 'board.insert';
        case 'delete': return 'board.delete';
      }
    // `board` is the only operation whose nested edit needs mapping; a missing
    // branch above is a type error, so the switch cannot silently fall through.
    case 'sync-board': return 'board.sync';
    case 'board-version': return 'board.version';
    case 'track':
      switch (operation.edit.kind) {
        case 'move': return 'timeline.clip.move';
        case 'move-off-track': return 'timeline.clip.move-off-track';
        case 'remove': return 'timeline.clip.remove';
        case 'add': return 'timeline.clip.add';
        case 'split': return 'timeline.clip.split';
        case 'trim': return 'timeline.clip.trim';
        case 'version': return 'timeline.clip.version';
      }
  }
}

/** `history13.operation` for one action. Total length is bounded by the single
 * name bound times the two allowed intents, still far below 200 bytes. */
export function sequenceEditOperationName(intents: readonly SequenceEditIntent[]): string {
  return intents.map(intent => sequenceEditIntentOperationName(intent.operation)).join('+');
}

// ---------------------------------------------------------------------------
// Actions, baseline, impact and allocation
// ---------------------------------------------------------------------------

export interface SequenceEditIntent {
  readonly side: SequenceEditSide;
  readonly operation: ChainSyncOperation;
}

/** A repair action may append one `sync-board` projection so that the recovered
 * chain and its main track land in the same transaction and one undo step (SA
 * review). Every other action is a single intent. */
export function isSequenceEditIntentSequence(intents: readonly SequenceEditIntent[]): boolean {
  if (intents.length < 1 || intents.length > SEQUENCE_EDIT_LIMITS.intents) return false;
  if (intents.some(intent => intent.side !== sequenceEditIntentSide(intent.operation))) return false;
  return intents.length === 1 || (intents[0]!.side === 'board' && intents[0]!.operation.kind !== 'sync-board'
    && intents[1]!.side === 'board' && intents[1]!.operation.kind === 'sync-board');
}

/**
 * A cross-side target revision observation, using the project target-revision
 * evidence both surfaces already share. `revision` is the value read before
 * planning; the transaction re-reads every target and rejects a mismatch.
 */
export interface SequenceEditExpectedTarget {
  readonly kind: 'shot' | 'node' | 'edge' | 'clip' | 'cue';
  readonly id: string;
  readonly revision: number;
}
export const SEQUENCE_EDIT_TARGET_KINDS = Object.freeze(['shot', 'node', 'edge', 'clip', 'cue'] as const);

/**
 * The exact revisions one action was planned against (plan §4). A transaction
 * re-reads them and returns SEQUENCE_EDIT_REVISION_CONFLICT instead of writing
 * onto a newer state.
 */
export interface SequenceEditBaseline {
  /** Project file content sequence (`project_file.contentSequence`). */
  readonly contentRevision: number;
  /** Timeline header revision. */
  readonly timelineRevision: number;
  /** `sequence_sync_state.revision` of this film. */
  readonly syncRevision: number;
  /** Unified history-13 cursor the caller observed. */
  readonly historyPosition: number;
  readonly historyRevision: number;
  /** Per-target evidence; the same ids as the impact arrays are expected here. */
  readonly targets: readonly SequenceEditExpectedTarget[];
}

/**
 * Every persisted object the action may create, change or remove. Ids are
 * returned to the UI/MT receipt and used for target-revision evidence. Counts
 * are bounded by the format-5 K1 capacity so one envelope stays small.
 */
export interface SequenceEditImpact {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly mainTrackClipIds: readonly string[];
  readonly otherTrackItemIds: readonly string[];
  readonly subtitleCueIds: readonly string[];
}
export function sequenceEditImpactCount(impact: SequenceEditImpact): number {
  return impact.nodeIds.length + impact.edgeIds.length + impact.mainTrackClipIds.length
    + impact.otherTrackItemIds.length + impact.subtitleCueIds.length;
}

/**
 * New ids are allocated by the coordinator before planning and carried in the
 * envelope. A retry of the same request reuses them, so both sides cannot
 * produce two different identities for one action. This mirrors the SA inputs:
 * `newClipIds` for `planChainMainTrack`, the copied node id, split right-clip
 * ids and new edge ids.
 */
export interface SequenceEditAllocation {
  /** nodeId -> main-track clip id (SA `newClipIds`). */
  readonly clips: readonly {readonly nodeId: string; readonly clipId: string}[];
  /** Copied node identity for a «copy and move» decision. */
  readonly nodes: readonly {readonly fromNodeId: string; readonly nodeId: string}[];
  /** Left clip -> new right clip id for splits. */
  readonly splitClips: readonly {readonly clipId: string; readonly rightClipId: string}[];
  /** New sequence/reference edges created by this action. */
  readonly edges: readonly {readonly id: string; readonly fromId: string; readonly toId: string}[];
}

/** History-13 action envelope: one user action, CS/TS, one undo step. */
export interface SequenceEditEnvelope {
  readonly contractVersion: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly projectId: string;
  /** Unified history-13 epoch recorded with the first format-5 action. */
  readonly epoch: string;
  /** Action identity; undo and redo keep applying this same id (plan §5). */
  readonly actionId: string;
  /** Idempotency key of this request; a replay returns the stored receipt. */
  readonly requestId: string;
  /** The surface the user acted in. The first intent belongs to this side. */
  readonly originSide: SequenceEditSide;
  /** Active `sequence_root` node; 0.3.0 actions target one film root. */
  readonly filmId: string;
  readonly intents: readonly SequenceEditIntent[];
  readonly baseline: SequenceEditBaseline;
  readonly impact: SequenceEditImpact;
  readonly allocation: SequenceEditAllocation;
}

// ---------------------------------------------------------------------------
// Validation (envelope shell only; SA validates operation semantics)
// ---------------------------------------------------------------------------

const uuidSchema = z.string().regex(UUID_PATTERN);
const digestSchema = z.string().regex(DIGEST_PATTERN);
const sequenceSchema = z.number().int().safe().min(0);
const revisionSchema = z.number().int().safe().min(1);
const boundedText = (max: number) => z.string().min(1).max(max);
const idListSchema = (max: number) => z.array(uuidSchema).max(max)
  .refine(value => new Set(value).size === value.length, 'Duplicate id');

const targetSchema = z.object({kind: z.enum(SEQUENCE_EDIT_TARGET_KINDS), id: uuidSchema, revision: revisionSchema}).strict();
const baselineSchema = z.object({
  contentRevision: sequenceSchema, timelineRevision: revisionSchema, syncRevision: revisionSchema,
  historyPosition: sequenceSchema, historyRevision: revisionSchema,
  targets: z.array(targetSchema).max(SEQUENCE_EDIT_LIMITS.impactIds),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const target of value.targets) {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) context.addIssue({code: z.ZodIssueCode.custom, message: 'Duplicate target revision'});
    seen.add(key);
  }
});
const impactSchema = z.object({
  nodeIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  edgeIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  mainTrackClipIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  otherTrackItemIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
  subtitleCueIds: idListSchema(SEQUENCE_EDIT_LIMITS.impactIds),
}).strict().superRefine((value, context) => {
  if (sequenceEditImpactCount(value) > SEQUENCE_EDIT_LIMITS.impactIds) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Too many impacted ids'});
  }
});
const allocationSchema = z.object({
  clips: z.array(z.object({nodeId: uuidSchema, clipId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  nodes: z.array(z.object({fromNodeId: uuidSchema, nodeId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  splitClips: z.array(z.object({clipId: uuidSchema, rightClipId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
  edges: z.array(z.object({id: uuidSchema, fromId: uuidSchema, toId: uuidSchema}).strict()).max(SEQUENCE_EDIT_LIMITS.impactIds),
}).strict().superRefine((value, context) => {
  const duplicate = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) context.addIssue({code: z.ZodIssueCode.custom, message: `Duplicate ${label} id`});
  };
  duplicate(value.clips.map(item => item.clipId), 'clip');
  duplicate(value.clips.map(item => item.nodeId), 'clip node');
  duplicate(value.nodes.map(item => item.nodeId), 'node');
  duplicate(value.nodes.map(item => item.fromNodeId), 'copy source node');
  duplicate(value.splitClips.map(item => item.rightClipId), 'split right clip');
  duplicate(value.edges.map(item => item.id), 'edge');
});
const operationSchema = z.object({kind: z.enum(['board', 'sync-board', 'board-version', 'track'])}).passthrough();
const intentSchema = z.object({side: z.enum(SEQUENCE_EDIT_SIDES), operation: operationSchema}).strict()
  .superRefine((value, context) => {
    if (sequenceEditIntentSide(value.operation as unknown as Pick<ChainSyncOperation, 'kind'>) !== value.side) {
      context.addIssue({code: z.ZodIssueCode.custom, message: 'Intent side does not match its operation kind'});
    }
  });

/**
 * Structural envelope validation for the receipt/idempotency boundary. It does
 * not re-implement SA planning: a valid shell still returns the SA failure code
 * (`CYCLE`, `MULTIPLE_PREDECESSORS`, ...) from `planChainSync`.
 */
export const sequenceEditEnvelopeSchema = z.object({
  contractVersion: z.literal(SEQUENCE_EDIT_CONTRACT_VERSION),
  projectId: uuidSchema, epoch: uuidSchema, actionId: uuidSchema, filmId: uuidSchema,
  requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'),
  originSide: z.enum(SEQUENCE_EDIT_SIDES),
  intents: z.array(intentSchema).min(1).max(SEQUENCE_EDIT_LIMITS.intents),
  baseline: baselineSchema, impact: impactSchema, allocation: allocationSchema,
}).strict().superRefine((value, context) => {
  if (!isSequenceEditIntentSequence(value.intents as unknown as readonly SequenceEditIntent[])) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid intent sequence'});
  }
  if (value.intents.length > 0 && value.intents[0]!.side !== value.originSide) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'The first intent must belong to the origin side'});
  }
});
export const isSequenceEditEnvelope = (value: unknown): value is SequenceEditEnvelope =>
  sequenceEditEnvelopeSchema.safeParse(value).success;

// ---------------------------------------------------------------------------
// Deltas, patches and the unified undo step
// ---------------------------------------------------------------------------

/** One persisted board object. `data` is the full row JSON the CS reader owns:
 * a shot record, a `Format5Node` or a `Format5Edge`; additions and removals
 * carry the complete object so undo can restore fields SA does not model. */
export interface SequenceEditBoardEntity {
  readonly kind: 'shot' | 'node' | 'edge';
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}
export const SEQUENCE_EDIT_BOARD_ENTITY_KINDS = Object.freeze(['shot', 'node', 'edge'] as const);

export interface SequenceEditBoardDelta {
  readonly writes: readonly SequenceEditBoardEntity[];
  readonly removals: readonly SequenceEditBoardEntity[];
}

/**
 * Three-state synchronization baseline (coordinator review 11-18): most actions
 * do not change the "last synced" row, and a full 512 KiB snapshot in every
 * before/after patch would exhaust the history budget. `set` stores a snapshot,
 * `absent` removes the stored row, and `unchanged` writes nothing.
 */
export type SequenceEditBaselineChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: Format5SyncBaseline }
  | { readonly kind: 'absent' };
export const SEQUENCE_EDIT_BASELINE_CHANGE_KINDS = Object.freeze(['unchanged', 'set', 'absent'] as const);

/** Resolve one baseline delta against the row read in the transaction. Both
 * sides must use this helper: `unchanged` returns the current value and writes
 * nothing (undo also leaves the stored row untouched), `absent` deletes it and
 * `set` stores the supplied snapshot. */
export function applySequenceEditBaselineChange(
  current: Format5SyncBaseline | null, change: SequenceEditBaselineChange,
): Format5SyncBaseline | null {
  switch (change.kind) {
    case 'unchanged': return current;
    case 'absent': return null;
    case 'set': return change.value;
  }
}

/** Timeline half of a patch. Entity arrays use the frozen K5a clip/cue shapes;
 * `removed*Ids` are the rows to delete; `baseline` is the three-state delta that
 * the transaction applies to the stored "last synced" row. */
export interface SequenceEditTimelineDelta {
  readonly clips: readonly Format5Clip[];
  readonly cues: readonly Format5Cue[];
  readonly removedClipIds: readonly string[];
  readonly removedCueIds: readonly string[];
  readonly baseline: SequenceEditBaselineChange;
}

/** Everything one action wrote or reverted: exactly one `editor_history_entries`
 * patch direction. Reading and writing remain owned by CS/TS services. */
export interface SequenceEditStateDelta {
  readonly board: SequenceEditBoardDelta;
  readonly timeline: SequenceEditTimelineDelta;
}

export interface SequenceEditPatch {
  readonly version: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
}

/** Undo and redo are the same action identity: undo applies `before`, redo
 * applies `after`, and a new action truncates the redo branch (plan §5). */
export function invertSequenceEditPatch(patch: SequenceEditPatch): SequenceEditPatch {
  return {...patch, before: patch.after, after: patch.before};
}

/** history-13 row shape both sides write through the shared history module. */
export interface SequenceEditHistoryEntry {
  readonly actionId: string;
  readonly projectId: string;
  readonly epoch: string;
  readonly position: number;
  readonly operation: string;
  readonly origin: 'user';
  readonly beforePatch: SequenceEditStateDelta;
  readonly afterPatch: SequenceEditStateDelta;
  readonly createdAt: string;
}

const entitySchema = z.object({
  kind: z.enum(SEQUENCE_EDIT_BOARD_ENTITY_KINDS), id: uuidSchema, data: z.record(z.unknown()),
}).strict();
const boardDeltaSchema = z.object({
  writes: z.array(entitySchema).max(SEQUENCE_EDIT_LIMITS.boardWrites),
  removals: z.array(entitySchema).max(SEQUENCE_EDIT_LIMITS.boardWrites),
}).strict();
const baselineChangeSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('unchanged')}).strict(),
  z.object({kind: z.literal('set'), value: format5SyncBaselineSchema}).strict(),
  z.object({kind: z.literal('absent')}).strict(),
]);
const timelineDeltaSchema = z.object({
  clips: z.array(z.record(z.unknown())).max(FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips),
  cues: z.array(z.record(z.unknown())).max(FORMAT5_LIMITS.subtitleCues),
  removedClipIds: idListSchema(FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips),
  removedCueIds: idListSchema(FORMAT5_LIMITS.subtitleCues),
  baseline: baselineChangeSchema,
}).strict();
const stateDeltaSchema = z.object({board: boardDeltaSchema, timeline: timelineDeltaSchema}).strict();
export const sequenceEditHistoryEntrySchema = z.object({
  actionId: uuidSchema, projectId: uuidSchema, epoch: uuidSchema, position: revisionSchema,
  operation: z.string().refine(value => sequenceEditUtf8Bytes(value) >= 1 && sequenceEditUtf8Bytes(value) <= SEQUENCE_EDIT_LIMITS.operationBytes),
  origin: z.literal('user'),
  beforePatch: stateDeltaSchema, afterPatch: stateDeltaSchema,
  createdAt: z.string().regex(ISO_PATTERN),
}).strict().refine(value => sequenceEditUtf8Bytes(JSON.stringify(value.beforePatch)) + sequenceEditUtf8Bytes(JSON.stringify(value.afterPatch)) <= SEQUENCE_EDIT_LIMITS.patchBytes,
  'History patches exceed the frozen entry budget');

// ---------------------------------------------------------------------------
// Transaction-internal entry signatures
// ---------------------------------------------------------------------------

/**
 * One transaction, in order (plan §4/§5):
 * 1. The caller captures `baseline` before planning and computes the
 *    `requestId`/`inputDigest` pair. A stored receipt for the same digest is
 *    replayed; a different digest is SEQUENCE_EDIT_REQUEST_REUSED.
 * 2. Inside `ProjectStore.tx` the coordinator re-reads the live board, timeline,
 *    baseline and history cursor, then plans once with SA.
 * 3. Board-origin: CS calls `MainTrackProjectionPort.projectMainTrack`;
 *    track-origin: TS calls `BoardSeamProjectionPort.projectBoardSeam`. Both
 *    calls receive the same envelope/state/plan and return only their half of
 *    the patch; neither writes history, target revisions or the content stamp.
 * 4. The coordinator applies both deltas, advances the touched target revisions,
 *    the content stamp, the sync state and the timeline revision, then writes
 *    exactly one `editor_history_entries` row (before/after delta), the bounded
 *    receipt, and the editor-history state/cursor change.
 * 5. Only after commit does the caller publish the HTTP/RPC projection.
 */

/** `ok` plan for one envelope, produced by exactly one `planChainSync` call. */
export type SequenceEditPlan = Extract<ChainSyncPlan, {readonly ok: true}>;

export interface SequenceEditTransactionFailure {
  readonly ok: false;
  readonly code: SequenceEditErrorCode;
  readonly ids: readonly string[];
}

/** Input both transaction-internal entries receive. The coordinator reads the
 * live SA state and plans inside the same `ProjectStore.tx` before calling the
 * other side; entries never open a nested transaction and never await IO. */
export interface SequenceEditTransactionRequest {
  readonly envelope: SequenceEditEnvelope;
  readonly state: ChainSyncState;
  readonly plan: SequenceEditPlan;
}

export interface SequenceEditBoardCommit {
  readonly ok: true;
  readonly delta: SequenceEditBoardDelta;
  /** `project_file.contentSequence` after the coordinator advances the stamp. */
  readonly contentRevision: number;
}
export interface SequenceEditTimelineCommit {
  readonly ok: true;
  readonly delta: SequenceEditTimelineDelta;
  readonly warnings: readonly ChainSyncWarning[];
  readonly timelineRevision: number;
  readonly syncRevision: number;
}

/**
 * Implemented by TS, called by CS inside CS's transaction for a board-origin
 * action. It maps the SA plan onto timeline entity/baseline writes and returns
 * the timeline half of the patch. No history row and no content stamp is
 * written here; the coordinator composes both halves and writes them once.
 */
export interface MainTrackProjectionPort {
  projectMainTrack(request: SequenceEditTransactionRequest): SequenceEditTimelineCommit | SequenceEditTransactionFailure;
}

/**
 * Implemented by CS, called by TS inside TS's transaction for a track-origin
 * action. It maps the SA plan onto board node/edge writes (including the seam
 * rewiring of inserted/deleted/reordered segments) and returns the board half.
 */
export interface BoardSeamProjectionPort {
  projectBoardSeam(request: SequenceEditTransactionRequest): SequenceEditBoardCommit | SequenceEditTransactionFailure;
}

// ---------------------------------------------------------------------------
// Receipts, history views and the service entry
// ---------------------------------------------------------------------------

export interface SequenceEditAffectedCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly mainTrackClips: number;
  readonly otherTrackItems: number;
  readonly subtitleCues: number;
}
export interface SequenceEditHistoryAction {
  readonly actionId: string;
  readonly operation: string;
  readonly affected: number;
}
export interface SequenceEditHistoryView {
  readonly epoch: string;
  readonly position: number;
  readonly revision: number;
  readonly undo: SequenceEditHistoryAction | null;
  readonly redo: SequenceEditHistoryAction | null;
}
export interface SequenceEditHistoryCursor {
  readonly position: number;
  readonly revision: number;
}

/** `editor_requests.response`, bounded by the frozen 64 KiB receipt window. */
export interface SequenceEditReceipt {
  readonly version: typeof SEQUENCE_EDIT_CONTRACT_VERSION;
  readonly requestId: string;
  readonly inputDigest: string;
  readonly projectId: string;
  readonly actionId: string;
  readonly operation: string;
  readonly originSide: SequenceEditSide;
  readonly status: 'applied' | 'not_applied';
  readonly code?: SequenceEditErrorCode;
  readonly affected: SequenceEditAffectedCounts;
  readonly history: SequenceEditHistoryView;
  readonly contentRevision: number;
  readonly timelineRevision: number;
  readonly syncRevision: number;
}
const historyActionSchema = z.object({actionId: uuidSchema, operation: boundedText(SEQUENCE_EDIT_LIMITS.operationBytes), affected: sequenceSchema}).strict();
const historyViewSchema = z.object({
  epoch: uuidSchema, position: sequenceSchema, revision: revisionSchema,
  undo: historyActionSchema.nullable(), redo: historyActionSchema.nullable(),
}).strict();
const countsSchema = z.object({
  nodes: sequenceSchema, edges: sequenceSchema, mainTrackClips: sequenceSchema,
  otherTrackItems: sequenceSchema, subtitleCues: sequenceSchema,
}).strict();
export const sequenceEditReceiptSchema = z.object({
  version: z.literal(SEQUENCE_EDIT_CONTRACT_VERSION),
  requestId: z.string().refine(isSequenceEditRequestId, 'Invalid request id'), inputDigest: digestSchema,
  projectId: uuidSchema, actionId: uuidSchema, operation: boundedText(SEQUENCE_EDIT_LIMITS.operationBytes),
  originSide: z.enum(SEQUENCE_EDIT_SIDES), status: z.enum(['applied', 'not_applied']),
  code: z.string().min(1).max(SEQUENCE_EDIT_LIMITS.operationBytes).optional(),
  affected: countsSchema, history: historyViewSchema,
  contentRevision: sequenceSchema, timelineRevision: revisionSchema, syncRevision: revisionSchema,
}).strict().refine(value => value.status === 'applied' ? value.code === undefined : value.code !== undefined,
  'Only a not-applied receipt carries an error code');

/** External service entry shared by UI-B/UI-E/MT. The same envelope shape feeds
 * `apply`; undo/redo address one existing history action and never blindly apply
 * when the cursor moved. */
export interface SequenceEditCommitRequest {
  readonly envelope: SequenceEditEnvelope;
  /** Impact digest from the preview/confirmation the user accepted. */
  readonly expectedPlanDigest?: string;
}
export interface SequenceEditHistoryCommand {
  readonly projectId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly direction: 'undo' | 'redo';
  readonly expected: SequenceEditHistoryCursor;
}
export interface SequenceEditCommitResult {
  readonly ok: true;
  readonly actionId: string;
  readonly operation: string;
  readonly patch: SequenceEditPatch;
  readonly receipt: SequenceEditReceipt;
}
export interface SequenceEditService {
  apply(request: SequenceEditCommitRequest): SequenceEditCommitResult | SequenceEditTransactionFailure;
  undo(command: SequenceEditHistoryCommand): SequenceEditCommitResult | SequenceEditTransactionFailure;
  redo(command: SequenceEditHistoryCommand): SequenceEditCommitResult | SequenceEditTransactionFailure;
}

// ---------------------------------------------------------------------------
// Idempotency digest
// ---------------------------------------------------------------------------

/** Domain separation for `editor_requests.inputDigest`. The host hashes
 * `canonicalSequenceEditInput(envelope)` with SHA-256 and stores the lowercase
 * hex digest. Both sides must use this recipe so a replay is recognized. */
export const SEQUENCE_EDIT_DIGEST_DOMAIN = 'mioon.sequence-edit.action.v1';

const stableKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) sorted[key] = stableKeys(item);
    }
    return sorted;
  }
  return value;
};
/** Deterministic JSON: object keys sorted recursively, array order preserved.
 * Callers hash the returned string with SHA-256 to obtain `inputDigest`. */
export function canonicalSequenceEditInput(envelope: SequenceEditEnvelope): string {
  return `${SEQUENCE_EDIT_DIGEST_DOMAIN}\n${JSON.stringify(stableKeys(envelope))}`;
}

// ---------------------------------------------------------------------------
// Shared error-code table
// ---------------------------------------------------------------------------

/** Plus `CHAIN_TRACK_MISMATCH` (sync failure) and `COPY_NODE_REQUIRED` (a copy
 * decision is missing) these are every non-storage failure `ChainSyncPlan` can
 * return; board and main-track codes are listed separately below. */
const CHAIN_SYNC_FAILURE_CODES = Object.freeze([
  'FILM_NOT_FOUND', 'ACTIVE_FILM_REMOVED', 'FILM_SCOPE_MISMATCH', 'CHAIN_TRACK_MISMATCH',
  'CLIP_NOT_FOUND', 'INVALID_SPLIT', 'INSERT_BETWEEN_SPLIT_PARTS', 'COPY_NODE_EXISTS',
  'INVALID_ANCHOR', 'INVALID_TRACK_TARGET', 'COPY_NODE_REQUIRED',
] as const satisfies readonly Extract<ChainSyncPlan, {readonly ok: false}>['code'][]);
const BOARD_SEQUENCE_ERROR_CODES = Object.freeze([
  'INVALID_SEQUENCE_TYPES', 'INVALID_REFERENCE_TYPES', 'FILM_MUST_START', 'TEXT_IS_ANNOTATION',
  'INVALID_CONNECTION_TYPES', 'MISSING_NODE', 'DUPLICATE_NODE', 'MISSING_EDGE', 'DUPLICATE_EDGE',
  'MULTIPLE_PREDECESSORS', 'MULTIPLE_SUCCESSORS', 'CYCLE', 'NODE_ALREADY_LINKED',
] as const satisfies readonly BoardSequenceErrorCode[]);
const MAIN_TRACK_ERROR_CODES = Object.freeze([
  'DUPLICATE_MEDIA', 'INVALID_MEDIA', 'MISSING_MEDIA', 'DUPLICATE_CLIP', 'INVALID_CLIP_FRAMES',
  'INVALID_CLIP_VERSION', 'TRACK_OVERLAP', 'DUPLICATE_TRACK_NODE', 'INVALID_SPLIT_GROUP',
  'TRACK_FRAME_OVERFLOW', 'NEW_CLIP_ID_REQUIRED', 'SOURCE_BOUNDS',
] as const satisfies readonly MainTrackErrorCode[]);

/**
 * Contract-level codes. Reused K5a/SA codes above stay authoritative; these six
 * cover the cross-side transaction envelope that neither side owned before:
 * - `SEQUENCE_EDIT_CONTRACT_INVALID`: bad version/ids/bounds/side-kind or an
 *   action outside the allowed single/repair shape.
 * - `SEQUENCE_EDIT_REQUEST_REUSED`: the request id already has a receipt with a
 *   different input digest. Never overwrite the immutable receipt.
 * - `SEQUENCE_EDIT_REVISION_CONFLICT`: content/timeline/sync/history or a target
 *   revision changed since planning. Retryable after the caller re-reads.
 * - `SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE`: explicit format-5 admission while the
 *   TS transaction seam is not registered yet; reject writes to a root-bound
 *   chain (plan §7).
 * - `SEQUENCE_EDIT_HISTORY_CONFLICT`: the undo/redo cursor or branch moved; do
 *   not blindly undo (plan §5).
 * - `SEQUENCE_EDIT_PATCH_INVALID`: a stored history patch is outside the frozen
 *   bounds or cannot be applied to the current state.
 */
export const SEQUENCE_EDIT_NEW_ERROR_CODES = Object.freeze([
  'SEQUENCE_EDIT_CONTRACT_INVALID', 'SEQUENCE_EDIT_REQUEST_REUSED', 'SEQUENCE_EDIT_REVISION_CONFLICT',
  'SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', 'SEQUENCE_EDIT_HISTORY_CONFLICT', 'SEQUENCE_EDIT_PATCH_INVALID',
] as const);
export type SequenceEditNewErrorCode = (typeof SEQUENCE_EDIT_NEW_ERROR_CODES)[number];
export type SequenceEditPlanFailureCode = Extract<ChainSyncPlan, {readonly ok: false}>['code'];
export type SequenceEditErrorCode = Format5ErrorCode | SequenceEditPlanFailureCode | SequenceEditNewErrorCode;
export type SequenceEditErrorSource = 'format5' | 'sa' | 'sequence-edit';
export interface SequenceEditErrorDescriptor {
  readonly code: SequenceEditErrorCode;
  readonly source: SequenceEditErrorSource;
  readonly retryable: boolean;
}
const descriptor = (code: SequenceEditErrorCode, source: SequenceEditErrorSource, retryable = false): SequenceEditErrorDescriptor =>
  Object.freeze({code, source, retryable});
export const SEQUENCE_EDIT_ERRORS: readonly SequenceEditErrorDescriptor[] = Object.freeze([
  ...FORMAT5_STORAGE_ERROR_CODES.map(code => descriptor(code, 'format5', code === 'FORMAT5_SYNC_REVISION_CONFLICT')),
  ...BOARD_SEQUENCE_ERROR_CODES.map(code => descriptor(code, 'sa')),
  ...MAIN_TRACK_ERROR_CODES.map(code => descriptor(code, 'sa')),
  ...CHAIN_SYNC_FAILURE_CODES.map(code => descriptor(code, 'sa', code === 'CHAIN_TRACK_MISMATCH')),
  ...SEQUENCE_EDIT_NEW_ERROR_CODES.map(code => descriptor(code, 'sequence-edit', code === 'SEQUENCE_EDIT_REVISION_CONFLICT')),
]);
/** Flat union of every shared code, in table order (unique by construction). */
export const SEQUENCE_EDIT_ERROR_CODES: readonly SequenceEditErrorCode[] = Object.freeze(SEQUENCE_EDIT_ERRORS.map(entry => entry.code));
/** Compile-time proof that the table covers every code both sides may return. */
type AssertNever<T extends never> = T;
export type SequenceEditErrorTableCoverage = AssertNever<
  Exclude<SequenceEditErrorCode, (typeof SEQUENCE_EDIT_ERRORS)[number]['code']>
>;
export const isSequenceEditErrorCode = (value: unknown): value is SequenceEditErrorCode =>
  typeof value === 'string' && SEQUENCE_EDIT_ERRORS.some(entry => entry.code === value);
