/** Format-5 timeline ⇄ sequence-root synchronization (TSa).
 *
 * Scope: association projection and per-root planning, version follow/lock,
 * placeholder handling, synchronization baseline, one shared transaction with
 * receipts and one-step undo. Anchors, split/move/delete and export admission
 * belong to TSb; board edits are owned by the board transaction (CS) and reach
 * this service through the same action envelope.
 *
 * All project content is read, planned with the pure SA, and written inside one
 * `ProjectStore.tx`. Persistent writes use the K5a entity delta path, so only
 * changed rows and one content stamp move. History and receipts live in the
 * history-13 tables of the local history database.
 */
import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError, sourceFrameCount} from '@mioon/contracts';
import type {SequenceSyncCommand, SequenceSyncEntitySummary, SequenceSyncEnvelope, SequenceSyncOperation,
  SequenceSyncReceipt, SequenceSyncVersionWarning} from '../../contracts/src/sequence-sync.ts';
import {planChainSync} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncPlan} from '../../contracts/src/chain-sync-algorithm.ts';
import type {ChainSyncClip, ChainSyncMedia, ChainSyncVersion} from '../../contracts/src/chain-main-track.ts';
import type {ChainBoard, ChainNode, SequenceEdge} from '../../contracts/src/board-sequence.ts';
import type {ChainSyncBaseline, TrackAnchoredItem} from '../../contracts/src/chain-sync-analysis.ts';
import {format5SyncBaselineSchema, format5TimelineHeader} from '../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {format5AnchoredItem, format5ChainNodeKind, format5MainTrackClips} from './project-file/format5-sequence-mapping.ts';
import {applyFormat5TimelineEntityUpdateInside, assembleFormat5Timeline, bumpFormat5ContentStampInside,
  planFormat5TimelineEntityUpdate, readFormat5TimelineState} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, any>; // JSON row projection: narrowed at boundaries, never exported
type Json = unknown;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
const syncError = (code: string, message: string, detail: Row = {}): never => {
  throw new AppError(code, message, 409, detail);
};
const planRejected = (plan: {readonly ok: false; readonly code: string; readonly id?: string}): never => {
  throw new AppError('SEQUENCE_SYNC_PLAN_REJECTED', '画板与主轨当前不能按这条命令同步。', 409, {reason: plan.code, id: plan.id});
};
const formatRequired = (): never => {
  throw new AppError('SEQUENCE_SYNC_FORMAT_REQUIRED', '这个操作只适用于项目格式 5。', 409, {});
};

function stableJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Row)[key])}`).join(',')}}`;
}
const digestOf = (value: Json): string => createHash('sha256').update(stableJson(value)).digest('hex');
const format5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === 5;

// ---------------------------------------------------------------------------
// Projection: format-5 rows → the exact SA input plus persistent write context.
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
  readonly edges: readonly SequenceEdge[];
  readonly edgeRows: ReadonlyMap<string, Row>;
  readonly media: readonly ChainSyncMedia[];
  readonly clips: readonly ChainSyncClip[];
  readonly anchored: readonly TrackAnchoredItem[];
  readonly liveShots: readonly Row[];
  readonly allShots: readonly Row[];
  readonly adoptions: readonly Row[];
  readonly subjects: readonly Row[];
  readonly subjectVersions: readonly Row[];
  readonly subjectBindings: readonly Row[];
}

interface JsonRow {readonly id: string; readonly data: Row; readonly archived: boolean}

function readJsonRows(db: DatabaseSync, table: 'shots' | 'nodes' | 'edges' | 'assets' | 'versions'): JsonRow[] {
  const hasArchive = table === 'shots' || table === 'nodes' || table === 'edges';
  const rows = db.prepare(`SELECT id,data${hasArchive ? ',archivedAt' : ''} FROM project.${table} ORDER BY id`).all() as Row[];
  return rows.map(row => {
    if (typeof row.id !== 'string' || typeof row.data !== 'string') throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
    let data: unknown;
    try { data = JSON.parse(row.data); } catch { throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'}); }
    if (!object(data) || data.id !== row.id) throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});
    return {id: row.id, data, archived: hasArchive && row.archivedAt !== null && row.archivedAt !== undefined};
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
  if (syncRows.length !== 1 || sync.timelineId !== timeline.id || sync.projectId !== store.projectId) {
    throw new AppError('SEQUENCE_SYNC_ROOT_NOT_BOUND', '时间线没有绑定成片根。', 409, {timelineId: timeline.id});
  }
  if (sync.sequenceNodeId !== timeline.mainTrack.sequenceNodeId || !Number.isSafeInteger(sync.revision) || typeof sync.baseline !== 'string') {
    throw new AppError('SEQUENCE_SYNC_ROOT_NOT_BOUND', '时间线的主轨关联与同步状态不一致。', 409, {timelineId: timeline.id});
  }
  const nodeRowsList = readJsonRows(db, 'nodes');
  const shotRowsList = readJsonRows(db, 'shots');
  const edgeRowsList = readJsonRows(db, 'edges');
  const assetRowsList = readJsonRows(db, 'assets');
  const versionRowsList = readJsonRows(db, 'versions');
  const adoptionRows = db.prepare('SELECT shotId,versionId,projectId FROM project.shot_version_adoptions ORDER BY shotId,versionId').all() as Row[];
  const subjectRows: Row[] = [];
  const subjectVersionRows: Row[] = [];
  const subjectBindingRows: Row[] = [];
  const nodeRows = new Map(nodeRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  const shots = new Map(shotRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  const versions = new Map(versionRowsList.map(row => [row.id, row.data]));
  const assets = new Map(assetRowsList.map(row => [row.id, row.data]));
  const edgeRows = new Map(edgeRowsList.filter(row => !row.archived).map(row => [row.id, row.data]));
  // Topology only: the terminal fence validates the full graph again at commit.
  // Omitting identity/hash checks here is what keeps the 500 + 500 + 1,000
  // read+plan budget reachable; it never weakens a write.
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
  return {
    projectId: store.projectId, timeline, timelineState, rootNodeId: timeline.mainTrack.sequenceNodeId,
    syncRevision: Number(sync.revision), baseline: baselineFromRaw(sync.baseline), board, nodes: board.nodes,
    nodeRows, shots, versions, assets, edges: board.edges, edgeRows, media, clips, anchored,
    liveShots: shotRowsList.filter(row => !row.archived).map(row => row.data),
    allShots: shotRowsList.map(row => row.data), adoptions: adoptionRows, subjects: subjectRows,
    subjectVersions: subjectVersionRows, subjectBindings: subjectBindingRows,
  };
}

function saState(context: SyncContext) {
  return {
    board: context.board, filmId: context.rootNodeId, media: context.media, clips: context.clips, anchored: context.anchored,
  };
}

/** The caller-visible association projection (TSa's "按根计划" input). */
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
  readonly warnings: readonly SequenceSyncVersionWarning[];
}

export function readSequenceSyncProjection(store: ProjectStore): SequenceSyncProjection {
  if (!format5(store)) formatRequired();
  return store.tx(() => {
    const context = readSyncContext(store);
    const chain = derivedChain(context);
    return {
      timelineId: context.timeline.id, rootNodeId: context.rootNodeId, mainTrackId: context.timeline.mainTrack.trackId,
      syncRevision: context.syncRevision, timelineRevision: context.timeline.revision,
      chainNodeIds: chain.nodeIds, floatingNodeIds: derivedFloating(context),
      track: context.clips.map(clip => ({nodeId: clip.nodeId, segmentGroupId: clip.splitGroupId ?? clip.id, clipId: clip.id,
        versionMode: clip.versionLocked ? 'locked' : 'follow', versionId: clip.versionId, durationFrames: clip.durationFrames})),
      board: chain.nodeIds.map(nodeId => {
        const node = context.board.nodes.find(item => item.id === nodeId)!;
        const media = context.media.find(item => item.nodeId === nodeId);
        return {nodeId, kind: node.kind, versionId: media?.selectedVersion?.id ?? null};
      }),
      warnings: [],
    };
  });
}

function derivedChain(context: SyncContext): {nodeIds: readonly string[]} {
  // The commit fence already enforces main-track order === chain order; the
  // projection reads the same order without another graph derivation.
  const nodeIds: string[] = [];
  for (const clip of context.clips) if (nodeIds.at(-1) !== clip.nodeId) nodeIds.push(clip.nodeId);
  return {nodeIds};
}
function derivedFloating(context: SyncContext): string[] {
  const live = new Set(context.board.nodes.map(node => node.id));
  for (const nodeId of derivedChain(context).nodeIds) live.delete(nodeId);
  return [...live].sort();
}

// ---------------------------------------------------------------------------
// Command planning
// ---------------------------------------------------------------------------

function versionRecord(context: SyncContext, nodeId: string, versionId: string): ChainSyncVersion {
  if (!isUuid(versionId)) syncError('SEQUENCE_SYNC_PLAN_REJECTED', '版本 ID 无效。', {reason: 'INVALID_VERSION', id: versionId});
  const version = context.versions.get(versionId);
  const shot = context.shots.get(nodeId);
  if (!version || !shot) {
    syncError('SEQUENCE_SYNC_PLAN_REJECTED', '所选版本不属于这个镜头。', {reason: 'MISSING_MEDIA', id: nodeId});
    throw new Error('unreachable');
  }
  const versionRow = version;
  const adopted = context.adoptions.some(row => row.shotId === nodeId && row.versionId === versionId);
  if (versionRow.shotId !== nodeId && !adopted) syncError('SEQUENCE_SYNC_PLAN_REJECTED', '所选版本不属于这个镜头。', {reason: 'INVALID_MEDIA', id: nodeId});
  const asset = typeof versionRow.assetId === 'string' ? context.assets.get(versionRow.assetId) : undefined;
  if (!asset || asset.sha256 !== versionRow.sha256) {
    syncError('SEQUENCE_SYNC_PLAN_REJECTED', '版本素材不一致。', {reason: 'INVALID_MEDIA', id: nodeId});
    throw new Error('unreachable');
  }
  return {id: versionRow.id, sourceFrames: sourceFrameCount(asset.duration)};
}

function planFor(context: SyncContext, command: SequenceSyncCommand): ChainSyncPlan {
  const state = saState(context);
  switch (command.kind) {
    case 'sync-board': return planChainSync(state, {kind: 'sync-board', ...(command.newClipIds ? {newClipIds: command.newClipIds} : {})});
    case 'board-version': {
      const version = command.versionId === null ? null : versionRecord(context, command.nodeId, command.versionId);
      return planChainSync(state, {kind: 'board-version', nodeId: command.nodeId, version});
    }
    case 'clip-version': {
      const found = context.clips.find(item => item.id === command.clipId);
      if (!found) {
        syncError('SEQUENCE_SYNC_PLAN_REJECTED', '片段不在主轨。', {reason: 'CLIP_NOT_FOUND', id: command.clipId});
        throw new Error('unreachable');
      }
      const clip = found;
      const requestedVersion = command.versionId;
      if (command.mode === 'locked') {
        if (requestedVersion === null) {
          syncError('SEQUENCE_SYNC_PLAN_REJECTED', '锁定需要具体版本。', {reason: 'INVALID_MEDIA', id: command.clipId});
          throw new Error('unreachable');
        }
        const version = versionRecord(context, clip.nodeId, requestedVersion);
        return planChainSync(state, {kind: 'track', edit: {kind: 'version', clipId: clip.id, version, locked: true}});
      }
      const shot = context.shots.get(clip.nodeId);
      const selected = typeof shot?.selectedVersionId === 'string' ? shot.selectedVersionId : null;
      if (requestedVersion !== null && requestedVersion !== selected) {
        const version = versionRecord(context, clip.nodeId, requestedVersion);
        return planChainSync(state, {kind: 'board-version', nodeId: clip.nodeId, version});
      }
      // Following the already selected version only needs an unlock.
      if (!clip.versionLocked) return planChainSync(state, {kind: 'sync-board'});
      if (selected === null) {
        syncError('SEQUENCE_SYNC_PLAN_REJECTED', '镜头没有选中版本，不能解锁。', {reason: 'INVALID_MEDIA', id: clip.nodeId});
        throw new Error('unreachable');
      }
      return planChainSync(state, {kind: 'track', edit: {kind: 'version', clipId: clip.id,
        version: versionRecord(context, clip.nodeId, selected), locked: false}});
    }
    case 'undo': syncError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '撤销由独立入口处理。', {});
  }
  return syncError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '未知命令。', {});
}

// ---------------------------------------------------------------------------
// Format-5 write mapping
// ---------------------------------------------------------------------------

function versionAssetId(context: SyncContext, nodeId: string, versionId: string | null): string | null {
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

function nextMainClip(context: SyncContext, clip: ChainSyncClip, existing: Format5Clip | undefined): Format5Clip {
  const node = context.board.nodes.find(item => item.id === clip.nodeId)!;
  const base: Format5Clip = existing ?? {
    id: clip.id, trackId: context.timeline.mainTrack.trackId, name: nodeName(context, clip.nodeId),
    startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame,
    rect: {x: 0, y: 0, width: context.timeline.width, height: context.timeline.height}, gain: 1,
    assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId: clip.splitGroupId ?? clip.id, versionMode: 'follow'},
  };
  const segmentGroupId = clip.splitGroupId ?? base.sequenceSource?.segmentGroupId ?? clip.id;
  const frames = {startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame};
  if (node.kind === 'shot' && clip.versionId === null) {
    const {versionId: _v, assetId: _a, jobId: _j, shotId: _s, ...rest} = base;
    void _v; void _a; void _j; void _s;
    return {...rest, ...frames, name: typeof base.name === 'string' ? base.name : nodeName(context, clip.nodeId),
      assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: 'follow'}};
  }
  const assetId = node.kind === 'shot' ? versionAssetId(context, clip.nodeId, clip.versionId) : clip.versionId;
  if (assetId === null) syncError('SEQUENCE_SYNC_PLAN_REJECTED', '版本缺少素材。', {reason: 'INVALID_MEDIA', id: clip.id});
  if (node.kind === 'shot') {
    const {jobId: _job, shotId: _shot, ...rest} = base;
    void _job; void _shot;
    const version = clip.versionId === null ? undefined : context.versions.get(clip.versionId);
    const jobId = isUuid(version?.jobId) ? version.jobId : null;
    return {...rest, ...frames, assetId, versionId: clip.versionId, sourceState: 'ready', shotId: clip.nodeId,
      ...(jobId ? {jobId} : {}),
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: clip.versionLocked ? 'locked' : 'follow'}};
  }
  return {...base, ...frames, assetId, sourceState: 'ready',
    sequenceSource: {kind: 'media', nodeId: clip.nodeId, segmentGroupId}};
}

function anchorForNewOwner(item: {startFrame: number; anchorClipId?: string | null},
  ownerClips: readonly {id: string; startFrame: number; durationFrames: number}[]): {clipId: string; offsetFrames: number} | null {
  if (item.anchorClipId === null || item.anchorClipId === undefined) return null;
  const owner = ownerClips.find(clip => clip.id === item.anchorClipId);
  if (!owner) return null;
  const offsetFrames = item.startFrame - owner.startFrame;
  return offsetFrames >= 0 && offsetFrames < owner.durationFrames ? {clipId: item.anchorClipId, offsetFrames} : null;
}

type SuccessfulPlan = Extract<ChainSyncPlan, {ok: true}>;
function patchMainTimeline(context: SyncContext, plan: SuccessfulPlan): Format5Timeline {
  const existing = new Map(context.timeline.clips.map(clip => [clip.id, clip]));
  const mainTrackId = context.timeline.mainTrack.trackId;
  const mainClips = plan.after.clips.map(clip => nextMainClip(context, clip, existing.get(clip.id)));
  const ownerSegments = mainClips.map(clip => ({id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames}));
  const anchored = new Map(plan.after.anchored.map(item => [item.id, item]));
  const durationFrames = mainClips.reduce((maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames), 0);
  const clips: Format5Clip[] = [...mainClips];
  for (const clip of context.timeline.clips) {
    if (clip.trackId === mainTrackId) continue;
    const item = anchored.get(clip.id);
    const startFrame = item?.startFrame ?? clip.startFrame;
    const anchor = item ? anchorForNewOwner(item, ownerSegments) : clip.anchor ?? null;
    clips.push({...clip, startFrame, anchor});
  }
  const cues: Format5Cue[] = (context.timeline.subtitles?.cues ?? []).map(cue => {
    const item = anchored.get(cue.id);
    if (!item) return cue;
    const anchor = anchorForNewOwner(item, ownerSegments);
    return {...cue, startFrame: item.startFrame, anchor: anchor ?? cue.anchor};
  });
  return {...context.timeline, revision: context.timeline.revision + 1, updatedAt: now(),
    durationFrames, clips, subtitles: context.timeline.subtitles ? {...context.timeline.subtitles, cues} : undefined};
}

function buildBaseline(context: SyncContext, timeline: Format5Timeline, shotUpdates: ReadonlyMap<string, Row> = new Map()): Format5SyncBaseline {
  const mainTrackId = timeline.mainTrack.trackId;
  const mainClips = timeline.clips.filter(clip => clip.trackId === mainTrackId);
  const chainNodeIds: string[] = [];
  for (const clip of mainClips) {
    const nodeId = clip.sequenceSource!.nodeId;
    if (chainNodeIds.at(-1) !== nodeId) chainNodeIds.push(nodeId);
  }
  const nodeKind = new Map(context.board.nodes.map(node => [node.id, node.kind]));
  const shotById = new Map(context.shots);
  for (const [nodeId, value] of shotUpdates) shotById.set(nodeId, value);
  const nodeRow = new Map(context.nodeRows);
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
  if (!parsed.success) {
    syncError('SEQUENCE_SYNC_PLAN_REJECTED', '同步基线无法写入。', {reason: 'INVALID_BASELINE'});
    throw new Error('unreachable');
  }
  return parsed.data;
}

function writeTimelineDelta(store: ProjectStore, context: SyncContext, nextTimeline: Format5Timeline,
  changedClipIds: ReadonlySet<string>, changedCueIds: ReadonlySet<string>): void {
  const patch = {clips: nextTimeline.clips.filter(clip => changedClipIds.has(clip.id)),
    cues: (nextTimeline.subtitles?.cues ?? []).filter(cue => changedCueIds.has(cue.id))};
  const update = planFormat5TimelineEntityUpdate(context.timelineState, patch);
  const headerRaw = JSON.stringify(format5TimelineHeader(nextTimeline));
  const headerChanged = context.timelineState.header?.raw !== headerRaw;
  if (update.changed) applyFormat5TimelineEntityUpdateInside(store.db, 'project', update);
  if (headerChanged) {
    const result = store.db.prepare('UPDATE project.timelines SET data=? WHERE id=?').run(headerRaw, nextTimeline.id);
    if (Number(result.changes) !== 1) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
  }
  if (update.changed || headerChanged) bumpFormat5ContentStampInside(store.db, 'project');
}

// ---------------------------------------------------------------------------
// History, receipts and the single transaction
// ---------------------------------------------------------------------------

interface EntityPatch {readonly before: Row | null; readonly after: Row | null}
interface HistoryPatch {
  readonly shots: {readonly before: readonly Row[]; readonly after: readonly Row[]};
  readonly timeline: {readonly before: Row; readonly after: Row};
  readonly baseline: {readonly before: Row; readonly after: Row};
}

function readHistoryState(store: ProjectStore): {epoch: string; position: number; revision: number} {
  const rows = store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state WHERE projectId=?').all(store.projectId) as Row[];
  if (rows.length) return {epoch: String(rows[0]!.epoch), position: Number(rows[0]!.position), revision: Number(rows[0]!.revision)};
  // Fresh format-5 projects start the unified stack lazily on their first edit.
  const epoch = randomUUID();
  store.db.prepare('INSERT INTO main.editor_history_state(projectId,epoch,position,revision,evidence) VALUES(?,?,0,1,?)')
    .run(store.projectId, epoch, JSON.stringify({formatVersion: 5, createdBy: 'sequence-sync'}));
  return {epoch, position: 0, revision: 1};
}

function readReceipt(store: ProjectStore, requestId: string): {operation: string; inputDigest: string; response: Row} | null {
  const row = store.db.prepare('SELECT operation,inputDigest,response FROM main.editor_requests WHERE requestId=?').get(requestId) as Row | undefined;
  if (!row) return null;
  return {operation: String(row.operation), inputDigest: String(row.inputDigest), response: JSON.parse(String(row.response)) as Row};
}
function writeReceipt(store: ProjectStore, requestId: string, operation: string, inputDigest: string, response: object): void {
  store.db.prepare('INSERT INTO main.editor_requests(requestId,projectId,operation,inputDigest,response,issuedAt,createdAt) VALUES(?,?,?,?,?,?,?)')
    .run(requestId, store.projectId, operation, inputDigest, JSON.stringify(response), Date.now(), now());
}

const emptySummary = (): SequenceSyncEntitySummary => ({created: [], updated: [], removed: []});
function summary(ids: Iterable<readonly [string, 'created' | 'updated' | 'removed']>): SequenceSyncEntitySummary {
  const result = {created: [] as string[], updated: [] as string[], removed: [] as string[]};
  for (const [id, kind] of ids) result[kind].push(id);
  return {created: result.created.sort(), updated: result.updated.sort(), removed: result.removed.sort()};
}
function changeSummary(rows: readonly {before: {id: string} | null; after: {id: string} | null}[]): SequenceSyncEntitySummary {
  return summary(rows.map(row => [row.after?.id ?? row.before!.id, row.before === null ? 'created' : row.after === null ? 'removed' : 'updated'] as const));
}

function contextFingerprint(context: SyncContext): string {
  return digestOf({timeline: context.timeline, sync: {root: context.rootNodeId, revision: context.syncRevision, baseline: context.baseline}});
}

function receiptBase(context: SyncContext, operation: SequenceSyncOperation, requestId: string, actionId: string, changed: boolean,
  timelineRevision: number, syncRevision: number): SequenceSyncReceipt {
  return {ok: true, operation, requestId, actionId, changed,
    root: {timelineId: context.timeline.id, rootNodeId: context.rootNodeId, mainTrackId: context.timeline.mainTrack.trackId},
    syncRevision, timelineRevision, nodes: emptySummary(), edges: emptySummary(), shotSources: emptySummary(),
    clips: emptySummary(), tracks: emptySummary(), anchored: emptySummary(), warnings: [], history: null};
}

export interface SequenceSyncResult extends SequenceSyncReceipt {}

export function runSequenceSync(store: ProjectStore, envelope: SequenceSyncEnvelope, command: SequenceSyncCommand): SequenceSyncResult {
  if (!format5(store)) formatRequired();
  const inputDigest = digestOf({operation: command.kind, expected: envelope.expected, command});
  return store.tx(() => {
    const replay = readReceipt(store, envelope.requestId);
    if (replay) {
      if (replay.operation !== command.kind || replay.inputDigest !== inputDigest) {
        throw new AppError('SEQUENCE_SYNC_REQUEST_CONFLICT', '同一请求 ID 被用于不同操作。', 409, {requestId: envelope.requestId});
      }
      return replay.response as unknown as SequenceSyncResult;
    }
    if (command.kind === 'undo') throw new AppError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '撤销由独立入口处理。', 409, {});
    const context = readSyncContext(store);
    if (context.syncRevision !== envelope.expected.syncRevision || context.timeline.revision !== envelope.expected.timelineRevision) {
      throw new AppError('SEQUENCE_SYNC_STALE_REVISION', '时间线或同步状态已经变化，请重新读取。', 409,
        {syncRevision: context.syncRevision, timelineRevision: context.timeline.revision});
    }
    const plan = planFor(context, command);
    if (!plan.ok) {
      planRejected(plan);
      throw new Error('unreachable');
    }
    const changed = plannedChanged(plan);
    if (!changed) {
      const receipt = receiptBase(context, command.kind, envelope.requestId, randomUUID(), false, context.timeline.revision, context.syncRevision);
      writeReceipt(store, envelope.requestId, command.kind, inputDigest, receipt);
      return receipt;
    }
    // Shot version selections changed by a board-level version command.
    const shotChanges: {before: Row; after: Row}[] = [];
    for (const change of plan.changes.media) {
      const node = context.board.nodes.find(item => item.id === change.after?.nodeId);
      if (node?.kind !== 'shot') continue;
      const shot = context.shots.get(change.after!.nodeId);
      if (!shot) continue;
      const after = {...shot, selectedVersionId: change.after!.selectedVersion?.id ?? null, updatedAt: now()};
      if (after.selectedVersionId !== shot.selectedVersionId) shotChanges.push({before: shot, after});
    }
    const beforeTimelineRaw = {revision: context.timeline.revision, durationFrames: context.timeline.durationFrames,
      clips: context.timeline.clips, cues: context.timeline.subtitles?.cues ?? []};
    const nextTimeline = patchMainTimeline(context, plan);
    const shotUpdates = new Map(shotChanges.map(change => [change.after.id as string, change.after] as const));
    const nextBaseline = buildBaseline(context, nextTimeline, shotUpdates);
    const changedClipIds = new Set(plan.changes.clips.map(change => change.after?.id ?? change.before!.id));
    const changedCueIds = new Set(plan.changes.anchored.map(change => change.after?.id ?? change.before!.id));
    // Apply main-track entities and other-track anchors in the same record.
    for (const change of plan.changes.clips) {
      if (change.before === null || change.after === null) {
        throw new AppError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '创建或删除片段属于 TSb。', 409,
          {id: change.after?.id ?? change.before?.id ?? ''});
      }
    }
    for (const change of plan.changes.nodes) syncError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '画板节点复制属于 TSb。', {id: change.after?.id ?? change.before?.id});
    for (const change of plan.changes.edges) syncError('SEQUENCE_SYNC_UNSUPPORTED_COMMAND', '画板边写入属于 CS。', {id: change.after?.fromId ?? change.before?.fromId});
    for (const change of shotChanges) store.put('shots', change.after);
    const historyState = readHistoryState(store);
    const actionId = randomUUID();
    const position = historyState.position + 1;
    const afterTimelineRaw = {revision: nextTimeline.revision, durationFrames: nextTimeline.durationFrames,
      clips: nextTimeline.clips, cues: nextTimeline.subtitles?.cues ?? []};
    const patch: HistoryPatch = {
      shots: {before: shotChanges.map(change => change.before), after: shotChanges.map(change => change.after)},
      timeline: {before: beforeTimelineRaw, after: afterTimelineRaw},
      baseline: {before: context.baseline as unknown as Row, after: nextBaseline as unknown as Row},
    };
    writeTimelineDelta(store, context, nextTimeline, changedClipIds, changedCueIds);
    const syncUpdate = store.db.prepare('UPDATE project.sequence_sync_state SET revision=revision+1,baseline=? WHERE timelineId=? AND revision=?')
      .run(JSON.stringify(nextBaseline), context.timeline.id, context.syncRevision);
    if (Number(syncUpdate.changes) !== 1) throw new AppError('SEQUENCE_SYNC_STALE_REVISION', '同步状态已经变化，请重新读取。', 409, {});
    const evidence = {formatVersion: 5, lastActionId: actionId, operation: command.kind, position,
      syncRevision: context.syncRevision + 1, timelineRevision: nextTimeline.revision};
    const beforePatch = JSON.stringify({shots: patch.shots.before, timeline: patch.timeline.before, baseline: patch.baseline.before});
    const afterPatch = JSON.stringify({shots: patch.shots.after, timeline: patch.timeline.after, baseline: patch.baseline.after});
    store.db.prepare('INSERT INTO main.editor_history_entries(actionId,projectId,epoch,position,operation,origin,beforePatch,afterPatch,createdAt) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(actionId, store.projectId, historyState.epoch, position, command.kind, 'user', beforePatch, afterPatch, now());
    store.db.prepare('UPDATE main.editor_history_state SET position=?,revision=revision+1,evidence=? WHERE projectId=?')
      .run(position, JSON.stringify(evidence), store.projectId);
    const receipt: SequenceSyncReceipt = {
      ...receiptBase(context, command.kind, envelope.requestId, actionId, true, nextTimeline.revision, context.syncRevision + 1),
      shotSources: summary(shotChanges.map(change => [change.before.id, 'updated'] as const)),
      clips: changeSummary(plan.changes.clips), tracks: changeSummary(plan.changes.anchored),
      warnings: plan.warnings as SequenceSyncVersionWarning[],
      history: {actionId, undoable: true, position},
    };
    writeReceipt(store, envelope.requestId, command.kind, inputDigest, receipt);
    return receipt;
  });
}

function plannedChanged(plan: SuccessfulPlan): boolean {
  const count = (values: readonly unknown[]) => values.length;
  return count(plan.changes.nodes) + count(plan.changes.edges) + count(plan.changes.media) + count(plan.changes.clips)
    + count(plan.changes.anchored) > 0;
}

// ---------------------------------------------------------------------------
// One-step undo of a previously recorded user action
// ---------------------------------------------------------------------------

export function undoSequenceSync(store: ProjectStore, envelope: SequenceSyncEnvelope & {readonly actionId: string}): SequenceSyncResult {
  if (!format5(store)) formatRequired();
  const inputDigest = digestOf({operation: 'undo', actionId: envelope.actionId});
  return store.tx(() => {
    const replay = readReceipt(store, envelope.requestId);
    if (replay) {
      if (replay.operation !== 'undo' || replay.inputDigest !== inputDigest) {
        throw new AppError('SEQUENCE_SYNC_REQUEST_CONFLICT', '同一请求 ID 被用于不同操作。', 409, {requestId: envelope.requestId});
      }
      return replay.response as unknown as SequenceSyncResult;
    }
    const context = readSyncContext(store);
    if (context.syncRevision !== envelope.expected.syncRevision || context.timeline.revision !== envelope.expected.timelineRevision) {
      throw new AppError('SEQUENCE_SYNC_STALE_REVISION', '时间线或同步状态已经变化，请重新读取。', 409,
        {syncRevision: context.syncRevision, timelineRevision: context.timeline.revision});
    }
    const state = store.db.prepare('SELECT epoch,position,revision FROM main.editor_history_state WHERE projectId=?').get(store.projectId) as Row | undefined;
    const entry = store.db.prepare('SELECT position,beforePatch,afterPatch,operation FROM main.editor_history_entries WHERE actionId=? AND projectId=?')
      .get(envelope.actionId, store.projectId) as Row | undefined;
    if (!state || !entry || Number(entry.position) !== Number(state.position)) {
      throw new AppError('SEQUENCE_SYNC_UNDO_STALE', '这一步已经不能撤销。', 409, {actionId: envelope.actionId});
    }
    const before = JSON.parse(String(entry.beforePatch)) as {shots: Row[]; timeline: {revision: number; durationFrames: number;
      clips: Format5Clip[]; cues: Format5Cue[]}; baseline: Format5SyncBaseline};
    const beforeTimeline = before.timeline;
    for (const shot of before.shots) store.put('shots', shot);
    const beforeBaseline = before.baseline;
    const restore: Format5Timeline = {...context.timeline, revision: context.timeline.revision + 1, updatedAt: now(),
      durationFrames: beforeTimeline.durationFrames, clips: beforeTimeline.clips,
      subtitles: context.timeline.subtitles ? {...context.timeline.subtitles, cues: beforeTimeline.cues} : undefined};
    store.put('timelines', restore);
    const syncUpdate = store.db.prepare('UPDATE project.sequence_sync_state SET revision=revision+1,baseline=? WHERE timelineId=? AND revision=?')
      .run(JSON.stringify(beforeBaseline), context.timeline.id, context.syncRevision);
    if (Number(syncUpdate.changes) !== 1) throw new AppError('SEQUENCE_SYNC_STALE_REVISION', '同步状态已经变化，请重新读取。', 409, {});
    store.db.prepare('UPDATE main.editor_history_state SET position=position-1,revision=revision+1,evidence=? WHERE projectId=?')
      .run(JSON.stringify({formatVersion: 5, undoneActionId: envelope.actionId, undoneOperation: entry.operation}), store.projectId);
    const receipt: SequenceSyncReceipt = {...receiptBase(context, 'undo', envelope.requestId, envelope.actionId, true,
      context.timeline.revision + 1, context.syncRevision + 1),
      history: {actionId: envelope.actionId, undoable: false, position: Number(state.position) - 1}};
    writeReceipt(store, envelope.requestId, 'undo', inputDigest, receipt);
    return receipt;
  });
}
