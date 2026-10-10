import {randomUUID} from 'node:crypto';
import {validateImageSecretPlaintext} from '@mioon/business/images/settings';

export const MAX_IMAGE_SECRET_MESSAGE_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_CHARACTERS = 48 * 1024;
const REQUEST = 'image-secret-codec-request', RESPONSE = 'image-secret-codec-response';
const NAMESPACE = 'images', VERSION = 1, MAX_PENDING = 16, MAX_COMPLETED_IDS = 128;
const unavailableStorage = () => ({persistentAvailable: false, sessionScope: 'server', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'});
const messages = Object.freeze({
  IMAGE_SECRET_CODEC_UNAVAILABLE: [503, 'Images secure storage is unavailable. Retry after restarting the local service.'],
  IMAGE_SECRET_CODEC_TIMEOUT: [503, 'Images secure storage did not respond in time.'],
  IMAGE_SECRET_CODEC_BUSY: [503, 'Images secure storage is busy. Retry shortly.'],
  IMAGE_SECRET_CODEC_VALIDATION: [400, 'Invalid Images secure storage request.'],
  IMAGE_SETTINGS_VALIDATION: [400, 'Invalid Images secure storage request.'],
  IMAGE_SETTINGS_STORAGE_UNAVAILABLE: [409, 'Images OS secure storage is unavailable. Choose session-only storage explicitly.'],
  IMAGE_SETTINGS_CORRUPT: [503, 'The Images credential could not be read safely.'],
});
function codecError(code = 'IMAGE_SECRET_CODEC_UNAVAILABLE') {
  if (!Object.hasOwn(messages, code)) code = 'IMAGE_SECRET_CODEC_UNAVAILABLE';
  return Object.assign(new Error(messages[code][1]), {code, status: messages[code][0]});
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactObject(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function boundedJson(value) {
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_IMAGE_SECRET_MESSAGE_BYTES; }
  catch { return false; }
}
function validCiphertext(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CIPHERTEXT_CHARACTERS &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}
function safeStorage(value) {
  if (!exactObject(value, ['persistentAvailable', 'sessionScope', 'reasonCode']) || typeof value.persistentAvailable !== 'boolean' ||
      value.sessionScope !== 'server' || ![null, 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT'].includes(value.reasonCode) ||
      value.persistentAvailable !== (value.reasonCode === null)) throw codecError();
  return {persistentAvailable: value.persistentAvailable, sessionScope: 'server', reasonCode: value.reasonCode};
}
function safeResult(operation, value) {
  if (operation === 'status') return safeStorage(value);
  if (operation === 'encrypt') { if (!validCiphertext(value)) throw codecError(); return value; }
  validateImageSecretPlaintext(value);
  return value;
}
function validInput(operation, input) {
  if (operation === 'status') return input === undefined;
  if (operation === 'decrypt') return validCiphertext(input);
  if (operation !== 'encrypt') return false;
  try { validateImageSecretPlaintext(input); return true; } catch { return false; }
}
function response(requestId, value, error) {
  if (error) {
    const safe = codecError(error.code);
    return {type: RESPONSE, version: VERSION, namespace: NAMESPACE, requestId, ok: false,
      error: {code: safe.code, message: safe.message, status: safe.status}};
  }
  return {type: RESPONSE, version: VERSION, namespace: NAMESPACE, requestId, ok: true, data: value};
}

// Main-only endpoint over the already-owned utility channel. Dispatch is fixed
// to synchronous native OS status/encrypt/decrypt; no paths, URLs, other secret
// namespaces, renderer IPC, settings engine or arbitrary methods are accepted.
export function createImageSecretBroker({imageSecretCodec, send, isActive = () => true}) {
  let closed = false;
  const pending = new Set(), completed = new Set();
  const active = () => !closed && isActive();
  const reply = message => {
    if (!active()) return;
    try { send(message); } catch { /* The exact owned child may have exited. */ }
  };
  const remember = requestId => {
    // Tombstones contain IDs only. Never retain plaintext, ciphertext, response
    // payloads or hashes of credentials, and never replay a decrypt response.
    completed.add(requestId);
    if (completed.size > MAX_COMPLETED_IDS) completed.delete(completed.values().next().value);
  };
  return Object.freeze({
    handle(message) {
      if (message?.type !== REQUEST) return false;
      if (!validId(message.requestId) || !active()) return true;
      const {requestId, operation} = message;
      const keys = ['type', 'version', 'namespace', 'requestId', 'operation', ...(operation === 'status' ? [] : ['input'])];
      if (!exactObject(message, keys) || !boundedJson(message) || message.version !== VERSION || message.namespace !== NAMESPACE ||
          !validInput(operation, message.input)) {
        reply(response(requestId, null, codecError('IMAGE_SECRET_CODEC_VALIDATION'))); return true;
      }
      if (completed.has(requestId)) { reply(response(requestId, null, codecError())); return true; }
      if (pending.has(requestId)) return true;
      if (pending.size >= MAX_PENDING) { reply(response(requestId, null, codecError('IMAGE_SECRET_CODEC_BUSY'))); return true; }
      if (!imageSecretCodec || typeof imageSecretCodec.storage !== 'function' ||
          typeof imageSecretCodec.encrypt !== 'function' || typeof imageSecretCodec.decrypt !== 'function') {
        reply(response(requestId, null, codecError())); return true;
      }
      pending.add(requestId);
      // Only a bounded immutable string is captured, never the input envelope.
      const input = message.input;
      queueMicrotask(() => {
        if (!active() || !pending.has(requestId)) { pending.delete(requestId); return; }
        let result;
        try {
          // The native codec is deliberately synchronous. Do not await arbitrary
          // promises that could outlive the child or consume unbounded resources.
          const value = operation === 'status' ? imageSecretCodec.storage() : operation === 'encrypt'
            ? imageSecretCodec.encrypt(input) : imageSecretCodec.decrypt(input);
          result = response(requestId, safeResult(operation, value));
          if (!boundedJson(result)) throw codecError();
        } catch (error) { result = response(requestId, null, codecError(error?.code)); }
        pending.delete(requestId);
        remember(requestId);
        reply(result);
      });
      return true;
    },
    close() { closed = true; pending.clear(); completed.clear(); }
  });
}

// Utility-only client. Its only cached value is redacted availability; Images
// session credentials remain exclusively in the utility settings engine.
export function createImageSecretClient({port, timeout = 2000}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function' ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw codecError();
  let closed = false, availability = unavailableStorage(), refreshing = null;
  const pending = new Map();
  const complete = (requestId, error, value) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.timer);
    if (error) { availability = unavailableStorage(); entry.reject(error); }
    else entry.resolve(value);
  };
  const onMessage = ({data: message} = {}) => {
    if (message?.type !== RESPONSE || !validId(message.requestId) || !pending.has(message.requestId)) return;
    const {requestId} = message;
    try {
      const keys = ['type', 'version', 'namespace', 'requestId', 'ok', message.ok ? 'data' : 'error'];
      if (!exactObject(message, keys) || !boundedJson(message) || message.version !== VERSION ||
          message.namespace !== NAMESPACE || typeof message.ok !== 'boolean') throw codecError();
      if (!message.ok) {
        if (!exactObject(message.error, ['code', 'message', 'status'])) throw codecError();
        throw codecError(message.error.code);
      }
      complete(requestId, null, safeResult(pending.get(requestId).operation, message.data));
    } catch (error) { complete(requestId, codecError(error?.code)); }
  };
  const close = () => {
    if (closed) return;
    closed = true; availability = unavailableStorage();
    port.removeListener?.('message', onMessage); port.removeListener?.('close', close);
    for (const requestId of pending.keys()) complete(requestId, codecError());
  };
  port.on('message', onMessage); port.on('close', close);
  const request = (operation, input) => {
    if (closed) return Promise.reject(codecError());
    if (!validInput(operation, input)) return Promise.reject(codecError('IMAGE_SECRET_CODEC_VALIDATION'));
    if (pending.size >= MAX_PENDING) return Promise.reject(codecError('IMAGE_SECRET_CODEC_BUSY'));
    const requestId = randomUUID();
    const message = {type: REQUEST, version: VERSION, namespace: NAMESPACE, requestId, operation,
      ...(operation !== 'status' ? {input} : {})};
    if (!boundedJson(message)) return Promise.reject(codecError('IMAGE_SECRET_CODEC_VALIDATION'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => complete(requestId, codecError('IMAGE_SECRET_CODEC_TIMEOUT')), timeout);
      pending.set(requestId, {resolve, reject, timer, operation});
      try { port.postMessage(message); } catch { complete(requestId, codecError()); }
    });
  };
  const refreshStorage = () => {
    if (closed) return Promise.reject(codecError());
    if (!refreshing) {
      refreshing = request('status').then(value => {
        if (closed) throw codecError();
        availability = safeStorage(value); return {...availability};
      }).finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  const crypto = async (operation, input) => {
    if (!validInput(operation, input)) throw codecError('IMAGE_SECRET_CODEC_VALIDATION');
    if (!(await refreshStorage()).persistentAvailable) throw codecError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
    return request(operation, input);
  };
  return Object.freeze({
    encrypt(plaintext) { return crypto('encrypt', plaintext); },
    decrypt(ciphertext) { return crypto('decrypt', ciphertext); },
    storage() { return {...availability}; },
    refreshStorage,
    close
  });
}
