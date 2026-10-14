import {TIMELINE_SUBTITLE_OPERATIONS} from './timeline-subtitles.mjs';
import {TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse} from './timeline-acknowledgement.mjs';
import {REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse} from './reference-acknowledgement.mjs';
import {SUBJECT_MUTATION_OPERATIONS, isSubjectMutationResponse} from './subjects.mjs';
import {workspaceRestoreTaskContextSchema,workspaceRestoreTaskListContextSchema} from './workspace-restore.mjs';
import {schemas} from './index.mjs';

// Local UI coordination only. These are not RPC/model-tool operations.
export const DURABLE_EDIT_OPERATIONS = Object.freeze([
  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render' && operation !== 'timeline.format.set' && operation !== 'timeline.loudness.apply' && !TIMELINE_SUBTITLE_OPERATIONS.includes(operation)),
  ...REFERENCE_MUTATION_OPERATIONS,
  ...SUBJECT_MUTATION_OPERATIONS,
  'timeline.format.set',
  ...TIMELINE_SUBTITLE_OPERATIONS,
  'timeline.loudness.apply',
]);
export const EDIT_TASK_LIMITS = Object.freeze({inputBytes: 8192, rowBytes: 16384,
  rows: 4096, bytes: 64 * 1024 * 1024, pageSize: 20, maxPageSize: 50});
export const EDIT_TASK_STATUSES = Object.freeze(['prepared', 'dispatching', 'unknown', 'applied', 'not_applied']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const encoder = new TextEncoder();
const laneByOperation = Object.freeze(Object.fromEntries([
  ...TIMELINE_MUTATION_OPERATIONS.filter(operation => operation !== 'timeline.render').map(operation => [operation, 'timeline:mutation']),
  ...REFERENCE_MUTATION_OPERATIONS.map(operation => [operation, 'reference:mutation']),
  ...SUBJECT_MUTATION_OPERATIONS.map(operation => [operation, 'subject:mutation']),
]));
export const editTaskLane = operation => Object.hasOwn(laneByOperation, operation) ? laneByOperation[operation] : null;
const responseValidators = Object.freeze({
  'timeline:mutation': isTimelineMutationResponse,
  'reference:mutation': isReferenceMutationResponse,
  'subject:mutation': isSubjectMutationResponse,
});
export function isEditTask(value) {
  try {
    return exact(value, ['id', 'projectId', 'operation', 'input', 'requestId', 'digest', 'lane', 'status', 'revision', 'createdAt', 'updatedAt', 'acknowledged', 'origin'], ['errorCode']) &&
      uuid(value.id) && uuid(value.projectId) && DURABLE_EDIT_OPERATIONS.includes(value.operation) &&
      object(value.input) && schemas[value.operation].safeParse(value.input).success && value.input.projectId === value.projectId &&
      value.requestId === value.input.requestId && typeof value.requestId === 'string' && value.requestId.length >= 8 && value.requestId.length <= 200 &&
      encoder.encode(JSON.stringify(value.input)).byteLength <= EDIT_TASK_LIMITS.inputBytes && digest(value.digest) && value.lane === editTaskLane(value.operation) &&
      EDIT_TASK_STATUSES.includes(value.status) && Number.isSafeInteger(value.revision) && value.revision > 0 &&
      timestamp(value.createdAt) && timestamp(value.updatedAt) && typeof value.acknowledged === 'boolean' &&
      (!value.acknowledged || ['applied', 'not_applied'].includes(value.status)) && ['new', 'legacy_session'].includes(value.origin) &&
      (!Object.hasOwn(value, 'errorCode') || value.status === 'not_applied' && typeof value.errorCode === 'string' && /^[A-Z_]{1,80}$/.test(value.errorCode));
  } catch { return false; }
}
export function isEditTaskEnvelope(value) {
  return exact(value, ['task', 'instanceId'], ['result','restore']) && uuid(value.instanceId) && isEditTask(value.task) &&
    (!Object.hasOwn(value,'restore') || workspaceRestoreTaskContextSchema.safeParse(value.restore).success) &&
    (!Object.hasOwn(value, 'result') || value.task.status === 'applied' &&
      responseValidators[value.task.lane]?.(value.task.operation, value.task.input, value.result));
}
export function isEditTaskListEnvelope(value) {
  return exact(value, ['items', 'nextCursor', 'instanceId'], ['restore']) && uuid(value.instanceId) && Array.isArray(value.items) &&
    value.items.length <= EDIT_TASK_LIMITS.maxPageSize && value.items.every(isEditTask) && new Set(value.items.map(item => item.id)).size === value.items.length &&
    (!Object.hasOwn(value,'restore') || workspaceRestoreTaskListContextSchema.safeParse(value.restore).success &&
      value.restore.tasks.length===value.items.length && value.restore.tasks.every((item,index)=>item.taskId===value.items[index].id)) &&
    (value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length >= 1 && value.nextCursor.length <= 512);
}
