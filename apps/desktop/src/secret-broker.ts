import { randomUUID, createHash } from 'node:crypto';
import { sanitizeAgentSettingsResult, sanitizeAgentSettingsError, AGENT_CREDENTIAL_ACQUIRE, parseAgentCredentialRequest, sanitizeAgentCredentialResult } from '@mioon/business/agent/settings';
import type {AgentCredentialRequest, AgentSettingsService, SettingsContextOptions} from '@mioon/business/agent/settings';

export const MAX_AGENT_SETTINGS_MESSAGE_BYTES = 64 * 1024;
const REQUEST = 'agent-settings-request';
const RESPONSE = 'agent-settings-response';
const CANCEL = 'agent-credential-cancel';
const VERSION = 1;
const MAX_PENDING = 32;
const REQUEST_KEYS = new Set(['type', 'version', 'requestId', 'operation', 'input', 'selfPort', 'deadline']);
const RESPONSE_KEYS = new Set(['type', 'version', 'requestId', 'ok', 'data', 'error']);
const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AGENT_SETTINGS_UNAVAILABLE: 'Agent settings are unavailable. Retry after restarting the local service.',
  AGENT_SETTINGS_TIMEOUT: 'Agent settings did not respond in time. Reload the settings before retrying a save.',
  AGENT_SETTINGS_BUSY: 'Agent settings are busy. Retry shortly.',
  VALIDATION_ERROR: 'Invalid Agent settings request.'
});
type AgentOperation = 'get' | 'put' | 'acquire';
type ClientRequestOptions = {selfPort?: number; signal?: AbortSignal};
interface TransportError extends Error { code: string; status: number }
interface SafeError { code: string; message: string; status: number }
/** Electron's owned utility channel, structurally (parentPort or a test double). */
interface BrokerPort {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): void;
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  operation: AgentOperation;
  expected: AgentCredentialRequest | undefined;
  signal?: AbortSignal;
  abort(): void;
  deadline: number;
}
interface CompletedResponse { fingerprint: string; response: unknown }
interface PendingBrokerRequest { controller: AbortController }

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function transportError(code: string): TransportError {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.AGENT_SETTINGS_UNAVAILABLE) as TransportError;
  error.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'AGENT_SETTINGS_UNAVAILABLE';
  error.status = code === 'VALIDATION_ERROR' ? 400 : 503;
  return error;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }
function boundedJson(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_AGENT_SETTINGS_MESSAGE_BYTES; }
  catch { return false; }
}
function validPort(value: unknown): value is number | undefined { return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65535); }
function validDeadline(value: unknown): value is number | undefined { return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= Date.now() + 60000); }
function validOperation(value: unknown): value is AgentOperation { return value === 'get' || value === 'put' || value === 'acquire'; }
function safeError(error: unknown): SafeError {
  const code = errorCode(error);
  if (code !== undefined && Object.hasOwn(ERROR_MESSAGES, code)) {
    const fixed = transportError(code);
    return { code: fixed.code, message: fixed.message, status: fixed.status };
  }
  return sanitizeAgentSettingsError(error);
}
function errorResponse(requestId: string, error: unknown) {
  return { type: RESPONSE, version: VERSION, requestId, ok: false, error: safeError(error) };
}

// Main-only endpoint. The trusted utility can read safe settings or submit one
// validated replacement. Only the trusted utility's inference capability may
// acquire one revision/configuration-bound credential. No arbitrary dispatch,
// renderer IPC handler, public key serializer, or transferable native port.
export function createAgentSettingsBroker({ agentSettings, send, isActive = () => true, getSelfPort = () => undefined as number | null | undefined }: {
  agentSettings: AgentSettingsService | null | undefined;
  send(message: unknown): void;
  isActive?(): boolean;
  getSelfPort?(): number | null | undefined;
}) {
  let closed = false;
  const pending = new Map<string, PendingBrokerRequest>(), completed = new Map<string, CompletedResponse>();
  const active = () => !closed && isActive();
  const reply = (message: unknown) => {
    if (!active()) return;
    try { send(message); } catch { /* The child may have exited between the check and send. */ }
  };
  const remember = (requestId: string, fingerprint: string, response: unknown) => {
    completed.set(requestId, {fingerprint, response});
    if (completed.size > 64) { const oldest = completed.keys().next().value; if (oldest !== undefined) completed.delete(oldest); }
  };
  return Object.freeze({
    handle(message: unknown): boolean {
      const envelope = recordOf(message);
      if (envelope?.type === CANCEL) {
        if (active() && plainObject(envelope) && Object.keys(envelope).length === 3 && envelope.version === VERSION && validId(envelope.requestId)) pending.get(envelope.requestId)?.controller?.abort();
        return true;
      }
      if (envelope?.type !== REQUEST) return false;
      // Uncorrelatable messages get no response, and no part of the supplied
      // payload is echoed in a rejection.
      const requestId = envelope.requestId;
      if (!validId(requestId) || !active() || !envelope) return true;
      if (!plainObject(envelope) || !boundedJson(envelope) || envelope.version !== VERSION ||
        Object.keys(envelope).some(key => !REQUEST_KEYS.has(key)) || !validPort(envelope.selfPort) || !validDeadline(envelope.deadline) ||
        !validOperation(envelope.operation) ||
        (envelope.operation === 'get' ? Object.hasOwn(envelope, 'input') : !plainObject(envelope.input))) {
        reply(errorResponse(requestId, transportError('VALIDATION_ERROR')));
        return true;
      }
      const operation = envelope.operation;
      const selfPort = getSelfPort();
      if (!validPort(selfPort) || (selfPort !== undefined && selfPort !== envelope.selfPort)) {
        reply(errorResponse(requestId, transportError('VALIDATION_ERROR')));
        return true;
      }
      const fingerprint = createHash('sha256').update(JSON.stringify([operation, envelope.input, selfPort ?? envelope.selfPort])).digest('hex');
      if (completed.has(requestId)) {
        const previous = completed.get(requestId)!;
        reply(previous.fingerprint === fingerprint && previous.response ? previous.response : errorResponse(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE')));
        return true;
      }
      if (pending.has(requestId)) return true;
      if (pending.size >= MAX_PENDING) { reply(errorResponse(requestId, transportError('AGENT_SETTINGS_BUSY'))); return true; }
      if (!agentSettings || typeof (operation === 'acquire' ? agentSettings[AGENT_CREDENTIAL_ACQUIRE] : agentSettings[operation]) !== 'function') {
        reply(errorResponse(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'))); return true;
      }
      const controller = new AbortController();
      pending.set(requestId, {controller});
      // Snapshot only the bounded input. Nothing after this point references the
      // incoming envelope, and errors cannot serialize it or its plaintext key.
      const input: unknown = operation !== 'get' ? JSON.parse(JSON.stringify(envelope.input)) : undefined;
      // The original utility deadline fences a late encrypt before save even
      // when its cancellation message has not reached main yet. Legacy requests
      // without a deadline still get a bounded main-side lifetime.
      const deadline = Math.min(envelope.deadline ?? Infinity, Date.now() + 7000);
      const options: SettingsContextOptions & {selfPort: number | undefined} = { selfPort: selfPort ?? envelope.selfPort as number | undefined,
        signal: controller.signal, isActive: () => active() && Date.now() < deadline };
      void (async () => {
        let response: unknown, timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        // Acquisition has its own abort/deadline, independent of HTTP lifetime.
        const acquire = async (): Promise<unknown> => {
          const expected: AgentCredentialRequest = parseAgentCredentialRequest(input, options);
          return new Promise<unknown>((resolve, reject) => {
            let settled = false;
            const finish = (error: Error | null, result?: unknown) => {
              if (settled) return;
              settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
              if (error) reject(error); else resolve(result);
            };
            const abort = () => finish(transportError('AGENT_SETTINGS_UNAVAILABLE'));
            controller.signal.addEventListener('abort', abort, {once: true});
            if (!active() || controller.signal.aborted) return abort();
            Promise.resolve().then(() => {
              if (controller.signal.aborted || !active()) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
              return agentSettings[AGENT_CREDENTIAL_ACQUIRE](expected, {...options, signal: controller.signal});
            }).then(value => {
              try { finish(null, sanitizeAgentCredentialResult(value, expected)); } catch (error) { finish(error as Error); }
            }, (error: unknown) => finish(error as Error));
          });
        };
        try {
          if (!options.isActive?.() || controller.signal.aborted) return;
          const data = operation === 'acquire' ? await acquire()
            : sanitizeAgentSettingsResult(operation === 'get' ? await agentSettings.get(options) : await agentSettings.put(input, options));
          response = { type: RESPONSE, version: VERSION, requestId, ok: true, data };
          if (!boundedJson(response)) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        } catch (error) { response = errorResponse(requestId, error); }
        finally { clearTimeout(timer); pending.delete(requestId); }
        if (options.isActive?.() && !controller.signal.aborted) {
          // Never cache an acquisition result or replay a plaintext credential.
          remember(requestId, fingerprint, operation === 'acquire' ? null : response);
          reply(response);
        }
      })();
      return true;
    },
    close() { closed = true; for (const entry of pending.values()) entry.controller?.abort(); pending.clear(); completed.clear(); }
  });
}

// Utility-only client over Electron's existing parentPort. Correlation and
// bounded deadlines prevent a dead main process from leaving HTTP saves hung.
export function createAgentSettingsClient({ port, timeout = 10000 }: {port: BrokerPort; timeout?: number}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function' ||
    !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
  let closed = false;
  const pending = new Map<string, PendingRequest>();
  const complete = (requestId: string, error: Error | null, data?: unknown) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    if (error) { try { port.postMessage({type: CANCEL, version: VERSION, requestId}); } catch {} }
    if (error) entry.reject(error); else entry.resolve(data);
  };
  const onMessage = (event?: unknown) => {
    // Electron delivers {data}; a malformed envelope is ignored by the same gates.
    const message = recordOf(recordOf(event)?.data);
    if (message?.type !== RESPONSE || !validId(message.requestId) || !pending.has(message.requestId)) return;
    const requestId = message.requestId;
    const entry = pending.get(requestId)!;
    if (Date.now() >= entry.deadline) {
      complete(requestId, transportError('AGENT_SETTINGS_TIMEOUT'));
      return;
    }
    if (!plainObject(message) || !boundedJson(message) || message.version !== VERSION ||
      Object.keys(message).some(key => !RESPONSE_KEYS.has(key)) || typeof message.ok !== 'boolean') {
      complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'));
      return;
    }
    try {
      if (message.ok) {
        if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'data')) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        complete(requestId, null, entry.operation === 'acquire'
          ? sanitizeAgentCredentialResult(message.data, entry.expected!) : sanitizeAgentSettingsResult(message.data));
      } else {
        if (Object.hasOwn(message, 'data') || !plainObject(message.error)) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        const serialized = safeError(message.error);
        complete(requestId, Object.assign(new Error(serialized.message), { code: serialized.code, status: serialized.status }));
      }
    } catch { complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE')); }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    port.removeListener?.('message', onMessage);
    port.removeListener?.('close', close);
    for (const requestId of pending.keys()) complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'));
  };
  port.on('message', onMessage);
  port.on('close', close);
  const request = (operation: AgentOperation, input: unknown, options: ClientRequestOptions): Promise<unknown> => {
    if (closed) return Promise.reject(transportError('AGENT_SETTINGS_UNAVAILABLE'));
    if (pending.size >= MAX_PENDING) return Promise.reject(transportError('AGENT_SETTINGS_BUSY'));
    if (!plainObject(options) || Object.keys(options).some(key => !['selfPort', 'signal'].includes(key)) || !validPort(options.selfPort)) {
      return Promise.reject(transportError('VALIDATION_ERROR'));
    }
    let expected: AgentCredentialRequest | undefined;
    try { if (operation === 'acquire') expected = parseAgentCredentialRequest(input, options); }
    catch { return Promise.reject(transportError('VALIDATION_ERROR')); }
    const requestId = randomUUID();
    const deadline = Date.now() + timeout;
    const message: Record<string, unknown> = { type: REQUEST, version: VERSION, requestId, operation, deadline,
      ...(options.selfPort !== undefined ? {selfPort: options.selfPort} : {}),
      ...(operation !== 'get' ? { input: expected ?? input } : {}) };
    if (!boundedJson(message)) return Promise.reject(transportError('VALIDATION_ERROR'));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => complete(requestId, transportError('AGENT_SETTINGS_TIMEOUT')), timeout);
      const signal = options.signal;
      const abort = () => complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'));
      pending.set(requestId, { resolve, reject, timer, operation, expected, signal, abort, deadline });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, {once: true});
      try { port.postMessage(message); }
      catch { complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE')); }
    });
  };
  return Object.freeze({
    get(options: ClientRequestOptions = {}) { return request('get', undefined, options); },
    put(input: unknown, options: ClientRequestOptions = {}) { return request('put', input, options); },
    [AGENT_CREDENTIAL_ACQUIRE](input: unknown, options: ClientRequestOptions = {}) { return request('acquire', input, options); },
    close
  });
}
