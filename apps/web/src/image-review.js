import { ApiError } from './api.js';
import { canonicalImageInput, isImageMutationResponse, isImageReviewResponse } from '@mioon/contracts';

const failure = () => new ApiError('图像审批请求未确认。', 'NETWORK');
export const imageReviewIdentity = review => canonicalImageInput(Object.fromEntries(['id', 'projectId', 'requestId', 'input', 'inputHash', 'settingsRevision', 'destination', 'policy', 'createdAt', ...(['openai-compatible', 'comfy-local'].includes(review.input.providerId) ? ['configuration'] : []), ...(review.input.providerId === 'comfy-local' ? ['execution'] : [])].map(key => [key, review[key]])));
const codes = new Set(['UNAUTHORIZED', 'IMAGE_REVIEW_CONFLICT', 'IMAGE_REVIEW_SETTINGS_CHANGED', 'IMAGE_REVIEW_REJECTED', 'IMAGE_REVIEW_REQUIRED', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_APPROVAL_REQUIRED', 'IMAGE_REQUEST_CONFLICT', 'IMAGE_GROUP_BUSY', 'IMAGE_REVISION_CONFLICT', 'IMAGE_QUEUE_FULL', 'IMAGE_CAPACITY', 'IMAGE_REVIEW_STATE_CONFLICT']);
/** Private authenticated UI endpoints. They are never RPC/CLI/MCP capabilities. */
export function createImageReviewClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15000 } = {}) {
  async function request(action, review, { signal } = {}) {
    if (!isImageReviewResponse(review) || review.state !== 'pending') throw failure();
    const controller = new AbortController(); let timer;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const input = { projectId: review.projectId, reviewId: review.id, expectedRevision: review.revision };
    const transport = (async () => {
      const response = await fetchImpl(`/api/images/reviews/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      let envelope; try { envelope = await response.json(); } catch { throw failure(); }
      if (!response.ok || envelope?.ok !== true) {
        const code = response.status === 401 ? 'UNAUTHORIZED' : codes.has(envelope?.error?.code) ? envelope.error.code : 'NETWORK';
        // Do not retain arbitrary server messages or details in renderer state.
        throw new ApiError('图像审批请求未确认。', code, undefined, response.status >= 400 && response.status < 500);
      }
      if (action === 'approve' ? !isImageMutationResponse('image.generate', review.input, envelope.data) : !isImageReviewResponse(envelope.data) || imageReviewIdentity(envelope.data) !== imageReviewIdentity(review) || envelope.data.state !== 'rejected' || envelope.data.revision !== review.revision + 1 || envelope.data.taskId !== null) throw failure();
      return structuredClone(envelope.data);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); })]) : await transport; }
    catch (error) { if (error instanceof ApiError) throw error; throw failure(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return { approve: (review, options) => request('approve', review, options), reject: (review, options) => request('reject', review, options) };
}
