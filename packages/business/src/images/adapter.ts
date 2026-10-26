import {IMAGE_NETWORK_LIMITS, createImageGenerationParameters, createImageEditParameters, validateImageEditSource, createCompatibleImageGenerationParameters, imageAdapterError, parseImageAdapterInput} from './profiles.ts';
import type {ImageAdapterInput} from './profiles.ts';
import {renderMockImagePng, validatePng} from './png.ts';
import type {PngMetadata} from './png.ts';
import {requestImageWithSdk} from './sdk.ts';
import type {ImageSdkParameters, ImageSdkPost} from './sdk.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> | null => object(value) ? value : null;
const codeOf = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
function abortIfNeeded(signal: AbortSignal | undefined, dispatched = false): void {
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED', {dispatched});
}
function fence(beforeDispatch: unknown): void {
  if (typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_DISPATCH_BLOCKED');
  try {
    const value = (beforeDispatch as () => unknown)();
    if (value && typeof (value as {then?: unknown}).then === 'function') { Promise.resolve(value).catch(() => {}); throw imageAdapterError('IMAGE_DISPATCH_BLOCKED'); }
  } catch { throw imageAdapterError('IMAGE_DISPATCH_BLOCKED'); }
}
function allowedKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).every(key => keys.includes(key)); }

// JSON.parse accepts duplicate keys and unbounded object depth. Preflight token
// structure before parsing, skipping string contents rather than regex-matching
// JSON, to bound objects and reject duplicate keys including escaped spellings.
function preflightJson(text: string): void {
  const stack: (Set<unknown> | null)[] = []; let containers = 0, keys = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{' || char === '[') {
      if (++containers > 128 || stack.length >= 8) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      stack.push(char === '{' ? new Set() : null);
    } else if (char === '}' || char === ']') {
      if (!stack.length) throw imageAdapterError('IMAGE_RESPONSE_INVALID'); stack.pop();
    } else if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === '"') break; }
      let next = i + 1; while (next < text.length && /[ \t\r\n]/.test(text[next]!)) next++;
      if (text[next] !== ':') continue;
      const current = stack.at(-1);
      if (!current || ++keys > 256 || i - start > 200) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      let key: unknown; try { key = JSON.parse(text.slice(start, i + 1)); } catch { throw imageAdapterError('IMAGE_RESPONSE_INVALID'); }
      if (current.has(key)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      current.add(key);
    }
  }
  if (stack.length) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
}
export function decodeImageBase64(value: unknown): Buffer {
  const maximum = IMAGE_NETWORK_LIMITS.maxDecodedBytes;
  if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > Math.ceil(maximum / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.indexOf('=') !== (padding ? value.length - padding : -1)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  if (value.length / 4 * 3 - padding > maximum) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  return bytes;
}
function usageMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  const scalarKeys = ['input_tokens', 'output_tokens', 'total_tokens'], detailKeys = ['input_tokens_details', 'output_tokens_details'];
  if (!allowedKeys(value, [...scalarKeys, ...detailKeys])) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const result: Record<string, unknown> = {};
  for (const key of scalarKeys) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0 || entry > 1_000_000_000) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    result[key] = entry;
  }
  for (const key of detailKeys) {
    const detail = value[key];
    if (detail === undefined) continue;
    if (!allowedKeys(detail, ['image_tokens', 'text_tokens'])) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    const tokens: Record<string, unknown> = {};
    result[key] = tokens;
    for (const field of ['image_tokens', 'text_tokens']) {
      const count = detail[field];
      if (count === undefined) continue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      tokens[field] = count;
    }
  }
  return result;
}
export interface ImageAdapterResult {bytes: Buffer; metadata: PngMetadata & {isMock: boolean; providerRequestId: string | null; usage: Record<string, unknown> | null}}
export interface ImageAdapterGenerateContext {signal?: AbortSignal; beforeDispatch?: unknown; sourceBytes?: unknown}
export async function decodeImageJsonResponse(body: unknown, {signal, providerRequestId = null}: {signal?: AbortSignal; providerRequestId?: unknown} = {}): Promise<ImageAdapterResult> {
  abortIfNeeded(signal);
  if (!Buffer.isBuffer(body) || !body.length || body.length > IMAGE_NETWORK_LIMITS.maxResponseBytes) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE');
  let json: Record<string, unknown>;
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(body);
    preflightJson(text);
    const parsed: unknown = JSON.parse(text);
    if (!allowedKeys(parsed, ['created', 'data', 'background', 'output_format', 'quality', 'size', 'usage'])) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    json = parsed;
  } catch { throw imageAdapterError('IMAGE_RESPONSE_INVALID'); }
  if (!Array.isArray(json.data) || json.data.length !== 1) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const data: readonly unknown[] = json.data, entry = data[0];
  if (!allowedKeys(entry, ['b64_json']) || !Object.hasOwn(entry, 'b64_json')) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  if ((json.created !== undefined && (typeof json.created !== 'number' || !Number.isSafeInteger(json.created) || json.created < 0)) || (json.background !== undefined && json.background !== 'opaque') || (json.output_format !== undefined && json.output_format !== 'png') || (json.quality !== undefined && json.quality !== 'low') || (json.size !== undefined && json.size !== '1024x1024')) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const usage = usageMetadata(json.usage), bytes = decodeImageBase64(entry.b64_json);
  const metadata = await validatePng(bytes, {signal});
  abortIfNeeded(signal);
  const requestId = typeof providerRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(providerRequestId) ? providerRequestId : null;
  return {bytes, metadata: {...metadata, isMock: false, providerRequestId: requestId, usage}};
}
const isEdit = (snapshot: unknown): boolean => object(snapshot) && snapshot.purpose === 'edit';
export function createMockImageAdapter() {
  return Object.freeze({
    async generate(snapshot: unknown, {signal, beforeDispatch, sourceBytes}: ImageAdapterGenerateContext = {}): Promise<ImageAdapterResult> {
      const input = parseImageAdapterInput(snapshot, 'mock'); abortIfNeeded(signal);
      if (isEdit(input)) await validateImageEditSource(input, sourceBytes, {signal, providerId: 'mock'});
      else if (sourceBytes !== undefined) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      abortIfNeeded(signal); fence(beforeDispatch);
      try {
        abortIfNeeded(signal, true);
        const bytes = await renderMockImagePng({signal});
        const metadata = await validatePng(bytes, {signal});
        abortIfNeeded(signal, true);
        return {bytes, metadata: {...metadata, isMock: true, providerRequestId: null, usage: null}};
      } catch (error) {
        // The durable host fence advanced, although Mock has no remote outcome.
        throw imageAdapterError(codeOf(error), {dispatched: true, outcomeUnknown: false});
      }
    },
  });
}
// Shared lifecycle and decoder for the two explicitly constructed live slots.
function createSdkImageAdapter({transport, baseUrl}: {transport?: unknown; baseUrl?: unknown}, compatible: boolean, prepare: (snapshot: unknown, context: {signal?: AbortSignal; sourceBytes?: unknown}) => ImageSdkParameters | Promise<ImageSdkParameters>) {
  const post = transport as ImageSdkPost | undefined;
  return Object.freeze({
    async generate(snapshot: unknown, {signal, beforeDispatch, sourceBytes}: ImageAdapterGenerateContext = {}): Promise<ImageAdapterResult> {
      if (typeof post !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
      const call = await prepare(snapshot, {signal, sourceBytes}); abortIfNeeded(signal);
      if (typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_DISPATCH_BLOCKED');
      let fenced = false, received = false;
      try {
        const response = await requestImageWithSdk(call, {post, baseUrl, compatible, signal, beforeDispatch: () => {
          if (fenced) throw imageAdapterError('IMAGE_DISPATCH_BLOCKED');
          abortIfNeeded(signal); fence(beforeDispatch); fenced = true;
        }});
        received = fenced;
        if (!fenced || response?.dispatched !== true) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
        abortIfNeeded(signal, true);
        return await decodeImageJsonResponse(response.body, {signal, providerRequestId: response.providerRequestId});
      } catch (error) {
        // Decoder failures carry local flags. Once a response exists, never let
        // those flags erase the upstream dispatch or imply a safe automatic retry.
        const source = record(error), flag = source?.dispatched;
        const dispatched = received || fenced || flag === true;
        throw imageAdapterError(codeOf(error), {dispatched, outcomeUnknown: dispatched});
      }
    },
  });
}

/** No ambient credential/network discovery. Only a trusted reviewed Images
 * gateway supplies a transport pinned to that slot's reviewed destination. */
function generationOnly(createParameters: typeof createImageGenerationParameters, snapshot: unknown, {sourceBytes}: {sourceBytes?: unknown} = {}): ImageSdkParameters {
  if (sourceBytes !== undefined) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  return {kind: 'generate', parameters: createParameters(snapshot)};
}
export function createOpenAIImageAdapter(options: {transport?: unknown} = {}) {
  return createSdkImageAdapter(options, false, async (snapshot, {signal, sourceBytes}) => isEdit(snapshot)
    ? {kind: 'edit', parameters: await createImageEditParameters(snapshot, sourceBytes, {signal})} : generationOnly(createImageGenerationParameters, snapshot, {sourceBytes}));
}
export function createCompatibleImageAdapter(options: {transport?: unknown; baseUrl?: unknown} = {}) {
  return createSdkImageAdapter(options, true, (snapshot, context) => generationOnly(createCompatibleImageGenerationParameters, snapshot, context));
}
export type ImageAdapter = ReturnType<typeof createOpenAIImageAdapter>;
export type MockImageAdapter = ReturnType<typeof createMockImageAdapter>;
