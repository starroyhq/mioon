import {ApiError} from './api.ts';
import {projectApiPath} from '../../../packages/contracts/src/project-file.ts';

/** Format 3/4 receipts answer only `applied`/`operation`. A format-5 editor
 * receipt may also prove its own status; `not_applied` is a definite
 * conclusion, never equal to a missing receipt. */
export interface RequestOutcome {readonly applied: boolean;readonly operation: string|null;
  readonly status?: 'applied'|'not_applied';readonly code?: string|null}
export interface RequestOutcomeReadInput {readonly projectId: string;readonly requestId: string}
export interface RequestOutcomeReadOptions {readonly signal?: AbortSignal}
export interface RequestOutcomeClient {read(input: RequestOutcomeReadInput,options?: RequestOutcomeReadOptions): Promise<RequestOutcome>}
export interface CreateRequestOutcomeClientOptions {fetcher?: typeof fetch}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocol = (message: string): ApiError => new ApiError(message,'REQUEST_OUTCOME_INVALID',{},false);
const errorCode = (error: unknown): string|undefined => isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
const errorMessage = (error: unknown): string|undefined => isRecord(error) && typeof error.message === 'string' ? error.message : undefined;

/** Bounded read-only receipt lookup. Every failure is thrown so the caller can
 * keep its retained request; a transport failure is never treated as evidence
 * that the original write was not applied. */
export function createRequestOutcomeClient({fetcher = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => fetch(...args)}: CreateRequestOutcomeClientOptions = {}): RequestOutcomeClient {
  return {
    async read({projectId,requestId},{signal}: RequestOutcomeReadOptions = {}): Promise<RequestOutcome> {
      if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 200 || /\s/u.test(requestId)) throw protocol('Invalid retained request ID.');
      let path: string;
      try { path = projectApiPath(projectId,'request-outcome'); }
      catch { throw new ApiError('The request has no valid project address.','VALIDATION_ERROR',{},true); }
      const response = await fetcher(`${path}?requestId=${encodeURIComponent(requestId)}`,{method: 'GET',credentials: 'same-origin',cache: 'no-store',...(signal ? {signal} : {})});
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new ApiError('The request outcome could not be read.','REQUEST_OUTCOME_UNAVAILABLE',{},false,response.status); }
      if (!isRecord(payload) || typeof payload.ok !== 'boolean') throw protocol('Invalid request outcome response.');
      if (!payload.ok || !response.ok) throw new ApiError(errorMessage(payload.error) ?? 'The request outcome could not be read.',errorCode(payload.error) ?? 'REQUEST_OUTCOME_UNAVAILABLE',isRecord(payload.error) ? payload.error.details : undefined,false,response.status);
      const data = payload.data;
      if (!isRecord(data) || typeof data.applied !== 'boolean' || !(data.operation === null || typeof data.operation === 'string'))
        throw protocol('Invalid request outcome response.');
      const status = data.status, code = data.code;
      if (status !== undefined && status !== 'applied' && status !== 'not_applied') throw protocol('Invalid request outcome response.');
      if (code !== undefined && code !== null && (typeof code !== 'string' || code.length < 1 || code.length > 200))
        throw protocol('Invalid request outcome response.');
      if (status === 'applied') {
        if (data.applied !== true || code !== null) throw protocol('Invalid request outcome response.');
        return {applied: true,operation: data.operation,status: 'applied',code: null};
      }
      if (status === 'not_applied') {
        if (data.applied !== false || typeof code !== 'string') throw protocol('Invalid request outcome response.');
        return {applied: false,operation: data.operation,status: 'not_applied',code};
      }
      // A code without a status, or an applied conclusion without `status`,
      // keeps the original two-field shape. Any extra field is a protocol error.
      if (code !== undefined) throw protocol('Invalid request outcome response.');
      return {applied: data.applied,operation: data.operation};
    },
  };
}
