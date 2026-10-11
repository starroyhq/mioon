import {IMAGE_NETWORK_LIMITS, createImageGenerationBody, createImageEditBody, validateImageEditSource, createCompatibleImageGenerationBody, imageAdapterError, parseImageAdapterInput} from './profiles.mjs';
import {renderMockImagePng, validatePng} from './png.mjs';

function abortIfNeeded(signal, dispatched = false) {
  if (signal?.aborted) throw imageAdapterError('IMAGE_CANCELLED', {dispatched});
}
function fence(beforeDispatch) {
  if (typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_DISPATCH_BLOCKED');
  try {
    const value = beforeDispatch();
    if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw imageAdapterError('IMAGE_DISPATCH_BLOCKED'); }
  } catch { throw imageAdapterError('IMAGE_DISPATCH_BLOCKED'); }
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function allowedKeys(value, keys) { return object(value) && Object.keys(value).every(key => keys.includes(key)); }

// JSON.parse accepts duplicate keys and unbounded object depth. Preflight token
// structure before parsing, skipping string contents rather than regex-matching
// JSON, to bound objects and reject duplicate keys including escaped spellings.
function preflightJson(text) {
  const stack = []; let containers = 0, keys = 0;
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
      let next = i + 1; while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
      if (text[next] !== ':') continue;
      if (!stack.at(-1) || ++keys > 256 || i - start > 200) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      let key; try { key = JSON.parse(text.slice(start, i + 1)); } catch { throw imageAdapterError('IMAGE_RESPONSE_INVALID'); }
      if (stack.at(-1).has(key)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      stack.at(-1).add(key);
    }
  }
  if (stack.length) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
}
export function decodeImageBase64(value) {
  const maximum = IMAGE_NETWORK_LIMITS.maxDecodedBytes;
  if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > Math.ceil(maximum / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.indexOf('=') !== (padding ? value.length - padding : -1)) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  if (value.length / 4 * 3 - padding > maximum) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  return bytes;
}
function usageMetadata(value) {
  if (value === undefined) return null;
  const scalarKeys = ['input_tokens', 'output_tokens', 'total_tokens'], detailKeys = ['input_tokens_details', 'output_tokens_details'];
  if (!allowedKeys(value, [...scalarKeys, ...detailKeys])) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const result = {};
  for (const key of scalarKeys) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000_000) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    result[key] = value[key];
  }
  for (const key of detailKeys) {
    if (value[key] === undefined) continue;
    if (!allowedKeys(value[key], ['image_tokens', 'text_tokens'])) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
    result[key] = {};
    for (const field of ['image_tokens', 'text_tokens']) {
      if (value[key][field] === undefined) continue;
      if (!Number.isSafeInteger(value[key][field]) || value[key][field] < 0 || value[key][field] > 1_000_000_000) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
      result[key][field] = value[key][field];
    }
  }
  return result;
}
export async function decodeImageJsonResponse(body, {signal, providerRequestId = null} = {}) {
  abortIfNeeded(signal);
  if (!Buffer.isBuffer(body) || !body.length || body.length > IMAGE_NETWORK_LIMITS.maxResponseBytes) throw imageAdapterError('IMAGE_RESPONSE_TOO_LARGE');
  let json;
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(body);
    preflightJson(text); json = JSON.parse(text);
  } catch { throw imageAdapterError('IMAGE_RESPONSE_INVALID'); }
  if (!allowedKeys(json, ['created', 'data', 'background', 'output_format', 'quality', 'size', 'usage']) || !Array.isArray(json.data) || json.data.length !== 1 || !allowedKeys(json.data[0], ['b64_json']) || !Object.hasOwn(json.data[0], 'b64_json')) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  if ((json.created !== undefined && (!Number.isSafeInteger(json.created) || json.created < 0)) || (json.background !== undefined && json.background !== 'opaque') || (json.output_format !== undefined && json.output_format !== 'png') || (json.quality !== undefined && json.quality !== 'low') || (json.size !== undefined && json.size !== '1024x1024')) throw imageAdapterError('IMAGE_RESPONSE_INVALID');
  const usage = usageMetadata(json.usage), bytes = decodeImageBase64(json.data[0].b64_json);
  const metadata = await validatePng(bytes, {signal});
  abortIfNeeded(signal);
  const requestId = typeof providerRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(providerRequestId) ? providerRequestId : null;
  return {bytes, metadata: {...metadata, isMock: false, providerRequestId: requestId, usage}};
}
export function createMockImageAdapter() {
  return Object.freeze({
    async generate(snapshot, {signal, beforeDispatch, sourceBytes} = {}) {
      const input = parseImageAdapterInput(snapshot, 'mock'); abortIfNeeded(signal);
      if (input.purpose === 'edit') await validateImageEditSource(input, sourceBytes, {signal, providerId: 'mock'});
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
        throw imageAdapterError(error?.code, {dispatched: true, outcomeUnknown: false});
      }
    },
  });
}
// Shared lifecycle and decoder for the two explicitly constructed live slots.
function createJsonImageAdapter({transport}, createBody) {
  return Object.freeze({
    async generate(snapshot, {signal, beforeDispatch, sourceBytes} = {}) {
      if (typeof transport !== 'function') throw imageAdapterError('IMAGE_LIVE_DISABLED');
      const prepared = createBody(snapshot, {signal, sourceBytes});
      const body = typeof prepared === 'string' ? prepared : await prepared; abortIfNeeded(signal);
      if (typeof beforeDispatch !== 'function') throw imageAdapterError('IMAGE_DISPATCH_BLOCKED');
      let fenced = false, received = false;
      try {
        const response = await transport({body, signal, beforeDispatch: () => {
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
        const dispatched = received || (typeof error?.dispatched === 'boolean' ? error.dispatched : fenced);
        throw imageAdapterError(error?.code, {dispatched, outcomeUnknown: dispatched});
      }
    },
  });
}

/** No ambient credential/network discovery. Only a trusted reviewed Images
 * gateway supplies a transport pinned to that slot's reviewed destination. */
function generationOnly(createBody, snapshot, {sourceBytes} = {}) {
  if (sourceBytes !== undefined) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  return createBody(snapshot);
}
export function createOpenAIImageAdapter(options = {}) {
  return createJsonImageAdapter(options, (snapshot, {signal, sourceBytes}) => snapshot?.purpose === 'edit'
    ? createImageEditBody(snapshot, sourceBytes, {signal}) : generationOnly(createImageGenerationBody, snapshot, {sourceBytes}));
}
export function createCompatibleImageAdapter(options = {}) {
  return createJsonImageAdapter(options, (snapshot, context) => generationOnly(createCompatibleImageGenerationBody, snapshot, context));
}
