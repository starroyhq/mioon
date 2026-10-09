import { randomUUID } from 'node:crypto';
import { sanitizeAgentSettingsResult, sanitizeAgentSettingsError } from '@mioon/business/agent/settings';

export const MAX_AGENT_SETTINGS_MESSAGE_BYTES = 64 * 1024;
const REQUEST = 'agent-settings-request';
const RESPONSE = 'agent-settings-response';
const VERSION = 1;
const MAX_PENDING = 32;
const REQUEST_KEYS = new Set(['type', 'version', 'requestId', 'operation', 'input', 'selfPort']);
const RESPONSE_KEYS = new Set(['type', 'version', 'requestId', 'ok', 'data', 'error']);
const ERROR_MESSAGES = Object.freeze({
  AGENT_SETTINGS_UNAVAILABLE: 'Agent settings are unavailable. Retry after restarting the local service.',
  AGENT_SETTINGS_TIMEOUT: 'Agent settings did not respond in time. Reload the settings before retrying a save.',
  AGENT_SETTINGS_BUSY: 'Agent settings are busy. Retry shortly.',
  VALIDATION_ERROR: 'Invalid Agent settings request.'
});

function transportError(code) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.AGENT_SETTINGS_UNAVAILABLE);
  error.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'AGENT_SETTINGS_UNAVAILABLE';
  error.status = code === 'VALIDATION_ERROR' ? 400 : 503;
  return error;
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }
function boundedJson(value) {
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_AGENT_SETTINGS_MESSAGE_BYTES; }
  catch { return false; }
}
function validPort(value) { return value === undefined || (Number.isInteger(value) && value >= 1 && value <= 65535); }
function safeError(error) {
  if (Object.hasOwn(ERROR_MESSAGES, error?.code)) {
    const fixed = transportError(error.code);
    return { code: fixed.code, message: fixed.message, status: fixed.status };
  }
  return sanitizeAgentSettingsError(error);
}
function errorResponse(requestId, error) {
  return { type: RESPONSE, version: VERSION, requestId, ok: false, error: safeError(error) };
}

// Main-only endpoint. The trusted utility can read safe settings or submit one
// validated replacement. There is deliberately no secret read/decrypt operation,
// arbitrary method dispatch, renderer IPC handler, or transferable native port.
export function createAgentSettingsBroker({ agentSettings, send, isActive = () => true, getSelfPort = () => undefined }) {
  let closed = false;
  const pending = new Set(), completed = new Map();
  const active = () => !closed && isActive();
  const reply = message => {
    if (!active()) return;
    try { send(message); } catch { /* The child may have exited between the check and send. */ }
  };
  const remember = response => {
    completed.set(response.requestId, response);
    if (completed.size > 64) completed.delete(completed.keys().next().value);
  };
  return Object.freeze({
    handle(message) {
      if (message?.type !== REQUEST) return false;
      // Uncorrelatable messages get no response, and no part of the supplied
      // payload is echoed in a rejection.
      if (!validId(message.requestId) || !active()) return true;
      const { requestId } = message;
      if (!plainObject(message) || !boundedJson(message) || message.version !== VERSION ||
        Object.keys(message).some(key => !REQUEST_KEYS.has(key)) || !validPort(message.selfPort) ||
        !['get', 'put'].includes(message.operation) ||
        (message.operation === 'get' ? Object.hasOwn(message, 'input') : !plainObject(message.input))) {
        reply(errorResponse(requestId, transportError('VALIDATION_ERROR')));
        return true;
      }
      const selfPort = getSelfPort();
      if (!validPort(selfPort) || (selfPort !== undefined && selfPort !== message.selfPort)) {
        reply(errorResponse(requestId, transportError('VALIDATION_ERROR')));
        return true;
      }
      if (completed.has(requestId)) { reply(completed.get(requestId)); return true; }
      if (pending.has(requestId)) return true;
      if (pending.size >= MAX_PENDING) { reply(errorResponse(requestId, transportError('AGENT_SETTINGS_BUSY'))); return true; }
      if (!agentSettings || typeof agentSettings[message.operation] !== 'function') {
        reply(errorResponse(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'))); return true;
      }
      pending.add(requestId);
      // Snapshot only the bounded input. Nothing after this point references the
      // incoming envelope, and errors cannot serialize it or its plaintext key.
      const input = message.operation === 'put' ? JSON.parse(JSON.stringify(message.input)) : undefined;
      const operation = message.operation;
      const options = { selfPort: selfPort ?? message.selfPort };
      void (async () => {
        let response;
        try {
          if (!active()) return;
          const result = operation === 'get' ? await agentSettings.get(options) : await agentSettings.put(input, options);
          const data = sanitizeAgentSettingsResult(result);
          response = { type: RESPONSE, version: VERSION, requestId, ok: true, data };
          if (!boundedJson(response)) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        } catch (error) { response = errorResponse(requestId, error); }
        finally { pending.delete(requestId); }
        if (active()) { remember(response); reply(response); }
      })();
      return true;
    },
    close() { closed = true; pending.clear(); completed.clear(); }
  });
}

// Utility-only client over Electron's existing parentPort. Correlation and
// bounded deadlines prevent a dead main process from leaving HTTP saves hung.
export function createAgentSettingsClient({ port, timeout = 10000 }) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function' ||
    !Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
  let closed = false;
  const pending = new Map();
  const complete = (requestId, error, data) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(data);
  };
  const onMessage = ({ data: message } = {}) => {
    if (message?.type !== RESPONSE || !validId(message.requestId) || !pending.has(message.requestId)) return;
    if (!plainObject(message) || !boundedJson(message) || message.version !== VERSION ||
      Object.keys(message).some(key => !RESPONSE_KEYS.has(key)) || typeof message.ok !== 'boolean') {
      complete(message.requestId, transportError('AGENT_SETTINGS_UNAVAILABLE'));
      return;
    }
    try {
      if (message.ok) {
        if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'data')) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        complete(message.requestId, null, sanitizeAgentSettingsResult(message.data));
      } else {
        if (Object.hasOwn(message, 'data') || !plainObject(message.error)) throw transportError('AGENT_SETTINGS_UNAVAILABLE');
        const serialized = safeError(message.error);
        complete(message.requestId, Object.assign(new Error(serialized.message), { code: serialized.code, status: serialized.status }));
      }
    } catch { complete(message.requestId, transportError('AGENT_SETTINGS_UNAVAILABLE')); }
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
  const request = (operation, input, options) => {
    if (closed) return Promise.reject(transportError('AGENT_SETTINGS_UNAVAILABLE'));
    if (pending.size >= MAX_PENDING) return Promise.reject(transportError('AGENT_SETTINGS_BUSY'));
    if (!plainObject(options) || Object.keys(options).some(key => key !== 'selfPort') || !validPort(options.selfPort)) {
      return Promise.reject(transportError('VALIDATION_ERROR'));
    }
    const requestId = randomUUID();
    const message = { type: REQUEST, version: VERSION, requestId, operation, ...options,
      ...(operation === 'put' ? { input } : {}) };
    if (!boundedJson(message)) return Promise.reject(transportError('VALIDATION_ERROR'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => complete(requestId, transportError('AGENT_SETTINGS_TIMEOUT')), timeout);
      pending.set(requestId, { resolve, reject, timer });
      try { port.postMessage(message); }
      catch { complete(requestId, transportError('AGENT_SETTINGS_UNAVAILABLE')); }
    });
  };
  return Object.freeze({
    get(options = {}) { return request('get', undefined, options); },
    put(input, options = {}) { return request('put', input, options); },
    close
  });
}
