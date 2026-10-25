import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';

type Rec = Record<string, unknown>;
// Canvas → timeline bridges: refresh clips whose shot selected a newer version,
// and append shots that are not on the timeline yet. Both are ordinary keyed
// timeline edits with one history entry; their responses add bounded outcomes.
export const TIMELINE_SOURCE_REFRESH_OPERATION = 'timeline.clip.refreshSources';
export const TIMELINE_SHOT_APPEND_OPERATION = 'timeline.shots.append';
export const TIMELINE_SHOT_SYNC_OPERATIONS = Object.freeze([TIMELINE_SOURCE_REFRESH_OPERATION, TIMELINE_SHOT_APPEND_OPERATION] as const);
export const TIMELINE_SHOT_SYNC_LIMITS = Object.freeze({clips: 100, shots: 100});
/** NOT_GENERATED: the clip's asset is not a generated version. NO_SELECTION:
 * its shot selects no version. UP_TO_DATE: it already uses the selected
 * version. SOURCE_TOO_SHORT: the selected version cannot cover the clip's
 * source range (sourceInFrame + durationFrames on the 30 fps grid). */
export const TIMELINE_SOURCE_REFRESH_SKIP_REASONS = Object.freeze(['NOT_GENERATED', 'NO_SELECTION', 'UP_TO_DATE', 'SOURCE_TOO_SHORT'] as const);
export const TIMELINE_SHOT_APPEND_SKIP_REASONS = Object.freeze(['NO_SELECTION'] as const);
// The timeline record plus at most 100 refreshed/appended and 100 skipped rows.
export const TIMELINE_SHOT_SYNC_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 64 * 1024;
// Pre-write rejections whose rollback the backend can prove. Their proofs bind
// operation, project and request; a missing clip or track stays uncertain.
export const TIMELINE_SHOT_SYNC_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'TIMELINE_LIMIT', 'SOURCE_BOUNDS',
  'INVALID_CLIP_TYPE', 'NOTHING_TO_REFRESH', 'NOTHING_TO_APPEND'] as const);

export type TimelineSourceRefreshSkipReason = typeof TIMELINE_SOURCE_REFRESH_SKIP_REASONS[number];
export interface TimelineSourceRefreshed {clipId: string; shotId: string; fromVersionId: string; toVersionId: string; assetId: string}
export interface TimelineSourceRefreshSkipped {
  clipId: string; reason: TimelineSourceRefreshSkipReason;
  shotId?: string; fromVersionId?: string; toVersionId?: string; shortByFrames?: number;
}
export interface TimelineSourceRefreshResponse {
  operation: typeof TIMELINE_SOURCE_REFRESH_OPERATION; requestId: string; timeline: Rec;
  refreshed: TimelineSourceRefreshed[]; skipped: TimelineSourceRefreshSkipped[];
}
export interface TimelineShotAppended {clipId: string; shotId: string; versionId: string; startFrame: number; durationFrames: number}
export interface TimelineShotAppendSkipped {shotId: string; reason: typeof TIMELINE_SHOT_APPEND_SKIP_REASONS[number]}
export interface TimelineShotAppendResponse {
  operation: typeof TIMELINE_SHOT_APPEND_OPERATION; requestId: string; timeline: Rec;
  appended: TimelineShotAppended[]; skipped: TimelineShotAppendSkipped[];
}

const id = z.string().uuid(), key = z.string().min(8).max(200);
const mutation = {projectId: id, expectedRevision: z.number().int().positive(), requestId: key};
export const timelineShotSyncSchemas = Object.freeze({
  [TIMELINE_SOURCE_REFRESH_OPERATION]: z.object({...mutation, clipIds: z.array(id).min(1).max(TIMELINE_SHOT_SYNC_LIMITS.clips)
    .refine(ids => new Set(ids).size === ids.length, 'clipIds must be unique')}).strict(),
  [TIMELINE_SHOT_APPEND_OPERATION]: z.object(mutation).strict(),
});
export const timelineShotSyncDescriptions = Object.freeze({
  [TIMELINE_SOURCE_REFRESH_OPERATION]: '按时间线版本把来源镜头已改选新版本的片段批量换成选中版本并固定来源；保留片段ID、位置、时长、源入点、画面、音量和淡入淡出；未来自生成版本、镜头未选版本、已是最新或新版本不足以覆盖源区间的片段跳过并返回原因；整批记一条历史，撤销一次全部回退；没有可更新的片段时不写入；使用必填稳定requestId精确重放，不生成或处理媒体',
  [TIMELINE_SHOT_APPEND_OPERATION]: '按时间线版本把还没有片段的镜头按画板顺序、用其选中版本完整时长追加到第一条视频轨末尾并固定来源；已有片段不动；未选版本的镜头跳过并返回原因；记一条历史可撤销；没有可追加的镜头时不写入；使用必填稳定requestId精确重放，不生成或处理媒体',
});

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exactKeys = (value: Rec, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_SHOT_SYNC_RESPONSE_BYTES;} catch {return false;}
}
/** New operations bind every identity field in a not-applied proof, never the
 * legacy optional operation/project fields. */
export function hasTimelineShotSyncNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    const schema = (timelineShotSyncSchemas as Readonly<Record<string, z.ZodTypeAny>>)[operation as string];
    if (!schema || !schema.safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_SHOT_SYNC_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}
const skipFields: Readonly<Record<TimelineSourceRefreshSkipReason, readonly string[]>> = Object.freeze({
  NOT_GENERATED: [], NO_SELECTION: ['shotId', 'fromVersionId'], UP_TO_DATE: ['shotId', 'fromVersionId'],
  SOURCE_TOO_SHORT: ['shotId', 'fromVersionId', 'toVersionId', 'shortByFrames'],
});

/** Keep the single established timeline DTO validator; do not grow a second
 * timeline parser. Every requested clip is accounted for exactly once, in
 * request order within each list, and every outcome matches the saved clip. */
export function createTimelineShotSyncContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function envelope(operation: string, value: unknown, input: Rec, outcomes: string): value is Rec {
    return object(value) && bounded(value) && exactKeys(value, ['operation', 'requestId', 'timeline', outcomes, 'skipped']) &&
      value.operation === operation && value.requestId === input.requestId && Array.isArray(value[outcomes]) && Array.isArray(value.skipped) &&
      (value[outcomes] as unknown[]).length >= 1 && input.expectedRevision !== Number.MAX_SAFE_INTEGER &&
      isTimelineRecord(value.timeline, {projectId: input.projectId}) && object(value.timeline) &&
      value.timeline.revision === (input.expectedRevision as number) + 1;
  }
  function isTimelineSourceRefreshResponse(value: unknown, input: unknown): value is TimelineSourceRefreshResponse {
    try {
      const parsed = timelineShotSyncSchemas[TIMELINE_SOURCE_REFRESH_OPERATION].safeParse(input);
      if (!parsed.success || !envelope(TIMELINE_SOURCE_REFRESH_OPERATION, value, input as Rec, 'refreshed')) return false;
      const order = new Map(parsed.data.clipIds.map((clipId, index) => [clipId, index] as const));
      const clips = (value.timeline as {clips?: unknown}).clips, seen = new Set<string>();
      if (!Array.isArray(clips)) return false;
      const clip = (clipId: string): Rec | undefined => clips.find((item: unknown) => object(item) && item.id === clipId) as Rec | undefined;
      const inOrder = (rows: unknown[]): boolean => rows.every((row, index) => index === 0 ||
        (order.get((rows[index - 1] as Rec).clipId as string) as number) < (order.get((row as Rec).clipId as string) as number));
      const account = (clipId: unknown): boolean => uuid(clipId) && order.has(clipId) && !seen.has(clipId) && Boolean(seen.add(clipId));
      const refreshed = value.refreshed as unknown[], skipped = value.skipped as unknown[];
      if (!refreshed.every(row => {
        if (!object(row) || !exactKeys(row, ['clipId', 'shotId', 'fromVersionId', 'toVersionId', 'assetId']) || !account(row.clipId) ||
          ![row.shotId, row.fromVersionId, row.toVersionId, row.assetId].every(uuid) || row.fromVersionId === row.toVersionId) return false;
        const saved = clip(row.clipId as string);
        return Boolean(saved && saved.assetId === row.assetId && saved.versionId === row.toVersionId && saved.shotId === row.shotId);
      }) || !inOrder(refreshed)) return false;
      if (!skipped.every(row => {
        if (!object(row) || typeof row.reason !== 'string' || !Object.hasOwn(skipFields, row.reason)) return false;
        const fields = skipFields[row.reason as TimelineSourceRefreshSkipReason];
        return exactKeys(row, ['clipId', 'reason', ...fields]) && account(row.clipId) && Boolean(clip(row.clipId as string)) &&
          fields.every(name => name === 'shortByFrames' ? integer(row[name], 1) : uuid(row[name])) &&
          (row.reason !== 'SOURCE_TOO_SHORT' || row.fromVersionId !== row.toVersionId);
      }) || !inOrder(skipped)) return false;
      return seen.size === order.size;
    } catch {return false;}
  }
  function isTimelineShotAppendResponse(value: unknown, input: unknown): value is TimelineShotAppendResponse {
    try {
      if (!timelineShotSyncSchemas[TIMELINE_SHOT_APPEND_OPERATION].safeParse(input).success ||
        !envelope(TIMELINE_SHOT_APPEND_OPERATION, value, input as Rec, 'appended')) return false;
      const timeline = value.timeline as {clips?: unknown}, appended = value.appended as unknown[], skipped = value.skipped as unknown[];
      if (!Array.isArray(timeline.clips) || appended.length > TIMELINE_SHOT_SYNC_LIMITS.shots || skipped.length > TIMELINE_SHOT_SYNC_LIMITS.shots) return false;
      const shots = new Set<string>(), clips = timeline.clips as unknown[];
      let track: unknown, nextFrame: number | undefined;
      // Appended clips are contiguous on one track at the end of it, full-length
      // from frame 0 of their source and pinned to the reported version and shot.
      for (const row of appended) {
        if (!object(row) || !exactKeys(row, ['clipId', 'shotId', 'versionId', 'startFrame', 'durationFrames']) ||
          ![row.clipId, row.shotId, row.versionId].every(uuid) || shots.has(row.shotId as string) ||
          !integer(row.startFrame, 0, 18000) || !integer(row.durationFrames, 1, 18000) || nextFrame !== undefined && row.startFrame !== nextFrame) return false;
        const saved = clips.find(item => object(item) && item.id === row.clipId) as Rec | undefined;
        if (!saved || saved.startFrame !== row.startFrame || saved.durationFrames !== row.durationFrames || saved.sourceInFrame !== 0 ||
          track !== undefined && saved.trackId !== track || saved.versionId !== row.versionId || saved.shotId !== row.shotId || Object.hasOwn(saved, 'jobId')) return false;
        if (!clips.every(item => !object(item) || item === saved || item.trackId !== saved.trackId ||
          (item.startFrame as number) + (item.durationFrames as number) <= (row.startFrame as number) ||
          appended.some(other => object(other) && other.clipId === item.id))) return false;
        shots.add(row.shotId as string); track = saved.trackId; nextFrame = (row.startFrame as number) + (row.durationFrames as number);
      }
      return skipped.every(row => object(row) && exactKeys(row, ['shotId', 'reason']) && uuid(row.shotId) && !shots.has(row.shotId) &&
        (TIMELINE_SHOT_APPEND_SKIP_REASONS as readonly unknown[]).includes(row.reason) && Boolean(shots.add(row.shotId)));
    } catch {return false;}
  }
  return {isTimelineSourceRefreshResponse, isTimelineShotAppendResponse,
    isTimelineShotSyncResponse: (operation: unknown, input: unknown, value: unknown): boolean =>
      operation === TIMELINE_SOURCE_REFRESH_OPERATION ? isTimelineSourceRefreshResponse(value, input) :
        operation === TIMELINE_SHOT_APPEND_OPERATION && isTimelineShotAppendResponse(value, input)};
}
