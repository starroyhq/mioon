import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {ensurePrivateDirectory, validateManagedDirectory, validateManagedFile, privateStorageIdentity, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {VIDEO_SETTINGS_V1_RESET_NOTICE} from '../../../contracts/src/generation-video-settings.ts';
import {VIDEO_SECRET_LIMITS, validateVideoSettingsEnvelope} from './settings.ts';
import {assertVideoSettingsV2Capacity, emptyVideoSettingsV2Envelope, sanitizeVideoSettingsV2Error, validateVideoSettingsV2Envelope, videoSettingsV2Error} from './settings-v2.ts';
import type {VideoSettingsEnvelopeV2} from './settings-v2.ts';

export interface VideoSettingsV2LoadResult {
  envelope: VideoSettingsEnvelopeV2;
  notice: typeof VIDEO_SETTINGS_V1_RESET_NOTICE | null;
}
export interface VideoSettingsV2Persistence {
  load(): Promise<VideoSettingsV2LoadResult | null>;
  save(value: VideoSettingsEnvelopeV2, signal?: AbortSignal): Promise<void>;
}

/** dev/ino may be reused after unlink. Keep the native identity (including the
 * full Windows file ID) together with metadata that distinguishes generations. */
export function videoSettingsV2FileIdentity(info: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs' | 'ctimeMs' | 'mtimeMs' | 'size' | 'mode' | 'uid' | 'nlink'>): string {
  return JSON.stringify([privateStorageIdentity(info), info.birthtimeMs, info.ctimeMs, info.mtimeMs, info.size, info.mode, info.uid, info.nlink]);
}

/** Read known v1 without importing keys; write v2 only on an explicit save. */
export function createVideoSettingsV2File({directory, privateRoot = directory}: {directory: string; privateRoot?: string}): VideoSettingsV2Persistence {
  if (typeof directory !== 'string' || typeof privateRoot !== 'string' || !path.isAbsolute(directory) || !path.isAbsolute(privateRoot)) throw videoSettingsV2Error('VIDEO_SETTINGS_CORRUPT');
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), relative = path.relative(boundary, root), file = path.join(root, 'settings.json');
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw videoSettingsV2Error('VIDEO_SETTINGS_CORRUPT');
  type Fingerprint = {identity: string; sha256: string} | null;
  let initialized = false, baseline: Fingerprint = null;
  const read = (): {bytes: Buffer | null; fingerprint: Fingerprint} => {
    if (!ensurePrivateDirectory(boundary, {allowMissing: true}) || !validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return {bytes: null, fingerprint: null};
    const options = {root, maxBytes: VIDEO_SECRET_LIMITS.envelopeBytes, allowMissing: true, private: true};
    const before = validateManagedFile(file, options), bytes = readPrivateFile(file, options);
    const after = validateManagedFile(file, options);
    if (before ? !after || videoSettingsV2FileIdentity(before) !== videoSettingsV2FileIdentity(after) : after !== null) throw Error();
    if ((bytes === null) !== (after === null)) throw Error();
    return {bytes: bytes as Buffer | null, fingerprint: after ? {identity: videoSettingsV2FileIdentity(after), sha256: createHash('sha256').update(bytes as Buffer).digest('hex')} : null};
  };
  return Object.freeze({
    async load() {
      try {
        const {bytes, fingerprint} = read();
        // Read-back after a failed save must compare the source too. A second
        // legacy file may have the same empty projection but is not our state.
        if (initialized && JSON.stringify(fingerprint) !== JSON.stringify(baseline)) throw Error();
        const accept = <T>(value: T): T => {if (!initialized) {baseline = fingerprint; initialized = true;} return value;};
        if (bytes === null) return accept(null);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
        if (value && typeof value === 'object' && 'version' in value && value.version === 1) {
          // Validate the complete known format before resetting. No key is
          // decrypted, copied into v2, or written during this read.
          validateVideoSettingsEnvelope(value);
          return accept({envelope: emptyVideoSettingsV2Envelope(), notice: VIDEO_SETTINGS_V1_RESET_NOTICE});
        }
        return accept({envelope: validateVideoSettingsV2Envelope(value), notice: null});
      } catch { throw videoSettingsV2Error('VIDEO_SETTINGS_CORRUPT'); }
    },
    async save(value: VideoSettingsEnvelopeV2, signal?: AbortSignal) {
      try {
        assertVideoSettingsV2Capacity(value);
        const bytes = JSON.stringify(validateVideoSettingsV2Envelope(value)) + '\n';
        if (Buffer.byteLength(bytes) > VIDEO_SECRET_LIMITS.envelopeBytes) throw Error();
        if (signal?.aborted) throw Error();
        // A normalized legacy reset is not a CAS token: two different v1 files
        // both project to empty v2. Fence the exact file we originally observed.
        if (!initialized || JSON.stringify(read().fingerprint) !== JSON.stringify(baseline)) throw Error();
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, bytes, {root, maxBytes: VIDEO_SECRET_LIMITS.envelopeBytes, replace: baseline !== null});
        const persisted = read().fingerprint;
        if (!persisted || persisted.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw Error();
        baseline = persisted;
      } catch (error) { throw videoSettingsV2Error(sanitizeVideoSettingsV2Error(error).code === 'VIDEO_SETTINGS_CAPACITY' ? 'VIDEO_SETTINGS_CAPACITY' : 'VIDEO_SETTINGS_SAVE_FAILED'); }
    },
  });
}
