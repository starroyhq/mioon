import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {VIDEO_SECRET_LIMITS, videoSettingsError, validateVideoSettingsEnvelope} from './settings.ts';
import type {VideoSettingsEnvelope} from './settings.ts';

export interface VideoSettingsPersistence {
  load(): Promise<VideoSettingsEnvelope | null>;
  save(value: unknown): Promise<void>;
}

/** A private atomic envelope. Neither keys nor historical credentials enter the business database. */
export function createVideoSettingsFile({directory, privateRoot = directory}: {directory: string; privateRoot?: string}): VideoSettingsPersistence {
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) || !path.isAbsolute(privateRoot)) throw videoSettingsError('VIDEO_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), relative = path.relative(boundary, root), file = path.join(root, 'settings.json');
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw videoSettingsError('VIDEO_SETTINGS_CORRUPT');
  return Object.freeze({
    async load() {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true}) || !validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents = readPrivateFile(file, {root, maxBytes: VIDEO_SECRET_LIMITS.envelopeBytes, allowMissing: true, encoding: 'utf8'});
        return contents === null ? null : validateVideoSettingsEnvelope(JSON.parse(contents as string));
      } catch { throw videoSettingsError('VIDEO_SETTINGS_CORRUPT'); }
    },
    async save(value: unknown) {
      try {
        const bytes = JSON.stringify(validateVideoSettingsEnvelope(value)) + '\n';
        if (Buffer.byteLength(bytes) > VIDEO_SECRET_LIMITS.envelopeBytes) throw Error();
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, bytes, {root, maxBytes: VIDEO_SECRET_LIMITS.envelopeBytes});
      } catch { throw videoSettingsError('VIDEO_SETTINGS_SAVE_FAILED'); }
    },
  });
}
