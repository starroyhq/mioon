// First-party, fixed ComfyUI profile. Version/node declarations are compatibility
// observations from an independently trusted runtime, never code attestation.
export const COMFY_NETWORK_LIMITS = Object.freeze({
  maxStatusBytes: 256 * 1024, maxNodeInfoBytes: 2 * 1024 * 1024,
  maxGraphBytes: 32 * 1024, maxRequestBytes: 36 * 1024, maxPngBytes: 30 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024, connectTimeoutMs: 5000, jsonTimeoutMs: 10000,
  pngTimeoutMs: 30000, checkTimeoutMs: 30000,
});
export const COMFY_NODE_CLASSES = Object.freeze(['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage']);
export const COMFY_SAVE_NODE_ID = '7';
export const COMFY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages = Object.freeze({
  COMFY_INVALID_REQUEST: 'The local ComfyUI request does not match the fixed image profile.',
  COMFY_NETWORK_DENIED: 'The local ComfyUI destination or route is not allowed.',
  COMFY_CONNECTION_FAILED: 'The selected local ComfyUI connection failed.',
  COMFY_TIMEOUT: 'The local ComfyUI request timed out.',
  COMFY_ABORTED: 'Stopped observing ComfyUI. Remote work may continue.',
  COMFY_HTTP_ERROR: 'The local ComfyUI server did not accept this request.',
  COMFY_RESPONSE_INVALID: 'The local ComfyUI response does not match the supported protocol.',
  COMFY_RESPONSE_TOO_LARGE: 'The local ComfyUI response exceeded the supported size limit.',
  COMFY_DISPATCH_BLOCKED: 'The reviewed ComfyUI submission is no longer authorized.',
  COMFY_VERSION_UNSUPPORTED: 'This connector requires ComfyUI 0.39.0.',
  COMFY_DEPENDENCY_MISSING: 'The selected ComfyUI instance lacks a required built-in node or checkpoint.',
  COMFY_CORRELATION_FAILED: 'The ComfyUI result could not be matched to the reviewed workflow.',
  COMFY_OUTPUT_INVALID: 'The ComfyUI output is not one supported 512 by 512 PNG.',
});
export function comfyError(code = 'COMFY_RESPONSE_INVALID', {dispatched = false, outcomeUnknown = dispatched} = {}) {
  const safeCode = Object.hasOwn(messages, code) ? code : 'COMFY_RESPONSE_INVALID';
  return Object.assign(new Error(messages[safeCode]), {code: safeCode, dispatched: !!dispatched, outcomeUnknown: !!outcomeUnknown});
}
export function comfyLimits(overrides = {}) {
  const limits = {...COMFY_NETWORK_LIMITS};
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) throw comfyError('COMFY_INVALID_REQUEST');
    limits[name] = value;
  }
  return Object.freeze(limits);
}
export function assertComfyUuid(value) {
  if (typeof value !== 'string' || !COMFY_UUID_PATTERN.test(value)) throw comfyError('COMFY_INVALID_REQUEST');
  return value;
}
