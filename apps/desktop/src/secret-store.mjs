import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSettings, AGENT_CREDENTIAL_ACQUIRE } from '@mioon/business/agent/settings';
import { createAgentSettingsFile } from '@mioon/business/agent/settings-file';
import { agentSettingsError } from '@mioon/business/agent/config';
import { validatePrivateDirectory } from '@mioon/contracts/private-storage';
import desktopIdentity from '../identity.cjs';
import {createLinuxDesktopSecretCodec, linuxDesktopSecretStorage} from './secret-store-linux.mjs';

const MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_NATIVE_OPERATIONS = 16;
const VAULT_TIMEOUT = 1500;
// Shared by Agent, Images and replacement codecs for the same Electron module.
// A caller deadline never releases a slot owned by an unsettled native Promise.
const vaultStates = new WeakMap();

const vaultError = (code = 'AGENT_SETTINGS_STORAGE_UNAVAILABLE') => agentSettingsError(code);

function vaultState(safeStorage) {
  if (!safeStorage || !['object', 'function'].includes(typeof safeStorage)) return null;
  if (!vaultStates.has(safeStorage)) vaultStates.set(safeStorage, {inFlight: 0, available: false, failed: false, epoch: 0});
  return vaultStates.get(safeStorage);
}
function platformReason(_safeStorage, platform) {
  // Linux is selected separately before reaching this macOS async state.
  return platform === 'darwin' ? null : 'OS_SECRET_STORE_UNAVAILABLE';
}
// A redacted snapshot only: it never calls a synchronous native vault method.
export function desktopSecretStorage(safeStorage, platform = process.platform) {
  if (platform === 'linux') return linuxDesktopSecretStorage(safeStorage);
  const state = vaultState(safeStorage);
  const reasonCode = platformReason(safeStorage, platform) ||
    (!state?.available || state.failed ? 'OS_SECRET_STORE_UNAVAILABLE' : null);
  return { persistentAvailable: reasonCode === null, sessionScope: 'app', reasonCode };
}

export function createDesktopSecretCodec({ safeStorage, appId, platform = process.platform, timeout = VAULT_TIMEOUT }) {
  if (!['production', 'development'].some(channel => desktopIdentity.identityForChannel(channel).appId === appId) ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > VAULT_TIMEOUT) throw vaultError();
  // Static OS policy, never a fallback after a macOS async failure. Preserve
  // Linux's established strong-keyring format and synchronous limitations.
  if (platform === 'linux') return createLinuxDesktopSecretCodec({safeStorage, appId});
  const lifetime = new AbortController();
  const storage = () => lifetime.signal.aborted
    ? {persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'}
    : desktopSecretStorage(safeStorage, platform);
  const run = (operation, options = {}) => {
    const state = vaultState(safeStorage);
    if (lifetime.signal.aborted || !state || state.failed || state.inFlight >= MAX_NATIVE_OPERATIONS ||
        platformReason(safeStorage, platform) ||
        !['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync'].every(name => typeof safeStorage[name] === 'function')) {
      return Promise.reject(vaultError());
    }
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    if (signal.aborted || options.isActive?.() === false) return Promise.reject(vaultError());
    const epoch = state.epoch, deadline = performance.now() + timeout;
    state.inFlight++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const current = () => !settled && !signal.aborted && state.epoch === epoch && options.isActive?.() !== false;
      const failVault = () => {
        // Cancellation belongs to one request. Only a current native failure
        // may invalidate the shared initializer and other owners' operations.
        if (current()) { state.failed = true; state.available = false; state.epoch++; }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve(value);
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
      const invoke = async (name, value) => {
        checkpoint();
        let result;
        try { result = await safeStorage[name](value); }
        catch (error) {
          if (name !== 'decryptStringAsync') failVault();
          throw error;
        }
        checkpoint(); return result;
      };
      void (async () => {
        try {
          checkpoint();
          // Electron 44 reports true when initialization finishes, even without
          // a usable key. Prove actual crypto with disposable, non-secret input.
          try {
            if (await invoke('isAsyncEncryptionAvailable') !== true) throw vaultError();
            const probe = 'mioon-vault-probe:' + randomUUID();
            const bytes = await invoke('encryptStringAsync', probe);
            if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
            const decoded = await invoke('decryptStringAsync', bytes);
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
          if (error?.code !== 'AGENT_SETTINGS_CORRUPT') failVault();
          finish(vaultError(error?.code === 'AGENT_SETTINGS_CORRUPT' ? error.code : undefined));
        }
        finally { state.inFlight--; }
      })();
    });
  };
  return Object.freeze({
    storage,
    refreshStorage(options) {
      return run(async () => undefined, options).then(storage).catch(() => ({persistentAvailable: false, sessionScope: 'app', reasonCode: platformReason(safeStorage, platform) || 'OS_SECRET_STORE_UNAVAILABLE'}));
    },
    async encrypt(plaintext, options) {
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
      return run(async invoke => {
        // The shared engine binds a credential to its profile and origin. This
        // encrypted wrapper additionally binds it to the channel.
        const encrypted = await invoke('encryptStringAsync', JSON.stringify({ version: 1, appId, plaintext }));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
        return encrypted.toString('base64');
      }, options);
    },
    async decrypt(ciphertext, options) {
      let buffer;
      try {
        if (typeof ciphertext !== 'string' || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT_BYTES * 2 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw vaultError();
        buffer = Buffer.from(ciphertext, 'base64');
        if (!buffer.length || buffer.length > MAX_CIPHERTEXT_BYTES || buffer.toString('base64') !== ciphertext) throw vaultError();
      } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
      return run(async invoke => {
        try {
          const result = await invoke('decryptStringAsync', buffer);
          const decoded = result?.result;
          if (typeof result?.shouldReEncrypt !== 'boolean') throw vaultError('AGENT_SETTINGS_CORRUPT');
          if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError('AGENT_SETTINGS_CORRUPT');
          const value = JSON.parse(decoded);
          if (!value || value.version !== 1 || value.appId !== appId || typeof value.plaintext !== 'string' ||
            Object.keys(value).length !== 3 || Buffer.byteLength(value.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError('AGENT_SETTINGS_CORRUPT');
          return value.plaintext;
        } catch (error) {
          if (error?.code === 'AGENT_SETTINGS_STORAGE_UNAVAILABLE') throw error;
          throw vaultError('AGENT_SETTINGS_CORRUPT');
        }
      }, options);
    },
    close() { lifetime.abort(); }
  });
}

// One instance belongs to main for the entire app session, not to an individual
// utility or project. A backend restart retains RAM-only credentials; app quit
// closes the engine and drops them. No public getter exposes the credential.
export async function createDesktopAgentSettings({ safeStorage, userData, appId, platform = process.platform, signal }) {
  try {
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw vaultError();
    validatePrivateDirectory(userData);
    const secretCodec = createDesktopSecretCodec({ safeStorage, appId, platform });
    return await createAgentSettings({
      persistence: createAgentSettingsFile({ directory: path.join(userData, 'agent-settings'), privateRoot: userData }),
      secretCodec, storage: secretCodec.storage, signal
    });
  } catch {
    // A settings-specific initialization problem must not prevent unrelated
    // editing, job recovery or export from starting. Surface it only to callers
    // of the dedicated settings endpoint; never fall back to plaintext storage.
    return Object.freeze({
      async get() { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async put() { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async [AGENT_CREDENTIAL_ACQUIRE]() { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); },
      async close() {}
    });
  }
}
