import {z} from 'zod';
import {TIMELINE_RESPONSE_BYTES} from './timeline-replacement.ts';

type Rec = Record<string, unknown>;
// Splits every clip of one reference video at the cuts of its current scene
// result that fall inside the clip's source range. One keyed timeline edit
// with one history entry; the response adds per-clip outcomes.
export const TIMELINE_SCENE_SPLIT_OPERATION = 'timeline.clip.splitAtScenes';
/** NO_CUT_IN_RANGE: no cut lies strictly inside the clip's source range.
 * FADE_BOUNDS: every such cut falls inside an audio fade-in or fade-out. */
export const TIMELINE_SCENE_SPLIT_SKIP_REASONS = Object.freeze(['NO_CUT_IN_RANGE', 'FADE_BOUNDS'] as const);
// The timeline record plus at most 100 split and skipped rows.
export const TIMELINE_SCENE_SPLIT_RESPONSE_BYTES = TIMELINE_RESPONSE_BYTES + 64 * 1024;
// Pre-write rejections whose rollback the backend can prove. Their proofs bind
// operation, project and request.
export const TIMELINE_SCENE_SPLIT_PROOF_CODES = Object.freeze(['REVISION_CONFLICT', 'TIMELINE_REVISION_LIMIT', 'TIMELINE_LIMIT',
  'NOTHING_TO_SPLIT', 'SCENE_RESULT_CONFLICT', 'SCENE_RESULT_STALE'] as const);

export type TimelineSceneSplitSkipReason = typeof TIMELINE_SCENE_SPLIT_SKIP_REASONS[number];
/** clipIds: the pieces in order; the first keeps the original clip ID. cutFrames:
 * the source frames each later piece starts at. fadeCutFrames: in-range cuts
 * left out because they fall inside an audio fade. */
export interface TimelineSceneSplitRow {clipId: string; clipIds: string[]; cutFrames: number[]; fadeCutFrames: number[]}
export interface TimelineSceneSplitSkipped {clipId: string; reason: TimelineSceneSplitSkipReason; cutFrames?: number[]}
export interface TimelineSceneSplitResponse {
  operation: typeof TIMELINE_SCENE_SPLIT_OPERATION; requestId: string; timeline: Rec;
  split: TimelineSceneSplitRow[]; skipped: TimelineSceneSplitSkipped[];
}

const id = z.string().uuid();
export const timelineSceneSplitSchemas = Object.freeze({
  [TIMELINE_SCENE_SPLIT_OPERATION]: z.object({projectId: id, expectedRevision: z.number().int().positive(), requestId: z.string().min(8).max(200),
    assetId: id.describe('The reference video whose clips are split.'),
    resultId: id.describe('Its current scene result (scene.result.get); a newer or stale result conflicts.')}).strict(),
});
export const timelineSceneSplitDescriptions = Object.freeze({
  [TIMELINE_SCENE_SPLIT_OPERATION]: '按时间线版本把来自一段参考视频的所有片段，在其源区间内的每个切点处批量分割；切点取该素材当前有效的拆解结果；分割规则与单次分割相同，落在音频淡入淡出内的切点跳过并返回；没有可分割的片段时不写入；整批记一条历史，撤销一次全部回退；使用必填稳定requestId精确重放，不处理媒体',
});

const encoder = new TextEncoder();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
// At most 1500 cuts per result, on a source of at most 18000 frames.
const increasing = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 1500 &&
  value.every((item, index) => integer(item, 1, 17999) && (index === 0 || item > value[index - 1]));
const exactKeys = (value: Rec, required: readonly string[]): boolean =>
  required.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => required.includes(name));
function bounded(value: unknown): boolean {
  try {return encoder.encode(JSON.stringify(value)).length <= TIMELINE_SCENE_SPLIT_RESPONSE_BYTES;} catch {return false;}
}
/** Binds every identity field of a not-applied proof, as shot-sync does. */
export function hasTimelineSceneSplitNotAppliedProof(error: unknown, input: unknown, operation: unknown): boolean {
  try {
    const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown};
    if (operation !== TIMELINE_SCENE_SPLIT_OPERATION || !timelineSceneSplitSchemas[TIMELINE_SCENE_SPLIT_OPERATION].safeParse(input).success || !object(failure?.details)) return false;
    const details = failure.details, request = input as Rec;
    return (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
      (TIMELINE_SCENE_SPLIT_PROOF_CODES as readonly unknown[]).includes(failure.code) && details.mutationOutcome === 'not_applied' &&
      details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId;
  } catch {return false;}
}

/** Uses the single established timeline validator. Every clip of the asset in
 * the saved timeline is one listed piece or one skipped clip, and every split
 * clip's pieces are contiguous in time and source at exactly its cut frames. */
export function createTimelineSceneSplitContracts({isTimelineRecord}: Readonly<{
  isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
}>) {
  function isTimelineSceneSplitResponse(value: unknown, input: unknown): value is TimelineSceneSplitResponse {
    try {
      const parsed = timelineSceneSplitSchemas[TIMELINE_SCENE_SPLIT_OPERATION].safeParse(input);
      if (!parsed.success || !object(value) || !bounded(value) || !exactKeys(value, ['operation', 'requestId', 'timeline', 'split', 'skipped']) ||
        value.operation !== TIMELINE_SCENE_SPLIT_OPERATION || value.requestId !== parsed.data.requestId ||
        !Array.isArray(value.split) || !Array.isArray(value.skipped) || !value.split.length || value.split.length + value.skipped.length > 100 ||
        parsed.data.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value.timeline, {projectId: parsed.data.projectId}) ||
        !object(value.timeline) || value.timeline.revision !== parsed.data.expectedRevision + 1) return false;
      const clips = (value.timeline as {clips?: unknown}).clips;
      if (!Array.isArray(clips)) return false;
      const byId = new Map<string, Rec>();
      for (const clip of clips) if (object(clip) && typeof clip.id === 'string') byId.set(clip.id, clip);
      const owned = new Set([...byId.values()].filter(clip => clip.assetId === parsed.data.assetId).map(clip => clip.id as string)), seen = new Set<string>();
      const account = (clipId: unknown): boolean => uuid(clipId) && owned.has(clipId) && !seen.has(clipId) && Boolean(seen.add(clipId));
      for (const row of value.split as unknown[]) {
        if (!object(row) || !exactKeys(row, ['clipId', 'clipIds', 'cutFrames', 'fadeCutFrames']) || !increasing(row.cutFrames) || !increasing(row.fadeCutFrames) ||
          !row.cutFrames.length || row.cutFrames.some(frame => (row.fadeCutFrames as number[]).includes(frame)) || !Array.isArray(row.clipIds) ||
          row.clipIds.length !== row.cutFrames.length + 1 || row.clipIds[0] !== row.clipId || !row.clipIds.every(account)) return false;
        const pieces = row.clipIds.map(clipId => byId.get(clipId as string)!);
        for (let index = 1; index < pieces.length; index++) {
          const left = pieces[index - 1], right = pieces[index];
          if (right.trackId !== left.trackId || right.startFrame !== (left.startFrame as number) + (left.durationFrames as number) ||
            right.sourceInFrame !== row.cutFrames[index - 1] || right.sourceInFrame !== (left.sourceInFrame as number) + (left.durationFrames as number)) return false;
        }
      }
      for (const row of value.skipped as unknown[]) {
        if (!object(row) || typeof row.reason !== 'string' || !(TIMELINE_SCENE_SPLIT_SKIP_REASONS as readonly string[]).includes(row.reason) ||
          !exactKeys(row, row.reason === 'FADE_BOUNDS' ? ['clipId', 'reason', 'cutFrames'] : ['clipId', 'reason']) || !account(row.clipId) ||
          row.reason === 'FADE_BOUNDS' && (!increasing(row.cutFrames) || !row.cutFrames.length)) return false;
      }
      return seen.size === owned.size;
    } catch {return false;}
  }
  return {isTimelineSceneSplitResponse};
}
