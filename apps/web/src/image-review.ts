import { ApiError } from './api.ts';
import { canonicalImageInput, isImageMutationResponse, isImageReviewResponse } from '@mioon/contracts';
import type { ImageReviewResponse } from '@mioon/contracts';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const failure = (): ApiError => new ApiError('图像审批请求未确认。', 'NETWORK');
export interface ImageReviewIdentityView { input: { providerId?: unknown; [key: string]: unknown }; [key: string]: unknown }
export interface ImageReviewClientOptions { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; timeoutMs?: number }
export interface ImageReviewRequestOptions { signal?: AbortSignal }
export interface ImageReviewClient {
  approve: (review: unknown, options?: ImageReviewRequestOptions) => Promise<unknown>;
  reject: (review: unknown, options?: ImageReviewRequestOptions) => Promise<unknown>;
}
export const imageReviewIdentity = (review: ImageReviewIdentityView): string => canonicalImageInput(Object.fromEntries(['id', 'projectId', 'requestId', 'input', 'inputHash', 'settingsRevision', 'destination', 'policy', 'sourceImage', 'createdAt', ...(['openai-compatible', 'comfy-local'].includes(review.input.providerId as string) ? ['configuration'] : []), ...(review.input.providerId === 'comfy-local' ? ['execution'] : [])].map(key => [key, review[key]])));
const codes = new Set(['UNAUTHORIZED', 'IMAGE_REVIEW_CONFLICT', 'IMAGE_REVIEW_SETTINGS_CHANGED', 'IMAGE_REVIEW_REJECTED', 'IMAGE_REVIEW_REQUIRED', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_APPROVAL_REQUIRED', 'IMAGE_REQUEST_CONFLICT', 'IMAGE_GROUP_BUSY', 'IMAGE_REVISION_CONFLICT', 'IMAGE_QUEUE_FULL', 'IMAGE_CAPACITY', 'IMAGE_REVIEW_STATE_CONFLICT', 'IMAGE_SOURCE_INVALID']);
/** Private authenticated UI endpoints. They are never RPC/CLI/MCP capabilities. */
export function createImageReviewClient({ fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), timeoutMs = 15000 }: ImageReviewClientOptions = {}): ImageReviewClient {
  async function request(action: 'approve' | 'reject', review: unknown, { signal }: ImageReviewRequestOptions = {}): Promise<unknown> {
    if (!isImageReviewResponse(review) || review.state !== 'pending') throw failure();
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const input = { projectId: review.projectId, reviewId: review.id, expectedRevision: review.revision };
    const transport = (async () => {
      const response = await fetchImpl(`/api/images/reviews/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      let envelope: unknown; try { envelope = await response.json(); } catch { throw failure(); }
      const envelopeRecord = isRecord(envelope) ? envelope : {}, errorRecord = isRecord(envelopeRecord.error) ? envelopeRecord.error : {};
      if (!response.ok || envelopeRecord.ok !== true) {
        const code = response.status === 401 ? 'UNAUTHORIZED' : typeof errorRecord.code === 'string' && codes.has(errorRecord.code) ? errorRecord.code : 'NETWORK';
        // Do not retain arbitrary server messages or details in renderer state.
        throw new ApiError('图像审批请求未确认。', code, undefined, response.status >= 400 && response.status < 500);
      }
      const data = envelopeRecord.data;
      if (action === 'approve' ? !isImageMutationResponse('image.generate', review.input, data) || canonicalImageInput((data as { sourceImage?: unknown }).sourceImage) !== canonicalImageInput((review as unknown as { sourceImage?: unknown }).sourceImage) : !isImageReviewResponse(data) || imageReviewIdentity(data as unknown as ImageReviewIdentityView) !== imageReviewIdentity(review as unknown as ImageReviewIdentityView) || data.state !== 'rejected' || data.revision !== review.revision + 1 || data.taskId !== null) throw failure();
      return structuredClone(data);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); })]) : await transport; }
    catch (error) { if (error instanceof ApiError) throw error; throw failure(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return { approve: (review: unknown, options?: ImageReviewRequestOptions) => request('approve', review, options), reject: (review: unknown, options?: ImageReviewRequestOptions) => request('reject', review, options) };
}
