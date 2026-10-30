import {AppError} from '../../../contracts/src/app-error.ts';
import type {PROJECT_FILE_EXISTS, ProjectOpenErrorCode} from '../../../contracts/src/project-file.ts';
import type {DatabaseKind} from './schema/databases.ts';

/** The codes projectFileError() raises: the contract's open codes and its
 * PROJECT_FILE_EXISTS. A subset of the contract's ProjectFileErrorCode, which
 * also lists the store-level and addressing codes of the API. */
export type ProjectFileKernelErrorCode = ProjectOpenErrorCode | typeof PROJECT_FILE_EXISTS;

/** Why an open or a create failed. `missing`, `locked` and `format-newer` go
 * with their own codes; every other reason comes with PROJECT_INVALID. */
export type ProjectFileErrorReason =
  | 'missing' | 'locked' | 'format-newer' | 'exists'
  | 'not-a-regular-file' | 'not-a-project-file' | 'journal-mode' | 'encoding' | 'application-id'
  | 'schema-version' | 'schema' | 'metadata' | 'project-row' | 'foreign-key' | 'project-mismatch'
  | 'corrupt' | 'unusable';

/** `details` of every project-file error. It never holds an absolute path:
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
};
export const MAX_REPORTED_DIFFERENCES = 20;

export function projectFileError(code: ProjectFileKernelErrorCode, details: ProjectFileErrorDetails): AppError {
  const {status, message} = ERRORS[code];
  const reported = details.differences && details.differences.length > MAX_REPORTED_DIFFERENCES
    ? {...details, differences: details.differences.slice(0, MAX_REPORTED_DIFFERENCES)}
    : details;
  return new AppError(code, message, status, reported);
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
