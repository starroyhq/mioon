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
  SequenceEditReceipt, SequenceEditStateDelta, SequenceEditSubtitleProfileChange, SequenceEditTimelineCommit,
  SequenceEditTimelineDelta,
  SequenceEditTransactionFailure, MainTrackProjectionPort, SequenceEditGenerateGeneration, SequenceEditIntent,
} from '@mioon/contracts/sequence-edit';
import {applySequenceEditBaselineChange, isSequenceEditEnvelope, isSequenceEditErrorCode, sequenceEditEnvelopeOperationName} from '@mioon/contracts/sequence-edit';
import {readSubjectBinding} from './format5-subject-binding.ts';
import {planSubjectEditAction} from './format5-subject-card.ts';
import {planPrevisAction} from './format5-previs.ts';
import {prunePrevisThumbnails} from './previs.ts';
import {planReferenceEdgeAction} from './format5-reference-inputs.ts';
import type {SequenceSyncCommand} from '@mioon/contracts/sequence-sync';
import {sequenceSyncIntent} from '@mioon/contracts/sequence-sync';
import {planChainSync} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncChange, ChainSyncChanges, ChainSyncOperation, ChainSyncPlan, ChainSyncWarning, TrackSyncEdit} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncVersion} from '../../contracts/src/chain-main-track.ts';
import type {ChainBoard, ChainNode, SequenceEdge} from '../../contracts/src/board-sequence.ts';
import type {TrackAnchoredItem} from '../../contracts/src/chain-sync-analysis.ts';
import {format5SyncBaselineSchema, format5TimelineHeader} from '../../contracts/src/project-format5.ts';
import {copyFormat5ShotDialogue, format5ShotDialogue, projectFormat5DialogueCues} from './format5-dialogue-projection.ts';
import type {Format5DialogueProjectedShot, Format5DialogueProjectionResult} from './format5-dialogue-projection.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {format5AnchoredItem, format5ChainNodeKind, format5MainTrackClips} from './project-file/format5-sequence-mapping.ts';
import {
  applyFormat5TimelineEntityUpdateInside, assembleFormat5Timeline, bumpFormat5ContentStampInside,
  planFormat5TimelineEntityUpdate, readFormat5TimelineState,
} from './project-file/format5-timeline.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readSceneSplitCuts} from './scene-history.ts';
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

function mergeChanges(target: ChainSyncChanges, source: ChainSyncChanges): void {
  for (const key of ['nodes', 'edges', 'media', 'clips', 'anchored'] as const) {
    (target[key] as ChainSyncChange<unknown>[]).push(...(source[key] as ChainSyncChange<unknown>[]));
  }
}
function sceneAllowedCuts(clip: {sourceInFrame: number; durationFrames: number; fadeInFrames?: number; fadeOutFrames?: number},
  cuts: readonly number[]): number[] {
  const inside = cuts.filter(frame => frame > clip.sourceInFrame && frame < clip.sourceInFrame + clip.durationFrames)
    .sort((left, right) => left - right);
  const fadeIn = Number(clip.fadeInFrames ?? 0), fadeOut = Number(clip.fadeOutFrames ?? 0);
  return inside.filter(frame => frame - clip.sourceInFrame >= fadeIn
    && frame - clip.sourceInFrame <= clip.durationFrames - fadeOut);
}
interface SceneSplitTarget {readonly clip: Format5Clip; readonly allowed: readonly number[];
  readonly fadeCutFrames: readonly number[]}
interface SceneTargetSet {readonly targets: readonly SceneSplitTarget[];
  readonly skipped: readonly {clipId: string; reason: 'NO_CUT_IN_RANGE' | 'FADE_BOUNDS'; cutFrames?: readonly number[]}[]}
/** Every timeline clip of one asset (all tracks), with the usable cuts in its
 * own source range. Cuts inside an audio fade are returned separately as skips. */
function sceneSplitTargets(timeline: Format5Timeline, cuts: readonly number[], assetId: string): SceneTargetSet {
  const targets: SceneSplitTarget[] = [], skipped: {clipId: string; reason: 'NO_CUT_IN_RANGE' | 'FADE_BOUNDS';
    cutFrames?: readonly number[]}[] = [];
  for (const clip of timeline.clips.filter(item => item.assetId === assetId)) {
    const inside = cuts.filter(frame => frame > clip.sourceInFrame && frame < clip.sourceInFrame + clip.durationFrames)
      .sort((left, right) => left - right);
    if (!inside.length) { skipped.push({clipId: clip.id, reason: 'NO_CUT_IN_RANGE'}); continue; }
    const fadeIn = Number(clip.fadeInFrames ?? 0), fadeOut = Number(clip.fadeOutFrames ?? 0);
    const allowed = inside.filter(frame => frame - clip.sourceInFrame >= fadeIn
      && frame - clip.sourceInFrame <= clip.durationFrames - fadeOut);
    const fadeCutFrames = inside.filter(frame => !allowed.includes(frame));
    if (!allowed.length) { skipped.push({clipId: clip.id, reason: 'FADE_BOUNDS', cutFrames: fadeCutFrames}); continue; }
    targets.push({clip, allowed, fadeCutFrames});
  }
  return {targets, skipped};
}
/** Pairs in the same order the envelope allocation was built: all targets in
 * timeline order, each target's cuts left-to-right. Main-track targets skip
 * ahead here because the chain planner consumes their pairs in the loop below. */
function scenePairs(envelope: SequenceEditEnvelope, targets: readonly SceneSplitTarget[]): {
  readonly pairs: readonly {clipId: string; rightClipId: string}[]; readonly byTarget: readonly (readonly {clipId: string; rightClipId: string}[])[] } {
  const pairs = envelope.allocation.splitClips, byTarget: {clipId: string; rightClipId: string}[][] = [];
  let index = 0;
  for (const target of targets) {
    const own = pairs.slice(index, index + target.allowed.length);
    if (own.length !== target.allowed.length) return {pairs: [], byTarget: []};
    byTarget.push(own);
    index += target.allowed.length;
  }
  return index === pairs.length ? {pairs, byTarget} : {pairs: [], byTarget: []};
}
/** FR-B2: expand the scene intent into ordinary sequential split commands for
 * every main-track target. Other-track clips are split in the timeline patch
 * after this plan; the allocation is still checked in full here. */
function planSceneSplit(context: SyncContext, envelope: SequenceEditEnvelope,
  edit: Extract<TrackSyncEdit, {kind: 'split-at-scenes'}>, cuts: readonly number[]): SequenceEditPlan | SequenceEditTransactionFailure {
  const targets = sceneSplitTargets(context.timeline, cuts, edit.assetId);
  if (!targets.targets.length) return failure('NOTHING_TO_SPLIT', []);
  const {byTarget} = scenePairs(envelope, targets.targets);
  if (!byTarget.length) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
  let state = saState(context), targetIndex = 0;
  const changes: ChainSyncChanges = {nodes: [], edges: [], media: [], clips: [], anchored: []};
  const warnings: ChainSyncWarning[] = [];
  for (const target of targets.targets) {
    const own = byTarget[targetIndex++]!;
    if (target.clip.trackId !== context.timeline.mainTrack.trackId) continue;
    let current = target.clip.id, index = 0;
    for (const cut of target.allowed) {
      const pair = own[index++]!;
      if (pair.clipId !== current) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [current]);
      const currentClip = state.clips.find(item => item.id === current);
      if (!currentClip) return failure('CLIP_NOT_FOUND', [current]);
      const plan = planChainSync(state, {kind: 'track', edit: {kind: 'split', clipId: current,
        offsetFrames: cut - currentClip.sourceInFrame, rightClipId: pair.rightClipId, rightSourceInFrame: cut}});
      if (plan.ok === false) return planFailure(plan);
      mergeChanges(changes, plan.changes);
      warnings.push(...plan.warnings);
      state = plan.after;
      current = pair.rightClipId;
    }
  }
  return {ok: true, after: state, changes, warnings, issues: []};
}
/** Split every other-track clip in the already main-track-patched timeline. */
function applyOtherTrackSceneSplits(timeline: Format5Timeline, context: SyncContext, envelope: SequenceEditEnvelope,
  cuts: readonly number[]): {timeline: Format5Timeline; split: readonly {clipId: string; clipIds: readonly string[];
    cutFrames: readonly number[]; fadeCutFrames: readonly number[]}[]; skipped: readonly {clipId: string;
    reason: 'NO_CUT_IN_RANGE' | 'FADE_BOUNDS'; cutFrames?: readonly number[]}[]} {
  const targetSet = sceneSplitTargets(context.timeline, cuts, envelope.intents[0]!.operation.kind === 'track'
    && envelope.intents[0]!.operation.edit && 'assetId' in envelope.intents[0]!.operation.edit
    ? String(envelope.intents[0]!.operation.edit.assetId) : '');
  const {byTarget} = scenePairs(envelope, targetSet.targets);
  const clips = [...timeline.clips];
  const split = targetSet.targets.map((target, index) => ({clipId: target.clip.id,
    clipIds: [target.clip.id, ...byTarget[index]!.map(pair => pair.rightClipId)],
    cutFrames: [...target.allowed], fadeCutFrames: [...target.fadeCutFrames]}));
  let pairIndex = 0;
  for (const target of targetSet.targets) {
    const own = byTarget[pairIndex++]!;
    if (target.clip.trackId === timeline.mainTrack.trackId) continue;
    let index = clips.findIndex(clip => clip.id === target.clip.id);
    if (index < 0) continue;
    let piece = clips[index]!;
    let pairCursor = 0;
    for (const cut of target.allowed) {
      const leftDuration = cut - piece.sourceInFrame;
      const rightStart = piece.startFrame + leftDuration;
      const owner = clips.find(clip => clip.trackId === timeline.mainTrack.trackId
        && clip.startFrame <= rightStart && rightStart < clip.startFrame + clip.durationFrames);
      const rightDuration = piece.durationFrames - leftDuration;
      const right = {...piece, id: own[pairCursor++]!.rightClipId,
        startFrame: rightStart, durationFrames: rightDuration, sourceInFrame: cut,
        ...(Object.hasOwn(piece, 'fadeInFrames') ? {fadeInFrames: 0} : {}),
        ...(Object.hasOwn(piece, 'fadeOutFrames')
          ? {fadeOutFrames: Math.min(Number(piece.fadeOutFrames), rightDuration)} : {}),
        ...(owner ? {anchor: {clipId: owner.id, offsetFrames: rightStart - owner.startFrame}} : {})} as Format5Clip;
      clips.splice(index, 1, {...piece, durationFrames: leftDuration} as Format5Clip, right);
      piece = right;
      index += 1;
    }
  }
  const skipped = [...targetSet.skipped, ...targetSet.targets.filter(target => target.fadeCutFrames.length)
    .map(target => ({clipId: target.clip.id, reason: 'FADE_BOUNDS' as const, cutFrames: [...target.fadeCutFrames]}))];
  return {timeline: {...timeline, clips}, split, skipped};
}
interface GeneratedShotMeta {readonly shot: Row; readonly nodeId: string; readonly otherClip?: Format5Clip}
const generatedShotMeta = new WeakMap<object, GeneratedShotMeta>();

/** GE-a: build the main-track placeholder plan. The new shot/node/media and the
 * chain edges are prepared in the planner state, then the ordinary `sync-board`
 * planner allocates the packed clip at the requested position. */
function planGeneratePlaceholder(context: SyncContext, envelope: SequenceEditEnvelope,
  operation: Extract<NonNullable<SequenceEditEnvelope['generateIntent']>['operation'], {kind: 'generate-placeholder'}>): SequenceEditPlan | SequenceEditTransactionFailure {
  const allocation = envelope.allocation.clips.find(item => item.nodeId === operation.shotId && item.clipId === operation.clipId);
  if (!allocation) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [operation.shotId]);
  const placement = operation.placement;
  if (placement.kind === 'track') {
    const track = context.timeline.tracks.find(item => item.id === placement.trackId);
    if (!track || track.id === context.timeline.mainTrack.trackId) return failure('INVALID_TRACK_TARGET', [placement.trackId]);
    const startFrame = placement.startFrame;
    const owner = context.timeline.clips.find(clip => clip.trackId === context.timeline.mainTrack.trackId
      && clip.startFrame <= startFrame && startFrame < clip.startFrame + clip.durationFrames);
    if (!owner) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', [placement.trackId]);
    const durationFrames = operation.settings.duration * 30;
    const clip: Format5Clip = {id: operation.clipId, trackId: track.id, name: operation.title,
      startFrame, durationFrames, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: context.timeline.width, height: context.timeline.height}, gain: 1,
      assetId: null, versionId: null, jobId: null, sourceState: 'placeholder', shotId: operation.shotId,
      anchor: {clipId: owner.id, offsetFrames: startFrame - owner.startFrame}};
    const shot: Row = {id: operation.shotId, projectId: context.projectId, title: operation.title,
      prompt: operation.settings.prompt, duration: operation.settings.duration, aspectRatio: operation.settings.aspectRatio,
      parameters: operation.settings.parameters ?? {}, selectedVersionId: null, referenceAssetIds: [],
      orderIndex: Math.max(0, ...[...context.shots.values()].map(row => Number(row.orderIndex)).filter(Number.isFinite)) + 1,
      revision: 1, createdAt: now(), updatedAt: now(),
      ...(operation.position ? {position: operation.position} : {})};
    const node: ChainNode = {id: operation.shotId, kind: 'shot'};
    const plan = {ok: true as const, issues: [] as const, warnings: [] as const,
      after: {...saState(context), board: {...context.board, nodes: [...context.board.nodes, node]},
        media: [...context.media, {nodeId: operation.shotId, selectedVersion: null, durationFrames}]},
      changes: {nodes: [{before: null, after: node}], edges: [], media: [{before: null,
        after: {nodeId: operation.shotId, selectedVersion: null, durationFrames}}], clips: [], anchored: []}} as unknown as SequenceEditPlan;
    generatedShotMeta.set(plan, {shot, nodeId: operation.shotId, otherClip: clip});
    return plan;
  }
  if (context.board.nodes.some(node => node.id === operation.shotId) || context.shots.has(operation.shotId))
    return failure('SEQUENCE_EDIT_GENERATION_INVALID', [operation.shotId]);
  const mainTrackId = context.timeline.mainTrack.trackId;
  const chainIds: string[] = [];
  for (const clip of context.clips) if (clip.nodeId !== chainIds.at(-1)) chainIds.push(clip.nodeId);
  let at = chainIds.length;
  if (placement.kind === 'main' && placement.beforeClipId !== null) {
    const before = context.timeline.clips.find(clip => clip.id === placement.beforeClipId && clip.trackId === mainTrackId);
    if (!before || !before.sequenceSource) return failure('CLIP_NOT_FOUND', [placement.beforeClipId]);
    const beforeNode = before.sequenceSource.nodeId;
    const index = chainIds.indexOf(beforeNode);
    if (index < 0) return failure('SEQUENCE_EDIT_GENERATION_INVALID', [beforeNode]);
    at = index;
  }
  const nextChain = [...chainIds.slice(0, at), operation.shotId, ...chainIds.slice(at)];
  const affected = new Set([context.rootNodeId, ...chainIds]);
  const edges = context.board.edges.filter(edge => !affected.has(edge.fromId));
  let fromId = context.rootNodeId;
  for (const toId of nextChain) { edges.push({fromId, toId}); fromId = toId; }
  const durationFrames = operation.settings.duration * 30;
  const shot: Row = {id: operation.shotId, projectId: context.projectId, title: operation.title,
    prompt: operation.settings.prompt, duration: operation.settings.duration, aspectRatio: operation.settings.aspectRatio,
    parameters: operation.settings.parameters ?? {}, selectedVersionId: null, referenceAssetIds: [],
    orderIndex: Math.max(0, ...[...context.shots.values()].map(row => Number(row.orderIndex)).filter(Number.isFinite)) + 1,
    revision: 1, createdAt: now(), updatedAt: now(),
    ...(operation.position ? {position: operation.position} : {})};
  const planningState = {board: {nodes: [...context.board.nodes, {id: operation.shotId, kind: 'shot' as const}], edges},
    filmId: context.rootNodeId,
    media: [...context.media, {nodeId: operation.shotId, selectedVersion: null, durationFrames}],
    clips: context.clips, anchored: context.anchored};
  const plan = planChainSync(planningState, {kind: 'sync-board', newClipIds: {[operation.shotId]: operation.clipId}});
  if (plan.ok === false) return planFailure(plan);
  generatedShotMeta.set(plan, {shot, nodeId: operation.shotId});
  return plan;
}

/** GE-a: resize one generated placeholder. It is one packed main-track clip;
 * following clips and anything anchored to them move with the delta. */
function planGenerateResize(context: SyncContext, envelope: SequenceEditEnvelope,
  operation: Extract<NonNullable<SequenceEditEnvelope['generateIntent']>['operation'], {kind: 'generate-resize'}>): SequenceEditPlan | SequenceEditTransactionFailure {
  const state = saState(context);
  const target = state.clips.filter(clip => clip.nodeId === operation.shotId);
  if (target.length !== 1) return failure('SEQUENCE_EDIT_GENERATION_INVALID', [operation.shotId]);
  const clip = target[0]!;
  const existing = context.timeline.clips.find(item => item.id === clip.id);
  if (!existing || existing.sourceState !== 'placeholder') return failure('SEQUENCE_EDIT_GENERATION_INVALID', [clip.id]);
  const durationFrames = operation.duration * 30;
  if (durationFrames === clip.durationFrames) return failure('SEQUENCE_EDIT_NOOP', [clip.id]);
  const delta = durationFrames - clip.durationFrames;
  const start = clip.startFrame, end = start + clip.durationFrames;
  const changedClips = new Set<string>([clip.id]);
  const clips = state.clips.map(item => {
    if (item.id === clip.id) return {...item, durationFrames};
    if (item.startFrame >= end) { changedClips.add(item.id); return {...item, startFrame: item.startFrame + delta}; }
    return item;
  });
  const shiftedOwners = new Set(clips.filter(item => changedClips.has(item.id) && item.startFrame !== clip.startFrame).map(item => item.id));
  const changedAnchors: TrackAnchoredItem[] = [];
  const anchored = state.anchored.map(item => {
    if (!item.anchorClipId || !shiftedOwners.has(item.anchorClipId)) return item;
    changedAnchors.push(item);
    return {...item, startFrame: item.startFrame + delta};
  });
  const clipChanges: ChainSyncChange<ChainSyncClip>[] = [];
  for (const id of changedClips) {
    const before = context.clips.find(item => item.id === id) ?? null;
    const after = clips.find(item => item.id === id) ?? null;
    clipChanges.push({before, after});
  }
  const anchoredChanges: ChainSyncChange<TrackAnchoredItem>[] = changedAnchors.map(item =>
    ({before: context.anchored.find(value => value.id === item.id) ?? null, after: item}));
  const changes: ChainSyncChanges = {nodes: [], edges: [], media: [], clips: clipChanges, anchored: anchoredChanges};
  return {ok: true, after: {...state, clips, anchored}, changes, warnings: [], issues: []};
}

// ---------------------------------------------------------------------------
// ED: insert one asset / paste one copied clip
// ---------------------------------------------------------------------------

/** Exact board rows created by one ED action. SA models only chain nodes and
 * media, so shot/node/adoption rows and any overlay clip travel beside the plan
 * until boardPlanEntities/patchMainTimeline consume them. */
interface InsertMetadata {
  readonly nodeRows: ReadonlyMap<string, Row>;
  readonly shotRows: ReadonlyMap<string, Row>;
  readonly adoptionRows: ReadonlyMap<string, Row>;
  readonly nodeKinds: ReadonlyMap<string, ChainNode['kind']>;
  readonly clipNames: ReadonlyMap<string, string>;
  readonly extraOtherClips: readonly Format5Clip[];
}
const insertMetadata = new WeakMap<object, InsertMetadata>();
function metadataOf(plan: SequenceEditPlan): InsertMetadata | undefined {return insertMetadata.get(plan);}
function attachMetadata(plan: SequenceEditPlan, metadata: InsertMetadata): SequenceEditPlan {
  insertMetadata.set(plan, metadata);
  return plan;
}
function assetKindOf(asset: Row): 'image' | 'video' | 'audio' | null {
  const mime = typeof asset.mimeType === 'string' ? asset.mimeType : '';
  return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : null;
}
function assetFrames(asset: Row, kind: 'image' | 'video' | 'audio'): number | null {
  return kind === 'image' ? 90 : sourceFrameCount(asset.duration);
}
function assetName(asset: Row, fallback: string): string {
  return typeof asset.name === 'string' && asset.name ? asset.name.slice(0, 200) : fallback;
}
function mainClips(context: SyncContext): Format5Clip[] {
  const mainTrackId = context.timeline.mainTrack.trackId;
  return [...context.timeline.clips].filter(clip => clip.trackId === mainTrackId)
    .sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id));
}
function insertionBefore(context: SyncContext, startFrame: number): string | null {
  const clips = mainClips(context);
  const target = clips.findIndex(clip => startFrame < clip.startFrame + clip.durationFrames);
  if (target < 0) return null;
  // SA refuses an insertion between two pieces of one split group. A drop inside
  // the later pieces lands after the whole group; a drop on the first piece
  // still lands before it.
  const nodeId = clips[target]!.sequenceSource?.nodeId;
  if (nodeId === undefined) return clips[target]!.id;
  const first = clips.findIndex(clip => clip.sequenceSource?.nodeId === nodeId);
  let last = first;
  while (last + 1 < clips.length && clips[last + 1]!.sequenceSource?.nodeId === nodeId) last += 1;
  const at = target > first ? last + 1 : first;
  return at < clips.length ? clips[at]!.id : null;
}
function ownerAt(context: SyncContext, startFrame: number): Format5Clip | null {
  return mainClips(context).find(clip => clip.startFrame <= startFrame && startFrame < clip.startFrame + clip.durationFrames) ?? null;
}
function freeBoardPosition(context: SyncContext): {x: number; y: number} {
  let right = 0;
  for (const row of [...context.shots.values(), ...context.nodeRows.values()]) {
    const point = row.position;
    if (point !== null && typeof point === 'object' && Number.isFinite(point.x)) right = Math.max(right, Number(point.x));
  }
  return {x: Math.min(1_000_000, right + 340), y: 120};
}
function insertClipTitle(pairs: Map<string, string>, clipId: string, title: string): Map<string, string> {
  pairs.set(clipId, title);
  return pairs;
}
function planMainInsert(context: SyncContext, input: {
  readonly nodeId: string; readonly clipId: string; readonly beforeClipId: string | null;
  readonly kind: 'shot' | 'image' | 'video'; readonly media: ChainSyncMedia; readonly nodeRow?: Row;
  readonly durationFrames: number; readonly sourceInFrame: number; readonly versionId: string | null;
  readonly title: string; readonly shotRow?: Row; readonly adoptionRow?: Row;
}): SequenceEditPlan | SequenceEditTransactionFailure {
  if (context.board.nodes.some(node => node.id === input.nodeId) || context.media.some(item => item.nodeId === input.nodeId))
    return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [input.nodeId]);
  const planningState = {board: {nodes: [...context.board.nodes, {id: input.nodeId, kind: input.kind}], edges: context.board.edges},
    filmId: context.rootNodeId, media: [...context.media, input.media], clips: context.clips, anchored: context.anchored};
  const edit: TrackSyncEdit = {kind: 'add', clip: {id: input.clipId, nodeId: input.nodeId,
    versionId: input.versionId, versionLocked: false, startFrame: 0, durationFrames: input.durationFrames,
    sourceInFrame: input.sourceInFrame, splitGroupId: input.clipId}, beforeClipId: input.beforeClipId,
    media: input.media, nodeKind: input.kind};
  const plan = planChainSync(planningState, {kind: 'track', edit});
  if (!plan.ok) return failure(plan.code as SequenceEditErrorCode, 'id' in plan && typeof plan.id === 'string' ? [plan.id] : []);
  const shotRows = new Map<string, Row>(); if (input.shotRow) shotRows.set(input.nodeId, input.shotRow);
  const adoptionRows = new Map<string, Row>();
  if (input.adoptionRow) adoptionRows.set(String(input.adoptionRow.id), input.adoptionRow);
  const nodeRows = new Map<string, Row>(); if (input.nodeRow) nodeRows.set(input.nodeId, input.nodeRow);
  return attachMetadata(plan, {nodeRows, shotRows, adoptionRows,
    nodeKinds: new Map([[input.nodeId, input.kind]]), clipNames: insertClipTitle(new Map(), input.clipId, input.title),
    extraOtherClips: []});
}
function planOverlayInsert(context: SyncContext, clip: Format5Clip, owner: Format5Clip): SequenceEditPlan {
  const anchored = {id: clip.id, startFrame: clip.startFrame, anchorClipId: owner.id};
  const plan = {ok: true as const, issues: [] as const, warnings: [] as const,
    after: {board: context.board, filmId: context.rootNodeId, media: context.media,
      clips: context.clips, anchored: [...context.anchored, anchored].sort((left, right) => left.id.localeCompare(right.id))},
    changes: {nodes: [], edges: [], media: [], clips: [], anchored: [{before: null, after: anchored}]}} as unknown as SequenceEditPlan;
  return attachMetadata(plan, {nodeRows: new Map(), shotRows: new Map(), adoptionRows: new Map(),
    nodeKinds: new Map(), clipNames: new Map(), extraOtherClips: [clip]});
}
function overlayClipForAsset(context: SyncContext, asset: Row, kind: 'image' | 'video' | 'audio', clipId: string,
  trackId: string, startFrame: number, durationFrames: number, owner: Format5Clip): Format5Clip {
  return {id: clipId, trackId, name: assetName(asset, kind === 'audio' ? 'Audio' : kind), startFrame,
    durationFrames, sourceInFrame: 0, rect: {x: 0, y: 0, width: context.timeline.width, height: context.timeline.height}, gain: 1,
    assetId: String(asset.id), sourceState: 'ready',
    anchor: {clipId: owner.id, offsetFrames: startFrame - owner.startFrame}};
}
/** Validate an account of a new node/media pair. Copy actions reuse the source
 * clip's applied version; asset insertion locks to the asset id as the format-5
 * media selected version. */
function expandedAddPlan(context: SyncContext, envelope: SequenceEditEnvelope,
  edit: Extract<TrackSyncEdit, {kind: 'add'}>): SequenceEditPlan | SequenceEditTransactionFailure {
  if (edit.nodeAssetId) {
    const asset = context.assets.get(edit.nodeAssetId);
    if (!asset || asset.projectId !== context.projectId) return failure('INVALID_MEDIA', [edit.nodeAssetId]);
    const kind = assetKindOf(asset);
    if (kind !== 'image' && kind !== 'video') return failure('INVALID_MEDIA', [edit.nodeAssetId]);
    const media = kind === 'image'
      ? {nodeId: edit.clip.nodeId, selectedVersion: {id: edit.nodeAssetId, sourceFrames: null as null}, durationFrames: edit.clip.durationFrames}
      : (() => {const frames = sourceFrameCount(asset.duration); return frames === null ? null :
        {nodeId: edit.clip.nodeId, selectedVersion: {id: edit.nodeAssetId!, sourceFrames: frames}, durationFrames: frames};})();
    if (!media) return failure('INVALID_MEDIA', [edit.nodeAssetId]);
    const nodeRow = {id: edit.clip.nodeId, projectId: context.projectId, type: kind, assetId: edit.nodeAssetId,
      name: edit.nodeName ?? assetName(asset, kind), label: edit.nodeName ?? assetName(asset, kind),
      position: freeBoardPosition(context), revision: 1, createdAt: now(), updatedAt: now()};
    return planMainInsert(context, {nodeId: edit.clip.nodeId, clipId: edit.clip.id, beforeClipId: edit.beforeClipId,
      kind, media: {...media, durationFrames: edit.clip.durationFrames}, nodeRow,
      durationFrames: edit.clip.durationFrames, sourceInFrame: edit.clip.sourceInFrame,
      versionId: edit.nodeAssetId, title: edit.nodeName ?? assetName(asset, kind)});
  }
  if (edit.copyFromClipId) {
    const source = context.timeline.clips.find(clip => clip.id === edit.copyFromClipId);
    if (!source || source.trackId !== context.timeline.mainTrack.trackId) return failure('CLIP_NOT_FOUND', [edit.copyFromClipId]);
    const sourceNodeId = source.sequenceSource?.nodeId;
    const node = sourceNodeId ? context.board.nodes.find(item => item.id === sourceNodeId) : undefined;
    if (!node || !sourceNodeId) return failure('CLIP_NOT_FOUND', [edit.copyFromClipId]);
    const media = context.media.find(item => item.nodeId === sourceNodeId);
    if (!media) return failure('MISSING_MEDIA', [sourceNodeId]);
    const copied = context.shots.get(sourceNodeId);
    if (node.kind === 'shot') {
      if (!copied) return failure('INVALID_MEDIA', [sourceNodeId]);
      const selected = source.versionId ?? null;
      const shotRow = {...copyFormat5ShotDialogue(copied, edit.clip.nodeId), id: edit.clip.nodeId,
        selectedVersionId: selected, createdAt: now(), updatedAt: now()};
      const version = selected === null ? undefined : context.versions.get(selected);
      if (selected !== null && !version) return failure('INVALID_MEDIA', [selected]);
      const adoptionRow = version === undefined ? undefined : {id: randomUUID(), projectId: context.projectId,
        shotId: edit.clip.nodeId, versionId: selected!, createdAt: now()};
      const mediaCopy = {nodeId: edit.clip.nodeId, selectedVersion: selected === null ? null
        : (media.selectedVersion === null ? null : {id: media.selectedVersion.id, sourceFrames: media.selectedVersion.sourceFrames}),
        durationFrames: media.durationFrames};
      return planMainInsert(context, {nodeId: edit.clip.nodeId, clipId: edit.clip.id, beforeClipId: edit.beforeClipId,
        kind: 'shot', media: mediaCopy, shotRow, ...(adoptionRow ? {adoptionRow} : {}),
        durationFrames: edit.clip.durationFrames, sourceInFrame: edit.clip.sourceInFrame,
        versionId: selected, title: typeof copied.title === 'string' ? copied.title : 'Clip'});
    }
    const nodeRow = context.nodeRows.get(sourceNodeId);
    if (!nodeRow) return failure('INVALID_MEDIA', [sourceNodeId]);
    const mediaCopy = {nodeId: edit.clip.nodeId, selectedVersion: media.selectedVersion === null ? null
      : {id: media.selectedVersion.id, sourceFrames: media.selectedVersion.sourceFrames}, durationFrames: media.durationFrames};
    return planMainInsert(context, {nodeId: edit.clip.nodeId, clipId: edit.clip.id, beforeClipId: edit.beforeClipId,
      kind: node.kind as 'image' | 'video', media: mediaCopy, nodeRow: {...nodeRow, id: edit.clip.nodeId},
      durationFrames: edit.clip.durationFrames, sourceInFrame: edit.clip.sourceInFrame,
      versionId: edit.clip.versionId, title: assetName(context.assets.get(String(media.selectedVersion?.id)) ?? {}, 'Clip')});
  }
  return failure('SEQUENCE_EDIT_CONTRACT_INVALID', [edit.clip.nodeId]);
}
function expandedOverlayPlan(context: SyncContext, edit: Extract<TrackSyncEdit, {kind: 'add-overlay'}>):
  SequenceEditPlan | SequenceEditTransactionFailure {
  const mainTrackId = context.timeline.mainTrack.trackId;
  if (edit.trackId === mainTrackId) return failure('INVALID_TRACK_TARGET', [edit.trackId]);
  const track = context.timeline.tracks.find(item => item.id === edit.trackId);
  if (!track) return failure('INVALID_TRACK_TARGET', [edit.trackId]);
  const owner = ownerAt(context, edit.startFrame);
  if (!owner) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', [edit.trackId]);
  let clip: Format5Clip;
  if (edit.copyFromClipId) {
    const source = context.timeline.clips.find(item => item.id === edit.copyFromClipId);
    if (!source || source.trackId === mainTrackId || !source.assetId) return failure('CLIP_NOT_FOUND', [edit.copyFromClipId]);
    const {sequenceSource: _source, ...sourceBase} = source;
    clip = {...sourceBase, id: edit.clipId, trackId: edit.trackId, startFrame: edit.startFrame,
      durationFrames: edit.durationFrames, sourceInFrame: edit.sourceInFrame,
      anchor: {clipId: owner.id, offsetFrames: edit.startFrame - owner.startFrame}};
    if (source.sourceState === 'placeholder') return failure('INVALID_MEDIA', [source.id]);
    if (track.kind === 'audio' && !String(context.assets.get(source.assetId)?.mimeType).startsWith('audio/'))
      return failure('INVALID_TRACK_TARGET', [edit.trackId]);
    if (track.kind === 'video' && String(context.assets.get(source.assetId)?.mimeType).startsWith('audio/'))
      return failure('INVALID_TRACK_TARGET', [edit.trackId]);
  } else {
    const asset = edit.assetId ? context.assets.get(edit.assetId) : undefined;
    if (!asset || asset.projectId !== context.projectId) return failure('INVALID_MEDIA', [edit.assetId ?? '']);
    const kind = assetKindOf(asset);
    if (kind === null) return failure('INVALID_MEDIA', [edit.assetId!]);
    if (track.kind === 'audio' ? kind !== 'audio' : kind === 'audio') return failure('INVALID_TRACK_TARGET', [edit.trackId]);
    clip = overlayClipForAsset(context, asset, kind, edit.clipId, edit.trackId, edit.startFrame, edit.durationFrames, owner);
  }
  return planOverlayInsert(context, clip, owner);
}
/** Expand the two minimal ED intents into the exact add/add-overlay envelope
 * the UI will confirm. Allocation ids are added before the envelope digest. */
function expandMinimalSequenceSync(context: SyncContext, envelope: SequenceEditEnvelope): SequenceEditEnvelope | SequenceEditTransactionFailure {
  const operation = envelope.intents[0]?.operation;
  if (operation?.kind !== 'track') return envelope;
  const edit = operation.edit;
  if (edit.kind !== 'insert-asset' && edit.kind !== 'paste-clip') return envelope;
  const allocation = envelope.allocation.clips as {nodeId: string; clipId: string}[];
  const allocated = allocation[0];
  const mainTrackId = context.timeline.mainTrack.trackId;
  if (edit.kind === 'insert-asset') {
    const asset = context.assets.get(edit.assetId);
    if (!asset || asset.projectId !== context.projectId) return failure('INVALID_MEDIA', [edit.assetId]);
    const kind = assetKindOf(asset);
    if (kind === null) return failure('INVALID_MEDIA', [edit.assetId]);
    const targetTrackId = edit.trackId ?? mainTrackId;
    const track = context.timeline.tracks.find(item => item.id === targetTrackId);
    if (!track) return failure('INVALID_TRACK_TARGET', [targetTrackId]);
    const main = targetTrackId === mainTrackId;
    if (main ? kind === 'audio' : track.kind !== (kind === 'audio' ? 'audio' : 'video'))
      return failure('INVALID_TRACK_TARGET', [targetTrackId]);
    const frames = assetFrames(asset, kind);
    if (frames === null || frames < 1 || frames > 18000) return failure('INVALID_CLIP_FRAMES', [edit.assetId]);
    if (main) {
      const ids = allocated ?? {nodeId: randomUUID(), clipId: randomUUID()};
      if (!allocated) allocation.push(ids);
      const addEdit: TrackSyncEdit = {kind: 'add', clip: {id: ids.clipId, nodeId: ids.nodeId, versionId: null,
        versionLocked: false, startFrame: 0, durationFrames: frames, sourceInFrame: 0, splitGroupId: ids.clipId},
        beforeClipId: insertionBefore(context, edit.startFrame), nodeKind: kind as 'image' | 'video',
        nodeAssetId: edit.assetId, nodeName: assetName(asset, kind)};
      return {...envelope, intents: [{side: 'timeline', operation: {kind: 'track', edit: addEdit}}]};
    }
    if (!ownerAt(context, edit.startFrame)) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', [targetTrackId]);
    const ids = allocated ?? {nodeId: targetTrackId, clipId: randomUUID()};
    if (!allocated) allocation.push(ids);
    const overlayEdit: TrackSyncEdit = {kind: 'add-overlay', clipId: ids.clipId, trackId: targetTrackId,
      startFrame: edit.startFrame, durationFrames: frames, sourceInFrame: 0,
      name: assetName(asset, kind === 'audio' ? 'Audio' : kind), assetId: edit.assetId};
    return {...envelope, intents: [{side: 'timeline', operation: {kind: 'track', edit: overlayEdit}}]};
  }
  const source = context.timeline.clips.find(clip => clip.id === edit.clipId);
  if (!source) return failure('CLIP_NOT_FOUND', [edit.clipId]);
  if (source.trackId === mainTrackId) {
    const ids = allocated ?? {nodeId: randomUUID(), clipId: randomUUID()};
    if (!allocated) allocation.push(ids);
    // A media node uses its asset ID as the playable media identity; a shot
    // copy uses the applied immutable version ID.
    const copiedVersionId = source.sequenceSource?.kind === 'media' ? source.assetId : source.versionId ?? null;
    const addEdit: TrackSyncEdit = {kind: 'add', clip: {id: ids.clipId, nodeId: ids.nodeId,
      versionId: copiedVersionId, versionLocked: false, startFrame: 0,
      durationFrames: source.durationFrames, sourceInFrame: source.sourceInFrame, splitGroupId: ids.clipId},
      beforeClipId: insertionBefore(context, edit.startFrame), copyFromClipId: source.id};
    return {...envelope, intents: [{side: 'timeline', operation: {kind: 'track', edit: addEdit}}]};
  }
  if (!ownerAt(context, edit.startFrame)) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', [source.trackId]);
  const ids = allocated ?? {nodeId: source.trackId, clipId: randomUUID()};
  if (!allocated) allocation.push(ids);
  const overlayEdit: TrackSyncEdit = {kind: 'add-overlay', clipId: ids.clipId, trackId: source.trackId,
    startFrame: edit.startFrame, durationFrames: source.durationFrames, sourceInFrame: source.sourceInFrame,
    name: source.name || 'Clip', copyFromClipId: source.id};
  return {...envelope, intents: [{side: 'timeline', operation: {kind: 'track', edit: overlayEdit}}]};
}

function planEnvelope(context: SyncContext, envelope: SequenceEditEnvelope, sceneCuts?: readonly number[]): SequenceEditPlan | SequenceEditTransactionFailure {
  if (envelope.generateIntent) {
    const operation = envelope.generateIntent.operation;
    return operation.kind === 'generate-placeholder'
      ? planGeneratePlaceholder(context, envelope, operation)
      : planGenerateResize(context, envelope, operation);
  }
  if (envelope.intents.length !== 1) return failure('SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE', []);
  const operation = envelope.intents[0]!.operation;
  if (operation.kind === 'track' && operation.edit.kind === 'add' && (operation.edit.nodeAssetId || operation.edit.copyFromClipId))
    return expandedAddPlan(context, envelope, operation.edit);
  if (operation.kind === 'track' && operation.edit.kind === 'add-overlay')
    return expandedOverlayPlan(context, operation.edit);
  if (operation.kind === 'track' && (operation.edit.kind === 'insert-asset' || operation.edit.kind === 'paste-clip'))
    return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (operation.kind === 'track' && operation.edit.kind === 'split-at-scenes') {
    return planSceneSplit(context, envelope, operation.edit, sceneCuts ?? []);
  }
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

/** Result of projecting one SA plan onto the timeline half. `changedCueIds`
 * and `removedCueIds` are exactly the cue rows the history patch must carry;
 * `subtitles` is the three-state profile change (a first projected dialogue cue
 * creates the subtitle layout). */
export interface MainTrackProjection {
  readonly timeline: Format5Timeline;
  readonly changedCueIds: readonly string[];
  readonly removedCueIds: readonly string[];
  readonly subtitles: SequenceEditSubtitleProfileChange;
}
export type MainTrackProjectionOutcome =
  | {readonly ok: true; readonly projection: MainTrackProjection}
  | SequenceEditTransactionFailure;

function subtitleProfileOf(timeline: Format5Timeline,
  change: SequenceEditSubtitleProfileChange): {profileId: string; basisPresetId?: string} | null {
  if (change.kind === 'unchanged') {
    return timeline.subtitles ? {profileId: timeline.subtitles.profileId,
      ...(timeline.subtitles.basisPresetId === undefined ? {} : {basisPresetId: timeline.subtitles.basisPresetId})} : null;
  }
  return change.kind === 'set' ? change.value as {profileId: string; basisPresetId?: string} : null;
}

/**
 * Patch the main track from one SA plan and, in the same read, project every
 * main-track shot's dialogue lines to real cues (DL-a). `extraShots` carries the
 * rows this action is about to create (copied / restored / created shots) so the
 * projection sees the dialogue they will have. Anchors that lose their owner
 * detach in place (`anchor: null`) instead of silently re-anchoring elsewhere
 * (plan §2.3); a cue whose shot leaves the main track keeps its absolute frame.
 */
function patchMainTimeline(context: SyncContext, plan: SequenceEditPlan,
  extraShots: ReadonlyMap<string, Row> = new Map()): MainTrackProjectionOutcome {
  const existing = new Map(context.timeline.clips.map(clip => [clip.id, clip]));
  const mainTrackId = context.timeline.mainTrack.trackId;
  const planNodes = new Map(plan.after.board.nodes.map(node => [node.id, node]));
  const copiedNodes = new Set(plan.copiedNode ? [plan.copiedNode.toNodeId] : []);
  const meta = metadataOf(plan);
  const mainClips = plan.after.clips.map(clip => nextMainClip(context, clip, existing.get(clip.id), planNodes.get(clip.nodeId), copiedNodes));
  if (meta) for (const clip of mainClips) {const name = meta.clipNames.get(clip.id); if (name) clip.name = name;}
  // GE-b: a generation placeholder is named after the shot it creates. The new
  // shot is not in `context.shots` yet while the plan is projected, so the
  // generic nodeName fallback would name the clip "Clip" in every locale.
  const generatedShot = generatedShotMeta.get(plan)?.shot;
  if (generatedShot && typeof generatedShot.title === 'string' && generatedShot.title) {
    for (const clip of mainClips) if (clip.sequenceSource?.nodeId === generatedShot.id) clip.name = generatedShot.title;
  }
  const ownerList = mainClips.map(clip => ({id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames}));
  const ownerSegments = new Map(ownerList.map(owner => [owner.id, owner] as const));
  const anchored = new Map(plan.after.anchored.map(item => [item.id, item]));
  // Other-track rows this action removes are dropped from the projection; the
  // patch carries the removal and undo restores the exact before row.
  const removedAnchored = new Set<string>();
  for (const change of plan.changes.anchored) {
    if (change.before && !change.after) removedAnchored.add(change.before.id);
  }
  const clips: Format5Clip[] = [...mainClips];
  const generatedOther = generatedShotMeta.get(plan)?.otherClip;
  if (generatedOther) clips.push(generatedOther);
  for (const clip of context.timeline.clips) {
    if (clip.trackId === mainTrackId || removedAnchored.has(clip.id)) continue;
    const item = anchored.get(clip.id);
    const startFrame = item?.startFrame ?? clip.startFrame;
    clips.push({...clip, startFrame, anchor: item ? anchorForOwner(item, ownerSegments) ?? null : clip.anchor ?? null});
  }
  // A segment moved off the main track keeps its content but becomes an
  // other-track item with an explicit anchor.
  if (meta) for (const clip of meta.extraOtherClips) clips.push(clip);
  if (plan.transfer) {
    const original = existing.get(plan.transfer.clip.id);
    if (!original) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '转移的片段不存在。', 409, {id: plan.transfer.clip.id});
    const item = anchored.get(plan.transfer.clip.id);
    const {sequenceSource: _removedSource, ...otherTrack} = original;
    void _removedSource;
    clips.push({...otherTrack, trackId: plan.transfer.trackId, startFrame: plan.transfer.clip.startFrame,
      anchor: item ? anchorForOwner(item, ownerSegments) : null});
  }
  // Anchors that no longer resolve detach in place; the absolute frame is kept.
  const movedCues: Format5Cue[] = (context.timeline.subtitles?.cues ?? []).map(cue => {
    const item = anchored.get(cue.id);
    if (!item) return cue;
    const startFrame = item.startFrame;
    const anchor = anchorForOwner(item, ownerSegments);
    if (anchor !== null && startFrame === cue.startFrame && sameJson(anchor, cue.anchor ?? null)) return cue;
    return {...cue, startFrame, anchor};
  });
  // Dialogue projection: the rows this action creates are visible to it.
  const mergedShots = extraShots.size === 0 ? context.shots : new Map([...context.shots, ...extraShots]);
  const segmentsByShot = new Map<string, {clipId: string; startFrame: number; durationFrames: number}[]>();
  for (const clip of mainClips) {
    const source = clip.sequenceSource;
    if (source?.kind !== 'shot') continue;
    const segments = segmentsByShot.get(source.nodeId) ?? [];
    segments.push({clipId: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames});
    segmentsByShot.set(source.nodeId, segments);
  }
  const previousMainShotIds = new Set<string>();
  for (const clip of context.timeline.clips) {
    if (clip.trackId !== mainTrackId || clip.sequenceSource?.kind !== 'shot') continue;
    previousMainShotIds.add(clip.sequenceSource.nodeId);
  }
  const projectedShots: Format5DialogueProjectedShot[] = [];
  for (const shotId of [...segmentsByShot.keys()].sort()) {
    const shotRow = mergedShots.get(shotId);
    if (!shotRow) throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
    const dialogue = format5ShotDialogue(shotRow);
    if (dialogue.length === 0) continue;
    projectedShots.push({shotId, lines: dialogue.map(line => ({id: line.id, text: line.text})),
      segments: segmentsByShot.get(shotId)!.sort((left, right) => left.startFrame - right.startFrame || left.clipId.localeCompare(right.clipId))});
  }
  const hasDialogueCues = movedCues.some(cue => cue.dialogueRef !== undefined);
  let cues = movedCues;
  let projection: Format5DialogueProjectionResult | null = null;
  if (projectedShots.length > 0 || hasDialogueCues) {
    projection = projectFormat5DialogueCues({
      timelineId: context.timeline.id, cues: movedCues,
      subtitleProfilePresent: context.timeline.subtitles !== undefined,
      shots: projectedShots, previousMainShotIds,
      previousCues: new Map((context.timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const)),
      liveShotIds: new Set(plan.after.board.nodes.map(node => node.id).filter(nodeId => mergedShots.has(nodeId))),
    });
    if (projection.ok === false) return {ok: false, code: projection.code as SequenceEditErrorCode, ids: projection.ids};
    cues = projection.cues as Format5Cue[];
  }
  const clipEnds = clips.map(clip => clip.startFrame + clip.durationFrames);
  const durationFrames = clipEnds.reduce((maximum, value) => Math.max(maximum, value), 0);
  const subtitleChange: SequenceEditSubtitleProfileChange = projection?.subtitles ?? {kind: 'unchanged'};
  const profile = subtitleProfileOf(context.timeline, subtitleChange);
  const beforeCues = new Map((context.timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const afterCues = new Map(cues.map(cue => [cue.id, cue] as const));
  const changedCueIds = new Set<string>(projection?.changedCueIds ?? []);
  for (const change of plan.changes.anchored) {
    const cueId = change.after?.id ?? change.before?.id;
    if (typeof cueId !== 'string' || (!beforeCues.has(cueId) && !afterCues.has(cueId))) continue;
    if (!sameJson(beforeCues.get(cueId), afterCues.get(cueId))) changedCueIds.add(cueId);
  }
  const nextTimeline: Format5Timeline = {...context.timeline, revision: context.timeline.revision + 1, updatedAt: now(),
    durationFrames, clips, subtitles: profile ? {...profile, cues} : undefined};
  return {ok: true, projection: {timeline: nextTimeline,
    changedCueIds: [...changedCueIds].filter(id => afterCues.has(id)).sort(),
    removedCueIds: [...(projection?.removedCueIds ?? [])].sort(),
    subtitles: subtitleChange}};
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

/** A fixed-media clip shares its source with the board node and the sync
 * baseline. Only an independent node can change without editing other objects. */
export function planFixedMediaClipSources(store: ProjectStore, timeline: Format5Timeline,
  nextClips: readonly Format5Clip[]): {before: SequenceEditStateDelta; after: SequenceEditStateDelta} {
  const context = readSyncContext(store);
  const nodeRows = new Map<string, Row>();
  const before = emptyDelta(), after = emptyDelta();
  const beforeNodes: SequenceEditBoardEntity[] = [], afterNodes: SequenceEditBoardEntity[] = [];
  function invalid(clip: Format5Clip, message: string): never {
    throw new AppError('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', message, 409, {clipId: clip.id});
  }
  const originalById = new Map(timeline.clips.map(clip => [clip.id, clip]));
  const hasFrozenReference = store.db.prepare(`
    SELECT 1 FROM (
      SELECT data FROM project.versions WHERE projectId=?
      UNION ALL SELECT data FROM main.jobs WHERE projectId=?
    ) AS owner, json_each(owner.data, '$.snapshot.referenceConnections') AS ref
    WHERE CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.sourceNodeId') END=?
    LIMIT 1`);
  for (const clip of nextClips) {
    const original = originalById.get(clip.id);
    const source = original?.sequenceSource;
    const row = source?.kind === 'media' ? context.nodeRows.get(source.nodeId) : undefined;
    if (!source || source.kind !== 'media' || !row || row.assetId !== original?.assetId) {
      invalid(clip, '主轨片段与画板素材的绑定无效');
    }
    const nodeId = source.nodeId;
    if (context.clips.some(item => item.nodeId === nodeId && item.id !== clip.id)) {
      invalid(clip, '拆分片段共享同一个画板节点，不能只替换其中一段');
    }
    const isReference = (edge: Row): boolean => edge.kind === 'reference' && edge.source === nodeId;
    if ([...context.edgeRows.values()].some(isReference) || [...context.archivedEdges.values()].some(isReference)
      || hasFrozenReference.get(store.projectId, store.projectId, nodeId)) {
      invalid(clip, '画板节点仍作为引用素材，不能改变其来源');
    }
    const revision = Number.isSafeInteger(row.revision) ? Number(row.revision) + 1 : 1;
    if (!Number.isSafeInteger(revision)) invalid(clip, '画板节点修订号已达到上限');
    const next = {...row, assetId: clip.assetId, revision, updatedAt: now()};
    nodeRows.set(nodeId, next);
    beforeNodes.push({kind: 'node', id: nodeId, data: row});
    afterNodes.push({kind: 'node', id: nodeId, data: next});
  }
  const replacements = new Map(nextClips.map(clip => [clip.id, clip]));
  const draft = {...timeline, clips: timeline.clips.map(clip => replacements.get(clip.id) ?? clip)};
  const nextBaseline = buildBaseline(context, draft, new Map(), new Map(), new Map(), nodeRows);
  return {
    before: {board: {...before.board, writes: beforeNodes},
      timeline: {...before.timeline, baseline: {kind: 'set', value: context.baseline}}},
    after: {board: {...after.board, writes: afterNodes},
      timeline: {...after.timeline, baseline: {kind: 'set', value: nextBaseline}}},
  };
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
  const generated = generatedShotMeta.get(plan);
  if (generated) {
    extraShots.set(generated.nodeId, generated.shot);
    extraNodeKinds.set(generated.nodeId, 'shot');
    writesAfter.push({kind: 'shot', id: generated.nodeId, data: generated.shot});
    removalsBefore.push({kind: 'shot', id: generated.nodeId, data: generated.shot});
  }
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
      // Copying a shot generates fresh dialogue line ids (plan §2.4) so the copy
      // never shares a line identity with its source.
      const shot: Row = copyFormat5ShotDialogue({...sourceShot, id: toNodeId,
        selectedVersionId: copiedClip.versionId ?? null, createdAt: now(), updatedAt: now()}, toNodeId);
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
  const meta = metadataOf(plan);
  if (meta) {
    for (const [id, row] of meta.nodeRows) {
      if (context.board.nodes.some(node => node.id === id)) continue;
      const kind = meta.nodeKinds.get(id);
      if (!kind) continue;
      writesAfter.push({kind: 'node', id, data: row});
      removalsBefore.push({kind: 'node', id, data: row});
      extraNodeRows.set(id, row);
      extraNodeKinds.set(id, kind);
    }
    for (const [id, row] of meta.shotRows) {
      writesAfter.push({kind: 'shot', id, data: row});
      removalsBefore.push({kind: 'shot', id, data: row});
      extraShots.set(id, row);
    }
    for (const [id, row] of meta.adoptionRows) {
      writesAfter.push({kind: 'adoption', id, data: row});
      removalsBefore.push({kind: 'adoption', id, data: row});
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
    // A cue may be unattached (`anchor: null`): a floating shot keeps its
    // subtitles in place until it re-enters the main track (plan §2.3/§2.4).
    if (cue.startFrame < 0 || cue.startFrame + cue.durationFrames > timeline.durationFrames) {
      problems.add(cue.id);
      continue;
    }
    const anchor = cue.anchor ?? null;
    if (anchor === null) continue;
    const owner = owners.get(anchor.clipId);
    if (!owner || anchor.offsetFrames < 0 || anchor.offsetFrames >= owner.durationFrames
      || cue.startFrame !== owner.startFrame + anchor.offsetFrames) problems.add(cue.id);
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
  nextBaseline: Format5SyncBaseline, additionalChangedClipIds: readonly string[] = [],
  projection: MainTrackProjection): SequenceEditPatch {
  const beforeClips = new Map(context.timeline.clips.map(clip => [clip.id, clip] as const));
  const afterClips = new Map(nextTimeline.clips.map(clip => [clip.id, clip] as const));
  const beforeCues = new Map((context.timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  const afterCues = new Map((nextTimeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
  // SA already reports every changed clip/anchored item; restricting the patch to
  // those ids keeps a 500-segment edit from re-serializing the whole projection.
  // Cue rows also come from the dialogue projection's touched set (DL-a).
  const changedIds = new Set<string>();
  for (const item of [...plan.changes.clips.map(change => change.after?.id ?? change.before?.id),
    ...plan.changes.anchored.map(change => change.after?.id ?? change.before?.id),
    ...additionalChangedClipIds]) if (item) changedIds.add(item);
  // SA reports an anchored item only when its start frame changes; an owner
  // detach/re-anchor can keep the same frame, so compare the anchor identity too.
  for (const item of context.anchored) {
    const beforeRow = beforeClips.get(item.id) ?? beforeCues.get(item.id);
    const afterRow = afterClips.get(item.id) ?? afterCues.get(item.id);
    if (!sameJson(beforeRow, afterRow)) changedIds.add(item.id);
  }
  for (const item of plan.after.anchored) if (!beforeClips.has(item.id) && !beforeCues.has(item.id)) changedIds.add(item.id);
  const clipIds = [...changedIds].filter(id => beforeClips.has(id) || afterClips.has(id));
  const cueIds = new Set<string>([...changedIds].filter(id => beforeCues.has(id) || afterCues.has(id)));
  for (const id of [...projection.changedCueIds, ...projection.removedCueIds]) cueIds.add(id);
  const baselineChanged = !sameJson(context.baseline, nextBaseline);
  const baselineAfter: SequenceEditBaselineChange = baselineChanged ? {kind: 'set', value: nextBaseline} : {kind: 'unchanged'};
  const baselineBefore: SequenceEditBaselineChange = baselineChanged ? {kind: 'set', value: context.baseline} : {kind: 'unchanged'};
  const subtitlesAfter: SequenceEditSubtitleProfileChange = projection.subtitles;
  const subtitlesBefore: SequenceEditSubtitleProfileChange = subtitlesAfter.kind === 'set'
    ? (context.timeline.subtitles ? {kind: 'unchanged'} : {kind: 'absent'}) : {kind: 'unchanged'};
  return {
    version: 1,
    before: {board: board.before, timeline: {
      clips: clipIds.filter(id => beforeClips.has(id)).map(id => beforeClips.get(id)!) as unknown as Format5Clip[],
      cues: [...cueIds].filter(id => beforeCues.has(id)).sort().map(id => beforeCues.get(id)!) as unknown as Format5Cue[],
      removedClipIds: clipIds.filter(id => !beforeClips.has(id)),
      removedCueIds: [...cueIds].filter(id => !beforeCues.has(id)).sort(),
      baseline: baselineBefore, subtitles: subtitlesBefore,
    }},
    after: {board: board.after, timeline: {
      clips: clipIds.filter(id => afterClips.has(id)).map(id => afterClips.get(id)!) as unknown as Format5Clip[],
      cues: [...cueIds].filter(id => afterCues.has(id)).sort().map(id => afterCues.get(id)!) as unknown as Format5Cue[],
      removedClipIds: clipIds.filter(id => !afterClips.has(id)),
      removedCueIds: [...cueIds].filter(id => !afterCues.has(id)).sort(),
      baseline: baselineAfter, subtitles: subtitlesAfter,
    }},
  };
}

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
export function applySubjectBindingWrite(store: ProjectStore, data: Row): void {
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
  const header = delta.header?.kind === 'set' ? delta.header.value : null;
  const next: Format5Timeline = {...current, revision: current.revision + 1, updatedAt: now(), durationFrames,
    ...(header ? {fps: header.fps, width: header.width, height: header.height} : {}),
    tracks: delta.tracks ? [...delta.tracks] : current.tracks,
    clips: [...clips.values()], subtitles: subtitleProfile ? {...subtitleProfile, cues: [...cues.values()]} : undefined};
  // Validate the rows against the header the patch asks for: an undo restores
  // the old header together with clips that intentionally have no layout, and a
  // track-adding action must validate its new clip against that same header.
  const planHeader = {...(header ?? {}), ...(delta.tracks ? {tracks: delta.tracks} : {})};
  const planState = (header || delta.tracks) && state.header
    ? {...state, header: {...state.header, raw: JSON.stringify({...JSON.parse(state.header.raw), ...planHeader})}}
    : state;
  const update = planFormat5TimelineEntityUpdate(planState, {clips: delta.clips, cues: delta.cues,
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

function allocationForCommand(context: SyncContext, command: SequenceSyncCommand, cuts: readonly number[] = []) {
  const allocation = {clips: [] as {nodeId: string; clipId: string}[], nodes: [] as {fromNodeId: string; nodeId: string}[],
    splitClips: [] as {clipId: string; rightClipId: string}[], edges: [] as {id: string; fromId: string; toId: string}[]};
  if (command.kind === 'sync-board') {
    allocation.clips = Object.entries(command.newClipIds ?? {}).map(([nodeId, clipId]) => ({nodeId, clipId}));
  } else if (command.kind === 'clip-add') {
    allocation.clips.push({nodeId: command.clip.nodeId, clipId: command.clip.id});
  } else if (command.kind === 'clip-split') {
    allocation.splitClips.push({clipId: command.clipId, rightClipId: command.rightClipId});
  } else if (command.kind === 'clip-split-scenes') {
    for (const target of sceneSplitTargets(context.timeline, cuts, command.assetId).targets) {
      let current = target.clip.id;
      for (const _cut of target.allowed) {
        const rightClipId = randomUUID();
        allocation.splitClips.push({clipId: current, rightClipId});
        current = rightClipId;
      }
    }
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
function sceneCutFailure(error: unknown): SequenceEditTransactionFailure {
  const code = (error as {code?: unknown})?.code;
  if (code === 'SCENE_RESULT_CONFLICT') return failure('SEQUENCE_EDIT_SCENE_RESULT_CONFLICT', []);
  if (code === 'SCENE_RESULT_STALE') return failure('SEQUENCE_EDIT_SCENE_RESULT_STALE', []);
  if (code === 'SCENE_NOT_FOUND') return failure('SEQUENCE_EDIT_REVISION_CONFLICT', []);
  return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
}
/** GE-a: preview one generation placement/resize envelope. The shot and clip
 * identities are already in the server-built intent; this only plans, validates
 * and projects the impact, never writes the shot or submits a job. */
export function previewGenerateInEditing(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio';
  readonly generateIntent: NonNullable<SequenceEditEnvelope['generateIntent']>;
}): {readonly envelope: SequenceEditEnvelope; readonly planDigest: string;
  readonly warnings: readonly ChainSyncWarning[]} | SequenceEditTransactionFailure {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const context = readSyncContext(store);
    const state = prepareSequenceEditHistory(store).state;
    const content = readProjectContentStamp(store.db).contentSequence;
    const operation = input.generateIntent.operation;
    const allocation: SequenceEditEnvelope['allocation'] = {clips: operation.kind === 'generate-placeholder'
      ? [{nodeId: operation.shotId, clipId: operation.clipId}] : [],
      nodes: [], splitClips: [], edges: []};
    const provisional: SequenceEditEnvelope = {
      contractVersion: 1, projectId: store.projectId, epoch: state.epoch,
      actionId: input.actionId ?? randomUUID(), requestId: input.requestId,
      originSide: 'timeline', filmId: context.rootNodeId, intents: [], ...(input.origin ? {origin: input.origin} : {}),
      generateIntent: input.generateIntent,
      baseline: {contentRevision: content, timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
        historyPosition: state.position, historyRevision: state.revision, targets: []},
      impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
      allocation,
    };
    const plan = planEnvelope(context, provisional);
    if ('ok' in plan && plan.ok === false) return plan;
    const successful = plan as SequenceEditPlan;
    allocateEdgeIds(context, successful, allocation as unknown as {edges: {id: string; fromId: string; toId: string}[]});
    const boardPlan = boardPlanEntities(context, successful, provisional);
    if ('ok' in boardPlan && boardPlan.ok === false) return boardPlan;
    const boardEntities = boardPlan as BoardPlanEntities;
    const projected = patchMainTimeline(context, successful, boardEntities.extraShots);
    if (projected.ok === false) return projected;
    const nextTimeline = projected.projection.timeline;
    const anchorIssue = validateAnchoredTimeline(nextTimeline);
    if (anchorIssue) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', anchorIssue.ids);
    const mainTrackId = context.timeline.mainTrack.trackId;
    const generatedOther = generatedShotMeta.get(successful)?.otherClip;
    const changedIds = successful.changes.clips.map(change => change.after?.id ?? change.before?.id)
      .filter((id): id is string => typeof id === 'string');
    if (generatedOther) changedIds.push(generatedOther.id);
    const impact: SequenceEditImpact = {
      nodeIds: operation.kind === 'generate-placeholder' ? [operation.shotId] : [],
      edgeIds: allocation.edges.map(edge => edge.id),
      mainTrackClipIds: changedIds.filter(id => nextTimeline.clips.some(clip => clip.id === id && clip.trackId === mainTrackId)),
      otherTrackItemIds: generatedOther ? [generatedOther.id] : [],
      subtitleCueIds: [...projected.projection.changedCueIds, ...projected.projection.removedCueIds].sort(),
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

export function previewSequenceSync(store: ProjectStore, command: SequenceSyncCommand,
  options: {readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio'}): SequenceSyncPreview | SequenceEditTransactionFailure {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const context = readSyncContext(store);
    const intent = sequenceSyncIntent(command);
    let cuts: number[] = [];
    if (command.kind === 'clip-split-scenes') {
      try { cuts = readSceneSplitCuts(store.db, store.projectId, command.assetId, command.resultId); }
      catch (error) { return sceneCutFailure(error); }
    }
    const {state} = prepareSequenceEditHistory(store);
    const content = readProjectContentStamp(store.db).contentSequence;
    const allocation = allocationForCommand(context, command, cuts);
    const provisional: SequenceEditEnvelope = {
      contractVersion: 1, projectId: store.projectId, epoch: state.epoch,
      actionId: options.actionId ?? randomUUID(), requestId: options.requestId,
      originSide: intent.side, filmId: context.rootNodeId, intents: [intent], ...(options.origin ? {origin: options.origin} : {}),
      baseline: {contentRevision: content, timelineRevision: context.timeline.revision, syncRevision: context.syncRevision,
        historyPosition: state.position, historyRevision: state.revision, targets: []},
      impact: {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []},
      allocation,
    };
    const expanded = expandMinimalSequenceSync(context, provisional);
    if ((expanded as SequenceEditTransactionFailure).ok === false) return expanded as SequenceEditTransactionFailure;
    const effective = expanded as SequenceEditEnvelope;
    const plan = planEnvelope(context, effective, cuts);
    if ('ok' in plan && plan.ok === false) return plan;
    const successful = plan as SequenceEditPlan;
    const mainTrackId = context.timeline.mainTrack.trackId;
    // New sequence-edge identities must be in the envelope before the board half
    // reads the allocation; the timeline projection then sees the shot rows
    // (copied/restored) this action creates, so dialogue/anchor conflicts are
    // reported before confirmation.
    allocateEdgeIds(context, successful, allocation as unknown as {edges: {id: string; fromId: string; toId: string}[]});
    const boardPlan = boardPlanEntities(context, successful, provisional);
    if ('ok' in boardPlan && boardPlan.ok === false) return boardPlan;
    const boardEntities = boardPlan as BoardPlanEntities;
    const projected = patchMainTimeline(context, successful, boardEntities.extraShots);
    if (projected.ok === false) return projected;
    const projection = projected.projection;
    let nextTimeline = projection.timeline;
    const sceneData = command.kind === 'clip-split-scenes'
      ? applyOtherTrackSceneSplits(nextTimeline, context, provisional, cuts) : null;
    if (sceneData) nextTimeline = sceneData.timeline;
    const transfer = successful.transfer;
    if (transfer && transfer.trackId !== mainTrackId) {
      // The main track compacts before the drop, which can pull anchored clips into its range.
      const {clip: dropped, trackId} = transfer;
      const dropEnd = dropped.startFrame + dropped.durationFrames;
      const blockers = nextTimeline.clips.filter(clip => clip.trackId === trackId && clip.id !== dropped.id
        && clip.startFrame < dropEnd && clip.startFrame + clip.durationFrames > dropped.startFrame);
      if (blockers.length > 0) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', blockers.map(clip => clip.id).sort());
    }
    const anchorIssue = validateAnchoredTimeline(nextTimeline);
    if (anchorIssue) return failure('SEQUENCE_EDIT_ANCHOR_CONFLICT', anchorIssue.ids);
    const mainTrackClipSet = new Set(nextTimeline.clips.filter(clip => clip.trackId === mainTrackId).map(clip => clip.id));
    const otherTrackClipSet = new Set(nextTimeline.clips.filter(clip => clip.trackId !== mainTrackId).map(clip => clip.id));
    const mainClipIds = successful.changes.clips.map(change => change.after?.id ?? change.before?.id)
      .filter((clipId): clipId is string => !!clipId && mainTrackClipSet.has(clipId));
    const otherItemIds = [...new Set(successful.changes.anchored.map(change => change.after?.id ?? change.before?.id).filter((id): id is string => !!id))];
    const newNodeIds = successful.after.board.nodes.filter(node => !context.board.nodes.some(item => item.id === node.id)).map(node => node.id);
    const changedEdgeIds: string[] = [];
    for (const edge of successful.changes.edges) {
      const key = `${edge.after?.fromId ?? edge.before?.fromId}>${edge.after?.toId ?? edge.before?.toId}`;
      const existing = context.edgeRows.values();
      for (const row of existing) if (row.kind === 'sequence' && `${row.source}>${row.target}` === key) changedEdgeIds.push(String(row.id));
    }
    const copiedNodeIds = [...new Set([...successful.changes.nodes.flatMap(change => change.after ? [change.after.id] : []), ...newNodeIds])];
    const extraOtherTrackIds = sceneData
      ? [...new Set(sceneData.split.filter(row => context.timeline.clips.some(clip => clip.id === row.clipId && clip.trackId !== mainTrackId))
        .flatMap(row => row.clipIds.slice(1)))]
      : [];
    const impact: SequenceEditImpact = {
      nodeIds: copiedNodeIds,
      edgeIds: [...new Set([...changedEdgeIds, ...provisional.allocation.edges.map(item => item.id)])],
      mainTrackClipIds: [...new Set(mainClipIds.filter(id => successful.changes.clips.some(change => (change.after?.id ?? change.before?.id) === id)))],
      otherTrackItemIds: [...new Set([...otherItemIds.filter(id => otherTrackClipSet.has(id)), ...extraOtherTrackIds])],
      subtitleCueIds: [...new Set([...otherItemIds.filter(id => (context.timeline.subtitles?.cues ?? []).some(cue => cue.id === id)),
        ...projection.changedCueIds, ...projection.removedCueIds])].sort(),
    };
    const kindName = (kind: 'shot' | 'node' | 'edge' | 'clip' | 'cue'): string =>
      kind === 'clip' ? 'timeline_clip' : kind === 'cue' ? 'timeline_cue' : kind;
    const targets = targetKinds({...effective, impact}).flatMap(target => {
      const row = store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind=? AND targetId=?')
        .get(kindName(target.kind), target.id) as Row | undefined;
      return row && Number.isSafeInteger(row.revision) ? [{kind: target.kind, id: target.id, revision: Number(row.revision)}] : [];
    });
    const envelope: SequenceEditEnvelope = {...effective, allocation, impact, baseline: {...effective.baseline, targets}};
    if (!isSequenceEditEnvelope(envelope)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
    return {envelope, warnings: planWarnings(successful), planDigest: sequenceEditInputDigest(envelope)};
  });
}

/** Read once and project a CS plan onto the timeline half, for
 * `sequence.preview` impact and for rejecting dialogue/anchor conflicts before
 * the user confirms. Never writes. */
export function previewMainTrackProjection(store: ProjectStore, plan: SequenceEditPlan,
  extraShots: ReadonlyMap<string, Row> = new Map()): MainTrackProjectionOutcome {
  return patchMainTimeline(readSyncContext(store), plan, extraShots);
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
  options: {readonly expectedPlanDigest?: string; readonly afterApply?: () => void} = {}): SequenceSyncResult {
  if (!format5(store)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (!isSequenceEditEnvelope(envelope)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  if (envelope.projectId !== store.projectId) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  const inputDigest = sequenceEditInputDigest(envelope);
  if (envelope.subjectIntent) return runSubjectBindingSync(store, envelope, inputDigest);
  if (envelope.referenceIntent) return runReferenceEdgeSync(store, envelope, inputDigest);
  if (envelope.previsIntent) return runPrevisSync(store, envelope, inputDigest);
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
    let sceneCuts: number[] = [];
    const sceneEdit = envelope.intents[0]?.operation;
    if (sceneEdit?.kind === 'track' && sceneEdit.edit.kind === 'split-at-scenes') {
      try { sceneCuts = readSceneSplitCuts(store.db, store.projectId, sceneEdit.edit.assetId, sceneEdit.edit.resultId); }
      catch (error) { const failureResult = sceneCutFailure(error); return writeFailure(store, envelope, failureResult.code); }
    }
    const plan = planEnvelope(context, envelope, sceneCuts);
    if ('ok' in plan && plan.ok === false) return writeFailure(store, envelope, plan.code);
    const successful = plan as SequenceEditPlan;
    const board = boardPlanEntities(context, successful, envelope);
    if ('ok' in board && board.ok === false) return writeFailure(store, envelope, board.code);
    const boardEntities = board as BoardPlanEntities;
    const projected = patchMainTimeline(context, successful, boardEntities.extraShots);
    if (projected.ok === false) return writeFailure(store, envelope, projected.code);
    const projection = projected.projection;
    let nextTimeline = projection.timeline;
    const sceneData = sceneCuts.length && sceneEdit?.kind === 'track' && sceneEdit.edit.kind === 'split-at-scenes'
      ? applyOtherTrackSceneSplits(nextTimeline, context, envelope, sceneCuts) : null;
    if (sceneData) nextTimeline = sceneData.timeline;
    const anchorIssue = validateAnchoredTimeline(nextTimeline);
    if (anchorIssue) return writeFailure(store, envelope, 'SEQUENCE_EDIT_ANCHOR_CONFLICT');
    const changedShots = shotChanges(context, successful);
    const shotUpdates = new Map(changedShots.map(change => [change.after.id as string, change.after] as const));
    const nextBaseline = buildBaseline(context, nextTimeline, shotUpdates, boardEntities.extraShots,
      boardEntities.extraNodeKinds, boardEntities.extraNodeRows);
    const extraClipIds = sceneData
      ? sceneData.split.filter(row => context.timeline.clips.some(clip => clip.id === row.clipId
        && clip.trackId !== context.timeline.mainTrack.trackId)).flatMap(row => row.clipIds.slice(1))
      : generatedShotMeta.get(successful)?.otherClip ? [generatedShotMeta.get(successful)!.otherClip!.id] : [];
    const patch = timelineDeltaPair(context, nextTimeline, successful, boardEntities, nextBaseline, extraClipIds, projection);
    const baselineChanged = !sameJson(context.baseline, nextBaseline);
    const noop = patch.after.board.writes.length === 0 && patch.after.board.removals.length === 0
      && patch.after.timeline.clips.length === 0 && patch.after.timeline.cues.length === 0
      && patch.after.timeline.removedClipIds.length === 0 && patch.after.timeline.removedCueIds.length === 0
      && (patch.after.timeline.subtitles ?? {kind: 'unchanged'}).kind === 'unchanged' && !baselineChanged;
    if (noop) return writeFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
    applyBoardDelta(store, boardEntities.after);
    const timelineApply = applyTimelineDelta(store, patch.after.timeline, context);
    const baselineApply = applyBaselineDelta(store, context, patch.after.timeline.baseline);
    // GE-a submits the paid generation call only after the placeholder rows are
    // visible, but still inside this transaction; a failure rolls both back.
    options.afterApply?.();
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const receipt = {...receiptDraft(envelope, inputDigest, {
      affected: affectedFromDelta(patch.after, context, context.timeline.mainTrack.trackId),
      warnings: planWarnings(successful), contentRevision,
      timelineRevision: timelineApply.timeline.revision, syncRevision: baselineApply.revision,
    }), ...(sceneData ? {sceneSplit: {split: sceneData.split, skipped: sceneData.skipped}} : {})};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}

/** GE-a: adopt the first successful version of an edit-created shot into its
 * placeholder inside the worker's existing transaction. Returns false when the
 * shot moved on (revised or already has a version) or the placeholder is gone;
 * the caller then only records the version as the late-result rule requires. */
export function adoptFormat5GeneratedVersionInside(store: ProjectStore,
  job: {readonly id: string; readonly shotId: string; readonly projectId: string; readonly snapshot: Row},
  version: Row, options: {readonly canReplace?: (clip: Format5Clip) => boolean} = {}): boolean {
  if (!format5(store) || job.projectId !== store.projectId) return false;
  const context = readSyncContext(store);
  const shot = context.shots.get(job.shotId);
  // First ready version of any format-5 shot: the shot must still be live and
  // unselected. Title/prompt/dialogue edits while the job runs never block it.
  if (!shot || shot.selectedVersionId !== null) return false;
  if (!context.assets.has(String(version.assetId))) return false;
  // Follow-mode main pieces and other-track placeholders keep their editing
  // parameters (start, duration, sourceInFrame, gain, rect, fades, anchor/group);
  // only the source identity changes from "not generated yet" to this version.
  const placeholders = context.timeline.clips.filter(clip => clip.sourceState === 'placeholder'
    && (clip.sequenceSource?.kind === 'shot' && clip.sequenceSource.nodeId === job.shotId
      || clip.shotId === job.shotId) && (options.canReplace?.(clip) ?? true));
  if (placeholders.length === 0) return false;
  const ready = placeholders.map(clip => ({...clip, assetId: String(version.assetId),
    versionId: String(version.id), jobId: job.id, shotId: job.shotId, sourceState: 'ready' as const} as Format5Clip));
  const nextTimeline: Format5Timeline = {...context.timeline,
    clips: context.timeline.clips.map(clip => ready.find(item => item.id === clip.id) ?? clip)};
  if (validateAnchoredTimeline(nextTimeline)) return false;
  const nextShot = {...shot, selectedVersionId: String(version.id), updatedAt: now()};
  const nextBaseline = buildBaseline(context, nextTimeline, new Map([[job.shotId, nextShot]]));
  const applied = applyTimelineDelta(store, {clips: ready, cues: [], removedClipIds: [], removedCueIds: [],
    baseline: {kind: 'unchanged'}}, context);
  if (!applied.changed) return false;
  applyBaselineDelta(store, context, {kind: 'set', value: nextBaseline});
  return true;
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
    try { plan = planSubjectEditAction(store, envelope); }
    catch (error) {
      if (error instanceof AppError && isSequenceEditErrorCode(error.code)) {
        return writeFailure(store, envelope, error.code);
      }
      throw error;
    }
    if (sameJson(plan.before.board, plan.after.board)) return writeFailure(store, envelope, 'SEQUENCE_EDIT_NOOP');
    applyBoardDelta(store, plan.after.board);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const nodes = plan.after.board.writes.filter(item => item.kind === 'node' || item.kind === 'shot').length
      + plan.after.board.removals.filter(item => item.kind === 'node' || item.kind === 'shot').length;
    const affected: SequenceEditAffectedCounts = {
      nodes,
      edges: plan.after.board.writes.filter(item => item.kind === 'edge').length
        + plan.after.board.removals.filter(item => item.kind === 'edge').length,
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

/** One shared transaction for a previs create/save: replay, revision CAS, the
 * board node delta, cached thumbnail pruning, one history entry and the
 * immutable receipt. A previs node is a tombstone-free board row: undo restores
 * the recorded full row (or deletes a created one) through the shared patch. */
function runPrevisSync(store: ProjectStore, envelope: SequenceEditEnvelope, inputDigest: string): SequenceSyncResult {
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
    try { plan = planPrevisAction(store, envelope); }
    catch (error) {
      if (error instanceof AppError && isSequenceEditErrorCode(error.code)) {
        return writeFailure(store, envelope, error.code);
      }
      throw error;
    }
    applyBoardDelta(store, plan.after.board);
    if (plan.prune) prunePrevisThumbnails(store.db, plan.prune.nodeId, plan.prune.current, plan.prune.next);
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const affected: SequenceEditAffectedCounts = {
      nodes: plan.after.board.writes.filter(item => item.kind === 'node').length + plan.after.board.removals.length,
      edges: 0, mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0,
    };
    const receipt = receiptDraft(envelope, inputDigest, {affected, contentRevision,
      timelineRevision: Number(header.revision ?? 1), syncRevision: Number(sync?.revision ?? 1)});
    const patch: SequenceEditPatch = {version: 1, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}

/** One shared transaction for a material reference-line action: replay,
 * revision CAS, board delta (edge + legacy frame projection), one history entry
 * and the immutable receipt. */
function runReferenceEdgeSync(store: ProjectStore, envelope: SequenceEditEnvelope, inputDigest: string): SequenceSyncResult {
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
    try { plan = planReferenceEdgeAction(store, envelope); }
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
      nodes: plan.after.board.writes.filter(item => item.kind === 'shot').length,
      edges: plan.after.board.writes.filter(item => item.kind === 'edge').length
        + plan.after.board.removals.filter(item => item.kind === 'edge').length,
      mainTrackClips: 0, otherTrackItems: 0, subtitleCues: 0,
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
      // Shot rows the CS transaction is about to create (copies) or restore are
      // supplied through the cached context so the projection sees their lines.
      const projectionShots = new Map<string, Row>();
      for (const node of request.plan.after.board.nodes) {
        if (node.kind !== 'shot' || context.shots.has(node.id)) continue;
        const row = context.archivedShots.get(node.id);
        if (row) projectionShots.set(node.id, row);
      }
      const projected = patchMainTimeline(context, request.plan, projectionShots);
      if (projected.ok === false) return projected;
      const projection = projected.projection;
      const nextTimeline = projection.timeline;
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
      const patch = timelineDeltaPair(context, nextTimeline, request.plan, emptyBoard, nextBaseline, [], projection);
      const baselineChanged = !sameJson(context.baseline, nextBaseline);
      return {ok: true, delta: patch.after.timeline, warnings: planWarnings(request.plan),
        timelineRevision: patch.after.timeline.clips.length || patch.after.timeline.cues.length
          || patch.after.timeline.removedClipIds.length || patch.after.timeline.removedCueIds.length
          || (patch.after.timeline.subtitles ?? {kind: 'unchanged'}).kind !== 'unchanged'
          ? context.timeline.revision + 1 : context.timeline.revision,
        syncRevision: baselineChanged ? context.syncRevision + 1 : context.syncRevision};
    },
  };
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

/** Apply coupled board and timeline entities with their baseline in the caller's transaction. */
export function applySequenceEditStateDelta(store: ProjectStore, patch: SequenceEditStateDelta,
  context = readSyncContext(store)): {
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
    let revisions: ReturnType<typeof applySequenceEditStateDelta>;
    try { revisions = applySequenceEditStateDelta(store, source, context); }
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
