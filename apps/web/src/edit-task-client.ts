import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import { readLoudnessApplyRpc } from './timeline-loudness-apply-rpc.ts';
import { workspaceOriginOptions } from './workspace-origin.ts';
import { ApiError } from './api.ts';
import { DURABLE_EDIT_OPERATIONS, isEditTaskEnvelope, isEditTaskListEnvelope } from '@mioon/contracts';
export interface EditTask {
  id: string; projectId: string; operation: string; input: Record<string, unknown>; requestId: string; digest: string;
  lane: string; status: 'prepared'|'dispatching'|'unknown'|'applied'|'not_applied'; revision: number; createdAt: string; updatedAt: string;
  acknowledged: boolean; origin: 'new'|'legacy_session'; errorCode?: string;
}
export interface EditTaskEnvelope {readonly task: EditTask; readonly instanceId: string; readonly result?: unknown; readonly restore?: unknown}
export interface EditTaskListEnvelope {readonly items: EditTask[]; readonly nextCursor: string|null; readonly instanceId: string; readonly restore?: unknown}
export interface TaskExpectation {readonly projectId?: unknown; readonly taskId?: unknown; readonly operation?: unknown; readonly digest?: unknown; readonly origin?: unknown; readonly input?: Record<string, unknown>}
export interface TaskListOptions {pendingOnly?: boolean}
export interface EditTaskProtocolError extends ApiError {displayMessage: ReturnType<typeof localizedMessage>}
export interface EditTaskRequestOptions {expectedWorkspaceOrigin?: unknown; operation?: string; signal?: AbortSignal}
export interface EditTaskPrepareInput extends Record<string, unknown> {projectId?: unknown; requestId?: unknown; operation: string}
export interface EditTaskListInput {projectId: string; limit?: number; cursor?: string; pendingOnly?: boolean}
export interface EditTaskGetInput {projectId: string; taskId: string; operation?: string}
export interface EditTaskExecuteInput extends Record<string, unknown> {taskId: string}
export interface EditTaskClient {
  prepare(input: EditTaskPrepareInput, options?: EditTaskRequestOptions): Promise<EditTaskEnvelope>;
  list(input: EditTaskListInput): Promise<EditTaskListEnvelope>;
  get(input: EditTaskGetInput): Promise<EditTaskEnvelope>;
  execute(input: EditTaskExecuteInput, options?: EditTaskRequestOptions): Promise<EditTaskEnvelope>;
  reconcile(input: EditTaskExecuteInput, options?: EditTaskRequestOptions): Promise<EditTaskEnvelope>;
  acknowledge(input: EditTaskExecuteInput, options?: EditTaskRequestOptions): Promise<EditTaskEnvelope>;
}
export interface CreateEditTaskClientOptions {fetcher?: typeof fetch; opacityBinding?: unknown}
export interface EditTaskClientValidation {readonly validateTaskEnvelope: typeof validateTaskEnvelope; readonly validateTaskList: typeof validateTaskList}
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorCode=(error: unknown): string|undefined=>typeof property(error,'code')==='string'?property(error,'code') as string:undefined;

export const isDurableEditOperation=(operation: unknown): boolean=>typeof operation==='string'&&(DURABLE_EDIT_OPERATIONS as readonly string[]).includes(operation);
export const taskInputKey=(value: unknown): string=>JSON.stringify(value, (_: string,item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) as string;
export const taskProtocolError=(): EditTaskProtocolError => Object.assign(new ApiError('任务确认无效。原请求仍保留，请重新核对任务；不会自动重试。', 'BACKEND_PROTOCOL_ERROR'), { displayMessage: localizedMessage('tasks.localError.taskProtocol') });

// A 200 is not an acknowledgment. Bind every reply to the exact persisted
// identity before it is allowed to release an edit lane or a legacy receipt.
export function validateTaskEnvelope(value: unknown,expected: TaskExpectation = {}): EditTaskEnvelope {
  return checkTaskEnvelope(value, expected, isEditTaskEnvelope);
}
function checkTaskEnvelope(value: unknown,expected: TaskExpectation,validate: (value: unknown)=>boolean): EditTaskEnvelope {
  if (!validate(value) || !isRecord(value) || !isRecord(value.task)) throw taskProtocolError();
  const envelope=value as unknown as EditTaskEnvelope, task = envelope.task;
  for (const [field, actual] of Object.entries({ projectId: task.projectId, taskId: task.id, operation: task.operation, digest: task.digest, origin: task.origin }))
    if (expected[field as keyof TaskExpectation] !== undefined && expected[field as keyof TaskExpectation] !== actual) throw taskProtocolError();
  if (expected.input && taskInputKey(expected.input) !== taskInputKey(task.input)) throw taskProtocolError();
  // Shared envelope validation explicitly selects the operation family's ACK.
  return envelope;
}
export function validateTaskList(value: unknown,projectId: string,{ pendingOnly = true }: TaskListOptions = {}): EditTaskListEnvelope {
  return checkTaskList(value, projectId, {pendingOnly}, isEditTaskListEnvelope);
}
function checkTaskList(value: unknown,projectId: string,{pendingOnly}: Required<TaskListOptions>,validate: (value: unknown)=>boolean): EditTaskListEnvelope {
  const envelope=value as unknown as EditTaskListEnvelope;
  if (!validate(value) || !isRecord(value) || !Array.isArray(value.items) || value.items.some(task => property(task,'projectId') !== projectId || pendingOnly && property(task,'acknowledged'))) throw taskProtocolError();
  return envelope;
}

import {readOpacityCandidateClientBinding} from './opacity-candidate-client-binding.ts';
const clientValidation = new WeakMap<object,EditTaskClientValidation>();
export function editTaskClientValidation(client: object): EditTaskClientValidation {
  return clientValidation.get(client) ?? {validateTaskEnvelope, validateTaskList};
}
export function createEditTaskClient({ fetcher = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => fetch(...args), opacityBinding }: CreateEditTaskClientOptions = {}): EditTaskClient {
  const selected = readOpacityCandidateClientBinding(opacityBinding);
  const validateEnvelope = selected ? (value: unknown, expected: TaskExpectation = {}): EditTaskEnvelope => checkTaskEnvelope(value, expected, selected.isTaskEnvelope) : (value: unknown, expected: TaskExpectation = {}): EditTaskEnvelope => checkTaskEnvelope(value, expected, isEditTaskEnvelope);
  const validateList = selected ? (value: unknown, projectId: string, options: TaskListOptions = {}): EditTaskListEnvelope => checkTaskList(value, projectId, {pendingOnly: options.pendingOnly ?? true}, selected.isTaskList) : (value: unknown, projectId: string, options: TaskListOptions = {}): EditTaskListEnvelope => checkTaskList(value, projectId, {pendingOnly: options.pendingOnly ?? true}, isEditTaskListEnvelope);
  async function request(path: string,body: Record<string,unknown>|undefined,options: EditTaskRequestOptions = {}): Promise<unknown> {
    const invocation = workspaceOriginOptions(options.expectedWorkspaceOrigin);
    const loudness = options.operation === 'timeline.loudness.apply' ? await readLoudnessApplyRpc(path, body ? { ...body, ...invocation } : undefined, { fetcher }) : null;
    const response = loudness?.response ?? await fetcher(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...invocation }) } : {}) });
    let payload: unknown;
    try { payload = loudness ? loudness.body : await response.json(); } catch { throw taskProtocolError(); }
    if (!isRecord(payload) || typeof payload.ok !== 'boolean' || (payload.ok ? !response.ok || !Object.hasOwn(payload, 'data')
      : !isRecord(payload.error) || typeof payload.error.code !== 'string' || typeof payload.error.message !== 'string')) throw taskProtocolError();
    if (!payload.ok || !response.ok) throw new ApiError(String(property(payload,'error') && isRecord(payload.error) ? payload.error.message : ''), response.status === 401 ? 'UNAUTHORIZED' : errorCode(property(payload,'error')), property(property(payload,'error'),'details'));
    return payload.data;
  }
  const endpoint = (taskId: string): string => `/api/tasks/${encodeURIComponent(taskId)}`;
  const client: EditTaskClient = {
    async prepare(input: EditTaskPrepareInput,options?: EditTaskRequestOptions) { return validateEnvelope(await request('/api/tasks/prepare', input, { ...options, operation: input.operation }), input); },
    async list({ projectId, limit = 50, cursor, pendingOnly = true }: EditTaskListInput) {
      const query = new URLSearchParams({ projectId, pendingOnly: String(pendingOnly), limit: String(limit), ...(cursor ? { cursor } : {}) });
      return validateList(await request(`/api/tasks?${query}`, undefined), projectId, { pendingOnly });
    },
    async get({ projectId, taskId, operation }: EditTaskGetInput) { return validateEnvelope(await request(`${endpoint(taskId)}?${new URLSearchParams({ projectId })}`, undefined, { operation }), { projectId, taskId }); },
    async execute({ taskId, ...body }: EditTaskExecuteInput,options?: EditTaskRequestOptions) { return validateEnvelope(await request(`${endpoint(taskId)}/execute`, body, options), { ...body, taskId }); },
    async reconcile({ taskId, ...body }: EditTaskExecuteInput,options?: EditTaskRequestOptions) { return validateEnvelope(await request(`${endpoint(taskId)}/reconcile`, body, options), { ...body, taskId }); },
    async acknowledge({ taskId, ...body }: EditTaskExecuteInput,options?: EditTaskRequestOptions) { return validateEnvelope(await request(`${endpoint(taskId)}/acknowledge`, body, options), { ...body, taskId }); },
  };
  if (selected) clientValidation.set(client, Object.freeze({validateTaskEnvelope: validateEnvelope, validateTaskList: validateList}));
  return client;
}
