import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {readCanvasClipboardSnapshot} from './canvas-clipboard.ts';
import {planChainSync} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncOperation, ChainSyncPlan, ChainSyncState, ChainSyncWarning} from '../../contracts/src/chain-sync-algorithm.ts';
import {deriveFilmChains} from '../../contracts/src/board-sequence.ts';
import type {ChainBoard, ChainNode, SequenceEdge} from '../../contracts/src/board-sequence.ts';
import type {ChainSyncBaseline, TrackAnchoredItem} from '../../contracts/src/chain-sync-analysis.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {format5SyncBaselineSchema} from '../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {
  applySequenceEditBaselineChange, isBoardIntentOperation, isSequenceEditIntentSequence, sequenceEditEnvelopeOperationName,
  sequenceEditOperationName,
} from '../../contracts/src/sequence-edit.ts';
import type {
  BoardSeamProjectionPort, SequenceEditAffectedCounts, SequenceEditAllocation, SequenceEditBaselineChange,
  SequenceEditBoardDelta, SequenceEditBoardEntity, SequenceEditEnvelope, SequenceEditHistoryCommand,
  SequenceEditHistoryEntry, SequenceEditHistoryView, SequenceEditIntent, SequenceEditPatch, SequenceEditReceipt,
  SequenceEditStateDelta, SequenceEditTimelineDelta, SequenceEditTimelineCommit, SequenceEditTransactionFailure,
  SequenceEditTransactionRequest, BoardIntentOperation,
} from '../../contracts/src/sequence-edit.ts';
import {
  isSequenceEditingOperation, isSequenceEditingWrite, sequenceEditingResponses, sequenceEditingSchemas,
  sequenceEditOperationSchema,
} from '../../contracts/src/sequence-editing.ts';
import type {SequenceEditingOperation} from '../../contracts/src/sequence-editing.ts';
import {
  applySequenceEditBaselineDelta, applySequenceEditTimelineDelta, applySubjectBindingWrite,
  createMainTrackProjectionPort, previewMainTrackProjection, readSequenceSyncContext,
} from './format5-sequence-sync.ts';
import {copyFormat5ShotDialogue} from './format5-dialogue-projection.ts';
import type {SequenceSyncContext} from './format5-sequence-sync.ts';
import {
  findSequenceEditReceipt, historyCommandDigest, moveSequenceEditHistoryCursor, prepareSequenceEditHistory,
  readSequenceEditHistoryEntry, sequenceEditHistoryFloor, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure,
} from './format5-editor-history.ts';
import type {SequenceEditHistoryState, SequenceEditReceiptDraft} from './format5-editor-history.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5JsonRows} from './project-file/format5-content.ts';
import {bumpFormat5ContentStampInside, readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
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
export type Format5LegacyWriteUse = 'sequence.preview/commit' | 'sequence.history.get' | 'sequence.undo'
  | 'sequence.redo' | 'not_yet_available';
/** Every legacy writer that would bypass the unified format-5 transaction.
 * FR-0 gates them all until their own card moves them onto
 * `sequence.preview/commit` (or the owner card re-opens them). Reads stay out. */
export const FORMAT5_LEGACY_WRITE_USES: Readonly<Record<string, Format5LegacyWriteUse>> = Object.freeze({
  'timeline.get': 'sequence.preview/commit',
  'timeline.track.add': 'sequence.preview/commit', 'timeline.track.update': 'sequence.preview/commit',
  'timeline.clip.add': 'sequence.preview/commit', 'timeline.clip.update': 'sequence.preview/commit',
  'timeline.clip.replaceSource': 'sequence.preview/commit', 'timeline.clip.remove': 'sequence.preview/commit',
  'timeline.clip.rippleRemove': 'sequence.preview/commit', 'timeline.clip.split': 'sequence.preview/commit',
  'timeline.clip.splitAtScenes': 'sequence.preview/commit', 'timeline.clip.crossfade': 'sequence.preview/commit',
  'timeline.clip.setGains': 'sequence.preview/commit', 'timeline.clip.setTransform': 'sequence.preview/commit',
  'timeline.clip.setTransition': 'sequence.preview/commit', 'timeline.loudness.apply': 'sequence.preview/commit',
  'timeline.subtitle.add': 'sequence.preview/commit', 'timeline.subtitle.update': 'sequence.preview/commit',
  'timeline.subtitle.remove': 'sequence.preview/commit', 'timeline.seed': 'not_yet_available',
  'timeline.shots.append': 'not_yet_available', 'timeline.clip.refreshSources': 'not_yet_available',
  'timeline.format.set': 'sequence.preview/commit',
  'timeline.history.get': 'sequence.history.get', 'timeline.undo': 'sequence.undo', 'timeline.redo': 'sequence.redo',
  'canvas.apply': 'sequence.preview/commit',
  'canvas.history.get': 'sequence.history.get', 'canvas.history.undo': 'sequence.undo', 'canvas.history.redo': 'sequence.redo',
  'edge.create': 'sequence.preview/commit', 'edge.delete': 'sequence.preview/commit',
  'shot.reorder': 'sequence.preview/commit', 'version.select': 'sequence.preview/commit',
  'shot.create': 'sequence.preview/commit', 'shot.update': 'sequence.preview/commit',
  'node.create': 'sequence.preview/commit', 'node.update': 'sequence.preview/commit',
  'reference.attach': 'sequence.preview/commit', 'reference.detach': 'sequence.preview/commit',
  // Previs scene writes are board actions, so they own a `previsIntent` in the
  // unified entry (G line). `previs.thumbnail.set` stays open on purpose: a
  // thumbnail is a disposable, rebuildable cache, so it writes outside history
  // and never creates an undo step; its writer takes the node's scene revision
  // as CAS and refuses a stale render.
  'previs.create': 'sequence.preview/commit', 'previs.scene.set': 'sequence.preview/commit',
  // Product decision 11-21: the subject library's create/version-add are asset
  // library operations. They write only subjects/subject_versions (retained
  // evidence) and never the board or the timeline, so they stay out of the
  // unified undo stack — exactly like importing an asset. Putting a subject on
  // the board still travels through the subject-card intent, and binding it to
  // a shot still goes through `sequence.preview/commit`.
  'subject.binding.set': 'sequence.preview/commit',
});
/** Public CLI/MCP routes for each gated entry. Where the format-5 model changes
 * the operation's scope, the hint names the supported subset. */
export const FORMAT5_LEGACY_WRITE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  'timeline.get':'成片主轨和生成占位用 sequence inspect；所有片段来源均可检查时，可用 timeline inspect 查看轨道和片段',
  'timeline.track.add':'sequence timeline edit（动作 track-add）',
  'timeline.track.update':'sequence timeline edit（动作 track-update）',
  'timeline.clip.add':'sequence timeline edit（动作 insert-asset，按素材、轨道和起始帧入轨）',
  'timeline.clip.update':'sequence clip edit（动作 clip-properties，仅改片段属性；移动或裁切使用剪辑面板）',
  'timeline.clip.replaceSource':'sequence clip edit（动作 replace-source，传 projectId、clipId、assetId；镜头主轨还须传镜头拥有或已采纳的 versionId）。用返回的 envelope 和 planDigest 调用 sequence action commit（将 planDigest 传为 expectedPlanDigest）',
  'timeline.clip.remove':'sequence action edit（动作 remove；删除主轨片段会收拢主轨）',
  'timeline.clip.rippleRemove':'sequence action edit（动作 remove，随动收拢仅适用主轨）',
  'timeline.clip.split':'sequence action edit（动作 split，仅适用主轨，传片段内的 offsetFrames）',
  'timeline.clip.splitAtScenes':'sequence timeline edit（动作 split-at-scenes）',
  'timeline.clip.crossfade':'sequence clip edit（动作 clip-properties，在一次编辑中手动设置两个片段的 volumeEnvelope）',
  'timeline.clip.setGains':'sequence clip edit（动作 clip-properties）',
  'timeline.clip.setTransform':'sequence clip edit（动作 clip-properties）',
  'timeline.clip.setTransition':'sequence clip edit（动作 clip-properties）',
  'timeline.loudness.apply':'整片响度校验并应用暂无等价命令；手动改增益可用 sequence clip edit（动作 clip-properties）',
  'timeline.subtitle.add':'sequence timeline edit（动作 subtitles）',
  'timeline.subtitle.update':'sequence timeline edit（动作 subtitles）',
  'timeline.subtitle.remove':'sequence timeline edit（动作 subtitles）',
  'timeline.seed':'按镜头批量初始化时间线暂无等价命令；逐个按素材入轨可用 sequence timeline edit（动作 insert-asset，仅插入素材）',
  'timeline.shots.append':'按镜头批量追加暂无等价命令；逐个按素材入轨可用 sequence timeline edit（动作 insert-asset，仅插入素材）',
  'timeline.clip.refreshSources':'批量刷新所选版本暂无等价命令；单个主轨片段改为跟随可用 sequence action edit（动作 set-mode，mode 为 follow）',
  'timeline.format.set':'sequence timeline edit（动作 format-set）',
  'timeline.history.get':'sequence history get',
  'timeline.undo':'sequence undo',
  'timeline.redo':'sequence redo',
  'canvas.apply':'布局移动用 sequence board edit（动作 board-layout-move）；恢复镜头或节点用 sequence board edit（动作 board-restore）；粘贴快照用 sequence preview（操作 board.paste）后用 sequence commit；批量归档暂无等价命令',
  'canvas.history.get':'sequence history get',
  'canvas.history.undo':'sequence undo',
  'canvas.history.redo':'sequence redo',
  'edge.create':'sequence action edit（动作 connect，仅用来创建顺序连线）',
  'edge.delete':'sequence action edit（动作 disconnect，仅用来断开顺序连线）',
  'shot.reorder':'sequence action edit（动作 reorder，逐个移动主轨片段，成片顺序会同步到画板）',
  'version.select':'sequence preview（操作 board-version，在画板 intent 中传 nodeId 和 version，version 含 id 和 sourceFrames: null）后用 sequence commit',
  'shot.create':'sequence board edit（动作 board-shot-append，在成片链末追加镜头；再编辑镜头属性或引用）',
  'shot.update':'sequence board edit（动作 board-shot-update，改标题、提示词、时长、横竖比例或位置）',
  'node.create':'sequence board edit（动作 board-node-create，用 name 设置节点名称）',
  'node.update':'sequence board edit（动作 board-node-update，用 patch.name 修改节点名称）',
  'reference.attach':'sequence reference edit（动作 reference-attach，首帧请指定 role 为 first_frame）',
  'reference.detach':'sequence reference edit（动作 reference-detach）',
  'previs.create':'sequence previs edit（动作 previs-create）',
  'previs.scene.set':'sequence previs edit（动作 previs-scene-set）',
  'subject.binding.set':'sequence subject edit（动作 subject-binding，按绑定状态选择新建、切换跟随或锁定、解绑或恢复）',
});
export function format5LegacyWriteUse(operation: string): Format5LegacyWriteUse | null {
  return Object.hasOwn(FORMAT5_LEGACY_WRITE_USES, operation) ? FORMAT5_LEGACY_WRITE_USES[operation]! : null;
}
/** One-time FR-0 gate: under explicit format-5 admission every legacy writer
 * that is not yet routed through `sequence.preview/commit` fails before it can
 * touch the project. Format 3/4 behavior is untouched. */
export function assertFormat5LegacyWriteAllowed(store: ProjectStore, operation: string): void {
  const use = format5LegacyWriteUse(operation);
  if (!use || !isFormat5Project(store)) return;
  const command=FORMAT5_LEGACY_WRITE_COMMANDS[operation]??String(use);
  throw new AppError('UNSUPPORTED_OPERATION', `格式 5 的这个旧入口已停用。${command}。`, 409, {use,command});
}
export function assertLegacyCanvasWriteAllowed(store: ProjectStore, use: LegacyCanvasWrite): void {
  if (!isFormat5Project(store)) return;
  throw new AppError('UNSUPPORTED_OPERATION', LEGACY_WRITE_MESSAGES[use], 409, {use: 'sequence.preview/commit'});
}
function assertFormat5(store: ProjectStore): void {
  if (!isFormat5Project(store)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
}

// ---------------------------------------------------------------------------
// Shared transaction seams
// ---------------------------------------------------------------------------

// CS never owns the history-13 rows: `format5-editor-history.ts` (the module the
// timeline-sync line aligned to the #289 contract) writes the cursor, entry and
// receipt, and `format5-sequence-sync.ts` provides the TS main-track projection
// plus the timeline half of undo/redo. Both run inside the caller's transaction.

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
}

function editContextOf(context: SequenceSyncContext): EditContext {
  return {
    projectId: context.projectId, timeline: context.timeline, rootNodeId: context.rootNodeId,
    syncRevision: context.syncRevision, baseline: context.baseline, board: context.board, nodes: context.nodes,
    rows: {shots: context.shots, nodes: context.nodeRows, edges: context.edgeRows,
      versions: context.versions, assets: context.assets},
    archived: new Map<string, Row>([
      ...[...context.archivedShots].map(([id, row]) => [`shot:${id}`, row] as const),
      ...[...context.archivedNodes].map(([id, row]) => [`node:${id}`, row] as const),
      ...[...context.archivedEdges].map(([id, row]) => [`edge:${id}`, row] as const),
    ]),
    media: context.media, clips: context.clips, anchored: context.anchored,
  };
}

/** One projection read: the shared timeline-sync context drives both the CS
 * planning state and, below, the TS main-track projection in the same tx. */
export function readSequenceEditContext(store: ProjectStore): EditContext {
  return editContextOf(readSequenceSyncContext(store));
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

function referencedNodeIds(envelope: {readonly intents: readonly SequenceEditIntent[]}): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown): void => {if (isUuid(value)) ids.add(value);};
  for (const intent of envelope.intents) {
    const operation = intent.operation;
    if (isBoardIntentOperation(operation)) continue;
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

function validateOperation(intent: {readonly operation: SequenceEditIntent['operation']}): void {
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
    if (isBoardIntentOperation(intent.operation)) {
      return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: []};
    }
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
// UI-B2 board-only intents: root creation, chain-tail shot append, layout move
// ---------------------------------------------------------------------------

export interface BoardCreationRows {
  readonly shots: ReadonlyMap<string, Row>;
  readonly nodes: ReadonlyMap<string, Row>;
  readonly media: readonly ChainSyncMedia[];
  readonly chainNodes: readonly ChainNode[];
}
export interface BoardLayoutMove {readonly nodeId: string; readonly position: {readonly x: number; readonly y: number}}
export interface BoardActionPreparation {
  readonly restored: ReadonlyMap<string, Row>;
  readonly created: BoardCreationRows;
  readonly layoutMoves: readonly BoardLayoutMove[];
  readonly planIntents: readonly SequenceEditIntent[];
  /** Row updates/archives/restores that do not pass through the SA chain plan
   * (record patches and detached-node archive). */
  readonly directChanges: readonly {readonly kind: 'shot' | 'node' | 'edge'; readonly before: Row;
    readonly after: Row; readonly newRecord?: boolean}[];
  readonly deleted: ReadonlySet<string>;
  /** Allocation including ids this preview had to allocate for new rows. */
  readonly allocation: SequenceEditAllocation;
  readonly warnings: readonly {readonly code: string}[];
}
type MutableAllocation = {clips: {nodeId: string; clipId: string}[]; nodes: {fromNodeId: string; nodeId: string}[];
  splitClips: {clipId: string; rightClipId: string}[]; edges: {id: string; fromId: string; toId: string}[]};
const cloneAllocation = (allocation: SequenceEditAllocation): MutableAllocation => ({
  clips: [...allocation.clips], nodes: [...allocation.nodes], splitClips: [...allocation.splitClips], edges: [...allocation.edges],
});
const rowPosition = (row: Row | undefined): {x: number; y: number} => {
  const value = row?.position;
  return value !== null && typeof value === 'object' && Number.isFinite((value as Row).x) && Number.isFinite((value as Row).y)
    ? {x: Number((value as Row).x), y: Number((value as Row).y)} : {x: 0, y: 0};
};
function activeFilmTail(board: ChainBoard, filmId: string): string {
  const chain = deriveFilmChains(board).chains.find(item => item.filmId === filmId);
  const nodes = chain?.nodeIds ?? [];
  return nodes.length ? nodes[nodes.length - 1]! : filmId;
}
function boardIntentPreparation(context: EditContext, store: ProjectStore, intents: readonly SequenceEditIntent[],
  allocationInput: SequenceEditAllocation, clipboardOwner: object | undefined,
  allocateNewIds = true): BoardActionPreparation {
  const allocation = cloneAllocation(allocationInput);
  const createdShots = new Map<string, Row>();
  const createdNodes = new Map<string, Row>();
  const createdMedia: ChainSyncMedia[] = [];
  const createdChainNodes: ChainNode[] = [];
  const layoutMoves: BoardLayoutMove[] = [];
  const planIntents: SequenceEditIntent[] = [];
  const directChanges: {kind: 'shot' | 'node' | 'edge'; before: Row; after: Row; newRecord?: boolean}[] = [];
  const deleted = new Set<string>();
  const restoredRows = new Map<string, Row>();
  const warnings: {code: string}[] = [];
  const at = now();
  const liveIds = new Set([...context.rows.shots.keys(), ...context.rows.nodes.keys(),
    ...[...context.archived.keys()].map(key => key.slice(key.indexOf(':') + 1))]);
  for (const intent of intents) {
    const operation = intent.operation;
    if (!isBoardIntentOperation(operation)) {
      if (operation.kind === 'board' && operation.edit.kind === 'delete') {
        const target = context.rows.shots.get(operation.edit.nodeId) ?? context.rows.nodes.get(operation.edit.nodeId);
        if (target?.type === 'subject_card') fail('SEQUENCE_EDIT_CONTRACT_INVALID',
          '主体卡只能通过主体绑定删除，普通删除已拒绝。', [operation.edit.nodeId], {reason: 'SUBJECT_CARD_DELETE_REQUIRED'});
        const chain = deriveFilmChains(context.board).chains.find(item => item.filmId === context.rootNodeId)?.nodeIds ?? [];
        const index = chain.indexOf(operation.edit.nodeId);
        if (index >= 0 && index < chain.length - 1) {
          const fromId = index === 0 ? context.rootNodeId : chain[index - 1]!;
          const toId = chain[index + 1]!;
          if (!allocation.edges.some(edge => edge.fromId === fromId && edge.toId === toId)) {
            if (!allocateNewIds) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '删除接链所需的顺序边 ID 没有随信封分配。', [operation.edit.nodeId]);
            allocation.edges.push({id: randomUUID(), fromId, toId});
          }
        }
      }
      planIntents.push(intent); continue;
    }
    if (operation.kind === 'board.root.create') {
      if (liveIds.has(operation.nodeId)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '新成片根的 ID 已被占用。', [operation.nodeId]);
      liveIds.add(operation.nodeId);
      createdNodes.set(operation.nodeId, {id: operation.nodeId, projectId: context.projectId, type: 'sequence_root',
        name: operation.name, position: {x: operation.position.x, y: operation.position.y}, createdAt: at});
      createdChainNodes.push({id: operation.nodeId, kind: 'film'});
      continue;
    }
    if (operation.kind === 'board.shot.append') {
      if (liveIds.has(operation.nodeId)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '新镜头节点的 ID 已被占用。', [operation.nodeId]);
      liveIds.add(operation.nodeId);
      const maxOrder = [...context.rows.shots.values()].reduce((maximum, row) =>
        Math.max(maximum, Number.isSafeInteger(row.orderIndex) ? Number(row.orderIndex) : -1), -1);
      const tail = activeFilmTail(context.board, context.rootNodeId);
      const position = operation.position ?? (() => {
        const tailRow = context.rows.shots.get(tail) ?? context.rows.nodes.get(tail);
        const point = rowPosition(tailRow);
        return {x: point.x + 290, y: point.y};
      })();
      const shot: Row = {id: operation.nodeId, projectId: context.projectId, title: operation.name,
        orderIndex: maxOrder + 1, position: {x: position.x, y: position.y}, selectedVersionId: null,
        duration: 4, revision: 1, createdAt: at, updatedAt: at};
      createdShots.set(operation.nodeId, shot);
      createdChainNodes.push({id: operation.nodeId, kind: 'shot'});
      createdMedia.push({nodeId: operation.nodeId, selectedVersion: null, durationFrames: 120});
      if (!allocation.clips.some(item => item.nodeId === operation.nodeId)) {
        allocation.clips.push({nodeId: operation.nodeId, clipId: randomUUID()});
      }
      if (!allocation.edges.some(item => item.fromId === tail && item.toId === operation.nodeId)) {
        allocation.edges.push({id: randomUUID(), fromId: tail, toId: operation.nodeId});
      }
      planIntents.push({side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: tail, toId: operation.nodeId}}});
      continue;
    }
    if (operation.kind === 'board.layout.move') {
      for (const move of operation.moves) {
        if (!context.rows.shots.has(move.nodeId) && !context.rows.nodes.has(move.nodeId)) {
          fail('SEQUENCE_EDIT_CONTRACT_INVALID', '布局移动的目标不在画板中。', [move.nodeId]);
        }
        const previous = layoutMoves.findIndex(item => item.nodeId === move.nodeId);
        const normalized: BoardLayoutMove = {nodeId: move.nodeId, position: {x: move.x, y: move.y}};
        if (previous >= 0) (layoutMoves as BoardLayoutMove[])[previous] = normalized; else layoutMoves.push(normalized);
      }
      continue;
    }
    if (operation.kind === 'board.node.create') {
      if (liveIds.has(operation.nodeId)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '新节点 ID 已被占用。', [operation.nodeId]);
      liveIds.add(operation.nodeId);
      const node: Row = {id: operation.nodeId, projectId: context.projectId, type: operation.nodeType,
        name: operation.name, label: operation.name, position: {x: operation.position.x, y: operation.position.y},
        revision: 1, createdAt: at, updatedAt: at};
      if (operation.nodeType === 'text') node.text = operation.text ?? '';
      else {
        if (operation.assetId === undefined) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '图片/视频/音频节点必须引用已导入素材。', [operation.nodeId]);
        const asset = context.rows.assets.get(operation.assetId);
        if (!asset || asset.projectId !== context.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '节点素材不属于本项目。', [operation.nodeId]);
        if (typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith(`${operation.nodeType}/`)) {
          fail('SEQUENCE_EDIT_CONTRACT_INVALID', '素材类型与节点类型不一致。', [operation.nodeId]);
        }
        node.assetId = operation.assetId;
      }
      createdNodes.set(operation.nodeId, node);
      continue;
    }
    if (operation.kind === 'board.shot.update' || operation.kind === 'board.node.update') {
      const targetId = operation.kind === 'board.shot.update' ? operation.shotId : operation.nodeId;
      const shot = context.rows.shots.get(targetId), node = context.rows.nodes.get(targetId);
      const before = shot ?? node;
      if (!before || (operation.kind === 'board.shot.update' ? !shot : !node)) {
        fail('SEQUENCE_EDIT_CONTRACT_INVALID', '要更新的画板对象不存在。', [targetId]);
      }
      const patch = operation.patch as Row;
      if (before.revision !== operation.expectedRevision) {
        fail('REVISION_CONFLICT', '画板对象已被其他编辑更新，请重新读取后再保存。', [targetId]);
      }
      const position = patch.position as {x?: unknown; y?: unknown} | undefined;
      const next: Row = {...before, ...patch,
        ...(position === undefined ? {} : {position: {x: Number(position.x), y: Number(position.y)}}),
        revision: Number.isSafeInteger(before.revision) ? Number(before.revision) + 1 : 1,
        updatedAt: at};
      if (operation.kind === 'board.shot.update' && patch.title !== undefined) next.title = String(patch.title);
      if (operation.kind === 'board.node.update' && patch.name !== undefined) {next.name = String(patch.name); next.label = String(patch.name);}
      directChanges.push({kind: shot ? 'shot' : 'node', before, after: next});
      continue;
    }
    if (operation.kind === 'board.restore') {
      const chain = deriveFilmChains(context.board).chains.find(item => item.filmId === context.rootNodeId)?.nodeIds ?? [];
      let tail = chain.at(-1) ?? context.rootNodeId;
      for (const item of operation.items) {
        const archived = context.archived.get(`${item.kind}:${item.id}`);
        if (!archived) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '要恢复的画板对象没有归档记录。', [item.id]);
        if (archived.type === 'subject_card') fail('SEQUENCE_EDIT_CONTRACT_INVALID',
          '主体卡由主体绑定恢复，不能走普通恢复。', [item.id], {reason: 'SUBJECT_CARD_RESTORE_REQUIRED'});
        restoredRows.set(item.id, archived);
        if (item.kind === 'shot') {
          // UI-B2 semantics: a restored shot re-enters at the active chain tail;
          // other node types return as detached rows.
          planIntents.push({side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: tail, toId: item.id}}});
          if (!allocation.edges.some(edge => edge.fromId === tail && edge.toId === item.id)) {
            if (!allocateNewIds) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '恢复接链所需的顺序边 ID 没有随信封分配。', [item.id]);
            allocation.edges.push({id: randomUUID(), fromId: tail, toId: item.id});
          }
          const selectedId = typeof archived.selectedVersionId === 'string' ? archived.selectedVersionId : null;
          const version = selectedId === null ? undefined : context.rows.versions.get(selectedId);
          const asset = version && typeof version.assetId === 'string' ? context.rows.assets.get(version.assetId) : undefined;
          // Source ranges are half-open frames into the exact asset duration:
          // 4.459 s supplies 133 frames, never 134. A restored shot's rounded
          // displayed duration (for example 4.46 s) must not invent one frame
          // beyond the source and fail the format-5 commit fence.
          const sourceFrames = Number.isFinite(asset?.duration) ? Math.max(1, Math.floor(Number(asset!.duration) * 30)) : null;
          const requestedFrames = Number.isFinite(archived.duration)
            ? Math.max(1, Math.round(Number(archived.duration) * 30)) : 120;
          createdMedia.push({nodeId: item.id, selectedVersion: version ? {id: String(version.id), sourceFrames} : null,
            durationFrames: sourceFrames === null ? requestedFrames : Math.min(requestedFrames, sourceFrames)});
          if (!allocation.clips.some(pair => pair.nodeId === item.id)) allocation.clips.push({nodeId: item.id, clipId: randomUUID()});
          tail = item.id;
        }
      }
      continue;
    }
    const viewport = operation.kind === 'board.paste' || operation.kind === 'board.duplicate'
      ? operation.viewport ?? {x: 100, y: 100, width: 0, height: 0} : null;
    if (operation.kind === 'board.paste' || operation.kind === 'board.duplicate') {
      interface CardSource {readonly kind: 'shot' | 'node'; readonly id: string; readonly fields: Row}
      const cards: CardSource[] = [];
      let links: readonly Row[] = [];
      if (operation.kind === 'board.paste') {
        const snapshot = clipboardOwner === undefined ? null : readCanvasClipboardSnapshot(
          store, clipboardOwner, {projectId: context.projectId, documentId: operation.documentId,
            snapshotId: operation.snapshotId});
        if (!snapshot) fail('CANVAS_CLIPBOARD_UNAVAILABLE', '只能粘贴在此画板复制且未过期的元素。', []);
        for (const card of snapshot.cards) cards.push({kind: card.kind, id: card.id, fields: card.fields as Row});
        links = (snapshot as {links?: readonly Row[]}).links ?? [];
      } else {
        for (const item of operation.items) {
          const fields = item.kind === 'shot' ? context.rows.shots.get(item.id) : context.rows.nodes.get(item.id);
          if (!fields) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '要复制的画板对象不存在。', [item.id]);
          cards.push({kind: item.kind, id: item.id, fields});
        }
      }
      // A copied subject card would create a second card for the same subject;
      // the board only permits one, so skip it (and its subject links).
      const skippedSubjects = cards.filter(card => card.kind === 'node' && card.fields.type === 'subject_card');
      const copyable = cards.filter(card => !(card.kind === 'node' && card.fields.type === 'subject_card'));
      if (skippedSubjects.length) warnings.push({code: 'SUBJECT_CARD_SKIPPED'});
      if (!copyable.length) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '没有可复制的画板元素。', [], {reason: 'SUBJECT_CARD_ONLY'});
      // New ids are allocated by the preview and travel in allocation.nodes; the
      // commit only uses those exact identities.
      const pairFor = (sourceId: string): string => {
        const existing = allocation.nodes.find(pair => pair.fromNodeId === sourceId);
        if (existing) return existing.nodeId;
        if (!allocateNewIds) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '复制/粘贴的新 ID 没有随信封分配。', [sourceId]);
        const nodeId = randomUUID();
        allocation.nodes.push({fromNodeId: sourceId, nodeId});
        return nodeId;
      };
      const mapped = new Map<string, string>();
      for (const card of copyable) mapped.set(card.id, pairFor(card.id));
      const points = copyable.map(card => rowPosition(card.fields));
      const anchor = {x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y))};
      const offset = {x: viewport!.x + 40 - anchor.x, y: viewport!.y + 40 - anchor.y};
      let order = [...context.rows.shots.values()].reduce((maximum, row) =>
        Math.max(maximum, Number.isSafeInteger(row.orderIndex) ? Number(row.orderIndex) : -1), -1);
      for (const card of copyable) {
        const point = rowPosition(card.fields);
        const id = mapped.get(card.id)!;
        const copy: Row = {...card.fields, id, projectId: context.projectId,
          position: {x: point.x + offset.x, y: point.y + offset.y}, revision: 1, createdAt: at, updatedAt: at};
        if (card.kind === 'shot') {
          order += 1;
          Object.assign(copy, {orderIndex: order, selectedVersionId: null, referenceAssetIds: []});
          delete copy.lastFrameAssetId;
          createdShots.set(String(copy.id), copy);
          createdChainNodes.push({id: String(copy.id), kind: 'shot'});
          createdMedia.push({nodeId: String(copy.id), selectedVersion: null, durationFrames: 120});
        } else {
          if (copy.type === 'previs') {
            copy.sceneRevision = 1;
            const scene = copy.scene as Row | undefined;
            if (scene !== null && typeof scene === 'object' && Array.isArray(scene.keyframes)) {
              copy.scene = {...scene, keyframes: (scene.keyframes as Row[]).map(frame => ({...frame, exports: []}))};
            }
          }
          createdNodes.set(String(copy.id), copy);
        }
      }
      // Internal material reference lines are copied with the same role, source
      // asset and order. Sequence links are not copied: the format-5 main chain
      // only accepts links maintained by sync-board, so a detached pasted chain
      // segment would be rejected by the graph fence. Subject links are skipped
      // because the subject card itself is skipped.
      let skippedSequenceLinks = 0;
      for (const link of links) {
        if (link.kind !== 'reference') {skippedSequenceLinks++; continue;}
        const from = mapped.get(String(link.source)), to = mapped.get(String(link.target));
        if (!from || !to) continue;
        if (link.role === 'subject_reference' || link.role === 'style_reference') continue;
        // Copied reference edges follow the same identity rule as copied nodes:
        // preview allocates the new edge id by its new endpoints into the
        // envelope, and commit only reuses that exact id.
        const pair = allocation.edges.find(edge => edge.fromId === from && edge.toId === to);
        let id: string;
        if (pair) id = pair.id;
        else if (allocateNewIds) {
          id = randomUUID();
          allocation.edges.push({id, fromId: from, toId: to});
        } else {
          fail('SEQUENCE_EDIT_CONTRACT_INVALID', '复制的引用线 ID 没有随信封分配。', [String(link.source)]);
        }
        const edge: Row = {id, projectId: context.projectId, kind: 'reference', role: link.role,
          source: from, target: to, createdAt: at,
          ...(typeof link.sourceAssetId === 'string' ? {sourceAssetId: link.sourceAssetId} : {}),
          ...(Number.isSafeInteger(link.orderIndex) ? {orderIndex: link.orderIndex} : {})};
        directChanges.push({kind: 'edge', before: edge, after: edge, newRecord: true});
      }
      if (skippedSequenceLinks) warnings.push({code: 'SEQUENCE_LINKS_NOT_COPIED'});
      continue;
    }
    fail('SEQUENCE_EDIT_CONTRACT_INVALID', '无法识别的画板动作。', []);
  }
  const restored = new Map<string, Row>([...restoredRows]);
  const restoredChain: ChainNode[] = [...restoredRows].map(([id, row]) => ({id,
    kind: context.archived.has(`shot:${id}`) ? 'shot' as const : format5ChainNodeKind(String(row.type))}));
  for (const id of referencedNodeIds({intents})) {
    const archived = context.archived.get(`shot:${id}`) ?? context.archived.get(`node:${id}`);
    if (!archived) continue;
    if (!restored.has(id)) {
      restored.set(id, archived);
      const kind = context.archived.has(`shot:${id}`) ? 'shot' as const : format5ChainNodeKind(String(archived.type));
      restoredChain.push({id, kind});
    }
    const restoredKind = context.archived.has(`shot:${id}`) ? 'shot' as const : format5ChainNodeKind(String(archived.type));
    if ((restoredKind === 'shot' || restoredKind === 'image' || restoredKind === 'video')
      && !context.media.some(item => item.nodeId === id) && !createdMedia.some(item => item.nodeId === id)) {
      createdMedia.push({nodeId: id, selectedVersion: null, durationFrames: 120});
    }
  }
  // Preview allocates identities for any new sequence edge and for a playable
  // node that enters the main track without a clip. The exact ids travel in the
  // envelope, so preview and commit plan one identical identity set.
  const boardNodes = new Map<string, ChainNode>([...context.board.nodes.map(node => [node.id, node] as const),
    ...[...restoredChain, ...createdChainNodes].map(node => [node.id, node] as const)]);
  let plannedEdges = [...context.board.edges];
  const ensureEdge = (fromId: string, toId: string): void => {
    if (plannedEdges.some(edge => edge.fromId === fromId && edge.toId === toId)) return;
    plannedEdges.push({fromId, toId});
    if (allocation.edges.some(edge => edge.fromId === fromId && edge.toId === toId)) return;
    allocation.edges.push({id: randomUUID(), fromId, toId});
  };
  for (const intent of intents) {
    const operation = intent.operation;
    if (operation.kind !== 'board') continue;
    const edit = operation.edit;
    if (edit.kind === 'connect') ensureEdge(edit.fromId, edit.toId);
    else if (edit.kind === 'disconnect') plannedEdges = plannedEdges.filter(edge => !(edge.fromId === edit.fromId && edge.toId === edit.toId));
    else if (edit.kind === 'delete') plannedEdges = plannedEdges.filter(edge => edge.fromId !== edit.nodeId && edge.toId !== edit.nodeId);
    else if (edit.kind === 'insert') {
      plannedEdges = plannedEdges.filter(edge => !(edge.fromId === edit.fromId && edge.toId === edit.toId)
        && edge.fromId !== edit.nodeId && edge.toId !== edit.nodeId);
      ensureEdge(edit.fromId, edit.nodeId);
      ensureEdge(edit.nodeId, edit.toId);
    }
  }
  // A reconnected segment brings its downstream chain back to the main track;
  // every playable node that lacks a clip identity needs one for the plan.
  const chain = deriveFilmChains({nodes: [...boardNodes.values()], edges: plannedEdges})
    .chains.find(item => item.filmId === context.rootNodeId)?.nodeIds ?? [];
  for (const nodeId of chain) {
    const kind = boardNodes.get(nodeId)?.kind;
    if (kind !== 'shot' && kind !== 'image' && kind !== 'video') continue;
    if (context.clips.some(clip => clip.nodeId === nodeId) || allocation.clips.some(clip => clip.nodeId === nodeId)) continue;
    allocation.clips.push({nodeId, clipId: randomUUID()});
  }
  return {restored, created: {shots: createdShots, nodes: createdNodes, media: createdMedia, chainNodes: [...restoredChain, ...createdChainNodes]},
    layoutMoves, planIntents, directChanges, deleted, warnings, allocation};
}

/** One read-only preview of board intents for `sequence.preview`. The shared
 * transaction later re-reads and re-plans the same envelope. */
export function previewSequenceBoardAction(store: ProjectStore, intents: readonly SequenceEditIntent[],
  allocationInput: SequenceEditAllocation, clipboardOwner?: object): {readonly ok: true; readonly allocation: SequenceEditAllocation;
    readonly impact: {readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[];
      readonly mainTrackClipIds: readonly string[]; readonly otherTrackItemIds: readonly string[];
      readonly subtitleCueIds: readonly string[]}; readonly warnings: readonly ChainSyncWarning[]}
  | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  const context = readSequenceEditContext(store);
  let preparation: BoardActionPreparation;
  try {preparation = boardIntentPreparation(context, store, intents, allocationInput, clipboardOwner);}
  catch (error) {
    if (error instanceof AppError) return {ok: false, code: error.code, ids: ((error.details as Row | undefined)?.ids as string[] | undefined) ?? []};
    throw error;
  }
  const initialBoard: ChainBoard = {nodes: [...context.board.nodes, ...preparation.created.chainNodes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0), edges: context.board.edges};
  const initialMedia = [...context.media, ...preparation.created.media];
  let state: ChainSyncState = {board: initialBoard, filmId: context.rootNodeId, media: initialMedia,
    clips: context.clips, anchored: context.anchored};
  let plan: SuccessfulPlan | undefined;
  const warnings: ChainSyncWarning[] = [];
  for (const intent of preparation.planIntents) {
    if (isBoardIntentOperation(intent.operation)) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: []};
    const planned = planSequenceEditIntents(state, [intent], preparation.allocation);
    if (!planned.ok) return {ok: false, code: planned.code, ids: planned.ids};
    state = planned.state;
    plan = planned.plan;
    warnings.push(...plan.warnings);
  }
  const boardDeltas = planBoardDeltas(context, {intents, allocation: preparation.allocation} as SequenceEditEnvelope,
    state.board, state.media, preparation.restored, preparation.deleted, new Map(), preparation.created,
    preparation.layoutMoves, preparation.directChanges);
  // Project the same main track the commit will write so the preview impact
  // lists the cues (and the user sees dialogue/anchor conflicts before confirm).
  const projectedShotRows = new Map<string, Row>();
  for (const [id, row] of preparation.created.shots) projectedShotRows.set(id, row);
  for (const [id] of preparation.restored) {
    if (!context.archived.has(`shot:${id}`)) continue;
    projectedShotRows.set(id, preparation.restored.get(id)!);
  }
  let projectedCueIds: string[] = [];
  if (plan) {
    const projection = previewMainTrackProjection(store, plan, projectedShotRows);
    if (projection.ok === false) return {ok: false, code: projection.code, ids: projection.ids};
    projectedCueIds = [...new Set([...projection.projection.changedCueIds, ...projection.projection.removedCueIds])].sort();
  }  const nodeIds = new Set<string>();
  for (const entity of [...boardDeltas.after.writes, ...boardDeltas.after.removals]) if (entity.kind !== 'edge') nodeIds.add(entity.id);
  const edgeIds = new Set<string>();
  for (const entity of [...boardDeltas.after.writes, ...boardDeltas.after.removals]) if (entity.kind === 'edge') edgeIds.add(entity.id);
  const mainTrackClipIds = new Set<string>();
  for (const item of preparation.allocation.clips) mainTrackClipIds.add(item.clipId);
  const otherTrackItemIds = new Set<string>();
  if (plan) {
    const delta = plan.changes.clips;
    for (const change of delta) if (change.after) mainTrackClipIds.add(change.after.id);
    for (const change of plan.changes.anchored) if (change.after) otherTrackItemIds.add(change.after.id);
  }
  return {ok: true, allocation: preparation.allocation, warnings: [...preparation.warnings, ...warnings] as unknown as readonly ChainSyncWarning[],
    impact: {nodeIds: [...nodeIds], edgeIds: [...edgeIds], mainTrackClipIds: [...mainTrackClipIds],
      otherTrackItemIds: [...otherTrackItemIds], subtitleCueIds: projectedCueIds}};
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
  const base = {...before, id: newNodeId, projectId: context.projectId, createdAt: now(), updatedAt: now()};
  // Copying a shot generates fresh dialogue line ids (plan §2.4); cue ids are
  // derived from them so the copy never collides with the source lines.
  const after = sourceTable === 'shots' ? copyFormat5ShotDialogue(base, newNodeId) : base;
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
  copied: ReadonlyMap<string, CopyNode>, created: BoardCreationRows = {shots: new Map(), nodes: new Map(), media: [], chainNodes: []},
  layoutMoves: readonly BoardLayoutMove[] = [],
  directChanges: readonly {readonly kind: 'shot' | 'node' | 'edge'; readonly before: Row;
    readonly after: Row; readonly newRecord?: boolean}[] = []): BoardDeltas {
  const at = now();
  const archiveBatchId = randomUUID();
  const beforeRows = new Map([...context.rows.shots, ...context.rows.nodes, ...context.rows.edges]);
  const afterRows = new Map(beforeRows);
  for (const row of [...created.shots.values(), ...created.nodes.values()]) afterRows.set(String(row.id), row);
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
  for (const item of directChanges) {
    change.set(`${item.kind}:${String(item.after.id)}`,
      {kind: item.kind, before: item.before, after: item.after, ...(item.newRecord ? {newRecord: true} as Row : {})});
    afterRows.set(String(item.after.id), item.after);
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
  for (const row of [...created.shots.values(), ...created.nodes.values()]) {
    const id = String(row.id);
    const kind: SequenceEditBoardEntity['kind'] = created.shots.has(id) ? 'shot' : 'node';
    change.set(`${kind}:${id}`, {kind, before: row, after: row, ...{newRecord: true} as Row});
  }
  for (const move of layoutMoves) {
    const row = afterRows.get(move.nodeId);
    if (!row) continue;
    const current = row.position as Row | undefined;
    const same = current !== null && typeof current === 'object'
      && Number(current.x) === move.position.x && Number(current.y) === move.position.y;
    if (same) continue;
    const kind: SequenceEditBoardEntity['kind'] = context.rows.shots.has(move.nodeId) ? 'shot' : 'node';
    const next = {...row, position: {x: move.position.x, y: move.position.y},
      ...(typeof row.updatedAt === 'string' ? {updatedAt: at} : {})};
    addChange(kind, move.nodeId, row, next);
    afterRows.set(move.nodeId, next);
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

function boardEntityRank(kind: SequenceEditBoardEntity['kind'], direction: 'write' | 'remove'): number {
  // Adoption rows reference a shot; edges reference nodes. Delete children before
  // their owners and insert owners before children on every forward/undo apply.
  if (kind === 'adoption') return direction === 'remove' ? 0 : 4;
  if (kind === 'edge') return direction === 'remove' ? 1 : 3;
  if (kind === 'shot') return direction === 'remove' ? 2 : 2;
  if (kind === 'node') return direction === 'remove' ? 3 : 1;
  return direction === 'remove' ? 0 : 5;
}
function applyBoardDelta(store: ProjectStore, delta: SequenceEditBoardDelta, mode: 'forward' | 'restore'): void {
  let subjectTouched = false;
  for (const entity of [...delta.removals].sort((left, right) => boardEntityRank(left.kind, 'remove') - boardEntityRank(right.kind, 'remove'))) {
    if (entity.kind === 'subject_binding') {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '主体绑定是墓碑，不能删除。', [entity.id]);
    }
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      const removed = store.db.prepare('DELETE FROM project.shot_version_adoptions WHERE projectId=? AND shotId=? AND versionId=?')
        .run(store.projectId, String(data.shotId), String(data.versionId));
      if (mode === 'restore' && Number(removed.changes) !== 1) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能应用。', [entity.id]);
      continue;
    }
    const table = tableOf(entity.kind);
    const removed = store.db.prepare(`DELETE FROM project.${table} WHERE id=? AND projectId=?`).run(entity.id, store.projectId);
    if (mode === 'restore' && Number(removed.changes) !== 1) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能应用。', [entity.id]);
  }
  for (const entity of [...delta.writes].sort((left, right) => boardEntityRank(left.kind, 'write') - boardEntityRank(right.kind, 'write'))) {
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      store.db.prepare('INSERT OR IGNORE INTO project.shot_version_adoptions(projectId,shotId,versionId,createdAt) VALUES(?,?,?,?)')
        .run(store.projectId, String(data.shotId), String(data.versionId), String(data.createdAt ?? now()));
      continue;
    }
    if (entity.kind === 'subject_binding') {
      applySubjectBindingWrite(store, entity.data as Row);
      subjectTouched = true;
      continue;
    }
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
  if (subjectTouched) bumpFormat5ContentStampInside(store.db, 'project');
}

function boardDeltaMatches(store: ProjectStore, delta: SequenceEditBoardDelta): boolean {
  for (const entity of delta.writes) {
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      const current = store.db.prepare('SELECT 1 AS found FROM project.shot_version_adoptions WHERE projectId=? AND shotId=? AND versionId=?')
        .get(store.projectId, String(data.shotId), String(data.versionId));
      if (!current) return false;
      continue;
    }
    if (entity.kind === 'subject_binding') {
      const data = entity.data as Row;
      const current = store.db.prepare(`SELECT bindingMode,subjectVersionId,shotId,subjectId,role
        FROM project.subject_bindings WHERE id=? AND projectId=?`).get(entity.id, store.projectId) as Row | undefined;
      if (!current) return false;
      if (current.bindingMode !== data.bindingMode || (current.subjectVersionId ?? null) !== (data.subjectVersionId ?? null)
        || current.shotId !== data.shotId || current.subjectId !== data.subjectId || current.role !== data.role) return false;
      continue;
    }
    const current = store.db.prepare(`SELECT data FROM project.${tableOf(entity.kind)} WHERE id=? AND projectId=?`)
      .get(entity.id, store.projectId) as Row | undefined;
    if (!current || typeof current.data !== 'string') return false;
    try { if (stable(JSON.parse(current.data)) !== stable(cleanRow(entity.data))) return false; } catch { return false; }
  }
  for (const entity of delta.removals) {
    if (entity.kind === 'subject_binding') return false;
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      if (store.db.prepare('SELECT 1 AS found FROM project.shot_version_adoptions WHERE projectId=? AND shotId=? AND versionId=?')
        .get(store.projectId, String(data.shotId), String(data.versionId))) return false;
      continue;
    }
    if (store.db.prepare(`SELECT 1 FROM project.${tableOf(entity.kind)} WHERE id=? AND projectId=?`)
      .get(entity.id, store.projectId) !== undefined) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Timeline patch pair
// ---------------------------------------------------------------------------

function emptyTimelineDelta(baseline: SequenceEditBaselineChange): SequenceEditTimelineDelta {
  return {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline, subtitles: {kind: 'unchanged'}};
}
/** Reverse three-state profile change for the before half of a patch. */
function beforeSubtitleChange(before: Format5Timeline,
  after: SequenceEditTimelineDelta['subtitles']): SequenceEditTimelineDelta['subtitles'] {
  const change = after ?? {kind: 'unchanged'};
  if (change.kind === 'set') return before.subtitles ? {kind: 'unchanged'} : {kind: 'absent'};
  if (change.kind === 'absent') return before.subtitles ? {
    kind: 'set',
    value: {profileId: before.subtitles.profileId,
      ...(before.subtitles.basisPresetId === undefined ? {} : {basisPresetId: before.subtitles.basisPresetId})},
  } : {kind: 'unchanged'};
  return {kind: 'unchanged'};
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
      baseline: beforeBaselineValue(beforeBaseline, baseline), subtitles: {kind: 'unchanged'}},
    after: {clips: afterClips, cues: afterCues, removedClipIds: afterRemovedClips, removedCueIds: afterRemovedCues,
      baseline, subtitles: {kind: 'unchanged'}},
  };
}

function timelinePatchFromCommit(before: Format5Timeline, delta: SequenceEditTimelineDelta,
  beforeBaseline: Format5SyncBaseline): {before: SequenceEditTimelineDelta; after: SequenceEditTimelineDelta} {
  const oldClips = new Map(before.clips.map(clip => [clip.id, clip] as const));
  const oldCues = new Map((before.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const touchedClips = new Set([...delta.clips.map(clip => clip.id), ...delta.removedClipIds]);
  const touchedCues = new Set([...delta.cues.map(cue => cue.id), ...delta.removedCueIds]);
  const afterClipIds = new Set(delta.clips.map(clip => clip.id));
  const afterCueIds = new Set(delta.cues.map(cue => cue.id));
  return {
    before: {
      clips: [...touchedClips].filter(id => oldClips.has(id)).map(id => oldClips.get(id)!),
      cues: [...touchedCues].filter(id => oldCues.has(id)).map(id => oldCues.get(id)!),
      removedClipIds: [...afterClipIds].filter(id => !oldClips.has(id)),
      removedCueIds: [...afterCueIds].filter(id => !oldCues.has(id)),
      baseline: beforeBaselineValue(beforeBaseline, delta.baseline),
      subtitles: beforeSubtitleChange(before, delta.subtitles),
    },
    after: delta,
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
// Receipts and history projection
// ---------------------------------------------------------------------------

function historyViewOf(store: ProjectStore): SequenceEditHistoryView {
  return prepareSequenceEditHistory(store).view;
}

function assertEnvelope(store: ProjectStore, context: EditContext, envelope: SequenceEditEnvelope,
  state: SequenceEditHistoryState): void {
  if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
  if (envelope.filmId !== context.rootNodeId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '成片根与时间线不一致。', [envelope.filmId, context.rootNodeId]);
  if (envelope.subjectIntent) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '主体绑定动作由 SB 卡接线后处理。', [], {reason: 'SUBJECT_SEAM'});
  if (!isSequenceEditIntentSequence(envelope.intents)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '动作组合无效。');
  for (const intent of envelope.intents) validateOperation(intent);
  const stamp = contentStamp(store);
  const conflicts: string[] = [];
  if (envelope.baseline.contentRevision !== stamp.contentSequence) conflicts.push('content');
  if (envelope.baseline.timelineRevision !== context.timeline.revision) conflicts.push('timeline');
  if (envelope.baseline.syncRevision !== context.syncRevision) conflicts.push('sync');
  if (conflicts.length) fail('SEQUENCE_EDIT_REVISION_CONFLICT', '项目的修订已经变化，请重新读取后再试。', [], {revision: conflicts});
  if (envelope.baseline.historyPosition !== state.position || envelope.baseline.historyRevision !== state.revision) {
    fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '撤销历史的位置已经变化，请重新读取。', [], {state});
  }
  for (const target of envelope.baseline.targets) {
    if (target.kind === 'clip' || target.kind === 'cue') continue;
    const revision = readMioTargetRevision(store.db, store.projectId, target.kind, target.id);
    if (revision !== target.revision) fail('SEQUENCE_EDIT_REVISION_CONFLICT', '受影响的画板对象已经变化。', [target.id], {target});
  }
}

function affectedFromDeltas(context: EditContext, deltas: BoardDeltas, timeline: SequenceEditTimelineDelta): SequenceEditAffectedCounts {
  const mainIds = new Set(context.timeline.clips.filter(clip => clip.trackId === context.timeline.mainTrack.trackId).map(clip => clip.id));
  const countKind = (kind: SequenceEditBoardEntity['kind']): number =>
    deltas.after.writes.filter(entity => entity.kind === kind).length + deltas.after.removals.filter(entity => entity.kind === kind).length;
  const mainWrites = timeline.clips.filter(clip => clip.trackId === context.timeline.mainTrack.trackId).length;
  const removedMain = timeline.removedClipIds.filter(id => mainIds.has(id)).length;
  return {
    nodes: countKind('node') + countKind('shot'), edges: countKind('edge'),
    mainTrackClips: mainWrites + removedMain,
    otherTrackItems: timeline.clips.length - mainWrites + timeline.removedClipIds.length - removedMain,
    subtitleCues: timeline.cues.length + timeline.removedCueIds.length,
  };
}

function timelineDeltaMatches(store: ProjectStore, delta: SequenceEditTimelineDelta): boolean {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) return false;
  const clips = new Map(timeline.clips.map(clip => [clip.id, clip] as const));
  const cues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  for (const clip of delta.clips) if (!sameRow(clips.get(clip.id), clip)) return false;
  for (const cue of delta.cues) if (!sameRow(cues.get(cue.id), cue)) return false;
  for (const id of delta.removedClipIds) if (clips.has(id)) return false;
  for (const id of delta.removedCueIds) if (cues.has(id)) return false;
  if (delta.tracks !== undefined && stable(timeline.tracks) !== stable(delta.tracks)) return false;
  if (delta.baseline.kind === 'unchanged') return true;
  const context = readSequenceEditContext(store);
  if (delta.baseline.kind === 'set') return sameRow(context.baseline, delta.baseline.value);
  return false;
}

// ---------------------------------------------------------------------------
// Apply one action
// ---------------------------------------------------------------------------

type ApplyOutcome = {readonly receipt: SequenceEditReceipt; readonly failure?: {readonly code: string; readonly ids: readonly string[]}};

export function applySequenceEdit(store: ProjectStore, envelope: SequenceEditEnvelope,
  authorize: () => void = () => {}, clipboardOwner?: object): SequenceEditReceipt {
  assertFormat5(store);
  const inputDigest = sequenceEditInputDigest(envelope);
  const outcome = store.tx((): ApplyOutcome => {
    authorize();
    // An exact retry returns the immutable receipt before observing any newer
    // revision, so a replay never has to match the current baseline.
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    if (replay) {
      if (replay.inputDigest !== inputDigest) {
        fail('SEQUENCE_EDIT_REQUEST_REUSED', '这个请求 ID 已用于不同的画板操作。', [], {requestId: envelope.requestId});
      }
      return {receipt: replay.receipt};
    }
    const syncContext = readSequenceSyncContext(store);
    const context = editContextOf(syncContext);
    const prepared = prepareSequenceEditHistory(store, envelope.epoch);
    assertEnvelope(store, context, envelope, prepared.state);
    const operation = sequenceEditEnvelopeOperationName(envelope);
    const requestDigest = inputDigest;
    const allocatedCopyIds = new Set(envelope.allocation.nodes.map(item => item.nodeId));
    // UI-B2 board-only intents (root create / chain-tail shot append / layout
    // move) are normalized into graph rows and the same SA plan pipeline before
    // the shared board delta is written.
    const preparation = boardIntentPreparation(context, store, envelope.intents, envelope.allocation, clipboardOwner, false);
    const planEnvelope: SequenceEditEnvelope = {...envelope, allocation: preparation.allocation};
    const restored = new Map(preparation.restored);
    const creation = preparation.created;
    const layoutMoves = preparation.layoutMoves;
    const planIntents = preparation.planIntents;
    let state: ChainSyncState;
    let stateBeforeFinal: ChainSyncState;
    let timelineChanged = false;
    let plan: SuccessfulPlan | undefined;
    {
      const initialBoard: ChainBoard = {nodes: [...context.board.nodes, ...creation.chainNodes]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0), edges: context.board.edges};
      state = {board: initialBoard, filmId: context.rootNodeId, media: [...context.media, ...creation.media],
        clips: context.clips, anchored: context.anchored};
      stateBeforeFinal = state;
    }
    for (const intent of planIntents) {
      const planned = planSequenceEditIntents(state, [intent], planEnvelope.allocation);
      if (!planned.ok) return {receipt: writeSequenceEditFailure(store, envelope, planned.code as never),
        failure: {code: planned.code, ids: planned.ids}};
      stateBeforeFinal = state;
      state = planned.state;
      plan = planned.plan;
      if (planTimelineChanged(planned.plan)) timelineChanged = true;
    }
    const copiedNodes = new Map<string, CopyNode>();
    for (const item of envelope.allocation.nodes) {
      if (!isUuid(item.fromNodeId) || !isUuid(item.nodeId)) {
        return {receipt: writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_CONTRACT_INVALID'),
          failure: {code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: [item.nodeId]}};
      }
      if (!state.board.nodes.some(node => node.id === item.nodeId)) continue;
      const copy = copyNodeRow(context, item.fromNodeId, item.nodeId);
      if (!copy) return {receipt: writeSequenceEditFailure(store, envelope, 'COPY_NODE_REQUIRED'),
        failure: {code: 'COPY_NODE_REQUIRED', ids: [item.fromNodeId]}};
      copiedNodes.set(item.nodeId, copy);
      if (allocatedCopyIds.has(item.nodeId) && !context.board.nodes.some(node => node.id === item.fromNodeId)) {
        return {receipt: writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_CONTRACT_INVALID'),
          failure: {code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: [item.fromNodeId]}};
      }
    }
    const deleted = new Set(preparation.deleted);
    for (const intent of envelope.intents) {
      if (intent.operation.kind === 'board' && intent.operation.edit.kind === 'delete') deleted.add(intent.operation.edit.nodeId);
    }
    const boardDeltas = planBoardDeltas(context, planEnvelope, state.board, state.media, restored, deleted, copiedNodes,
      creation, layoutMoves, preparation.directChanges);
    const changed = boardDeltas.nodes + boardDeltas.edges > 0 || timelineChanged || restored.size > 0 || copiedNodes.size > 0
      || creation.shots.size > 0 || creation.nodes.size > 0 || layoutMoves.length > 0;
    if (!changed) {
      // A legal request whose live projection already matches the intent only
      // stores a not_applied receipt; no history row or cursor revision moves.
      return {receipt: writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_NOOP')};
    }
    let syncCommit: SequenceEditTimelineCommit | undefined;
    let appliedTimelineRevision: number | undefined;
    let appliedSyncRevision: number | undefined;
    if (timelineChanged) {
      const extraShotRows = new Map<string, Row>([...creation.shots]);
      for (const [id, copy] of copiedNodes) if (copy.sourceTable === 'shots') extraShotRows.set(id, copy.after);
      for (const [id, row] of restored) if (context.archived.has(`shot:${id}`)) extraShotRows.set(id, row);
      const projectionShots = extraShotRows.size || creation.nodes.size
        ? new Map([...syncContext.shots, ...extraShotRows]) : syncContext.shots;
      const projectionContext = projectionShots === syncContext.shots ? syncContext : {...syncContext, shots: projectionShots};
      const result = createMainTrackProjectionPort(store, () => projectionContext).projectMainTrack({envelope: planEnvelope, state: stateBeforeFinal, plan: plan!});
      if (!result.ok) {
        return {receipt: writeSequenceEditFailure(store, envelope, result.code), failure: {code: result.code, ids: result.ids}};
      }
      syncCommit = result;
      // The projection port plans the timeline half; the coordinator applies it
      // in the same transaction (it never opens its own transaction).
            appliedTimelineRevision = applySequenceEditTimelineDelta(store, result.delta, syncContext).timelineRevision;
                  appliedSyncRevision = applySequenceEditBaselineDelta(store, result.delta.baseline, syncContext).syncRevision;
          }
        applyBoardDelta(store, boardDeltas.after, 'forward');
        const baselineChange = syncCommit?.delta.baseline ?? {kind: 'unchanged' as const};
    const timelinePatch = syncCommit
      ? timelinePatchFromCommit(context.timeline, syncCommit.delta, context.baseline)
      : buildTimelinePatch(context.timeline, readFormat5TimelineRecord(store.db, 'project'), baselineChange, context.baseline);
    const patch: SequenceEditPatch = {
      version: 1,
      before: {board: boardDeltas.before, timeline: timelinePatch.before},
      after: {board: boardDeltas.after, timeline: timelinePatch.after},
    };
    const timelineRevision = appliedTimelineRevision ?? context.timeline.revision;
    const syncRevision = appliedSyncRevision ?? context.syncRevision;
    const draft: SequenceEditReceiptDraft = {
      version: 1, requestId: envelope.requestId, inputDigest: requestDigest, projectId: envelope.projectId,
      actionId: envelope.actionId, operation, originSide: envelope.originSide, status: 'applied',
      ...(syncCommit?.warnings.length ? {warnings: syncCommit.warnings} : {}),
      affected: affectedFromDeltas(context, boardDeltas, timelinePatch.after),
      contentRevision: contentStamp(store).contentSequence, timelineRevision, syncRevision,
    };
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt: draft});
    return {receipt: stored};
  });
  if (outcome.failure) fail(outcome.failure.code, '画板顺序链不能按这条命令修改。', outcome.failure.ids, {reason: outcome.failure.code});
  return outcome.receipt;
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export interface SequenceEditHistoryRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly expected: {readonly position: number; readonly revision: number};
  /** Selects the user or Mio stack; defaults to the user stack. */
  readonly origin?: 'user' | 'mio';
}

function entryAffected(entry: SequenceEditHistoryEntry): number {
  const board = entry.afterPatch.board;
  const timeline = entry.afterPatch.timeline;
  return board.writes.length + board.removals.length + timeline.clips.length + timeline.cues.length
    + timeline.removedClipIds.length + timeline.removedCueIds.length;
}

export function applySequenceEditHistory(store: ProjectStore, direction: 'undo' | 'redo',
  request: SequenceEditHistoryRequest, authorize: () => void = () => {}): SequenceEditReceipt {
  assertFormat5(store);
  const command: SequenceEditHistoryCommand = {...request, direction};
  const inputDigest = historyCommandDigest(command);
  return store.tx(() => {
    authorize();
    const replay = findSequenceEditReceipt(store, request.requestId);
    if (replay) {
      if (replay.inputDigest !== inputDigest) {
        fail('SEQUENCE_EDIT_REQUEST_REUSED', '这个请求 ID 已用于不同的画板操作。', [], {requestId: request.requestId});
      }
      return replay.receipt;
    }
    const prepared = prepareSequenceEditHistory(store);
    if (request.expected.position !== prepared.state.position || request.expected.revision !== prepared.state.revision) {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '撤销历史的位置已经变化，请重新读取。', [], {state: prepared.state});
    }
    const floor = sequenceEditHistoryFloor(store);
    if (direction === 'undo' && (floor === null || prepared.state.position < floor)) {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '已经到最早可撤销的一步。', [], {reason: 'EARLIEST', floor});
    }
    const targetPosition = direction === 'undo' ? prepared.state.position : prepared.state.position + 1;
    const entry = readSequenceEditHistoryEntry(store, request.actionId);
    if (!entry || entry.position !== targetPosition) fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步已经不能撤回。', [request.actionId]);
    const requestedOrigin = request.origin ?? 'user';
    if (entry.origin !== requestedOrigin) {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步属于另一条撤销栈，不能在这里撤回。', [request.actionId],
        {reason: 'ORIGIN', origin: entry.origin, requestedOrigin});
    }
    const source = direction === 'undo' ? entry.afterPatch : entry.beforePatch;
    const apply = direction === 'undo' ? entry.beforePatch : entry.afterPatch;
    if (!boardDeltaMatches(store, source.board) || !timelineDeltaMatches(store, source.timeline)) {
      fail('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步之后画板或主轨已经变化，不能直接撤回。', [request.actionId]);
    }
    applyBoardDelta(store, apply.board, 'restore');
    const timelineResult = applySequenceEditTimelineDelta(store, apply.timeline);
    const baselineResult = applySequenceEditBaselineDelta(store, apply.timeline.baseline);
    const draft: SequenceEditReceiptDraft = {
      version: 1, requestId: request.requestId, inputDigest, projectId: store.projectId,
      actionId: request.actionId, operation: `${direction}:${entry.operation}`,
      originSide: entry.operation.startsWith('timeline.') ? 'timeline' : 'board', status: 'applied',
      affected: {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0},
      contentRevision: contentStamp(store).contentSequence,
      timelineRevision: timelineResult.timelineRevision, syncRevision: baselineResult.syncRevision,
    };
    return moveSequenceEditHistoryCursor(store, command, draft);
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
  readonly undoBlockedBy: 'user' | 'mio' | null;
  readonly redoBlockedBy: 'user' | 'mio' | null;
  readonly undoAvailable: boolean;
  readonly redoAvailable: boolean;
  readonly earliestPosition: number | null;
  readonly atEarliest: boolean;
}
export function readSequenceEditHistory(store: ProjectStore, requestedOrigin: 'user' | 'mio' = 'user'): SequenceEditHistoryProjection {
  assertFormat5(store);
  const prepared = prepareSequenceEditHistory(store);
  const floor = sequenceEditHistoryFloor(store);
  const current = prepared.state.position;
  const globalUndo = prepared.view.undo ? readSequenceEditHistoryEntry(store, prepared.view.undo.actionId) : null;
  const globalRedo = prepared.view.redo ? readSequenceEditHistoryEntry(store, prepared.view.redo.actionId) : null;
  const nearest = (direction: 'undo' | 'redo'): SequenceEditHistoryEntry | null => {
    const row = (direction === 'undo'
      ? store.db.prepare(`SELECT actionId FROM main.editor_history_entries WHERE projectId=? AND origin=? AND position<=? ORDER BY position DESC LIMIT 1`).get(store.projectId, requestedOrigin, current)
      : store.db.prepare(`SELECT actionId FROM main.editor_history_entries WHERE projectId=? AND origin=? AND position>? ORDER BY position ASC LIMIT 1`).get(store.projectId, requestedOrigin, current)) as {actionId?: unknown} | undefined;
    return typeof row?.actionId === 'string' ? readSequenceEditHistoryEntry(store, row.actionId) : null;
  };
  const undoEntry = nearest('undo'), redoEntry = nearest('redo');
  const undoBlockedBy = undoEntry && undoEntry.position !== current ? (globalUndo?.origin ?? null) : null;
  const redoBlockedBy = redoEntry && redoEntry.position !== current + 1 ? (globalRedo?.origin ?? null) : null;
  const stale = (entry: SequenceEditHistoryEntry | null, patch: SequenceEditStateDelta | null): boolean =>
    !!entry && !!patch && (!boardDeltaMatches(store, patch.board) || !timelineDeltaMatches(store, patch.timeline));
  const undoConflict = !!undoBlockedBy || stale(undoEntry, undoEntry?.afterPatch ?? null);
  const redoConflict = !!redoBlockedBy || stale(redoEntry, redoEntry?.beforePatch ?? null);
  const action = (entry: SequenceEditHistoryEntry | null) => entry
    ? {actionId: entry.actionId, operation: entry.operation, affected: entryAffected(entry),
      ...(entry.origin === 'mio' ? {origin: 'mio' as const} : {})} : null;
  const atEarliest = floor === null || prepared.state.position < floor;
  return {...prepared.view, projectId: store.projectId, undo: action(undoEntry), redo: action(redoEntry),
    conflict: undoConflict || redoConflict, undoConflict, redoConflict, undoBlockedBy, redoBlockedBy,
    undoAvailable: !!undoEntry && !undoConflict, redoAvailable: !!redoEntry && !redoConflict,
    earliestPosition: floor, atEarliest};
}

// ---------------------------------------------------------------------------
// Transaction-internal board seam (TS → CS)
// ---------------------------------------------------------------------------

/** CS half of one track-origin action. TS calls this inside its transaction
 * after planning; CS writes the rewired board edges/nodes and returns the
 * board patch. The content stamp advances from the row triggers. */
export function createSequenceBoardPort(store: ProjectStore): BoardSeamProjectionPort {
  return {
    projectBoardSeam(request: SequenceEditTransactionRequest): SequenceEditBoardCommitResult {
      if (!isFormat5Project(store)) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于项目格式 5。');
      const context = readSequenceEditContext(store);
      const envelope = request.envelope;
      if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
      const finalBoard = request.plan.after.board;
      const finalMedia = request.plan.after.media;
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
export function createSequenceEditing(store: ProjectStore): SequenceEditingService {
  return {
    call(operation: SequenceEditingOperation, input: unknown, authorize: () => void = () => {}): unknown {
      assertFormat5(store);
      const parsed = sequenceEditingSchemas[operation].safeParse(input);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', '画板顺序链操作参数无效。', 400, {issues: parsed.error.issues});
      if (operation === 'sequence.history.get') {
        const {projectId} = parsed.data as {projectId: string};
        if (projectId !== store.projectId) throw new AppError('VALIDATION_ERROR', '项目范围无效。', 400);
        return sequenceEditingResponses[operation].parse(readSequenceEditHistory(store, (parsed.data as {origin?: 'user' | 'mio'}).origin ?? 'user'));
      }
      if (operation === 'sequence.edit') {
        const envelope = parsed.data as unknown as SequenceEditEnvelope;
        if (envelope.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
        return sequenceEditingResponses[operation].parse(applySequenceEdit(store, envelope, authorize));
      }
      const history = parsed.data as {projectId?: string; requestId: string; actionId: string; expected: {position: number; revision: number}; origin?: 'user' | 'mio'};
      if (history.projectId !== undefined && history.projectId !== store.projectId) fail('SEQUENCE_EDIT_CONTRACT_INVALID', '项目范围无效。');
      return sequenceEditingResponses[operation].parse(applySequenceEditHistory(store,
        operation === 'sequence.undo' ? 'undo' : 'redo',
        {projectId: store.projectId, requestId: history.requestId, actionId: history.actionId, expected: history.expected,
          ...(history.origin ? {origin: history.origin} : {})}, authorize));
    },
  };
}
export {isSequenceEditingOperation, isSequenceEditingWrite};
