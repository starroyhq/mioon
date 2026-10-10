import { ApiError } from './api.js';
import { DURABLE_EDIT_OPERATIONS, isEditTaskEnvelope, isEditTaskListEnvelope, isTimelineMutationResponse, isReferenceMutationResponse } from '@mioon/contracts';

export const isDurableEditOperation = operation => DURABLE_EDIT_OPERATIONS.includes(operation);
export const taskInputKey = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const taskProtocolError = () => new ApiError('任务确认无效。原请求仍保留，请重新核对任务；不会自动重试。', 'BACKEND_PROTOCOL_ERROR');

// A 200 is not an acknowledgment. Bind every reply to the exact persisted
// identity before it is allowed to release an edit lane or a legacy receipt.
export function validateTaskEnvelope(value, expected = {}) {
  if (!isEditTaskEnvelope(value)) throw taskProtocolError();
  const task = value.task;
  for (const [field, actual] of Object.entries({ projectId: task.projectId, taskId: task.id, operation: task.operation, digest: task.digest, origin: task.origin }))
    if (expected[field] !== undefined && expected[field] !== actual) throw taskProtocolError();
  if (expected.input && taskInputKey(expected.input) !== taskInputKey(task.input)) throw taskProtocolError();
  if (Object.hasOwn(value, 'result')) {
    const valid = task.status === 'applied' && (task.operation.startsWith('timeline.')
      ? isTimelineMutationResponse(task.operation, task.input, value.result)
      : isReferenceMutationResponse(task.operation, task.input, value.result));
    if (!valid) throw taskProtocolError();
  }
  return value;
}
export function validateTaskList(value, projectId) {
  if (!isEditTaskListEnvelope(value) || value.items.some(task => task.projectId !== projectId || task.acknowledged)) throw taskProtocolError();
  return value;
}

export function createEditTaskClient({ fetcher = (...args) => fetch(...args) } = {}) {
  async function request(path, body) {
    const response = await fetcher(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    let payload;
    try { payload = await response.json(); } catch { throw taskProtocolError(); }
    if (!payload || typeof payload.ok !== 'boolean' || (payload.ok ? !response.ok || !Object.hasOwn(payload, 'data')
      : typeof payload.error?.code !== 'string' || typeof payload.error?.message !== 'string')) throw taskProtocolError();
    if (!payload.ok || !response.ok) throw new ApiError(payload.error.message, response.status === 401 ? 'UNAUTHORIZED' : payload.error.code, payload.error.details);
    return payload.data;
  }
  const endpoint = taskId => `/api/tasks/${encodeURIComponent(taskId)}`;
  return {
    async prepare(input) { return validateTaskEnvelope(await request('/api/tasks/prepare', input), input); },
    async list({ projectId, limit = 50, cursor }) {
      const query = new URLSearchParams({ projectId, pendingOnly: 'true', limit: String(limit), ...(cursor ? { cursor } : {}) });
      return validateTaskList(await request(`/api/tasks?${query}`), projectId);
    },
    async get({ projectId, taskId }) { return validateTaskEnvelope(await request(`${endpoint(taskId)}?${new URLSearchParams({ projectId })}`), { projectId, taskId }); },
    async execute({ taskId, ...body }) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/execute`, body), { ...body, taskId }); },
    async reconcile({ taskId, ...body }) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/reconcile`, body), { ...body, taskId }); },
    async acknowledge({ taskId, ...body }) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/acknowledge`, body), { ...body, taskId }); },
  };
}
