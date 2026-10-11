import { ApiError, rpc, requestId as newRequestId } from './api.js';
import { IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_LIMITS, canonicalImageInput, imageSchemas, isImageTaskResponse, isImageGroupResponse, isImageMutationResponse, isImageRequestResponse, isImageListResponse, isImageReviewResponse, isImageReviewListResponse, isImageReviewPreparationResponse, isCompleteCustomImageConfiguration, getCustomImageDestination, COMFY_IMAGE_OPTIONS, comfyImageExecutionSchema, isCompleteComfyImageConfiguration, getComfyImageDestination } from '@mioon/contracts';
import { safeImageSettings } from './image-settings.js';
import { safeComfyImageSettings } from './comfy-image-settings.js';
import { createComfyObservationSession, comfyObservationActive, comfyCanObserve } from './comfy-image-observation.js';
export { comfyCanObserve } from './comfy-image-observation.js';
import { createImageReviewClient, imageReviewIdentity as reviewIdentity } from './image-review.js';

export { IMAGE_FIXED_OPTIONS, IMAGE_MODELS };
const PREFIX = 'mioon.image-intent.v1:';
const ACTIVE = new Set(['queued', 'dispatching', 'receiving', 'persisting']);
const CANCELABLE = new Set(['queued', 'interrupted_before_dispatch']);
const REJECTION_CODES = new Set(['IMAGE_LIVE_DISABLED', 'IMAGE_CAPACITY', 'IMAGE_QUEUE_FULL', 'IMAGE_GROUP_BUSY', 'IMAGE_REVISION_CONFLICT', 'IMAGE_STATE_CONFLICT', 'IMAGE_RESULT_INVALID']);
const copy = value => structuredClone(value);
const problem = code => Object.assign(new Error(code), { code });
export const imageTaskLabel = state => ({ queued: '等待生成', dispatching: '正在发送', receiving: '正在接收图像', persisting: '正在保存结果', succeeded: '已保存', cancelled_before_dispatch: '发送前已取消', interrupted_before_dispatch: '发送前已中断', failed: '生成失败', outcome_unknown: '服务商结果未知', local_result_error: '本地结果保存失败' }[state] || '状态待确认');
export const imageTaskMessage = state => ({ interrupted_before_dispatch: '应用重启前尚未发送，不会自动继续。可取消此任务，再明确创建新请求。', outcome_unknown: '无法确认服务商结果。可明确检查并恢复已落盘的本地结果；没有可核验结果时仍保持未知，绝不重新调用服务商。', local_result_error: '已有本地结果待恢复。恢复只处理同一份结果，不再次生成。', cancelled_before_dispatch: '已确认在发送前取消，没有启动生成。', failed: '此请求已结束。查看记录后，可明确创建新的生成请求。' }[state] || '');
const customPreDispatchMessages = Object.freeze({
  IMAGE_NETWORK_DENIED: '发送前网络检查未通过。请检查自定义地址是否指向允许访问的 HTTPS 公网服务，再准备新的请求。',
  IMAGE_CONNECTION_FAILED: '发送前无法建立连接。请检查自定义地址和服务状态，再准备新的请求。',
  IMAGE_TIMEOUT: '发送前连接检查超时。请检查自定义服务是否可用，再准备新的请求。',
  IMAGE_DISPATCH_BLOCKED: '发送前安全检查未通过。请重新读取并核对自定义连接设置，再准备新的请求。',
  IMAGE_SETTINGS_CONFLICT: '自定义连接在发送前已变化。请读取当前地址、模型与配置版本，再准备新的请求。',
  IMAGE_SETTINGS_NOT_CONFIGURED: '自定义连接缺少完整设置或可用密钥。请检查连接设置并重新输入此连接的密钥，再准备新的请求。',
  IMAGE_SETTINGS_DISABLED: '自定义连接已停用。请在图像设置中确认是否启用，再准备新的请求。',
});
export function imageTaskConnectionMessage(task) {
  if (task?.providerId !== 'openai-compatible' || task.state !== 'failed' || task.dispatched !== false || !Object.hasOwn(customPreDispatchMessages, task.errorCode)) return '';
  return `${customPreDispatchMessages[task.errorCode]}本次未发送生成 POST；任何新请求都需要重新明确批准，不会自动重试。`;
}
const rejectionMessage = code => ({ IMAGE_LIVE_DISABLED: '真实图像调用尚未启用，本次未被接受。', IMAGE_GROUP_BUSY: '此组有未结束或结果未知的任务，本次未被接受。请查看原任务。', IMAGE_REVISION_CONFLICT: '图像组或任务的状态已变化，本次未被接受。请重新读取并明确选择目标。', IMAGE_QUEUE_FULL: '本地图像队列已满，本次未被接受。草稿保留，可稍后明确提交。', IMAGE_CAPACITY: '本地图像记录容量已满，本次未被接受。草稿保留。', IMAGE_STATE_CONFLICT: '当前任务或图像组不允许此操作，本次未被接受。请重新读取。', IMAGE_RESULT_INVALID: '未找到可完整核验的本地结果，本次恢复未被接受。原任务保留，不会重新生成。' }[code] || '请求未被接受，草稿保留。请重新读取并核对后再提交。');
export function imageInputIssue(draft) {
  if (!draft.name.trim()) return '请填写图像名称。';
  if (draft.name.length > 120) return '名称最多 120 个字符。';
  if (!draft.prompt.trim()) return '请填写图像描述。';
  if (draft.prompt.length > IMAGE_LIMITS.promptCharacters || new TextEncoder().encode(draft.prompt).length > IMAGE_LIMITS.promptBytes) return `描述最多 ${IMAGE_LIMITS.promptCharacters} 个字符。`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(draft.prompt)) return '描述中含有不支持的控制字符。';
  return '';
}
export function initialImageGenerationState() {
  return { draft: { name: '', prompt: '' }, providerId: 'mock', settings: null, customSettings: null, comfySettings: null, remotes: {}, remotePending: null, remoteActionTaskId: null, remoteStorageBlocked: false, reviews: [], reviewCursor: null, reviewTrail: [], nextReviewCursor: null, reviewActionId: null, target: null, targetRequest: null, tasks: [], groups: [], versions: [], selectedGroupId: null, groupCursor: null, groupTrail: [], nextGroupCursor: null, versionCursor: null, versionTrail: [], nextVersionCursor: null, historyPhase: 'idle', pending: null, phase: 'idle', loaded: false, message: '', storageBlocked: false, pollPaused: false, actionTaskId: null };
}
export const imageDraftDirty = state => Boolean(state.draft.name || state.draft.prompt || state.target);
const paidProvider = providerId => ['openai', 'openai-compatible'].includes(providerId);
const reviewedProvider = providerId => paidProvider(providerId) || providerId === 'comfy-local';
export const imageSelectedSettings = (state, providerId = state.providerId) => providerId === 'comfy-local' ? state.comfySettings : providerId === 'openai-compatible' ? state.customSettings : providerId === 'openai' ? state.settings : null;
export function imageReviewCanApprove(state, review) {
  const settings = imageSelectedSettings(state, review?.input?.providerId);
  if (!isImageReviewResponse(review) || review.state !== 'pending' || settings?.revision !== review.settingsRevision || !settings.configuration.enabled) return false;
  if (review.input.providerId === 'comfy-local') return settings.readiness.checked && isCompleteComfyImageConfiguration(settings.configuration) && canonicalImageInput(settings.configuration) === canonicalImageInput(review.configuration);
  return settings.secret.configured && (review.input.providerId !== 'openai-compatible' || canonicalImageInput(settings.configuration) === canonicalImageInput(review.configuration));
}
export function imageTaskReview(state, task) {
  if (!isImageTaskResponse(task)) return null;
  return state.reviews.find(review => isImageReviewResponse(review) && review.taskId === task.id && review.projectId === task.projectId && review.requestId === task.requestId && ['name', 'prompt', 'providerId', 'model', 'options'].every(field => canonicalImageInput(review.input[field]) === canonicalImageInput(task[field])) && (!review.input.groupId || review.input.groupId === task.groupId)) || null;
}
export function imagePaidAuthorization(state) {
  const settings = imageSelectedSettings(state);
  if (!settings || !paidProvider(state.providerId)) return null;
  return { providerId: state.providerId, draft: copy(state.draft), target: copy(state.target), configuration: copy(settings.configuration), settingsRevision: settings.revision,
    destination: state.providerId === 'openai-compatible' ? isCompleteCustomImageConfiguration(settings.configuration) ? getCustomImageDestination(settings.configuration.baseUrl) : null : `${settings.configuration.baseUrl}/images/generations` };
}
export function imageCanGenerate(state) {
  const group = state.target && state.groups.find(item => item.id === state.target.groupId), settings = imageSelectedSettings(state);
  return state.loaded && !state.pending && !state.storageBlocked && !state.actionTaskId && !state.reviewActionId && !state.remoteActionTaskId && !state.remotePending && !state.remoteStorageBlocked && !['loading', 'submitting', 'targeting'].includes(state.phase) && !imageInputIssue(state.draft) && (state.providerId === 'mock' || state.providerId === 'comfy-local' && settings?.configuration.enabled && settings.readiness.checked && settings.revision > 0 && isCompleteComfyImageConfiguration(settings.configuration) || paidProvider(state.providerId) && settings?.configuration.enabled && settings.secret.configured && settings.revision > 0 && (state.providerId !== 'openai-compatible' || isCompleteCustomImageConfiguration(settings.configuration))) && (!state.target || (group && !group.activeTaskId && group.revision === state.target.expectedRevision));
}
const pendingMatchesReview = (pending, review) => canonicalImageInput(pending.input) === canonicalImageInput(review.input) && pending.settingsRevision === review.settingsRevision &&
  (pending.input.providerId !== 'openai-compatible' || pending.version === 2 && canonicalImageInput(pending.configuration) === canonicalImageInput(review.configuration) && pending.destination === review.destination) &&
  (pending.input.providerId !== 'comfy-local' || pending.version === 3 && canonicalImageInput(pending.configuration) === canonicalImageInput(review.configuration) && pending.destination === review.destination && (!pending.execution || canonicalImageInput(pending.execution) === canonicalImageInput(review.execution)));
const fixedIntent = (projectId, value) => {
  if (!value || !imageSchemas[value.operation]?.safeParse(value.input).success || value.input.projectId !== projectId || !['image.generate', 'image.task.cancelQueued', 'image.task.recoverResult'].includes(value.operation)) return false;
  if (value.operation !== 'image.generate' || value.input.providerId === 'mock') return value.version === 1;
  if (!Number.isSafeInteger(value.settingsRevision) || value.settingsRevision < 1 || typeof value.approvalAttempted !== 'boolean' || !(value.reviewId === null || typeof value.reviewId === 'string')) return false;
  if (value.input.providerId === 'openai') return value.version === 1;
  if (value.input.providerId === 'comfy-local') return value.version === 3 && isCompleteComfyImageConfiguration(value.configuration) && value.configuration.enabled && value.configuration.model === value.input.model && canonicalImageInput(value.configuration.options) === canonicalImageInput(value.input.options) && value.destination === getComfyImageDestination(value.configuration.baseUrl) && (value.execution === null && value.reviewId === null && !value.approvalAttempted || comfyImageExecutionSchema.safeParse(value.execution).success);
  return value.version === 2 && isCompleteCustomImageConfiguration(value.configuration) && value.configuration.enabled && value.configuration.model === value.input.model && canonicalImageInput(value.configuration.options) === canonicalImageInput(value.input.options) && value.destination === getCustomImageDestination(value.configuration.baseUrl);
};
const safeTask = (value, projectId) => {
  if (!isImageTaskResponse(value) || value.projectId !== projectId) throw problem('INVALID_RESPONSE');
  return copy(value);
};
const safePage = (operation, input, value) => {
  if (!isImageListResponse(operation, input, value)) throw problem('INVALID_RESPONSE');
  return copy(value);
};
const taskIdentity = task => canonicalImageInput(Object.fromEntries(['id', 'projectId', 'groupId', 'requestId', 'name', 'prompt', 'providerId', 'model', 'options', 'createdAt'].map(key => [key, task[key]])));
function newestTask(previous, next) {
  if (previous && (taskIdentity(previous) !== taskIdentity(next) || (previous.revision === next.revision && canonicalImageInput(previous) !== canonicalImageInput(next)))) throw problem('INVALID_RESPONSE');
  return previous?.revision > next.revision ? previous : next;
}
async function notAccepted(error, operation, input) {
  const proof = error?.details?.imageOutcome;
  if (!(error instanceof ApiError) || !REJECTION_CODES.has(error.code) || proof?.status !== 'not_accepted' || proof.projectId !== input.projectId || proof.operation !== operation || proof.requestId !== input.requestId || !/^[a-f0-9]{64}$/.test(proof.inputHash || '')) return false;
  try {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalImageInput(input)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash;
  } catch { return false; }
}

/** One project lifetime. Reads never dispatch work; every mutation needs a saved exact intent. */
export function createImageGenerationSession({ projectId, api = rpc, reviewClient = createImageReviewClient(), settings, settingsReader, customSettings, customSettingsReader, comfySettings, comfySettingsReader, storage, requestId = newRequestId, onChange = () => {}, onGenerated = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 1500, pollLimit = 40, timeoutMs = 15000 } = {}) {
  let state = initialImageGenerationState(), disposed = false, visible = true, readEpoch = 0, selectionEpoch = 0, interactionEpoch = 0, timer = null, polls = 0, reading = false;
  if (settings) state.settings = safeImageSettings(settings);
  if (customSettings) state.customSettings = safeImageSettings(customSettings, 'custom');
  if (comfySettings) state.comfySettings = safeComfyImageSettings(comfySettings);
  const announced = new Set(), tracked = new Map(), calls = new Set();
  async function call(operation, input) {
    const controller = new AbortController(); calls.add(controller); let deadline;
    const expired = new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(problem('NETWORK')); }, timeoutMs); });
    try { return await Promise.race([Promise.resolve().then(() => api(operation, input, { signal: controller.signal })), expired]); }
    finally { clearTimeout(deadline); calls.delete(controller); }
  }
  const store = () => storage === undefined ? globalThis.sessionStorage : storage;
  const emit = patch => {
    if (disposed) return;
    const groupChanged = Object.hasOwn(patch, 'selectedGroupId') && patch.selectedGroupId !== state.selectedGroupId;
    const pageChanged = Object.hasOwn(patch, 'versionCursor') && patch.versionCursor !== state.versionCursor;
    const groupPageChanged = Object.hasOwn(patch, 'groupCursor') && patch.groupCursor !== state.groupCursor;
    // Saved previews and their cursor belong to one exact group/page. Every
    // selection route (including recovered receipts) crosses this same boundary.
    // Same-page refreshes keep their known results, drafts and recoverable tasks.
    state = { ...state, ...(groupPageChanged ? { nextGroupCursor: null } : {}), ...(groupChanged ? { versionCursor: null, versionTrail: [] } : {}),
      ...(groupChanged || pageChanged ? { versions: [], nextVersionCursor: null, historyPhase: 'loading' } : {}), ...patch };
    onChange(copy(state));
  };
  const observations = createComfyObservationSession({ projectId, call, storage, requestId, onChange: emit });
  state = { ...state, ...observations.snapshot() };
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const owned = epoch => !disposed && readEpoch === epoch;
  function savePending(value) {
    const target = store(); if (!target) throw problem('LOCAL_STORAGE_UNAVAILABLE');
    if (target.getItem(`${PREFIX}${projectId}`)) throw problem('LOCAL_STORAGE_CHANGED');
    const serialized = JSON.stringify(value); target.setItem(`${PREFIX}${projectId}`, serialized);
    if (target.getItem(`${PREFIX}${projectId}`) !== serialized) throw problem('LOCAL_STORAGE_UNAVAILABLE');
  }
  function updatePending(previous, next) {
    try {
      if (disposed || state.pending !== previous) return false;
      const target = store(), stored = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
      if (canonicalImageInput(stored) !== canonicalImageInput(previous)) throw problem('LOCAL_STORAGE_CHANGED');
      const serialized = JSON.stringify(next); target.setItem(`${PREFIX}${projectId}`, serialized);
      if (target.getItem(`${PREFIX}${projectId}`) !== serialized) throw problem('LOCAL_STORAGE_UNAVAILABLE');
      emit({ pending: next }); return true;
    } catch { emit({ storageBlocked: true, phase: 'unknown', message: '无法核验本地审批记录，本次不会继续发送。请重新打开面板后核对。' }); return false; }
  }
  function clearPending(pending) {
    // Late acknowledgements from an old project lifetime never remove a newer intent.
    if (disposed || state.pending !== pending) return false;
    try {
      const target = store(), saved = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
      if (saved && canonicalImageInput(saved) !== canonicalImageInput(pending)) throw problem('LOCAL_STORAGE_CHANGED');
      target?.removeItem(`${PREFIX}${projectId}`);
      if (target?.getItem(`${PREFIX}${projectId}`)) throw problem('LOCAL_STORAGE_UNAVAILABLE');
    } catch { emit({ storageBlocked: true, phase: 'unknown', message: '原请求已确认，但无法更新本地请求记录。请重新打开面板后核对。' }); return false; }
    emit({ pending: null }); return true;
  }
  try {
    const serialized = store()?.getItem(`${PREFIX}${projectId}`);
    if (serialized) {
      const pending = JSON.parse(serialized); if (!fixedIntent(projectId, pending)) throw problem('LOCAL_STORAGE_INVALID');
      state.pending = pending; state.phase = 'unknown';
      if (pending.operation === 'image.generate') { state.draft = { name: pending.input.name, prompt: pending.input.prompt }; state.providerId = pending.input.providerId; }
    }
  } catch { state.storageBlocked = true; state.message = '无法读取本地请求记录。为避免重复生成，暂不能提交。'; }
  function mergeTask(task) {
    const previous = state.tasks.find(item => item.id === task.id);
    task = newestTask(previous, task);
    emit({ tasks: [task, ...state.tasks.filter(item => item.id !== task.id)].slice(0, IMAGE_LIMITS.maxPageSize) });
    if (ACTIVE.has(task.state)) tracked.set(task.id, task); else tracked.delete(task.id);
    if (task.state === 'succeeded' && !announced.has(task.id)) { announced.add(task.id); onGenerated(projectId, copy(task)); }
    return task;
  }
  function schedule() {
    stopTimer();
    if (disposed || !visible || reading || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || !(state.pending || state.remotePending || Object.values(state.remotes).some(comfyObservationActive) || state.tasks.some(task => ACTIVE.has(task.state)))) return;
    if (polls >= pollLimit) { emit({ pollPaused: true }); return; }
    timer = setTimer(() => { timer = null; polls++; void load({ automatic: true }); }, pollMs);
  }
  async function resolvePending(epoch) {
    const pending = state.pending; if (!pending) return;
    const receipt = await call('image.request.get', { projectId, requestId: pending.input.requestId });
    if (!owned(epoch)) return;
    if (!isImageRequestResponse(receipt) || (receipt && (receipt.projectId !== projectId || receipt.requestId !== pending.input.requestId || receipt.operation !== pending.operation || !isImageMutationResponse(pending.operation, pending.input, receipt.response)))) throw problem('INVALID_RESPONSE');
    if (!receipt) {
      if (pending.reviewId) {
        const review = await call('image.review.get', { projectId, reviewId: pending.reviewId });
        if (!owned(epoch)) return;
        if (!isImageReviewResponse(review) || review.projectId !== projectId || !pendingMatchesReview(pending, review)) throw problem('INVALID_RESPONSE');
        mergeReview(review);
        if (review.state === 'rejected' && clearPending(pending)) { emit({ phase: 'ready', message: '原请求已被拒绝，没有重新生成。' }); return; }
        if (review.state === 'pending') { emit({ phase: 'unknown', message: '原始描述仍在等待审批。只有明确点击批准才会发送，不会自动继续。' }); return; }
      }
      emit({ phase: 'unknown', message: reviewedProvider(pending.input.providerId) && !pending.approvalAttempted ? pending.input.providerId === 'comfy-local' ? '尚未确认本地运行准备结果；没有批准运行。请重新读取，或明确放弃此未批准请求。' : '尚未确认审批准备结果；没有发起付费审批。请重新读取，或明确放弃此未批准请求。' : '尚未找到原请求的确认记录。这不能证明请求未被接受；请继续核对，不要重复生成。' }); return;
    }
    const latest = safeTask(await call('image.task.get', { projectId, taskId: receipt.response.id }), projectId);
    if (!owned(epoch)) return;
    if (taskIdentity(latest) !== taskIdentity(receipt.response) || latest.revision < receipt.response.revision) throw problem('INVALID_RESPONSE');
    mergeTask(latest);
    if (clearPending(pending)) emit({ phase: 'ready', ...(pending.operation === 'image.generate' ? { ...(!pending.preserveDraft ? { draft: { name: '', prompt: '' }, target: null } : {}), selectedGroupId: latest.groupId, versionCursor: null, versionTrail: [] } : {}), message: '已找到原请求，没有重新生成。' });
  }
  async function load({ automatic = false } = {}) {
    if (disposed || !visible || reading || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || state.phase === 'targeting') return false;
    if (!automatic) { polls = 0; emit({ pollPaused: false }); }
    stopTimer(); const epoch = ++readEpoch; reading = epoch; let pendingRemoteTask = null;
    emit({ historyPhase: 'loading', ...(!state.loaded ? { phase: state.pending ? 'unknown' : 'loading' } : {}) });
    try {
      await resolvePending(epoch); if (!owned(epoch)) return false;
      if (state.remotePending) {
        const task = safeTask(await call('image.task.get', { projectId, taskId: state.remotePending.input.taskId }), projectId);
        if (!owned(epoch)) return false;
        if (task.providerId !== 'comfy-local' || task.id !== state.remotePending.input.taskId) throw problem('INVALID_RESPONSE');
        pendingRemoteTask = task;
        await observations.read(task.id, imageTaskReview(state, task));
        if (!owned(epoch)) return false;
        if (!state.selectedGroupId) emit({ selectedGroupId: task.groupId });
      }
      if (settingsReader) {
        try { const latest = safeImageSettings(await settingsReader()); if (!owned(epoch)) return false; emit({ settings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ settings: null, message: '暂时无法核验图像设置。付费生成已暂停，Mock 与已保存记录仍可使用。' }); }
      }
      if (customSettingsReader) {
        try { const latest = safeImageSettings(await customSettingsReader(), 'custom'); if (!owned(epoch)) return false; emit({ customSettings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ customSettings: null }); }
      }
      if (comfySettingsReader) {
        try { const latest = safeComfyImageSettings(await comfySettingsReader()); if (!owned(epoch)) return false; emit({ comfySettings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ comfySettings: null }); }
      }
      const groupInput = { projectId, limit: IMAGE_LIMITS.pageSize, ...(state.groupCursor ? { cursor: state.groupCursor } : {}) };
      const groups = safePage('image.group.list', groupInput, await call('image.group.list', groupInput));
      if (!owned(epoch)) return false;
      const selectedGroupId = state.selectedGroupId || groups.items[0]?.id || null;
      // An accepted group can be outside this page. Resolve it by identity rather
      // than switching to an unrelated first row and dropping its running task.
      for (const groupId of [state.target?.groupId].filter(id => id && id !== selectedGroupId)) if (!groups.items.some(group => group.id === groupId)) {
        const group = await call('image.group.get', { projectId, groupId });
        if (!isImageGroupResponse(group) || group.projectId !== projectId || group.id !== groupId) throw problem('INVALID_RESPONSE');
        groups.items.push(copy(group));
      }
      if (!owned(epoch)) return false;
      const changed = selectedGroupId !== state.selectedGroupId;
      const taskInput = { projectId, limit: IMAGE_LIMITS.pageSize, ...(selectedGroupId ? { groupId: selectedGroupId } : {}) };
      const versionInput = { projectId, groupId: selectedGroupId, limit: IMAGE_LIMITS.pageSize, ...(!changed && state.versionCursor ? { cursor: state.versionCursor } : {}) };
      const tasks = safePage('image.task.list', taskInput, await call('image.task.list', taskInput));
      if (pendingRemoteTask && !tasks.items.some(task => task.id === pendingRemoteTask.id)) tasks.items.push(copy(pendingRemoteTask));
      if (!owned(epoch)) return false;
      // Observe completion before reading its committed group/version data. A
      // parallel older empty version page must not stop polling after success.
      if (selectedGroupId) {
        const currentGroup = await call('image.group.get', { projectId, groupId: selectedGroupId });
        if (!isImageGroupResponse(currentGroup) || currentGroup.projectId !== projectId || currentGroup.id !== selectedGroupId) throw problem('INVALID_RESPONSE');
        const index = groups.items.findIndex(item => item.id === selectedGroupId);
        if (index < 0) groups.items.push(copy(currentGroup)); else groups.items[index] = copy(currentGroup);
        if (currentGroup.activeTaskId && !tasks.items.some(task => task.id === currentGroup.activeTaskId)) {
          const task = safeTask(await call('image.task.get', { projectId, taskId: currentGroup.activeTaskId }), projectId);
          if (task.id !== currentGroup.activeTaskId || task.groupId !== selectedGroupId) throw problem('INVALID_RESPONSE');
          tasks.items.push(task);
        }
      }
      if (!owned(epoch)) return false;
      const versions = selectedGroupId ? safePage('image.version.list', versionInput, await call('image.version.list', versionInput)) : { items: [], nextCursor: null };
      if (!owned(epoch)) return false;
      { // Retained review authority is readable even when current settings are unavailable.
        const input = { projectId, limit: IMAGE_LIMITS.pageSize, ...(state.reviewCursor ? { cursor: state.reviewCursor } : {}) };
        const page = await call('image.review.list', input);
        if (!owned(epoch)) return false;
        if (!isImageReviewListResponse(input, page)) throw problem('INVALID_RESPONSE');
        for (const review of page.items) mergeReview(review);
        const pendingReview = state.pending && page.items.find(review => review.requestId === state.pending.input.requestId && pendingMatchesReview(state.pending, review));
        if (pendingReview && !state.pending.reviewId) updatePending(state.pending, { ...state.pending, reviewId: pendingReview.id, ...(pendingReview.input.providerId === 'comfy-local' ? { execution: copy(pendingReview.execution) } : {}) });
        const pinned = state.reviews.find(item => item.id === state.pending?.reviewId);
        emit({ reviews: [...(pinned && !page.items.some(item => item.id === pinned.id) ? [pinned] : []), ...page.items.map(review => state.reviews.find(item => item.id === review.id))], nextReviewCursor: page.nextCursor });
      }
      if (!owned(epoch)) return false;
      for (const taskId of tracked.keys()) if (!tasks.items.some(task => task.id === taskId)) {
        const task = safeTask(await call('image.task.get', { projectId, taskId }), projectId);
        if (task.id !== taskId) throw problem('INVALID_RESPONSE');
        tasks.items.push(task);
      }
      if (!owned(epoch)) return false;
      for (const task of tasks.items.filter(item => item.providerId === 'comfy-local')) {
        try { await observations.read(task.id, imageTaskReview(state, task)); } catch { if (owned(epoch)) emit({ message: '暂时无法读取此任务的本地远端身份记录。没有查询 ComfyUI 或重新提交生成。' }); }
        if (!owned(epoch)) return false;
      }
      const monotonicTasks = tasks.items.map(task => newestTask(state.tasks.find(item => item.id === task.id), task));
      for (const version of versions.items) { const old = state.versions.find(item => item.id === version.id); if (old && canonicalImageInput(old) !== canonicalImageInput(version)) throw problem('INVALID_RESPONSE'); }
      emit({ groups: groups.items, nextGroupCursor: groups.nextCursor, selectedGroupId, tasks: monotonicTasks, versions: versions.items, nextVersionCursor: versions.nextCursor, ...(changed ? { versionCursor: null, versionTrail: [] } : {}), loaded: true, historyPhase: 'ready', phase: state.pending ? 'unknown' : 'ready' });
      for (const task of monotonicTasks) {
        if (ACTIVE.has(task.state)) tracked.set(task.id, task); else tracked.delete(task.id);
        if (task.state === 'succeeded' && !announced.has(task.id)) { announced.add(task.id); onGenerated(projectId, copy(task)); }
      }
      return true;
    } catch {
      if (owned(epoch)) emit({ historyPhase: 'read_error', phase: state.pending ? 'unknown' : 'read_error', message: state.pending ? '原请求的结果仍待确认。只会重新读取本地记录，不会自动重发。' : '暂时无法读取图像记录。草稿保留，可重新读取。' });
      return false;
    } finally { if (reading === epoch) reading = false; if (owned(epoch)) schedule(); }
  }
  async function dispatch(operation, input) {
    if (disposed || !visible || state.pending || state.storageBlocked || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId) return false;
    const pending = { version: 1, operation, input: copy(input) };
    try { savePending(pending); } catch { emit({ message: '无法保存本地请求凭据，本次尚未发送。请恢复页面存储后再试。' }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '', actionTaskId: input.taskId || null });
    try {
      const result = await call(operation, copy(input));
      if (disposed || state.pending !== pending) return false;
      if (!isImageMutationResponse(operation, input, result)) throw problem('INVALID_RESPONSE');
      mergeTask(safeTask(result, projectId));
      if (clearPending(pending)) emit({ phase: 'ready', ...(operation === 'image.generate' ? { draft: { name: '', prompt: '' }, target: null, selectedGroupId: result.groupId, groupCursor: null, groupTrail: [], versionCursor: null, versionTrail: [] } : {}), message: operation === 'image.generate' ? '请求已保存。Mock 仅生成确定性测试图案。' : '操作已确认。' });
    } catch (error) {
      if (disposed || state.pending !== pending) return false;
      // Only an operation-bound, authoritative rejection may release the intent.
      const rejected = await notAccepted(error, operation, input);
      if (disposed || state.pending !== pending) return false;
      if (rejected && clearPending(pending)) emit({ phase: 'ready', message: rejectionMessage(error.code) });
      else emit({ phase: 'unknown', message: '尚未确认原请求是否已接受。正在核对本地记录，不会重新生成。' });
    } finally {
      if (!disposed) { emit({ actionTaskId: null }); if (visible) await load(); }
    }
    return !state.pending;
  }
  function mergeReview(review) {
    if (!isImageReviewResponse(review) || review.projectId !== projectId) throw problem('INVALID_RESPONSE');
    const previous = state.reviews.find(item => item.id === review.id);
    if (previous && (reviewIdentity(previous) !== reviewIdentity(review) || previous.revision === review.revision && canonicalImageInput(previous) !== canonicalImageInput(review))) throw problem('INVALID_RESPONSE');
    const next = previous?.revision > review.revision ? previous : copy(review);
    emit({ reviews: [next, ...state.reviews.filter(item => item.id !== next.id)].slice(0, IMAGE_LIMITS.maxPageSize) }); return next;
  }
  function reviewUsable(review) { return review?.projectId === projectId && imageReviewCanApprove(state, review); }
  async function approveSaved(review, pending) {
    if (disposed || !visible || state.pending !== pending || !reviewUsable(review) || !pendingMatchesReview(pending, review)) return false;
    const next = { ...pending, reviewId: review.id, approvalAttempted: true };
    if (!updatePending(pending, next)) return false;
    emit({ phase: 'submitting', reviewActionId: review.id, message: '' });
    try {
      const result = await reviewClient.approve(copy(review));
      if (disposed || state.pending !== next) return false;
      if (!isImageMutationResponse('image.generate', next.input, result)) throw problem('INVALID_RESPONSE');
      mergeTask(safeTask(result, projectId));
      if (clearPending(next)) emit({ phase: 'ready', ...(!next.preserveDraft ? { draft: { name: '', prompt: '' }, target: null } : {}), selectedGroupId: result.groupId, groupCursor: null, groupTrail: [], versionCursor: null, versionTrail: [], message: review.input.providerId === 'comfy-local' ? '本地运行请求已保存。最多提交一次；关闭面板不会取消远端 GPU 工作。' : '付费请求已保存。最多发送一次，不会自动重试。' });
    } catch {
      if (!disposed && state.pending === next) emit({ phase: 'unknown', message: review.input.providerId === 'comfy-local' ? '尚未确认本地运行审批结果。只读取原请求，不会自动重新批准、提交或查询远端。' : '尚未确认付费审批结果。只会读取原请求，不会自动重新批准或生成。' });
    } finally { if (!disposed) { emit({ reviewActionId: null }); if (visible) await load(); } }
    return !state.pending;
  }
  async function generatePaid(authorization) {
    if (disposed || !visible || !paidProvider(state.providerId) || !imageCanGenerate(state)) return false;
    if (authorization !== undefined && canonicalImageInput(authorization) !== canonicalImageInput(imagePaidAuthorization(state))) { emit({ message: '描述或连接配置已变化。请核对当前完整地址、模型与配置版本后重新点击付费生成。' }); return false; }
    const selected = imageSelectedSettings(state), custom = state.providerId === 'openai-compatible';
    const input = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: state.providerId, model: selected.configuration.model, options: { ...IMAGE_FIXED_OPTIONS }, requestId: requestId(), ...(state.target || {}) };
    if (!imageSchemas['image.generate'].safeParse(input).success) return false;
    const pending = { version: custom ? 2 : 1, operation: 'image.generate', input, settingsRevision: selected.revision, reviewId: null, approvalAttempted: false, ...(custom ? { configuration: copy(selected.configuration), destination: getCustomImageDestination(selected.configuration.baseUrl) } : {}) }, interaction = interactionEpoch;
    try { savePending(pending); } catch { emit({ message: '无法保存原始付费请求，本次尚未发送。' }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '' });
    try {
      const prepareInput = { input: copy(input), settingsRevision: pending.settingsRevision };
      const review = await call('image.review.prepare', prepareInput);
      if (disposed || state.pending !== pending) return false;
      if (!isImageReviewPreparationResponse(prepareInput, review) || !pendingMatchesReview(pending, review) || review.state !== 'pending') throw problem('INVALID_RESPONSE');
      mergeReview(review);
      const next = { ...pending, reviewId: review.id };
      if (!updatePending(pending, next)) return false;
      if (!visible || interactionEpoch !== interaction || !reviewUsable(review)) { emit({ phase: 'unknown', message: '审批内容已保存。页面或配置已变化，请回到原请求并重新明确批准；不会自动发送。' }); return false; }
      return await approveSaved(review, next);
    } catch { if (!disposed) emit({ phase: 'unknown', message: '审批准备结果待核对。尚未发起付费审批，不会自动重试。' }); return false; }
    finally { if (!disposed && state.phase === 'submitting') emit({ phase: 'unknown' }); if (!disposed && visible && !state.reviewActionId) await load(); }
  }
  async function prepareComfy() {
    if (disposed || !visible || state.providerId !== 'comfy-local' || !imageCanGenerate(state)) return false;
    const selected = state.comfySettings;
    const input = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: 'comfy-local', model: selected.configuration.model, options: { ...COMFY_IMAGE_OPTIONS }, requestId: requestId(), ...(state.target || {}) };
    if (!imageSchemas['image.generate'].safeParse(input).success) return false;
    const pending = { version: 3, operation: 'image.generate', input, settingsRevision: selected.revision, reviewId: null, approvalAttempted: false, configuration: copy(selected.configuration), destination: getComfyImageDestination(selected.configuration.baseUrl), execution: null };
    try { savePending(pending); } catch { emit({ message: '无法保存本地运行请求凭据，没有准备或发送生成。' }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '' });
    try {
      const prepareInput = { input: copy(input), settingsRevision: pending.settingsRevision };
      const review = await call('image.review.prepare', prepareInput);
      if (disposed || state.pending !== pending) return false;
      if (!isImageReviewPreparationResponse(prepareInput, review) || !pendingMatchesReview(pending, review) || review.state !== 'pending') throw problem('INVALID_RESPONSE');
      mergeReview(review);
      if (!updatePending(pending, { ...pending, reviewId: review.id, execution: copy(review.execution) })) return false;
      emit({ phase: 'unknown', message: '本地运行请求已准备。请核对下方实际地址、种子和完整冻结工作流，再单独批准；目前未发送生成。' }); return true;
    } catch { if (!disposed) emit({ phase: 'unknown', message: '准备结果待核对。尚未批准运行，不会自动重试。请重新读取已保存审批。' }); return false; }
    finally { if (!disposed && state.phase === 'submitting') emit({ phase: 'unknown' }); if (!disposed && visible) await load(); }
  }
  async function chooseTarget(groupId) {
    if (disposed || !visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || reading || state.phase === 'targeting') return false;
    const group = groupId ? state.groups.find(item => item.id === groupId) : null;
    if (groupId && (!group || group.activeTaskId)) return false;
    if (!groupId) { emit({ target: null, targetRequest: null, draft: { name: '', prompt: '' }, message: '' }); return true; }
    const epoch = ++selectionEpoch; let reloadHistory = false;
    emit({ phase: 'targeting', targetRequest: null }); stopTimer();
    try {
      const input = { projectId, groupId, limit: 1 };
      const page = safePage('image.version.list', input, await call('image.version.list', input));
      let task = null;
      if (page.items[0]) task = safeTask(await call('image.task.get', { projectId, taskId: page.items[0].taskId }), projectId);
      if (disposed || selectionEpoch !== epoch || !visible) return false;
      if (task && task.groupId !== groupId) throw problem('INVALID_RESPONSE');
      reloadHistory = state.selectedGroupId !== groupId || state.versionCursor !== null;
      emit({ draft: { name: group.name, prompt: task?.prompt || '' }, target: { groupId, expectedRevision: group.revision }, selectedGroupId: groupId, versionCursor: null, versionTrail: [], message: '已载入历史描述。修改后点击生成，才会创建此组的新版本。' });
      return true;
    } catch { if (!disposed && selectionEpoch === epoch) emit({ message: '无法读取此组的原始描述，未改变草稿。' }); return false; }
    finally { if (!disposed && selectionEpoch === epoch) { emit({ phase: state.pending ? 'unknown' : 'ready' }); if (reloadHistory && visible) await load(); else schedule(); } }
  }
  return {
    getState: () => copy(state), load, generatePaid, prepareComfy,
    setSettings(value) { if (disposed) return false; const settings = safeImageSettings(value); if (canonicalImageInput(state.settings) !== canonicalImageInput(settings)) interactionEpoch++; emit({ settings }); return true; },
    setCustomSettings(value) { if (disposed) return false; const customSettings = safeImageSettings(value, 'custom'); if (canonicalImageInput(state.customSettings) !== canonicalImageInput(customSettings)) interactionEpoch++; emit({ customSettings }); return true; },
    setComfySettings(value) { if (disposed) return false; const comfySettings = safeComfyImageSettings(value); if (canonicalImageInput(state.comfySettings) !== canonicalImageInput(comfySettings)) interactionEpoch++; emit({ comfySettings }); return true; },
    selectProvider(providerId) { if (disposed || !visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || !['mock', 'openai', 'openai-compatible', 'comfy-local'].includes(providerId)) return false; interactionEpoch++; emit({ providerId }); return true; },
    async approveReview(review) {
      if (disposed || !visible || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || !reviewUsable(review) || !state.reviews.some(item => item.id === review.id && canonicalImageInput(item) === canonicalImageInput(review))) return false;
      if (state.pending && (state.pending.reviewId !== review.id || !pendingMatchesReview(state.pending, review))) return false;
      let pending = state.pending;
      if (!pending) {
        pending = { version: review.input.providerId === 'comfy-local' ? 3 : review.input.providerId === 'openai-compatible' ? 2 : 1, operation: 'image.generate', input: copy(review.input), settingsRevision: review.settingsRevision, reviewId: review.id, approvalAttempted: false, preserveDraft: true, ...(['openai-compatible', 'comfy-local'].includes(review.input.providerId) ? { configuration: copy(review.configuration), destination: review.destination } : {}), ...(review.input.providerId === 'comfy-local' ? { execution: copy(review.execution) } : {}) };
        try { savePending(pending); } catch { emit({ message: '无法保存原始审批请求，本次未发送。' }); return false; }
        emit({ pending });
      }
      stopTimer(); readEpoch++; reading = false;
      return approveSaved(review, pending);
    },
    async rejectReview(review) {
      if (disposed || !visible || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || review.state !== 'pending' || !state.reviews.some(item => item.id === review.id && canonicalImageInput(item) === canonicalImageInput(review))) return false;
      stopTimer(); readEpoch++; reading = false; emit({ reviewActionId: review.id });
      try {
        const result = await reviewClient.reject(copy(review));
        if (disposed) return false;
        if (!isImageReviewResponse(result) || result.id !== review.id || reviewIdentity(result) !== reviewIdentity(review) || result.state !== 'rejected') throw problem('INVALID_RESPONSE');
        mergeReview(result);
        if (state.pending?.reviewId === result.id) clearPending(state.pending);
        emit({ phase: state.pending ? 'unknown' : 'ready', message: '已拒绝此原始请求，不会生成图像。' }); return true;
      } catch { if (!disposed) emit({ message: '拒绝结果待确认。只会重新读取，不会自动重试。' }); return false; }
      finally { if (!disposed) { emit({ reviewActionId: null }); if (visible) await load(); } }
    },
    abandonUnapproved() {
      const pending = state.pending;
      if (disposed || !visible || state.phase === 'submitting' || state.reviewActionId || !pending || !reviewedProvider(pending.input.providerId) || pending.approvalAttempted || pending.reviewId) return false;
      if (clearPending(pending)) { emit({ phase: 'ready', message: '已放弃本页尚未批准的请求。若准备记录随后出现，仍需明确批准或拒绝。' }); return true; } return false;
    },
    edit(field, value) { if (!disposed && visible && !state.pending && !state.remotePending && !state.remoteActionTaskId && !state.actionTaskId && !state.reviewActionId && state.phase !== 'targeting' && ['name', 'prompt'].includes(field) && !(field === 'name' && state.target)) { emit({ draft: { ...state.draft, [field]: value }, targetRequest: null }); return true; } return false; },
    async generate() {
      if (!visible || state.providerId !== 'mock' || !imageCanGenerate(state)) return false;
      const input = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, requestId: requestId(), ...(state.target || {}) };
      if (!imageSchemas['image.generate'].safeParse(input).success) return false;
      return dispatch('image.generate', input);
    },
    async act(action, task) {
      if (!visible || !task || !state.tasks.some(item => item.id === task.id && item.revision === task.revision) || state.pending || state.actionTaskId || state.reviewActionId) return false;
      task = state.tasks.find(item => item.id === task.id);
      if (action === 'cancelQueued' ? !CANCELABLE.has(task.state) || task.dispatched : action !== 'recoverResult' || !['local_result_error', 'outcome_unknown'].includes(task.state)) return false;
      return dispatch(`image.task.${action}`, { projectId, taskId: task.id, expectedRevision: task.revision, requestId: requestId() });
    },
    async observeRemote(task) {
      if (disposed || !visible || reading || state.pending || state.actionTaskId || state.reviewActionId || !state.tasks.some(item => item.id === task?.id && canonicalImageInput(item) === canonicalImageInput(task)) || !comfyCanObserve(state, task)) return false;
      stopTimer(); readEpoch++; reading = false;
      const accepted = await observations.observe(task);
      if (!disposed && visible) await load();
      return accepted;
    },
    requestTarget(groupId = null) { if (!visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId) return false; if (imageDraftDirty(state)) { emit({ targetRequest: { groupId } }); return false; } return chooseTarget(groupId); },
    confirmTarget() { if (!state.targetRequest) return false; return chooseTarget(state.targetRequest.groupId); },
    keepDraft() { emit({ targetRequest: null }); },
    async selectGroup(groupId) { if (!visible || state.remotePending || state.remoteActionTaskId || reading || !state.groups.some(group => group.id === groupId)) return false; emit({ selectedGroupId: groupId, versionCursor: null, versionTrail: [] }); return load(); },
    async pageGroups(older) { if (!visible || state.remotePending || state.remoteActionTaskId || reading || (older ? !state.nextGroupCursor : !state.groupTrail.length)) return false; const trail = [...state.groupTrail], cursor = older ? state.nextGroupCursor : trail.pop(); if (older) trail.push(state.groupCursor); emit({ groupCursor: cursor, groupTrail: trail, selectedGroupId: null, versionCursor: null, versionTrail: [] }); return load(); },
    async pageVersions(older) { if (!visible || state.remotePending || state.remoteActionTaskId || reading || (older ? !state.nextVersionCursor : !state.versionTrail.length)) return false; const trail = [...state.versionTrail], cursor = older ? state.nextVersionCursor : trail.pop(); if (older) trail.push(state.versionCursor); emit({ versionCursor: cursor, versionTrail: trail }); return load(); },
    async pageReviews(older) { if (!visible || reading || state.reviewActionId || (older ? !state.nextReviewCursor : !state.reviewTrail.length)) return false; const trail = [...state.reviewTrail], cursor = older ? state.nextReviewCursor : trail.pop(); if (older) trail.push(state.reviewCursor); emit({ reviewCursor: cursor, reviewTrail: trail }); return load(); },
    setVisible(value) { if (disposed) return; const changed = visible !== Boolean(value); visible = Boolean(value); observations.setVisible(visible); if (changed) interactionEpoch++; if (!visible) { stopTimer(); selectionEpoch++; if (state.phase === 'targeting') emit({ phase: 'ready' }); } else if (changed) { polls = 0; void load(); } },
    dispose() { observations.dispose(); disposed = true; readEpoch++; selectionEpoch++; interactionEpoch++; stopTimer(); for (const controller of calls) controller.abort(); },
  };
}
