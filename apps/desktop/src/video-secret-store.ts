import {VIDEO_SECRET_LIMITS} from '../../../packages/business/src/video/settings.ts';
import {createDesktopSecretCodec} from './secret-store.ts';
import type {DesktopSafeStorage, DesktopSecretCodec, SecretOperationOptions} from './secret-store.ts';
import {videoSettingsError, validateVideoSecretPlaintext} from '../../../packages/business/src/video/settings.ts';

/** Video-only session scope; video configuration/revision stay in the utility. */
export type VideoSecretReasonCode = 'OS_SECRET_STORE_UNAVAILABLE' | 'LINUX_BASIC_TEXT' | null;
export interface VideoSecretStorage {
  readonly persistentAvailable: boolean;
  readonly sessionScope: 'server';
  readonly reasonCode: VideoSecretReasonCode;
}
export interface VideoSecretCodec {
  storage(options?: SecretOperationOptions): Promise<VideoSecretStorage>;
  encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string>;
  decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string>;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
const validCiphertext = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= VIDEO_SECRET_LIMITS.ciphertextCharacters &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;

// Main owns only an OS codec. Video configuration, revision and session keys
// belong to the utility's dedicated video settings engine, not to Agent main.
export function createDesktopVideoSecretCodec({safeStorage, appId, platform = process.platform, timeout}: {
  safeStorage: DesktopSafeStorage; appId: string; platform?: NodeJS.Platform; timeout?: number;
}): VideoSecretCodec {
  let codec: DesktopSecretCodec;
  try {
    // This is a validated platform OS codec, never a renderer or network API.
    codec = createDesktopSecretCodec({safeStorage, appId, platform, timeout});
  }
  catch { throw videoSettingsError('VIDEO_SETTINGS_STORAGE_UNAVAILABLE'); }
  const storage = async (options?: SecretOperationOptions): Promise<VideoSecretStorage> =>
    ({...await codec.refreshStorage(options), sessionScope: 'server'});
  return Object.freeze({
    storage,
    async encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string> {
      // The complete binding must match the video credential namespace and recipient binding.
      // Arbitrary strings and Agent/Images envelopes are denied.
      try { validateVideoSecretPlaintext(plaintext); }
      catch { throw videoSettingsError('VIDEO_SETTINGS_VALIDATION'); }
      try {
        const encrypted = await codec.encrypt(plaintext, options);
        if (!validCiphertext(encrypted)) throw Error();
        return encrypted;
      }
      catch { throw videoSettingsError('VIDEO_SETTINGS_STORAGE_UNAVAILABLE'); }
    },
    async decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string> {
      try {
        if (!validCiphertext(ciphertext)) throw Error();
        const plaintext = await codec.decrypt(ciphertext, options);
        // The legacy channel wrapper is unchanged. This extra Video-only gate
        // prevents its reuse as a decryption oracle for Agent or Images secrets.
        validateVideoSecretPlaintext(plaintext);
        return plaintext;
      } catch (error) { throw videoSettingsError(errorCode(error) === 'AGENT_SETTINGS_STORAGE_UNAVAILABLE' ? 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE' : 'VIDEO_SETTINGS_CORRUPT'); }
    }
  });
}
