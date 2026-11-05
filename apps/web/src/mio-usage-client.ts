import {projectApiPath, projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import {mioRunUsageSchema} from '../../../packages/contracts/src/mio-run-usage.ts';
import type {MioRunUsage} from '../../../packages/contracts/src/mio-run-usage.ts';
import {readBoundedJsonResponse} from './project-entry-directory-client.ts';

export class MioUsageReadError extends Error {
  readonly code:string; readonly status?:number;
  constructor(code: string, status?: number) { super('This round’s usage could not be verified.'); this.name = 'MioUsageReadError'; this.code=code; if(status!==undefined)this.status=status; }
}
export interface MioUsageReadOptions {readonly signal?: AbortSignal}
export interface MioUsageClient {read(projectId: string, runId: string, options?: MioUsageReadOptions): Promise<MioRunUsage>}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const statuses: Readonly<Record<string, number>> = Object.freeze({UNAUTHORIZED:401, ORIGIN_REJECTED:403, METHOD_NOT_ALLOWED:405, VALIDATION_ERROR:400,
  AGENT_TASK_NOT_FOUND:404, PROJECT_NOT_FOUND:404, NOT_FOUND:404, PROJECT_UNAVAILABLE:409, PROJECT_HOST_STOPPED:503, INTERNAL_ERROR:500});

/** A passive, independently cancellable GET. It never borrows an execution or
 * SSE controller, retries a request, or accepts a caller-selected URL. */
export function createMioUsageClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 12_000}: {readonly fetcher?: typeof fetch; readonly timeoutMs?: number} = {}): MioUsageClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || typeof fetcher !== 'function') throw new MioUsageReadError('VALIDATION_ERROR');
  return {async read(projectId, runId, options = {}) {
    if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(runId).success || !record(options) || Object.keys(options).some(key => key !== 'signal') || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new MioUsageReadError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw new MioUsageReadError('INTERRUPTED');
    const controller = new AbortController(); let timedOut = false;
    let rejectAbort!: (error: MioUsageReadError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
    const stop = () => rejectAbort(new MioUsageReadError(timedOut ? 'TIMEOUT' : 'INTERRUPTED'));
    const cancel = () => controller.abort();
    controller.signal.addEventListener('abort', stop, {once:true});
    options.signal?.addEventListener('abort', cancel, {once:true});
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    try {
      if (options.signal?.aborted) controller.abort();
      return await Promise.race([(async () => {
        const response = await fetcher(projectApiPath(projectId, 'agent', 'tasks', 'v2', runId, 'usage'), {method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal});
        if (controller.signal.aborted) throw new MioUsageReadError(timedOut ? 'TIMEOUT' : 'INTERRUPTED');
        const body = await readBoundedJsonResponse(response, {signal:controller.signal, maxBytes:16 * 1024});
        if (!record(body) || typeof body.ok !== 'boolean' || body.ok !== response.ok || Object.keys(body).length !== 2) throw new MioUsageReadError('BACKEND_PROTOCOL_ERROR');
        if (!body.ok) {
          if (!record(body.error) || typeof body.error.code !== 'string' || statuses[body.error.code] !== response.status || Object.keys(body.error).some(key => !['code','message','details','retryable'].includes(key))) throw new MioUsageReadError('BACKEND_PROTOCOL_ERROR');
          throw new MioUsageReadError(body.error.code, response.status);
        }
        const parsed = mioRunUsageSchema.safeParse(body.data);
        if (response.status !== 200 || !parsed.success || parsed.data.runId !== runId) throw new MioUsageReadError('BACKEND_PROTOCOL_ERROR');
        return parsed.data;
      })(), interrupted]);
    } catch (error) {
      if (options.signal?.aborted) throw new MioUsageReadError('INTERRUPTED');
      if (timedOut) throw new MioUsageReadError('TIMEOUT');
      if (error instanceof MioUsageReadError) throw error;
      if (record(error) && error.code === 'BACKEND_PROTOCOL_ERROR') throw new MioUsageReadError('BACKEND_PROTOCOL_ERROR');
      throw new MioUsageReadError('BACKEND_UNAVAILABLE');
    } finally {clearTimeout(timer); controller.signal.removeEventListener('abort', stop); options.signal?.removeEventListener('abort', cancel);}
  }};
}
