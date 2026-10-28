type Rec = Record<string, unknown>;
import {TIMELINE_SUBTITLE_OPERATIONS} from './timeline-subtitles.ts';
import {TIMELINE_SHOT_SYNC_OPERATIONS} from './timeline-shot-sync.ts';
import {TIMELINE_SCENE_SPLIT_OPERATION} from './timeline-scene-split.ts';
import {TIMELINE_CROSSFADE_OPERATION} from './timeline-crossfade.ts';
import {TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse} from './timeline-acknowledgement.ts';
import {REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse} from './reference-acknowledgement.ts';
import {SUBJECT_MUTATION_OPERATIONS, isSubjectMutationResponse} from './subjects.ts';
import {workspaceRestoreTaskContextSchema,workspaceRestoreTaskListContextSchema} from './workspace-restore.ts';
import {type z} from 'zod';
import {schemas} from './index.ts';

// Local UI coordination only. These are not RPC/model-tool operations.
// The edit_tasks table checks this exact list, so shot-sync bridges and the
// scene split and the crossfade stay out.
export const DURABLE_EDIT_OPERATIONS = Object.freeze([
  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render' && operation !== 'timeline.format.set' && operation !== 'timeline.loudness.apply' && !TIMELINE_SUBTITLE_OPERATIONS.includes(operation) && !(TIMELINE_SHOT_SYNC_OPERATIONS as readonly string[]).includes(operation) && operation !== TIMELINE_SCENE_SPLIT_OPERATION && operation !== TIMELINE_CROSSFADE_OPERATION),
  ...REFERENCE_MUTATION_OPERATIONS,
  ...SUBJECT_MUTATION_OPERATIONS,
  'timeline.format.set',
  ...TIMELINE_SUBTITLE_OPERATIONS,
  'timeline.loudness.apply',
]);
export const EDIT_TASK_LIMITS = Object.freeze({inputBytes: 8192, rowBytes: 16384,
  rows: 4096, bytes: 64 * 1024 * 1024, pageSize: 20, maxPageSize: 50});
export const EDIT_TASK_STATUSES = Object.freeze(['prepared', 'dispatching', 'unknown', 'applied', 'not_applied'] as const);
export type EditTaskStatus = (typeof EDIT_TASK_STATUSES)[number];
export interface EditTask {
  id: string; projectId: string; operation: string; input: Rec; requestId: string; digest: string;
  lane: string; status: EditTaskStatus; revision: number; createdAt: string; updatedAt: string;
  acknowledged: boolean; origin: 'new' | 'legacy_session'; errorCode?: string;
}
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Rec => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const encoder = new TextEncoder();
const laneByOperation = Object.freeze(Object.fromEntries([
  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render').map(operation => [operation, 'timeline:mutation']),
  ...REFERENCE_MUTATION_OPERATIONS.map(operation => [operation, 'reference:mutation']),
  ...SUBJECT_MUTATION_OPERATIONS.map(operation => [operation, 'subject:mutation']),
]));
export const editTaskLane = (operation: unknown): string | null => Object.hasOwn(laneByOperation, operation as PropertyKey) ? (laneByOperation as Record<string, string>)[operation as string] : null;
const responseValidators: Readonly<Record<string, (operation: unknown, input: unknown, result: unknown) => boolean>> = Object.freeze({
  'timeline:mutation': isTimelineMutationResponse,
  'reference:mutation': (operation: unknown, input: unknown, result: unknown): boolean => typeof operation === 'string' && isReferenceMutationResponse(operation, input, result),
  'subject:mutation': isSubjectMutationResponse,
});
export function isEditTask(value: unknown): value is EditTask {
  try {
    if (!exact(value, ['id', 'projectId', 'operation', 'input', 'requestId', 'digest', 'lane', 'status', 'revision', 'createdAt', 'updatedAt', 'acknowledged', 'origin'], ['errorCode'])) return false;
    const task = value as Rec;
    if (!uuid(task.id) || !uuid(task.projectId) || typeof task.operation !== 'string' || !(DURABLE_EDIT_OPERATIONS as readonly string[]).includes(task.operation)) return false;
    const input = task.input as Rec | null | undefined;
    if (!object(task.input) || !(schemas as Record<string, z.ZodTypeAny>)[task.operation].safeParse(task.input).success || input!.projectId !== task.projectId) return false;
    if (task.requestId !== input!.requestId || typeof task.requestId !== 'string' || task.requestId.length < 8 || task.requestId.length > 200) return false;
    if (encoder.encode(JSON.stringify(task.input)).byteLength > EDIT_TASK_LIMITS.inputBytes || encoder.encode(JSON.stringify(value)).byteLength > EDIT_TASK_LIMITS.rowBytes) return false;
    if (!digest(task.digest) || task.lane !== editTaskLane(task.operation)) return false;
    if (typeof task.status !== 'string' || !(EDIT_TASK_STATUSES as readonly string[]).includes(task.status)) return false;
    if (!Number.isSafeInteger(task.revision) || (task.revision as number) <= 0 || !timestamp(task.createdAt) || !timestamp(task.updatedAt) || typeof task.acknowledged !== 'boolean') return false;
    if ((task.acknowledged && !['applied', 'not_applied'].includes(task.status)) || !['new', 'legacy_session'].includes(task.origin as string)) return false;
    return !Object.hasOwn(task, 'errorCode') || task.status === 'not_applied' && typeof task.errorCode === 'string' && /^[A-Z_]{1,80}$/.test(task.errorCode);
  } catch { return false; }
}
export function isEditTaskEnvelope(value: unknown): boolean {
  if (!exact(value, ['task', 'instanceId'], ['result','restore']) || !uuid(value.instanceId) || !isEditTask(value.task)) return false;
  const envelope = value as Rec, task = envelope.task as EditTask;
  if (Object.hasOwn(envelope,'restore') && !workspaceRestoreTaskContextSchema.safeParse(envelope.restore).success) return false;
  if (!Object.hasOwn(envelope, 'result')) return true;
  return task.status === 'applied' && Boolean(responseValidators[task.lane]?.(task.operation, task.input, envelope.result));
}
export function isEditTaskListEnvelope(value: unknown): boolean {
  if (!exact(value, ['items', 'nextCursor', 'instanceId'], ['restore']) || !uuid(value.instanceId) || !Array.isArray(value.items)) return false;
  const envelope = value as Rec;
  const items = envelope.items as unknown[];
  if (items.length > EDIT_TASK_LIMITS.maxPageSize || !items.every(isEditTask) || new Set(items.map(item => (item as unknown as Rec).id)).size !== items.length) return false;
  if (Object.hasOwn(envelope,'restore')) {
    if (!workspaceRestoreTaskListContextSchema.safeParse(envelope.restore).success) return false;
    const restore = envelope.restore as {tasks: {taskId?: unknown}[]};
    if (restore.tasks.length !== items.length || !restore.tasks.every((item,index)=>item.taskId === (items[index] as unknown as Rec).id)) return false;
  }
  return envelope.nextCursor === null || typeof envelope.nextCursor === 'string' && envelope.nextCursor.length >= 1 && envelope.nextCursor.length <= 512;
}
