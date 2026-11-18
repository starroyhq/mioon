import {agentSettingsError} from '@mioon/business/agent/config';
import desktopIdentity from '../identity.ts';
import type {DesktopSecretCodec, SecretOperationOptions, SecretStorageState, SyncSafeStorage} from './secret-store.ts';

const MAX_PLAINTEXT_BYTES = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;
const vaultError = (code = 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'): Error => agentSettingsError(code);
const unavailable = (): SecretStorageState => ({persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'});

/** Electron's Windows synchronous DPAPI surface; no Linux backend selection. */
export type WindowsSafeStorage = Pick<SyncSafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;

export function windowsDesktopSecretStorage(safeStorage: WindowsSafeStorage): SecretStorageState {
  try {
    if (typeof safeStorage?.isEncryptionAvailable === 'function' && typeof safeStorage.encryptString === 'function' &&
      typeof safeStorage.decryptString === 'function' && safeStorage.isEncryptionAvailable() === true) {
      return {persistentAvailable: true, reasonCode: null};
    }
  } catch { /* Native readiness details never cross the settings boundary. */ }
  return unavailable();
}

export function createWindowsDesktopSecretCodec({safeStorage, appId}: {
  safeStorage: WindowsSafeStorage; appId: string;
}): DesktopSecretCodec {
  if (!['production', 'development'].some(channel => desktopIdentity.identityForChannel(channel).appId === appId)) throw vaultError();
  let closed = false;
  const assertActive = (options: SecretOperationOptions) => {
    try {
      const active = typeof options.isActive !== 'function' || options.isActive();
      if (closed || options.signal?.aborted || !active) throw vaultError();
    } catch { throw vaultError(); }
  };
  const storage = (): SecretStorageState => {
    if (closed) return unavailable();
    const result = windowsDesktopSecretStorage(safeStorage);
    return closed ? unavailable() : result;
  };
  const requireVault = () => {
    if (!storage().persistentAvailable) throw vaultError();
  };
  return Object.freeze({
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
        // Keep the existing channel wrapper and opaque base64 representation.
        const bytes = safeStorage.encryptString(JSON.stringify({version: 1, appId, plaintext}));
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES) throw vaultError();
        result = bytes.toString('base64');
      } catch {
        assertActive(options);
        throw vaultError();
      }
      // DPAPI is synchronous: retirement fences the result rather than the call.
      assertActive(options);
      return result;
    },
    decrypt(ciphertext: string, options: SecretOperationOptions = {}): string {
      assertActive(options);
      requireVault();
      let bytes: Buffer;
      try {
        if (typeof ciphertext !== 'string' || !ciphertext.length || ciphertext.length > MAX_CIPHERTEXT_BYTES * 2 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ciphertext)) throw vaultError();
        bytes = Buffer.from(ciphertext, 'base64');
        if (!bytes.length || bytes.length > MAX_CIPHERTEXT_BYTES || bytes.toString('base64') !== ciphertext) throw vaultError();
      } catch { throw vaultError('AGENT_SETTINGS_CORRUPT'); }
      assertActive(options);
      let result: string;
      try {
        const decoded = safeStorage.decryptString(bytes);
        if (typeof decoded !== 'string' || Buffer.byteLength(decoded) > MAX_PLAINTEXT_BYTES * 2) throw vaultError();
        const value: unknown = JSON.parse(decoded);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw vaultError();
        const envelope = value as Record<string, unknown>;
        if (Object.keys(envelope).length !== 3 || !Object.hasOwn(envelope, 'version') || !Object.hasOwn(envelope, 'appId') ||
          !Object.hasOwn(envelope, 'plaintext') || envelope.version !== 1 || envelope.appId !== appId ||
          typeof envelope.plaintext !== 'string' || Buffer.byteLength(envelope.plaintext) > MAX_PLAINTEXT_BYTES) throw vaultError();
        result = envelope.plaintext;
      } catch {
        assertActive(options);
        throw vaultError('AGENT_SETTINGS_CORRUPT');
      }
      assertActive(options);
      return result;
    },
    close() { closed = true; },
  } satisfies DesktopSecretCodec);
}
