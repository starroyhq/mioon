import {randomUUID} from 'node:crypto';
import {validateImageSecretPlaintext} from '@mioon/business/images/settings';
import type {ImageSecretCodec, ImageSecretStorage} from './image-secret-store.ts';
import type {SecretOperationOptions} from './secret-store.ts';

export const MAX_IMAGE_SECRET_MESSAGE_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_CHARACTERS = 48 * 1024;
const REQUEST = 'image-secret-codec-request', RESPONSE = 'image-secret-codec-response';
const CANCEL = 'image-secret-codec-cancel';
const NAMESPACE = 'images', VERSION = 1, MAX_PENDING = 16, MAX_COMPLETED_IDS = 128;
type CodecOperation = 'status' | 'encrypt' | 'decrypt';
const unavailableStorage = (): ImageSecretStorage => ({persistentAvailable: false, sessionScope: 'server', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'});
const messages: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  IMAGE_SECRET_CODEC_UNAVAILABLE: [503, 'Images secure storage is unavailable. Retry after restarting the local service.'],
  IMAGE_SECRET_CODEC_TIMEOUT: [503, 'Images secure storage did not respond in time.'],
  IMAGE_SECRET_CODEC_BUSY: [503, 'Images secure storage is busy. Retry shortly.'],
  IMAGE_SECRET_CODEC_VALIDATION: [400, 'Invalid Images secure storage request.'],
  IMAGE_SETTINGS_VALIDATION: [400, 'Invalid Images secure storage request.'],
  IMAGE_SETTINGS_STORAGE_UNAVAILABLE: [409, 'Images OS secure storage is unavailable. Choose session-only storage explicitly.'],
  IMAGE_SETTINGS_CORRUPT: [503, 'The Images credential could not be read safely.'],
});
interface CodecError extends Error { code: string; status: number }
interface SafeStorage extends ImageSecretStorage {}
interface CodecPort {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): void;
}
interface PendingClientRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  operation: CodecOperation;
  deadline: number;
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function codecError(code = 'IMAGE_SECRET_CODEC_UNAVAILABLE'): CodecError {
  if (!Object.hasOwn(messages, code)) code = 'IMAGE_SECRET_CODEC_UNAVAILABLE';
  const entry = messages[code];
  return Object.assign(new Error(entry[1]), {code, status: entry[0]});
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function boundedJson(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_IMAGE_SECRET_MESSAGE_BYTES; }
  catch { return false; }
}
function validCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CIPHERTEXT_CHARACTERS &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value;
}
function safeStorage(value: unknown): SafeStorage {
  if (!exactObject(value, ['persistentAvailable', 'sessionScope', 'reasonCode']) || typeof value.persistentAvailable !== 'boolean' ||
      value.sessionScope !== 'server' || ![null, 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT'].includes(value.reasonCode as string) ||
      value.persistentAvailable !== (value.reasonCode === null)) throw codecError();
  return {persistentAvailable: value.persistentAvailable, sessionScope: 'server',
    reasonCode: value.reasonCode as SafeStorage['reasonCode']};
}
function safeResult(operation: CodecOperation, value: unknown): unknown {
  if (operation === 'status') return safeStorage(value);
  if (operation === 'encrypt') { if (!validCiphertext(value)) throw codecError(); return value; }
  validateImageSecretPlaintext(value);
  return value;
}
function validInput(operation: unknown, input: unknown): boolean {
  if (operation === 'status') return input === undefined;
  if (operation === 'decrypt') return validCiphertext(input);
  if (operation !== 'encrypt') return false;
  try { validateImageSecretPlaintext(input); return true; } catch { return false; }
}
function response(requestId: string, value: unknown, error?: unknown) {
  if (error) {
    const safe = codecError(errorCode(error));
    return {type: RESPONSE, version: VERSION, namespace: NAMESPACE, requestId, ok: false,
      error: {code: safe.code, message: safe.message, status: safe.status}};
  }
  return {type: RESPONSE, version: VERSION, namespace: NAMESPACE, requestId, ok: true, data: value};
}

// Main-only endpoint over the already-owned utility channel. Dispatch is fixed
// to bounded async OS status/encrypt/decrypt; no paths, URLs, other secret
// namespaces beyond the two validated Images profiles, renderer IPC, settings
// engine or arbitrary methods are accepted. Deadlines/cancel stay on this private
// owned-child channel; no credential or arbitrary native method is exposed.
export function createImageSecretBroker({imageSecretCodec, send, isActive = () => true}: {
  imageSecretCodec: ImageSecretCodec | null | undefined;
  send(message: unknown): void;
  isActive?(): boolean;
}) {
  let closed = false;
  const pending = new Map<string, AbortController>(), completed = new Set<string>();
  const active = () => !closed && isActive();
  const reply = (message: unknown) => {
    if (!active()) return;
    try { send(message); } catch { /* The exact owned child may have exited. */ }
  };
  const remember = (requestId: string) => {
    // Tombstones contain IDs only. Never retain plaintext, ciphertext, response
    // payloads or hashes of credentials, and never replay a decrypt response.
    completed.add(requestId);
    if (completed.size > MAX_COMPLETED_IDS) {
      const oldest = completed.values().next().value;
      if (oldest !== undefined) completed.delete(oldest);
    }
  };
  return Object.freeze({
    handle(message: unknown): boolean {
      const envelope = recordOf(message);
      if (envelope?.type === CANCEL) {
        if (active() && exactObject(envelope, ['type', 'version', 'namespace', 'requestId']) &&
            envelope.version === VERSION && envelope.namespace === NAMESPACE && validId(envelope.requestId)) pending.get(envelope.requestId)?.abort();
        return true;
      }
      if (envelope?.type !== REQUEST) return false;
      const requestId = envelope.requestId, operation = envelope.operation;
      if (!validId(requestId) || !active()) return true;
      const keys = ['type', 'version', 'namespace', 'requestId', 'operation', ...(operation === 'status' ? [] : ['input'])];
      if (Object.hasOwn(envelope, 'deadline')) keys.push('deadline');
      if (!exactObject(envelope, keys) || !boundedJson(envelope) || envelope.version !== VERSION || envelope.namespace !== NAMESPACE ||
          (envelope.deadline !== undefined && (!Number.isSafeInteger(envelope.deadline) || (envelope.deadline as number) < 1 || (envelope.deadline as number) > Date.now() + 60000)) ||
          !validInput(operation, envelope.input)) {
        reply(response(requestId, null, codecError('IMAGE_SECRET_CODEC_VALIDATION'))); return true;
      }
      if (completed.has(requestId)) { reply(response(requestId, null, codecError())); return true; }
      if (pending.has(requestId)) return true;
      if (pending.size >= MAX_PENDING) { reply(response(requestId, null, codecError('IMAGE_SECRET_CODEC_BUSY'))); return true; }
      if (!imageSecretCodec || typeof imageSecretCodec.storage !== 'function' ||
          typeof imageSecretCodec.encrypt !== 'function' || typeof imageSecretCodec.decrypt !== 'function') {
        reply(response(requestId, null, codecError())); return true;
      }
      const controller = new AbortController();
      pending.set(requestId, controller);
      const deadline = Math.min(envelope.deadline as number | undefined ?? Infinity, Date.now() + 2000);
      const isActiveRequest = () => active() && pending.get(requestId) === controller && !controller.signal.aborted && Date.now() < deadline;
      // Only a bounded immutable string is captured, never the input envelope.
      const input = envelope.input, dispatch = operation as CodecOperation;
      queueMicrotask(async () => {
        if (!isActiveRequest()) { pending.delete(requestId); return; }
        const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        let result: unknown;
        try {
          // Only the owned codec is awaited. Its shared native slot outlives
          // this request's timeout/close until the actual native call settles.
          const options: SecretOperationOptions = {signal: controller.signal, isActive: isActiveRequest};
          const value = dispatch === 'status' ? await imageSecretCodec.storage(options) : dispatch === 'encrypt'
            ? await imageSecretCodec.encrypt(input as string, options) : await imageSecretCodec.decrypt(input as string, options);
          if (!isActiveRequest()) throw codecError();
          result = response(requestId, safeResult(dispatch, value));
          if (!boundedJson(result)) throw codecError();
        } catch (error) { result = response(requestId, null, codecError(errorCode(error))); }
        finally {
          clearTimeout(timer);
          const canReply = isActiveRequest();
          pending.delete(requestId);
          if (!closed) remember(requestId);
          if (canReply && result) reply(result);
        }
      });
      return true;
    },
    close() { closed = true; for (const controller of pending.values()) controller.abort(); completed.clear(); }
  });
}

// Utility-only client. Its only cached value is redacted availability; Images
// session credentials remain exclusively in the utility settings engine.
export function createImageSecretClient({port, timeout = 2000}: {port: CodecPort; timeout?: number}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function' ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw codecError();
  let closed = false, availability: ImageSecretStorage = unavailableStorage(), refreshing: Promise<ImageSecretStorage> | null = null, epoch = 0;
  const pending = new Map<string, PendingClientRequest>();
  const complete = (requestId: string, error: Error | null, value?: unknown) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.timer);
    if (error) {
      availability = unavailableStorage(); epoch++;
      try { port.postMessage({type: CANCEL, version: VERSION, namespace: NAMESPACE, requestId}); } catch {}
      entry.reject(error);
    }
    else entry.resolve(value);
  };
  const onMessage = (event?: unknown) => {
    // Electron delivers {data}; a malformed envelope is ignored by the same gates.
    const message = recordOf(recordOf(event)?.data);
    if (message?.type !== RESPONSE || !validId(message.requestId) || !pending.has(message.requestId)) return;
    const requestId = message.requestId;
    const entry = pending.get(requestId)!;
    if (Date.now() >= entry.deadline) {
      complete(requestId, codecError('IMAGE_SECRET_CODEC_TIMEOUT'));
      return;
    }
    try {
      const keys = ['type', 'version', 'namespace', 'requestId', 'ok', message.ok ? 'data' : 'error'];
      if (!exactObject(message, keys) || !boundedJson(message) || message.version !== VERSION ||
          message.namespace !== NAMESPACE || typeof message.ok !== 'boolean') throw codecError();
      if (!message.ok) {
        if (!exactObject(message.error, ['code', 'message', 'status'])) throw codecError();
        throw codecError(message.error.code as string);
      }
      complete(requestId, null, safeResult(entry.operation, message.data));
    } catch (error) { complete(requestId, codecError(errorCode(error))); }
  };
  const close = () => {
    if (closed) return;
    closed = true; availability = unavailableStorage();
    port.removeListener?.('message', onMessage); port.removeListener?.('close', close);
    for (const requestId of pending.keys()) complete(requestId, codecError());
  };
  port.on('message', onMessage); port.on('close', close);
  const request = (operation: CodecOperation, input?: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(codecError());
    if (!validInput(operation, input)) return Promise.reject(codecError('IMAGE_SECRET_CODEC_VALIDATION'));
    if (pending.size >= MAX_PENDING) return Promise.reject(codecError('IMAGE_SECRET_CODEC_BUSY'));
    const requestId = randomUUID();
    const message: Record<string, unknown> = {type: REQUEST, version: VERSION, namespace: NAMESPACE, requestId, operation, deadline: Date.now() + timeout,
      ...(operation !== 'status' ? {input} : {})};
    if (!boundedJson(message)) return Promise.reject(codecError('IMAGE_SECRET_CODEC_VALIDATION'));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => complete(requestId, codecError('IMAGE_SECRET_CODEC_TIMEOUT')), timeout);
      pending.set(requestId, {resolve, reject, timer, operation, deadline: message.deadline as number});
      try { port.postMessage(message); } catch { complete(requestId, codecError()); }
    });
  };
  const refreshStorage = (): Promise<ImageSecretStorage> => {
    if (closed) return Promise.reject(codecError());
    if (!refreshing) {
      const currentEpoch = epoch;
      refreshing = request('status').then(value => {
        if (closed || currentEpoch !== epoch) throw codecError();
        availability = safeStorage(value); return {...availability};
      }).finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  const crypto = async (operation: CodecOperation, input: unknown): Promise<unknown> => {
    if (!validInput(operation, input)) throw codecError('IMAGE_SECRET_CODEC_VALIDATION');
    if (!(await refreshStorage()).persistentAvailable) throw codecError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
    return request(operation, input);
  };
  const client = {
    // The response allowlist already proved the ciphertext/plaintext is a string.
    encrypt(plaintext: string): Promise<string> { return crypto('encrypt', plaintext) as Promise<string>; },
    decrypt(ciphertext: string): Promise<string> { return crypto('decrypt', ciphertext) as Promise<string>; },
    storage(): ImageSecretStorage { return {...availability}; },
    refreshStorage,
    close
  };
  return Object.freeze(client);
}
