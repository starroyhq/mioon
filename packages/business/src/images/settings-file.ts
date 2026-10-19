import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_SETTINGS_FILENAME} from '../../../contracts/src/image-settings.ts';
import {imageSettingsError, validateImageSettingsEnvelope, validateCustomImageSettingsEnvelope} from './settings.ts';
import type {ImageSettingsEnvelope} from './settings.ts';

export interface ImageSettingsFileOptions {directory?: string; filename?: string; privateRoot?: string}
export interface ImageSettingsFile {
  load(): Promise<ImageSettingsEnvelope | null>;
  save(value: unknown): Promise<void>;
}
type EnvelopeValidator = (value: unknown) => ImageSettingsEnvelope;

/** Dedicated private image envelope, never an Agent filename or legacy loader.
 * Reuses the existing symlink/ownership/bounded-I/O/atomic-publication policy. */
export const createImageSettingsFile = (options: ImageSettingsFileOptions = {}): ImageSettingsFile => createSettingsFile(options, validateImageSettingsEnvelope);
export function createCustomImageSettingsFile({directory, filename = CUSTOM_IMAGE_SETTINGS_FILENAME, privateRoot = directory}: ImageSettingsFileOptions = {}): ImageSettingsFile {
  if (filename !== CUSTOM_IMAGE_SETTINGS_FILENAME) throw imageSettingsError('IMAGE_SETTINGS_CORRUPT');
  return createSettingsFile({directory, filename, privateRoot}, validateCustomImageSettingsEnvelope);
}
function createSettingsFile({directory, filename = 'settings.json', privateRoot = directory}: ImageSettingsFileOptions, validateEnvelope: EnvelopeValidator): ImageSettingsFile {
  function fail(code: string): never { throw imageSettingsError(code); }
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) || !path.isAbsolute(privateRoot) ||
      typeof filename !== 'string' || !/^[a-z0-9-]+\.json$/i.test(filename)) fail('IMAGE_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), file = path.join(root, filename), relative = path.relative(boundary, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('IMAGE_SETTINGS_CORRUPT');
  return Object.freeze({
    async load(): Promise<ImageSettingsEnvelope | null> {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true})) return null;
        if (!validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents = readPrivateFile(file, {root, maxBytes: IMAGE_SETTINGS_LIMITS.envelopeBytes, allowMissing: true, encoding: 'utf8'});
        return contents === null ? null : validateEnvelope(JSON.parse(contents as string));
      } catch { fail('IMAGE_SETTINGS_CORRUPT'); }
    },
    async save(envelope: unknown): Promise<void> {
      try {
        const serialized = JSON.stringify(validateEnvelope(envelope)) + '\n';
        if (Buffer.byteLength(serialized, 'utf8') > IMAGE_SETTINGS_LIMITS.envelopeBytes) fail('IMAGE_SETTINGS_SAVE_FAILED');
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, serialized, {root, maxBytes: IMAGE_SETTINGS_LIMITS.envelopeBytes});
      } catch { fail('IMAGE_SETTINGS_SAVE_FAILED'); }
    },
  });
}
