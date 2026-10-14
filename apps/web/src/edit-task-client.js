import { readLoudnessApplyRpc } from './timeline-loudness-apply-rpc.ts';
import { workspaceOriginOptions } from './workspace-origin.js';
import { ApiError } from './api.js';
import { DURABLE_EDIT_OPERATIONS, isEditTaskEnvelope, isEditTaskListEnvelope } from '@mioon/contracts';

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
  // Shared envelope validation explicitly selects the operation family's ACK.
  return value;
}
export function validateTaskList(value, projectId, { pendingOnly = true } = {}) {
  if (!isEditTaskListEnvelope(value) || value.items.some(task => task.projectId !== projectId || pendingOnly && task.acknowledged)) throw taskProtocolError();
  return value;
}

export function createEditTaskClient({ fetcher = (...args) => fetch(...args) } = {}) {
  async function request(path, body, options = {}) {
    const invocation = workspaceOriginOptions(options.expectedWorkspaceOrigin);
    const loudness = options.operation === 'timeline.loudness.apply' ? await readLoudnessApplyRpc(path, body ? { ...body, ...invocation } : undefined, { fetcher }) : null;
    const response = loudness?.response ?? await fetcher(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...invocation }) } : {}) });
    let payload;
    try { payload = loudness ? loudness.body : await response.json(); } catch { throw taskProtocolError(); }
    if (!payload || typeof payload.ok !== 'boolean' || (payload.ok ? !response.ok || !Object.hasOwn(payload, 'data')
      : typeof payload.error?.code !== 'string' || typeof payload.error?.message !== 'string')) throw taskProtocolError();
    if (!payload.ok || !response.ok) throw new ApiError(payload.error.message, response.status === 401 ? 'UNAUTHORIZED' : payload.error.code, payload.error.details);
    return payload.data;
  }
  const endpoint = taskId => `/api/tasks/${encodeURIComponent(taskId)}`;
  return {
    async prepare(input, options) { return validateTaskEnvelope(await request('/api/tasks/prepare', input, { ...options, operation: input.operation }), input); },
    async list({ projectId, limit = 50, cursor, pendingOnly = true }) {
      const query = new URLSearchParams({ projectId, pendingOnly: String(pendingOnly), limit: String(limit), ...(cursor ? { cursor } : {}) });
      return validateTaskList(await request(`/api/tasks?${query}`), projectId, { pendingOnly });
    },
    async get({ projectId, taskId, operation }) { return validateTaskEnvelope(await request(`${endpoint(taskId)}?${new URLSearchParams({ projectId })}`, undefined, { operation }), { projectId, taskId }); },
    async execute({ taskId, ...body }, options) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/execute`, body, options), { ...body, taskId }); },
    async reconcile({ taskId, ...body }, options) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/reconcile`, body, options), { ...body, taskId }); },
    async acknowledge({ taskId, ...body }, options) { return validateTaskEnvelope(await request(`${endpoint(taskId)}/acknowledge`, body, options), { ...body, taskId }); },
  };
}
