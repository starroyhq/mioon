import {lstatSync, realpathSync, statfsSync} from 'node:fs';
import {join} from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {OUTPUT_ARTIFACT_MAX_BYTES} from '../../contracts/src/output-artifact.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../../contracts/src/project-output-publication.ts';
import {
  TIMELINE_EXPORT_4K_MAX_FPS, TIMELINE_EXPORT_RESOLUTIONS,
  timelineExport4KFrameRateSupported, timelineOutputPreset,
} from '../../contracts/src/timeline-output-geometry.ts';
import {
  TIMELINE_EXPORT_DEFAULT_SETTINGS, resolveTimelineExportDelivery,
} from '../../contracts/src/timeline-export-profile.ts';
import type {TimelineExportSettings} from '../../contracts/src/timeline-export-profile.ts';
import {timelineExportEstimateSchemas} from '../../contracts/src/timeline-export-estimate.ts';
import type {
  TimelineExportEstimateResponse, TimelineExportResourceIssue,
} from '../../contracts/src/timeline-export-estimate.ts';
import {timelineExportRangeFields} from '../../contracts/src/timeline-export-range.ts';
import type {ProjectStore} from './project-file/store.ts';
import {readTimelineHeaderStorage, readTimelineStorage} from './project-file/timeline-storage.ts';
import {outputFileIdentity, sameOutputIdentity, verifyProjectOutputStore} from './project-output-owner.ts';
import {encoderMemoryAllows, encoderResidentBytesForOutput} from './media-encoder-pool.ts';
import {timelineExportRangeBoundsIssue} from './timeline-export-range.ts';
import type {TimelineRecord} from './timeline-inputs.ts';
import {timeline4kRasterBudget} from './timeline-4k-raster-budget.ts';
import type {TimelineExportRange} from '../../contracts/src/timeline-export-range.ts';
import {assertProjectStore} from './store-runtime.ts';

interface ExportBasis {
  readonly id: string;
  readonly revision: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
}
type RasterTimeline = Pick<TimelineRecord,'width'|'height'|'fps'|'clips'|'tracks'>;
interface RasterContext {
  readonly timeline: RasterTimeline;
  readonly range?: TimelineExportRange;
}

interface ExportInput {
  readonly projectId: string;
  readonly expectedRevision?: unknown;
  readonly exportSettings?: unknown;
  readonly exportRange?: unknown;
}

export interface TimelineExportResourceOptions {
  /** Trusted service ports; never read from an RPC request. */
  availableBytes?: (store: ProjectStore) => number | null;
  memoryAllows?: (requiredBytes: number) => boolean;
}

export const invalidTimelineExportBasis = (): AppError =>
  new AppError('INVALID_TIMELINE_SNAPSHOT', '时间线包含无效的导出设置', 409);

export function readTimelineExportBasis(store: ProjectStore, projectId: string): ExportBasis | null {
  assertProjectStore(store);
  if (store.projectId !== projectId)
    throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
  const stored = readTimelineHeaderStorage(store.db, projectId);
  if (!stored) return null;
  const value = stored.header as (ExportBasis & {projectId: string}) | null;
  // The current 30fps persistence contract is separate from the export limit.
  // Validate the existing aspect, including while #432 adds saved FPS values.
  if (!value || value.id !== stored.id || value.projectId !== projectId ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Number.isSafeInteger(value.fps) || value.fps < 1 || value.fps > 60 ||
      !Number.isSafeInteger(value.durationFrames) || value.durationFrames < 0 ||
      !timelineOutputPreset({...value, fps: TIMELINE_EXPORT_4K_MAX_FPS})) throw invalidTimelineExportBasis();
  return {id: value.id, revision: value.revision, fps: value.fps, width: value.width,
    height: value.height, durationFrames: value.durationFrames};
}

function targetVolumeAvailableBytes(store: ProjectStore): number | null {
  const unavailable = () => new AppError('PROJECT_UNAVAILABLE', '导出位置已改变，请重新打开项目', 409);
  try {
    const owner = verifyProjectOutputStore(store);
    const directory = join(store.projectDir, PROJECT_OUTPUT_FOLDERS.exports);
    const before = lstatSync(directory, {bigint: true, throwIfNoEntry: false});
    if (before && (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory))
      throw unavailable();
    const info = statfsSync(before ? directory : store.projectDir, {bigint: true});
    const after = lstatSync(directory, {bigint: true, throwIfNoEntry: false});
    if (!sameOutputIdentity(owner, verifyProjectOutputStore(store)) ||
        (before && after ? !sameOutputIdentity(outputFileIdentity(before), outputFileIdentity(after)) : before !== after))
      throw unavailable();
    const bytes = info.bavail * info.bsize;
    return bytes < 0n ? null : Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(String((error as NodeJS.ErrnoException)?.code))) return null;
    throw unavailable();
  }
}

export function timelineExportFrameRateIssue(fps: number, settings: unknown): TimelineExportResourceIssue | null {
  if ((settings as TimelineExportSettings | undefined)?.resolution !== 'short_2160' || timelineExport4KFrameRateSupported(fps))
    return null;
  return {code: 'EXPORT_4K_FPS_UNSUPPORTED', severity: 'error', message: `${fps} fps 暂不支持 4K`,
    details: {fps, maxFps: TIMELINE_EXPORT_4K_MAX_FPS}};
}

export function timelineExportResourceError(issue: TimelineExportResourceIssue): AppError {
  return new AppError(issue.code, issue.message, 409, issue.details);
}

// A content-dependent CRF estimate, based on one CRF-23 reference. Each +6
// CRF approximately halves the model bitrate. MP4 overhead excludes audio.
const CRF23_BITS_PER_PIXEL_FRAME = 0.04;
const ENCODE_PIXELS_PER_SECOND = 400_000_000;
const MP4_OVERHEAD = 1.01;

export function estimateTimelineExportRow(timeline: ExportBasis, settings: TimelineExportSettings, frames: number,
    availableBytes: number | null, memoryAllows: (requiredBytes: number) => boolean, raster?: RasterContext): TimelineExportEstimateResponse['estimates'][number] {
  const {effective} = resolveTimelineExportDelivery({...timeline, fps: TIMELINE_EXPORT_4K_MAX_FPS}, settings);
  const {width, height, rateControl, audioKbps} = effective;
  const pixels = width * height, duration = frames / timeline.fps;
  const videoKbps = rateControl.mode === 'bitrate' ? rateControl.targetKbps
    : CRF23_BITS_PER_PIXEL_FRAME * pixels * timeline.fps / 1000 * 2 ** ((23 - rateControl.crf) / 6);
  const estimatedBytes = Math.ceil((videoKbps + audioKbps) * 1000 / 8 * duration * MP4_OVERHEAD);
  const estimatedSeconds = frames ? 1 + pixels * frames / ENCODE_PIXELS_PER_SECOND : 0;
  const issues: TimelineExportResourceIssue[] = [];
  const fpsIssue = timelineExportFrameRateIssue(timeline.fps, settings);
  if (fpsIssue) issues.push(fpsIssue);
  else if (settings.resolution === 'short_2160') {
    const budget = raster ? timeline4kRasterBudget(raster.timeline, {width, height}, raster.range) : null;
    const requiredBytes = budget?.residentBytes ?? encoderResidentBytesForOutput(width, height);
    if (budget?.unsupportedRaster) issues.push({
      code: 'EXPORT_4K_RASTER_UNSUPPORTED', severity: 'error', message: '所选范围的片段变换超出了 4K 合成可处理的像素上限',
      details: budget.unsupportedRaster,
    });
    else if (!memoryAllows(requiredBytes)) issues.push({
      code: 'EXPORT_4K_MEMORY_INSUFFICIENT', severity: 'error', message: '设备内存不足以导出 4K',
      details: {requiredBytes},
    });
  }
  if (estimatedBytes > OUTPUT_ARTIFACT_MAX_BYTES) issues.push({
    code: 'EXPORT_OUTPUT_TOO_LARGE', severity: 'error', message: '预计成品将超过单个文件 8 GiB 的上限',
    details: {estimatedBytes, maxBytes: OUTPUT_ARTIFACT_MAX_BYTES},
  });
  if (availableBytes !== null && estimatedBytes > availableBytes) issues.push({
    code: 'EXPORT_DISK_SPACE_INSUFFICIENT', severity: 'error', message: '导出位置的可用空间不足',
    details: {estimatedBytes, availableBytes},
  });
  return {resolution: settings.resolution, width, height, estimatedBytes, estimatedSeconds, issues};
}

function outputFrames(input: unknown, timeline: ExportBasis): number {
  const {exportRange} = timelineExportRangeFields(input);
  return exportRange ? exportRange.endFrame - exportRange.startFrame : timeline.durationFrames;
}

export function createTimelineExportResourceServices(store: ProjectStore, {
  availableBytes = targetVolumeAvailableBytes, memoryAllows = encoderMemoryAllows,
}: TimelineExportResourceOptions = {}) {
  const readSpace = () => {
    const bytes = availableBytes(store);
    return bytes === null || Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  };

  function rasterContext(timeline: ExportBasis, input: ExportInput): RasterContext {
    const saved = readTimelineStorage(store.db, input.projectId);
    if (!saved || saved.id !== timeline.id) throw invalidTimelineExportBasis();
    const record = saved.timeline as RasterTimeline;
    if (!record || !Array.isArray(record.clips) || !Array.isArray(record.tracks)) throw invalidTimelineExportBasis();
    const {exportRange} = timelineExportRangeFields(input);
    return {timeline: record, ...(exportRange ? {range: exportRange} : {})};
  }

  function selectedIssue(input: ExportInput, timeline: ExportBasis): TimelineExportResourceIssue | null {
    const settings = (input.exportSettings ?? TIMELINE_EXPORT_DEFAULT_SETTINGS) as TimelineExportSettings;
    const fpsIssue = timelineExportFrameRateIssue(timeline.fps, settings);
    if (fpsIssue) return fpsIssue;
    const raster = settings.resolution === 'short_2160' ? rasterContext(timeline, input) : undefined;
    return estimateTimelineExportRow(timeline, settings, outputFrames(input, timeline), readSpace(), memoryAllows, raster).issues[0] ?? null;
  }

  function estimate(raw: unknown): TimelineExportEstimateResponse {
    const parsed = timelineExportEstimateSchemas['timeline.export.estimate'].safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '导出估算参数无效', 400);
    const input = parsed.data;
    const timeline = readTimelineExportBasis(store, input.projectId);
    if (!timeline) throw new AppError('TIMELINE_MISSING', '项目还没有保存的时间线', 404);
    if (timeline.revision !== input.expectedRevision)
      throw new AppError('REVISION_CONFLICT', '时间线版本已变化，请重新估算', 409,
        {expectedRevision: input.expectedRevision, timelineRevision: timeline.revision});
    const rangeIssue = timelineExportRangeBoundsIssue(input, timeline.durationFrames);
    if (rangeIssue) throw new AppError(rangeIssue.code, rangeIssue.message, rangeIssue.status);
    const frames = outputFrames(input, timeline), free = readSpace();
    const raster = timelineExport4KFrameRateSupported(timeline.fps) ? rasterContext(timeline, input) : undefined;
    return {
      projectId: input.projectId, timelineId: timeline.id, timelineRevision: timeline.revision,
      expectedRevision: input.expectedRevision, fps: timeline.fps, availableBytes: free,
      estimates: TIMELINE_EXPORT_RESOLUTIONS.map(resolution => estimateTimelineExportRow(timeline,
        {profileId: input.profileId, rateControl: input.rateControl, resolution}, frames, free, memoryAllows, raster)),
    };
  }

  return {handlers: {'timeline.export.estimate': estimate}, selectedIssue};
}
