/** Test-only doubles for the CS board transaction.
 *
 * - `createMemoryHistory` is the shared history-13 port (receipts, entries,
 *   cursor) held in memory for one test.
 * - `createProjectionDouble(store)` is the TS half: it applies the SA plan to
 *   the stored format-5 timeline as the timeline-sync service will, so the
 *   kernel's full-state commit fence sees a consistent board/timeline.
 * - `createChainWorld` writes a small but real format-5 project (rows, timeline
 *   and sync state) through the K5a store surface.
 */
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import {createProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {
  applyFormat5TimelineEntityUpdateInside, planFormat5TimelineEntityUpdate, readFormat5TimelineState,
} from '../../packages/business/src/project-file/format5-timeline.ts';
import {format5SyncBaselineSchema, format5TimelineHeader} from '../../packages/contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5SyncBaseline, Format5Timeline} from '../../packages/contracts/src/project-format5.ts';
import {sourceFrameCount} from '../../packages/contracts/src/source-range.ts';
import {readSequenceEditContext} from '../../packages/business/src/sequence-edit.ts';
import {readFormat5TimelineRecord} from '../../packages/business/src/project-file/format5-timeline.ts';
import type {
  SequenceEditHistoryCommit, SequenceEditHistoryCursor, SequenceEditHistoryPort, SequenceEditHistoryReplay,
} from '../../packages/business/src/sequence-edit.ts';
import type {
  MainTrackProjectionPort, SequenceEditHistoryEntry, SequenceEditTimelineCommit,
  SequenceEditTimelineDelta, SequenceEditTransactionFailure, SequenceEditTransactionRequest,
} from '../../packages/contracts/src/sequence-edit.ts';
import type {SequenceEditTimelineHistoryPort} from '../../packages/business/src/sequence-edit.ts';
import {applySequenceEditBaselineChange} from '../../packages/contracts/src/sequence-edit.ts';
import type {ChainSyncClip} from '../../packages/contracts/src/chain-main-track.ts';

type Row = Record<string, unknown>;
const at = '2026-01-01T00:00:00.000Z';
const uuid = (): string => randomUUID();
const now = (): string => new Date().toISOString();

export interface MemoryHistory extends SequenceEditHistoryPort {
  readonly receipts: Map<string, SequenceEditHistoryReplay>;
  readonly entries: Map<number, SequenceEditHistoryEntry>;
  cursor: SequenceEditHistoryCursor;
}
export function createMemoryHistory(): MemoryHistory {
  const history: MemoryHistory = {
    receipts: new Map(), entries: new Map(), cursor: {epoch: randomUUID(), position: 0, revision: 1},
    readCursor: () => ({...history.cursor}),
    readEntryAt: position => history.entries.get(position) ?? null,
    findReceipt: requestId => history.receipts.get(requestId) ?? null,
    commit(change: SequenceEditHistoryCommit) {
      if (change.entry) {
        if (change.entry.position !== history.cursor.position + 1) throw new TypeError('History double requires the next position');
        history.entries.set(change.entry.position, change.entry);
      }
      history.receipts.set(change.requestId, {operation: change.operation, inputDigest: change.inputDigest, receipt: change.receipt});
      history.cursor = {...history.cursor, position: change.receipt.history.position, revision: change.receipt.history.revision};
    },
  };
  return history;
}

// ---------------------------------------------------------------------------
// Format-5 world
// ---------------------------------------------------------------------------

export interface VersionFixture {
  readonly versionId: string;
  readonly assetId: string;
  readonly sha256: string;
  readonly durationSeconds: number;
}
export interface ChainWorld {
  readonly store: ProjectStore;
  readonly projectId: string;
  readonly rootId: string;
  readonly timelineId: string;
  readonly mainTrackId: string;
  readonly shots: Map<string, Row>;
  readonly nodes: Map<string, Row>;
  readonly versions: Map<string, Row>;
  readonly assets: Map<string, Row>;
  readonly timeline: Format5Timeline;
  readonly baseline: Format5SyncBaseline;
}
export interface ChainWorldSpec {
  readonly shots: readonly {readonly id: string; readonly title?: string; readonly versionId?: string | null}[];
  readonly versions?: readonly VersionFixture[];
  readonly nodes?: readonly {readonly id: string; readonly type: string; readonly name?: string; readonly assetId?: string | null}[];
  readonly clips: readonly {readonly nodeId: string; readonly clipId: string; readonly startFrame: number;
    readonly durationFrames: number; readonly versionId?: string | null; readonly locked?: boolean; readonly splitGroupId?: string}[];
  readonly edges: readonly {readonly id: string; readonly fromId: string; readonly toId: string}[];
  readonly archived?: readonly {readonly table: 'shots' | 'nodes'; readonly id: string}[];
  readonly rootId?: string;
  readonly timelineId?: string;
  readonly mainTrackId?: string;
}

function clipRecord(world: {readonly shots: ReadonlyMap<string, Row>; readonly nodes: ReadonlyMap<string, Row>;
  readonly versions: ReadonlyMap<string, Row>; readonly assets: ReadonlyMap<string, Row>}, mainTrackId: string,
  clip: ChainWorldSpec['clips'][number]): Format5Clip {
  const shot = world.shots.get(clip.nodeId);
  const node = world.nodes.get(clip.nodeId);
  const segmentGroupId = clip.splitGroupId ?? clip.clipId;
  const base: Format5Clip = {id: clip.clipId, trackId: mainTrackId,
    name: typeof shot?.title === 'string' ? shot.title : 'Clip',
    startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
    sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: 'follow'}};
  if (shot) {
    const versionId = typeof clip.versionId === 'string' ? clip.versionId : typeof shot.selectedVersionId === 'string' ? shot.selectedVersionId : null;
    if (versionId === null) return base;
    const version = world.versions.get(versionId);
    if (!version || typeof version.assetId !== 'string') throw new TypeError('Fixture version is missing');
    return {...base, assetId: version.assetId, versionId, jobId: typeof version.jobId === 'string' ? version.jobId : null,
      shotId: clip.nodeId, sourceState: 'ready',
      sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: clip.locked ? 'locked' : 'follow'}};
  }
  if (!node) throw new TypeError(`Fixture node ${clip.nodeId} is missing`);
  const assetId = typeof node.assetId === 'string' ? node.assetId : null;
  if (assetId === null) return base;
  const asset = world.assets.get(assetId);
  void sourceFrameCount(asset?.duration);
  return {...base, assetId, sourceState: 'ready',
    sequenceSource: {kind: 'media', nodeId: clip.nodeId, segmentGroupId}};
}

function baselineFrom(timeline: Format5Timeline, shots: ReadonlyMap<string, Row>, nodes: ReadonlyMap<string, Row>,
  mainTrackId: string, shotVersions: ReadonlyMap<string, string | null> = new Map()): Format5SyncBaseline {
  const chain: string[] = [];
  for (const clip of timeline.clips) {
    if (clip.trackId !== mainTrackId) continue;
    const nodeId = clip.sequenceSource?.nodeId;
    if (typeof nodeId === 'string' && chain.at(-1) !== nodeId) chain.push(nodeId);
  }
  const board = chain.map(nodeId => {
    const shot = shots.get(nodeId);
    if (shot) {
      const selected = shotVersions.has(nodeId) ? shotVersions.get(nodeId) : shot.selectedVersionId;
      return {nodeId, kind: 'shot' as const, selectedVersionId: typeof selected === 'string' ? selected : null};
    }
    const node = nodes.get(nodeId);
    const assetId = typeof node?.assetId === 'string' ? node.assetId : '00000000-0000-4000-8000-000000000000';
    return {nodeId, kind: 'media' as const, assetId};
  });
  const track = timeline.clips.filter(clip => clip.trackId === mainTrackId).map(clip => {
    const source = clip.sequenceSource!;
    if (source.kind === 'shot') return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id,
      kind: 'shot' as const, versionMode: source.versionMode, appliedVersionId: clip.versionId ?? null};
    return {nodeId: source.nodeId, segmentGroupId: source.segmentGroupId, clipId: clip.id, kind: 'media' as const,
      assetId: clip.assetId ?? '00000000-0000-4000-8000-000000000000'};
  });
  const parsed = format5SyncBaselineSchema.safeParse({version: 1 as const, board, track});
  if (!parsed.success) throw new TypeError(`Invalid fixture baseline: ${parsed.error.message}`);
  return parsed.data;
}

export function createChainWorld(t: test.TestContext, spec: ChainWorldSpec): ChainWorld {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-sequence-edit-'));
  const projectId = uuid(), rootId = spec.rootId ?? uuid(), timelineId = spec.timelineId ?? uuid(), mainTrackId = spec.mainTrackId ?? uuid();
  const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const shots = new Map<string, Row>(), nodes = new Map<string, Row>(), versions = new Map<string, Row>(), assets = new Map<string, Row>();
  for (const fixture of spec.versions ?? []) {
    assets.set(fixture.assetId, {id: fixture.assetId, projectId, mimeType: 'video/mp4', duration: fixture.durationSeconds,
      sha256: fixture.sha256, name: 'source.mp4'});
    versions.set(fixture.versionId, {id: fixture.versionId, projectId, shotId: '', jobId: uuid(), assetId: fixture.assetId,
      sha256: fixture.sha256, number: 1, createdAt: at});
  }
  for (const shot of spec.shots) {
    const version = typeof shot.versionId === 'string' ? versions.get(shot.versionId) : undefined;
    shots.set(shot.id, {id: shot.id, projectId, title: shot.title ?? 'Shot', orderIndex: 0, duration: 2,
      selectedVersionId: typeof shot.versionId === 'string' ? shot.versionId : null, createdAt: at, updatedAt: at});
    if (version) version.shotId = shot.id;
  }
  for (const node of spec.nodes ?? []) {
    nodes.set(node.id, {id: node.id, projectId, type: node.type, name: node.name ?? 'Node', position: {x: 0, y: 0},
      ...(node.assetId !== undefined ? {assetId: node.assetId} : {}), createdAt: at});
  }
  const timelineBase = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 0, createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
    tracks: [{id: mainTrackId, name: 'V1', kind: 'video' as const, orderIndex: 0, hidden: false, muted: false}]};
  const clipWorld = {projectId, shots, nodes, versions, assets};
  const clips = spec.clips.map(clip => clipRecord(clipWorld, mainTrackId, clip));
  const durationFrames = clips.reduce((maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames), 0);
  const timeline: Format5Timeline = {...timelineBase, durationFrames, clips};
  const archived = new Set((spec.archived ?? []).map(item => `${item.table}:${item.id}`));
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic chain', revision: 1, createdAt: at, updatedAt: at});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
    for (const row of nodes.values()) store.put('nodes', row);
    for (const row of versions.values()) store.put('versions', row);
    for (const row of assets.values()) store.put('assets', row);
    for (const row of shots.values()) store.put('shots', row);
    for (const row of shots.values()) if (archived.has(`shots:${row.id}`))
      store.db.prepare('UPDATE project.shots SET archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=?')
        .run(at, uuid(), 'user-delete', String(row.id));
    for (const row of nodes.values()) if (archived.has(`nodes:${row.id}`))
      store.db.prepare('UPDATE project.nodes SET archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=?')
        .run(at, uuid(), 'user-delete', String(row.id));
    for (const edge of spec.edges) store.put('edges', {id: edge.id, projectId, source: edge.fromId, target: edge.toId, kind: 'sequence', createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify(baselineFrom(timeline, shots, nodes, mainTrackId)));
  });
  const baseline = baselineFrom(timeline, shots, nodes, mainTrackId);
  return {store, projectId, rootId, timelineId, mainTrackId, shots, nodes, versions, assets, timeline, baseline};
}

// ---------------------------------------------------------------------------
// TS projection double
// ---------------------------------------------------------------------------

function projectionFailure(code: string, ids: readonly string[]): SequenceEditTransactionFailure {
  return {ok: false, code: code as never, ids};
}

/** Writes the main-track projection for the plan with the K5a entity path and
 * advances the sync revision exactly as the timeline-sync transaction will. */
export function createProjectionDouble(store: ProjectStore): MainTrackProjectionPort {
  return {
    projectMainTrack(request: SequenceEditTransactionRequest): SequenceEditTimelineCommit | SequenceEditTransactionFailure {
      const context = readSequenceEditContext(store);
      const plan = request.plan;
      const mainTrackId = context.timeline.mainTrack.trackId;
      const existing = new Map(context.timeline.clips.map(clip => [clip.id, clip] as const));
      const versions = context.rows.versions;
      const nodeById = new Map(plan.after.board.nodes.map(node => [node.id, node] as const));
      const nextMainClip = (clip: ChainSyncClip): Format5Clip => {
        const node = nodeById.get(clip.nodeId);
        if (!node) throw new TypeError(`Projection lost node ${clip.nodeId}`);
        const current = existing.get(clip.id);
        const base: Format5Clip = current ?? {id: clip.id, trackId: mainTrackId,
          name: typeof context.rows.shots.get(clip.nodeId)?.title === 'string' ? String(context.rows.shots.get(clip.nodeId)!.title) : 'Clip',
          startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame,
          rect: {x: 0, y: 0, width: context.timeline.width, height: context.timeline.height}, gain: 1,
          assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
          sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId: clip.splitGroupId ?? clip.id, versionMode: 'follow'}};
        const segmentGroupId = clip.splitGroupId ?? base.sequenceSource?.segmentGroupId ?? clip.id;
        const frames = {startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame};
        if (node.kind === 'shot' && clip.versionId === null) {
          const {assetId: _assetId, versionId: _versionId, jobId: _jobId, shotId: _shotId, ...rest} = base;
          return {...rest, ...frames, assetId: null, versionId: null, jobId: null, sourceState: 'placeholder',
            sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: 'follow'}};
        }
        const version = clip.versionId === null ? undefined : versions.get(clip.versionId);
        const assetId = node.kind === 'shot' ? (typeof version?.assetId === 'string' ? version.assetId : null) : clip.versionId;
        if (assetId === null) throw new TypeError('Projection needs an asset for a ready clip');
        if (node.kind === 'shot') {
          return {...base, ...frames, assetId, versionId: clip.versionId, sourceState: 'ready', shotId: clip.nodeId,
            ...(typeof version?.jobId === 'string' ? {jobId: version.jobId} : {}),
            sequenceSource: {kind: 'shot', nodeId: clip.nodeId, segmentGroupId, versionMode: clip.versionLocked ? 'locked' : 'follow'}};
        }
        return {...base, ...frames, assetId, sourceState: 'ready',
          sequenceSource: {kind: 'media', nodeId: clip.nodeId, segmentGroupId}};
      };
      const mainClips = plan.after.clips.map(nextMainClip);
      const ownerSegments = mainClips.map(clip => ({id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames}));
      const anchored = new Map(plan.after.anchored.map(item => [item.id, item] as const));
      const anchorFor = (item: {startFrame: number; anchorClipId?: string | null}): {clipId: string; offsetFrames: number} | null => {
        if (item.anchorClipId === null || item.anchorClipId === undefined) return null;
        const owner = ownerSegments.find(clip => clip.id === item.anchorClipId);
        if (!owner) return null;
        const offsetFrames = item.startFrame - owner.startFrame;
        return offsetFrames >= 0 && offsetFrames < owner.durationFrames ? {clipId: item.anchorClipId, offsetFrames} : null;
      };
      const clips: Format5Clip[] = [...mainClips];
      for (const clip of context.timeline.clips) {
        if (clip.trackId === mainTrackId) continue;
        const item = anchored.get(clip.id);
        clips.push({...clip, startFrame: item?.startFrame ?? clip.startFrame, anchor: item ? anchorFor(item) : clip.anchor ?? null});
      }
      const cues: Format5Cue[] = (context.timeline.subtitles?.cues ?? []).map(cue => {
        const item = anchored.get(cue.id);
        return item ? {...cue, startFrame: item.startFrame, anchor: anchorFor(item) ?? cue.anchor} : cue;
      });
      const durationFrames = mainClips.reduce((maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames), 0);
      const nextTimeline: Format5Timeline = {...context.timeline, revision: context.timeline.revision + 1, updatedAt: now(),
        durationFrames, clips};
      if (context.timeline.subtitles) nextTimeline.subtitles = {...context.timeline.subtitles, cues};
      const shotVersions = new Map<string, string | null>();
      for (const item of context.media) shotVersions.set(item.nodeId, item.selectedVersion?.id ?? null);
      for (const change of plan.changes.media) if (change.after) shotVersions.set(change.after.nodeId, change.after.selectedVersion?.id ?? null);
      const nextBaseline = baselineFrom(nextTimeline, context.rows.shots, context.rows.nodes, mainTrackId, shotVersions);
      const state = readFormat5TimelineState(store.db, 'project');
      const changedClips = nextTimeline.clips.filter(clip => {
        const before = existing.get(clip.id);
        return !before || JSON.stringify(before) !== JSON.stringify(clip);
      });
      const update = planFormat5TimelineEntityUpdate(state, {clips: changedClips, cues,
        removedClipIds: context.timeline.clips.filter(clip => clip.trackId === mainTrackId
          && !nextTimeline.clips.some(next => next.id === clip.id)).map(clip => clip.id)});
      if (update.changed || update.clipDeletes.length || update.cueDeletes.length) applyFormat5TimelineEntityUpdateInside(store.db, 'project', update);
      const headerRaw = JSON.stringify(format5TimelineHeader(nextTimeline));
      if (state.header?.raw !== headerRaw) store.db.prepare('UPDATE project.timelines SET data=? WHERE id=?').run(headerRaw, nextTimeline.id);
      const sync = store.db.prepare('UPDATE project.sequence_sync_state SET revision=revision+1,baseline=? WHERE timelineId=? AND revision=?')
        .run(JSON.stringify(nextBaseline), context.timeline.id, context.syncRevision);
      if (Number(sync.changes) !== 1) return projectionFailure('CHAIN_TRACK_MISMATCH', [context.rootNodeId]);
      return {ok: true, delta: {clips: [], cues: [], removedClipIds: [], removedCueIds: [],
        baseline: {kind: 'set', value: nextBaseline}}, warnings: plan.warnings,
        timelineRevision: nextTimeline.revision, syncRevision: context.syncRevision + 1};
    },
  };
}

// ---------------------------------------------------------------------------
// Timeline history double (undo/redo partner of the projection double)
// ---------------------------------------------------------------------------

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function createTimelineHistoryDouble(store: ProjectStore): SequenceEditTimelineHistoryPort {
  const readTimeline = (): Format5Timeline => {
    const timeline = readFormat5TimelineRecord(store.db, 'project');
    if (!timeline) throw new TypeError('Fixture timeline is missing');
    return timeline;
  };
  const readSync = (): {revision: number; baseline: Format5SyncBaseline} => {
    const row = store.db.prepare('SELECT revision,baseline FROM project.sequence_sync_state').get() as Row;
    const parsed = format5SyncBaselineSchema.safeParse(JSON.parse(String(row.baseline)));
    if (!parsed.success) throw new TypeError('Fixture sync state is invalid');
    return {revision: Number(row.revision), baseline: parsed.data};
  };
  return {
    matches(delta: SequenceEditTimelineDelta): boolean {
      const timeline = readTimeline();
      const clips = new Map(timeline.clips.map(clip => [clip.id, clip] as const));
      const cues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
      for (const clip of delta.clips) if (!sameJson(clips.get(clip.id), clip)) return false;
      for (const cue of delta.cues) if (!sameJson(cues.get(cue.id), cue)) return false;
      for (const id of delta.removedClipIds) if (clips.has(id)) return false;
      for (const id of delta.removedCueIds) if (cues.has(id)) return false;
      const sync = readSync();
      if (delta.baseline.kind === 'set') return sameJson(sync.baseline, delta.baseline.value);
      return delta.baseline.kind === 'unchanged';
    },
    apply(delta: SequenceEditTimelineDelta) {
      const timeline = readTimeline();
      const clips = new Map(timeline.clips.map(clip => [clip.id, clip] as const));
      const cues = new Map((timeline.subtitles?.cues ?? []).map(cue => [cue.id, cue] as const));
      for (const clip of delta.clips) clips.set(clip.id, clip);
      for (const cue of delta.cues) cues.set(cue.id, cue);
      for (const id of delta.removedClipIds) clips.delete(id);
      for (const id of delta.removedCueIds) cues.delete(id);
      const nextClips = [...clips.values()];
      const nextCues = [...cues.values()];
      const durationFrames = nextClips.reduce((maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames), 0);
      const nextTimeline: Format5Timeline = {...timeline, revision: timeline.revision + 1, updatedAt: now(), durationFrames,
        clips: nextClips};
      if (timeline.subtitles) nextTimeline.subtitles = {...timeline.subtitles, cues: nextCues};
      store.put('timelines', nextTimeline);
      const sync = readSync();
      const nextBaseline = applySequenceEditBaselineChange(sync.baseline, delta.baseline);
      if (!nextBaseline) throw new TypeError('Format-5 history cannot delete the sync baseline');
      const update = store.db.prepare('UPDATE project.sequence_sync_state SET revision=revision+1,baseline=? WHERE timelineId=? AND revision=?')
        .run(JSON.stringify(nextBaseline), nextTimeline.id, sync.revision);
      if (Number(update.changes) !== 1) return {ok: false as const, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT' as never, ids: [timeline.id]};
      return {timelineRevision: nextTimeline.revision, syncRevision: sync.revision + 1};
    },
  };
}
