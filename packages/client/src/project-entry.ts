import {z} from 'zod';
import {PROJECT_ENTRY_ERROR_STATUS, PROJECT_ENTRY_LIMITS, projectEntriesResponseSchema} from '../../contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../../contracts/src/project-entry.ts';
import {resolveConnection} from './connection.ts';
import {ClientError, EXIT_CODES} from './index.ts';
import type {ClientOptions} from './index.ts';

export interface ProjectEntryRequestOptions {readonly signal?: AbortSignal; readonly timeoutMs?: number}
const optionsSchema = z.object({signal: z.instanceof(AbortSignal).optional(), timeoutMs: z.number().int().min(1).max(86_400_000).optional()}).strict();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (): ClientError => new ClientError('BACKEND_PROTOCOL_ERROR', 'Invalid local project catalog response.');
const errorStatuses: Readonly<Record<string, number>> = Object.freeze({...PROJECT_ENTRY_ERROR_STATUS,
  UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 400, NOT_FOUND: 404,
  PROJECT_HOST_STOPPED: 503, APP_LIBRARY_INVALID: 422, APP_LIBRARY_LIMIT: 507, INTERNAL_ERROR: 500,
});

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw protocol();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = (): void => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', cancel, {once: true});
  let bytes = 0;
  try {
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw protocol();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > PROJECT_ENTRY_LIMITS.responseBytes)) throw protocol();
    for (;;) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PROJECT_ENTRY_LIMITS.responseBytes) throw protocol();
      chunks.push(value);
    }
    if (length !== null && bytes !== Number(length)) throw protocol();
    try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;}
    catch {throw protocol();}
  } finally {signal.removeEventListener('abort', cancel); cancel();}
}

/** Fixed read-only resource. Channel filtering is decided by the trusted
 * server, never by a path, mode, query parameter or automatic retry here. */
export function createProjectEntriesClient({env = process.env, fetchImpl = fetch, requestTimeoutMs = 30_000}: ClientOptions = {}) {
  return {async list(rawOptions: ProjectEntryRequestOptions = {}): Promise<ProjectEntriesResponse> {
    const parsed = optionsSchema.safeParse(rawOptions);
    if (!parsed.success) throw new ClientError('VALIDATION_ERROR', 'Invalid project catalog request options.');
    const options = parsed.data, timeoutMs = options.timeoutMs ?? requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ClientError('VALIDATION_ERROR', 'Invalid project catalog timeout.');
    const interrupted = (): ClientError => new ClientError('INTERRUPTED', 'Project catalog reading stopped locally.', {exitCode: EXIT_CODES.interrupted});
    if (options.signal?.aborted) throw interrupted();
    const {base, token} = await resolveConnection(env);
    if (options.signal?.aborted) throw interrupted();
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const rejectStopped = (): void => rejectAbort?.(timedOut
      ? new ClientError('TIMEOUT', 'Project catalog reading timed out.', {exitCode: EXIT_CODES.timeout}) : interrupted());
    controller.signal.addEventListener('abort', rejectStopped, {once: true});
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(base + '/api/project-entries', {method: 'GET', headers: {authorization: 'Bearer ' + token},
          redirect: 'error', cache: 'no-store', signal: controller.signal});
        const value = await readJson(response, controller.signal);
        if (!object(value) || typeof value.ok !== 'boolean' || value.ok !== response.ok || response.status !== 200 && value.ok) throw protocol();
        if (!value.ok) {
          if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'error') || !object(value.error)) throw protocol();
          const error = value.error;
          if (Object.keys(error).some(key => !['code', 'message', 'details', 'retryable'].includes(key)) || typeof error.code !== 'string' ||
            !Object.hasOwn(errorStatuses, error.code) || errorStatuses[error.code] !== response.status || typeof error.message !== 'string' ||
            error.message.length < 1 || error.message.length > 1000 || error.details !== undefined && !object(error.details) ||
            error.retryable !== undefined && error.retryable !== false) throw protocol();
          throw new ClientError(error.code, 'The local backend rejected the project catalog read.', {status: response.status});
        }
        if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'data')) throw protocol();
        const result = projectEntriesResponseSchema.safeParse(value.data);
        if (!result.success) throw protocol();
        return result.data;
      })(), stopped]);
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (timedOut) throw new ClientError('TIMEOUT', 'Project catalog reading timed out.', {exitCode: EXIT_CODES.timeout});
      if (error instanceof ClientError) throw error;
      throw new ClientError('BACKEND_UNAVAILABLE', 'The local project catalog backend is unavailable.');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectStopped);
    }
  }};
}
export type ProjectEntriesClient = ReturnType<typeof createProjectEntriesClient>;
