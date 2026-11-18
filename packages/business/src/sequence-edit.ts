import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {planChainSync} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncOperation, ChainSyncPlan, ChainSyncState} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainBoard, ChainNode, SequenceEdge} from '../../contracts/src/board-sequence.ts';
import type {ChainSyncBaseline, TrackAnchoredItem} from '../../contracts/src/chain-sync-analysis.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {format5SyncBaselineSchema} from '../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {
  applySequenceEditBaselineChange, canonicalSequenceEditInput, invertSequenceEditPatch, isSequenceEditIntentSequence,
  sequenceEditIntentOperationName, sequenceEditOperationName,
} from '../../contracts/src/sequence-edit.ts';
import type {
  BoardSeamProjectionPort, MainTrackProjectionPort, SequenceEditAllocation, SequenceEditBaselineChange,
  SequenceEditBoardDelta, SequenceEditBoardEntity, SequenceEditEnvelope, SequenceEditHistoryAction,
  SequenceEditHistoryEntry, SequenceEditHistoryView, SequenceEditIntent, SequenceEditPatch, SequenceEditReceipt,
  SequenceEditStateDelta, SequenceEditTimelineDelta, SequenceEditTimelineCommit, SequenceEditTransactionFailure,
  SequenceEditTransactionRequest,
} from '../../contracts/src/sequence-edit.ts';
import {
  isSequenceEditingOperation, isSequenceEditingWrite, sequenceEditingResponses, sequenceEditingSchemas,
  sequenceEditIntentPayloadSchema, sequenceEditOperationSchema,
} from '../../contracts/src/sequence-editing.ts';
import type {SequenceEditingOperation} from '../../contracts/src/sequence-editing.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5JsonRows} from './project-file/format5-content.ts';
import {bumpFormat5ContentStampInside, fenceFormat5TimelineRows, readFormat5TimelineRecord, readFormat5TimelineState, assembleFormat5Timeline} from './project-file/format5-timeline.ts';
import {validateFormat5SequenceGraph} from './project-file/format5-sequence-mapping.ts';
import {format5AnchoredItem, format5ChainNodeKind, format5MainTrackClips} from './project-file/format5-sequence-mapping.ts';
import type {ProjectStore} from './project-file/store.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {canonicalJson} from './project-versions/document.ts';

type Row = Record<string, unknown>;
type CanvasTable = 'shots' | 'nodes' | 'edges';
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
const contentStamp = (store: ProjectStore): {readonly contentSequence: number} => readProjectContentStamp(store.db);
const tableOf = (kind: SequenceEditBoardEntity['kind']): CanvasTable => kind === 'shot' ? 'shots' : kind === 'edge' ? 'edges' : 'nodes';
const rowKind = (table: CanvasTable): SequenceEditBoardEntity['kind'] => table === 'shots' ? 'shot' : table === 'edges' ? 'edge' : 'node';
const stable = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));
const digestOf = (envelope: SequenceEditEnvelope): string =>
  createHash('sha256').update(canonicalSequenceEditInput(envelope)).digest('hex');

function fail(code: string, message: string, ids: readonly string[] = [], detail: Row = {}): never {
  throw new AppError(code, message, 409, {ids: [...new Set(ids)], ...detail});
}
function invalidContent(): never {
  throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
}
export function isFormat5Project(store: ProjectStore): boolean {
  return Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
}
const LEGACY_WRITE_MESSAGES = Object.freeze({
  edge: '格式 5 的顺序连线请通过画板顺序操作修改。',
  order: '格式 5 的镜头顺序由画板链决定，请使用画板顺序操作。',
  version: '格式 5 的选中版本必须经画板同步操作修改。',
  archive: '格式 5 的画板删除、恢复和粘贴需经画板顺序操作。',
} as const);
export type LegacyCanvasWrite = keyof typeof LEGACY_WRITE_MESSAGES;
/** Old ambiguous writers that would desynchronize the board chain must not run
 * under explicit format-5 admission. The sequence.edit service is the only
 * writer; the selected-version caller passes its user-facing hint. */
export function assertLegacyCanvasWriteAllowed(store: ProjectStore, use: LegacyCanvasWrite): void {
  if (!isFormat5Project(store)) return;
  throw new AppError('UNSUPPORTED_OPERATION', LEGACY_WRITE_MESSAGES[use], 409, {use: 'sequence.edit'});
}
function assertFormat5(store: ProjectStore): void {
  if (!isFormat5Project(store)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Cursor of the one project-level undo stack (history 13). The shared module
 * created by the timeline-sync line implements this port; CS never writes a
 * second history. */
export interface SequenceEditHistoryCursor {
  readonly epoch: string;
  readonly position: number;
  readonly revision: number;
}
export interface SequenceEditHistoryReplay {
  readonly operation: string;
  readonly inputDigest: string;
  readonly receipt: SequenceEditReceipt;
}
export interface SequenceEditHistoryCommit {
  readonly requestId: string;
  readonly operation: string;
  readonly inputDigest: string;
  readonly receipt: SequenceEditReceipt;
  /** One user action. Undo and redo only move the cursor, so entry is null. */
  readonly entry: SequenceEditHistoryEntry | null;
  readonly direction: 'apply' | 'undo' | 'redo';
}
export interface SequenceEditHistoryPort {
  readCursor(): SequenceEditHistoryCursor;
  readEntryAt(position: number): SequenceEditHistoryEntry | null;
  findReceipt(requestId: string): SequenceEditHistoryReplay | null;
  commit(change: SequenceEditHistoryCommit): void;
}
/** Applies the timeline half of one stored before/after delta while undoing or
 * redoing. The timeline-sync service owns this port once it is merged; the CS
 * tests exercise it through a projection double. */
export interface SequenceEditTimelineHistoryPort {
  matches(delta: SequenceEditTimelineDelta): boolean;
  apply(delta: SequenceEditTimelineDelta): {readonly timelineRevision: number; readonly syncRevision: number} | SequenceEditTransactionFailure;
}
export interface SequenceEditPorts {
  /** TS projection; called by CS inside the same transaction for board edits
   * that change the bound film's main track. */
  readonly mainTrack?: MainTrackProjectionPort;
  /** Shared history 13 writer. Without it no format-5 board write can commit. */
  readonly history?: SequenceEditHistoryPort;
  /** Timeline half of undo/redo. Required only when a stored patch changes the
   * timeline; production wires it together with `mainTrack`. */
  readonly timelineHistory?: SequenceEditTimelineHistoryPort;
}

// ---------------------------------------------------------------------------
// Live read model
// ---------------------------------------------------------------------------

interface EditRows {
  readonly shots: ReadonlyMap<string, Row>;
  readonly nodes: ReadonlyMap<string, Row>;
  readonly edges: ReadonlyMap<string, Row>;
  readonly versions: ReadonlyMap<string, Row>;
  readonly assets: ReadonlyMap<string, Row>;
}
interface EditContext {
  readonly projectId: string;
  readonly timeline: Format5Timeline;
  readonly rootNodeId: string;
  readonly syncRevision: number;
  readonly baseline: Format5SyncBaseline;
  readonly board: ChainBoard;
  readonly nodes: readonly ChainNode[];
  readonly rows: EditRows;
  readonly archived: ReadonlyMap<string, Row>;
  readonly media: readonly ChainSyncMedia[];
  readonly clips: readonly ChainSyncClip[];
  readonly anchored: readonly TrackAnchoredItem[];
  readonly adoptions: readonly Row[];
}

function readRows(db: DatabaseSync, table: CanvasTable): {live: Map<string, Row>; archived: Map<string, Row>} {
  const all = new Map(readFormat5JsonRows(db, 'project', table, false).map(row => [String(row.id), row] as const));
  const archived = new Map<string, Row>();
  for (const row of db.prepare(`SELECT id,archivedAt,archiveBatchId,archiveReason FROM project.${table} WHERE archivedAt IS NOT NULL ORDER BY id`).all() as Row[]) {
    const value = all.get(String(row.id));
    if (!value || typeof row.archivedAt !== 'string') invalidContent();
    archived.set(String(row.id), {...value, archivedAt: row.archivedAt,
      archiveBatchId: typeof row.archiveBatchId === 'string' ? row.archiveBatchId : undefined,
      archiveReason: typeof row.archiveReason === 'string' ? row.archiveReason : 'user-delete'});
  }
  const live = new Map([...all].filter(([id]) => !archived.has(id)));
  return {live, archived};
}

function pickRows(db: DatabaseSync, selected: ReadonlySet<string>): Map<string, Row> {
  if (!selected.size) return new Map();
  return new Map(readFormat5JsonRows(db, 'project', 'versions', false, selected).map(row => [String(row.id), row] as const));
}

function readMedia(node: ChainNode, context: {
  readonly nodeRows: ReadonlyMap<string, Row>; readonly shots: ReadonlyMap<string, Row>;
  readonly versions: ReadonlyMap<string, Row>; readonly assets: ReadonlyMap<string, Row>;
  readonly clipDuration: (nodeId: string) => number | null;
}): ChainSyncMedia | null {
  const row = context.nodeRows.get(node.id);
  const fallback = context.clipDuration(node.id) ?? 120;
  if (node.kind === 'shot') {
    const shot = context.shots.get(node.id);
    const selected = typeof shot?.selectedVersionId === 'string' ? context.versions.get(shot.selectedVersionId) : undefined;
    const selectedAssetId = selected?.assetId;
    if (!selected || !isUuid(selected.id) || typeof selectedAssetId !== 'string') {
      return {nodeId: node.id, selectedVersion: null, durationFrames: fallback};
    }
    const frames = sourceFrameCount(context.assets.get(selectedAssetId)?.duration);
    return {nodeId: node.id, selectedVersion: {id: selected.id, sourceFrames: frames}, durationFrames: frames ?? fallback};
  }
  if (!row) return null;
  if (node.kind === 'image') {
    const rawAssetId = row.assetId;
    const assetId = isUuid(rawAssetId) ? rawAssetId : null;
    return {nodeId: node.id, selectedVersion: assetId === null ? null : {id: assetId, sourceFrames: null}, durationFrames: fallback};
  }
  if (node.kind === 'video') {
    const rawAssetId = row.assetId;
    const assetId = isUuid(rawAssetId) ? rawAssetId : null;
    const frames = assetId === null ? null : sourceFrameCount(context.assets.get(assetId)?.duration);
    return {nodeId: node.id, selectedVersion: assetId !== null && frames !== null ? {id: assetId, sourceFrames: frames} : null,
      durationFrames: frames ?? fallback};
  }
  return null;
}

function readBaseline(raw: unknown): Format5SyncBaseline {
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { return invalidContent(); }
  const parsed = format5SyncBaselineSchema.safeParse(value);
  if (!parsed.success) return invalidContent();
  return parsed.data;
}

export function readSequenceEditContext(store: ProjectStore): EditContext {
  const db = store.db;
  const timeline = readFormat5TimelineRecord(db, 'project');
  if (!timeline || timeline.projectId !== store.projectId) return invalidContent();
  const sync = db.prepare('SELECT timelineId,projectId,sequenceNodeId,revision,baseline FROM project.sequence_sync_state WHERE timelineId=?')
    .get(timeline.id) as Row | undefined;
  if (!sync || sync.projectId !== store.projectId || sync.sequenceNodeId !== timeline.mainTrack.sequenceNodeId ||
      !Number.isSafeInteger(sync.revision) || Number(sync.revision) < 1) return invalidContent();
  const shotRows = readRows(db, 'shots'), nodeRows = readRows(db, 'nodes'), edgeRows = readRows(db, 'edges');
  const hiddenEndpoints = new Set<string>([...shotRows.archived.keys(), ...nodeRows.archived.keys()]);
  for (const [id, row] of [...edgeRows.live]) {
    if (hiddenEndpoints.has(String(row.source)) || hiddenEndpoints.has(String(row.target))) edgeRows.live.delete(id);
  }
  const nodes: ChainNode[] = [];
  for (const id of shotRows.live.keys()) nodes.push({id, kind: 'shot'});
  for (const row of nodeRows.live.values()) {
    if (typeof row.type !== 'string') return invalidContent();
    nodes.push({id: String(row.id), kind: format5ChainNodeKind(row.type)});
  }
  const edges: SequenceEdge[] = [];
  for (const row of edgeRows.live.values()) {
    if (row.kind !== 'sequence') continue;
    if (!isUuid(row.source) || !isUuid(row.target)) return invalidContent();
    edges.push({fromId: row.source, toId: row.target});
  }
  nodes.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  edges.sort((left, right) => left.fromId < right.fromId ? -1 : left.fromId > right.fromId ? 1 : left.toId < right.toId ? -1 : left.toId > right.toId ? 1 : 0);
  const board: ChainBoard = {nodes, edges};
  const clips = format5MainTrackClips(timeline);
  const mainTrackId = timeline.mainTrack.trackId;
  const clipDuration = (nodeId: string): number | null => {
    const group = clips.filter(clip => clip.nodeId === nodeId);
    return group.length ? group.reduce((sum, clip) => sum + clip.durationFrames, 0) : null;
  };
  const versionIds = new Set<string>();
  for (const shot of shotRows.live.values()) if (typeof shot.selectedVersionId === 'string') versionIds.add(shot.selectedVersionId);
  const versions = new Map(readFormat5JsonRows(db, 'project', 'versions', false, versionIds).map(row => [String(row.id), row] as const));
  const assetIds = new Set<string>();
  for (const version of versions.values()) if (typeof version.assetId === 'string') assetIds.add(version.assetId);
  for (const row of nodeRows.live.values()) if (typeof row.assetId === 'string') assetIds.add(row.assetId);
  for (const clip of timeline.clips) if (typeof clip.assetId === 'string') assetIds.add(clip.assetId);
  const assets = new Map(readFormat5JsonRows(db, 'project', 'assets', false, assetIds).map(row => [String(row.id), row] as const));
  const mediaContext = {nodeRows: nodeRows.live, shots: shotRows.live, versions, assets, clipDuration};
  const media: ChainSyncMedia[] = [];
  for (const node of nodes) {
    const entry = readMedia(node, mediaContext);
    if (entry) media.push(entry);
  }
  const anchored: TrackAnchoredItem[] = [];
  for (const clip of timeline.clips) {
    if (clip.trackId === mainTrackId) continue;
    anchored.push(format5AnchoredItem({id: clip.id, startFrame: clip.startFrame, anchor: clip.anchor ?? null}));
  }
  for (const cue of timeline.subtitles?.cues ?? []) anchored.push(format5AnchoredItem({id: cue.id, startFrame: cue.startFrame, anchor: cue.anchor}));
  const adoptions = db.prepare('SELECT shotId,versionId FROM project.shot_version_adoptions ORDER BY shotId,versionId').all() as Row[];
  return {
    projectId: store.projectId, timeline, rootNodeId: timeline.mainTrack.sequenceNodeId,
    syncRevision: Number(sync.revision), baseline: readBaseline(sync.baseline), board, nodes, media, clips, anchored, adoptions,
    rows: {shots: shotRows.live, nodes: nodeRows.live, edges: edgeRows.live, versions, assets},
    archived: new Map([
      ...[...shotRows.archived].map(([id, row]) => [`shot:${id}`, row] as const),
      ...[...nodeRows.archived].map(([id, row]) => [`node:${id}`, row] as const),
      ...[...edgeRows.archived].map(([id, row]) => [`edge:${id}`, row] as const),
    ]),
  };
}

function stateOf(context: EditContext, board: ChainBoard = context.board): ChainSyncState {
  return {board, filmId: context.rootNodeId, media: context.media, clips: context.clips, anchored: context.anchored};
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type SuccessfulPlan = Extract<ChainSyncPlan, {ok: true}>;

function planFailure(plan: Extract<ChainSyncPlan, {ok: false}>): never {
  const ids: string[] = [];
  const record = plan as unknown as Row;
  for (const key of ['id', 'nodeId', 'clipId']) if (typeof record[key] === 'string') ids.push(record[key] as string);
  for (const issue of Array.isArray(record.issues) ? record.issues as Array<{nodeIds?: readonly string[]}> : []) {
    for (const id of issue.nodeIds ?? []) ids.push(id);
  }
  fail(plan.code, '画板顺序链不能按这条命令修改。', ids, {reason: plan.code});
}
const planChanged = (plan: SuccessfulPlan): boolean => plan.changes.nodes.length + plan.changes.edges.length
  + plan.changes.media.length + plan.changes.clips.length + plan.changes.anchored.length > 0;
const planTimelineChanged = (plan: SuccessfulPlan): boolean =>
  plan.changes.clips.length + plan.changes.anchored.length + plan.changes.media.length > 0;

function referencedNodeIds(envelope: SequenceEditEnvelope): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown): void => {if (isUuid(value)) ids.add(value);};
  for (const intent of envelope.intents) {
    const operation = intent.operation;
    if (operation.kind === 'board') {
      if (operation.edit.kind === 'delete') add(operation.edit.nodeId);
      else {add(operation.edit.fromId); add(operation.edit.toId);}
      if (operation.edit.kind === 'insert') add(operation.edit.nodeId);
    } else if (operation.kind === 'board-version') add(operation.nodeId);
    else if (operation.kind === 'track') {
      const edit = operation.edit;
      if ('copyNodeId' in edit) add(edit.copyNodeId);
      if (edit.kind === 'add') add(edit.clip.nodeId);
    }
  }
  return ids;
}

function validateOperation(intent: {readonly operation: ChainSyncOperation}): void {
  const parsed = sequenceEditOperationSchema.safeParse(intent.operation);
  if (!parsed.success) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '画板顺序链操作参数无效。', [], {issues: parsed.error.issues});
}

function withAllocation(operation: ChainSyncOperation, allocation: SequenceEditAllocation): ChainSyncOperation {
  if (operation.kind !== 'board' && operation.kind !== 'sync-board') return operation;
  if (operation.kind === 'board' && operation.newClipIds) return operation;
  const newClipIds = Object.fromEntries(allocation.clips.map(item => [item.nodeId, item.clipId]));
  return Object.keys(newClipIds).length ? {...operation, newClipIds} : operation;
}

/** Pure planning entry for one envelope's ordered intents. SA validates the
 * graph semantics; this only injects the preallocated clip identities. */
export type SequenceEditPlanResult =
  | {readonly ok: true; readonly plan: SuccessfulPlan; readonly state: ChainSyncState}
  | {readonly ok: false; readonly code: string; readonly ids: readonly string[]};
export function planSequenceEditIntents(state: ChainSyncState, intents: readonly SequenceEditIntent[],
  allocation: SequenceEditAllocation): SequenceEditPlanResult {
  let current = state;
  let finalPlan: SuccessfulPlan | undefined;
  for (const intent of intents) {
    const plan = planChainSync(current, withAllocation(intent.operation, allocation));
    if (!plan.ok) {
      const ids: string[] = [];
      const record = plan as unknown as Row;
      for (const key of ['id', 'nodeId', 'clipId']) if (typeof record[key] === 'string') ids.push(record[key] as string);
      return {ok: false, code: plan.code, ids: [...new Set(ids)]};
    }
    current = plan.after;
    finalPlan = plan;
  }
  return {ok: true, plan: finalPlan!, state: current};
}

// ---------------------------------------------------------------------------
// Board delta
// ---------------------------------------------------------------------------

interface BoardSnapshot {
  readonly entity: SequenceEditBoardEntity;
}
interface BoardDeltas {
  readonly before: SequenceEditBoardDelta;
  readonly after: SequenceEditBoardDelta;
  readonly nodes: number;
  readonly edges: number;
}

interface CopyNode {readonly fromNodeId: string; readonly sourceTable: CanvasTable; readonly before: Row; readonly after: Row}

function copyNodeRow(context: EditContext, sourceNodeId: string, newNodeId: string): CopyNode | null {
  const shotRow = context.rows.shots.get(sourceNodeId);
  const nodeRow = context.rows.nodes.get(sourceNodeId);
  const sourceTable: CanvasTable | null = shotRow ? 'shots' : nodeRow ? 'nodes' : null;
  if (!sourceTable) return null;
  const before = (shotRow ?? nodeRow)!;
  const after = {...before, id: newNodeId, projectId: context.projectId, createdAt: now(), updatedAt: now()};
  return {fromNodeId: sourceNodeId, sourceTable, before, after};
}

const ARCHIVE_FIELDS = ['archivedAt', 'archiveBatchId', 'archiveReason'] as const;
function archiveRow(row: Row, at: string, batchId: string): Row {
  const clean = {...row};
  for (const field of ARCHIVE_FIELDS) delete clean[field];
  // Archive state lives in the frozen columns, not in the row JSON;
  // archive/restore triggers advance the target revision.
  return {...clean, archivedAt: at, archiveBatchId: batchId, archiveReason: 'user-delete'};
}
function restoreRow(row: Row): Row {
  const clean = {...row};
  for (const field of ARCHIVE_FIELDS) delete clean[field];
  return clean;
}
function cleanRow(row: Row): Row {
  const clean = {...row};
  for (const field of ARCHIVE_FIELDS) delete clean[field];
  return clean;
}
interface ArchiveMark {readonly archivedAt: string | null; readonly archiveBatchId: string | null; readonly archiveReason: string | null}
function archiveMark(row: Row): ArchiveMark {
  const archivedAt = typeof row.archivedAt === 'string' ? row.archivedAt : null;
  if (archivedAt === null) return {archivedAt: null, archiveBatchId: null, archiveReason: null};
  const archiveBatchId = typeof row.archiveBatchId === 'string' ? row.archiveBatchId : randomUUID();
  const archiveReason = typeof row.archiveReason === 'string' ? row.archiveReason : 'user-delete';
  return {archivedAt, archiveBatchId, archiveReason};
}

/** Build the before/after full-row deltas for every board record one action
 * touches. Restored archived nodes and «copy and move» nodes are included in
 * the same record so one undo restores the whole step. */
function planBoardDeltas(context: EditContext, envelope: SequenceEditEnvelope, finalBoard: ChainBoard,
  finalMedia: readonly ChainSyncMedia[], restored: ReadonlyMap<string, Row>, deleted: ReadonlySet<string>,
  copied: ReadonlyMap<string, CopyNode>): BoardDeltas {
  const at = now();
  const archiveBatchId = randomUUID();
  const beforeRows = new Map([...context.rows.shots, ...context.rows.nodes, ...context.rows.edges]);
  const afterRows = new Map(beforeRows);
  const change = new Map<string, {kind: SequenceEditBoardEntity['kind']; before: Row; after: Row}>();
  const addChange = (kind: SequenceEditBoardEntity['kind'], id: string, before: Row, after: Row): void => {
    if (stable(before) !== stable(after)) change.set(`${kind}:${id}`, {kind, before, after});
  };
  for (const [id, archivedRow] of restored) {
    const kind: SequenceEditBoardEntity['kind'] = context.archived.has(`shot:${id}`) ? 'shot' : 'node';
    const live = restoreRow(archivedRow);
    addChange(kind, id, archivedRow, live);
    afterRows.set(id, live);
  }
  const liveNodeIds = new Set(context.board.nodes.map(node => node.id));
  const finalNodeIds = new Set(finalBoard.nodes.map(node => node.id));
  for (const id of deleted) {
    const row = context.rows.shots.get(id) ?? context.rows.nodes.get(id);
    if (!row) continue;
    const kind: SequenceEditBoardEntity['kind'] = context.rows.shots.has(id) ? 'shot' : 'node';
    const archived = archiveRow(row, at, archiveBatchId);
    addChange(kind, id, row, archived);
    afterRows.set(id, archived);
  }
  for (const [id, copy] of copied) {
    const kind: SequenceEditBoardEntity['kind'] = copy.sourceTable === 'shots' ? 'shot' : 'node';
    change.set(`${kind}:${id}`, {kind, before: copy.after, after: copy.after, ...{newRecord: true} as Row});
    afterRows.set(id, copy.after);
  }
  for (const node of finalBoard.nodes) {
    if (copied.has(node.id)) continue;
    const row = afterRows.get(node.id);
    if (!row) continue;
    if (node.kind !== 'shot') continue;
    const versionId = finalMedia.find(item => item.nodeId === node.id)?.selectedVersion?.id ?? null;
    if (row.selectedVersionId === versionId) continue;
    const next = {...row, selectedVersionId: versionId, ...(typeof row.updatedAt === 'string' ? {updatedAt: at} : {})};
    addChange('shot', node.id, row, next);
    afterRows.set(node.id, next);
  }
  // Detached nodes stay live; only an explicit board delete archives a node.
  const oldEdges = [...context.board.edges];
  const finalEdges = [...finalBoard.edges];
  const finalKeys = new Set(finalEdges.map(edge => `${edge.fromId}>${edge.toId}`));
  const allocationEdges = new Map(envelope.allocation.edges.map(edge => [`${edge.fromId}>${edge.toId}`, edge.id]));
  const edgeRowsByKey = new Map<string, Row>();
  for (const row of context.rows.edges.values()) {
    if (row.kind !== 'sequence' || !isUuid(row.source) || !isUuid(row.target)) continue;
    edgeRowsByKey.set(`${row.source}>${row.target}`, row);
  }
  const finalEdgeRows = new Map<string, Row>();
  for (const edge of finalEdges) {
    const key = `${edge.fromId}>${edge.toId}`;
    const existing = edgeRowsByKey.get(key);
    const row = existing ?? (() => {
      const id = allocationEdges.get(key);
      if (!id) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '缺少新顺序边的预分配 ID。', [edge.fromId, edge.toId]);
      return {id, projectId: context.projectId, source: edge.fromId, target: edge.toId, kind: 'sequence', createdAt: at};
    })();
    finalEdgeRows.set(String(row.id), row);
    if (!existing) {
      change.set(`edge:${row.id}`, {kind: 'edge', before: row, after: row, ...{newRecord: true} as Row});
      afterRows.set(String(row.id), row);
    }
  }
  for (const edge of oldEdges) {
    const key = `${edge.fromId}>${edge.toId}`;
    if (finalKeys.has(key)) continue;
    const row = edgeRowsByKey.get(key);
    if (!row) continue;
    const id = String(row.id);
    afterRows.delete(id);
    change.delete(`edge:${id}`);
    change.set(`edge:${id}`, {kind: 'edge', before: row, after: row, ...{removedRecord: true} as Row});
  }
  const afterWrites: SequenceEditBoardEntity[] = [];
  const afterRemovals: SequenceEditBoardEntity[] = [];
  for (const item of change.values()) {
    const record = item as Row;
    const kind = item.kind;
    if (record.removedRecord === true) afterRemovals.push({kind, id: String(item.before.id), data: item.before});
    else afterWrites.push({kind, id: String((item.after as Row).id), data: item.after});
  }
  const beforeWrites: SequenceEditBoardEntity[] = [];
  const beforeRemovals: SequenceEditBoardEntity[] = [];
  for (const item of change.values()) {
    const record = item as Row;
    const kind = item.kind;
    if (record.newRecord === true) beforeRemovals.push({kind, id: String((item.after as Row).id), data: item.after});
    else beforeWrites.push({kind, id: String((item.before as Row).id), data: item.before});
  }
  const countKind = (entities: readonly SequenceEditBoardEntity[], kind: SequenceEditBoardEntity['kind']): number =>
    entities.filter(entity => entity.kind === kind).length;
  const nodes = countKind(afterWrites, 'node') + countKind(afterWrites, 'shot') + countKind(afterRemovals, 'node') + countKind(afterRemovals, 'shot');
  const edges = countKind(afterWrites, 'edge') + countKind(afterRemovals, 'edge');
  return {before: {writes: beforeWrites, removals: beforeRemovals}, after: {writes: afterWrites, removals: afterRemovals}, nodes, edges};
}

function applyBoardDelta(store: ProjectStore, delta: SequenceEditBoardDelta, mode: 'forward' | 'restore'): void {
  for (const entity of delta.removals) {
    const table = tableOf(entity.kind);
    const removed = store.db.prepare(`DELETE FROM project.${table} WHERE id=? AND projectId=?`).run(entity.id, store.projectId);
    if (mode === 'restore' && Number(removed.changes) !== 1) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能应用。', [entity.id]);
  }
  for (const entity of delta.writes) {
    const table = tableOf(entity.kind);
    const mark = archiveMark(entity.data);
    const clean = cleanRow(entity.data);
    let data = clean;
    if (mode === 'restore') {
      const current = store.db.prepare(`SELECT id FROM project.${table} WHERE id=? AND projectId=?`).get(entity.id, store.projectId);
      // Recreating a removed row is the only case that needs the frozen
      // creation metadata; content fields stay exactly as recorded.
      if (!current) data = {...clean, ...(typeof clean.createdAt === 'string' ? {} : {createdAt: now()})};
    }
    const write = store.db.prepare(`UPDATE project.${table} SET data=?,archivedAt=?,archiveBatchId=?,archiveReason=?
      WHERE id=? AND projectId=?`).run(JSON.stringify(data), mark.archivedAt, mark.archiveBatchId, mark.archiveReason,
      entity.id, store.projectId);
    if (Number(write.changes) !== 1) {
      const insert = store.db.prepare(`INSERT INTO project.${table}(id,projectId,data,archivedAt,archiveBatchId,archiveReason)
        VALUES(?,?,?,?,?,?)`).run(entity.id, store.projectId, JSON.stringify(data), mark.archivedAt, mark.archiveBatchId, mark.archiveReason);
      if (Number(insert.changes) !== 1) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能应用。', [entity.id]);
    }
  }
}

function boardDeltaMatches(store: ProjectStore, delta: SequenceEditBoardDelta): boolean {
  for (const entity of delta.writes) {
    const current = store.db.prepare(`SELECT data FROM project.${tableOf(entity.kind)} WHERE id=? AND projectId=?`)
      .get(entity.id, store.projectId) as Row | undefined;
    if (!current || typeof current.data !== 'string') return false;
    try { if (stable(JSON.parse(current.data)) !== stable(cleanRow(entity.data))) return false; } catch { return false; }
  }
  for (const entity of delta.removals) {
    if (store.db.prepare(`SELECT 1 FROM project.${tableOf(entity.kind)} WHERE id=? AND projectId=?`)
      .get(entity.id, store.projectId) !== undefined) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Timeline patch pair
// ---------------------------------------------------------------------------

function emptyTimelineDelta(baseline: SequenceEditBaselineChange): SequenceEditTimelineDelta {
  return {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline};
}
function timelineDeltaChanged(delta: SequenceEditTimelineDelta): boolean {
  return delta.clips.length > 0 || delta.cues.length > 0 || delta.removedClipIds.length > 0
    || delta.removedCueIds.length > 0 || delta.baseline.kind !== 'unchanged';
}

function sameRow(left: unknown, right: unknown): boolean {
  return (left === undefined && right === undefined) || (left !== undefined && right !== undefined && stable(left) === stable(right));
}

function buildTimelinePatch(before: Format5Timeline, after: Format5Timeline | null,
  baseline: SequenceEditBaselineChange, beforeBaseline: Format5SyncBaseline): {before: SequenceEditTimelineDelta; after: SequenceEditTimelineDelta} {
  const oldClips = new Map(before.clips.map(clip => [clip.id, clip] as const));
  const newClips = new Map((after?.clips ?? before.clips).map(clip => [clip.id, clip] as const));
  const oldCues = new Map((before.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const newCues = new Map((after?.subtitles?.cues ?? before.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const beforeClips: Format5Clip[] = [], afterClips: Format5Clip[] = [];
  const beforeCues: Format5Cue[] = [], afterCues: Format5Cue[] = [];
  const beforeRemovedClips: string[] = [], afterRemovedClips: string[] = [];
  const beforeRemovedCues: string[] = [], afterRemovedCues: string[] = [];
  for (const id of new Set([...oldClips.keys(), ...newClips.keys()])) {
    const oldClip = oldClips.get(id), newClip = newClips.get(id);
    if (sameRow(oldClip, newClip)) continue;
    if (oldClip) beforeClips.push(oldClip); else beforeRemovedClips.push(id);
    if (newClip) afterClips.push(newClip); else afterRemovedClips.push(id);
  }
  for (const id of new Set([...oldCues.keys(), ...newCues.keys()])) {
    const oldCue = oldCues.get(id), newCue = newCues.get(id);
    if (sameRow(oldCue, newCue)) continue;
    if (oldCue) beforeCues.push(oldCue); else beforeRemovedCues.push(id);
    if (newCue) afterCues.push(newCue); else afterRemovedCues.push(id);
  }
  return {
    before: {clips: beforeClips, cues: beforeCues, removedClipIds: beforeRemovedClips, removedCueIds: beforeRemovedCues,
      baseline: beforeBaselineValue(beforeBaseline, baseline)},
    after: {clips: afterClips, cues: afterCues, removedClipIds: afterRemovedClips, removedCueIds: afterRemovedCues, baseline},
  };
}

function beforeBaselineValue(before: Format5SyncBaseline, change: SequenceEditBaselineChange): SequenceEditBaselineChange {
  switch (change.kind) {
    case 'unchanged': return {kind: 'unchanged'};
    case 'absent': return {kind: 'set', value: before};
    case 'set': return stable(before) === stable(change.value) ? {kind: 'unchanged'} : {kind: 'set', value: before};
  }
}

function countTimeline(delta: SequenceEditTimelineDelta, mainTrackId: string): {mainTrackClips: number; otherTrackItems: number; subtitleCues: number} {
  const main = delta.clips.filter(clip => clip.trackId === mainTrackId).length + delta.removedClipIds.length;
  const other = delta.clips.filter(clip => clip.trackId !== mainTrackId).length;
  return {mainTrackClips: main, otherTrackItems: other, subtitleCues: delta.cues.length + delta.removedCueIds.length};
}

// ---------------------------------------------------------------------------
// Receipts and history views
// ---------------------------------------------------------------------------

function historyAction(entry: SequenceEditHistoryEntry | null): SequenceEditHistoryAction | null {
  if (!entry) return null;
  const board = entry.afterPatch.board;
  return {actionId: entry.actionId, operation: entry.operation, affected: board.writes.length + board.removals.length};
}
function historyView(history: SequenceEditHistoryPort, cursor: SequenceEditHistoryCursor, store: ProjectStore): SequenceEditHistoryView {
  const undoEntry = history.readEntryAt(cursor.position);
  const redoEntry = history.readEntryAt(cursor.position + 1);
  return {epoch: cursor.epoch, position: cursor.position, revision: cursor.revision,
    undo: historyAction(undoEntry), redo: historyAction(redoEntry)};
}
function receiptOf(args: {
  readonly envelope: SequenceEditEnvelope; readonly history: SequenceEditHistoryPort; readonly cursor: SequenceEditHistoryCursor;
  readonly store: ProjectStore; readonly affected: {nodes: number; edges: number; mainTrackClips: number; otherTrackItems: number; subtitleCues: number};
  readonly timelineRevision: number; readonly syncRevision: number; readonly operation: string;
}): SequenceEditReceipt {
  const {envelope, history, cursor, store, affected, timelineRevision, syncRevision, operation} = args;
  return {
    version: 1, requestId: envelope.requestId, inputDigest: digestOf(envelope), projectId: envelope.projectId,
    actionId: envelope.actionId, operation, originSide: envelope.originSide, status: 'applied', affected,
    history: historyView(history, cursor, store), contentRevision: contentStamp(store).contentSequence,
    timelineRevision, syncRevision,
  };
}

function assertEnvelope(store: ProjectStore, context: EditContext, envelope: SequenceEditEnvelope, cursor: SequenceEditHistoryCursor): void {
  if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
  if (envelope.filmId !== context.rootNodeId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '成片根与时间线不一致。', [envelope.filmId, context.rootNodeId]);
  if (!isSequenceEditIntentSequence(envelope.intents)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '动作组合无效。');
  for (const intent of envelope.intents) validateOperation(intent);
  const stamp = contentStamp(store);
  const conflicts: string[] = [];
  if (envelope.baseline.contentRevision !== stamp.contentSequence) conflicts.push('content');
  if (envelope.baseline.timelineRevision !== context.timeline.revision) conflicts.push('timeline');
  if (envelope.baseline.syncRevision !== context.syncRevision) conflicts.push('sync');
  if (conflicts.length) fail('SEQUENCE_EDIT_REVISION_CONFLICT', '项目的修订已经变化，请重新读取后再试。', [], {revision: conflicts});
  if (envelope.baseline.historyPosition !== cursor.position || envelope.baseline.historyRevision !== cursor.revision) {
    fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '撤销历史的位置已经变化，请重新读取。', [], {cursor});
  }
  for (const target of envelope.baseline.targets) {
    if (target.kind === 'clip' || target.kind === 'cue') continue;
    const revision = readMioTargetRevision(store.db, store.projectId, target.kind, target.id);
    if (revision !== target.revision) fail('SEQUENCE_EDIT_REVISION_CONFLICT', '受影响的画板对象已经变化。', [target.id], {target});
  }
}

// ---------------------------------------------------------------------------
// Apply one action
// ---------------------------------------------------------------------------

export function applySequenceEdit(store: ProjectStore, envelope: SequenceEditEnvelope, ports: SequenceEditPorts,
  authorize: () => void = () => {}): SequenceEditReceipt {
  assertFormat5(store);
  if (!ports.history) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '同步接缝尚未就绪，暂不能修改画板顺序链。');
  const history = ports.history;
  const operation = sequenceEditOperationName(envelope.intents);
  const requestDigest = digestOf(envelope);
  return store.tx(() => {
    authorize();
    // An exact retry returns the immutable receipt before observing any newer
    // revision, so a replay never has to match the current baseline.
    const replay = history.findReceipt(envelope.requestId);
    if (replay) {
      if (replay.inputDigest !== requestDigest || replay.operation !== operation) {
        fail('SEQUENCE_EDIT_REQUEST_REUSED', '这个请求 ID 已用于不同的画板操作。', [], {requestId: envelope.requestId});
      }
      return replay.receipt;
    }
    const context = readSequenceEditContext(store);
    const cursor = history.readCursor();
    assertEnvelope(store, context, envelope, cursor);
    const allocatedCopyIds = new Set(envelope.allocation.nodes.map(item => item.nodeId));
    const referenced = referencedNodeIds(envelope);
    const restored = new Map<string, Row>();
    const addedNodes: ChainNode[] = [];
    for (const id of referenced) {
      const archived = context.archived.get(`shot:${id}`) ?? context.archived.get(`node:${id}`);
      if (!archived) continue;
      restored.set(id, archived);
      const kind = context.archived.has(`shot:${id}`) ? 'shot' as const : format5ChainNodeKind(String(archived.type));
      addedNodes.push({id, kind});
    }
    const initialBoard: ChainBoard = {nodes: [...context.board.nodes, ...addedNodes].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0), edges: context.board.edges};
    const restoredMedia = [...context.media];
    for (const node of addedNodes) {
      if (restoredMedia.some(item => item.nodeId === node.id)) continue;
      if (node.kind === 'shot' || node.kind === 'image' || node.kind === 'video') {
        restoredMedia.push({nodeId: node.id, selectedVersion: null, durationFrames: 120});
      }
    }
    let state: ChainSyncState = {board: initialBoard, filmId: context.rootNodeId, media: restoredMedia,
      clips: context.clips, anchored: context.anchored};
    let stateBeforeFinal = state;
    let timelineChanged = false;
    let plan!: SuccessfulPlan;
    for (let index = 0; index < envelope.intents.length; index++) {
      const planned = planSequenceEditIntents(state, [envelope.intents[index]!], envelope.allocation);
      if (!planned.ok) planFailure({ok: false, code: planned.code as never, id: planned.ids[0] ?? ''} as never);
      stateBeforeFinal = state;
      state = planned.state;
      plan = planned.plan;
      if (planTimelineChanged(plan)) timelineChanged = true;
    }
    const copiedNodes = new Map<string, CopyNode>();
    for (const item of envelope.allocation.nodes) {
      if (!isUuid(item.fromNodeId) || !isUuid(item.nodeId)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '复制节点的预分配 ID 无效。');
      if (!state.board.nodes.some(node => node.id === item.nodeId)) continue;
      const copy = copyNodeRow(context, item.fromNodeId, item.nodeId);
      if (!copy) fail('COPY_NODE_REQUIRED', '复制节点需要有效的来源。', [item.fromNodeId]);
      copiedNodes.set(item.nodeId, copy);
      if (allocatedCopyIds.has(item.nodeId) && !context.board.nodes.some(node => node.id === item.fromNodeId)) {
        fail('SEQUENCE_EDIT_CONTRACT_INVALID', '复制节点的来源不在画板上。', [item.fromNodeId]);
      }
    }
    const deleted = new Set<string>();
    for (const intent of envelope.intents) {
      if (intent.operation.kind === 'board' && intent.operation.edit.kind === 'delete') deleted.add(intent.operation.edit.nodeId);
    }
    const boardDeltas = planBoardDeltas(context, envelope, state.board, state.media, restored, deleted, copiedNodes);
    const changed = boardDeltas.nodes + boardDeltas.edges > 0 || timelineChanged || restored.size > 0 || copiedNodes.size > 0;
    if (!changed) {
      const affected = {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0};
      const receipt = receiptOf({envelope, history, cursor, store, affected,
        timelineRevision: context.timeline.revision, syncRevision: context.syncRevision, operation});
      history.commit({requestId: envelope.requestId, operation, inputDigest: requestDigest, receipt, entry: null, direction: 'apply'});
      return receipt;
    }
    if (!ports.mainTrack) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '主轨同步接缝尚未就绪，暂不能修改绑定了成片根的顺序链。');
    let syncCommit: SequenceEditTimelineCommit | undefined;
    if (timelineChanged) {
      const result = ports.mainTrack.projectMainTrack({envelope, state: stateBeforeFinal, plan});
      if (!result.ok) fail(result.code, '主轨同步拒绝了这次画板修改。', result.ids);
      syncCommit = result;
    }
    applyBoardDelta(store, boardDeltas.after, 'forward');
    const beforeTimeline = context.timeline;
    const afterTimeline = readFormat5TimelineRecord(store.db, 'project');
    if (!afterTimeline) return invalidContent();
    const baselineChange = syncCommit?.delta.baseline ?? {kind: 'unchanged' as const};
    const timelinePatch = buildTimelinePatch(beforeTimeline, afterTimeline, baselineChange, context.baseline);
    bumpFormat5ContentStampInside(store.db, 'project');
    const afterContent = contentStamp(store).contentSequence;
    const timelineRevision = syncCommit?.timelineRevision ?? afterTimeline.revision;
    const syncRevision = syncCommit?.syncRevision ?? context.syncRevision;
    const timelineCounts = countTimeline(timelinePatch.after, context.timeline.mainTrack.trackId);
    const newCursor: SequenceEditHistoryCursor = {...cursor, position: cursor.position + 1, revision: cursor.revision + 1};
    const affected = {nodes: boardDeltas.nodes, edges: boardDeltas.edges, ...timelineCounts};
    const beforeState: SequenceEditStateDelta = {board: boardDeltas.before, timeline: timelinePatch.before};
    const afterState: SequenceEditStateDelta = {board: boardDeltas.after, timeline: timelinePatch.after};
    const entry: SequenceEditHistoryEntry = {actionId: envelope.actionId, projectId: store.projectId, epoch: cursor.epoch,
      position: newCursor.position, operation, origin: 'user', beforePatch: beforeState, afterPatch: afterState, createdAt: now()};
    const receipt = receiptOf({envelope, history, cursor: newCursor, store, affected,
      timelineRevision, syncRevision, operation});
    if (receipt.history.position !== newCursor.position) return invalidContent();
    history.commit({requestId: envelope.requestId, operation, inputDigest: requestDigest, receipt, entry, direction: 'apply'});
    return {...receipt, contentRevision: afterContent};
  });
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export interface SequenceEditHistoryRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly expected: SequenceEditHistoryCursor;
}

export function applySequenceEditHistory(store: ProjectStore, direction: 'undo' | 'redo', request: SequenceEditHistoryRequest,
  ports: SequenceEditPorts, authorize: () => void = () => {}): SequenceEditReceipt {
  assertFormat5(store);
  if (!ports.history) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '同步接缝尚未就绪，暂不能撤回画板修改。');
  const history = ports.history;
  return store.tx(() => {
    authorize();
    const cursor = history.readCursor();
    const operation = direction;
    const digest = createHash('sha256').update(canonicalSequenceEditInput({actionId: request.actionId, expected: request.expected, direction} as never)).digest('hex');
    const replay = history.findReceipt(request.requestId);
    if (replay) {
      if (replay.inputDigest !== digest || replay.operation !== operation) {
        fail('SEQUENCE_EDIT_REQUEST_REUSED', '这个请求 ID 已用于不同的画板操作。', [], {requestId: request.requestId});
      }
      return replay.receipt;
    }
    if (request.expected.position !== cursor.position || request.expected.revision !== cursor.revision) {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '撤销历史的位置已经变化，请重新读取。', [], {cursor});
    }
    const target = direction === 'undo' ? history.readEntryAt(cursor.position) : history.readEntryAt(cursor.position + 1);
    if (!target || target.actionId !== request.actionId) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能撤回。', [request.actionId]);
    const sourceDelta = direction === 'undo' ? target.afterPatch : target.beforePatch;
    const applyDelta = direction === 'undo' ? target.beforePatch : target.afterPatch;
    let timelineRevision = readFormat5TimelineRecord(store.db, 'project')?.revision ?? 0;
    let syncRevision = readSequenceEditContext(store).syncRevision;
    const timelineChanged = timelineDeltaChanged(sourceDelta.timeline) || timelineDeltaChanged(applyDelta.timeline);
    if (timelineChanged) {
      const timelineHistory = ports.timelineHistory;
      if (!timelineHistory) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '撤回主轨变化需要主轨同步接缝接线后才能应用。', [target.actionId]);
      if (!timelineHistory.matches(sourceDelta.timeline)) {
        fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步之后主轨已经变化，不能直接撤回。', [target.actionId]);
      }
    }
    if (!boardDeltaMatches(store, sourceDelta.board)) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步之后画板已经变化，不能直接撤回。', [target.actionId]);
    applyBoardDelta(store, applyDelta.board, 'restore');
    if (timelineChanged) {
      const applied = ports.timelineHistory!.apply(applyDelta.timeline);
      if ('ok' in applied) fail(applied.code, '主轨撤回被同步接缝拒绝。', applied.ids);
      timelineRevision = applied.timelineRevision;
      syncRevision = applied.syncRevision;
    }
    bumpFormat5ContentStampInside(store.db, 'project');
    const newCursor: SequenceEditHistoryCursor = {...cursor, position: cursor.position + (direction === 'undo' ? -1 : 1), revision: cursor.revision + 1};
    const signed = applyDelta.board.writes.length + applyDelta.board.removals.length;
    const timelineCounts = countTimeline(applyDelta.timeline, readFormat5TimelineRecord(store.db, 'project')?.mainTrack.trackId ?? '');
    const receipt: SequenceEditReceipt = {
      version: 1, requestId: request.requestId, inputDigest: digest, projectId: store.projectId,
      actionId: target.actionId, operation: `${direction}:${target.operation}`, originSide: 'board', status: 'applied',
      affected: {nodes: signed, edges: 0, mainTrackClips: timelineCounts.mainTrackClips,
        otherTrackItems: timelineCounts.otherTrackItems, subtitleCues: timelineCounts.subtitleCues},
      history: historyView(history, newCursor, store),
      contentRevision: contentStamp(store).contentSequence,
      timelineRevision, syncRevision,
    };
    history.commit({requestId: request.requestId, operation, inputDigest: digest, receipt, entry: null, direction});
    return receipt;
  });
}

// ---------------------------------------------------------------------------
// History projection
// ---------------------------------------------------------------------------

export interface SequenceEditHistoryProjection extends SequenceEditHistoryView {
  readonly projectId: string;
  readonly conflict: boolean;
  readonly undoConflict: boolean;
  readonly redoConflict: boolean;
  readonly undoAvailable: boolean;
  readonly redoAvailable: boolean;
}
export function readSequenceEditHistory(store: ProjectStore, history: SequenceEditHistoryPort): SequenceEditHistoryProjection {
  assertFormat5(store);
  const cursor = history.readCursor();
  const view = historyView(history, cursor, store);
  const undoEntry = history.readEntryAt(cursor.position), redoEntry = history.readEntryAt(cursor.position + 1);
  const sourceForUndo = undoEntry?.afterPatch.board, targetForRedo = redoEntry?.beforePatch.board;
  const undoConflict = !!undoEntry && !!sourceForUndo && !boardDeltaMatches(store, sourceForUndo);
  const redoConflict = !!redoEntry && !!targetForRedo && !boardDeltaMatches(store, targetForRedo);
  return {...view, projectId: store.projectId, conflict: undoConflict || redoConflict,
    undoConflict, redoConflict, undoAvailable: !!undoEntry && !undoConflict, redoAvailable: !!redoEntry && !redoConflict};
}

// ---------------------------------------------------------------------------
// Transaction-internal board seam (TS → CS)
// ---------------------------------------------------------------------------

/** CS half of one track-origin action. TS calls this inside its transaction
 * after planning; CS writes the rewired board edges/nodes and returns the
 * board patch. The content stamp advances once here. */
export function createSequenceBoardPort(store: ProjectStore): BoardSeamProjectionPort {
  return {
    projectBoardSeam(request: SequenceEditTransactionRequest): SequenceEditBoardCommitResult {
      if (!isFormat5Project(store)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于项目格式 5。');
      const context = readSequenceEditContext(store);
      const envelope = request.envelope;
      if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
      const operation = request.plan;
      const finalBoard = operation.after.board;
      const finalMedia = operation.after.media;
      const copiedNodes = new Map<string, CopyNode>();
      for (const item of envelope.allocation.nodes) {
        if (!isUuid(item.fromNodeId) || !isUuid(item.nodeId)) continue;
        if (!finalBoard.nodes.some(node => node.id === item.nodeId)) continue;
        const copy = copyNodeRow(context, item.fromNodeId, item.nodeId);
        if (!copy) fail('COPY_NODE_REQUIRED', '复制节点需要有效的来源。', [item.fromNodeId]);
        copiedNodes.set(item.nodeId, copy);
      }
      const deltas = planBoardDeltas(context, envelope, finalBoard, finalMedia, new Map(), new Set(), copiedNodes);
      if (!deltas.nodes && !deltas.edges) return {ok: true, delta: deltas.after, contentRevision: contentStamp(store).contentSequence};
      applyBoardDelta(store, deltas.after, 'forward');
      bumpFormat5ContentStampInside(store.db, 'project');
      return {ok: true, delta: deltas.after, contentRevision: contentStamp(store).contentSequence};
    },
  };
}
type SequenceEditBoardCommitResult = {readonly ok: true; readonly delta: SequenceEditBoardDelta; readonly contentRevision: number}
  | SequenceEditTransactionFailure;

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface SequenceEditingService {
  call(operation: SequenceEditingOperation, input: unknown, authorize?: () => void): unknown;
}
export function createSequenceEditing(store: ProjectStore, ports: SequenceEditPorts = {}): SequenceEditingService {
  return {
    call(operation: SequenceEditingOperation, input: unknown, authorize: () => void = () => {}): unknown {
      assertFormat5(store);
      const parsed = sequenceEditingSchemas[operation].safeParse(input);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', '画板顺序链操作参数无效。', 400, {issues: parsed.error.issues});
      if (operation === 'sequence.history.get') {
        const {projectId} = parsed.data as {projectId: string};
        if (projectId !== store.projectId) throw new AppError('VALIDATION_ERROR', '项目范围无效。', 400);
        if (!ports.history) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '同步接缝尚未就绪。');
        return sequenceEditingResponses[operation].parse(readSequenceEditHistory(store, ports.history));
      }
      if (!ports.history) fail('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', '同步接缝尚未就绪，暂不能修改画板顺序链。');
      if (operation === 'sequence.edit') {
        const envelope = parsed.data as unknown as SequenceEditEnvelope;
        if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
        return sequenceEditingResponses[operation].parse(applySequenceEdit(store, envelope, ports, authorize));
      }
      const history = parsed.data as {projectId?: string; requestId: string; actionId: string; expected: SequenceEditHistoryCursor};
      if (history.projectId !== undefined && history.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
      return sequenceEditingResponses[operation].parse(applySequenceEditHistory(store, operation === 'sequence.undo' ? 'undo' : 'redo',
        {projectId: store.projectId, requestId: history.requestId, actionId: history.actionId, expected: history.expected}, ports, authorize));
    },
  };
}
export {isSequenceEditingOperation, isSequenceEditingWrite};
