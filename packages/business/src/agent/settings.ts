import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from './presets.ts';
import {agentSettingsError, safeAgentSettingsError, exactObject, parseAgentConfiguration, parseAgentSettingsUpdate, agentCredentialBinding} from './config.ts';

export const sanitizeAgentSettingsError = safeAgentSettingsError;
// A trusted-module capability, deliberately absent from string-based HTTP/RPC
// dispatch and the public settings DTO. Renderer code never imports this symbol.
export const AGENT_CREDENTIAL_ACQUIRE = Symbol('trusted Agent inference credential');
export function parseAgentCredentialRequest(value, options = {}) {
  if (!exactObject(value, ['expectedRevision', 'configuration']) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
  const configuration = parseAgentConfiguration(value.configuration, options);
  if (JSON.stringify(configuration) !== JSON.stringify(value.configuration)) throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
  return {expectedRevision: value.expectedRevision, configuration};
}
export function sanitizeAgentCredentialResult(value, expected) {
  if (!exactObject(value, ['revision', 'configuration', 'apiKey']) || value.revision !== expected.expectedRevision || JSON.stringify(value.configuration) !== JSON.stringify(expected.configuration)) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
  if (value.apiKey !== null) parseAgentSettingsUpdate({expectedRevision: value.revision, configuration: value.configuration, secret: {action: 'replace', storage: 'session', value: value.apiKey}});
  return {revision: value.revision, configuration: {...expected.configuration}, apiKey: value.apiKey};
}
function boundedCredentialRead(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) reject(agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE')); else resolve(value);
    };
    const aborted = () => finish(true);
    const timer = setTimeout(aborted, 5000);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => { if (signal?.aborted) throw agentSettingsError('AGENT_SETTINGS_CLOSED'); return operation(); }).then(value => finish(null, value), () => finish(true));
  });
}
const storageReasons = new Set([null, 'WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT']);
function publicStorage(value) {
  if (!value || typeof value.persistentAvailable !== 'boolean' || !['app', 'server'].includes(value.sessionScope) || !storageReasons.has(value.reasonCode)) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
  return {persistentAvailable: value.persistentAvailable, sessionScope: value.sessionScope, reasonCode: value.reasonCode};
}
/** Explicit result allowlist, also used by the trusted desktop broker. Never
 * spread internal state/envelopes/errors into public transport messages. */
export function sanitizeAgentSettingsResult(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.secret?.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(value.secret.storage) || value.secret.configured !== (value.secret.storage !== 'none')) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = parseAgentConfiguration(value.configuration);
  return {revision: value.revision, configuration, secret: {configured: value.secret.configured, storage: value.secret.storage}, storage: publicStorage(value.storage), presets: structuredClone(AGENT_PRESETS), scope: 'settings_only', verification: 'not_tested'};
}
// The only legacy projection lives on the read path. Public DTOs, writes and
// trusted acquisition always require an explicit protocol; no default fallback.
function parseLegacyConfiguration(value) {
  if (!exactObject(value, ['presetId', 'platformId', 'baseUrl', 'model'])) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = parseAgentConfiguration({...value, protocol: 'chat_completions'});
  const {protocol, ...legacy} = configuration;
  if (JSON.stringify(legacy) !== JSON.stringify(value)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  return configuration;
}
function parseEnvelope(value) {
  if (!exactObject(value, ['version', 'revision', 'configuration', 'secret']) || ![1, 2].includes(value.version) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = value.version === 1 ? parseLegacyConfiguration(value.configuration) : parseAgentConfiguration(value.configuration);
  if (value.version === 2 && JSON.stringify(configuration) !== JSON.stringify(value.configuration)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  let secret = null;
  if (value.secret !== null) {
    if (!exactObject(value.secret, ['binding', 'encrypted']) || value.secret.binding !== agentCredentialBinding(configuration) || typeof value.secret.encrypted !== 'string' || !value.secret.encrypted || value.secret.encrypted.length > 48 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.secret.encrypted)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
    secret = {binding: value.secret.binding, encrypted: value.secret.encrypted};
  }
  // Projection changes no bytes on disk, revision, binding or ciphertext.
  return {version: 2, revision: value.revision, configuration, secret};
}
/** Single active Agent profile; not the video-provider registry. Secrets are
 * write-only publicly; trusted inference acquisition is an unexported-to-HTTP capability. */
export async function createAgentSettings({persistence, secretCodec, storage = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, signal}) {
  let state = {version: 2, revision: 0, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: null};
  let session = null, fault = null, tail = Promise.resolve(), closing = false, vaultReadBlocked = false, refreshBlocked = false;
  const lifetime = new AbortController();
  const controls = (options = {}) => ({...options, signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal});
  const checkpoint = options => {
    if (closing || options?.signal?.aborted || options?.isActive?.() === false) throw agentSettingsError('AGENT_SETTINGS_CLOSED');
  };
  const refreshCapabilities = async options => {
    if (typeof secretCodec?.refreshStorage !== 'function') return;
    try {
      const value = await boundedCredentialRead(() => secretCodec.refreshStorage(options), options?.signal);
      refreshBlocked = !publicStorage(value).persistentAvailable;
    } catch { refreshBlocked = true; }
  };
  const capabilities = () => {
    const value = publicStorage(typeof storage === 'function' ? storage() : storage);
    return vaultReadBlocked || refreshBlocked ? {...value, persistentAvailable: false, reasonCode: value.reasonCode || 'OS_SECRET_STORE_UNAVAILABLE'} : value;
  };
  const initialization = controls({signal});
  await refreshCapabilities(initialization);
  try {
    const loaded = await persistence.load();
    if (loaded !== null) state = parseEnvelope(loaded);
    if (state.secret) {
      // A web server has no vault and must never adopt a desktop envelope.
      if (!secretCodec) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
      if (capabilities().persistentAvailable) {
        try {
          const decoded = JSON.parse(await boundedCredentialRead(() => secretCodec.decrypt(state.secret.encrypted, initialization), initialization.signal));
          if (!exactObject(decoded, ['version', 'binding', 'value']) || decoded.version !== 1 || decoded.binding !== state.secret.binding) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
          // Reuse key bounds/control validation without ever exposing a getter.
          parseAgentSettingsUpdate({expectedRevision: state.revision, configuration: state.configuration, secret: {action: 'replace', storage: 'persistent', value: decoded.value}});
        } catch {
          // A locked vault and an unreadable ciphertext cannot be distinguished
          // safely here. Keep the stored envelope, forbid its use, and allow an
          // explicit removal or newly entered session-only replacement.
          vaultReadBlocked = true;
        }
      }
    }
  } catch { fault = agentSettingsError('AGENT_SETTINGS_CORRUPT'); }
  function schedule(operation) {
    if (closing) return Promise.reject(agentSettingsError('AGENT_SETTINGS_CLOSED'));
    const result = tail.then(() => { if (closing) throw agentSettingsError('AGENT_SETTINGS_CLOSED'); if (fault) throw fault; return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  const snapshot = () => sanitizeAgentSettingsResult({revision: state.revision, configuration: state.configuration, secret: {configured: Boolean(state.secret || session), storage: state.secret ? 'persistent' : session ? 'session' : 'none'}, storage: capabilities()});
  return {
    get(options = {}) {
      const context = controls(options);
      return schedule(async () => { checkpoint(context); await refreshCapabilities(context); checkpoint(context); return snapshot(); });
    },
    [AGENT_CREDENTIAL_ACQUIRE](input, options = {}) {
      let expected;
      try { expected = parseAgentCredentialRequest(input, options); } catch (error) { return Promise.reject(error); }
      const context = controls(options), signal = context.signal;
      return schedule(async () => {
        checkpoint(context);
        if (state.revision !== expected.expectedRevision || JSON.stringify(state.configuration) !== JSON.stringify(expected.configuration)) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
        const binding = agentCredentialBinding(expected.configuration);
        let apiKey = null;
        if (state.secret) {
          await refreshCapabilities(context); checkpoint(context);
          if (!secretCodec || !capabilities().persistentAvailable || state.secret.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
          try {
            const decoded = JSON.parse(await boundedCredentialRead(() => secretCodec.decrypt(state.secret.encrypted, context), signal));
            if (!exactObject(decoded, ['version', 'binding', 'value']) || decoded.version !== 1 || decoded.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
            apiKey = decoded.value;
          } catch { throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'); }
        } else if (session) {
          if (session.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
          apiKey = session.value;
        }
        checkpoint(context);
        return sanitizeAgentCredentialResult({revision: state.revision, configuration: state.configuration, apiKey}, expected);
      });
    },
    put(input, options = {}) {
      // Snapshot/validate before scheduling so callers cannot mutate queued input.
      let update;
      try { update = parseAgentSettingsUpdate(input, options); } catch (error) { return Promise.reject(error); }
      const context = controls(options);
      return schedule(async () => {
        checkpoint(context);
        if (update.expectedRevision !== state.revision) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
        if (state.revision === Number.MAX_SAFE_INTEGER) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        const binding = agentCredentialBinding(update.configuration);
        const sameBinding = binding === agentCredentialBinding(state.configuration);
        let nextSecret = sameBinding ? state.secret : null;
        let nextSession = sameBinding ? session : null;
        if (update.secret.action === 'remove') { nextSecret = null; nextSession = null; }
        if (update.secret.action === 'replace') {
          nextSecret = null; nextSession = null;
          if (update.secret.storage === 'persistent') {
            await refreshCapabilities(context); checkpoint(context);
            if (!secretCodec || !capabilities().persistentAvailable) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
            let encrypted;
            try { encrypted = await boundedCredentialRead(() => secretCodec.encrypt(JSON.stringify({version: 1, binding, value: update.secret.value}), context), context.signal); }
            catch { throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'); }
            nextSecret = {binding, encrypted};
          } else nextSession = {binding, value: update.secret.value};
        }
        const candidate = {version: 2, revision: state.revision + 1, configuration: update.configuration, secret: nextSecret};
        // Validate the encrypted codec result before it reaches persistent storage.
        try { parseEnvelope(candidate); } catch { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); }
        // Cancellation can stop a late encryption result before the atomic save
        // starts. Once save has begun, preserve the durable/RAM commit pairing.
        checkpoint(context);
        try { await persistence.save(candidate); }
        catch { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); }
        // Only commit RAM after the single atomic envelope has committed.
        state = candidate; session = nextSession;
        return snapshot();
      });
    },
    async close() { closing = true; lifetime.abort(); secretCodec?.close?.(); await tail; session = null; },
  };
}
