import {CUSTOM_IMAGE_PROFILE_ID} from '../../../contracts/src/image-settings.mjs';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, imageAdapterInputSchema} from '../../../contracts/src/images.mjs';

// Official documentation checked 2026-10-10; no account/model/live evidence.
// https://developers.openai.com/api/reference/resources/images/methods/generate
// https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
export const IMAGE_GENERATION_ENDPOINT = 'https://api.openai.com/v1/images/generations';
export const IMAGE_NETWORK_LIMITS = Object.freeze({connectTimeoutMs: 10000, totalTimeoutMs: 180000, maxRequestBytes: 16384, maxResponseBytes: 42 * 1024 * 1024, maxDecodedBytes: 30 * 1024 * 1024, maxHeaderBytes: 16384, maxDnsAnswers: 64});
export const IMAGE_LIVE_ENABLED = false;
export const IMAGE_PROFILES = Object.freeze([
  Object.freeze({providerId: 'mock', model: IMAGE_MODELS.mock, name: 'Mock image · synthetic test card', enabled: true, isMock: true, evidence: 'deterministic-mock', options: IMAGE_FIXED_OPTIONS}),
  Object.freeze({providerId: 'openai', model: IMAGE_MODELS.openai, name: 'OpenAI Images · live disabled', enabled: false, isMock: false, evidence: 'offline-tested-not-live', options: IMAGE_FIXED_OPTIONS}),
]);
// An explicit conservative wire profile, not a claim of broad vendor support.
// Unsupported fields fail closed; there is no negotiation or fallback request.
export const CUSTOM_IMAGE_JSON_PROFILE = Object.freeze({
  providerId: 'openai-compatible', profileId: CUSTOM_IMAGE_PROFILE_ID,
  evidence: 'offline-tested-not-live', protocol: 'https:', port: 443, pathSuffix: '/images/generations',
  request: Object.freeze({method: 'POST', contentType: 'application/json', moderation: 'auto', options: IMAGE_FIXED_OPTIONS}),
  response: Object.freeze({format: 'b64_json', mimeType: 'image/png', count: 1}),
});
const messages = Object.freeze({
  IMAGE_LIVE_DISABLED: 'Live image generation is disabled.',
  IMAGE_INVALID_REQUEST: 'Image request does not match the fixed image profile.',
  IMAGE_CANCELLED: 'Image generation was cancelled; a dispatched request may still complete remotely.',
  IMAGE_NETWORK_DENIED: 'Image service connection did not pass the network safety checks.',
  IMAGE_CONNECTION_FAILED: 'Image service connection failed.',
  IMAGE_TIMEOUT: 'Image request exceeded its deadline.',
  IMAGE_HTTP_ERROR: 'Image service returned an unsuccessful response.',
  IMAGE_RESPONSE_INVALID: 'Image service returned an unsupported response.',
  IMAGE_RESPONSE_TOO_LARGE: 'Image service response exceeded the local size limit.',
  IMAGE_DISPATCH_BLOCKED: 'The local image dispatch fence did not authorize sending.',
  IMAGE_PNG_INVALID: 'Image bytes are not a valid supported PNG.',
  IMAGE_PNG_UNSUPPORTED: 'Image bytes use an unsupported PNG feature.',
  IMAGE_PNG_TOO_LARGE: 'Image pixels or metadata exceeded the local limit.',
});
export function imageAdapterError(code, {dispatched = false, outcomeUnknown = dispatched} = {}) {
  if (!Object.hasOwn(messages, code)) code = 'IMAGE_RESPONSE_INVALID';
  return Object.assign(new Error(messages[code]), {code, dispatched: dispatched === true, outcomeUnknown: outcomeUnknown === true});
}
export function parseImageAdapterInput(snapshot, expectedProvider) {
  const parsed = imageAdapterInputSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.providerId !== expectedProvider) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  return parsed.data;
}
function generationBody(snapshot, providerId) {
  const input = parseImageAdapterInput(snapshot, providerId);
  const body = JSON.stringify({model: input.model, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
  if (Buffer.byteLength(body) > IMAGE_NETWORK_LIMITS.maxRequestBytes) throw imageAdapterError('IMAGE_INVALID_REQUEST');
  return body;
}

// Both explicit slots use this bounded single-PNG JSON profile. Provider/model
// validation remains distinct, and no response-format negotiation is attempted.
export function createImageGenerationBody(snapshot) { return generationBody(snapshot, 'openai'); }
export function createCompatibleImageGenerationBody(snapshot) { return generationBody(snapshot, 'openai-compatible'); }
