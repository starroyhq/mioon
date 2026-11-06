import {isLocalRecordResponse, LOCAL_RECORDS_LIMITS, localRecordSchemas, localRecordsDeleteResponseSchema, localRecordsListResponseSchema} from '../../../packages/contracts/src/local-record-operations.ts';
import type {LocalRecordOperation, LocalRecordsDeleteInput, LocalRecordsDeleteResponse, LocalRecordsListResponse} from '../../../packages/contracts/src/local-record-operations.ts';
import {readBoundedJsonResponse} from './project-entry-directory-client.ts';

export class LocalRecordsRequestError extends Error {
  readonly code: string; readonly outcomeUnknown: boolean;
  constructor(code: string, outcomeUnknown = false) {super('The local records request did not complete.'); this.name = 'LocalRecordsRequestError';this.code = code;this.outcomeUnknown = outcomeUnknown;}
}
export interface LocalRecordsClient {
  list(options?: {readonly signal?: AbortSignal}): Promise<LocalRecordsListResponse>;
  delete(input: LocalRecordsDeleteInput, options?: {readonly signal?: AbortSignal}): Promise<LocalRecordsDeleteResponse>;
}
const statuses = Object.freeze({LOCAL_RECORDS_NOT_FOUND:404, LOCAL_RECORDS_IN_USE:409, LOCAL_RECORDS_SUPER_JOURNAL:409,
  LOCAL_RECORDS_IDENTITY_CHANGED:409, LOCAL_RECORDS_DELETE_UNCERTAIN:503, LOCAL_RECORDS_LIMIT:413,
  APP_LIBRARY_CLOSED:503, APP_LIBRARY_INVALID:422, APP_LIBRARY_LOCKED:409, APP_LIBRARY_LIMIT:507,
  PROJECT_ENTRY_UNAVAILABLE:503, PROJECT_HOST_STOPPED:503, OPERATION_CANCELLED:503,
  VALIDATION_ERROR:400, UNKNOWN_OPERATION:404, UNAUTHORIZED:401, ORIGIN_REJECTED:403, METHOD_NOT_ALLOWED:405, INTERNAL_ERROR:500});
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (): never => {throw new LocalRecordsRequestError('BACKEND_PROTOCOL_ERROR');};

/** Same-origin application operations; a deletion is never replayed by this
 * transport. A lost acknowledgement is not evidence that no files changed. */
export function createLocalRecordsClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 30_000}: {
  readonly fetcher?: typeof fetch; readonly timeoutMs?: number;
} = {}): LocalRecordsClient {
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new LocalRecordsRequestError('VALIDATION_ERROR');
  async function call(operation: LocalRecordOperation, input: unknown, options: {readonly signal?: AbortSignal}): Promise<unknown> {
    if (!object(options) || Object.keys(options).some(key => key !== 'signal') || options.signal !== undefined && !(options.signal instanceof AbortSignal)
      || !localRecordSchemas[operation].safeParse(input).success) throw new LocalRecordsRequestError('VALIDATION_ERROR');
    if (options.signal?.aborted) throw new LocalRecordsRequestError('INTERRUPTED');
    const controller = new AbortController(); let timedOut = false, dispatched = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, {once:true});
    const stopped = new Promise<never>((_resolve,reject) => controller.signal.addEventListener('abort', () => reject(new LocalRecordsRequestError(timedOut ? 'TIMEOUT' : 'INTERRUPTED')), {once:true}));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, timeoutMs);
    try {
      return await Promise.race([(async () => {
        dispatched = true;
        const response = await fetcher('/api/rpc', {method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
          headers:{'content-type':'application/json'}, body:JSON.stringify({operation,input}), signal:controller.signal});
        const body = await readBoundedJsonResponse(response, {signal:controller.signal,maxBytes:LOCAL_RECORDS_LIMITS.responseBytes});
        if (!object(body) || Object.keys(body).length !== 2 || typeof body.ok !== 'boolean' || body.ok !== response.ok) return protocol();
        if (!body.ok) {
          if (!object(body.error) || Object.keys(body.error).some(key => !['code','message','details','retryable'].includes(key))) return protocol();
          const error = body.error;
          if (typeof error.code !== 'string' || !Object.hasOwn(statuses,error.code) || statuses[error.code as keyof typeof statuses] !== response.status
            || typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000
            || error.details !== undefined && !object(error.details) || error.retryable !== undefined && typeof error.retryable !== 'boolean') return protocol();
          throw new LocalRecordsRequestError(error.code, operation === 'local.records.delete' && response.status >= 500);
        }
        if (response.status !== 200 || !Object.hasOwn(body,'data') || !isLocalRecordResponse(operation,input,body.data)) return protocol();
        return body.data;
      })(),stopped]);
    } catch (error) {
      if (error instanceof LocalRecordsRequestError && !['BACKEND_PROTOCOL_ERROR','INTERRUPTED','TIMEOUT'].includes(error.code)) throw error;
      const code = options.signal?.aborted ? 'INTERRUPTED' : timedOut ? 'TIMEOUT' : error instanceof LocalRecordsRequestError ? error.code : 'BACKEND_UNAVAILABLE';
      throw new LocalRecordsRequestError(code, operation === 'local.records.delete' && dispatched);
    } finally {clearTimeout(timer); options.signal?.removeEventListener('abort',abort);}
  }
  return {
    async list(options = {}) {return localRecordsListResponseSchema.parse(await call('local.records.list',{},options));},
    async delete(input,options = {}) {return localRecordsDeleteResponseSchema.parse(await call('local.records.delete',input,options));},
  };
}
