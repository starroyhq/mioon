/** Only backup actions use this internal IPC envelope. Electron does not
 * preserve custom Error properties when ipcMain.handle rejects. Never carry a
 * backend/OS message or path through an error result. */
import {PROJECT_BACKUP_NATIVE_ERROR_CODES} from '../../../packages/contracts/src/workspace-native.ts';
import type {ProjectBackupNativeErrorCode} from '../../../packages/contracts/src/workspace-native.ts';
export const BACKUP_NATIVE_ERROR_CODES = PROJECT_BACKUP_NATIVE_ERROR_CODES;
export type BackupNativeErrorCode = ProjectBackupNativeErrorCode;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = (value: unknown): value is BackupNativeErrorCode => typeof value === 'string' && BACKUP_NATIVE_ERROR_CODES.some(code => code === value);
export function backupNativeFailureCode(error: unknown): BackupNativeErrorCode {
  const code = record(error) ? error.code : null;
  if (typeof code === 'string' && ['EACCES', 'EPERM', 'EROFS', 'PROJECT_FILE_ACCESS_DENIED'].includes(code)) return 'PROJECT_ACCESS_DENIED';
  return known(code) ? code : 'WORKSPACE_NATIVE_UNAVAILABLE';
}
export function backupNativeFailure(error: unknown): {ok: false; code: BackupNativeErrorCode} {
  return {ok: false, code: backupNativeFailureCode(error)};
}
export function backupNativeError(code: BackupNativeErrorCode): Error & {code: BackupNativeErrorCode} {
  return Object.assign(new Error('Native backup action is unavailable.'), {code});
}
/** Strictly decode the fixed wrapper before the caller validates its own DTO. */
export function backupNativeResponseValue(value: unknown): unknown {
  if (!record(value)) throw backupNativeError('WORKSPACE_NATIVE_UNAVAILABLE');
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === false && keys === 'code,ok' && known(value.code)) throw backupNativeError(value.code);
  if (value.ok === true && keys === 'ok,value') return value.value;
  throw backupNativeError('WORKSPACE_NATIVE_UNAVAILABLE');
}
