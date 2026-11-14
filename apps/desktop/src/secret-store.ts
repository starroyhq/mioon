import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSettings, AGENT_CREDENTIAL_ACQUIRE } from '@mioon/business/agent/settings';
import type {AgentSettingsService} from '@mioon/business/agent/settings';
import { createAgentSettingsFile } from '@mioon/business/agent/settings-file';
import { agentSettingsError } from '@mioon/business/agent/config';
import { validatePrivateDirectory } from '@mioon/contracts/private-storage';
import desktopIdentity from '../identity.ts';
import {createLinuxDesktopSecretCodec, linuxDesktopSecretStorage} from './secret-store-linux.ts';

const MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_VAULT_REQUESTS = 16;
const VAULT_TIMEOUT = 1500;

/** Fixed reason codes only. No native error message, path or token crosses this boundary. */
export type SecretReasonCode = 'OS_SECRET_STORE_PENDING' | 'OS_SECRET_STORE_UNAVAILABLE' | 'LINUX_BASIC_TEXT' | null;
export interface SecretStorageState {
  readonly persistentAvailable: boolean;
  readonly sessionScope: 'app' | 'server';
  readonly reasonCode: SecretReasonCode;
}
/** Cancellation is a caller-scoped deadline; it never releases an unsettled native slot. */
export interface SecretOperationOptions {
  readonly signal?: AbortSignal;
  readonly isActive?: () => boolean;
}
/** The macOS/Linux Electron module surfaces this module is allowed to use. */
export interface AsyncSafeStorage {
  isEncryptionAvailable?(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString?(plaintext: string): Buffer;
  decryptString?(ciphertext: Buffer): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plaintext: string): Promise<Buffer>;
  decryptStringAsync(ciphertext: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
}
/** The synchronous Linux strong-keyring surface, intersected for Electron's module. */
export interface SyncSafeStorage {
  isEncryptionAvailable?(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}
export type DesktopSafeStorage = AsyncSafeStorage & SyncSafeStorage;
export interface DesktopSecretCodec {
  storage(): SecretStorageState;
  /** macOS refreshes the redacted snapshot without waiting for Keychain. */
  refreshStorage(options?: SecretOperationOptions): SecretStorageState | Promise<SecretStorageState>;
  encrypt(plaintext: string, options?: SecretOperationOptions): string | Promise<string>;
  decrypt(ciphertext: string, options?: SecretOperationOptions): string | Promise<string>;
  close(): void;
}
/** The trusted Agent settings engine surface main configures once per app session. */
export type DesktopAgentSettings = AgentSettingsService;
interface VaultState {
  phase: 'idle' | 'probing' | 'ready' | 'failed';
  busy: boolean;
  waiting: Set<VaultRequest>;
}
interface VaultRequest {
  start(): Promise<void>;
  reject(): void;
}

// Shared by Agent, Images, Video and replacement codecs for the same Electron module.
// A caller deadline never releases a slot owned by an unsettled native Promise.
const vaultStates = new WeakMap<object, VaultState>();

const vaultError = (code = 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'): Error => agentSettingsError(code);
/** Errors cross trusted boundaries by fixed code only; messages may be arbitrary. */
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function vaultState(safeStorage: unknown): VaultState | null {
  if (!safeStorage || !['object', 'function'].includes(typeof safeStorage)) return null;
  const key = safeStorage as object;
  if (!vaultStates.has(key)) vaultStates.set(key, {phase: 'idle', busy: false, waiting: new Set()});
  return vaultStates.get(key)!;
}

function drainVault(state: VaultState) {
  if (state.phase === 'failed') {
    for (const request of state.waiting) request.reject();
    return;
  }
  if (state.phase !== 'ready' || state.busy) return;
  const request = state.waiting.values().next().value;
  if (!request) return;
  state.waiting.delete(request);
  state.busy = true;
  void request.start();
}

const requiredMethods = ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync'] as const;
async function proveVault(safeStorage: DesktopSafeStorage, current = () => true) {
  // Electron can report true once initialized without having a usable key.
  if (!current()) throw vaultError();
  const available = await safeStorage.isAsyncEncryptionAvailable();
  if (available !== true || !current()) throw vaultError();
  const probe = 'mioon-vault-probe:' + randomUUID();
  const bytes = await safeStorage.encryptStringAsync(probe);
  if (!current() || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
  const decoded = await safeStorage.decryptStringAsync(bytes);
  if (decoded?.result !== probe || typeof decoded.shouldReEncrypt !== 'boolean') throw vaultError();
}

function initializeVault(state: VaultState, safeStorage: DesktopSafeStorage) {
  if (state.phase !== 'idle') return;
  if (!requiredMethods.every(name => typeof safeStorage[name] === 'function')) {
    state.phase = 'failed';
    drainVault(state);
    return;
  }
  state.phase = 'probing';
  // This probe belongs to the shared module. A closed window or expired
  // caller cannot cancel it or trigger a second Keychain request.
  void (async () => {
    try {
      await proveVault(safeStorage);
      state.phase = 'ready';
    } catch {
      // Electron caches a denied initializer for this native module.
      state.phase = 'failed';
    }
    drainVault(state);
  })();
}

const unavailableStorage = (): SecretStorageState =>
  ({persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'});

// A redacted snapshot only: it never calls a synchronous native vault method.
export function desktopSecretStorage(safeStorage: DesktopSafeStorage, platform: NodeJS.Platform = process.platform): SecretStorageState {
  if (platform === 'linux') return linuxDesktopSecretStorage(safeStorage);
  if (platform !== 'darwin') return unavailableStorage();
  const state = vaultState(safeStorage);
  if (state?.phase === 'probing') {
    return {persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_PENDING'};
  }
  return state?.phase === 'ready'
    ? {persistentAvailable: true, sessionScope: 'app', reasonCode: null}
    : unavailableStorage();
}

export function createDesktopSecretCodec({ safeStorage, appId, platform = process.platform, timeout = VAULT_TIMEOUT }: {
  safeStorage: DesktopSafeStorage; appId: string; platform?: NodeJS.Platform; timeout?: number;
}): DesktopSecretCodec {
  if (!['production', 'development'].some(channel => desktopIdentity.identityForChannel(channel).appId === appId) ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > VAULT_TIMEOUT) throw vaultError();
  // Static OS policy, never a fallback after a macOS async failure. Preserve
  // Linux's established strong-keyring format and synchronous limitations.
  if (platform === 'linux') return createLinuxDesktopSecretCodec({safeStorage, appId});
  const lifetime = new AbortController();
  const state = platform === 'darwin' ? vaultState(safeStorage) : null;
  const storage = (): SecretStorageState => lifetime.signal.aborted
    ? unavailableStorage()
    : desktopSecretStorage(safeStorage, platform);
  const active = (options: SecretOperationOptions) =>
    !lifetime.signal.aborted && !options.signal?.aborted && options.isActive?.() !== false;
  const run = <T>(operation: (current: () => boolean) => Promise<T>, options: SecretOperationOptions = {}): Promise<T> => {
    if (!state || state.phase === 'failed' || state.waiting.size + Number(state.busy) >= MAX_VAULT_REQUESTS || !active(options)) {
      return Promise.reject(vaultError());
    }
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    const deadline = performance.now() + timeout;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const current = () => !settled && performance.now() < deadline && active(options);
      const finish = (error: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        state.waiting.delete(request);
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(value as T);
      };
      const aborted = () => finish(vaultError());
      const request: VaultRequest = {
        reject: aborted,
        async start() {
          try {
            if (!current()) {
              aborted();
              return;
            }
            const value = await operation(current);
            if (current()) finish(null, value);
            else aborted();
          } catch (error) {
            if (!current()) {
              aborted();
              return;
            }
            const corrupt = errorCode(error) === 'AGENT_SETTINGS_CORRUPT';
            if (!corrupt) state.phase = 'failed';
            finish(vaultError(corrupt ? 'AGENT_SETTINGS_CORRUPT' : undefined));
          } finally {
            // A canceled caller no longer receives a result. The native slot
            // remains occupied until the operation itself has settled.
            state.busy = false;
            drainVault(state);
          }
        }
      };
      const timer = setTimeout(aborted, timeout);
      signal.addEventListener('abort', aborted, {once: true});
      state.waiting.add(request);
      initializeVault(state, safeStorage);
      drainVault(state);
    });
  };
  const codec: DesktopSecretCodec = {
    storage,
    async refreshStorage(options: SecretOperationOptions = {}): Promise<SecretStorageState> {
      if (!state || !active(options)) return unavailableStorage();
      initializeVault(state, safeStorage);
      // Give a cold proof one event loop turn. Occupying the initialized
      // crypto slot leaves availability unchanged.
      if (state.phase === 'probing') await new Promise<void>(resolve => setImmediate(resolve));
      return active(options) ? storage() : unavailableStorage();
    },
    async encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string> {
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
      return run(async () => {
        // The shared engine binds a credential to its profile and origin. This
        // encrypted wrapper additionally binds it to the channel.
        const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ version: 1, appId, plaintext }));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
        return encrypted.toString('base64');
      }, options);
    },
    async decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string> {
      let buffer: Buffer;
      try {
        if (typeof ciphertext !== 'string' || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT_BYTES * 2 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw vaultError();
        buffer = Buffer.from(ciphertext, 'base64');
        if (!buffer.length || buffer.length > MAX_CIPHERTEXT_BYTES || buffer.toString('base64') !== ciphertext) throw vaultError();
      } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
      return run(async current => {
        let result: Awaited<ReturnType<DesktopSafeStorage['decryptStringAsync']>>;
        try {
          result = await safeStorage.decryptStringAsync(buffer);
        } catch {
          // A native rejection can be an invalid ciphertext or an unavailable
          // key. Distinguish them on the same slot using non-secret input.
          try { await proveVault(safeStorage, current); }
          catch { throw vaultError(); }
          throw vaultError('AGENT_SETTINGS_CORRUPT');
        }
        try {
          const decoded = result?.result;
          if (typeof result?.shouldReEncrypt !== 'boolean') throw vaultError('AGENT_SETTINGS_CORRUPT');
          if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError('AGENT_SETTINGS_CORRUPT');
          const value = JSON.parse(decoded);
          if (!value || value.version !== 1 || value.appId !== appId || typeof value.plaintext !== 'string' ||
            Object.keys(value).length !== 3 || Buffer.byteLength(value.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError('AGENT_SETTINGS_CORRUPT');
          return value.plaintext;
        } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
      }, options);
    },
    close() { lifetime.abort(); }
  };
  return Object.freeze(codec);
}

// One instance belongs to main for the entire app session, not to an individual
// utility or project. A backend restart retains RAM-only credentials; app quit
// closes the engine and drops them. No public getter exposes the credential.
export async function createDesktopAgentSettings({ safeStorage, userData, appId, platform = process.platform, signal }: {
  safeStorage: DesktopSafeStorage; userData: string; appId: string; platform?: NodeJS.Platform; signal?: AbortSignal;
}): Promise<DesktopAgentSettings> {
  try {
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw vaultError();
    validatePrivateDirectory(userData);
    const secretCodec = createDesktopSecretCodec({ safeStorage, appId, platform });
    const settings: DesktopAgentSettings = await createAgentSettings({
      persistence: createAgentSettingsFile({ directory: path.join(userData, 'agent-settings'), privateRoot: userData }),
      secretCodec, storage: secretCodec.storage, signal
    });
    return settings;
  } catch {
    // A settings-specific initialization problem must not prevent unrelated
    // editing, job recovery or export from starting. Surface it only to callers
    // of the dedicated settings endpoint; never fall back to plaintext storage.
    return Object.freeze({
      async get(): Promise<never> { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async put(): Promise<never> { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async [AGENT_CREDENTIAL_ACQUIRE](): Promise<never> { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async close() {}
    });
  }
}
