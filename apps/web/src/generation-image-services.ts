import {projectApiPath} from '../../../packages/contracts/src/project-file.ts';
import {generationImageServiceSchemas, isGenerationImageServiceResponse, generationImageServiceListResponseSchema} from '../../../packages/contracts/src/generation-image-services.ts';
import type {GenerationImageServiceOperation} from '../../../packages/contracts/src/generation-image-services.ts';
import type {ImageReviewResponse} from '../../../packages/contracts/src/image-reviews.ts';
import type {CustomImageConnectionV2} from '../../../packages/contracts/src/generation-image-settings.ts';
import {OUTPUT_LOCALE_HEADER} from '../../../packages/contracts/src/output-locale.ts';
import type {Locale} from '../../../packages/i18n/src/types.ts';
export type CustomImageServicePreparation = ReturnType<typeof generationImageServiceSchemas['image.service.review.prepare']['parse']>;
export interface GenerationImageServicesClient {
  list(projectId: string, signal?: AbortSignal): Promise<CustomImageConnectionV2[]>;
  prepare(input: CustomImageServicePreparation, signal?: AbortSignal, outputLocale?: Locale): Promise<ImageReviewResponse>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code = 'NETWORK') => Object.assign(new Error('Image service request could not be confirmed.'), {code});
/** Dedicated web endpoint; none of these operations enters RPC or the Mio tool catalog. */
export function createGenerationImageServicesClient({fetchImpl = globalThis.fetch, timeoutMs = 15000}: {fetchImpl?: typeof fetch; timeoutMs?: number} = {}): GenerationImageServicesClient {
  async function request(operation: GenerationImageServiceOperation, input: unknown, signal?: AbortSignal, outputLocale?: Locale): Promise<unknown> {
    const parsed = generationImageServiceSchemas[operation].safeParse(input); if (!parsed.success) throw failure('IMAGE_SETTINGS_VALIDATION');
    const projectId = operation === 'image.service.list' ? (parsed.data as {projectId: string}).projectId : (parsed.data as CustomImageServicePreparation).input.projectId;
    const controller = new AbortController(), abort = () => controller.abort(); let timer: ReturnType<typeof setTimeout> | undefined;
    signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) controller.abort();
    const transport = (async () => {
      const response = await fetchImpl(projectApiPath(projectId, 'images', 'services'), {method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: {'Content-Type': 'application/json', ...(outputLocale ? {[OUTPUT_LOCALE_HEADER]: outputLocale} : {})}, body: JSON.stringify({operation, input: parsed.data})});
      const body: unknown = await response.json();
      if (!record(body) || body.ok !== true || !response.ok) {const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : 'NETWORK'; throw failure(response.status === 401 ? 'UNAUTHORIZED' : /^(?:IMAGE_|REQUEST_)[A-Z_]+$/.test(code) ? code : 'NETWORK');}
      if (!isGenerationImageServiceResponse(operation, parsed.data, body.data)) throw failure('INVALID_RESPONSE'); return structuredClone(body.data);
    })();
    try {return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(failure());}, timeoutMs);})]) : await transport;}
    finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
  }
  return {async list(projectId, signal) {return generationImageServiceListResponseSchema.parse(await request('image.service.list', {projectId}, signal)).items;},
    async prepare(input, signal, outputLocale) {return await request('image.service.review.prepare', input, signal, outputLocale) as ImageReviewResponse;}};
}
