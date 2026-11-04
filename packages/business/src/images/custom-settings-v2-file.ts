import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {ensurePrivateDirectory, validateManagedDirectory, validateManagedFile, privateStorageIdentity, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {CUSTOM_IMAGE_SETTINGS_FILENAME, IMAGE_SETTINGS_LIMITS} from '../../../contracts/src/image-settings.ts';
import {CUSTOM_IMAGE_SETTINGS_V2_LIMITS} from '../../../contracts/src/generation-image-settings.ts';
import {customImageSettingsV2Error, validateCustomImageSettingsV2Envelope, validateCustomImageSettingsV2Stored} from './custom-settings-v2.ts';
import type {ImageSettingsPersistence} from './settings.ts';

export interface CustomImageSettingsV2FileOptions {directory?: string; privateRoot?: string; filename?: string}
export interface CustomImageSettingsV2File extends ImageSettingsPersistence {load(): Promise<unknown>; save(value: unknown): Promise<void>}
/** The factory is independent of production startup. Missing reads are inert;
 * only an explicit v2 save can replace an exact recognized legacy envelope. */
export function createCustomImageSettingsV2File({directory, privateRoot = directory,
  filename = CUSTOM_IMAGE_SETTINGS_FILENAME}: CustomImageSettingsV2FileOptions = {}): CustomImageSettingsV2File {
  function fail(code: string): never {throw customImageSettingsV2Error(code);}
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) ||
    !path.isAbsolute(privateRoot) || directory.includes('\0') || privateRoot.includes('\0') ||
    filename !== CUSTOM_IMAGE_SETTINGS_FILENAME) fail('IMAGE_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), relative = path.relative(boundary, root), file = path.join(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('IMAGE_SETTINGS_CORRUPT');
  const identity = (info: Stats): string => JSON.stringify([privateStorageIdentity(info), info.birthtimeMs, info.ctimeMs, info.mtimeMs, info.size, info.mode, info.uid, info.nlink]);
  function readRaw(): {contents: Buffer | null; token: string} {
    if (!ensurePrivateDirectory(boundary, {allowMissing: true}) ||
      !validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return {contents: null, token: 'missing'};
    const options = {root, maxBytes: CUSTOM_IMAGE_SETTINGS_V2_LIMITS.envelopeBytes, allowMissing: true, private: true};
    const before = validateManagedFile(file, options), contents = readPrivateFile(file, options), after = validateManagedFile(file, options);
    if (!before && !after && contents === null) return {contents: null, token: 'missing'};
    if (!before || !after || !Buffer.isBuffer(contents) || identity(before) !== identity(after)) fail('IMAGE_SETTINGS_CORRUPT');
    return {contents, token: `${identity(after)}:${createHash('sha256').update(contents).digest('hex')}`};
  }
  let initialized = false, baseline: string;
  return Object.freeze({
    async load(): Promise<unknown> {
      try {
        const {contents, token} = readRaw();
        if (initialized && token !== baseline) fail('IMAGE_SETTINGS_CORRUPT');
        let result: unknown = null;
        if (contents !== null) {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(contents));
          if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1 &&
            contents.length > IMAGE_SETTINGS_LIMITS.envelopeBytes) fail('IMAGE_SETTINGS_CORRUPT');
          result = validateCustomImageSettingsV2Stored(parsed);
        }
        if (!initialized) {baseline = token; initialized = true;}
        return result;
      } catch {fail('IMAGE_SETTINGS_CORRUPT');}
    },
    async save(input: unknown): Promise<void> {
      try {
        const contents = JSON.stringify(validateCustomImageSettingsV2Envelope(input)) + '\n';
        if (!initialized || readRaw().token !== baseline) fail('IMAGE_SETTINGS_SAVE_FAILED');
        ensurePrivateDirectory(boundary, {create: true}); ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, contents, {root, maxBytes: CUSTOM_IMAGE_SETTINGS_V2_LIMITS.envelopeBytes, replace: baseline !== 'missing'});
        const current = readRaw();
        if (!current.contents?.equals(Buffer.from(contents))) fail('IMAGE_SETTINGS_SAVE_FAILED');
        baseline = current.token;
      } catch {fail('IMAGE_SETTINGS_SAVE_FAILED');}
    },
  });
}
