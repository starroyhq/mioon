import {IMAGE_SETTINGS_LIMITS} from '@mioon/contracts';
import {createDesktopSecretCodec} from './secret-store.ts';
import type {DesktopSafeStorage, DesktopSecretCodec, SecretOperationOptions} from './secret-store.ts';
import {imageSettingsError, validateImageSecretPlaintext} from '@mioon/business/images/settings';
import {validateCustomImageSecretPlaintextV2} from '@mioon/business/images/custom-settings-v2';
import {IMAGE_SETTINGS_NAMESPACE} from '../../../packages/contracts/src/image-settings.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE} from '../../../packages/contracts/src/generation-image-settings.ts';

/** Images-only session scope; images configuration/revision stay in the utility. */
export type ImageSecretReasonCode = 'OS_SECRET_STORE_UNAVAILABLE' | 'LINUX_BASIC_TEXT' | null;
export interface ImageSecretStorage {
  readonly persistentAvailable: boolean;
  readonly sessionScope: 'server';
  readonly reasonCode: ImageSecretReasonCode;
}
export interface ImageSecretCodec {
  storage(options?: SecretOperationOptions): Promise<ImageSecretStorage>;
  encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string>;
  decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string>;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
const validCiphertext = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= IMAGE_SETTINGS_LIMITS.ciphertextCharacters &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;

/** Fixed Images-only gate shared by the codec and its private IPC boundary.
 * Recognizing an old custom settings file never grants old custom key access. */
export function validateDesktopImageSecretPlaintext(plaintext: unknown): void {
  try {
    if(typeof plaintext!=='string'||Buffer.byteLength(plaintext)>IMAGE_SETTINGS_LIMITS.updateBytes)throw Error();
    const value:unknown=JSON.parse(plaintext);
    const namespace=value&&typeof value==='object'&&'namespace'in value?value.namespace:null;
    if(namespace===IMAGE_SETTINGS_NAMESPACE)validateImageSecretPlaintext(plaintext);
    else if(namespace===CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE)validateCustomImageSecretPlaintextV2(plaintext);
    else throw Error();
  } catch {throw imageSettingsError('IMAGE_SETTINGS_CORRUPT');}
}

// Main owns only an OS codec. Images configuration, revision and session keys
// belong to the utility's dedicated Images settings engine, not to Agent main.
export function createDesktopImageSecretCodec({safeStorage, appId, platform = process.platform, timeout}: {
  safeStorage: DesktopSafeStorage; appId: string; platform?: NodeJS.Platform; timeout?: number;
}): ImageSecretCodec {
  let codec: DesktopSecretCodec;
  try {
    // This is a validated platform OS codec, never a renderer or network API.
    codec = createDesktopSecretCodec({safeStorage, appId, platform, timeout});
  }
  catch { throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
  const storage = async (options?: SecretOperationOptions): Promise<ImageSecretStorage> =>
    ({...await codec.refreshStorage(options), sessionScope: 'server'});
  return Object.freeze({
    storage,
    async encrypt(plaintext: string, options?: SecretOperationOptions): Promise<string> {
      // The complete binding must match one of exactly two Images namespace/
      // profile pairs. Arbitrary strings and Agent/video envelopes are denied.
      try { validateDesktopImageSecretPlaintext(plaintext); }
      catch { throw imageSettingsError('IMAGE_SETTINGS_VALIDATION'); }
      try {
        const encrypted = await codec.encrypt(plaintext, options);
        if (!validCiphertext(encrypted)) throw Error();
        return encrypted;
      }
      catch { throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
    },
    async decrypt(ciphertext: string, options?: SecretOperationOptions): Promise<string> {
      try {
        if (!validCiphertext(ciphertext)) throw Error();
        const plaintext = await codec.decrypt(ciphertext, options);
        // The legacy channel wrapper is unchanged. This extra Images-only gate
        // prevents its reuse as a decryption oracle for Agent or video secrets.
        validateDesktopImageSecretPlaintext(plaintext);
        return plaintext;
      } catch (error) { throw imageSettingsError(errorCode(error) === 'AGENT_SETTINGS_STORAGE_UNAVAILABLE' ? 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE' : 'IMAGE_SETTINGS_CORRUPT'); }
    }
  });
}
