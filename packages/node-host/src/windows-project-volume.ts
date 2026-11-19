import {PrivateStorageError} from '@mioon/contracts/private-storage';
import type {WindowsStorageNative} from './windows-private-storage.ts';

/** Native project-location facts. Booleans and a bounded filesystem name are
 * the only fields exposed; the desktop probe validates every value again. */
export interface WindowsProjectVolumeFacts {
  readonly fileSystem: string;
  readonly isLocal: boolean;
  readonly volumeReadOnly: boolean;
  readonly permissionBits: boolean;
  readonly cloudSyncRoot: boolean;
  readonly placeholder: boolean;
}

const failure = (): never => {
  throw new PrivateStorageError('WINDOWS_ACL_UNIMPLEMENTED', 'The Windows project location helper is unavailable.', 'STORAGE_PRIVACY_UNAVAILABLE');
};
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') return failure();
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return failure();
  return value;
};

/** Bind the shipped helper into the read-only reader used by the desktop
 * project-location probe. A helper without the reviewed entry fails closed. */
export function createWindowsProjectVolumeReader(native: WindowsStorageNative): (existingPath: string) => Promise<WindowsProjectVolumeFacts> {
  if (process.platform !== 'win32' || native?.apiVersion !== 1 || typeof native.projectVolumeFacts !== 'function') failure();
  return async (existingPath: string) => {
    if (typeof existingPath !== 'string' || existingPath.length < 1 || existingPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(existingPath)) return failure();
    let raw: unknown;
    try { raw = native.projectVolumeFacts!(existingPath); }
    catch (error) {
      const reason = (error as {reason?: unknown} | null)?.reason;
      if (reason === 'INVALID_PATH') throw Object.assign(new Error('Project location cannot be safely identified.'), {code: 'PROJECT_LOCATION_INVALID', status: 400});
      throw Object.assign(new Error('Project location cannot be safely identified.'), {code: 'PROJECT_LOCATION_INVALID', status: 400});
    }
    const facts = record(raw);
    if (!facts) return failure();
    return Object.freeze({fileSystem: text(facts.fileSystem), isLocal: flag(facts.isLocal), volumeReadOnly: flag(facts.volumeReadOnly),
      permissionBits: flag(facts.permissionBits), cloudSyncRoot: flag(facts.cloudSyncRoot), placeholder: flag(facts.placeholder)});
  };
}
