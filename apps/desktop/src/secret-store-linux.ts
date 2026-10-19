import { agentSettingsError } from '@mioon/business/agent/config';
import desktopIdentity from '../identity.ts';
import type {DesktopSecretCodec, SecretOperationOptions, SecretReasonCode, SecretStorageState, SyncSafeStorage} from './secret-store.ts';

const LINUX_KEYRINGS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const vaultError = (code = 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'): Error => agentSettingsError(code);
const unavailable = (): SecretStorageState => ({ persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE' });

/** The synchronous Electron module surface the Linux strong-keyring path uses. */
export type LinuxSafeStorage = SyncSafeStorage;

// Linux retains Electron's existing synchronous strong-keyring path. Capability
// is recomputed before every crypto operation; basic_text is never a fallback.
export function linuxDesktopSecretStorage(safeStorage: LinuxSafeStorage): SecretStorageState {
  let reasonCode: SecretReasonCode = null;
  try {
    if (safeStorage?.isEncryptionAvailable?.() !== true) reasonCode = 'OS_SECRET_STORE_UNAVAILABLE';
    else {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (backend === 'basic_text') reasonCode = 'LINUX_BASIC_TEXT';
      else if (backend === undefined || !LINUX_KEYRINGS.has(backend)) reasonCode = 'OS_SECRET_STORE_UNAVAILABLE';
    }
  } catch { reasonCode = 'OS_SECRET_STORE_UNAVAILABLE'; }
  return { persistentAvailable: reasonCode === null, sessionScope: 'app', reasonCode };
}

export function createLinuxDesktopSecretCodec({ safeStorage, appId }: {
  safeStorage: LinuxSafeStorage; appId: string;
}): DesktopSecretCodec {
  if (!['production', 'development'].some(channel => desktopIdentity.identityForChannel(channel).appId === appId)) throw vaultError();
  let closed = false;
  const assertActive = (options: SecretOperationOptions) => {
    try {
      const active = typeof options.isActive !== 'function' || options.isActive();
      if (closed || options.signal?.aborted || !active) throw vaultError();
    } catch { throw vaultError(); }
  };
  const storage = (): SecretStorageState => closed ? unavailable() : linuxDesktopSecretStorage(safeStorage);
  const requireVault = () => {
    if (!storage().persistentAvailable) throw vaultError();
  };
  const codec: DesktopSecretCodec = {
    storage,
    refreshStorage(options: SecretOperationOptions = {}): SecretStorageState {
      try {
        assertActive(options);
        const result = storage();
        assertActive(options);
        return result;
      } catch { return unavailable(); }
    },
    encrypt(plaintext: string, options: SecretOperationOptions = {}): string {
      assertActive(options);
      requireVault();
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
      assertActive(options);
      let result: string;
      try {
        // Keep the original wrapper and ciphertext representation byte-for-byte.
        const encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, appId, plaintext }));
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
        result = encrypted.toString('base64');
      } catch {
        assertActive(options);
        throw vaultError();
      }
      // A synchronous native call cannot be cancelled. Fence its result instead.
      assertActive(options);
      return result;
    },
    decrypt(ciphertext: string, options: SecretOperationOptions = {}): string {
      assertActive(options);
      requireVault();
      let buffer: Buffer;
      try {
        if (typeof ciphertext !== 'string' || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT_BYTES * 2 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw vaultError();
        buffer = Buffer.from(ciphertext, 'base64');
        if (!buffer.length || buffer.length > MAX_CIPHERTEXT_BYTES || buffer.toString('base64') !== ciphertext) throw vaultError();
      } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
      assertActive(options);
      let result: string;
      try {
        const decoded = safeStorage.decryptString(buffer);
        if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError();
        const value = JSON.parse(decoded);
        if (!value || value.version !== 1 || value.appId !== appId || typeof value.plaintext !== 'string' ||
          Object.keys(value).length !== 3 || Buffer.byteLength(value.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
        result = value.plaintext;
      } catch {
        assertActive(options);
        throw vaultError('AGENT_SETTINGS_CORRUPT');
      }
      assertActive(options);
      return result;
    },
    close() { closed = true; }
  };
  return Object.freeze(codec);
}
