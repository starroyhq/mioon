/** The single shared history-13 writer for format-5 board/timeline actions.
 *
 * The CS board transaction and the TS timeline transaction never write
 * `editor_requests`, `editor_history_entries` or `editor_history_state`
 * themselves: both call this module inside their one `ProjectStore.tx`.
 * The action contract, patch shape and error codes come from
 * `@mioon/contracts/sequence-edit`; this file owns persistence only.
 *
 * Public entry points:
 * - `prepareSequenceEditHistory(store, envelopeEpoch?)` — read/lazily create
 *   the unified cursor and return it with the undo/redo view.
 * - `findSequenceEditReceipt(store, requestId)` / `sequenceEditInputDigest` —
 *   immutable replay lookup.
 * - `writeSequenceEditAction(store, {envelope, patch, receipt})` — one new
 *   action: validates the envelope against the live cursor, truncates a redo
 *   branch, inserts the history entry, advances the cursor and writes the
 *   bounded receipt. Returns the final receipt with the fresh history view.
 * - `moveSequenceEditHistoryCursor(store, command, receipt)` — undo/redo cursor
 *   move after the caller applied `SequenceEditPatch.before/after`.
 * - `readSequenceEditHistoryEntry(store, actionId)` — the stored patch for an
 *   action (used by replay and by TS/CS undo).
 */
import {createHash, randomUUID} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import type {
  SequenceEditEnvelope, SequenceEditErrorCode, SequenceEditHistoryCommand, SequenceEditHistoryEntry, SequenceEditHistoryView,
  SequenceEditPatch, SequenceEditReceipt, SequenceEditStateDelta,
} from '@mioon/contracts/sequence-edit';
import {
  SEQUENCE_EDIT_LIMITS, canonicalSequenceEditInput, isSequenceEditEnvelope, sequenceEditEnvelopeOperationName,
  sequenceEditHistoryEntrySchema, sequenceEditReceiptSchema,
} from '@mioon/contracts/sequence-edit';
import {assertHeldProjectReaderRequirements} from './project-file/reader-requirements.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const contractInvalid = (message: string, details: Row = {}): never => {
  throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', message, 409, details);
};
const historyConflict = (message: string, details: Row = {}): never => {
  throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', message, 409, details);
};
const requestReused = (message: string, details: Row = {}): never => {
  throw new AppError('SEQUENCE_EDIT_REQUEST_REUSED', message, 409, details);
};
const patchInvalid = (message: string, details: Row = {}): never => {
  throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', message, 409, details);
};

export interface SequenceEditHistoryState {
  readonly epoch: string;
  readonly position: number;
  readonly revision: number;
}

export interface SequenceEditStoredReceipt {
  readonly inputDigest: string;
  readonly receipt: SequenceEditReceipt;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

/** Deterministic digest both sides store in `editor_requests.inputDigest`. */
export function sequenceEditInputDigest(envelope: SequenceEditEnvelope): string {
  return createHash('sha256').update(canonicalSequenceEditInput(envelope)).digest('hex');
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const sorted: Row = {};
    for (const key of Object.keys(value as Row).sort()) {
      const item = (value as Row)[key];
      if (item !== undefined) sorted[key] = stable(item);
    }
    return sorted;
  }
  return value;
};

/** Digest for an undo/redo command (its own request identity). */
export function historyCommandDigest(command: SequenceEditHistoryCommand): string {
  return createHash('sha256').update(`mioon.sequence-edit.history.v1\n${JSON.stringify(stable(command))}`).digest('hex');
}

function readStateRow(store: ProjectStore): SequenceEditHistoryState | null {
  const rows = store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state WHERE projectId=?').all(store.projectId) as Row[];
  if (rows.length > 1) throw new AppError('EDITOR_STORAGE_CORRUPT', '编辑器历史状态不唯一。', 422, {database: 'history', reason: 'metadata'});
  const row = rows[0];
  if (!row) return null;
  if (!isUuid(row.epoch) || !Number.isSafeInteger(row.position) || Number(row.position) < 0
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) {
    throw new AppError('EDITOR_STORAGE_CORRUPT', '编辑器历史状态无效。', 422, {database: 'history', reason: 'metadata'});
  }
  return {epoch: row.epoch, position: Number(row.position), revision: Number(row.revision)};
}

function entryAt(store: ProjectStore, position: number): SequenceEditHistoryEntry | null {
  if (position < 1) return null;
  const row = store.db.prepare(`SELECT actionId,projectId,epoch,position,operation,origin,beforePatch,afterPatch,createdAt
    FROM main.editor_history_entries WHERE projectId=? AND epoch=? AND position=?`)
    .get(store.projectId, readStateRow(store)!.epoch, position) as Row | undefined;
  return row ? entryFromRow(row) : null;
}

function entryFromRow(row: Row): SequenceEditHistoryEntry {
  const parsed = sequenceEditHistoryEntrySchema.safeParse({
    actionId: row.actionId, projectId: row.projectId, epoch: row.epoch, position: row.position,
    operation: row.operation, origin: row.origin,
    beforePatch: JSON.parse(String(row.beforePatch)), afterPatch: JSON.parse(String(row.afterPatch)),
    createdAt: row.createdAt,
  });
  if (!parsed.success) patchInvalid('已存的动作补丁不符合共用合同。', {actionId: row.actionId});
  return parsed.data as unknown as SequenceEditHistoryEntry;
}

export function readSequenceEditHistoryEntry(store: ProjectStore, actionId: string): SequenceEditHistoryEntry | null {
  assertHeldProjectReaderRequirements(store);
  const row = store.db.prepare(`SELECT actionId,projectId,epoch,position,operation,origin,beforePatch,afterPatch,createdAt
    FROM main.editor_history_entries WHERE actionId=? AND projectId=?`).get(actionId, store.projectId) as Row | undefined;
  return row ? entryFromRow(row) : null;
}

function historyView(store: ProjectStore, state: SequenceEditHistoryState): SequenceEditHistoryView {
  const undo = entryAt(store, state.position);
  const redo = entryAt(store, state.position + 1);
  const action = (entry: SequenceEditHistoryEntry | null) => entry === null ? null
    : {actionId: entry.actionId, operation: entry.operation, affected: 0};
  return {epoch: state.epoch, position: state.position, revision: state.revision,
    undo: action(undo), redo: action(redo)};
}

/** Read (or lazily create on the first format-5 action) the unified cursor. The
 * caller supplies the epoch it observed in its envelope when creating it. */
export function prepareSequenceEditHistory(store: ProjectStore, observedEpoch?: string): {
  readonly state: SequenceEditHistoryState; readonly view: SequenceEditHistoryView;
} {
  assertHeldProjectReaderRequirements(store);
  let state = readStateRow(store);
  if (!state) {
    const epoch = observedEpoch ?? randomUUID();
    if (!isUuid(epoch)) contractInvalid('历史 epoch 无效。', {reason: 'EPOCH'});
    store.db.prepare('INSERT INTO main.editor_history_state(projectId,epoch,position,revision,evidence) VALUES(?,?,0,1,?)')
      .run(store.projectId, epoch, JSON.stringify({formatVersion: 5, contractVersion: 1, createdBy: 'sequence-edit'}));
    state = {epoch, position: 0, revision: 1};
  }
  return {state, view: historyView(store, state)};
}

/** Exactly one history row per action, and no second copy of the patch. */
export function patchFromEntry(entry: SequenceEditHistoryEntry): SequenceEditPatch {
  return {version: 1, before: entry.beforePatch, after: entry.afterPatch};
}

export function findSequenceEditReceipt(store: ProjectStore, requestId: string): SequenceEditStoredReceipt | null {
  assertHeldProjectReaderRequirements(store);
  const row = store.db.prepare('SELECT inputDigest,response FROM main.editor_requests WHERE requestId=? AND projectId=?')
    .get(requestId, store.projectId) as Row | undefined;
  if (!row) return null;
  const parsed = sequenceEditReceiptSchema.safeParse(JSON.parse(String(row.response)));
  if (!parsed.success) patchInvalid('已存回执不符合共用合同。', {requestId});
  return {inputDigest: String(row.inputDigest), receipt: parsed.data as unknown as SequenceEditReceipt};
}

/** Lowest position that is still retained. Null while no action is stored. */
export function sequenceEditHistoryFloor(store: ProjectStore): number | null {
  const row = store.db.prepare('SELECT min(position) AS floor FROM main.editor_history_entries WHERE projectId=?')
    .get(store.projectId) as Row | undefined;
  const floor = row?.floor;
  return Number.isSafeInteger(floor) && Number(floor) >= 1 ? Number(floor) : null;
}

/** history-13 has a 200-entry / 128 MiB budget enforced by insert triggers.
 * Before one new action is written, the oldest rows are removed until the new
 * action fits. The immutable receipts are deliberately never evicted: replaying
 * an old request by its original ID must keep returning its original result. */
function evictOldestEntries(store: ProjectStore, epoch: string, newBytes: number): void {
  const rows = store.db.prepare(`SELECT position,length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB)) AS bytes
    FROM main.editor_history_entries WHERE projectId=? AND epoch=? ORDER BY position`).all(store.projectId, epoch) as Row[];
  let count = rows.length;
  let bytes = rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
  let index = 0;
  while (index < rows.length && (count >= SEQUENCE_EDIT_LIMITS.historyEntries || bytes + newBytes > SEQUENCE_EDIT_LIMITS.historyBytes)) {
    const row = rows[index++]!;
    store.db.prepare('DELETE FROM main.editor_history_entries WHERE projectId=? AND epoch=? AND position=?')
      .run(store.projectId, epoch, Number(row.position));
    count--;
    bytes -= Number(row.bytes ?? 0);
  }
}

function writeReceiptRow(store: ProjectStore, receipt: SequenceEditReceipt): void {
  const parsed = sequenceEditReceiptSchema.safeParse(receipt);
  if (!parsed.success) patchInvalid('回执不符合共用合同。', {requestId: receipt.requestId});
  store.db.prepare('INSERT INTO main.editor_requests(requestId,projectId,operation,inputDigest,response,issuedAt,createdAt) VALUES(?,?,?,?,?,?,?)')
    .run(receipt.requestId, store.projectId, receipt.operation, receipt.inputDigest, JSON.stringify(parsed.data), Date.now(), now());
}

function verifyEnvelope(store: ProjectStore, envelope: SequenceEditEnvelope, state: SequenceEditHistoryState): void {
  if (!isSequenceEditEnvelope(envelope)) contractInvalid('动作 envelope 不符合共用合同。', {reason: 'ENVELOPE'});
  if (envelope.projectId !== store.projectId) contractInvalid('动作不属于这个项目。', {reason: 'PROJECT'});
  if (envelope.epoch !== state.epoch) contractInvalid('动作 epoch 与当前统一历史不一致。', {reason: 'EPOCH'});
  if (envelope.baseline.historyPosition !== state.position || envelope.baseline.historyRevision !== state.revision) {
    historyConflict('历史游标已经变化，请重新读取。', {position: state.position, revision: state.revision});
  }
}

export type SequenceEditReceiptDraft = Omit<SequenceEditReceipt, 'history'>;

/** One new user action. Writes exactly one history entry, one cursor revision,
 * the redo-branch truncation and the immutable receipt. */
export function writeSequenceEditAction(store: ProjectStore, input: {
  readonly envelope: SequenceEditEnvelope; readonly patch: SequenceEditPatch; readonly receipt: SequenceEditReceiptDraft;
}): SequenceEditReceipt {
  const {state} = prepareSequenceEditHistory(store, input.envelope.epoch);
  verifyEnvelope(store, input.envelope, state);
  const position = state.position + 1;
  const entry: SequenceEditHistoryEntry = {
    actionId: input.envelope.actionId, projectId: store.projectId, epoch: state.epoch, position,
    operation: sequenceEditEnvelopeOperationName(input.envelope), origin: input.envelope.origin ?? 'user',
    beforePatch: input.patch.before, afterPatch: input.patch.after, createdAt: now(),
  };
  const parsedEntry = sequenceEditHistoryEntrySchema.safeParse(entry);
  if (!parsedEntry.success) patchInvalid('动作补丁超出共用合同的边界。', {actionId: entry.actionId});
  const before = JSON.stringify(entry.beforePatch), after = JSON.stringify(entry.afterPatch);
  const newBytes = Buffer.byteLength(before) + Buffer.byteLength(after);
  // A new action truncates the old redo branch; history entry rows for the
  // undone branch are removed (their receipts stay immutable and queryable).
  store.db.prepare('DELETE FROM main.editor_history_entries WHERE projectId=? AND epoch=? AND position>=?')
    .run(store.projectId, state.epoch, position);
  evictOldestEntries(store, state.epoch, newBytes);
  store.db.prepare('INSERT INTO main.editor_history_entries(actionId,projectId,epoch,position,operation,origin,beforePatch,afterPatch,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(entry.actionId, entry.projectId, entry.epoch, entry.position, entry.operation, entry.origin, before, after, entry.createdAt);
  store.db.prepare('UPDATE main.editor_history_state SET position=?,revision=revision+1,evidence=? WHERE projectId=?')
    .run(position, JSON.stringify(evidence(entry, input.receipt)), store.projectId);
  const view = historyView(store, {epoch: state.epoch, position, revision: state.revision + 1});
  const receipt: SequenceEditReceipt = {...input.receipt, history: {...view,
    undo: view.undo ? {...view.undo, affected: affectedTotal(input.receipt.affected)} : null}};
  writeReceiptRow(store, receipt);
  return receipt;
}

function affectedTotal(affected: SequenceEditReceipt['affected']): number {
  return affected.nodes + affected.edges + affected.mainTrackClips + affected.otherTrackItems + affected.subtitleCues
    + (affected.tracks ?? 0);
}

function evidence(entry: SequenceEditHistoryEntry, receipt: SequenceEditReceiptDraft): Row {
  return {formatVersion: 5, contractVersion: 1, actionId: entry.actionId, operation: entry.operation,
    position: entry.position, syncRevision: receipt.syncRevision, timelineRevision: receipt.timelineRevision,
    contentRevision: receipt.contentRevision};
}

/** A valid request that needs no state change (the live projection already
 * matches the intent). Only the immutable receipt is written; no history entry,
 * cursor revision or content stamp moves. */
export function writeSequenceEditFailure(store: ProjectStore, envelope: SequenceEditEnvelope,
  code: SequenceEditErrorCode): SequenceEditReceipt {
  const {state, view} = prepareSequenceEditHistory(store, envelope.epoch);
  if (envelope.projectId !== store.projectId) contractInvalid('动作不属于这个项目。', {reason: 'PROJECT'});
  if (envelope.epoch !== state.epoch) contractInvalid('动作 epoch 与当前统一历史不一致。', {reason: 'EPOCH'});
  const content = store.db.prepare('SELECT contentSequence FROM project.project_file WHERE singleton=1').get() as Row | undefined;
  const timeline = store.db.prepare('SELECT data FROM project.timelines').get() as Row | undefined;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  const timelineRevision = timeline && typeof timeline.data === 'string' ? Number(JSON.parse(String(timeline.data)).revision) : 1;
  const receipt: SequenceEditReceipt = {
    version: 1, requestId: envelope.requestId, inputDigest: sequenceEditInputDigest(envelope), projectId: store.projectId,
    actionId: envelope.actionId, operation: sequenceEditEnvelopeOperationName(envelope), originSide: envelope.originSide,
    status: 'not_applied', code, affected: {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0},
    history: view, contentRevision: Number(content?.contentSequence ?? 0), timelineRevision,
    syncRevision: Number(sync?.revision ?? 1),
  };
  writeReceiptRow(store, receipt);
  return receipt;
}

/** Undo/redo move the cursor without adding a branch; the caller applied the
 * patch direction first. Exactly one receipt is stored for the command. */
export function moveSequenceEditHistoryCursor(store: ProjectStore, command: SequenceEditHistoryCommand,
  receipt: SequenceEditReceiptDraft): SequenceEditReceipt {
  if (command.projectId !== store.projectId) contractInvalid('动作不属于这个项目。', {reason: 'PROJECT'});
  if (command.direction !== 'undo' && command.direction !== 'redo') contractInvalid('方向无效。', {reason: 'DIRECTION'});
  const state = readStateRow(store);
  if (!state) {
    historyConflict('还没有可撤销的动作。', {});
    throw new Error('unreachable');
  }
  if (command.expected.position !== state.position || command.expected.revision !== state.revision) {
    historyConflict('历史游标已经变化，请重新读取。', {position: state.position, revision: state.revision});
  }
  const targetPosition = command.direction === 'undo' ? state.position : state.position + 1;
  const entry = targetPosition >= 1 ? readSequenceEditHistoryEntry(store, command.actionId) : null;
  if (!entry || entry.position !== targetPosition) {
    const floor = sequenceEditHistoryFloor(store);
    if (command.direction === 'undo' && (floor === null || targetPosition < floor)) {
      historyConflict('已经到最早可撤销的一步。', {reason: 'EARLIEST', floor});
    }
    historyConflict('这一步已经不能撤销或重做。', {actionId: command.actionId, floor});
  }
  const position = command.direction === 'undo' ? state.position - 1 : state.position + 1;
  store.db.prepare('UPDATE main.editor_history_state SET position=?,revision=revision+1,evidence=? WHERE projectId=?')
    .run(position, JSON.stringify({formatVersion: 5, contractVersion: 1, direction: command.direction,
      actionId: command.actionId, position}), store.projectId);
  const view = historyView(store, {epoch: state.epoch, position, revision: state.revision + 1});
  const stored: SequenceEditReceipt = {...receipt, history: {...view, undo: view.undo ?? null, redo: view.redo ?? null}};
  writeReceiptRow(store, stored);
  return stored;
}

/** Structural validation used when a caller hands this module a raw delta. */
export function isSequenceEditStateDelta(value: unknown): value is SequenceEditStateDelta {
  return value !== null && typeof value === 'object' && 'board' in value && 'timeline' in value;
}
