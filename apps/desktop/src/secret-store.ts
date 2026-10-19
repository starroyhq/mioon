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
const MAX_NATIVE_OPERATIONS = 16;
const VAULT_TIMEOUT = 1500;

/** Fixed reason codes only. No native error message, path or token crosses this boundary. */
export type SecretReasonCode = 'OS_SECRET_STORE_UNAVAILABLE' | 'LINUX_BASIC_TEXT' | null;
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
  /** Linux returns synchronously; macOS resolves asynchronously. */
  refreshStorage(options?: SecretOperationOptions): SecretStorageState | Promise<SecretStorageState>;
  encrypt(plaintext: string, options?: SecretOperationOptions): string | Promise<string>;
  decrypt(ciphertext: string, options?: SecretOperationOptions): string | Promise<string>;
  close(): void;
}
/** The trusted Agent settings engine surface main configures once per app session. */
export type DesktopAgentSettings = AgentSettingsService;
interface VaultState {
  inFlight: number;
  available: boolean;
  failed: boolean;
  epoch: number;
}
interface NativeInvoke {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
}

// Shared by Agent, Images and replacement codecs for the same Electron module.
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
  if (!vaultStates.has(key)) vaultStates.set(key, {inFlight: 0, available: false, failed: false, epoch: 0});
  return vaultStates.get(key)!;
}
function platformReason(_safeStorage: unknown, platform: NodeJS.Platform): SecretReasonCode {
  // Linux is selected separately before reaching this macOS async state.
  return platform === 'darwin' ? null : 'OS_SECRET_STORE_UNAVAILABLE';
}
// A redacted snapshot only: it never calls a synchronous native vault method.
export function desktopSecretStorage(safeStorage: DesktopSafeStorage, platform: NodeJS.Platform = process.platform): SecretStorageState {
  if (platform === 'linux') return linuxDesktopSecretStorage(safeStorage);
  const state = vaultState(safeStorage);
  const reasonCode = platformReason(safeStorage, platform) ||
    (!state?.available || state.failed ? 'OS_SECRET_STORE_UNAVAILABLE' : null);
  return { persistentAvailable: reasonCode === null, sessionScope: 'app', reasonCode };
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
  const storage = (): SecretStorageState => lifetime.signal.aborted
    ? {persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'}
    : desktopSecretStorage(safeStorage, platform);
  const requiredMethods = ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync'] as const;
  const run = <T>(operation: (invoke: NativeInvoke) => Promise<T>, options: SecretOperationOptions = {}): Promise<T> => {
    const state = vaultState(safeStorage);
    if (lifetime.signal.aborted || !state || state.failed || state.inFlight >= MAX_NATIVE_OPERATIONS ||
        platformReason(safeStorage, platform) ||
        !requiredMethods.every(name => typeof safeStorage[name] === 'function')) {
      return Promise.reject(vaultError());
    }
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    if (signal.aborted || options.isActive?.() === false) return Promise.reject(vaultError());
    const epoch = state.epoch, deadline = performance.now() + timeout;
    state.inFlight++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const current = () => !settled && !signal.aborted && state.epoch === epoch && options.isActive?.() !== false;
      const failVault = () => {
        // Cancellation belongs to one request. Only a current native failure
        // may invalidate the shared initializer and other owners' operations.
        if (current()) { state.failed = true; state.available = false; state.epoch++; }
      };
      const finish = (error: Error | null, value?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(value as T);
      };
      const expired = () => { if (!settled) { failVault(); finish(vaultError()); } };
      const aborted = () => finish(vaultError());
      const timer = setTimeout(expired, timeout);
      signal.addEventListener('abort', aborted, {once: true});
      const checkpoint = () => {
        if (settled) throw vaultError();
        if (performance.now() >= deadline) expired();
        if (settled || signal.aborted || state.failed || state.epoch !== epoch || options.isActive?.() === false) throw vaultError();
      };
      const invoke: NativeInvoke = {
        async isAsyncEncryptionAvailable() {
          checkpoint();
          try { return await safeStorage.isAsyncEncryptionAvailable(); }
          catch (error) { failVault(); throw error; }
        },
        async encryptStringAsync(value: string) {
          checkpoint();
          try { return await safeStorage.encryptStringAsync(value); }
          catch (error) { failVault(); throw error; }
        },
        async decryptStringAsync(value: Buffer) {
          checkpoint();
          try { return await safeStorage.decryptStringAsync(value); }
          catch (error) { throw error; }
        }
      };
      void (async () => {
        try {
          checkpoint();
          // Electron 44 reports true when initialization finishes, even without
          // a usable key. Prove actual crypto with disposable, non-secret input.
          try {
            if (await invoke.isAsyncEncryptionAvailable() !== true) throw vaultError();
            const probe = 'mioon-vault-probe:' + randomUUID();
            const bytes = await invoke.encryptStringAsync(probe);
            if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
            const decoded = await invoke.decryptStringAsync(bytes);
            if (decoded?.result !== probe || typeof decoded.shouldReEncrypt !== 'boolean') throw vaultError();
          } catch (error) {
            // The native initializer caches failure; repeated status calls do
            // not acquire a new key. Only a new app/native module may retry.
            failVault();
            throw error;
          }
          checkpoint();
          const value = await operation(invoke);
          checkpoint(); state.available = true; finish(null, value);
        } catch (error) {
          const code = errorCode(error);
          if (code !== 'AGENT_SETTINGS_CORRUPT') failVault();
          finish(vaultError(code === 'AGENT_SETTINGS_CORRUPT' ? code : undefined));
        }
        finally { state.inFlight--; }
      })();
    });
  };
  const codec: DesktopSecretCodec = {
    storage,
    refreshStorage(options?: SecretOperationOptions): Promise<SecretStorageState> {
      return run(async () => undefined, options).then(storage).catch(() => ({persistentAvailable: false, sessionScope: 'app',
        reasonCode: platformReason(safeStorage, platform) || 'OS_SECRET_STORE_UNAVAILABLE'}));
    },
    async encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string> {
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
      return run(async invoke => {
        // The shared engine binds a credential to its profile and origin. This
        // encrypted wrapper additionally binds it to the channel.
        const encrypted = await invoke.encryptStringAsync(JSON.stringify({ version: 1, appId, plaintext }));
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
      return run(async invoke => {
        try {
          const result = await invoke.decryptStringAsync(buffer);
          const decoded = result?.result;
          if (typeof result?.shouldReEncrypt !== 'boolean') throw vaultError('AGENT_SETTINGS_CORRUPT');
          if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError('AGENT_SETTINGS_CORRUPT');
          const value = JSON.parse(decoded);
          if (!value || value.version !== 1 || value.appId !== appId || typeof value.plaintext !== 'string' ||
            Object.keys(value).length !== 3 || Buffer.byteLength(value.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError('AGENT_SETTINGS_CORRUPT');
          return value.plaintext;
        } catch (error) {
          if (errorCode(error) === 'AGENT_SETTINGS_STORAGE_UNAVAILABLE') throw error;
          throw vaultError('AGENT_SETTINGS_CORRUPT');
        }
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
