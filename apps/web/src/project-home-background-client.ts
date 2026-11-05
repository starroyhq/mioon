import {BACKGROUND_TASK_QUERY_LIMITS, backgroundTaskQueryResponseSchema} from '../../../packages/contracts/src/background-task-query.ts';
import type {BackgroundTaskQueryResponse} from '../../../packages/contracts/src/background-task-query.ts';
import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import {ProjectEntryDirectoryError, readBoundedJsonResponse} from './project-entry-directory-client.ts';

const serverStatuses = Object.freeze({
  UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 400, NOT_FOUND: 404,
  BACKGROUND_TASK_QUERY_UNAVAILABLE: 503, BACKGROUND_TASK_QUERY_LIMIT: 413, PROJECT_HOST_STOPPED: 503,
  APP_LIBRARY_INVALID: 422, APP_LIBRARY_LIMIT: 507, INTERNAL_ERROR: 500,
});
export type ProjectHomeBackgroundErrorCode = keyof typeof serverStatuses | 'BACKEND_PROTOCOL_ERROR' | 'BACKEND_UNAVAILABLE' | 'TIMEOUT' | 'INTERRUPTED';
export class ProjectHomeBackgroundError extends Error {
  readonly code: ProjectHomeBackgroundErrorCode;
  readonly status?: number;
  constructor(code: ProjectHomeBackgroundErrorCode, status?: number) {
    super('Background tasks could not be verified.');
    this.name = 'ProjectHomeBackgroundError'; this.code = code;
    if (status !== undefined) this.status = status;
  }
}
export interface HomeBackgroundListOptions {readonly cursor?: string; readonly signal?: AbortSignal}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (): ProjectHomeBackgroundError => new ProjectHomeBackgroundError('BACKEND_PROTOCOL_ERROR');
const interrupted = (): ProjectHomeBackgroundError => new ProjectHomeBackgroundError('INTERRUPTED');
const validSignal = (value: unknown): value is AbortSignal | undefined => value === undefined || value instanceof AbortSignal;

/** One fixed application metadata resource. Neither its cursor nor a waiting
 * count admits a project file or dispatches any background task action. */
export function createProjectHomeBackgroundClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 30_000}: {
  readonly fetcher?: typeof fetch; readonly timeoutMs?: number;
} = {}) {
  return {async list(options: HomeBackgroundListOptions = {}): Promise<BackgroundTaskQueryResponse> {
    if (!record(options) || Object.keys(options).some(key => !['cursor', 'signal'].includes(key)) || !validSignal(options.signal) ||
      options.cursor !== undefined && (typeof options.cursor !== 'string' || !projectIdSchema.safeParse(options.cursor).success) || typeof fetcher !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ProjectHomeBackgroundError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw interrupted();
    const query = new URLSearchParams({limit: String(BACKGROUND_TASK_QUERY_LIMITS.maxPageSize)});
    if (options.cursor !== undefined) query.set('after', options.cursor);
    const controller = new AbortController(); let timedOut = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    let rejectAbort: ((error: ProjectHomeBackgroundError) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (): void => rejectAbort?.(timedOut ? new ProjectHomeBackgroundError('TIMEOUT') : interrupted());
    controller.signal.addEventListener('abort', stop, {once: true});
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    try {
      return await Promise.race([(async () => {
        const response = await fetcher('/api/background-tasks?' + query.toString(), {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        const body = await readBoundedJsonResponse(response, {signal: controller.signal, maxBytes: BACKGROUND_TASK_QUERY_LIMITS.responseBytes});
        if (!record(body) || typeof body.ok !== 'boolean' || body.ok !== response.ok || body.ok && response.status !== 200 || Object.keys(body).length !== 2) throw protocol();
        if (!body.ok) {
          if (!Object.hasOwn(body, 'error') || !record(body.error)) throw protocol();
          const error = body.error;
          if (Object.keys(error).some(key => !['code', 'message', 'details', 'retryable'].includes(key)) || typeof error.code !== 'string' ||
            !Object.hasOwn(serverStatuses, error.code) || serverStatuses[error.code as keyof typeof serverStatuses] !== response.status ||
            typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
            error.details !== undefined && !record(error.details) || error.retryable !== undefined && error.retryable !== false) throw protocol();
          throw new ProjectHomeBackgroundError(error.code as keyof typeof serverStatuses, response.status);
        }
        if (!Object.hasOwn(body, 'data')) throw protocol();
        const parsed = backgroundTaskQueryResponseSchema.safeParse(body.data);
        if (!parsed.success) throw protocol();
        return parsed.data;
      })(), stopped]);
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (timedOut) throw new ProjectHomeBackgroundError('TIMEOUT');
      if (error instanceof ProjectHomeBackgroundError) throw error;
      if (error instanceof ProjectEntryDirectoryError && ['BACKEND_PROTOCOL_ERROR', 'VALIDATION_ERROR', 'BACKEND_UNAVAILABLE', 'INTERRUPTED'].includes(error.code))
        throw new ProjectHomeBackgroundError(error.code as 'BACKEND_PROTOCOL_ERROR' | 'VALIDATION_ERROR' | 'BACKEND_UNAVAILABLE' | 'INTERRUPTED');
      throw new ProjectHomeBackgroundError('BACKEND_UNAVAILABLE');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', stop);
    }
  }};
}
export type ProjectHomeBackgroundClient = ReturnType<typeof createProjectHomeBackgroundClient>;
