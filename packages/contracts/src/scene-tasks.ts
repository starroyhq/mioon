import {z} from 'zod';
import {SOURCE_RANGE_FPS, sourceFrameCount} from './source-range.ts';
import {FRAME_LIMITS} from './frame-extraction.ts';

type Rec = Record<string, unknown>;
// Reference-film scene detection: a local background task over one owned
// video, the retained cut lists it produces or a user saves, and their
// receipts. Cuts are first frames of a new shot on the 30 fps editing grid.
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
export const SCENE_MUTATION_OPERATIONS = Object.freeze(['scene.detect', 'scene.task.cancel', 'scene.cuts.save'] as const);
// The request table also admits the storyboard operations of the next step,
// so adding them later needs no new schema version.
export const SCENE_STORED_OPERATIONS = Object.freeze([...SCENE_MUTATION_OPERATIONS, 'scene.shots.create', 'scene.shots.undo'] as const);
export const SCENE_LIMITS = Object.freeze({
  inputBytes: 16384, snapshotBytes: 8192, receiptBytes: 32768, outcomeBytes: 16384, taskBytes: 81920,
  responseBytes: 16384, requestBytes: 49152, cutsBytes: 65536, resultBytes: 81920,
  cuts: 1500, shotsPerTask: 100,
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
  'SCENE_SOURCE_INVALID', 'SCENE_SOURCE_CHANGED', 'SCENE_RESULT_CONFLICT', 'SCENE_RESULT_STALE', 'SCENE_CUTS_INVALID'] as const);

export const canonicalSceneInput = (value: unknown): string => JSON.stringify(value, (_key: string, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const bounded = <T extends z.ZodTypeAny>(schema: T, limit: number) => schema.refine(value => bytes(value) <= limit, 'Scene record exceeds its byte limit');
const id = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.string().min(8).max(200).refine(value => bytes(value) <= 800, 'Request ID exceeds its byte limit');
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(1).max(40).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const frameCount = z.number().int().min(1).max(SCENE_LIMITS.frameCount);
const cursor = z.string().min(1).max(SCENE_LIMITS.cursorBytes).refine(value => bytes(value) <= SCENE_LIMITS.cursorBytes, 'Cursor exceeds its byte limit');
const [shortest, longest] = SCENE_MIN_SHOT_SECONDS;
export const sceneDetectionOptionsSchema = z.object({
  mode: z.enum(SCENE_DETECTION_MODES),
  sensitivity: z.number().int().min(0).max(100).describe('0–100. Higher finds more cuts; every 20 points halve the threshold. Default 60.'),
  minShotSeconds: z.number().finite().min(shortest).max(longest).describe('Shortest shot in seconds, 0.1–10. Default 0.6.'),
}).strict();
const cutFrames = z.array(z.number().int().min(1).max(SCENE_LIMITS.frameCount - 1)).max(SCENE_LIMITS.cuts)
  .refine(values => values.every((value, index) => index === 0 || value > values[index - 1]), 'Cuts must be strictly increasing');
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
});
export const sceneDescriptions = Object.freeze({
  'scene.detect': '为本项目一段视频素材排队本地镜头拆解：先持久化任务再解码，按30fps网格找出切点并保存为该素材的最新结果；可设模式、灵敏度和最短镜头；不修改素材、不生成或付费；使用必填稳定requestId精确重放',
  'scene.request.get': '只读查询镜头拆解相关操作的不可变受理回执；不触发执行，当前状态另查task.get',
  'scene.task.get': '只读查询本项目已有镜头拆解任务、运行进度和结果摘要；不读取媒体或恢复任务',
  'scene.task.list': '按项目分页只读列出镜头拆解任务，可按素材筛选，默认20条、最多50条；重启和查询不会自动解码',
  'scene.task.cancel': '按任务版本和稳定请求键取消排队或运行中的镜头拆解；运行中的任务先进入取消中，解码进程关闭后变为已取消，不保存结果',
  'scene.result.get': '只读读取一段视频素材最新的切点结果（检测所得或手动保存）；素材哈希或打分规则不一致时标为失效',
  'scene.cuts.save': '把手动增删或移动后的完整切点列表保存为该素材的新结果；必须基于当前最新且有效的结果，其后又有新结果时冲突；不修改素材或时间线；使用必填稳定requestId精确重放',
});

export const sceneSnapshotSchema = bounded(z.object({
  schemaVersion: z.literal(1), projectId: id, taskId: id, kind: z.literal('detect'),
  source: z.object({assetId: id, sha256: hash, mimeType: z.enum(['video/mp4', 'video/webm']), sizeBytes: z.number().int().min(1).max(SCENE_LIMITS.sourceBytes),
    relativePath: z.string().min(1).max(1024), duration: z.number().finite().positive().max(SCENE_LIMITS.sourceDuration)}).strict(),
  options: sceneDetectionOptionsSchema, profileId: z.literal(SCENE_DETECTION_PROFILE_ID), fps: z.literal(SOURCE_RANGE_FPS),
}).strict().refine(value => sourceFrameCount(value.source.duration) !== null, 'Source has no complete frame'), SCENE_LIMITS.snapshotBytes);
const progress = z.object({frames: z.number().int().min(0).max(SCENE_LIMITS.frameCount + 30), frameCount, cuts: z.number().int().min(0).max(SCENE_LIMITS.cuts)}).strict();
export const sceneTaskResponseSchema = bounded(z.object({
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
  .refine(value => value.cuts.every((cut, index) => cut.frame < value.frameCount && (index === 0 || cut.frame > value.cuts[index - 1].frame)), 'Cuts must be strictly increasing inside the source')
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
export interface SceneTaskProgress {frames: number; frameCount: number; cuts: number}
export interface SceneTaskResponse {
  id: string; projectId: string; kind: 'detect'; requestId: string; sourceAssetId: string; sourceHash: string;
  options: SceneDetectionOptionsInput; profileId: typeof SCENE_DETECTION_PROFILE_ID; fps: typeof SOURCE_RANGE_FPS;
  state: typeof SCENE_TASK_STATES[number]; revision: number; started: boolean;
  result: {id: string; frameCount: number; cutCount: number} | null; progress: SceneTaskProgress | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}
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

const schemaFor = (operation: string): z.ZodTypeAny | null => Object.hasOwn(sceneSchemas, operation) ? (sceneSchemas as Readonly<Record<string, z.ZodTypeAny>>)[operation] : null;
/** An acknowledgement is the task at acceptance (detect), after its transition
 * (cancel), or the new result summary (cuts.save). Progress is never stored. */
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
  if (operation === 'scene.detect') return result.requestId === request.requestId && result.sourceAssetId === request.sourceAssetId && result.sourceHash === request.sourceHash &&
    result.state === 'queued' && result.revision === 1 && !result.started && result.result === null &&
    JSON.stringify(normalizeSceneDetectionOptions(request.options as Partial<SceneDetectionOptionsInput> | undefined)) === JSON.stringify({mode: result.options.mode, sensitivity: result.options.sensitivity, minShotSeconds: result.options.minShotSeconds});
  return result.id === request.taskId && result.revision === (request.expectedRevision as number) + 1 &&
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
    (parsed.data.operation !== 'scene.detect' || response.requestId === parsed.data.requestId);
}
export function isSceneListResponse(operation: unknown, input: unknown, result: unknown): boolean {
  const request = input as Rec, response = result as Rec | null | undefined;
  if (operation !== 'scene.task.list' || !sceneSchemas['scene.task.list'].safeParse(input).success || !response || typeof response !== 'object' || Array.isArray(response) ||
    Object.keys(response).sort().join(',') !== 'items,nextCursor,projectId' || response.projectId !== request.projectId || !Array.isArray(response.items) ||
    response.items.length > ((request.limit as number | undefined) ?? SCENE_LIMITS.pageSize) || (response.nextCursor !== null && !cursor.safeParse(response.nextCursor).success)) return false;
  const items = response.items as Rec[];
  return new Set(items.map(value => value?.id)).size === items.length && items.every(value => isSceneTaskResponse(value) && value.projectId === request.projectId &&
    (request.sourceAssetId === undefined || value.sourceAssetId === request.sourceAssetId));
}
