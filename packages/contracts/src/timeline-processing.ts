import {z} from 'zod';
import type {SpeedProcessingItem, SpeedProcessingReason} from './timeline-speed.ts';

const uuid = z.string().uuid();
const project = {projectId: uuid};
const task = {...project, taskId: uuid};
const bytes = z.number().int().safe().nonnegative();
const status = z.enum(['queued', 'running', 'failed', 'ready']);
const reason = z.enum([
  'SOURCE_UNAVAILABLE', 'DISK_FULL', 'CACHE_LIMIT', 'UNSUPPORTED_FORMAT', 'PROCESSING_FAILED', 'INTERPOLATION_UNAVAILABLE',
] satisfies [SpeedProcessingReason, ...SpeedProcessingReason[]]);

export const TIMELINE_PROCESSING_WAIT_DEFAULT_MS = 30_000;
export const TIMELINE_PROCESSING_WAIT_MAX_MS = 60_000;

export const speedProcessingItemSchema = z.object({
  taskId: uuid,
  clipId: uuid,
  kind: z.enum(['reverse', 'optical']),
  status,
  progress: z.number().finite().min(0).max(100).optional(),
  reason: reason.optional(),
}).strict() satisfies z.ZodType<SpeedProcessingItem>;

export const timelineProcessingSchemas = Object.freeze({
  'timeline.processing.list': z.object(project).strict(),
  'timeline.processing.inspect': z.object(task).strict(),
  'timeline.processing.wait': z.object({
    ...task, timeoutMs: z.number().int().min(1).max(TIMELINE_PROCESSING_WAIT_MAX_MS).optional(),
  }).strict(),
  'timeline.processing.retry': z.object({...task, requestId: z.string().min(8).max(200)}).strict(),
  'timeline.processing.cancel': z.object(task).strict(),
  'timeline.processing.cache.get': z.object(project).strict(),
  'timeline.processing.cache.clear': z.object(project).strict(),
});

export type TimelineProcessingOperation = keyof typeof timelineProcessingSchemas;
export const isTimelineProcessingOperation = (operation: string): operation is TimelineProcessingOperation =>
  Object.hasOwn(timelineProcessingSchemas, operation);

export const timelineProcessingResponseSchemas = Object.freeze({
  'timeline.processing.list': z.object({items: z.array(speedProcessingItemSchema)}).strict(),
  'timeline.processing.inspect': z.object({item: speedProcessingItemSchema}).strict(),
  'timeline.processing.wait': z.object({item: speedProcessingItemSchema, timedOut: z.boolean()}).strict(),
  'timeline.processing.retry': z.object({taskId: uuid}).strict(),
  'timeline.processing.cancel': z.object({status}).strict(),
  'timeline.processing.cache.get': z.object({usedBytes: bytes, limitBytes: bytes}).strict(),
  'timeline.processing.cache.clear': z.object({freedBytes: bytes}).strict(),
} satisfies Record<TimelineProcessingOperation, z.ZodTypeAny>);

export const timelineProcessingDescriptions = Object.freeze({
  'timeline.processing.list': '查询当前项目的变速处理任务摘要。',
  'timeline.processing.inspect': '读取当前项目中指定变速任务的状态和原因。',
  'timeline.processing.wait': '等待当前项目中指定变速任务结束或到达时限。中止等待不会取消任务。',
  'timeline.processing.retry': '用新的稳定请求 ID 重试当前项目的一项变速处理任务。重复请求返回已有任务。',
  'timeline.processing.cancel': '停止当前项目中指定的变速处理任务，确认工作进程退出后清理暂存文件。',
  'timeline.processing.cache.get': '查询当前项目的变速代理占用量和额度。',
  'timeline.processing.cache.clear': '清理当前项目中未被片段或任务占用的变速代理。',
} satisfies Record<TimelineProcessingOperation, string>);
