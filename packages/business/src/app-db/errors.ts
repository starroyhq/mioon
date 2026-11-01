import {AppError} from '../../../contracts/src/app-error.ts';
import {PROJECT_FILE_COPY} from '../../../contracts/src/project-file.ts';

/** Why the app library cannot be used as it is: the check that failed, or what
 * SQLite reported (`corrupt`, `read-only`, `unusable`). */
export type AppLibraryInvalidReason =
  | 'application-id' | 'encoding' | 'schema-version' | 'schema' | 'journal-mode' | 'corrupt' | 'read-only' | 'unusable';

/** `details` of APP_LIBRARY_INVALID and APP_LIBRARY_FORMAT_NEWER. Like the
 * project-file kernel's errors they never hold an absolute path. */
export interface AppLibraryErrorDetails {
  readonly reason?: AppLibraryInvalidReason;
  /** Structure differences such as `unexpected table:x`, at most 20. */
  readonly differences?: readonly string[];
  readonly formatVersion?: number;
  readonly supportedFormatVersion?: number;
}

const ERRORS = {
  APP_LIBRARY_LOCKED: {status: 409, message: '应用库已被另一个 Mioon 进程占用'},
  APP_LIBRARY_FORMAT_NEWER: {status: 409, message: '应用库来自更新版本的 Mioon，请先升级'},
  APP_LIBRARY_INVALID: {status: 422, message: '应用库的结构无效'},
  APP_LIBRARY_CLOSED: {status: 503, message: '应用库已关闭'},
  APP_LIBRARY_LIMIT: {status: 507, message: '应用库的记录已达上限'},
  AGENT_POLICY_REQUEST_EXISTS: {status: 409, message: '这个放行请求已有回执'},
  APP_OPERATION_RECEIPT_CONFLICT: {status: 409, message: '同一个请求 ID 已有不同的回执'},
  PROJECT_INBOX_ITEM_CONFLICT: {status: 409, message: '收件箱里已有同一 ID 的不同条目'},
  LOCAL_RECORDS_NOT_FOUND: {status: 404, message: '找不到这份本机记录'},
  LOCAL_RECORDS_IN_USE: {status: 409, message: '这份本机记录的项目文件还找得到，或项目正打开着'},
  LOCAL_RECORDS_SUPER_JOURNAL: {status: 409, message: '这份本机记录里有还用得着的超级日志，不能删除'},
} as const;
export type AppLibraryErrorCode = keyof typeof ERRORS;
export const MAX_REPORTED_DIFFERENCES = 20;

export function appLibraryError(code: AppLibraryErrorCode, details: object = {}): AppError {
  const {status, message} = ERRORS[code];
  return new AppError(code, message, status, details);
}

export const appLibraryInvalid = (reason: AppLibraryInvalidReason, differences?: readonly string[]): AppError =>
  appLibraryError('APP_LIBRARY_INVALID', differences === undefined ? {reason} : {reason, differences: differences.slice(0, MAX_REPORTED_DIFFERENCES)});

/** The contract's PROJECT_FILE_COPY (409), built like the kernel's
 * projectFileMovedError: the details are only `{projectId}`, never a path;
 * where the registered file is can be read from the registry. */
export function projectFileCopyError(projectId: string): AppError {
  return new AppError(PROJECT_FILE_COPY, '这个项目文件是另一处已登记项目的副本', 409, {projectId});
}

const primaryCode = (error: unknown): number | undefined => {
  const code = (error as {errcode?: unknown} | null | undefined)?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
};
/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the file. */
export const isSqliteBusy = (error: unknown): boolean => primaryCode(error) === 5 || primaryCode(error) === 6;
/** SQLITE_CORRUPT or SQLITE_NOTADB. */
export const isSqliteCorrupt = (error: unknown): boolean => primaryCode(error) === 11 || primaryCode(error) === 26;
/** SQLITE_READONLY and its extended codes. */
export const isSqliteReadOnly = (error: unknown): boolean => primaryCode(error) === 8;
