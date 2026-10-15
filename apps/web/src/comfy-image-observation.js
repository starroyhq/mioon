import { comfyConnectorAvailable } from './comfy-image-settings.js';
import { ApiError } from './api.js';
import { canonicalImageInput, comfyRemoteSchemas, isComfyRemoteResponse, isComfyObserveResponse } from '@mioon/contracts';

const copy = value => structuredClone(value), PREFIX = 'mioon.comfy-observation.v1:';
const failure = () => new Error('Invalid local ComfyUI observation response');
const identity = remote => canonicalImageInput(Object.fromEntries(['taskId', 'projectId', 'reviewId', 'promptId', 'clientId', 'outputNonce', 'filenamePrefix', 'workflowId', 'workflowVersion', 'comfyVersion', 'seed', 'baseUrl', 'graphHash', 'createdAt'].map(key => [key, remote[key]])));
export const comfyObservationActive = value => ['queued', 'running'].includes(value?.observation?.state);
export function comfyCanObserve(state, task) {
  const value = state.remotes?.[task?.id];
  if (task?.providerId !== 'comfy-local' || state.remoteActionTaskId || state.remoteStorageBlocked) return false;
  // A late receipt may be replayed even after another observer finished the task.
  if (state.remotePending) return state.remotePending.input.taskId === task.id;
  return Boolean(comfyConnectorAvailable(state.comfyAvailability) && task.dispatched && ['outcome_unknown', 'receiving'].includes(task.state) && value && value.remote.state !== 'failed' && !comfyObservationActive(value));
}
const rejectionCodes = new Set(['COMFY_REMOTE_STATE', 'COMFY_REMOTE_REVISION_CONFLICT', 'COMFY_REMOTE_BUSY', 'COMFY_REMOTE_CAPACITY', 'COMFY_MODULE_UNAVAILABLE']);
async function notAccepted(error, input) {
  const proof = error?.details?.observation;
  if (!(error instanceof ApiError) || !rejectionCodes.has(error.code) || error.status !== (error.code === 'COMFY_REMOTE_CAPACITY' ? 507 : error.code === 'COMFY_MODULE_UNAVAILABLE' ? 503 : 409) || proof?.outcome !== 'not_accepted' || proof.operation !== 'image.task.observeRemote' || proof.projectId !== input.projectId || proof.taskId !== input.taskId || proof.requestId !== input.requestId || !/^[a-f0-9]{64}$/.test(proof.inputHash || '')) return false;
  try { const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalImageInput(input))); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash; } catch { return false; }
}
/** Observing has its own journal: old recoverResult receipts and task revisions are untouched. */
export function createComfyObservationSession({ projectId, call, storage, requestId, getAvailability = () => null, onChange = () => {} }) {
  let active = true, visible = true, values = {}, pending = null, actionTaskId = null, storageBlocked = false;
  const store = () => storage === undefined ? globalThis.sessionStorage : storage;
  const emit = (message = '') => { if (active) onChange({ remotes: copy(values), remotePending: copy(pending), remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked, ...(message ? { message } : {}) }); };
  try { const saved = store()?.getItem(`${PREFIX}${projectId}`); if (saved) { const value = JSON.parse(saved); if (value.version !== 1 || value.operation !== 'image.task.observeRemote' || !comfyRemoteSchemas[value.operation]?.safeParse(value.input).success || value.input.projectId !== projectId) throw failure(); pending = value; } }
  catch { storageBlocked = true; }
  function clear(expected) {
    if (!active || pending !== expected) return false;
    try { const raw = store()?.getItem(`${PREFIX}${projectId}`); if (raw && canonicalImageInput(JSON.parse(raw)) !== canonicalImageInput(expected)) throw failure(); store()?.removeItem(`${PREFIX}${projectId}`); if (store()?.getItem(`${PREFIX}${projectId}`)) throw failure(); pending = null; emit(); return true; }
    catch { storageBlocked = true; emit('无法核验本地查询记录。请重新打开面板后核对；没有重新提交生成。'); return false; }
  }
  async function read(taskId, review = null) {
    if (!active || !visible) return false;
    const value = await call('image.task.remote.get', { projectId, taskId });
    if (!active) return false;
    if (!isComfyRemoteResponse(value) || value.projectId !== projectId || value.taskId !== taskId) throw failure();
    if (review && (value.remote.reviewId !== review.id || value.remote.baseUrl !== review.configuration.baseUrl || ['promptId', 'clientId', 'outputNonce', 'filenamePrefix', 'workflowId', 'workflowVersion', 'comfyVersion', 'seed', 'graphHash'].some(key => value.remote[key] !== review.execution[key]))) throw failure();
    const old = values[taskId];
    if (old && (identity(old.remote) !== identity(value.remote) || old.remote.revision === value.remote.revision && canonicalImageInput(old.remote) !== canonicalImageInput(value.remote))) throw failure();
    if (old?.observation && old.observation.id === value.observation?.id && (old.observation.revision > value.observation.revision || old.observation.revision === value.observation.revision && canonicalImageInput(old.observation) !== canonicalImageInput(value.observation))) throw failure();
    if (!old || value.remote.revision >= old.remote.revision) values = { ...values, [taskId]: copy(value) };
    if (pending?.input.taskId === taskId && value.observation?.requestId === pending.input.requestId && value.observation.remoteRevision === pending.input.expectedRevision + 1) clear(pending);
    emit(); return true;
  }
  async function observe(task) {
    if (!active || !visible || !comfyCanObserve({ comfyAvailability: getAvailability(), remotes: values, remotePending: pending, remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked }, task)) return false;
    let intent = pending;
    if (!intent) {
      intent = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId: task.id, expectedRevision: values[task.id].remote.revision, requestId: requestId() } };
      if (!comfyRemoteSchemas[intent.operation].safeParse(intent.input).success) return false;
      try { const target = store(); if (!target || target.getItem(`${PREFIX}${projectId}`)) throw failure(); const raw = JSON.stringify(intent); target.setItem(`${PREFIX}${projectId}`, raw); if (target.getItem(`${PREFIX}${projectId}`) !== raw) throw failure(); }
      catch { storageBlocked = true; emit('无法保存本地查询凭据。没有发起远端查询。'); return false; }
      pending = intent;
    }
    // Explicit retry uses the same durable key and exact CAS revision. The backend
    // replays a prior admission ACK without scheduling another external read.
    actionTaskId = task.id; emit();
    try { const result = await call(intent.operation, copy(intent.input)); if (!active || pending !== intent) return false; if (!isComfyObserveResponse(intent.input, result)) throw failure(); if (!clear(intent)) return false; emit('此查询已接受。只读取保存的生成身份并按证据取回结果，不提交新的生成。'); return true; }
    catch (error) {
      const rejected = await notAccepted(error, intent.input);
      if (!active || pending !== intent) return false;
      if (rejected && clear(intent)) emit('此次查询未被接受，查询凭据已核对。请读取当前状态后再明确查询；没有自动重试或提交生成。');
      else emit('查询是否已接受仍待确认。保留同一个查询标识；重新读取只核对本地记录，不会重提生成。');
      return false;
    }
    finally { if (active) { actionTaskId = null; emit(); } }
  }
  return { snapshot: () => ({ remotes: copy(values), remotePending: copy(pending), remoteActionTaskId: actionTaskId, remoteStorageBlocked: storageBlocked }), read, observe, setVisible(value) { visible = Boolean(value); }, dispose() { active = false; } };
}
