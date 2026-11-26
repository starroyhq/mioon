/** FR-B: render/export projection for a format-5 project.
 *
 * The renderer consumes the legacy frozen snapshot shape while format 5 stores
 * native clip/cue rows. This projects the assembled row timeline into that
 * shape, strips the format-5-only fields the frozen schema does not allow, and
 * refuses placeholders / pending too-short versions through the TSb export
 * ticket rules before any media metadata is frozen.
 */
import {assertTimelineSpeedRenderable} from '../../contracts/src/timeline-speed-render.ts';
import {timelineSpeedExportSnapshotFields} from '../../contracts/src/timeline-speed-export.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {timelineStorageFormat, timelineStorageSchema} from './project-file/timeline-storage.ts';
import {timelineSpeedExportLayout, type SpeedExportSnapshotContext} from './timeline-speed-export-admission.ts';
import {freezeTimelineOpticalProxies} from './timeline-speed-export-optical.ts';
import type {TimelineOpticalProxyPort} from './timeline-processing/optical-proxy-port.ts';
import {freezeTimelineReverseProxies, type TimelineReverseProxyPort} from './timeline-speed-export-proxy.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import type {Format5Cue, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {getFormat5TimelineIssue} from '../../contracts/src/project-format5.ts';
import type {TimelineRecord, TimelineClipRecord, TimelineSubtitleCueRecord} from './timeline-inputs.ts';
import {freezeTimelineSnapshot} from './timeline-inputs.ts';
import type {ManagedAssetRecord} from './timeline-inputs.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import {format5ExportBlockersFromTimeline} from './format5-timeline-export.ts';
import {timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, unknown>;
const sha256 = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const mediaMime = (value: unknown): boolean => typeof value === 'string' &&
  ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'].includes(value);
/** Format-5 assets are native project rows, so render reads that same owned
 * row instead of the legacy inspection graph (which is scoped to released
 * formats). The locator still has to be one the project file already admits. */
function readFormat5Asset(store: ProjectStore, assetId: string): ManagedAssetRecord | null {
  const row = store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(assetId) as {data?: unknown} | undefined;
  if (typeof row?.data !== 'string') return null;
  let value: Row;
  try {value = JSON.parse(row.data) as Row;} catch {return null;}
  if (value.projectId !== store.projectId || value.id !== assetId || !sha256(value.sha256) || !mediaMime(value.mimeType)) return null;
  if (value.duration !== undefined && value.duration !== null && (typeof value.duration !== 'number' || !Number.isFinite(value.duration))) return null;
  const reference = value.reference === undefined ? null : value.reference;
  if (reference !== null) {
    const parsed = mediaReferenceSchema.safeParse(reference);
    if (!parsed.success || parsed.data.fullSha256 !== value.sha256 || parsed.data.sizeBytes !== value.sizeBytes) return null;
  } else if (typeof value.relativePath !== 'string' || !value.relativePath.startsWith('media/')) return null;
  return {...value, id: assetId} as unknown as ManagedAssetRecord;
}
export interface Format5RenderProjection {
  readonly format5: Format5Timeline;
  readonly legacy: TimelineRecord;
  readonly assets: ReadonlyMap<string, ManagedAssetRecord>;
}
function stripClip(clip: Format5Timeline['clips'][number], keepTiming = false): TimelineClipRecord {
  const {sourceState: _state, sequenceSource: _sequence, anchor: _anchor, timing, sourceSpanFrames, ...legacy} = clip as TimelineClipRecord & Row;
  return (keepTiming && timing ? {...legacy, timing, sourceSpanFrames} : legacy) as TimelineClipRecord;
}
function stripCue(cue: Format5Cue): TimelineSubtitleCueRecord {
  const {anchor: _anchor, dialogueRef: _dialogue, ...legacy} = cue as unknown as TimelineSubtitleCueRecord & Row;
  return legacy as TimelineSubtitleCueRecord;
}
function exportRange(input: {exportRange?: unknown}): {startFrame: number; endFrame: number} | null {
  if (input.exportRange === undefined) return null;
  return input.exportRange as {startFrame: number; endFrame: number};
}

/** Pure projection read; no file/probe work and no write. */
export function readFormat5RenderProjection(store: ProjectStore, {purpose}: {purpose?: unknown} = {}): Format5RenderProjection | null {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) return null;
  const keepTiming = purpose === 'export' &&
    timelineStorageFormat(store.db, timelineStorageSchema(store.db)) === FORMAT6_PROJECT_SCHEMA_VERSION;
  if (!keepTiming) assertTimelineSpeedRenderable(timeline);
  const {mainTrack: _mainTrack, clips, subtitles, ...header} = timeline as Format5Timeline & Row;
  const legacyClips = clips.map(clip => stripClip(clip, keepTiming));
  const cues = subtitles?.cues.map(stripCue) ?? [];
  const legacy: TimelineRecord = {...header, clips: legacyClips,
    ...(subtitles && cues.length ? {subtitles: {profileId: subtitles.profileId,
      ...(subtitles.basisPresetId !== undefined ? {basisPresetId: subtitles.basisPresetId} : {}), cues}} : {})} as TimelineRecord;
  const assets = new Map<string, ManagedAssetRecord>();
  for (const clip of legacyClips) {
    // A format-5 placeholder has no source yet. The render/export admission
    // boundary reports it as a named blocker before this projection is frozen;
    // the projection itself must not turn every whole-timeline read into 404.
    if ((clip as {assetId?: unknown}).assetId === null) continue;
    if (typeof clip.assetId !== 'string') throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线还有未生成片段，不能导出。', 409, {clipId: clip.id});
    if (!assets.has(clip.assetId)) {
      const asset = readFormat5Asset(store, clip.assetId);
      if (!asset) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线素材不可用。', 409, {clipId: clip.id});
      assets.set(clip.assetId, asset as unknown as ManagedAssetRecord);
    }
  }
  return {format5: timeline, legacy, assets};
}

/** Audio-only projection. It validates the whole format-5 aggregate, then omits
 * placeholders (they have no source to decode) instead of rejecting the entire
 * timeline. Single-clip loudness still validates its selected clip's own source;
 * mix/preview audio reads the remaining real clips and treats placeholder spans
 * as silence. Render/export keeps the stricter projection above. */
export function readFormat5AudioProjection(store: ProjectStore): {legacy: TimelineRecord; assets: ReadonlyMap<string, ManagedAssetRecord>} | null {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) return null;
  const issue = getFormat5TimelineIssue(timeline, {projectId: store.projectId});
  if (issue) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线数据不可用。', 409, {clipIds: issue.ids ?? []});
  assertTimelineSpeedRenderable(timeline);
  const {mainTrack: _mainTrack, clips, subtitles, ...header} = timeline as Format5Timeline & Row;
  const ready = clips.filter(clip => clip.sourceState !== 'placeholder' && clip.assetId !== null);
  const legacyClips = ready.map(clip => stripClip(clip));
  const cues = subtitles?.cues.map(stripCue) ?? [];
  // The audio range ends at the last clip that actually has a source. A trailing
  // placeholder is silence and must not make the mix decoder reject a timeline
  // whose final audible frame is earlier.
  const durationFrames = ready.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
  const legacy: TimelineRecord = {...header, durationFrames, clips: legacyClips,
    ...(subtitles && cues.length ? {subtitles: {profileId: subtitles.profileId,
      ...(subtitles.basisPresetId !== undefined ? {basisPresetId: subtitles.basisPresetId} : {}), cues}} : {})} as TimelineRecord;
  const assets = new Map<string, ManagedAssetRecord>();
  for (const clip of ready) {
    if (typeof clip.assetId !== 'string') throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线素材不可用。', 409, {clipId: clip.id});
    if (!assets.has(clip.assetId)) {
      const asset = readFormat5Asset(store, clip.assetId);
      if (!asset) throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '时间线素材不可用。', 409, {clipId: clip.id});
      assets.set(clip.assetId, asset as unknown as ManagedAssetRecord);
    }
  }
  return {legacy, assets};
}

/** Preflight and enqueue hash the same frozen projection. */
export function freezeFormat5RenderProjection(projection: Format5RenderProjection, input: {
  readonly exportSettings?: unknown; readonly exportRange?: unknown; readonly deliveryName?: string;
}, reverseProxy?: TimelineReverseProxyPort, opticalProxy?: TimelineOpticalProxyPort): Row {
  const {legacy, assets} = projection;
  const retimes = legacy.clips.some(clip => clip.timing);
  if (retimes) {
    const rangeIssue = timelineExportRangeBoundsIssue(input, legacy.durationFrames);
    if (rangeIssue) throw new AppError(rangeIssue.code, rangeIssue.message, rangeIssue.status);
  }
  const frozen = freezeTimelineSnapshot(legacy, assets, input.exportSettings, input) as Row;
  if (retimes) {
    Object.assign(frozen, timelineSpeedExportSnapshotFields(legacy));
    const snapshot = frozen as unknown as SpeedExportSnapshotContext;
    const layout = timelineSpeedExportLayout(snapshot, assets);
    if (layout) {
      const phases = new Map(layout.clips.flatMap(clip => clip.interpolation ? [[clip.clipId, clip.interpolation.phase] as const] : []));
      const opticalProxies = freezeTimelineOpticalProxies(snapshot, layout, assets, opticalProxy);
      const reverseProofs = freezeTimelineReverseProxies(snapshot, layout, assets, reverseProxy);
      if (phases.size || opticalProxies.size || reverseProofs.size) {
        Object.assign(frozen, timelineSpeedExportSnapshotFields(legacy, reverseProofs, {phases, opticalProxies}));
      }
    }
  }
  return frozen;
}

/** Freeze the renderer snapshot, refusing blocked exports first. */
export function freezeFormat5RenderSnapshot(store: ProjectStore, input: {
  readonly expectedRevision?: number;
  readonly purpose?: unknown;
  readonly exportSettings?: unknown;
  readonly exportRange?: unknown;
  readonly deliveryName?: string;
  readonly preflightSnapshotHash?: string;
} = {}, reverseProxy?: TimelineReverseProxyPort, opticalProxy?: TimelineOpticalProxyPort): unknown {
  const projection = readFormat5RenderProjection(store, {purpose: input.purpose});
  if (!projection) throw new AppError('EMPTY_TIMELINE', '请先向时间线添加片段', 409);
  const timeline = projection.format5;
  if (input.expectedRevision !== undefined && input.expectedRevision !== timeline.revision) {
    throw new AppError('REVISION_CONFLICT', '时间线已有新版本，请重新读取后再修改', 409,
      {expectedRevision: input.expectedRevision, currentRevision: timeline.revision});
  }
  const rangeIssue = timelineExportRangeBoundsIssue(input, timeline.durationFrames);
  if (rangeIssue) throw new AppError(rangeIssue.code, rangeIssue.message, rangeIssue.status);
  const range = exportRange(input);
  const blockers = format5ExportBlockersFromTimeline(store.db, timeline, range);
  if (blockers.length) {
    const placeholder = blockers.find(blocker => blocker.code === 'PLACEHOLDER_CLIP');
    throw new AppError('EXPORT_BLOCKED', placeholder?.shotTitle
      ? `镜头「${placeholder.shotTitle}」还没生成，先补上素材再导出。`
      : '时间线还有未生成片段或待选版本的片段，不能导出。', 409, {blockers});
  }
  if (!projection.legacy.clips.length) throw new AppError('EMPTY_TIMELINE', '请先向时间线添加片段', 409);
  return freezeFormat5RenderProjection(projection, input, reverseProxy, opticalProxy);
}
