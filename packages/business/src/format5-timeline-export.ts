/** Format-5 export admission boundary (TSb).
 *
 * An export ticket freezes the exact timeline projection and the three
 * revisions a sync transaction may advance (`contentRevision`, `timelineRevision`
 * and the film's `syncRevision`). The async admission path must re-read and
 * compare the ticket immediately before the final enqueue; an already queued
 * export keeps its own frozen snapshot and is unaffected by later edits.
 *
 * Blockers are decided from the frozen timeline only: a placeholder in the
 * selected range always blocks, and a follow clip whose selected version is
 * shorter than its cut asks the user to select/lock a usable version first
 * (P5 D4). Nothing here writes project data.
 */
import {assertTimelineSpeedRenderable} from '../../contracts/src/timeline-speed-render.ts';
import {isSequenceProjectFormat} from './project-file/schema/databases.ts';
import {createHash} from 'node:crypto';
import {AppError, sourceFrameCount} from '@mioon/contracts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, any>;

export const FORMAT5_EXPORT_TICKET_VERSION = 1 as const;
export const FORMAT5_EXPORT_BLOCKER_CODES = Object.freeze(['PLACEHOLDER_CLIP', 'VERSION_TOO_SHORT'] as const);
export type Format5ExportBlockerCode = (typeof FORMAT5_EXPORT_BLOCKER_CODES)[number];

export interface Format5ExportBlocker {
  readonly code: Format5ExportBlockerCode;
  readonly clipId: string;
  readonly nodeId: string;
  /** Human-readable shot title when the board row provides one. */
  readonly shotTitle?: string;
  /** Present for VERSION_TOO_SHORT: the selected-but-unsynced version. */
  readonly versionId?: string;
  readonly shortByFrames?: number;
}

export interface Format5ExportRange {
  readonly startFrame: number;
  readonly endFrame: number;
}

export interface Format5ExportTicket {
  readonly version: typeof FORMAT5_EXPORT_TICKET_VERSION;
  readonly projectId: string;
  readonly timelineId: string;
  readonly contentRevision: number;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  readonly range: Format5ExportRange | null;
  /** sha256 of the frozen projection + revisions; later edits change it. */
  readonly snapshotHash: string;
  readonly blockers: readonly Format5ExportBlocker[];
  readonly createdAt: string;
}

const format5 = (store: ProjectStore): boolean =>
  isSequenceProjectFormat(store.db.prepare('PRAGMA project.user_version').get()?.user_version);
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
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function intersects(clip: {startFrame: number; durationFrames: number}, range: Format5ExportRange | null): boolean {
  if (!range) return true;
  return clip.startFrame < range.endFrame && clip.startFrame + clip.durationFrames > range.startFrame;
}

function readSyncRevision(store: ProjectStore): number {
  const row = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  if (!row || !Number.isSafeInteger(row.revision)) {
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '时间线没有绑定成片根。', 409, {reason: 'ROOT_NOT_BOUND'});
  }
  return Number(row.revision);
}

/** Blockers of one frozen format-5 projection at an optional export range. The
 * async admission and preflight reporters consume this exact list. */
export function format5ExportBlockersFromTimeline(db: ProjectStore['db'], timeline: Format5Timeline,
  range: Format5ExportRange | null = null): Format5ExportBlocker[] {
  const blockers: Format5ExportBlocker[] = [];
  const mainTrackId = timeline.mainTrack.trackId;
  const shots = new Map((db.prepare('SELECT id,data FROM project.shots').all() as Row[])
    .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
  const versions = new Map((db.prepare('SELECT id,data FROM project.versions').all() as Row[])
    .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
  const assets = new Map((db.prepare('SELECT id,data FROM project.assets').all() as Row[])
    .map(row => [String(row.id), JSON.parse(String(row.data)) as Row]));
  for (const clip of timeline.clips) {
    if (clip.trackId !== mainTrackId || !intersects(clip, range)) continue;
    const source = clip.sequenceSource;
    if (!source) continue;
    if (clip.sourceState === 'placeholder') {
      const shot = shots.get(source.nodeId);
      const shotTitle = typeof shot?.title === 'string' && shot.title ? shot.title : undefined;
      blockers.push({code: 'PLACEHOLDER_CLIP', clipId: clip.id, nodeId: source.nodeId, ...(shotTitle ? {shotTitle} : {})});
      continue;
    }
    if (source.kind !== 'shot' || source.versionMode !== 'follow') continue;
    const shot = shots.get(source.nodeId);
    const selected = typeof shot?.selectedVersionId === 'string' ? shot.selectedVersionId : null;
    if (selected === null || selected === clip.versionId) continue;
    const version = versions.get(selected);
    const asset = version && typeof version.assetId === 'string' ? assets.get(version.assetId) : undefined;
    const sourceFrames = sourceFrameCount(asset?.duration);
    const needed = clip.sourceInFrame + clip.durationFrames;
    if (sourceFrames !== null && sourceFrames < needed) {
      blockers.push({code: 'VERSION_TOO_SHORT', clipId: clip.id, nodeId: source.nodeId, versionId: selected,
        shortByFrames: needed - sourceFrames});
    }
  }
  return blockers;
}
/** Read the format-5 projection and freeze an export ticket. */
export function createFormat5ExportTicket(store: ProjectStore, range: Format5ExportRange | null = null): Format5ExportTicket {
  if (!format5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于项目格式 5。', 409, {reason: 'FORMAT_REQUIRED'});
  return store.tx(() => {
    const timeline = readFormat5TimelineRecord(store.db, 'project');
    if (!timeline || timeline.projectId !== store.projectId) {
      throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线。', 422, {database: 'project', reason: 'metadata'});
    }
    assertTimelineSpeedRenderable(timeline);
    const stamp = readProjectContentStamp(store.db);
    const blockers = format5ExportBlockersFromTimeline(store.db, timeline, range);
    const revisions = {contentRevision: stamp.contentSequence, timelineRevision: timeline.revision,
      syncRevision: readSyncRevision(store), range};
    const snapshotHash = sha256({projectId: store.projectId, timelineId: timeline.id, ...revisions,
      clips: timeline.clips, subtitles: timeline.subtitles});
    return {version: FORMAT5_EXPORT_TICKET_VERSION, projectId: store.projectId, timelineId: timeline.id,
      contentRevision: revisions.contentRevision, timelineRevision: revisions.timelineRevision,
      syncRevision: revisions.syncRevision, range, snapshotHash, blockers, createdAt: new Date().toISOString()};
  });
}

export interface Format5ExportRecheck {readonly ok: true; readonly ticket: Format5ExportTicket}
export interface Format5ExportStale {readonly ok: false; readonly code: 'EXPORT_SNAPSHOT_STALE'; readonly ids: readonly string[]}

/** Re-read the three revisions and the frozen projection right before the final
 * enqueue. A changed ticket is stale: the caller must re-preview, never enqueue
 * against the old ticket. */
export function recheckFormat5ExportTicket(store: ProjectStore, ticket: Format5ExportTicket): Format5ExportRecheck | Format5ExportStale {
  if (!format5(store)) return {ok: false, code: 'EXPORT_SNAPSHOT_STALE', ids: [ticket.timelineId]};
  return store.tx(() => {
    const timeline = readFormat5TimelineRecord(store.db, 'project');
    const stamp = readProjectContentStamp(store.db);
    const syncRevision = readSyncRevision(store);
    const snapshotHash = timeline === null ? null : sha256({projectId: store.projectId, timelineId: timeline.id,
      contentRevision: stamp.contentSequence, timelineRevision: timeline.revision, syncRevision, range: ticket.range,
      clips: timeline.clips, subtitles: timeline.subtitles});
    if (!timeline || timeline.id !== ticket.timelineId || timeline.projectId !== ticket.projectId
      || stamp.contentSequence !== ticket.contentRevision || timeline.revision !== ticket.timelineRevision
      || syncRevision !== ticket.syncRevision || snapshotHash !== ticket.snapshotHash) {
      return {ok: false, code: 'EXPORT_SNAPSHOT_STALE', ids: [ticket.timelineId]};
    }
    return {ok: true, ticket};
  });
}

/** Admission decision for a fresh ticket: placeholders and pending too-short
 * follow versions block the whole export with the concrete clip/node ids. */
export function assertFormat5ExportAdmissible(ticket: Format5ExportTicket): void {
  if (ticket.blockers.length === 0) return;
  const placeholder = ticket.blockers.find(blocker => blocker.code === 'PLACEHOLDER_CLIP');
  throw new AppError('EXPORT_BLOCKED', placeholder?.shotTitle
    ? `镜头「${placeholder.shotTitle}」还没生成，先补上素材再导出。`
    : '时间线还有未生成片段或待选版本的片段，不能导出。', 409, {blockers: ticket.blockers});
}

export type {Format5Clip, Format5Timeline};
