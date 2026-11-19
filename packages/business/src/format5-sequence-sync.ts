/** Format-5 timeline ⇄ sequence-root synchronization (TSa), aligned with the
 * shared CS/TS action contract (`sequence-edit.ts`).
 *
 * Entry points:
 * - `readSequenceSyncProjection` / `previewSequenceSync` — read-only projection
 *   and the contract envelope a card/UI sends to the shared transaction.
 * - `runSequenceSync` — one `ProjectStore.tx`: replay receipt, revision checks,
 *   SA planning, main-track/timeline writes, three-state baseline, one history
 *   action through `format5-editor-history.ts`, immutable receipt.
 * - `moveSequenceSyncHistory` — undo/redo one existing action with the same
 *   shared patch/history/receipt module.
 * - `createMainTrackProjectionPort` — the CS transaction-internal seam that maps
 *   the same plan onto the timeline half only (no history, no stamp).
 *
 * Scope: association projection and per-root planning, version follow/lock,
 * placeholder handling, baseline, receipts and one-step undo/redo. Anchors,
 * split/move/delete, copy-confirmation and export admission are TSb.
 */
import {randomUUID} from 'node:crypto';
import {AppError, sourceFrameCount} from '@mioon/contracts';
import type {
  SequenceEditAffectedCounts, SequenceEditBaselineChange, SequenceEditBoardDelta, SequenceEditBoardEntity,
  SequenceEditCommitResult, SequenceEditEnvelope, SequenceEditErrorCode, SequenceEditHistoryAction,
  SequenceEditHistoryCommand, SequenceEditHistoryView, SequenceEditImpact, SequenceEditPatch, SequenceEditPlan,
  SequenceEditReceipt, SequenceEditStateDelta, SequenceEditTimelineCommit, SequenceEditTimelineDelta,
  SequenceEditTransactionFailure, MainTrackProjectionPort,
} from '@mioon/contracts/sequence-edit';
import {applySequenceEditBaselineChange, isSequenceEditEnvelope, isSequenceEditErrorCode, sequenceEditEnvelopeOperationName} from '@mioon/contracts/sequence-edit';
import {planSubjectBindingAction, readSubjectBinding} from './format5-subject-binding.ts';
import type {SequenceSyncCommand} from '@mioon/contracts/sequence-sync';
import {sequenceSyncIntent} from '@mioon/contracts/sequence-sync';
import {planChainSync} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncOperation, ChainSyncPlan, ChainSyncWarning} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncVersion} from '../../contracts/src/chain-main-track.ts';
import type {ChainBoard, ChainNode, SequenceEdge} from '../../contracts/src/board-sequence.ts';
import type {TrackAnchoredItem} from '../../contracts/src/chain-sync-analysis.ts';
import {format5SyncBaselineSchema, format5TimelineHeader} from '../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {format5AnchoredItem, format5ChainNodeKind, format5MainTrackClips} from './project-file/format5-sequence-mapping.ts';
import {
  applyFormat5TimelineEntityUpdateInside, assembleFormat5Timeline, bumpFormat5ContentStampInside,
  planFormat5TimelineEntityUpdate, readFormat5TimelineState,
} from './project-file/format5-timeline.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';
import {
  findSequenceEditReceipt, historyCommandDigest, moveSequenceEditHistoryCursor, patchFromEntry, prepareSequenceEditHistory,
  readSequenceEditHistoryEntry, sequenceEditInputDigest, writeSequenceEditAction, writeSequenceEditFailure,
} from './format5-editor-history.ts';

type Row = Record<string, any>;
type Json = unknown;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
const format5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === 5;
const failure = (code: SequenceEditErrorCode, ids: readonly string[] = []): SequenceEditTransactionFailure => ({ok: false, code, ids});
const emptyDelta = (): SequenceEditStateDelta => ({board: {writes: [], removals: []},
  timeline: {clips: [], cues: [], removedClipIds: [], removedCueIds: [], baseline: {kind: 'unchanged'}}});
const emptyCounts = (): SequenceEditAffectedCounts => ({nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0});
// Both sides are built by this service in deterministic field order; plain JSON
// comparison avoids sorting a 500-entry baseline on every action.
const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface SyncContext {
  readonly projectId: string;
  readonly timeline: Format5Timeline;
  readonly timelineState: ReturnType<typeof readFormat5TimelineState>;
  readonly rootNodeId: string;
  readonly syncRevision: number;
  readonly baseline: Format5SyncBaseline;
  readonly board: ChainBoard;
  readonly nodes: readonly ChainNode[];
  readonly nodeRows: ReadonlyMap<string, Row>;
  readonly shots: ReadonlyMap<string, Row>;
  readonly versions: ReadonlyMap<string, Row>;
  readonly assets: ReadonlyMap<string, Row>;
  readonly adoptions: ReadonlySet<string>;
  readonly edges: readonly SequenceEdge[];
  readonly edgeRows: ReadonlyMap<string, Row>;
  readonly media: readonly ChainSyncMedia[];
  readonly clips: readonly ChainSyncClip[];
  readonly anchored: readonly TrackAnchoredItem[];
  /** Full archived row JSON with archive columns, for restore actions. */
  readonly archivedShots: ReadonlyMap<string, Row>;
  readonly archivedNodes: ReadonlyMap<string, Row>;
  readonly archivedEdges: ReadonlyMap<string, Row>;
}
export type SequenceSyncContext = SyncContext;

interface JsonRow {
  readonly id: string; readonly data: Row; readonly archived: boolean;
  readonly archivedAt?: string; readonly archiveBatchId?: string; readonly archiveReason?: string;
}

function readJsonRows(db: any, table: 'shots' | 'nodes' | 'edges' | 'assets' | 'versions'): JsonRow[] {
  const hasArchive = table === 'shots' || table === 'nodes' || table === 'edges';
  const rows = db.prepare(`SELECT id,data${hasArchive ? ',archivedAt,archiveBatchId,archiveReason' : ''} FROM project.${table} ORDER BY id`).all() as Row[];
  return rows.map(row => {
    if (typeof row.id !== 'string' || typeof row.data !== 'string') throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'}); }
    if (!object(data) || data.id !== row.id) throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
    const archived = hasArchive && row.archivedAt !== null && row.archivedAt !== undefined;
    return {id: row.id, data, archived,
      ...(archived ? {archivedAt: String(row.archivedAt),
        ...(typeof row.archiveBatchId === 'string' ? {archiveBatchId: row.archiveBatchId} : {}),
        ...(typeof row.archiveReason === 'string' ? {archiveReason: row.archiveReason} : {})} : {})};
  });
}

function baselineFromRaw(raw: string): Format5SyncBaseline {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AppError('PROJECT_INVALID', '同步基线与格式 5 不符。', 422, {database: 'project', reason: 'metadata'}); }
  const parsed = format5SyncBaselineSchema.safeParse(value);
  if (!parsed.success) throw new AppError('PROJECT_INVALID', '同步基线与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
  return parsed.data;
}

function readMediaNode(node: ChainNode, nodeRows: ReadonlyMap<string, Row>, shots: ReadonlyMap<string, Row>,
  versions: ReadonlyMap<string, Row>, assets: ReadonlyMap<string, Row>, clipDuration: (nodeId: string) => number | null): ChainSyncMedia | null {
  const row = nodeRows.get(node.id);
  const fallback = clipDuration(node.id) ?? 120;
  if (node.kind === 'shot') {
    const shot = shots.get(node.id);
    const selected = typeof shot?.selectedVersionId === 'string' ? versions.get(shot.selectedVersionId) : undefined;
    const selectedVersion: ChainSyncVersion | null = selected && typeof selected.assetId === 'string'
      ? {id: selected.id, sourceFrames: sourceFrameCount(assets.get(selected.assetId)?.duration)} : null;
    return {nodeId: node.id, selectedVersion, durationFrames: selectedVersion?.sourceFrames ?? fallback};
  }
  if (!row) return null;
  if (node.kind === 'image') {
    const assetId = typeof row.assetId === 'string' ? row.assetId : null;
    if (assetId === null || !assets.has(assetId)) return {nodeId: node.id, selectedVersion: null, durationFrames: fallback};
    return {nodeId: node.id, selectedVersion: {id: assetId, sourceFrames: null}, durationFrames: fallback};
  }
  if (node.kind === 'video') {
    const assetId = typeof row.assetId === 'string' ? row.assetId : null;
    const frames = assetId === null ? null : sourceFrameCount(assets.get(assetId)?.duration);
    return {nodeId: node.id, selectedVersion: assetId !== null && frames !== null ? {id: assetId, sourceFrames: frames} : null,
      durationFrames: frames ?? fallback};
  }
  return null;
}

function readSyncContext(store: ProjectStore): SyncContext {
  const db = store.db;
  const timelineState = readFormat5TimelineState(db, 'project');
  const timeline = assembleFormat5Timeline(timelineState);
  if (!timeline) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  const syncRows = db.prepare('SELECT timelineId,projectId,sequenceNodeId,revision,baseline FROM project.sequence_sync_state').all() as Row[];
  const sync = syncRows[0];
  if (syncRows.length !== 1 || sync.timelineId !== timeline.id || sync.projectId !== store.projectId
    || sync.sequenceNodeId !== timeline.mainTrack.sequenceNodeId
    || !Number.isSafeInteger(sync.revision) || typeof sync.baseline !== 'string') {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '时间线没有绑定成片根。', 409, {timelineId: timeline.id});
  }
  const nodeRowsList = readJsonRows(db, 'nodes');
  const shotRowsList = readJsonRows(db, 'shots');
  const edgeRowsList = readJsonRows(db, 'edges');
  const assetRowsList = readJsonRows(db, 'assets');
  const versionRowsList = readJsonRows(db, 'versions');
  const adoptions = new Set<string>();
  for (const row of db.prepare('SELECT shotId,versionId FROM project.shot_version_adoptions').all() as Row[]) {
    adoptions.add(`${row.shotId}/${row.versionId}`);
  }
  const nodeRows = new Map(nodeRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  const shots = new Map(shotRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  const versions = new Map(versionRowsList.map(row => [row.id, row.data]));
  const assets = new Map(assetRowsList.map(row => [row.id, row.data]));
  const edgeRows = new Map(edgeRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  // Topology only: the terminal fence re-validates the complete graph at commit.
  const boardNodes: ChainNode[] = [];
  for (const shot of shotRowsList) if (!shot.archived) boardNodes.push({id: shot.id, kind: 'shot'});
  for (const row of nodeRowsList) {
    if (row.archived) continue;
    try { boardNodes.push({id: row.id, kind: format5ChainNodeKind(typeof row.data.type === 'string' ? row.data.type : '')}); }
    catch { throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'}); }
  }
  const sequenceEdges: SequenceEdge[] = edgeRowsList.filter(row => !row.archived && row.data.kind === 'sequence')
    .map(row => ({fromId: String(row.data.source), toId: String(row.data.target)}));
  const board: ChainBoard = {nodes: boardNodes, edges: sequenceEdges};
  const clips = format5MainTrackClips(timeline);
  const mainTrackId = timeline.mainTrack.trackId;
  const clipDuration = (nodeId: string): number | null => {
    const group = clips.filter(clip => clip.nodeId === nodeId);
    return group.length ? group.reduce((sum, clip) => sum + clip.durationFrames, 0) : null;
  };
  const media: ChainSyncMedia[] = [];
  for (const node of board.nodes) {
    const entry = readMediaNode(node, nodeRows, shots, versions, assets, clipDuration);
    if (entry) media.push(entry);
  }
  const anchored: TrackAnchoredItem[] = [];
  for (const clip of timeline.clips.filter(item => item.trackId !== mainTrackId)) {
    anchored.push(format5AnchoredItem({id: clip.id, startFrame: clip.startFrame, anchor: clip.anchor ?? null}));
  }
  for (const cue of timeline.subtitles?.cues ?? []) {
    anchored.push(format5AnchoredItem({id: cue.id, startFrame: cue.startFrame, anchor: cue.anchor}));
  }
  const archivedRow = (row: JsonRow): Row => ({...row.data, ...(row.archivedAt !== undefined ? {
    archivedAt: row.archivedAt,
    ...(row.archiveBatchId !== undefined ? {archiveBatchId: row.archiveBatchId} : {}),
    ...(row.archiveReason !== undefined ? {archiveReason: row.archiveReason} : {}),
  } : {})});
  const archivedShots = new Map(shotRowsList.filter(row => row.archived).map(row => [row.id, archivedRow(row)]));
  const archivedNodes = new Map(nodeRowsList.filter(row => row.archived).map(row => [row.id, archivedRow(row)]));
  const archivedEdges = new Map(edgeRowsList.filter(row => row.archived).map(row => [row.id, archivedRow(row)]));
  return {projectId: store.projectId, timeline, timelineState, rootNodeId: timeline.mainTrack.sequenceNodeId,
    syncRevision: Number(sync.revision), baseline: baselineFromRaw(sync.baseline), board, nodes: board.nodes,
    nodeRows, shots, versions, assets, adoptions, edges: board.edges, edgeRows, media, clips, anchored,
    archivedShots, archivedNodes, archivedEdges};
}

/** Read the exact live projection the CS board transaction plans against. */
export function readSequenceSyncContext(store: ProjectStore): SequenceSyncContext {
  return readSyncContext(store);
}

const saState = (context: SyncContext) => ({board: context.board, filmId: context.rootNodeId,
  media: context.media, clips: context.clips, anchored: context.anchored});

function derivedChain(context: SyncContext): {nodeIds: readonly string[]} {
  const nodeIds: string[] = [];
  for (const clip of context.clips) if (nodeIds.at(-1) !== clip.nodeId) nodeIds.push(clip.nodeId);
  return {nodeIds};
}
function derivedFloating(context: SyncContext): string[] {
  const live = new Set(context.board.nodes.map(node => node.id));
  for (const nodeId of derivedChain(context).nodeIds) live.delete(nodeId);
  return [...live].sort();
}

export interface SequenceSyncProjection {
  readonly timelineId: string;
  readonly rootNodeId: string;
  readonly mainTrackId: string;
  readonly syncRevision: number;
  readonly timelineRevision: number;
  readonly chainNodeIds: readonly string[];
  readonly floatingNodeIds: readonly string[];
  readonly track: readonly {nodeId: string; segmentGroupId: string; clipId: string; versionMode: 'follow' | 'locked';
    versionId: string | null; durationFrames: number}[];
  readonly board: readonly {nodeId: string; kind: ChainNode['kind']; versionId: string | null}[];
}

export function readSequenceSyncProjection(store: ProjectStore): SequenceSyncProjection {
  if (!format5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于项目格式 5。', 409, {reason: 'FORMAT_REQUIRED'});
  return store.tx(() => {
    const context = readSyncContext(store);
    const chain = derivedChain(context);
    return {timelineId: context.timeline.id, rootNodeId: context.rootNodeId, mainTrackId: context.timeline.mainTrack.trackId,
      syncRevision: context.syncRevision, timelineRevision: context.timeline.revision,
      chainNodeIds: chain.nodeIds, floatingNodeIds: derivedFloating(context),
      track: context.clips.map(clip => ({nodeId: clip.nodeId, segmentGroupId: clip.splitGroupId ?? clip.id, clipId: clip.id,
        versionMode: clip.versionLocked ? 'locked' : 'follow', versionId: clip.versionId, durationFrames: clip.durationFrames})),
      board: chain.nodeIds.map(nodeId => {
        const node = context.board.nodes.find(item => item.id === nodeId)!;
        const media = context.media.find(item => item.nodeId === nodeId);
        return {nodeId, kind: node.kind, versionId: media?.selectedVersion?.id ?? null};
      })};
  });
}

// ---------------------------------------------------------------------------
// Intent planning
// ---------------------------------------------------------------------------

function resolveVersion(context: SyncContext, nodeId: string, versionId: string): ChainSyncVersion | SequenceEditTransactionFailure {
  if (!isUuid(versionId) || !isUuid(nodeId)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [nodeId]);
  const version = context.versions.get(versionId);
  const shot = context.shots.get(nodeId);
  if (!version || !shot) return failure('MISSING_MEDIA', [nodeId]);
  if (version.shotId !== nodeId && !context.adoptions.has(`${nodeId}/${versionId}`)) return failure('INVALID_MEDIA', [nodeId]);
  const asset = typeof version.assetId === 'string' ? context.assets.get(version.assetId) : undefined;
  if (!asset || asset.sha256 !== version.sha256) return failure('INVALID_MEDIA', [nodeId]);
  return {id: version.id, sourceFrames: sourceFrameCount(asset.duration)};
}

function planFailure(plan: Extract<ChainSyncPlan, {ok: false}>): SequenceEditTransactionFailure {
  const ids = 'id' in plan && typeof plan.id === 'string' ? [plan.id]
    : 'issues' in plan && Array.isArray(plan.issues) ? plan.issues.flatMap(issue => issue.ids ?? []) : [];
  return failure(plan.code as SequenceEditErrorCode, ids);
}

function allocationClipIds(envelope: SequenceEditEnvelope): Record<string, string> {
  return Object.fromEntries(envelope.allocation.clips.map(item => [item.nodeId, item.clipId]));
}

function planEnvelope(context: SyncContext, envelope: SequenceEditEnvelope): SequenceEditPlan | SequenceEditTransactionFailure {
  if (envelope.intents.length !== 1) return failure('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', []);
  const operation = envelope.intents[0]!.operation;
  const state = saState(context);
  const checked = (plan: ChainSyncPlan): SequenceEditPlan | SequenceEditTransactionFailure =>
    plan.ok ? plan : planFailure(plan);
  if (operation.kind === 'sync-board') {
    return checked(planChainSync(state, {kind: 'sync-board', newClipIds: allocationClipIds(envelope)}));
  }
  if (operation.kind === 'board-version') {
    const version = operation.version === null ? null : resolveVersion(context, operation.nodeId, operation.version.id);
    if (version !== null && 'ok' in version && version.ok === false) return version;
    return checked(planChainSync(state, {kind: 'board-version', nodeId: operation.nodeId,
      version: version === null ? null : version as ChainSyncVersion}));
  }
  if (operation.kind === 'track') {
    const edit = operation.edit;
    if (edit.kind === 'version') {
      const clip = context.clips.find(item => item.id === edit.clipId);
      if (!clip) return failure('CLIP_NOT_FOUND', [edit.clipId]);
      const versionId = edit.version?.id ?? null;
      if (versionId === null) return failure('INVALID_MEDIA', [clip.nodeId]);
      const resolved = resolveVersion(context, clip.nodeId, versionId);
      if ('ok' in resolved) return resolved;
      return checked(planChainSync(state, {kind: 'track', edit: {kind: 'version', clipId: clip.id,
        version: resolved, locked: edit.locked}}));
    }
    if (edit.kind === 'add') {
      const enriched = enrichAddEdit(context, edit);
      if ('ok' in enriched && enriched.ok === false) return enriched;
      return checked(planChainSync(state, {kind: 'track', edit: enriched as Extract<typeof edit, {kind: 'add'}>}));
    }
    if (edit.kind === 'move-off-track') {
      const track = context.timeline.tracks.find(item => item.id === edit.trackId);
      if (!track) return failure('INVALID_TRACK_TARGET', [edit.trackId]);
    }
    return checked(planChainSync(state, {kind: 'track', edit}));
  }
  return failure('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', []);
}

// ---------------------------------------------------------------------------
// Format-5 mapping helpers
// ---------------------------------------------------------------------------

function versionAssetId(context: SyncContext, versionId: string | null): string | null {
  if (versionId === null) return null;
  const version = context.versions.get(versionId);
  return version && typeof version.assetId === 'string' ? version.assetId : null;
}
function nodeName(context: SyncContext, nodeId: string): string {
  const shot = context.shots.get(nodeId);
  if (typeof shot?.title === 'string' && shot.title) return shot.title;
  const node = context.nodeRows.get(nodeId);
  if (typeof node?.name === 'string' && node.name) return node.name;
  return 'Clip';
}
function nextMainClip(context: SyncContext, clip: ChainSyncClip, existing: Format5Clip | undefined,
  node: ChainNode | undefined = context.board.nodes.find(item => item.id === clip.nodeId),
  copiedNodes: ReadonlySet<string> = new Set()): Format5Clip {
  if (!node) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '主轨节点不在画板中。', 409, {reason: 'MISSING_NODE', id: clip.nodeId});
  const base: Format5Clip = existing ?? {
    id: clip.id, trackId: context.timeline.mainTrack.trackId, name: nodeName(context, clip.nodeId),
    startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame,
    rect: {x: 0, y: 0, width: context.timeline.width, height: context.timeline.height}, gain: 1,
    assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId: clip.splitGroupId ?? clip.id, versionMode: 'follow'},
  };
  const copiedNode = copiedNodes.has(clip.nodeId);
  const segmentGroupId = copiedNode && clip.splitGroupId === undefined ? clip.id
    : clip.splitGroupId ?? base.sequenceSource?.segmentGroupId ?? clip.id;
  const frames = {startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame};
  if (node.kind === 'shot' && clip.versionId === null) {
    const {versionId: _v, assetId: _a, jobId: _j, shotId: _s, ...rest} = base;
    void _v; void _a; void _j; void _s;
    return {...rest, ...frames, assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: 'follow'}};
  }
  const assetId = node.kind === 'shot' ? versionAssetId(context, clip.versionId) : clip.versionId;
  if (assetId === null) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '版本缺少素材。', 409, {reason: 'INVALID_MEDIA'});
  if (node.kind === 'shot') {
    const {jobId: _job, shotId: _shot, ...rest} = base;
    void _job; void _shot;
    const version = clip.versionId === null ? undefined : context.versions.get(clip.versionId);
    const jobId = isUuid(version?.jobId) ? version.jobId : null;
    const convertedPlaceholder = existing?.sourceState === 'placeholder';
    const versionChanged = (existing?.versionId ?? null) !== clip.versionId;
    const lineageCopy = convertedPlaceholder || versionChanged || copiedNode;
    // Existing ready clips with the same applied version keep their stored
    // lineage exactly; a converted placeholder, a version switch or a copied
    // node copies the applied version's ownership identity (fenced against the
    // version row/adoption).
    return {...(lineageCopy ? rest : base), ...frames, assetId, versionId: clip.versionId, sourceState: 'ready',
      shotId: lineageCopy ? version?.shotId ?? clip.nodeId : clip.nodeId,
      ...(lineageCopy && jobId ? {jobId} : {}),
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: clip.versionLocked ? 'locked' : 'follow'}};
  }
  const {versionId: _mv, jobId: _mj, shotId: _ms, ...mediaBase} = base;
  void _mv; void _mj; void _ms;
  return {...mediaBase, ...frames, assetId, sourceState: 'ready',
    sequenceSource: {kind: 'media', nodeId: clip.nodeId, segmentGroupId}};
}

function anchorForOwner(item: {startFrame: number; anchorClipId?: string | null},
  owners: ReadonlyMap<string, {id: string; startFrame: number; durationFrames: number}>): {clipId: string; offsetFrames: number} | null {
  if (item.anchorClipId === null || item.anchorClipId === undefined) return null;
  const owner = owners.get(item.anchorClipId);
  if (!owner) return null;
  const offsetFrames = item.startFrame - owner.startFrame;
  return offsetFrames >= 0 && offsetFrames < owner.durationFrames ? {clipId: item.anchorClipId, offsetFrames} : null;
}

function patchMainTimeline(context: SyncContext, plan: SequenceEditPlan): Format5Timeline {
  const existing = new Map(context.timeline.clips.map(clip => [clip.id, clip]));
  const mainTrackId = context.timeline.mainTrack.trackId;
  const planNodes = new Map(plan.after.board.nodes.map(node => [node.id, node]));
  const copiedNodes = new Set(plan.copiedNode ? [plan.copiedNode.toNodeId] : []);
  const mainClips = plan.after.clips.map(clip => nextMainClip(context, clip, existing.get(clip.id), planNodes.get(clip.nodeId), copiedNodes));
  const ownerList = mainClips.map(clip => ({id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames}));
  const ownerSegments = new Map(ownerList.map(owner => [owner.id, owner] as const));
  const anchored = new Map(plan.after.anchored.map(item => [item.id, item]));
  const clips: Format5Clip[] = [...mainClips];
  for (const clip of context.timeline.clips) {
    if (clip.trackId === mainTrackId) continue;
    const item = anchored.get(clip.id);
    const startFrame = item?.startFrame ?? clip.startFrame;
    clips.push({...clip, startFrame, anchor: item ? anchorForOwner(item, ownerSegments) ?? null : clip.anchor ?? null});
  }
  // A segment moved off the main track keeps its content but becomes an
  // other-track item with an explicit anchor.
  if (plan.transfer) {
    const original = existing.get(plan.transfer.clip.id);
    if (!original) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '转移的片段不存在。', 409, {id: plan.transfer.clip.id});
    const item = anchored.get(plan.transfer.clip.id);
    const {sequenceSource: _removedSource, ...otherTrack} = original;
    void _removedSource;
    clips.push({...otherTrack, trackId: plan.transfer.trackId, startFrame: plan.transfer.clip.startFrame,
      anchor: item ? anchorForOwner(item, ownerSegments) : null});
  }
  const ownerAt = (frame: number) => ownerList
    .find(owner => owner.startFrame <= frame && frame < owner.startFrame + owner.durationFrames) ?? null;
  const cues: Format5Cue[] = (context.timeline.subtitles?.cues ?? []).map(cue => {
    const item = anchored.get(cue.id);
    const startFrame = item?.startFrame ?? cue.startFrame;
    const anchor = item ? anchorForOwner(item, ownerSegments) : null;
    if (anchor) return {...cue, startFrame, anchor};
    // A cue cannot be detached (format-5 cues always carry an anchor): when the
    // owner disappears, re-anchor at the same frame if a main segment covers it.
    const owner = ownerAt(startFrame);
    return owner === null ? {...cue, startFrame, anchor: cue.anchor}
      : {...cue, startFrame, anchor: {clipId: owner.id, offsetFrames: startFrame - owner.startFrame}};
  });
  const ends = [...clips.map(clip => clip.startFrame + clip.durationFrames), ...cues.map(cue => cue.startFrame + cue.durationFrames)];
  const durationFrames = ends.reduce((maximum, value) => Math.max(maximum, value), 0);
  return {...context.timeline, revision: context.timeline.revision + 1, updatedAt: now(),
    durationFrames, clips, subtitles: context.timeline.subtitles ? {...context.timeline.subtitles, cues} : undefined};
}

function buildBaseline(context: SyncContext, timeline: Format5Timeline, shotUpdates: ReadonlyMap<string, Row>,
  extraShots: ReadonlyMap<string, Row> = new Map(), extraNodeKinds: ReadonlyMap<string, ChainNode['kind']> = new Map(),
  extraNodeRows: ReadonlyMap<string, Row> = new Map()): Format5SyncBaseline {
  const mainTrackId = timeline.mainTrack.trackId;
  const mainClips = timeline.clips.filter(clip => clip.trackId === mainTrackId);
  const chainNodeIds: string[] = [];
  for (const clip of mainClips) {
    const nodeId = clip.sequenceSource!.nodeId;
    if (chainNodeIds.at(-1) !== nodeId) chainNodeIds.push(nodeId);
  }
  const nodeKind = new Map(context.board.nodes.map(node => [node.id, node.kind]));
  for (const [nodeId, kind] of extraNodeKinds) nodeKind.set(nodeId, kind);
  const shotById = new Map(context.shots);
  for (const [nodeId, value] of shotUpdates) shotById.set(nodeId, value);
  for (const [nodeId, value] of extraShots) shotById.set(nodeId, value);
  const nodeRow = new Map(context.nodeRows);
  for (const [nodeId, value] of extraNodeRows) nodeRow.set(nodeId, value);
  const board = chainNodeIds.map(nodeId => {
    const kind = nodeKind.get(nodeId)!;
    if (kind === 'shot') return {nodeId, kind: 'shot' as const,
      selectedVersionId: typeof shotById.get(nodeId)?.selectedVersionId === 'string' ? shotById.get(nodeId)!.selectedVersionId as string : null};
    const assetId = nodeRow.get(nodeId)?.assetId;
    return {nodeId, kind: 'media' as const, assetId: isUuid(assetId) ? assetId : '00000000-0000-4000-8000-000000000000'};
  });
  const track: ({nodeId: string; segmentGroupId: string; clipId: string; kind: 'shot'; versionMode: 'follow' | 'locked';
    appliedVersionId: string | null} | {nodeId: string; segmentGroupId: string; clipId: string; kind: 'media'; assetId: string})[] =
  mainClips.map(clip => {
    const source = clip.sequenceSource!;
    if (source.kind === 'shot') return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id,
      kind: 'shot' as const, versionMode: source.versionMode, appliedVersionId: clip.versionId ?? null};
    return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id, kind: 'media' as const,
      assetId: clip.assetId ?? '00000000-0000-4000-8000-000000000000'};
  });
  const parsed = format5SyncBaselineSchema.safeParse({version: 1 as const, board, track});
  if (!parsed.success) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '同步基线无法写入。', 409, {reason: 'INVALID_BASELINE'});
  return parsed.data;
}

/** Resolve an `add` edit against the live board/media projection. Only existing
 * chain nodes are added here; creating a media card/track belongs to CS. */
function enrichAddEdit(context: SyncContext, edit: Extract<ChainSyncOperation, {kind: 'track'}>['edit'] & {kind: 'add'}):
  | {readonly ok: true; readonly kind: 'add'; readonly clip: ChainSyncClip; readonly beforeClipId: string | null;
    readonly media: ChainSyncMedia; readonly nodeKind?: 'shot' | 'video' | 'image'}
  | SequenceEditTransactionFailure {
  const clip = edit.clip;
  const node = context.board.nodes.find(item => item.id === clip.nodeId);
  if (!node) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [clip.nodeId]);
  if (!['shot', 'video', 'image'].includes(node.kind)) return failure('INVALID_MEDIA', [clip.nodeId]);
  const media = context.media.find(item => item.nodeId === clip.nodeId);
  if (!media) return failure('MISSING_MEDIA', [clip.nodeId]);
  const selected = media.selectedVersion?.id ?? null;
  const versionId = clip.versionId ?? null;
  if (node.kind === 'shot') {
    if (clip.versionLocked) {
      if (versionId === null) return failure('INVALID_MEDIA', [clip.nodeId]);
      const resolved = resolveVersion(context, clip.nodeId, versionId);
      if ('ok' in resolved) return resolved;
    } else if (versionId !== null && versionId !== selected) {
      return failure('INVALID_CLIP_VERSION', [clip.id]);
    }
  } else if (versionId !== null && versionId !== selected) {
    return failure('INVALID_CLIP_VERSION', [clip.id]);
  }
  return {ok: true, kind: 'add', clip: {...clip, versionId: node.kind === 'shot' ? (clip.versionId ?? null) : (versionId ?? selected),
    versionLocked: clip.versionLocked ?? false}, beforeClipId: edit.beforeClipId,
    media, nodeKind: edit.nodeKind ?? (node.kind as 'shot' | 'video' | 'image')};
}

interface BoardPlanEntities {
  readonly before: SequenceEditBoardDelta;
  readonly after: SequenceEditBoardDelta;
  readonly extraShots: ReadonlyMap<string, Row>;
  readonly extraNodeRows: ReadonlyMap<string, Row>;
  readonly extraNodeKinds: ReadonlyMap<string, ChainNode['kind']>;
}

const edgeKey = (edge: {readonly fromId: string; readonly toId: string}): string => `${edge.fromId}>${edge.toId}`;

/** Build the full board half: version selection shot rows, copied nodes/shots and
 * the chain edge rewiring. New edge ids come from the accepted allocation; a
 * missing allocation is a contract error, never a silently invented id. */
function boardPlanEntities(context: SyncContext, plan: SequenceEditPlan, envelope: SequenceEditEnvelope): BoardPlanEntities | SequenceEditTransactionFailure {
  const writesAfter: SequenceEditBoardEntity[] = [];
  const writesBefore: SequenceEditBoardEntity[] = [];
  const removalsAfter: SequenceEditBoardEntity[] = [];
  const removalsBefore: SequenceEditBoardEntity[] = [];
  const extraShots = new Map<string, Row>();
  const extraNodeRows = new Map<string, Row>();
  const extraNodeKinds = new Map<string, ChainNode['kind']>();
  for (const change of shotChanges(context, plan)) {
    writesAfter.push({kind: 'shot', id: String(change.after.id), data: change.after});
    writesBefore.push({kind: 'shot', id: String(change.before.id), data: change.before});
  }
  // Copied node for a split piece that is moved off its group.
  if (plan.copiedNode) {
    const {fromNodeId, toNodeId} = plan.copiedNode;
    const sourceNode = context.board.nodes.find(node => node.id === fromNodeId);
    if (!sourceNode) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [fromNodeId]);
    const allocation = envelope.allocation.nodes.find(item => item.fromNodeId === fromNodeId && item.nodeId === toNodeId);
    if (!allocation) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [toNodeId]);
    const copiedClip = plan.after.clips.find(clip => clip.nodeId === toNodeId);
    if (!copiedClip) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [toNodeId]);
    extraNodeKinds.set(toNodeId, sourceNode.kind);
    if (sourceNode.kind === 'shot') {
      const sourceShot = context.shots.get(fromNodeId);
      if (!sourceShot) return failure('INVALID_MEDIA', [fromNodeId]);
      const shot: Row = {...sourceShot, id: toNodeId, selectedVersionId: copiedClip.versionId ?? null,
        createdAt: now(), updatedAt: now()};
      extraShots.set(toNodeId, shot);
      writesAfter.push({kind: 'shot', id: toNodeId, data: shot});
      removalsBefore.push({kind: 'shot', id: toNodeId, data: shot});
      if (copiedClip.versionId !== null) {
        const adoption = {id: randomUUID(), projectId: context.projectId, shotId: toNodeId,
          versionId: copiedClip.versionId, createdAt: now()};
        writesAfter.push({kind: 'adoption', id: adoption.id, data: adoption});
        removalsBefore.push({kind: 'adoption', id: adoption.id, data: adoption});
      }
    } else {
      const sourceRow = context.nodeRows.get(fromNodeId);
      if (!sourceRow) return failure('INVALID_MEDIA', [fromNodeId]);
      const nodeRow: Row = {...sourceRow, id: toNodeId};
      extraNodeRows.set(toNodeId, nodeRow);
      writesAfter.push({kind: 'node', id: toNodeId, data: nodeRow});
      removalsBefore.push({kind: 'node', id: toNodeId, data: nodeRow});
    }
  }
  // Chain edge rewiring: removals by pair, additions by accepted allocation.
  const beforePairs = context.board.edges;
  const afterPairs = plan.after.board.edges;
  const beforeByKey = new Map(beforePairs.map(edge => [edgeKey(edge), edge]));
  const afterByKey = new Map(afterPairs.map(edge => [edgeKey(edge), edge]));
  const existingEdgeRows = new Map<string, Row>();
  for (const row of context.edgeRows.values()) {
    if (row.kind === 'sequence' && typeof row.source === 'string' && typeof row.target === 'string') {
      existingEdgeRows.set(`${row.source}>${row.target}`, row);
    }
  }
  for (const [key, edge] of beforeByKey) {
    if (afterByKey.has(key)) continue;
    const row = existingEdgeRows.get(key);
    if (!row) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [edge.fromId, edge.toId]);
    removalsAfter.push({kind: 'edge', id: String(row.id), data: row});
    writesBefore.push({kind: 'edge', id: String(row.id), data: row});
  }
  for (const [key, edge] of afterByKey) {
    if (beforeByKey.has(key)) continue;
    const allocated = envelope.allocation.edges.find(item => item.fromId === edge.fromId && item.toId === edge.toId);
    if (!allocated) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [edge.fromId, edge.toId]);
    const row = {id: allocated.id, projectId: context.projectId, kind: 'sequence', source: edge.fromId,
      target: edge.toId, createdAt: now()};
    writesAfter.push({kind: 'edge', id: allocated.id, data: row});
    removalsBefore.push({kind: 'edge', id: allocated.id, data: row});
  }
  return {before: {writes: writesBefore, removals: removalsBefore},
    after: {writes: writesAfter, removals: removalsAfter}, extraShots, extraNodeRows, extraNodeKinds};
}

interface AnchorIssue {readonly ok: false; readonly ids: readonly string[]}
/** D3: after a track/version change the other-track items and cues must stay
 * inside the timeline, keep a resolvable anchor and not overlap each other. */
function validateAnchoredTimeline(timeline: Format5Timeline): AnchorIssue | null {
  const mainClips = timeline.clips.filter(clip => clip.trackId === timeline.mainTrack.trackId);
  const owners = new Map(mainClips.map(clip => [clip.id, clip]));
  const problems = new Set<string>();
  const byTrack = new Map<string, {id: string; startFrame: number; durationFrames: number}[]>();
  for (const clip of timeline.clips) {
    if (clip.trackId === timeline.mainTrack.trackId) continue;
    const anchor = clip.anchor ?? null;
    if (anchor !== null) {
      const owner = owners.get(anchor.clipId);
      if (!owner || anchor.offsetFrames < 0 || anchor.offsetFrames >= owner.durationFrames
        || clip.startFrame !== owner.startFrame + anchor.offsetFrames) problems.add(clip.id);
    }
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0
      || clip.startFrame + clip.durationFrames > timeline.durationFrames) problems.add(clip.id);
    const lane = byTrack.get(clip.trackId) ?? [];
    lane.push({id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames});
    byTrack.set(clip.trackId, lane);
  }
  for (const lane of byTrack.values()) {
    lane.sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));
    for (let index = 1; index < lane.length; index++) {
      const previous = lane[index - 1]!, current = lane[index]!;
      if (previous.startFrame + previous.durationFrames > current.startFrame) {
        problems.add(previous.id); problems.add(current.id);
      }
    }
  }
  const cues = [...(timeline.subtitles?.cues ?? [])].sort((left, right) => left.startFrame - right.startFrame || (left.id < right.id ? -1 : 1));
  for (const cue of cues) {
    if (cue.anchor === null || cue.anchor === undefined) {
      problems.add(cue.id);
      continue;
    }
    const owner = owners.get(cue.anchor.clipId);
    if (!owner || cue.anchor.offsetFrames < 0 || cue.anchor.offsetFrames >= owner.durationFrames
      || cue.startFrame !== owner.startFrame + cue.anchor.offsetFrames
      || cue.startFrame + cue.durationFrames > timeline.durationFrames) problems.add(cue.id);
  }
  for (let index = 1; index < cues.length; index++) {
    const previous = cues[index - 1]!, current = cues[index]!;
    if (previous.startFrame + previous.durationFrames > current.startFrame) {
      problems.add(previous.id); problems.add(current.id);
    }
  }
  return problems.size ? {ok: false, ids: [...problems].sort()} : null;
}

// ---------------------------------------------------------------------------
// Delta composition and application
// ---------------------------------------------------------------------------

interface ShotChange {readonly before: Row; readonly after: Row}

function shotChanges(context: SyncContext, plan: SequenceEditPlan): ShotChange[] {
  const changes: ShotChange[] = [];
  for (const change of plan.changes.media) {
    const node = context.board.nodes.find(item => item.id === change.after?.nodeId);
    if (node?.kind !== 'shot') continue;
    const shot = context.shots.get(change.after!.nodeId);
    if (!shot) continue;
    const after = {...shot, selectedVersionId: change.after!.selectedVersion?.id ?? null, updatedAt: now()};
    if (after.selectedVersionId !== shot.selectedVersionId) changes.push({before: shot, after});
  }
  return changes;
}

function timelineDeltaPair(context: SyncContext, nextTimeline: Format5Timeline, plan: SequenceEditPlan,
  board: {readonly before: SequenceEditBoardDelta; readonly after: SequenceEditBoardDelta},
  nextBaseline: Format5SyncBaseline): SequenceEditPatch {
  const beforeClips = new Map(context.timeline.clips.map(clip => [clip.id, clip] as const));
  const afterClips = new Map(nextTimeline.clips.map(clip => [clip.id, clip] as const));
  const beforeCues = new Map((context.timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const afterCues = new Map((nextTimeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  // SA already reports every changed clip/anchored item; restricting the patch to
  // those ids keeps a 500-segment edit from re-serializing the whole projection.
  const changedIds = new Set<string>();
  for (const item of [...plan.changes.clips.map(change => change.after?.id ?? change.before?.id),
    ...plan.changes.anchored.map(change => change.after?.id ?? change.before?.id)]) if (item) changedIds.add(item);
  // SA reports an anchored item only when its start frame changes; an owner
  // detach/re-anchor can keep the same frame, so compare the anchor identity too.
  for (const item of context.anchored) {
    const beforeRow = beforeClips.get(item.id) ?? beforeCues.get(item.id);
    const afterRow = afterClips.get(item.id) ?? afterCues.get(item.id);
    if (!sameJson(beforeRow, afterRow)) changedIds.add(item.id);
  }
  for (const item of plan.after.anchored) if (!beforeClips.has(item.id) && !beforeCues.has(item.id)) changedIds.add(item.id);
  const clipIds = [...changedIds].filter(id => beforeClips.has(id) || afterClips.has(id));
  const cueIds = [...changedIds].filter(id => beforeCues.has(id) || afterCues.has(id));
  const baselineChanged = !sameJson(context.baseline, nextBaseline);
  const baselineAfter: SequenceEditBaselineChange = baselineChanged ? {kind: 'set', value: nextBaseline} : {kind: 'unchanged'};
  const baselineBefore: SequenceEditBaselineChange = baselineChanged ? {kind: 'set', value: context.baseline} : {kind: 'unchanged'};
  return {
    version: 1,
    before: {board: board.before, timeline: {
      clips: clipIds.filter(id => beforeClips.has(id)).map(id => beforeClips.get(id)!) as unknown as Format5Clip[],
      cues: cueIds.filter(id => beforeCues.has(id)).map(id => beforeCues.get(id)!) as unknown as Format5Cue[],
      removedClipIds: clipIds.filter(id => !beforeClips.has(id)), removedCueIds: cueIds.filter(id => !beforeCues.has(id)),
      baseline: baselineBefore,
    }},
    after: {board: board.after, timeline: {
      clips: clipIds.filter(id => afterClips.has(id)).map(id => afterClips.get(id)!) as unknown as Format5Clip[],
      cues: cueIds.filter(id => afterCues.has(id)).map(id => afterCues.get(id)!) as unknown as Format5Cue[],
      removedClipIds: clipIds.filter(id => !afterClips.has(id)), removedCueIds: cueIds.filter(id => !afterCues.has(id)),
      baseline: baselineAfter,
    }},
  };
}

/** Applies one board delta. Subject binding rows are tombstones: their native
 * revision always advances and a removal is never valid (the shared contract
 * rejects it before this point). */
function applyBoardDelta(store: ProjectStore, delta: SequenceEditBoardDelta): void {
  let subjectTouched = false;
  const rank = (entity: SequenceEditBoardEntity): number => entity.kind === 'adoption' ? 0
    : entity.kind === 'node' ? 1 : entity.kind === 'shot' ? 2 : 3;
  // Delete adoptions before their shot, and write the shot before its adoption.
  for (const entity of [...delta.removals].sort((left, right) => rank(left) - rank(right))) {
    if (entity.kind === 'subject_binding') {
      throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '主体绑定是墓碑，不能删除。', 409, {id: entity.id});
    }
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      const result = store.db.prepare('DELETE FROM project.shot_version_adoptions WHERE shotId=? AND versionId=? AND projectId=?')
        .run(String(data.shotId), String(data.versionId), store.projectId);
      if (Number(result.changes) !== 1) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '撤销/重做的版本采纳已不存在。', 409, {id: entity.id});
    } else {
      const table = entity.kind === 'shot' ? 'shots' : entity.kind === 'node' ? 'nodes' : 'edges';
      const result = store.db.prepare(`DELETE FROM project.${table} WHERE id=? AND projectId=?`).run(entity.id, store.projectId);
      if (Number(result.changes) !== 1) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '撤销/重做的对象已不存在。', 409, {id: entity.id});
    }
  }
  const writeRank = (entity: SequenceEditBoardEntity): number => entity.kind === 'adoption' ? 4
    : entity.kind === 'node' ? 1 : entity.kind === 'shot' ? 2 : 3;
  for (const entity of [...delta.writes].sort((left, right) => writeRank(left) - writeRank(right))) {
    if (entity.kind === 'subject_binding') {
      applySubjectBindingWrite(store, entity.data);
      subjectTouched = true;
      continue;
    }
    if (entity.kind === 'adoption') {
      const data = entity.data as Row;
      store.db.prepare('INSERT INTO project.shot_version_adoptions(projectId,shotId,versionId,createdAt) VALUES(?,?,?,?)')
        .run(store.projectId, String(data.shotId), String(data.versionId), String(data.createdAt));
    } else {
      store.put(entity.kind === 'shot' ? 'shots' : entity.kind === 'node' ? 'nodes' : 'edges', entity.data);
    }
  }
  if (subjectTouched) bumpFormat5ContentStampInside(store.db, 'project');
}

/** Native-column binding row: content comes from the patch, revision is always
 * the live row + 1 (or 1 when the tombstone is created). */
function applySubjectBindingWrite(store: ProjectStore, data: Row): void {
  const current = readSubjectBinding(store, String(data.id));
  const revision = current ? Number(current.revision) + 1 : 1;
  if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) {
    throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体绑定 revision 超出上限', 409, {});
  }
  if (current && (data.projectId !== current.projectId || data.shotId !== current.shotId
    || data.subjectId !== current.subjectId || data.role !== current.role)) {
    throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体绑定身份不可替换', 409, {id: current.id});
  }
  const value = {...data, revision, projectId: store.projectId,
    createdAt: current ? current.createdAt : String(data.createdAt)} as Record<string, unknown>;
  const bindingMode = String(value.bindingMode);
  const subjectVersionId = value.subjectVersionId === null ? null : String(value.subjectVersionId);
  const reviewedHeadVersionId = value.reviewedHeadVersionId === null ? null : String(value.reviewedHeadVersionId);
  const updatedAt = String(value.updatedAt);
  if (current) {
    // A replacement INSERT would trip the tombstone trigger; only content
    // columns (and the monotonic revision) may change.
    const saved = store.db.prepare(`UPDATE project.subject_bindings SET revision=?,bindingMode=?,subjectVersionId=?,
      reviewedHeadVersionId=?,updatedAt=? WHERE id=? AND projectId=? AND revision=?`)
      .run(revision, bindingMode, subjectVersionId, reviewedHeadVersionId, updatedAt, current.id,
        store.projectId, Number(current.revision));
    if (Number(saved.changes) !== 1) {
      throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '主体绑定 revision 已变化。', 409, {id: current.id});
    }
  } else {
    store.db.prepare(`INSERT INTO project.subject_bindings(id,projectId,shotId,subjectId,role,revision,bindingMode,
      subjectVersionId,reviewedHeadVersionId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(String(value.id), store.projectId, String(value.shotId), String(value.subjectId), String(value.role), revision,
        bindingMode, subjectVersionId, reviewedHeadVersionId, String(value.createdAt), updatedAt);
  }
}

interface TimelineApplyResult {readonly timeline: Format5Timeline; readonly changed: boolean}

function applyTimelineDelta(store: ProjectStore, delta: SequenceEditTimelineDelta,
  cachedContext?: SequenceSyncContext): TimelineApplyResult {
  const state = cachedContext?.timelineState ?? readFormat5TimelineState(store.db, 'project');
  const current = cachedContext?.timeline ?? assembleFormat5Timeline(state);
  if (!current) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  const clips = new Map(current.clips.map(clip => [clip.id, clip]));
  for (const clip of delta.clips) clips.set(clip.id, clip);
  for (const id of delta.removedClipIds) clips.delete(id);
  const cues = new Map((current.subtitles?.cues ?? []).map(cue => [cue.id, cue]));
  for (const cue of delta.cues) cues.set(cue.id, cue);
  for (const id of delta.removedCueIds) cues.delete(id);
  const durationFrames = [...[...clips.values()].map(clip => clip.startFrame + clip.durationFrames),
    ...[...cues.values()].map(cue => cue.startFrame + cue.durationFrames)]
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  const subtitleChange = delta.subtitles ?? {kind: 'unchanged' as const};
  const subtitleProfile = subtitleChange.kind === 'unchanged'
    ? (current.subtitles ? {profileId: current.subtitles.profileId,
      ...(current.subtitles.basisPresetId !== undefined ? {basisPresetId: current.subtitles.basisPresetId} : {})} : null)
    : subtitleChange.kind === 'absent' ? null : subtitleChange.value;
  const next: Format5Timeline = {...current, revision: current.revision + 1, updatedAt: now(), durationFrames,
    clips: [...clips.values()], subtitles: subtitleProfile ? {...subtitleProfile, cues: [...cues.values()]} : undefined};
  const update = planFormat5TimelineEntityUpdate(state, {clips: delta.clips, cues: delta.cues,
    removedClipIds: delta.removedClipIds, removedCueIds: delta.removedCueIds});
  const headerRaw = JSON.stringify(format5TimelineHeader(next));
  const headerChanged = state.header?.raw !== headerRaw;
  const rowChanges = update.changed || update.clipDeletes.length > 0 || update.cueDeletes.length > 0;
  const changed = rowChanges || headerChanged;
  if (!changed) return {timeline: current, changed: false};
  if (rowChanges) applyFormat5TimelineEntityUpdateInside(store.db, 'project', update);
  if (headerChanged) {
    const result = store.db.prepare('UPDATE project.timelines SET data=? WHERE id=?').run(headerRaw, next.id);
    if (Number(result.changes) !== 1) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  }
  bumpFormat5ContentStampInside(store.db, 'project');
  return {timeline: next, changed};
}

interface BaselineApplyResult {readonly revision: number; readonly baseline: Format5SyncBaseline | null; readonly changed: boolean}

function applyBaselineDelta(store: ProjectStore, context: SyncContext, change: SequenceEditBaselineChange): BaselineApplyResult {
  const next = applySequenceEditBaselineChange(context.baseline, change);
  if (next === null) {
    const result = store.db.prepare('DELETE FROM project.sequence_sync_state WHERE timelineId=? AND projectId=?')
      .run(context.timeline.id, store.projectId);
    if (Number(result.changes) !== 1) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '同步基线行不存在。', 409, {});
    return {revision: context.syncRevision + 1, baseline: null, changed: true};
  }
  if (sameJson(next, context.baseline)) return {revision: context.syncRevision, baseline: next, changed: false};
  const result = store.db.prepare('UPDATE project.sequence_sync_state SET revision=revision+1,baseline=? WHERE timelineId=? AND revision=?')
    .run(JSON.stringify(next), context.timeline.id, context.syncRevision);
  if (Number(result.changes) !== 1) throw new AppError('SEQUENCE_EDIT_REVISION_CONFLICT', '同步状态已经变化，请重新读取。', 409, {});
  return {revision: context.syncRevision + 1, baseline: next, changed: true};
}

// ---------------------------------------------------------------------------
// Preview / envelope construction
// ---------------------------------------------------------------------------

function affectedFromDelta(delta: SequenceEditStateDelta, context: SyncContext, mainTrackId: string): SequenceEditAffectedCounts {
  const countBoard = (kind: SequenceEditBoardEntity['kind'] | readonly SequenceEditBoardEntity['kind'][]) => {
    const kinds = Array.isArray(kind) ? kind : [kind];
    return delta.board.writes.filter(item => kinds.includes(item.kind)).length
      + delta.board.removals.filter(item => kinds.includes(item.kind)).length;
  };
  const beforeMain = new Set(context.timeline.clips.filter(clip => clip.trackId === mainTrackId).map(clip => clip.id));
  const mainClips = delta.timeline.clips.filter(clip => clip.trackId === mainTrackId).length
    + delta.timeline.removedClipIds.filter(id => beforeMain.has(id)).length;
  return {
    nodes: countBoard(['node', 'shot']), edges: countBoard('edge'),
    mainTrackClips: mainClips,
    otherTrackItems: delta.timeline.clips.filter(clip => clip.trackId !== mainTrackId).length
      + delta.timeline.removedClipIds.filter(id => !beforeMain.has(id)).length,
    subtitleCues: delta.timeline.cues.length + delta.timeline.removedCueIds.length,
  };
}

function operationOf(envelope: SequenceEditEnvelope): string {
  return sequenceEditEnvelopeOperationName(envelope);
}

function planWarnings(plan: SequenceEditPlan): ChainSyncWarning[] {
  return [...plan.warnings];
}

function targetKinds(envelope: SequenceEditEnvelope): {kind: 'shot' | 'node' | 'edge' | 'clip' | 'cue'; id: string}[] {
  return [
    ...envelope.impact.nodeIds.map(id => ({kind: 'node' as const, id})),
    ...envelope.impact.edgeIds.map(id => ({kind: 'edge' as const, id})),
    ...envelope.impact.mainTrackClipIds.map(id => ({kind: 'clip' as const, id})),
    ...envelope.impact.otherTrackItemIds.map(id => ({kind: 'clip' as const, id})),
    ...envelope.impact.subtitleCueIds.map(id => ({kind: 'cue' as const, id})),
  ];
}

export interface SequenceSyncPreview {
  readonly envelope: SequenceEditEnvelope;
  readonly warnings: readonly ChainSyncWarning[];
  /** Digest of the exact accepted envelope; the confirm request must repeat it
   * (`runSequenceSync(store, envelope, {expectedPlanDigest})`) or be rejected. */
  readonly planDigest: string;
}

function allocationForCommand(context: SyncContext, command: SequenceSyncCommand) {
  const allocation = {clips: [] as {nodeId: string; clipId: string}[], nodes: [] as {fromNodeId: string; nodeId: string}[],
    splitClips: [] as {clipId: string; rightClipId: string}[], edges: [] as {id: string; fromId: string; toId: string}[]};
  if (command.kind === 'sync-board') {
    allocation.clips = Object.entries(command.newClipIds ?? {}).map(([nodeId, clipId]) => ({nodeId, clipId}));
  } else if (command.kind === 'clip-add') {
    allocation.clips.push({nodeId: command.clip.nodeId, clipId: command.clip.id});
  } else if (command.kind === 'clip-split') {
    allocation.splitClips.push({clipId: command.clipId, rightClipId: command.rightClipId});
  } else if ((command.kind === 'clip-move' || command.kind === 'clip-move-off-track') && command.copyNodeId) {
    const clip = context.clips.find(item => item.id === command.clipId);
    if (clip) allocation.nodes.push({fromNodeId: clip.nodeId, nodeId: command.copyNodeId});
  }
  return allocation;
}

/** Fill new sequence-edge ids into the accepted allocation. The retry/confirm
 * request reuses exactly this envelope; ids are never reallocated on confirm. */
function allocateEdgeIds(context: SyncContext, plan: SequenceEditPlan,
  allocation: {edges: {id: string; fromId: string; toId: string}[]}): void {
  const before = new Set(context.board.edges.map(edge => `${edge.fromId}>${edge.toId}`));
  const existing = new Set(allocation.edges.map(item => `${item.fromId}>${item.toId}`));
  for (const edge of plan.after.board.edges) {
    const key = `${edge.fromId}>${edge.toId}`;
    if (before.has(key) || existing.has(key)) continue;
    allocation.edges.push({id: randomUUID(), fromId: edge.fromId, toId: edge.toId});
    existing.add(key);
  }
}

/** Read the live state once, plan with SA and build the shared contract envelope
 * a UI-E2/MT caller sends to `runSequenceSync`. The envelope carries the
 * observed revisions, impact ids, new-id allocation and the contract baseline. */
export function previewSequenceSync(store: ProjectStore, command: SequenceSyncCommand,
  options: {readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio'}): SequenceSyncPreview | SequenceEditTransactionFailure {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const context = readSyncContext(store);
    const intent = sequenceSyncIntent(command);
    const {state} = prepareSequenceEditHistory(store);
    const content = readProjectContentStamp(store.db).contentSequence;
    const allocation = allocationForCommand(context, command);
    const provisional: SequenceEditEnvelope = {
      contractVersion: 1, projectId: store.projectId, epoch: state.epoch,
      actionId: options.actionId ?? randomUUID(), requestId: options.requestId,
      originSide: intent.side, filmId: context.rootNodeId, intents: [intent], ...(options.origin ? {origin: options.origin} : {}),
      baseline: {contentRevision: content, timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
        historyPosition: state.position, historyRevision: state.revision, targets: []},
      impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
      allocation,
    };
    const plan = planEnvelope(context, provisional);
    if ('ok' in plan && plan.ok === false) return plan;
    const successful = plan as SequenceEditPlan;
    const mainTrackId = context.timeline.mainTrack.trackId;
    const nextTimeline = patchMainTimeline(context, successful);
    const anchorIssue = validateAnchoredTimeline(nextTimeline);
    if (anchorIssue) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', anchorIssue.ids);
    allocateEdgeIds(context, successful, allocation);
    const mainTrackClipSet = new Set(context.timeline.clips.filter(clip => clip.trackId === mainTrackId).map(clip => clip.id));
    const mainClipIds = successful.changes.clips.map(change => change.after?.id ?? change.before?.id)
      .filter((clipId): clipId is string => !!clipId && mainTrackClipSet.has(clipId));
    const otherItemIds = [...new Set(successful.changes.anchored.map(change => change.after?.id ?? change.before?.id).filter((id): id is string => !!id))];
    const changedEdgeIds: string[] = [];
    for (const edge of successful.changes.edges) {
      const key = `${edge.after?.fromId ?? edge.before?.fromId}>${edge.after?.toId ?? edge.before?.toId}`;
      const existing = context.edgeRows.values();
      for (const row of existing) if (row.kind === 'sequence' && `${row.source}>${row.target}` === key) changedEdgeIds.push(String(row.id));
    }
    const copiedNodeIds = successful.changes.nodes.flatMap(change => change.after ? [change.after.id] : []);
    const impact: SequenceEditImpact = {
      nodeIds: copiedNodeIds,
      edgeIds: [...new Set([...changedEdgeIds, ...provisional.allocation.edges.map(item => item.id)])],
      mainTrackClipIds: mainClipIds.filter(id => successful.changes.clips.some(change => (change.after?.id ?? change.before?.id) === id)),
      otherTrackItemIds: otherItemIds.filter(id => context.timeline.clips.some(clip => clip.id === id && clip.trackId !== mainTrackId)),
      subtitleCueIds: otherItemIds.filter(id => (context.timeline.subtitles?.cues ?? []).some(cue => cue.id === id)),
    };
    const kindName = (kind: 'shot' | 'node' | 'edge' | 'clip' | 'cue'): string =>
      kind === 'clip' ? 'timeline_clip' : kind === 'cue' ? 'timeline_cue' : kind;
    const targets = targetKinds({...provisional, impact}).flatMap(target => {
      const row = store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind=? AND targetId=?')
        .get(kindName(target.kind), target.id) as Row | undefined;
      return row && Number.isSafeInteger(row.revision) ? [{kind: target.kind, id: target.id, revision: Number(row.revision)}] : [];
    });
    const envelope: SequenceEditEnvelope = {...provisional, allocation, impact, baseline: {...provisional.baseline, targets}};
    if (!isSequenceEditEnvelope(envelope)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
    return {envelope, warnings: planWarnings(successful), planDigest: sequenceEditInputDigest(envelope)};
  });
}

// ---------------------------------------------------------------------------
// Shared transaction entry
// ---------------------------------------------------------------------------

export type SequenceSyncResult = SequenceEditCommitResult | SequenceEditTransactionFailure;

function emptyPatch(): SequenceEditPatch {
  return {version: 1, before: emptyDelta(), after: emptyDelta()};
}

function replayResult(store: ProjectStore, receipt: SequenceEditReceipt): SequenceSyncResult {
  if (receipt.status === 'not_applied') return failure(receipt.code ?? 'SEQUENCE_EDIT_NOOP');
  const entry = readSequenceEditHistoryEntry(store, receipt.actionId);
  return {ok: true, actionId: receipt.actionId, operation: receipt.operation,
    patch: entry ? patchFromEntry(entry) : emptyPatch(), receipt};
}

function revisionMatches(store: ProjectStore, envelope: SequenceEditEnvelope, context: SyncContext): SequenceEditTransactionFailure | null {
  const content = readProjectContentStamp(store.db).contentSequence;
  if (envelope.baseline.contentRevision !== content) return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
  if (envelope.baseline.timelineRevision !== context.timeline.revision) return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
  if (envelope.baseline.syncRevision !== context.syncRevision) return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
  return null;
}

function receiptDraft(envelope: SequenceEditEnvelope, inputDigest: string, receipt: {
  readonly affected: SequenceEditAffectedCounts; readonly warnings?: readonly ChainSyncWarning[];
  readonly contentRevision: number; readonly timelineRevision: number; readonly syncRevision: number;
}): Omit<SequenceEditReceipt, 'history'> {
  return {
    version: 1, requestId: envelope.requestId, inputDigest, projectId: envelope.projectId, actionId: envelope.actionId,
    operation: sequenceEditEnvelopeOperationName(envelope), originSide: envelope.originSide, status: 'applied',
    ...(receipt.warnings && receipt.warnings.length ? {warnings: receipt.warnings} : {}),
    affected: receipt.affected, contentRevision: receipt.contentRevision,
    timelineRevision: receipt.timelineRevision, syncRevision: receipt.syncRevision,
  };
}

/** One shared transaction: replay, CAS, plan, write both halves, one history
 * action and the immutable receipt. Failures before the first write leave no
 * data or history row; a no-op stores a `not_applied` receipt only. */
export function runSequenceSync(store: ProjectStore, envelope: SequenceEditEnvelope,
  options: {readonly expectedPlanDigest?: string} = {}): SequenceSyncResult {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (!isSequenceEditEnvelope(envelope)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (envelope.projectId !== store.projectId) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const inputDigest = sequenceEditInputDigest(envelope);
  if (envelope.subjectIntent) return runSubjectBindingSync(store, envelope, inputDigest);
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    if (replay) return replay.inputDigest === inputDigest ? replayResult(store, replay.receipt) : failure('SEQUENCE_EDIT_REQUEST_REUSED');
    if (options.expectedPlanDigest !== undefined && options.expectedPlanDigest !== inputDigest) {
      return failure('SEQUENCE_EDIT_PATCH_INVALID');
    }
    const context = readSyncContext(store);
    if (envelope.filmId !== context.rootNodeId) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
    const revisionFailure = revisionMatches(store, envelope, context);
    if (revisionFailure) return revisionFailure;
    const plan = planEnvelope(context, envelope);
    if ('ok' in plan && plan.ok === false) return writeFailure(store, envelope, plan.code);
    const successful = plan as SequenceEditPlan;
    const nextTimeline = patchMainTimeline(context, successful);
    const anchorIssue = validateAnchoredTimeline(nextTimeline);
    if (anchorIssue) return writeFailure(store, envelope, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
    const board = boardPlanEntities(context, successful, envelope);
    if ('ok' in board && board.ok === false) return writeFailure(store, envelope, board.code);
    const boardEntities = board as BoardPlanEntities;
    const changedShots = shotChanges(context, successful);
    const shotUpdates = new Map(changedShots.map(change => [change.after.id as string, change.after] as const));
    const nextBaseline = buildBaseline(context, nextTimeline, shotUpdates, boardEntities.extraShots,
      boardEntities.extraNodeKinds, boardEntities.extraNodeRows);
    const patch = timelineDeltaPair(context, nextTimeline, successful, boardEntities, nextBaseline);
    const baselineChanged = !sameJson(context.baseline, nextBaseline);
    const noop = patch.after.board.writes.length === 0 && patch.after.board.removals.length === 0
      && patch.after.timeline.clips.length === 0 && patch.after.timeline.cues.length === 0
      && patch.after.timeline.removedClipIds.length === 0 && patch.after.timeline.removedCueIds.length === 0
      && !baselineChanged;
    if (noop) return writeFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
    applyBoardDelta(store, boardEntities.after);
    const timelineApply = applyTimelineDelta(store, patch.after.timeline, context);
    const baselineApply = applyBaselineDelta(store, context, patch.after.timeline.baseline);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const receipt = receiptDraft(envelope, inputDigest, {
      affected: affectedFromDelta(patch.after, context, context.timeline.mainTrack.trackId),
      warnings: planWarnings(successful), contentRevision,
      timelineRevision: timelineApply.timeline.revision, syncRevision: baselineApply.revision,
    });
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}

/** One shared transaction for a subject binding action: replay, revision CAS,
 * board delta, one history entry and the immutable receipt. */
function runSubjectBindingSync(store: ProjectStore, envelope: SequenceEditEnvelope, inputDigest: string): SequenceSyncResult {
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    if (replay) return replay.inputDigest === inputDigest ? replayResult(store, replay.receipt) : failure('SEQUENCE_EDIT_REQUEST_REUSED');
    const content = readProjectContentStamp(store.db).contentSequence;
    const state = readFormat5TimelineState(store.db, 'project');
    const header = state.header ? JSON.parse(state.header.raw) as Row : {};
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content
      || envelope.baseline.timelineRevision !== Number(header.revision ?? 1)
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1)) {
      return writeFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan;
    try { plan = planSubjectBindingAction(store, envelope); }
    catch (error) {
      if (error instanceof AppError && isSequenceEditErrorCode(error.code)) {
        return writeFailure(store, envelope, error.code);
      }
      throw error;
    }
    if (sameJson(plan.before.board, plan.after.board)) return writeFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
    applyBoardDelta(store, plan.after.board);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const affected: SequenceEditAffectedCounts = {
      nodes: 0,
      edges: plan.after.board.writes.filter(item => item.kind === 'edge').length + plan.after.board.removals.length,
      mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0,
      subjectBindings: plan.after.board.writes.filter(item => item.kind === 'subject_binding').length,
    };
    const receipt = receiptDraft(envelope, inputDigest, {affected, contentRevision,
      timelineRevision: Number(header.revision ?? 1), syncRevision: Number(sync?.revision ?? 1)});
    const patch: SequenceEditPatch = {version: 1, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}

function writeFailure(store: ProjectStore, envelope: SequenceEditEnvelope, code: SequenceEditErrorCode): SequenceEditTransactionFailure {
  writeSequenceEditFailure(store, envelope, code);
  return failure(code);
}

// ---------------------------------------------------------------------------
// CS transaction-internal seam
// ---------------------------------------------------------------------------

export function createMainTrackProjectionPort(store: ProjectStore,
  providedContext?: () => SequenceSyncContext): MainTrackProjectionPort {
  return {
    projectMainTrack(request): SequenceEditTimelineCommit | SequenceEditTransactionFailure {
      const context = providedContext?.() ?? readSyncContext(store);
      if (request.envelope.filmId !== context.rootNodeId) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
      const nextTimeline = patchMainTimeline(context, request.plan);
      const anchorIssue = validateAnchoredTimeline(nextTimeline);
      if (anchorIssue) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', anchorIssue.ids);
      const changedShots = shotChanges(context, request.plan);
      const shotUpdates = new Map(changedShots.map(change => [change.after.id as string, change.after] as const));
      // Nodes restored by the CS board transaction in the same tx are not in
      // this pre-write context yet; expose their kind/archived row so the
      // baseline projection stays complete.
      const extraNodeKinds = new Map<string, ChainNode['kind']>();
      const extraNodeRows = new Map<string, Row>();
      const extraShots = new Map<string, Row>();
      for (const node of request.plan.after.board.nodes) {
        if (context.board.nodes.some(current => current.id === node.id)) continue;
        extraNodeKinds.set(node.id, node.kind);
        if (node.kind === 'shot') {
          const row = context.archivedShots.get(node.id);
          if (row) extraShots.set(node.id, row);
        } else {
          const row = context.archivedNodes.get(node.id);
          if (row) extraNodeRows.set(node.id, row);
        }
      }
      const nextBaseline = buildBaseline(context, nextTimeline, shotUpdates, extraShots,
        extraNodeKinds, extraNodeRows);
      // The CS caller owns the board half; this port only projects the timeline
      // half, so the full board plan is deliberately skipped here.
      const emptyBoard = {before: {writes: [], removals: []}, after: {writes: [], removals: []}};
      const patch = timelineDeltaPair(context, nextTimeline, request.plan, emptyBoard, nextBaseline);
      const baselineChanged = !sameJson(context.baseline, nextBaseline);
      return {ok: true, delta: patch.after.timeline, warnings: planWarnings(request.plan),
        timelineRevision: patch.after.timeline.clips.length || patch.after.timeline.cues.length
          || patch.after.timeline.removedClipIds.length || patch.after.timeline.removedCueIds.length
          ? context.timeline.revision + 1 : context.timeline.revision,
        syncRevision: baselineChanged ? context.syncRevision + 1 : context.syncRevision};
    },
  };
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

function undoApplyPatch(store: ProjectStore, patch: SequenceEditStateDelta, context: SyncContext): {
  readonly contentRevision: number; readonly timelineRevision: number; readonly syncRevision: number;
} {
  applyBoardDelta(store, patch.board);
  const timelineApply = applyTimelineDelta(store, patch.timeline, context);
  const baselineApply = applyBaselineDelta(store, context, patch.timeline.baseline);
  return {contentRevision: readProjectContentStamp(store.db).contentSequence,
    timelineRevision: timelineApply.timeline.revision, syncRevision: baselineApply.revision};
}

/** Undo or redo one existing action with the shared patch and history module.
 * The cursor move is validated against the caller's expected position/revision;
 * a new action later truncates the redo branch. */
export function moveSequenceSyncHistory(store: ProjectStore, command: SequenceEditHistoryCommand): SequenceSyncResult {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (command.projectId !== store.projectId) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const inputDigest = historyCommandDigest(command);
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, command.requestId);
    if (replay) return replay.inputDigest === inputDigest ? replayResult(store, replay.receipt) : failure('SEQUENCE_EDIT_REQUEST_REUSED');
    const context = readSyncContext(store);
    const current = prepareSequenceEditHistory(store);
    if (command.expected.position !== current.state.position || command.expected.revision !== current.state.revision) {
      return writeHistoryFailure(store, command, inputDigest, 'SEQUENCE_EDIT_HISTORY_CONFLICT');
    }
    const entry = readSequenceEditHistoryEntry(store, command.actionId);
    if (!entry || (command.direction === 'undo'
      ? entry.position !== current.state.position
      : entry.position !== current.state.position + 1)) {
      return writeHistoryFailure(store, command, inputDigest, 'SEQUENCE_EDIT_HISTORY_CONFLICT');
    }
    const source = command.direction === 'undo' ? entry.beforePatch : entry.afterPatch;
    let revisions: ReturnType<typeof undoApplyPatch>;
    try { revisions = undoApplyPatch(store, source, context); }
    catch (error) { if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_PATCH_INVALID') return writeHistoryFailure(store, command, inputDigest, 'SEQUENCE_EDIT_PATCH_INVALID'); throw error; }
    const operation = entry.operation;
    const receipt = moveSequenceEditHistoryCursor(store, command, {
      version: 1, requestId: command.requestId, inputDigest, projectId: store.projectId, actionId: command.actionId,
      operation, originSide: operation.startsWith('timeline.') ? 'timeline' : 'board', status: 'applied',
      affected: emptyCounts(), contentRevision: revisions.contentRevision,
      timelineRevision: revisions.timelineRevision, syncRevision: revisions.syncRevision,
    });
    return {ok: true, actionId: command.actionId, operation, patch: patchFromEntry(entry), receipt};
  });
}

function writeHistoryFailure(store: ProjectStore, command: SequenceEditHistoryCommand, inputDigest: string,
  code: SequenceEditErrorCode): SequenceEditTransactionFailure {
  const current = prepareSequenceEditHistory(store);
  const content = readProjectContentStamp(store.db).contentSequence;
  const timeline = store.db.prepare('SELECT data FROM project.timelines').get() as Row | undefined;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  const timelineRevision = timeline && typeof timeline.data === 'string' ? Number(JSON.parse(String(timeline.data)).revision) : 1;
  const receipt: SequenceEditReceipt = {
    version: 1, requestId: command.requestId, inputDigest, projectId: store.projectId, actionId: command.actionId,
    operation: readSequenceEditHistoryEntry(store, command.actionId)?.operation ?? 'timeline.clip.version',
    originSide: 'timeline', status: 'not_applied', code, affected: emptyCounts(), history: current.view,
    contentRevision: content, timelineRevision, syncRevision: Number(sync?.revision ?? 1),
  };
  store.db.prepare('INSERT INTO main.editor_requests(requestId,projectId,operation,inputDigest,response,issuedAt,createdAt) VALUES(?,?,?,?,?,?,?)')
    .run(command.requestId, store.projectId, receipt.operation, inputDigest, JSON.stringify(receipt), Date.now(), now());
  return failure(code);
}

// ---------------------------------------------------------------------------
// CS undo/redo seam
// ---------------------------------------------------------------------------

/** Apply the timeline half of a stored patch while CS undoes or redoes a
 * board-origin action. The caller may pass its already-read projection context;
 * the shared history module still owns the cursor and receipt. */
export function applySequenceEditTimelineDelta(store: ProjectStore, delta: SequenceEditTimelineDelta,
  providedContext?: SequenceSyncContext): {readonly timelineRevision: number} {
  const result = applyTimelineDelta(store, delta, providedContext);
  return {timelineRevision: result.timeline.revision};
}

/** Apply the three-state baseline half of a stored patch. */
export function applySequenceEditBaselineDelta(store: ProjectStore, change: SequenceEditBaselineChange,
  providedContext?: SequenceSyncContext): {readonly syncRevision: number} {
  const context = providedContext ?? readSyncContext(store);
  const result = applyBaselineDelta(store, context, change);
  return {syncRevision: result.revision};
}
