import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {IMAGE_SETTINGS_LIMITS} from '../../../contracts/src/image-settings.mjs';
import {imageSettingsError, validateImageSettingsEnvelope} from './settings.mjs';

/** Dedicated private image envelope, never an Agent filename or legacy loader.
 * Reuses the existing symlink/ownership/bounded-I/O/atomic-publication policy. */
export function createImageSettingsFile({directory, filename = 'settings.json', privateRoot = directory}) {
  const fail = code => { throw imageSettingsError(code); };
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) || !path.isAbsolute(privateRoot) ||
      typeof filename !== 'string' || !/^[a-z0-9-]+\.json$/i.test(filename)) fail('IMAGE_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), file = path.join(root, filename), relative = path.relative(boundary, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('IMAGE_SETTINGS_CORRUPT');
  return Object.freeze({
    async load() {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true})) return null;
        if (!validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents = readPrivateFile(file, {root, maxBytes: IMAGE_SETTINGS_LIMITS.envelopeBytes, allowMissing: true, encoding: 'utf8'});
        return contents === null ? null : validateImageSettingsEnvelope(JSON.parse(contents));
      } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
    },
    async save(envelope) {
      try {
        const serialized = JSON.stringify(validateImageSettingsEnvelope(envelope)) + '\n';
        if (Buffer.byteLength(serialized, 'utf8') > IMAGE_SETTINGS_LIMITS.envelopeBytes) fail('IMAGE_SETTINGS_SAVE_FAILED');
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, serialized, {root, maxBytes: IMAGE_SETTINGS_LIMITS.envelopeBytes});
      } catch { fail('IMAGE_SETTINGS_SAVE_FAILED'); }
    },
  });
}
