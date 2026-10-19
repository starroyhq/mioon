import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { comfyConnectorAvailable } from './comfy-image-settings.ts';
import { ApiError } from './api.ts';
import { canonicalImageInput, comfyRemoteSchemas, isComfyRemoteResponse, isComfyObserveResponse } from '@mioon/contracts';

export interface ComfyObservationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ComfyObservationInput {projectId: string; taskId: string; expectedRevision: number; requestId: string}
export interface ComfyObservationIntent {version: 1; operation: 'image.task.observeRemote'; input: ComfyObservationInput}
export interface ComfyRemoteValue {readonly remote: Record<string, unknown> & {revision: number; state: string}; readonly observation?: Record<string, unknown> | null}
export interface ComfyObservationState {
  remotes: Record<string, ComfyRemoteValue>;
  remotePending: ComfyObservationIntent | null;
  remoteActionTaskId: string | null;
  remoteStorageBlocked: boolean;
  comfyAvailability?: unknown;
}
export interface ComfyObservationPatch {
  remotes: Record<string, ComfyRemoteValue>;
  remotePending: ComfyObservationIntent | null;
  remoteActionTaskId: string | null;
  remoteStorageBlocked: boolean;
  message?: string;
  displayMessage?: DisplayMessage | null;
}
export interface ComfyObservationSessionOptions {
  projectId: string;
  call: (operation: string, input: unknown) => Promise<unknown>;
  storage?: ComfyObservationStorage | undefined;
  requestId: () => string;
  getAvailability?: () => unknown;
  onChange?: (patch: ComfyObservationPatch) => void;
}
export interface ComfyObservationSession {
  snapshot(): {remotes: Record<string, ComfyRemoteValue>; remotePending: ComfyObservationIntent | null; remoteActionTaskId: string | null; remoteStorageBlocked: boolean};
  read(taskId: string, review?: unknown): Promise<boolean>;
  observe(task: unknown): Promise<boolean>;
  setVisible(value: unknown): void;
  dispose(): void;
}
const PREFIX = 'mioon.comfy-observation.v1:';
const copy=<T>(value: T): T=>structuredClone(value);
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const failure=(): Error=>new Error('Invalid local ComfyUI observation response');
const identity=(remote: unknown): string=>canonicalImageInput(Object.fromEntries(['taskId', 'projectId', 'reviewId', 'promptId', 'clientId', 'outputNonce', 'filenamePrefix', 'workflowId', 'workflowVersion', 'comfyVersion', 'seed', 'baseUrl', 'graphHash', 'createdAt'].map(key => [key, property(remote,key)])));
export const comfyObservationActive=(value: unknown): boolean=>['queued', 'running'].includes(String(property(property(value,'observation'),'state')));
export function comfyCanObserve(state: ComfyObservationState,task: unknown): boolean {
  const taskId=typeof property(task,'id')==='string'?property(task,'id') as string:null;
  const value = taskId!==null ? state.remotes[taskId] : undefined;
  if (property(task,'providerId') !== 'comfy-local' || state.remoteActionTaskId || state.remoteStorageBlocked) return false;
  // A late receipt may be replayed even after another observer finished the task.
  if (state.remotePending) return state.remotePending.input.taskId === taskId;
  return Boolean(comfyConnectorAvailable(state.comfyAvailability) && property(task,'dispatched') && ['outcome_unknown', 'receiving'].includes(String(property(task,'state'))) && value && property(value.remote,'state') !== 'failed' && !comfyObservationActive(value));
}
const rejectionCodes = new Set(['COMFY_REMOTE_STATE', 'COMFY_REMOTE_REVISION_CONFLICT', 'COMFY_REMOTE_BUSY', 'COMFY_REMOTE_CAPACITY', 'COMFY_MODULE_UNAVAILABLE']);
async function notAccepted(error: unknown,input: ComfyObservationInput): Promise<boolean> {
  const proof = property(property(error,'details'),'observation');
  if (!(error instanceof ApiError) || !rejectionCodes.has(error.code) || error.status !== (error.code === 'COMFY_REMOTE_CAPACITY' ? 507 : error.code === 'COMFY_MODULE_UNAVAILABLE' ? 503 : 409) || property(proof,'outcome') !== 'not_accepted' || property(proof,'operation') !== 'image.task.observeRemote' || property(proof,'projectId') !== input.projectId || property(proof,'taskId') !== input.taskId || property(proof,'requestId') !== input.requestId || !/^[a-f0-9]{64}$/.test(String(property(proof,'inputHash') || ''))) return false;
  try { const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalImageInput(input))); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === property(proof,'inputHash'); } catch { return false; }
}
/** Observing has its own journal: old recoverResult receipts and task revisions are untouched. */
export function createComfyObservationSession({ projectId, call, storage, requestId, getAvailability = () => null, onChange = () => {} }: ComfyObservationSessionOptions): ComfyObservationSession {
  let active = true, visible = true, values: Record<string, ComfyRemoteValue> = {}, pending: ComfyObservationIntent | null = null, actionTaskId: string | null = null, storageBlocked = false;
  const store = (): ComfyObservationStorage | undefined => storage === undefined ? globalThis.sessionStorage as unknown as ComfyObservationStorage : storage;
  const emit = (message = '', displayMessage: DisplayMessage | null = null): void => { if (active) onChange({ remotes: copy(values), remotePending: copy(pending), remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked, ...(message ? { message, displayMessage } : {}) }); };
  try { const saved = store()?.getItem(`${PREFIX}${projectId}`); if (saved) { const value: unknown = JSON.parse(saved); if (!isRecord(value) || value.version !== 1 || value.operation !== 'image.task.observeRemote' || !isRecord(value.input) || !comfyRemoteSchemas['image.task.observeRemote']?.safeParse(value.input).success || value.input.projectId !== projectId) throw failure(); pending = value as unknown as ComfyObservationIntent; } }
  catch { storageBlocked = true; }
  function clear(expected: ComfyObservationIntent | null): boolean {
    if (!active || pending !== expected) return false;
    try { const raw = store()?.getItem(`${PREFIX}${projectId}`); if (raw && canonicalImageInput(JSON.parse(raw)) !== canonicalImageInput(expected)) throw failure(); store()?.removeItem(`${PREFIX}${projectId}`); if (store()?.getItem(`${PREFIX}${projectId}`)) throw failure(); pending = null; emit(); return true; }
    catch { storageBlocked = true; emit('无法核验本地查询记录。请重新打开面板后核对；没有重新提交生成。', localizedMessage('image.comfy.observation.recordUnverifiable')); return false; }
  }
  async function read(taskId: string, review: unknown = null): Promise<boolean> {
    if (!active || !visible) return false;
    const value = await call('image.task.remote.get', { projectId, taskId });
    if (!active) return false;
    if (!isComfyRemoteResponse(value) || !isRecord(value) || value.projectId !== projectId || value.taskId !== taskId) throw failure();
    const remote=property(value,'remote'), observation=property(value,'observation');
    if (review && (property(remote,'reviewId') !== property(review,'id') || property(remote,'baseUrl') !== property(property(review,'configuration'),'baseUrl') || ['promptId', 'clientId', 'outputNonce', 'filenamePrefix', 'workflowId', 'workflowVersion', 'comfyVersion', 'seed', 'graphHash'].some(key => property(remote,key) !== property(property(review,'execution'),key)))) throw failure();
    const old = values[taskId];
    if (old && (identity(old.remote) !== identity(remote) || property(old.remote,'revision') === property(remote,'revision') && canonicalImageInput(old.remote) !== canonicalImageInput(remote))) throw failure();
    if (old?.observation && property(old.observation,'id') === property(observation,'id') && (Number(property(old.observation,'revision')) > Number(property(observation,'revision')) || property(old.observation,'revision') === property(observation,'revision') && canonicalImageInput(old.observation) !== canonicalImageInput(observation))) throw failure();
    if (!old || Number(property(remote,'revision')) >= Number(property(old.remote,'revision'))) values = { ...values, [taskId]: copy(value) as unknown as ComfyRemoteValue };
    if (pending?.input.taskId === taskId && property(observation,'requestId') === pending.input.requestId && property(observation,'remoteRevision') === pending.input.expectedRevision + 1) clear(pending);
    emit(); return true;
  }
  async function observe(task: unknown): Promise<boolean> {
    if (!active || !visible || !comfyCanObserve({ comfyAvailability: getAvailability(), remotes: values, remotePending: pending, remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked }, task)) return false;
    const taskId=typeof property(task,'id')==='string'?property(task,'id') as string:null;
    if(taskId===null)return false;
    let intent = pending;
    if (!intent) {
      intent = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId, expectedRevision: Number(property(values[taskId]?.remote,'revision')), requestId: requestId() } };
      if (!comfyRemoteSchemas[intent.operation].safeParse(intent.input).success) return false;
      try { const target = store(); if (!target || target.getItem(`${PREFIX}${projectId}`)) throw failure(); const raw = JSON.stringify(intent); target.setItem(`${PREFIX}${projectId}`, raw); if (target.getItem(`${PREFIX}${projectId}`) !== raw) throw failure(); }
      catch { storageBlocked = true; emit('无法保存本地查询凭据。没有发起远端查询。', localizedMessage('image.comfy.observation.receiptSaveFailed')); return false; }
      pending = intent;
    }
    // Explicit retry uses the same durable key and exact CAS revision. The backend
    // replays a prior admission ACK without scheduling another external read.
    actionTaskId = taskId; emit();
    const savedIntent=intent;
    try { const result = await call(savedIntent.operation, copy(savedIntent.input)); if (!active || pending !== savedIntent) return false; if (!isComfyObserveResponse(savedIntent.input, result)) throw failure(); if (!clear(savedIntent)) return false; emit('此查询已接受。只读取保存的生成身份并按证据取回结果，不提交新的生成。', localizedMessage('image.comfy.observation.accepted')); return true; }
    catch (error) {
      const rejected = await notAccepted(error, savedIntent.input);
      if (!active || pending !== savedIntent) return false;
      if (rejected && clear(savedIntent)) emit('此次查询未被接受，查询凭据已核对。请读取当前状态后再明确查询；没有自动重试或提交生成。', localizedMessage('image.comfy.observation.notAccepted'));
      else emit('查询是否已接受仍待确认。保留同一个查询标识；重新读取只核对本地记录，不会重提生成。', localizedMessage('image.comfy.observation.acceptanceUnknown'));
      return false;
    }
    finally { if (active) { actionTaskId = null; emit(); } }
  }
  return { snapshot: () => ({ remotes: copy(values), remotePending: copy(pending), remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked }), read, observe, setVisible(value: unknown): void { visible = Boolean(value); }, dispose(): void { active = false; } };
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
