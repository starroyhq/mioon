import { clipDraftEnvelopeSchema } from '../../../packages/contracts/src/local-drafts.ts';
import type { ClipDraftClient, ClipDraftDelete, ClipDraftEnvelope, ClipDraftKey, ClipDraftRead, ClipDraftWrite } from './clip-draft-state.ts';

export type ClipDraftFailureKind = 'refused' | 'conflict' | 'unknown';
export interface ClipDraftFailure { code: string; status: number | null; kind: ClipDraftFailureKind }
const refusals: Readonly<Record<string, number>> = Object.freeze({ LOCAL_DRAFT_VALIDATION: 400, LOCAL_DRAFT_OWNER_REQUIRED: 403, LOCAL_DRAFT_NOT_FOUND: 404, LOCAL_DRAFT_LIMIT: 413, LOCAL_DRAFT_CAPACITY: 507 });
const conflicts: Readonly<Record<string, number>> = Object.freeze({ LOCAL_DRAFT_CONFLICT: 409, LOCAL_DRAFT_STALE_INSTANCE: 409, LOCAL_DRAFT_SCOPE_MISMATCH: 409 });
/** A classification is evidence about this response only. It never revokes an
 * earlier uncertain write, nor infers an outcome from a message or status alone. */
export class ClipDraftRequestError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly kind: ClipDraftFailureKind;
  constructor(message: string, code = 'LOCAL_DRAFT_RESPONSE_UNKNOWN', status: number | null = null) {
    super(message); this.name = 'ClipDraftRequestError'; this.code = code; this.status = status;
    this.kind = refusals[code] === status ? 'refused' : conflicts[code] === status ? 'conflict' : 'unknown';
  }
}
export function clipDraftFailure(error: unknown): ClipDraftFailure {
  return error instanceof ClipDraftRequestError ? { code: error.code, status: error.status, kind: error.kind }
    : { code: 'LOCAL_DRAFT_RESPONSE_UNKNOWN', status: null, kind: 'unknown' };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const endpoint = '/api/local-drafts/clip';
export function createClipDraftClient(fetcher: typeof fetch = (...args) => fetch(...args)): ClipDraftClient {
  async function request(method: 'GET' | 'PUT' | 'DELETE', input: ClipDraftKey | ClipDraftWrite | ClipDraftDelete): Promise<ClipDraftRead> {
    const query = method === 'GET' ? `?${new URLSearchParams(input as unknown as Record<string, string>)}` : '';
    let response: Response;
    try { response = await fetcher(endpoint + query, { method, credentials: 'same-origin', cache: 'no-store', ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }); }
    catch { throw new ClipDraftRequestError('本地草稿请求未收到确认；写入结果可能仍待确认。', 'LOCAL_DRAFT_NETWORK_UNKNOWN'); }
    const protocol = () => new ClipDraftRequestError('本地草稿服务返回无效确认；未替换当前输入。', 'LOCAL_DRAFT_PROTOCOL_UNKNOWN', response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw protocol(); }
    if (!object(body) || typeof body.ok !== 'boolean') throw protocol();
    if (!body.ok) {
      const error = body.error;
      if (response.ok || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'error') || !object(error) ||
          Object.keys(error).length !== 4 || !['code', 'message', 'details', 'retryable'].every(key => Object.hasOwn(error, key)) ||
          typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ||
          typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
          !object(error.details) || Object.keys(error.details).length !== 0 || error.retryable !== false) throw protocol();
      throw new ClipDraftRequestError(error.message, error.code, response.status);
    }
    if (!response.ok) throw protocol();
    const value = clipDraftEnvelopeSchema.safeParse(body.data);
    if (!value.success) throw protocol();
    return value.data;
  }
  async function write(method: 'PUT' | 'DELETE', input: ClipDraftWrite | ClipDraftDelete): Promise<ClipDraftEnvelope> {
    const result = await request(method, input);
    if (!result.supported) throw new ClipDraftRequestError('恢复分支暂不支持本地片段草稿。', 'LOCAL_DRAFT_WRITE_UNSUPPORTED');
    return result;
  }
  return { get: key => request('GET', key), put: value => write('PUT', value), remove: value => write('DELETE', value) };
}
