import {IMAGE_SETTINGS_LIMITS} from '@mioon/contracts';
import {desktopSecretStorage, createDesktopSecretCodec} from './secret-store.mjs';
import {imageSettingsError, validateImageSecretPlaintext} from '@mioon/business/images/settings';

const validCiphertext = value => typeof value === 'string' && value.length > 0 && value.length <= IMAGE_SETTINGS_LIMITS.ciphertextCharacters &&
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;

// Main owns only an OS codec. Images configuration, revision and session keys
// belong to the utility's dedicated Images settings engine, not to Agent main.
export function createDesktopImageSecretCodec({safeStorage, appId, platform = process.platform}) {
  let codec;
  try { codec = createDesktopSecretCodec({safeStorage, appId, platform}); }
  catch { throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
  const storage = () => ({...desktopSecretStorage(safeStorage, platform), sessionScope: 'server'});
  const requireVault = () => {
    if (!storage().persistentAvailable) throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE');
  };
  return Object.freeze({
    storage,
    encrypt(plaintext) {
      requireVault();
      // The complete binding must match one of exactly two Images namespace/
      // profile pairs. Arbitrary strings and Agent/video envelopes are denied.
      try { validateImageSecretPlaintext(plaintext); }
      catch { throw imageSettingsError('IMAGE_SETTINGS_VALIDATION'); }
      try {
        const encrypted = codec.encrypt(plaintext);
        if (!validCiphertext(encrypted)) throw Error();
        return encrypted;
      }
      catch { throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
    },
    decrypt(ciphertext) {
      requireVault();
      try {
        if (!validCiphertext(ciphertext)) throw Error();
        const plaintext = codec.decrypt(ciphertext);
        // The legacy channel wrapper is unchanged. This extra Images-only gate
        // prevents its reuse as a decryption oracle for Agent or video secrets.
        validateImageSecretPlaintext(plaintext);
        return plaintext;
      } catch { throw imageSettingsError('IMAGE_SETTINGS_CORRUPT'); }
    }
  });
}
