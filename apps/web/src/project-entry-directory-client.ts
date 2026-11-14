import {measureSettingsRead} from './settings-diagnostics.ts';
import {PROJECT_ENTRY_ERROR_STATUS, PROJECT_ENTRY_LIMITS, projectEntriesResponseSchema, projectEntryIdentitySchema} from '../../../packages/contracts/src/project-entry.ts';

const serverStatuses = Object.freeze({...PROJECT_ENTRY_ERROR_STATUS,
  UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 400, NOT_FOUND: 404,
  PROJECT_HOST_STOPPED: 503, APP_LIBRARY_INVALID: 422, APP_LIBRARY_LIMIT: 507, INTERNAL_ERROR: 500,
});
export type ProjectEntryDirectoryErrorCode = keyof typeof serverStatuses | 'BACKEND_PROTOCOL_ERROR' | 'BACKEND_UNAVAILABLE' | 'TIMEOUT' | 'INTERRUPTED';
export class ProjectEntryDirectoryError extends Error {
  readonly code: ProjectEntryDirectoryErrorCode;
  readonly status?: number;
  constructor(code: ProjectEntryDirectoryErrorCode, status?: number) {
    super('The project directory could not be read.');
    this.name = 'ProjectEntryDirectoryError'; this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (): ProjectEntryDirectoryError => new ProjectEntryDirectoryError('BACKEND_PROTOCOL_ERROR');
const interrupted = (): ProjectEntryDirectoryError => new ProjectEntryDirectoryError('INTERRUPTED');
const validSignal = (value: unknown): value is AbortSignal | undefined => value === undefined || value instanceof AbortSignal;

/** Bounded decoded JSON for fixed same-origin read resources. It checks bytes
 * before decoding and also cancels streams that ignore their request signal. */
export async function readBoundedJsonResponse(response: Response, {signal, maxBytes}: {readonly signal?: AbortSignal; readonly maxBytes: number}): Promise<unknown> {
  if (!validSignal(signal) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ProjectEntryDirectoryError('VALIDATION_ERROR');
  if (!response.body) throw protocol();
  const reader = response.body.getReader();
  let cancelled = false, complete = false, bytes = 0;
  const cancel = (): void => {if (!cancelled && !complete) {cancelled = true; void reader.cancel().catch(() => {});}};
  let rejectAbort: ((error: ProjectEntryDirectoryError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
  const stop = (): void => {cancel(); rejectAbort?.(interrupted());};
  signal?.addEventListener('abort', stop, {once: true});
  try {
    if (signal?.aborted) throw interrupted();
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) throw protocol();
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(advertised) || !Number.isSafeInteger(Number(advertised)) || Number(advertised) > maxBytes)) throw protocol();
    const decoder = new TextDecoder('utf-8', {fatal: true}), parts: string[] = [];
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) throw interrupted();
      if (chunk.done) {complete = true; break;}
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw protocol();
      try {parts.push(decoder.decode(chunk.value, {stream: true}));} catch {throw protocol();}
    }
    if (advertised !== null && bytes !== Number(advertised)) throw protocol();
    try {parts.push(decoder.decode()); return JSON.parse(parts.join('')) as unknown;} catch {throw protocol();}
  } catch (error) {
    if (signal?.aborted) throw interrupted();
    if (error instanceof ProjectEntryDirectoryError) throw error;
    throw new ProjectEntryDirectoryError('BACKEND_UNAVAILABLE');
  } finally {
    signal?.removeEventListener('abort', stop); cancel();
    reader.releaseLock();
  }
}

/** The server's trusted channel selects Web root filtering or desktop recent
 * registrations. Renderer URL parameters never select a directory mode. */
export function createProjectEntryDirectoryClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 30_000}: {
  readonly fetcher?: typeof fetch; readonly timeoutMs?: number;
} = {}) {
  async function read<T>(route: '/api/project-entries' | '/api/project-entries/identity',
    schema: {safeParse(value: unknown): {success: true; data: T} | {success: false}}, maxBytes: number,
    options: {readonly signal?: AbortSignal} = {}): Promise<T> {
    if (!record(options) || Object.keys(options).some(key => key !== 'signal') || !validSignal(options.signal) ||
      typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ProjectEntryDirectoryError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw interrupted();
    const controller = new AbortController(); let timedOut = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    let rejectAbort: ((error: ProjectEntryDirectoryError) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = (): void => rejectAbort?.(timedOut ? new ProjectEntryDirectoryError('TIMEOUT') : interrupted());
    controller.signal.addEventListener('abort', stop, {once: true});
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    try {
      return await Promise.race([(async () => {
        const response = await fetcher(route, {method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal});
        const body = await readBoundedJsonResponse(response, {signal: controller.signal, maxBytes});
        if (!record(body) || typeof body.ok !== 'boolean' || body.ok !== response.ok || body.ok && response.status !== 200 || Object.keys(body).length !== 2) throw protocol();
        if (!body.ok) {
          if (!Object.hasOwn(body, 'error') || !record(body.error)) throw protocol();
          const error = body.error;
          if (Object.keys(error).some(key => !['code', 'message', 'details', 'retryable'].includes(key)) || typeof error.code !== 'string' ||
            !Object.hasOwn(serverStatuses, error.code) || serverStatuses[error.code as keyof typeof serverStatuses] !== response.status ||
            typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
            error.details !== undefined && !record(error.details) || error.retryable !== undefined && error.retryable !== false) throw protocol();
          throw new ProjectEntryDirectoryError(error.code as keyof typeof serverStatuses, response.status);
        }
        if (!Object.hasOwn(body, 'data')) throw protocol();
        const parsed = schema.safeParse(body.data);
        if (!parsed.success) throw protocol();
        return parsed.data;
      })(), stopped]);
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (timedOut) throw new ProjectEntryDirectoryError('TIMEOUT');
      if (error instanceof ProjectEntryDirectoryError) throw error;
      throw new ProjectEntryDirectoryError('BACKEND_UNAVAILABLE');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', stop);
    }
  }
  return {
    list: (options?: {readonly signal?: AbortSignal}) => measureSettingsRead('workspace-directory',
      () => read('/api/project-entries', projectEntriesResponseSchema, PROJECT_ENTRY_LIMITS.responseBytes, options)),
    readIdentity: (options?: {readonly signal?: AbortSignal}) => measureSettingsRead('workspace-identity',
      () => read('/api/project-entries/identity', projectEntryIdentitySchema, 4096, options)),
  };
}
