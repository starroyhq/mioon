import {createHash} from 'node:crypto';
import OpenAI from 'openai';
import type {ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming} from 'openai/resources/images';
import {getCustomImageDestination} from '../../../contracts/src/image-settings.ts';
import {IMAGE_EDIT_LIMITS} from '../../../contracts/src/images.ts';
import {IMAGE_EDIT_ENDPOINT, IMAGE_EDIT_NETWORK_LIMITS, IMAGE_GENERATION_ENDPOINT, IMAGE_NETWORK_LIMITS, imageAdapterError} from './profiles.ts';
import type {ImageTransportRequest, ImageTransportResponse} from './network.ts';

export type ImageSdkParameters = {kind: 'generate'; parameters: ImageGenerateParamsNonStreaming} | {kind: 'edit'; parameters: ImageEditParamsNonStreaming};
export type ImageSdkPost = (request: ImageTransportRequest) => Promise<ImageTransportResponse>;
interface ImageSdkRequestContext {post: ImageSdkPost; signal?: AbortSignal; beforeDispatch: () => void; baseUrl?: unknown; compatible?: boolean}

function abortIfNeeded(signal?: AbortSignal): void { if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED'); }
function destination(call: ImageSdkParameters, {baseUrl, compatible}: Pick<ImageSdkRequestContext, 'baseUrl' | 'compatible'>): {baseURL: string; endpoint: string} {
  if (!compatible) return {baseURL: 'https://api.openai.com/v1', endpoint: call.kind === 'edit' ? IMAGE_EDIT_ENDPOINT : IMAGE_GENERATION_ENDPOINT};
  if (call.kind !== 'generate' || typeof baseUrl !== 'string') throw imageAdapterError('IMAGE_INVALID_REQUEST');
  try { return {baseURL: baseUrl, endpoint: getCustomImageDestination(baseUrl)}; }
  catch { throw imageAdapterError('IMAGE_INVALID_REQUEST'); }
}
async function multipartPayload(body: unknown, parameters: ImageEditParamsNonStreaming, signal?: AbortSignal): Promise<{body: Buffer; contentType: string}> {
  if (!(body instanceof FormData) || !(parameters.image instanceof File) || !parameters.image.size || parameters.image.size > IMAGE_EDIT_LIMITS.sourceBytes) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  const expected = new Map<string, string | File>(Object.entries(parameters).map(([name, value]) => [name, value instanceof File ? value : String(value)]));
  let size = 0;
  for (const [name, value] of body.entries()) {
    abortIfNeeded(signal);
    const original = expected.get(name);
    if (original === undefined) throw imageAdapterError('IMAGE_INVALID_REQUEST');
    expected.delete(name);
    if (typeof value === 'string') {
      if (value !== original) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      size += Buffer.byteLength(value);
    } else {
      if (!(original instanceof File) || !/^source\.(png|jpg|webp)$/.test(original.name) || value.name !== original.name || value.type !== original.type || value.size !== original.size) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      size += value.size;
      if (size > IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      const hash = (bytes: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      if (hash(await value.arrayBuffer()) !== hash(await original.arrayBuffer())) throw imageAdapterError('IMAGE_INVALID_REQUEST');
    }
    if (size > IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  }
  if (expected.size) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  // Request only serializes the SDK-created form locally. It never opens a
  // socket; the bounded bytes go through the host's pinned DNS/TLS transport.
  const serialized = new Request(IMAGE_EDIT_ENDPOINT, {method: 'POST', body});
  const contentType = serialized.headers.get('content-type');
  if (!contentType || !/^multipart\/form-data; boundary=[A-Za-z0-9-]{1,100}$/.test(contentType) || !serialized.body) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  const reader = serialized.body.getReader(), chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      abortIfNeeded(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > IMAGE_EDIT_NETWORK_LIMITS.maxRequestBytes) throw imageAdapterError('IMAGE_INVALID_REQUEST');
      chunks.push(Buffer.from(chunk.value));
    }
    abortIfNeeded(signal);
    return {body: Buffer.concat(chunks, length), contentType};
  } finally { await reader.cancel().catch(() => undefined); }
}

/** One SDK request, one bounded host transport. Exported for boundary tests;
 * this hook has no ambient network or credential implementation. */
export function createImageSdkFetch(call: ImageSdkParameters, context: ImageSdkRequestContext) {
  const target = destination(call, context);
  let used = false, dispatched = false, response: ImageTransportResponse | undefined, failure: unknown, transportFailure: unknown;
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const duplicate = used; used = true;
      if (duplicate || String(input) !== target.endpoint || init?.method !== 'POST') throw imageAdapterError('IMAGE_INVALID_REQUEST', {dispatched});
      const signals = [context.signal, init.signal].filter((value): value is AbortSignal => value != null);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      abortIfNeeded(signal);
      let payload: {body: string | Buffer; contentType: string};
      if (call.kind === 'edit') payload = await multipartPayload(init.body, call.parameters, signal);
      else {
        if (typeof init.body !== 'string' || init.body !== JSON.stringify(call.parameters) || Buffer.byteLength(init.body) > IMAGE_NETWORK_LIMITS.maxRequestBytes || new Headers(init.headers).get('content-type') !== 'application/json') throw imageAdapterError('IMAGE_INVALID_REQUEST');
        payload = {body: init.body, contentType: 'application/json'};
      }
      abortIfNeeded(signal);
      // Only payload/content type and cancellation cross the boundary. SDK
      // Authorization, organization, project and other headers are discarded.
      try { response = await context.post({...payload, signal, beforeDispatch: () => { context.beforeDispatch(); dispatched = true; }}); }
      catch (error) { transportFailure ??= error; throw error; }
      if (response?.dispatched !== true) throw imageAdapterError('IMAGE_RESPONSE_INVALID', {dispatched});
      if (!Buffer.isBuffer(response.body) || !response.body.length || response.body.length > IMAGE_NETWORK_LIMITS.maxResponseBytes) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE', {dispatched: true});
      return new Response(new Uint8Array(response.body), {status: 200, headers: {'content-type': 'application/json'}});
    } catch (error) { failure ??= error; throw error; }
  }, {Response: globalThis.Response});
  return {fetch, baseURL: target.baseURL, response: () => response, failure: () => transportFailure ?? failure};
}

export async function requestImageWithSdk(call: ImageSdkParameters, context: ImageSdkRequestContext): Promise<ImageTransportResponse> {
  const bridge = createImageSdkFetch(call, context);
  const sdk = new OpenAI({baseURL: bridge.baseURL, apiKey: 'mioon-host-owned-image-credential', adminAPIKey: null, organization: null, project: null,
    maxRetries: 0, timeout: IMAGE_NETWORK_LIMITS.totalTimeoutMs + IMAGE_NETWORK_LIMITS.connectTimeoutMs, logLevel: 'off', fetch: bridge.fetch});
  try {
    // asResponse deliberately avoids SDK JSON parsing: the existing decoder
    // rejects duplicate keys, unknown metadata and malformed PNG/base64.
    const raw = call.kind === 'edit'
      ? await sdk.images.edit(call.parameters, {signal: context.signal}).asResponse()
      : await sdk.images.generate(call.parameters, {signal: context.signal}).asResponse();
    await raw.body?.cancel();
    const response = bridge.response();
    if (!response) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    return response;
  } catch {
    const failure = bridge.failure();
    if (failure !== undefined) throw failure;
    throw imageAdapterError(context.signal?.aborted ? 'IMAGE_CANCELLED' : 'IMAGE_RESPONSE_INVALID');
  }
}
