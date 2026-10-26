import {z} from 'zod';
import {SOURCE_RANGE_FPS, sourceFrameCount} from './source-range.ts';
import {FRAME_LIMITS, FRAME_PROFILE_ID, FRAME_SELECTION_RULE, frameProbeSchema} from './frame-extraction.ts';

type Rec = Record<string, unknown>;
// Reference-film scene detection: a local background task over one owned
// video, the retained cut lists it produces or a user saves, and their
// receipts. Cuts are first frames of a new shot on the 30 fps editing grid.
// A storyboard task turns chosen segments of a result into canvas shots, each
// with its mid-segment keyframe as the first-frame reference.
export const SCENE_DETECTION_PROFILE_ID = 'scene-cuts-v1';
export const SCENE_DETECTION_MODES = Object.freeze(['adaptive', 'fixed'] as const);
export const SCENE_DETECTION_DEFAULTS = Object.freeze({mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6} as const);
export const SCENE_MIN_SHOT_SECONDS = Object.freeze([0.1, 10] as const);
export const SCENE_TASK_KINDS = Object.freeze(['detect', 'shots'] as const);
// cancelling: a running task was asked to stop and its decoder is closing.
// persisting, local_result_error and undone belong to storyboard tasks.
export const SCENE_TASK_STATES = Object.freeze(['queued', 'running', 'cancelling', 'persisting', 'succeeded', 'cancelled_before_start',
  'cancelled', 'interrupted', 'local_result_error', 'failed', 'undone'] as const);
export const SCENE_RESULT_ORIGINS = Object.freeze(['detected', 'manual'] as const);
export const SCENE_MUTATION_OPERATIONS = Object.freeze(['scene.detect', 'scene.task.cancel', 'scene.cuts.save', 'scene.shots.create', 'scene.shots.undo'] as const);
// Every operation the request table admits now has a handler.
export const SCENE_STORED_OPERATIONS = SCENE_MUTATION_OPERATIONS;
// Keyframe images a storyboard task saves; their owner is that task's receipt.
export const SCENE_KEYFRAME_PROVENANCE = 'scene-keyframe';
export const SCENE_SHOT_TITLE_PREFIX = '参考';
// New shots follow the project's format, never the reference film's.
export const SCENE_SHOT_ASPECT_RATIOS = Object.freeze(['9:16', '16:9', '1:1'] as const);
// Rows of six at the canvas pitch of a shot card. Without a position the batch
// starts below the existing canvas content.
export const SCENE_SHOT_LAYOUT = Object.freeze({columns: 6, columnSpacing: 340, rowSpacing: 300, left: 80, top: 100, gap: 360});
export const SCENE_UNDO_BLOCKERS = Object.freeze(['MISSING', 'EDITED', 'GENERATED', 'CONNECTED', 'SUBJECT_BOUND'] as const);
// Undo compares these fields with the created shot. Moving or reordering a
// shot is layout, not an edit, so it never blocks undo.
export const SCENE_SHOT_CONTENT_FIELDS = Object.freeze(['title', 'prompt', 'referenceAssetIds', 'lastFrameAssetId', 'aspectRatio', 'duration', 'parameters', 'selectedVersionId'] as const);
export const SCENE_LIMITS = Object.freeze({
  inputBytes: 16384, snapshotBytes: 8192, receiptBytes: 32768, outcomeBytes: 16384, taskBytes: 81920,
  responseBytes: 16384, requestBytes: 49152, cutsBytes: 65536, resultBytes: 81920,
  // Live storyboard reads may add undo blockers; receipts stay within responseBytes.
  shotsResponseBytes: 32768,
  cuts: 1500, shotsPerTask: 100, titlePrefix: 40,
  pageSize: 20, maxPageSize: 50, cursorBytes: 768,
  activeGlobal: 1, queuedPerProject: 2, queuedGlobal: 8,
  tasksPerProject: 256, tasksGlobal: 2048, requestsPerTask: 16, requestsPerProject: 4096, requestsGlobal: 32768,
  resultsPerAsset: 64, resultsPerProject: 1024, resultsGlobal: 8192,
  // Frame capture's source limits, so every segment's keyframe can be captured.
  sourceBytes: FRAME_LIMITS.sourceBytes, sourceDuration: FRAME_LIMITS.sourceDuration,
  frameCount: FRAME_LIMITS.sourceDuration * SOURCE_RANGE_FPS,
});
export const SCENE_STALE_REASONS = Object.freeze(['SOURCE_CHANGED', 'PROFILE_CHANGED'] as const);
// Pre-write refusals whose rollback a fresh transaction can prove.
export const SCENE_REFUSAL_CODES = Object.freeze(['SCENE_CAPACITY', 'SCENE_QUEUE_FULL', 'SCENE_TASK_ACTIVE', 'SCENE_REVISION_CONFLICT', 'SCENE_STATE_CONFLICT',
  'SCENE_SOURCE_INVALID', 'SCENE_SOURCE_CHANGED', 'SCENE_RESULT_CONFLICT', 'SCENE_RESULT_STALE', 'SCENE_CUTS_INVALID', 'SCENE_SEGMENTS_INVALID', 'SCENE_UNDO_BLOCKED'] as const);

export const canonicalSceneInput = (value: unknown): string => JSON.stringify(value, (_key: string, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const bounded = <T extends z.ZodTypeAny>(schema: T, limit: number) => schema.refine(value => bytes(value) <= limit, 'Scene record exceeds its byte limit');
const increasing = (values: readonly number[]): boolean => values.every((value, index) => index === 0 || value > values[index - 1]!);
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.string().min(8).max(200).refine(value => bytes(value) <= 800, 'Request ID exceeds its byte limit');
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(1).max(40).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const frameCount = z.number().int().min(1).max(SCENE_LIMITS.frameCount);
const editFrame = z.number().int().min(0).max(SCENE_LIMITS.frameCount);
const segmentNumber = z.number().int().min(1).max(SCENE_LIMITS.cuts + 1);
const position = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
const titlePrefix = z.string().min(1).max(SCENE_LIMITS.titlePrefix);
const cursor = z.string().min(1).max(SCENE_LIMITS.cursorBytes).refine(value => bytes(value) <= SCENE_LIMITS.cursorBytes, 'Cursor exceeds its byte limit');
const [shortest, longest] = SCENE_MIN_SHOT_SECONDS;
export const sceneDetectionOptionsSchema = z.object({
  mode: z.enum(SCENE_DETECTION_MODES),
  sensitivity: z.number().int().min(0).max(100).describe('0–100. Higher finds more cuts; every 20 points halve the threshold. Default 60.'),
  minShotSeconds: z.number().finite().min(shortest).max(longest).describe('Shortest shot in seconds, 0.1–10. Default 0.6.'),
}).strict();
const cutFrames = z.array(z.number().int().min(1).max(SCENE_LIMITS.frameCount - 1)).max(SCENE_LIMITS.cuts)
  .refine(increasing, 'Cuts must be strictly increasing');
const control = {projectId: id, taskId: id, expectedRevision: revision, requestId};
export const sceneSchemas = Object.freeze({
  'scene.detect': z.object({projectId: id, sourceAssetId: id, sourceHash: hash,
    options: sceneDetectionOptionsSchema.partial().optional().describe('Omitted fields use the defaults: adaptive, 60, 0.6 s.'), requestId}).strict(),
  'scene.request.get': z.object({projectId: id, requestId}).strict(),
  'scene.task.get': z.object({projectId: id, taskId: id}).strict(),
  'scene.task.list': z.object({projectId: id, sourceAssetId: id.optional(), limit: z.number().int().min(1).max(SCENE_LIMITS.maxPageSize).optional(), cursor: cursor.optional()}).strict(),
  'scene.task.cancel': z.object(control).strict(),
  'scene.result.get': z.object({projectId: id, assetId: id}).strict(),
  'scene.cuts.save': z.object({projectId: id, assetId: id, sourceHash: hash,
    expectedResultId: id.describe('The current result the edit starts from; a newer result conflicts.'),
    cuts: cutFrames.describe('Every cut after the edit: first frames of new shots on the 30 fps grid, strictly increasing, below the result frameCount.'),
    requestId}).strict(),
  'scene.shots.create': z.object({projectId: id, sourceAssetId: id, sourceHash: hash,
    resultId: id.describe('The newest current result of this video; a newer or stale result is refused.'),
    segments: z.array(segmentNumber).min(1).max(SCENE_LIMITS.shotsPerTask).refine(increasing, 'Segments must be strictly increasing')
      .describe('Segment numbers to build, from 1: segment n runs from cut n-1 (or the start) to cut n (or the end). Strictly increasing, at most 100.'),
    titlePrefix: titlePrefix.optional().describe('Shot titles are "<prefix> NN" by segment number. Default 参考.'),
    position: position.optional().describe('Canvas position of the first new shot; the rest follow in rows of six. Omitted places the batch below the existing canvas content.'),
    requestId}).strict(),
  'scene.shots.undo': z.object(control).strict(),
});
export const sceneDescriptions = Object.freeze({
  'scene.detect': '为本项目一段视频素材排队本地镜头拆解：先持久化任务再解码，按30fps网格找出切点并保存为该素材的最新结果；可设模式、灵敏度和最短镜头；不修改素材、不生成或付费；使用必填稳定requestId精确重放',
  'scene.request.get': '只读查询镜头拆解相关操作的不可变受理回执；不触发执行，当前状态另查task.get',
  'scene.task.get': '只读查询本项目已有镜头拆解或建分镜任务、运行进度和结果摘要；已建好的分镜同时给出能否撤销及原因；不读取媒体或恢复任务',
  'scene.task.list': '按项目分页只读列出镜头拆解和建分镜任务，可按素材筛选，默认20条、最多50条；重启和查询不会自动解码',
  'scene.task.cancel': '按任务版本和稳定请求键取消排队或运行中的镜头拆解或建分镜；运行中的任务先进入取消中，解码进程关闭后变为已取消，不保存结果、不留下镜头',
  'scene.result.get': '只读读取一段视频素材最新的切点结果（检测所得或手动保存）；素材哈希或打分规则不一致时标为失效',
  'scene.cuts.save': '把手动增删或移动后的完整切点列表保存为该素材的新结果；必须基于当前最新且有效的结果，其后又有新结果时冲突；不修改素材或时间线；使用必填稳定requestId精确重放',
  'scene.shots.create': '按该视频当前最新且有效的切点结果排队本地建分镜：一次解码截出所选段落的中间帧并存为图片素材，再一次建出带首帧参考的镜头（标题按段号，时长取段长，比例跟随项目画幅）；最多100段；取消或失败不留下镜头；不生成或付费；使用必填稳定requestId精确重放',
  'scene.shots.undo': '按任务版本撤销一次已完成的建分镜：这批镜头都未生成、未改内容、未连线、未绑定主体时删除这批镜头，关键帧图片保留在素材库；使用必填稳定requestId精确重放',
});

const relativePath = z.string().min(1).max(1024);
const sourceFields = {assetId: id, sha256: hash, mimeType: z.enum(['video/mp4', 'video/webm']), sizeBytes: z.number().int().min(1).max(SCENE_LIMITS.sourceBytes),
  relativePath, duration: z.number().finite().positive().max(SCENE_LIMITS.sourceDuration)};
export const sceneSnapshotSchema = bounded(z.object({
  schemaVersion: z.literal(1), projectId: id, taskId: id, kind: z.literal('detect'),
  source: z.object(sourceFields).strict(),
  options: sceneDetectionOptionsSchema, profileId: z.literal(SCENE_DETECTION_PROFILE_ID), fps: z.literal(SOURCE_RANGE_FPS),
}).strict().refine(value => sourceFrameCount(value.source.duration) !== null, 'Source has no complete frame'), SCENE_LIMITS.snapshotBytes);
const sourceDimension = z.number().int().min(1).max(FRAME_LIMITS.sourceMaxEdge);
// Segments are [number, startFrame, endFrame) on the editing grid, copied from
// the immutable result at acceptance. Titles, keyframe marks, durations and
// positions are derived from them by sceneShotPlan.
export const sceneShotsSnapshotSchema = bounded(z.object({
  schemaVersion: z.literal(1), projectId: id, taskId: id, kind: z.literal('shots'),
  source: z.object({...sourceFields, width: sourceDimension, height: sourceDimension}).strict(),
  resultId: id, frameCount,
  frame: z.object({profileId: z.literal(FRAME_PROFILE_ID), selectionRule: z.literal(FRAME_SELECTION_RULE), fps: z.literal(SOURCE_RANGE_FPS)}).strict(),
  aspectRatio: z.enum(SCENE_SHOT_ASPECT_RATIOS), titlePrefix, origin: position,
  segments: z.array(z.tuple([segmentNumber, editFrame, editFrame])).min(1).max(SCENE_LIMITS.shotsPerTask),
}).strict()
  .refine(value => increasing(value.segments.map(([segment]) => segment)), 'Segments must be strictly increasing')
  .refine(value => value.segments.every(([, start, end], index, all) => start < end && end <= value.frameCount && (index === 0 || start >= all[index - 1]![2])),
    'Segments must lie in order inside the source')
  .refine(value => value.source.width * value.source.height <= FRAME_LIMITS.sourceMaxPixels, 'Source geometry exceeds the frame profile')
  .refine(value => sourceFrameCount(value.source.duration) !== null, 'Source has no complete frame'), SCENE_LIMITS.snapshotBytes);
const keyframeSchema = z.object({segment: segmentNumber, sourceFrame: editFrame, assetId: id, sha256: hash,
  width: z.number().int().min(1).max(FRAME_LIMITS.resultMaxEdge), height: z.number().int().min(1).max(FRAME_LIMITS.resultMaxEdge),
  byteLength: z.number().int().min(1).max(FRAME_LIMITS.resultBytes)}).strict();
/** The staged keyframes of a storyboard task, in segment order: one PNG and one
 * new asset ID per segment, captured by frame capture's profile and rule. */
export const sceneShotsReceiptSchema = bounded(z.object({
  schemaVersion: z.literal(1), projectId: id, taskId: id, inputHash: hash, sourceAssetId: id, sourceHash: hash,
  profileId: z.literal(FRAME_PROFILE_ID), selectionRule: z.literal(FRAME_SELECTION_RULE), fps: z.literal(SOURCE_RANGE_FPS), probe: frameProbeSchema,
  keyframes: z.array(keyframeSchema).min(1).max(SCENE_LIMITS.shotsPerTask),
}).strict()
  .refine(value => increasing(value.keyframes.map(keyframe => keyframe.segment)), 'Keyframes follow the segments')
  .refine(value => new Set(value.keyframes.map(keyframe => keyframe.assetId)).size === value.keyframes.length, 'Keyframes have distinct assets'), SCENE_LIMITS.receiptBytes);
/** The shots a storyboard task created, in segment order. */
export const sceneShotsOutcomeSchema = bounded(z.object({schemaVersion: z.literal(1), shotIds: z.array(id).min(1).max(SCENE_LIMITS.shotsPerTask), createdAt: timestamp}).strict()
  .refine(value => new Set(value.shotIds).size === value.shotIds.length, 'Shots are distinct'), SCENE_LIMITS.outcomeBytes);
const progress = z.object({frames: z.number().int().min(0).max(SCENE_LIMITS.frameCount + 30), frameCount, cuts: z.number().int().min(0).max(SCENE_LIMITS.cuts)}).strict();
export const sceneDetectTaskResponseSchema = bounded(z.object({
  id, projectId: id, kind: z.literal('detect'), requestId, sourceAssetId: id, sourceHash: hash,
  options: sceneDetectionOptionsSchema, profileId: z.literal(SCENE_DETECTION_PROFILE_ID), fps: z.literal(SOURCE_RANGE_FPS),
  state: z.enum(SCENE_TASK_STATES), revision, started: z.boolean(),
  result: z.object({id, frameCount, cutCount: z.number().int().min(0).max(SCENE_LIMITS.cuts)}).strict().nullable(),
  progress: progress.nullable(), errorCode: errorCode.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict()
  .refine(value => (value.state === 'succeeded') === (value.result !== null), 'Only a succeeded task has a result')
  .refine(value => !['persisting', 'local_result_error', 'undone'].includes(value.state), 'Detection tasks have no storyboard states')
  .refine(value => !['queued', 'cancelled_before_start'].includes(value.state) || !value.started, 'An unstarted task cannot have crossed its start fence')
  .refine(value => !['running', 'cancelling', 'succeeded', 'cancelled'].includes(value.state) || value.started, 'Active and finished tasks require the start fence')
  .refine(value => ['interrupted', 'failed'].includes(value.state) === (value.errorCode !== null), 'Only interrupted and failed tasks carry an error')
  .refine(value => value.state !== 'queued' || value.revision === 1, 'Queued tasks retain their original revision')
  .refine(value => value.progress === null || value.state === 'running', 'Only a running task reports progress'), SCENE_LIMITS.responseBytes);
const undoBlockerSchema = z.object({segment: segmentNumber, shotId: id, reason: z.enum(SCENE_UNDO_BLOCKERS),
  fields: z.array(z.enum(SCENE_SHOT_CONTENT_FIELDS)).min(1).max(SCENE_SHOT_CONTENT_FIELDS.length).optional()}).strict()
  .refine(value => (value.reason === 'EDITED') === (value.fields !== undefined), 'Only an edited shot names its changed fields');
export const sceneShotsTaskResponseSchema = bounded(z.object({
  id, projectId: id, kind: z.literal('shots'), requestId, sourceAssetId: id, sourceHash: hash, resultId: id,
  segments: z.array(segmentNumber).min(1).max(SCENE_LIMITS.shotsPerTask), titlePrefix, aspectRatio: z.enum(SCENE_SHOT_ASPECT_RATIOS),
  state: z.enum(SCENE_TASK_STATES), revision, started: z.boolean(),
  shots: z.array(z.object({segment: segmentNumber, shotId: id, assetId: id}).strict()).nullable(),
  progress: z.object({done: z.number().int().min(0).max(SCENE_LIMITS.shotsPerTask), total: z.number().int().min(1).max(SCENE_LIMITS.shotsPerTask)}).strict().nullable(),
  undo: z.object({available: z.boolean(), blockers: z.array(undoBlockerSchema).max(SCENE_LIMITS.shotsPerTask)}).strict().nullable(),
  errorCode: errorCode.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict()
  .refine(value => increasing(value.segments), 'Segments must be strictly increasing')
  .refine(value => ['succeeded', 'undone'].includes(value.state) === (value.shots !== null), 'Only a built storyboard lists its shots')
  .refine(value => value.shots === null || value.shots.length === value.segments.length && value.shots.every((shot, index) => shot.segment === value.segments[index]), 'Shots follow the segments')
  .refine(value => !['queued', 'cancelled_before_start'].includes(value.state) || !value.started, 'An unstarted task cannot have crossed its start fence')
  .refine(value => !['running', 'cancelling', 'persisting', 'succeeded', 'cancelled', 'local_result_error', 'undone'].includes(value.state) || value.started, 'Active and finished tasks require the start fence')
  .refine(value => ['interrupted', 'failed', 'local_result_error'].includes(value.state) === (value.errorCode !== null), 'Only interrupted and failed tasks carry an error')
  .refine(value => value.state !== 'queued' || value.revision === 1, 'Queued tasks retain their original revision')
  .refine(value => value.progress === null || value.state === 'running' && value.progress.total === value.segments.length && value.progress.done <= value.progress.total, 'Only a running task reports progress')
  .refine(value => value.undo === null || value.state === 'succeeded' && value.undo.available === (value.undo.blockers.length === 0), 'Only a built storyboard reports undo'), SCENE_LIMITS.shotsResponseBytes);
export const sceneTaskResponseSchema = z.union([sceneDetectTaskResponseSchema, sceneShotsTaskResponseSchema]);
const resultFields = {
  id, projectId: id, assetId: id, sourceHash: hash, origin: z.enum(SCENE_RESULT_ORIGINS), taskId: id.nullable(), basedOnResultId: id.nullable(),
  requestId: requestId.nullable(), profileId: z.string().regex(/^[a-z0-9-]{1,40}$/), fps: z.literal(SOURCE_RANGE_FPS), frameCount, createdAt: timestamp,
};
const origin = <T extends {origin: string; taskId: string | null; basedOnResultId: string | null; requestId: string | null}>(value: T): boolean =>
  value.origin === 'detected' ? value.taskId !== null && value.basedOnResultId === null && value.requestId === null
    : value.taskId === null && value.basedOnResultId !== null && value.requestId !== null;
export const sceneResultSummarySchema = z.object({...resultFields, cutCount: z.number().int().min(0).max(SCENE_LIMITS.cuts)}).strict()
  .refine(origin, 'Result origin must match its task or base result');
export const sceneCutSchema = z.object({frame: z.number().int().min(1).max(SCENE_LIMITS.frameCount - 1), score: z.number().min(0).max(1).nullable()}).strict();
export const sceneResultSchema = bounded(z.object({...resultFields, options: sceneDetectionOptionsSchema.nullable(), cuts: z.array(sceneCutSchema).max(SCENE_LIMITS.cuts)}).strict()
  .refine(origin, 'Result origin must match its task or base result')
  .refine(value => (value.origin === 'detected') === (value.options !== null), 'Only detected results keep their options')
  .refine(value => value.cuts.every((cut, index) => cut.frame < value.frameCount && (index === 0 || cut.frame > value.cuts[index - 1]!.frame)), 'Cuts must be strictly increasing inside the source')
  .refine(value => value.origin === 'manual' || value.cuts.every(cut => cut.score !== null), 'Detected cuts carry their scores'), SCENE_LIMITS.resultBytes);
export const sceneResultResponseSchema = z.object({projectId: id, assetId: id, result: sceneResultSchema.nullable(), current: z.boolean(), staleReason: z.enum(SCENE_STALE_REASONS).nullable()}).strict()
  .refine(value => value.result === null ? !value.current && value.staleReason === null : value.current === (value.staleReason === null), 'Validity must match the stale reason')
  .refine(value => value.result === null || value.result.projectId === value.projectId && value.result.assetId === value.assetId, 'Result identity mismatch');

export interface SceneDetectionOptionsInput {mode: typeof SCENE_DETECTION_MODES[number]; sensitivity: number; minShotSeconds: number}
export interface SceneTaskSnapshot {
  schemaVersion: 1; projectId: string; taskId: string; kind: 'detect';
  source: {assetId: string; sha256: string; mimeType: 'video/mp4' | 'video/webm'; sizeBytes: number; relativePath: string; duration: number};
  options: SceneDetectionOptionsInput; profileId: typeof SCENE_DETECTION_PROFILE_ID; fps: typeof SOURCE_RANGE_FPS;
}
export type SceneShotAspectRatio = typeof SCENE_SHOT_ASPECT_RATIOS[number];
export interface SceneShotsSnapshot {
  schemaVersion: 1; projectId: string; taskId: string; kind: 'shots';
  source: SceneTaskSnapshot['source'] & {width: number; height: number};
  resultId: string; frameCount: number;
  frame: {profileId: typeof FRAME_PROFILE_ID; selectionRule: typeof FRAME_SELECTION_RULE; fps: typeof SOURCE_RANGE_FPS};
  aspectRatio: SceneShotAspectRatio; titlePrefix: string; origin: {x: number; y: number};
  segments: [number, number, number][];
}
export interface SceneKeyframe {segment: number; sourceFrame: number; assetId: string; sha256: string; width: number; height: number; byteLength: number}
export interface SceneShotsReceipt {
  schemaVersion: 1; projectId: string; taskId: string; inputHash: string; sourceAssetId: string; sourceHash: string;
  profileId: typeof FRAME_PROFILE_ID; selectionRule: typeof FRAME_SELECTION_RULE; fps: typeof SOURCE_RANGE_FPS;
  probe: z.infer<typeof frameProbeSchema>; keyframes: SceneKeyframe[];
}
export interface SceneShotsOutcome {schemaVersion: 1; shotIds: string[]; createdAt: string}
export interface SceneTaskProgress {frames: number; frameCount: number; cuts: number}
export interface SceneDetectTaskResponse {
  id: string; projectId: string; kind: 'detect'; requestId: string; sourceAssetId: string; sourceHash: string;
  options: SceneDetectionOptionsInput; profileId: typeof SCENE_DETECTION_PROFILE_ID; fps: typeof SOURCE_RANGE_FPS;
  state: typeof SCENE_TASK_STATES[number]; revision: number; started: boolean;
  result: {id: string; frameCount: number; cutCount: number} | null; progress: SceneTaskProgress | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}
export interface SceneUndoBlocker {segment: number; shotId: string; reason: typeof SCENE_UNDO_BLOCKERS[number]; fields?: (typeof SCENE_SHOT_CONTENT_FIELDS[number])[]}
export interface SceneShotsTaskResponse {
  id: string; projectId: string; kind: 'shots'; requestId: string; sourceAssetId: string; sourceHash: string; resultId: string;
  segments: number[]; titlePrefix: string; aspectRatio: SceneShotAspectRatio;
  state: typeof SCENE_TASK_STATES[number]; revision: number; started: boolean;
  shots: {segment: number; shotId: string; assetId: string}[] | null;
  progress: {done: number; total: number} | null;
  undo: {available: boolean; blockers: SceneUndoBlocker[]} | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}
export type SceneTaskResponse = SceneDetectTaskResponse | SceneShotsTaskResponse;
export interface SceneCut {frame: number; score: number | null}
export interface SceneResultSummary {
  id: string; projectId: string; assetId: string; sourceHash: string; origin: typeof SCENE_RESULT_ORIGINS[number];
  taskId: string | null; basedOnResultId: string | null; requestId: string | null; profileId: string; fps: typeof SOURCE_RANGE_FPS;
  frameCount: number; createdAt: string; cutCount: number;
}
export interface SceneResult extends Omit<SceneResultSummary, 'cutCount'> {options: SceneDetectionOptionsInput | null; cuts: SceneCut[]}
export interface SceneResultResponse {projectId: string; assetId: string; result: SceneResult | null; current: boolean; staleReason: typeof SCENE_STALE_REASONS[number] | null}
export const isSceneTaskResponse = (value: unknown): value is SceneTaskResponse => sceneTaskResponseSchema.safeParse(value).success;
export const isSceneResultSummary = (value: unknown): value is SceneResultSummary => sceneResultSummarySchema.safeParse(value).success;
export const isSceneResultResponse = (value: unknown): value is SceneResultResponse => sceneResultResponseSchema.safeParse(value).success;
/** Fills omitted detection options with the defaults; unknown keys are refused by the input schema. */
export function normalizeSceneDetectionOptions(value: Partial<SceneDetectionOptionsInput> | undefined): SceneDetectionOptionsInput {
  return {...SCENE_DETECTION_DEFAULTS, ...(value ?? {})};
}
/** Segment n (from 1) runs from cut n-1, or the start, to cut n, or the end. */
export function sceneSegmentBounds(cuts: readonly number[], frameCount: number, segment: number): [number, number] | null {
  if (!Number.isSafeInteger(segment) || segment < 1 || segment > cuts.length + 1) return null;
  const start = segment === 1 ? 0 : cuts[segment - 2]!, end = segment === cuts.length + 1 ? frameCount : cuts[segment - 1]!;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= frameCount ? [start, end] : null;
}
export const sceneShotTitle = (prefix: string, segment: number): string => `${prefix} ${String(segment).padStart(2, '0')}`;
export interface SceneShotPlanEntry {segment: number; startFrame: number; endFrame: number; sourceFrame: number; title: string; duration: number; position: {x: number; y: number}}
/** The keyframe mark is the segment's middle frame; the duration its length in
 * whole seconds within a shot's 1–20; positions fill rows of six. */
export function sceneShotPlan(snapshot: Pick<SceneShotsSnapshot, 'segments' | 'titlePrefix' | 'origin'>): SceneShotPlanEntry[] {
  const {columns, columnSpacing, rowSpacing} = SCENE_SHOT_LAYOUT;
  return snapshot.segments.map(([segment, startFrame, endFrame], index) => ({segment, startFrame, endFrame,
    sourceFrame: startFrame + Math.floor((endFrame - startFrame) / 2), title: sceneShotTitle(snapshot.titlePrefix, segment),
    duration: Math.min(20, Math.max(1, Math.round((endFrame - startFrame) / SOURCE_RANGE_FPS))),
    position: {x: snapshot.origin.x + (index % columns) * columnSpacing, y: snapshot.origin.y + Math.floor(index / columns) * rowSpacing}}));
}

const schemaFor = (operation: string): z.ZodTypeAny | null => Object.hasOwn(sceneSchemas, operation) ? (sceneSchemas as Readonly<Record<string, z.ZodTypeAny>>)[operation]! : null;
/** An acknowledgement is the task at acceptance (detect, shots.create), after
 * its transition (cancel, shots.undo), or the new result summary (cuts.save).
 * Progress and undo availability are live and never stored. */
export function isSceneMutationResponse(operation: unknown, input: unknown, result: unknown): boolean {
  const schema = typeof operation === 'string' ? schemaFor(operation) : null;
  if (!schema || !(SCENE_MUTATION_OPERATIONS as readonly unknown[]).includes(operation) || !schema.safeParse(input).success) return false;
  const request = input as Rec;
  if (operation === 'scene.cuts.save') {
    if (!isSceneResultSummary(result)) return false;
    const value = result;
    return value.projectId === request.projectId && value.assetId === request.assetId && value.sourceHash === request.sourceHash &&
      value.origin === 'manual' && value.basedOnResultId === request.expectedResultId && value.requestId === request.requestId &&
      value.cutCount === (request.cuts as unknown[]).length;
  }
  if (!isSceneTaskResponse(result) || result.projectId !== request.projectId || result.progress !== null) return false;
  if (operation === 'scene.detect') return result.kind === 'detect' && result.requestId === request.requestId && result.sourceAssetId === request.sourceAssetId &&
    result.sourceHash === request.sourceHash && result.state === 'queued' && result.revision === 1 && !result.started && result.result === null &&
    JSON.stringify(normalizeSceneDetectionOptions(request.options as Partial<SceneDetectionOptionsInput> | undefined)) === JSON.stringify({mode: result.options.mode, sensitivity: result.options.sensitivity, minShotSeconds: result.options.minShotSeconds});
  if (operation === 'scene.shots.create') return result.kind === 'shots' && result.requestId === request.requestId && result.sourceAssetId === request.sourceAssetId &&
    result.sourceHash === request.sourceHash && result.resultId === request.resultId && JSON.stringify(result.segments) === JSON.stringify(request.segments) &&
    result.titlePrefix === (request.titlePrefix ?? SCENE_SHOT_TITLE_PREFIX) && result.state === 'queued' && result.revision === 1 && !result.started &&
    result.shots === null && result.undo === null;
  if (result.id !== request.taskId || result.revision !== (request.expectedRevision as number) + 1) return false;
  if (operation === 'scene.shots.undo') return result.kind === 'shots' && result.state === 'undone' && result.started && result.shots !== null && result.undo === null;
  return (result.kind !== 'shots' || result.undo === null) &&
    (result.state === 'cancelled_before_start' && !result.started || result.state === 'cancelling' && result.started);
}
export const sceneRequestResponseSchema = z.object({projectId: id, requestId, operation: z.enum(SCENE_MUTATION_OPERATIONS), response: z.unknown()}).strict()
  .refine(value => value.operation === 'scene.cuts.save' ? sceneResultSummarySchema.safeParse(value.response).success : isSceneTaskResponse(value.response),
    'Receipt must hold the original acknowledgement').nullable();
export function isSceneRequestResponse(value: unknown): boolean {
  if (value === null) return true;
  const parsed = sceneRequestResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data === null) return false;
  const response = parsed.data.response as Rec;
  return response.projectId === parsed.data.projectId && (parsed.data.operation !== 'scene.cuts.save' || response.requestId === parsed.data.requestId) &&
    (!['scene.detect', 'scene.shots.create'].includes(parsed.data.operation) || response.requestId === parsed.data.requestId) &&
    (parsed.data.operation === 'scene.cuts.save' || response.progress === null && (response.kind !== 'shots' || response.undo === null));
}
export function isSceneListResponse(operation: unknown, input: unknown, result: unknown): boolean {
  const request = input as Rec, response = result as Rec | null | undefined;
  if (operation !== 'scene.task.list' || !sceneSchemas['scene.task.list'].safeParse(input).success || !response || typeof response !== 'object' || Array.isArray(response) ||
    Object.keys(response).sort().join(',') !== 'items,nextCursor,projectId' || response.projectId !== request.projectId || !Array.isArray(response.items) ||
    response.items.length > ((request.limit as number | undefined) ?? SCENE_LIMITS.pageSize) || (response.nextCursor !== null && !cursor.safeParse(response.nextCursor).success)) return false;
  const items = response.items as Rec[];
  // Pages leave undo availability to scene.task.get.
  return new Set(items.map(value => value?.id)).size === items.length && items.every(value => isSceneTaskResponse(value) && value.projectId === request.projectId &&
    (value.kind !== 'shots' || value.undo === null) && (request.sourceAssetId === undefined || value.sourceAssetId === request.sourceAssetId));
}
