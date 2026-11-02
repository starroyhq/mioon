import {AppError} from '../../../contracts/src/app-error.ts';
import {PROJECT_FILE_MOVED} from '../../../contracts/src/project-file.ts';
import type {PROJECT_FILE_EXISTS, ProjectInvalidReason, ProjectOpenErrorCode} from '../../../contracts/src/project-file.ts';
import type {DatabaseKind} from './schema/databases.ts';

/** The codes the kernel raises: the contract's open codes, its
 * PROJECT_FILE_EXISTS (projectFileError) and its PROJECT_FILE_MOVED
 * (projectFileMovedError). A subset of the contract's ProjectFileErrorCode,
 * which also lists the store-level and addressing codes of the API. */
export type ProjectFileKernelErrorCode = ProjectOpenErrorCode | typeof PROJECT_FILE_EXISTS | typeof PROJECT_FILE_MOVED;

/** Why an open or a create failed. `missing`, `locked`, `format-newer` and
 * `exists` go with their own codes; every other reason comes with
 * PROJECT_INVALID and is one of the contract's PROJECT_INVALID_REASONS. */
export type ProjectFileErrorReason = 'missing' | 'locked' | 'format-newer' | 'exists' | ProjectInvalidReason;

/** `details` of every projectFileError(). It never holds an absolute path:
 * `database` says which of the three files failed. `projectId` is set once the
 * project file has been read; `formatVersion` and `supportedFormatVersion` come
 * with PROJECT_FORMAT_NEWER. */
export interface ProjectFileErrorDetails {
  readonly database: DatabaseKind;
  readonly reason: ProjectFileErrorReason;
  readonly projectId?: string;
  /** Structure differences such as `missing index:x`, at most 20. */
  readonly differences?: readonly string[];
  readonly formatVersion?: number;
  readonly supportedFormatVersion?: number;
}

const ERRORS: Readonly<Record<ProjectFileKernelErrorCode, {readonly status: number; readonly message: string}>> = {
  PROJECT_MISSING: {status: 404, message: '找不到项目文件'},
  PROJECT_LOCKED: {status: 409, message: '项目已在另一个 Mioon 中打开'},
  PROJECT_FORMAT_NEWER: {status: 409, message: '项目文件来自更新版本的 Mioon，请先升级'},
  PROJECT_INVALID: {status: 422, message: '项目文件的结构无效'},
  PROJECT_FILE_EXISTS: {status: 409, message: '目标位置已有项目文件'},
  // The project host's projectFileMoved builds the same error.
  PROJECT_FILE_MOVED: {status: 409, message: '项目文件在打开期间被改名或移动，正在按新位置重新打开，请重试'},
};
export const MAX_REPORTED_DIFFERENCES = 20;

export function projectFileError(code: Exclude<ProjectFileKernelErrorCode, typeof PROJECT_FILE_MOVED>, details: ProjectFileErrorDetails): AppError {
  const {status, message} = ERRORS[code];
  const reported = details.differences && details.differences.length > MAX_REPORTED_DIFFERENCES
    ? {...details, differences: details.differences.slice(0, MAX_REPORTED_DIFFERENCES)}
    : details;
  return new AppError(code, message, status, reported);
}

/** PROJECT_FILE_MOVED (409): the project file alone was renamed or moved while
 * open, so the store refused a write (ProjectConnection.throwIfMoved). As in
 * the contract, the details are only `{projectId}`, never a path. The project
 * host reopens the project where file identity finds it; the caller retries. */
export function projectFileMovedError(projectId: string): AppError {
  const {status, message} = ERRORS[PROJECT_FILE_MOVED];
  return new AppError(PROJECT_FILE_MOVED, message, status, {projectId});
}

const primaryCode = (error: unknown): number | undefined => {
  const code = (error as {errcode?: unknown} | null | undefined)?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
};
/** SQLITE_BUSY or SQLITE_LOCKED, including their extended codes: another
 * connection holds the file. */
export function isSqliteBusy(error: unknown): boolean {
  const code = primaryCode(error);
  return code === 5 || code === 6;
}
/** SQLITE_CORRUPT or SQLITE_NOTADB. */
export function isSqliteCorrupt(error: unknown): boolean {
  const code = primaryCode(error);
  return code === 11 || code === 26;
}
/** SQLITE_READONLY_DBMOVED: the database file was renamed or unlinked while
 * open. SQLite checks this when it opens a rollback journal. */
export const SQLITE_READONLY_DBMOVED = 1032;
/** SQLITE_READONLY and its extended codes (no write permission, a read-only
 * volume, a directory where the journal cannot be created), except
 * SQLITE_READONLY_DBMOVED, which is about a moved file. */
export function isSqliteReadOnly(error: unknown): boolean {
  const code = (error as {errcode?: unknown} | null | undefined)?.errcode;
  return primaryCode(error) === 8 && code !== SQLITE_READONLY_DBMOVED;
}
