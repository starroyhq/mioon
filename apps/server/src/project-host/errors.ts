/** Errors of project-addressed requests and of the project host. Imports only
 * contracts without Node, so the web app can use the codes and statuses. */
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {PROJECT_FILE_EXISTS, PROJECT_OPEN_ERROR_CODES} from '../../../../packages/contracts/src/project-file.ts';
import type {ProjectAddressErrorCode, ProjectOpenErrorCode} from '../../../../packages/contracts/src/project-file.ts';

export const PROJECT_ADDRESS_ERROR_STATUS: Readonly<Record<ProjectAddressErrorCode, number>> = Object.freeze({
  PROJECT_NOT_FOUND: 404, PROJECT_ID_MISMATCH: 400, PROJECT_UNAVAILABLE: 409,
});

/** The host's own codes:
 * - `PROJECT_HOST_BUSY`: an exclusive operation found requests or work that
 *   did not end in time; nothing was cancelled.
 * - `PROJECT_HOST_TRANSITION`: the project is opening or closing (test-only
 *   inspection, which never waits).
 * - `PROJECT_HOST_STOPPED`: the backend is shutting down.
 * - `PROJECT_LOCATION_INVALID`: the folder of a chosen `.mioon` does not exist.
 * - `PROJECT_FILE_MOVED`: the open project file was renamed or moved on its
 *   own; the write was refused and the host reopens it at its new location,
 *   so a retry works. */
export const PROJECT_HOST_ERROR_CODES = Object.freeze([
  'PROJECT_HOST_BUSY', 'PROJECT_HOST_TRANSITION', 'PROJECT_HOST_STOPPED', 'PROJECT_LOCATION_INVALID', 'PROJECT_FILE_MOVED',
] as const);
export type ProjectHostErrorCode = typeof PROJECT_HOST_ERROR_CODES[number];
export const PROJECT_HOST_ERROR_STATUS: Readonly<Record<ProjectHostErrorCode, number>> = Object.freeze({
  PROJECT_HOST_BUSY: 409, PROJECT_HOST_TRANSITION: 409, PROJECT_HOST_STOPPED: 503, PROJECT_LOCATION_INVALID: 400, PROJECT_FILE_MOVED: 409,
});
const HOST_MESSAGES: Readonly<Record<ProjectHostErrorCode, string>> = {
  PROJECT_HOST_BUSY: '项目仍有请求或任务在执行，请结束后再试',
  PROJECT_HOST_TRANSITION: '项目正在打开或关闭，请稍后再试',
  PROJECT_HOST_STOPPED: '本地服务正在退出',
  PROJECT_LOCATION_INVALID: '项目位置无效',
  PROJECT_FILE_MOVED: '项目文件在打开期间被改名或移动，正在按新位置重新打开，请重试',
};

/** Not registered on this computer. */
export function projectNotFound(projectId: string): AppError {
  return new AppError('PROJECT_NOT_FOUND', '这个项目没有登记', PROJECT_ADDRESS_ERROR_STATUS.PROJECT_NOT_FOUND, {projectId});
}

/** The input names another project than the URL; details carry the URL's ID. */
export function projectIdMismatch(projectId: string): AppError {
  return new AppError('PROJECT_ID_MISMATCH', '请求里的项目和地址不一致', PROJECT_ADDRESS_ERROR_STATUS.PROJECT_ID_MISMATCH, {projectId});
}

/** Registered, but it cannot be opened; `reason` is the open failure code and
 * the kernel's error, if any, is the cause. */
export function projectUnavailable(projectId: string, reason: ProjectOpenErrorCode, cause?: unknown): AppError {
  const error = new AppError('PROJECT_UNAVAILABLE', '项目现在打不开', PROJECT_ADDRESS_ERROR_STATUS.PROJECT_UNAVAILABLE, {projectId, reason});
  if (cause !== undefined) error.cause = cause;
  return error;
}

const isOpenFailure = (error: unknown): error is AppError & {readonly code: ProjectOpenErrorCode} =>
  error instanceof AppError && (PROJECT_OPEN_ERROR_CODES as readonly string[]).includes(error.code);

/** Kernel open failures become PROJECT_UNAVAILABLE; any other value is returned unchanged. */
export function asProjectUnavailable(projectId: string, error: unknown): unknown {
  return isOpenFailure(error) ? projectUnavailable(projectId, error.code, error) : error;
}

/** SQLite's extended code for a write to a database file that was moved or
 * renamed since the connection opened it. */
export const SQLITE_READONLY_DBMOVED = 1032;

/** The error, or the cause of a kernel open failure, is SQLITE_READONLY_DBMOVED:
 * find the project file by identity, close the project and reopen it there. */
export function isDatabaseMovedError(error: unknown): boolean {
  const failure = error as {errcode?: unknown; cause?: {errcode?: unknown} | null} | null | undefined;
  return failure?.errcode === SQLITE_READONLY_DBMOVED || failure?.cause?.errcode === SQLITE_READONLY_DBMOVED;
}

export function projectHostError(code: ProjectHostErrorCode, details: Readonly<Record<string, unknown>> = {}): AppError {
  return new AppError(code, HOST_MESSAGES[code], PROJECT_HOST_ERROR_STATUS[code], details);
}

/** App-level creation: the kernel's details plus the path. */
export function projectFileExists(projectFile: string): AppError {
  return new AppError(PROJECT_FILE_EXISTS, '目标位置已有项目文件', 409, {database: 'project', reason: 'exists', projectFile});
}
