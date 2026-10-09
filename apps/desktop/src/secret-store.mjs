import path from 'node:path';
import { createAgentSettings, AGENT_CREDENTIAL_ACQUIRE } from '@mioon/business/agent/settings';
import { createAgentSettingsFile } from '@mioon/business/agent/settings-file';
import { agentSettingsError } from '@mioon/business/agent/config';
import { validatePrivateDirectory } from '@mioon/contracts/private-storage';
import desktopIdentity from '../identity.cjs';

const LINUX_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

const vaultError = (code = 'AGENT_SETTINGS_STORAGE_UNAVAILABLE') => agentSettingsError(code);

// This status is deliberately recomputed before every crypto operation: an OS
// keyring becoming unavailable must never turn a persistent write into plaintext.
export function desktopSecretStorage(safeStorage, platform = process.platform) {
  let reasonCode = null;
  try {
    if (safeStorage?.isEncryptionAvailable?.() !== true) reasonCode = 'OS_SECRET_STORE_UNAVAILABLE';
    else if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text') reasonCode = 'LINUX_BASIC_TEXT';
      else if (!LINUX_KEYRINGS.has(backend)) reasonCode = 'OS_SECRET_STORE_UNAVAILABLE';
    }
  } catch { reasonCode = 'OS_SECRET_STORE_UNAVAILABLE'; }
  return { persistentAvailable: reasonCode === null, sessionScope: 'app', reasonCode };
}

export function createDesktopSecretCodec({ safeStorage, appId, platform = process.platform }) {
  if (!['production', 'development'].some(channel => desktopIdentity.identityForChannel(channel).appId === appId)) throw vaultError();
  const requireVault = () => {
    if (!desktopSecretStorage(safeStorage, platform).persistentAvailable) throw vaultError();
  };
  return Object.freeze({
    encrypt(plaintext) {
      requireVault();
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
      try {
        // The shared engine binds a credential to its profile and origin. This
        // encrypted wrapper additionally binds it to the channel.
        const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, appId, plaintext }));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
        return encrypted.toString('base64');
      } catch { throw vaultError(); }
    },
    decrypt(ciphertext) {
      requireVault();
      try {
        if (typeof ciphertext !== 'string' || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT_BYTES * 2 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw vaultError();
        const buffer = Buffer.from(ciphertext, 'base64');
        if (!buffer.length || buffer.length > MAX_CIPHERTEXT_BYTES || buffer.toString('base64') !== ciphertext) throw vaultError();
        const decoded = safeStorage.decryptString(buffer);
        if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError();
        const value = JSON.parse(decoded);
        if (!value || value.version !== 1 || value.appId !== appId || typeof value.plaintext !== 'string' ||
          Object.keys(value).length !== 3 || Buffer.byteLength(value.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
        return value.plaintext;
      } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
    }
  });
}

// One instance belongs to main for the entire app session, not to an individual
// utility or project. A backend restart retains RAM-only credentials; app quit
// closes the engine and drops them. No public getter exposes the credential.
export async function createDesktopAgentSettings({ safeStorage, userData, appId, platform = process.platform }) {
  try {
    if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw vaultError();
    validatePrivateDirectory(userData);
    return await createAgentSettings({
      persistence: createAgentSettingsFile({ directory: path.join(userData, 'agent-settings'), privateRoot: userData }),
      secretCodec: createDesktopSecretCodec({ safeStorage, appId, platform }),
      storage: () => desktopSecretStorage(safeStorage, platform)
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
