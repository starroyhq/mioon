import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from './presets.ts';
import {agentSettingsError, safeAgentSettingsError, exactObject, parseAgentConfiguration, parseAgentSettingsUpdate, agentCredentialBinding} from './config.ts';
import type {AgentConfiguration, AgentSettingsUpdate} from './config.ts';
import type {AgentSettingsFile} from './settings-file.ts';

export const sanitizeAgentSettingsError = safeAgentSettingsError;
// A trusted-module capability, deliberately absent from string-based HTTP/RPC
// dispatch and the public settings DTO. Renderer code never imports this symbol.
export const AGENT_CREDENTIAL_ACQUIRE = Symbol('trusted Agent inference credential');
export interface AgentCredentialRequest {expectedRevision: number; configuration: AgentConfiguration}
export function parseAgentCredentialRequest(value: unknown, options: {selfPort?: number} = {}): AgentCredentialRequest {
  if (!exactObject(value, ['expectedRevision', 'configuration']) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
  const configuration = parseAgentConfiguration(value.configuration, options);
  if (JSON.stringify(configuration) !== JSON.stringify(value.configuration)) throw agentSettingsError('AGENT_SETTINGS_VALIDATION');
  return {expectedRevision: value.expectedRevision as number, configuration};
}
export interface AgentCredentialResult {revision: number; configuration: AgentConfiguration; apiKey: string | null}
export function sanitizeAgentCredentialResult(value: unknown, expected: AgentCredentialRequest): AgentCredentialResult {
  if (!exactObject(value, ['revision', 'configuration', 'apiKey']) || value.revision !== expected.expectedRevision || JSON.stringify(value.configuration) !== JSON.stringify(expected.configuration)) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
  if (value.apiKey !== null) parseAgentSettingsUpdate({expectedRevision: value.revision, configuration: value.configuration, secret: {action: 'replace', storage: 'session', value: value.apiKey}});
  return {revision: value.revision as number, configuration: {...expected.configuration}, apiKey: value.apiKey as string | null};
}
export interface PublicStorage {persistentAvailable: boolean; sessionScope: string; reasonCode: string | null}
function boundedCredentialRead<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) reject(agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE')); else resolve(value as T);
    };
    const aborted = () => finish(true);
    const timer = setTimeout(aborted, 5000);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, {once: true});
    Promise.resolve().then(() => { if (signal?.aborted) throw agentSettingsError('AGENT_SETTINGS_CLOSED'); return operation(); }).then(value => finish(null, value), () => finish(true));
  });
}
const storageReasons = new Set<unknown>([null, 'WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT']);
function publicStorage(value: unknown): PublicStorage {
  const record = value as {persistentAvailable?: unknown; sessionScope?: unknown; reasonCode?: unknown} | null | undefined;
  if (!record || typeof record.persistentAvailable !== 'boolean' || !['app', 'server'].includes(record.sessionScope as string) || !storageReasons.has(record.reasonCode)) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
  return {persistentAvailable: record.persistentAvailable, sessionScope: record.sessionScope as string, reasonCode: record.reasonCode as string | null};
}
export interface AgentSettingsSnapshot {
  revision: number;
  configuration: AgentConfiguration;
  secret: {configured: boolean; storage: string};
  storage: PublicStorage;
  presets: typeof AGENT_PRESETS;
  scope: 'settings_only';
  verification: 'not_tested';
}
/** Explicit result allowlist, also used by the trusted desktop broker. Never
 * spread internal state/envelopes/errors into public transport messages. */
export function sanitizeAgentSettingsResult(value: unknown): AgentSettingsSnapshot {
  const record = value as {revision?: unknown; secret?: {configured?: unknown; storage?: unknown}; configuration?: unknown; storage?: unknown} | null | undefined;
  if (!record || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || typeof record.secret?.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(record.secret.storage as string) || record.secret.configured !== (record.secret.storage !== 'none')) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = parseAgentConfiguration(record.configuration);
  return {revision: record.revision as number, configuration, secret: {configured: record.secret.configured, storage: record.secret.storage as string}, storage: publicStorage(record.storage), presets: structuredClone(AGENT_PRESETS), scope: 'settings_only', verification: 'not_tested'};
}
// The only legacy projection lives on the read path. Public DTOs, writes and
// trusted acquisition always require an explicit protocol; no default fallback.
function parseLegacyConfiguration(value: unknown): AgentConfiguration {
  if (!exactObject(value, ['presetId', 'platformId', 'baseUrl', 'model'])) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = parseAgentConfiguration({...value, protocol: 'chat_completions'});
  const {protocol: _protocol, ...legacy} = configuration;
  if (JSON.stringify(legacy) !== JSON.stringify(value)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  return configuration;
}
interface LoadedSecret {binding: string; encrypted: string}
interface StateEnvelope {version: number; revision: number; configuration: AgentConfiguration; secret: LoadedSecret | null}
function parseEnvelope(value: unknown): StateEnvelope {
  if (!exactObject(value, ['version', 'revision', 'configuration', 'secret']) || ![1, 2].includes(value.version as number) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  const configuration = value.version === 1 ? parseLegacyConfiguration(value.configuration) : parseAgentConfiguration(value.configuration);
  if (value.version === 2 && JSON.stringify(configuration) !== JSON.stringify(value.configuration)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
  let secret: LoadedSecret | null = null;
  if (value.secret !== null) {
    if (!exactObject(value.secret, ['binding', 'encrypted']) || value.secret.binding !== agentCredentialBinding(configuration) || typeof value.secret.encrypted !== 'string' || !value.secret.encrypted || value.secret.encrypted.length > 48 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.secret.encrypted)) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
    secret = {binding: value.secret.binding as string, encrypted: value.secret.encrypted};
  }
  // Projection changes no bytes on disk, revision, binding or ciphertext.
  return {version: 2, revision: value.revision as number, configuration, secret};
}
export interface SettingsContextOptions {selfPort?: number; signal?: AbortSignal; isActive?: () => boolean}
export interface SecretCodec {
  refreshStorage?(options?: SettingsContextOptions): Promise<unknown> | unknown;
  decrypt?(encrypted: string, options?: SettingsContextOptions): Promise<unknown> | unknown;
  encrypt?(value: string, options?: SettingsContextOptions): Promise<unknown> | unknown;
  close?(): void;
}
export interface AgentSettingsDependencies {
  persistence: AgentSettingsFile;
  secretCodec?: SecretCodec;
  storage?: PublicStorage | (() => PublicStorage);
  signal?: AbortSignal;
}
export interface AgentSettingsService {
  get(options?: SettingsContextOptions): Promise<AgentSettingsSnapshot>;
  [AGENT_CREDENTIAL_ACQUIRE](input: unknown, options?: SettingsContextOptions): Promise<AgentCredentialResult>;
  put(input: unknown, options?: SettingsContextOptions): Promise<AgentSettingsSnapshot>;
  close(): Promise<void>;
}
/** Single active Agent profile; not the video-provider registry. Secrets are
 * write-only publicly; trusted inference acquisition is an unexported-to-HTTP capability. */
export async function createAgentSettings({persistence, secretCodec, storage = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, signal}: AgentSettingsDependencies): Promise<AgentSettingsService> {
  let state: StateEnvelope = {version: 2, revision: 0, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: null};
  let session: {binding: string; value: string} | null = null, fault: Error | null = null, tail: Promise<unknown> = Promise.resolve(), closing = false, vaultReadBlocked = false, refreshBlocked = false;
  const lifetime = new AbortController();
  const controls = (options: SettingsContextOptions = {}): SettingsContextOptions & {signal: AbortSignal} => ({...options, signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal});
  const checkpoint = (options?: SettingsContextOptions): void => {
    if (closing || options?.signal?.aborted || options?.isActive?.() === false) throw agentSettingsError('AGENT_SETTINGS_CLOSED');
  };
  const refreshCapabilities = async (options?: SettingsContextOptions): Promise<void> => {
    if (typeof secretCodec?.refreshStorage !== 'function') return;
    try {
      const value = await boundedCredentialRead(() => (secretCodec as SecretCodec).refreshStorage!(options), options?.signal);
      refreshBlocked = !publicStorage(value).persistentAvailable;
    } catch { refreshBlocked = true; }
  };
  const capabilities = (): PublicStorage => {
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
          const decoded = JSON.parse(await boundedCredentialRead(() => (secretCodec as SecretCodec).decrypt!(state.secret!.encrypted, initialization), initialization.signal) as string);
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
  function schedule<T>(operation: () => T | Promise<T>): Promise<T> {
    if (closing) return Promise.reject(agentSettingsError('AGENT_SETTINGS_CLOSED'));
    const result = tail.then(() => { if (closing) throw agentSettingsError('AGENT_SETTINGS_CLOSED'); if (fault) throw fault; return operation(); });
    tail = result.catch(() => {});
    return result;
  }
  const snapshot = (): AgentSettingsSnapshot => sanitizeAgentSettingsResult({revision: state.revision, configuration: state.configuration, secret: {configured: Boolean(state.secret || session), storage: state.secret ? 'persistent' : session ? 'session' : 'none'}, storage: capabilities()});
  return {
    get(options: SettingsContextOptions = {}) {
      const context = controls(options);
      return schedule(async () => { checkpoint(context); await refreshCapabilities(context); checkpoint(context); return snapshot(); });
    },
    [AGENT_CREDENTIAL_ACQUIRE](input: unknown, options: SettingsContextOptions = {}) {
      let expected: AgentCredentialRequest;
      try { expected = parseAgentCredentialRequest(input, options); } catch (error) { return Promise.reject(error); }
      const context = controls(options), signal = context.signal;
      return schedule(async () => {
        checkpoint(context);
        if (state.revision !== expected.expectedRevision || JSON.stringify(state.configuration) !== JSON.stringify(expected.configuration)) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
        const binding = agentCredentialBinding(expected.configuration);
        let apiKey: string | null = null;
        if (state.secret) {
          await refreshCapabilities(context); checkpoint(context);
          if (!secretCodec || !capabilities().persistentAvailable || state.secret.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
          try {
            const decoded = JSON.parse(await boundedCredentialRead(() => (secretCodec as SecretCodec).decrypt!(state.secret!.encrypted, context), signal) as string);
            if (!exactObject(decoded, ['version', 'binding', 'value']) || decoded.version !== 1 || decoded.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_CORRUPT');
            apiKey = decoded.value as string;
          } catch { throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'); }
        } else if (session) {
          if (session.binding !== binding) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
          apiKey = session.value;
        }
        checkpoint(context);
        return sanitizeAgentCredentialResult({revision: state.revision, configuration: state.configuration, apiKey}, expected);
      });
    },
    put(input: unknown, options: SettingsContextOptions = {}) {
      // Snapshot/validate before scheduling so callers cannot mutate queued input.
      let update: AgentSettingsUpdate;
      try { update = parseAgentSettingsUpdate(input, options); } catch (error) { return Promise.reject(error); }
      const context = controls(options);
      return schedule(async () => {
        checkpoint(context);
        if (update.expectedRevision !== state.revision) throw agentSettingsError('AGENT_SETTINGS_CONFLICT');
        if (state.revision === Number.MAX_SAFE_INTEGER) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        const binding = agentCredentialBinding(update.configuration);
        const sameBinding = binding === agentCredentialBinding(state.configuration);
        let nextSecret: LoadedSecret | null = sameBinding ? state.secret : null;
        let nextSession: {binding: string; value: string} | null = sameBinding ? session : null;
        if (update.secret.action === 'remove') { nextSecret = null; nextSession = null; }
        if (update.secret.action === 'replace') {
          nextSecret = null; nextSession = null;
          if (update.secret.storage === 'persistent') {
            await refreshCapabilities(context); checkpoint(context);
            if (!secretCodec || !capabilities().persistentAvailable) throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE');
            let encrypted: string;
            try { encrypted = await boundedCredentialRead(() => (secretCodec as SecretCodec).encrypt!(JSON.stringify({version: 1, binding, value: (update.secret as {value: string}).value}), context), context.signal) as string; }
            catch { throw agentSettingsError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'); }
            nextSecret = {binding, encrypted};
          } else nextSession = {binding, value: (update.secret as {value: string}).value};
        }
        const candidate: StateEnvelope = {version: 2, revision: state.revision + 1, configuration: update.configuration, secret: nextSecret};
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
