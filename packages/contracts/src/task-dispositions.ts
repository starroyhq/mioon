import {z} from 'zod';

export const TASK_DISPOSITION_BATCH_LIMIT = 100;
export const TASK_DISPOSITION_KINDS = ['generation', 'render', 'edit'] as const;
export type TaskDispositionKind = (typeof TASK_DISPOSITION_KINDS)[number];
export const isTaskDispositionUnicode = (value:string):boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
const id = z.string().uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const status = z.string().min(1).max(40);
const requestId = z.string().min(8).max(200).refine(value => isTaskDispositionUnicode(value));
const target = z.object({kind:z.enum(TASK_DISPOSITION_KINDS), taskId:id}).strict();
const checkedTarget = target.extend({expectedRevision:revision, expectedStatus:status}).strict();
const batch = <T extends z.ZodTypeAny>(schema:T) => z.array(schema).min(1).max(TASK_DISPOSITION_BATCH_LIMIT)
  .refine(items => new Set(items.map(item => `${item.kind}:${item.taskId}`)).size === items.length, 'Task targets must be unique');

export const taskDispositionSchemas = {
  'task.disposition.list':z.object({projectId:id, targets:batch(target)}).strict(),
  'task.disposition.markFailed':checkedTarget.extend({projectId:id, requestId, confirm:z.literal(true)}).strict(),
  'task.disposition.archiveCompleted':z.object({projectId:id, targets:batch(checkedTarget), requestId}).strict(),
} as const;
export const taskDispositionDescriptions = {
  'task.disposition.list':'只读查询明确项目任务的本地处置标记，不调度、对账或重试任务',
  'task.disposition.markFailed':'经明确确认将未知任务标记为本地失败；保留原状态、requestId、审计与后续对账，不授权重新生成',
  'task.disposition.archiveCompleted':'原子归档隐藏明确终结且无需对账的任务；保留所有原记录、文件、幂等回执与历史',
} as const;
export type TaskDispositionTarget = z.infer<typeof target>;
export type TaskDispositionCheckedTarget = z.infer<typeof checkedTarget>;
export type TaskDispositionListInput = z.infer<typeof taskDispositionSchemas['task.disposition.list']>;
export type TaskDispositionMarkFailedInput = z.infer<typeof taskDispositionSchemas['task.disposition.markFailed']>;
export type TaskDispositionArchiveInput = z.infer<typeof taskDispositionSchemas['task.disposition.archiveCompleted']>;

export const taskDispositionSchema = z.object({
  projectId:id, kind:z.enum(TASK_DISPOSITION_KINDS), taskId:id, revision,
  markedFailed:z.boolean(), archived:z.boolean(), updatedAt:z.string().datetime().nullable(),
  sourceStatus:status, sourceRequestId:requestId.nullable(), canMarkFailed:z.boolean(), canArchive:z.boolean(),
}).strict().refine(value => value.revision !== 0 || !value.markedFailed && !value.archived && value.updatedAt === null);
export type TaskDisposition = z.infer<typeof taskDispositionSchema>;
export interface TaskDispositionListResponse {projectId:string; items:TaskDisposition[]}
export interface TaskDispositionMutationResponse extends TaskDispositionListResponse {
  operation:'task.disposition.markFailed'|'task.disposition.archiveCompleted'; requestId:string;
}
const listResponse = z.object({projectId:id, items:z.array(taskDispositionSchema).min(1).max(TASK_DISPOSITION_BATCH_LIMIT)}).strict();
const mutationResponse = listResponse.extend({operation:z.enum(['task.disposition.markFailed','task.disposition.archiveCompleted']), requestId}).strict();
export function isTaskDispositionListResponse(value:unknown, input?:TaskDispositionListInput):value is TaskDispositionListResponse {
  const result = listResponse.safeParse(value);
  if (!result.success || result.data.items.some(item => item.projectId !== result.data.projectId) || new Set(result.data.items.map(item => `${item.kind}:${item.taskId}`)).size !== result.data.items.length) return false;
  return !input || result.data.projectId === input.projectId && result.data.items.length === input.targets.length && result.data.items.every((item,index) => item.kind === input.targets[index].kind && item.taskId === input.targets[index].taskId);
}
export function isTaskDispositionMutationResponse(value:unknown):value is TaskDispositionMutationResponse {
  const result = mutationResponse.safeParse(value);
  if (!result.success || result.data.items.some(item => item.projectId !== result.data.projectId || item.revision < 1)) return false;
  return result.data.operation === 'task.disposition.markFailed' ? result.data.items.length === 1 && result.data.items[0].markedFailed : result.data.items.every(item => item.archived);
}
