import {desktopSecretStorage, createDesktopSecretCodec} from './secret-store.mjs';
import {imageSettingsError, validateImageSecretPlaintext} from '@mioon/business/images/settings';

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
      // Both namespace and the entire fixed Images binding must match before
      // any plaintext is admitted. Arbitrary strings/Agent envelopes are denied.
      try { validateImageSecretPlaintext(plaintext); }
      catch { throw imageSettingsError('IMAGE_SETTINGS_VALIDATION'); }
      try { return codec.encrypt(plaintext); }
      catch { throw imageSettingsError('IMAGE_SETTINGS_STORAGE_UNAVAILABLE'); }
    },
    decrypt(ciphertext) {
      requireVault();
      try {
        const plaintext = codec.decrypt(ciphertext);
        // The legacy channel wrapper is unchanged. This extra Images-only gate
        // prevents its reuse as a decryption oracle for Agent or video secrets.
        validateImageSecretPlaintext(plaintext);
        return plaintext;
      } catch { throw imageSettingsError('IMAGE_SETTINGS_CORRUPT'); }
    }
  });
}
