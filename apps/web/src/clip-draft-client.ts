import { clipDraftEnvelopeSchema, clipDraftWriteSchema, clipDraftDeleteSchema, LOCAL_DRAFT_LIMITS } from '../../../packages/contracts/src/local-drafts.ts';
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
const protocolError = (status: number) => new ClipDraftRequestError('本地草稿服务返回无效确认；未替换当前输入。', 'LOCAL_DRAFT_PROTOCOL_UNKNOWN', status);
const timeoutError = () => new ClipDraftRequestError('本地草稿请求超时，结果仍待确认。中断连接不会取消草稿保存或删除。', 'LOCAL_DRAFT_TIMEOUT_UNKNOWN');
async function boundedJSON(response: Response, signal: AbortSignal, expiresAt: number): Promise<unknown> {
  if (!response.body) throw protocolError(response.status);
  // A single saved row is at most rowBytes (8 KiB). The 12 KiB HTTP budget
  // also accommodates the authority, key and success-envelope metadata.
  const limit = LOCAL_DRAFT_LIMITS.httpBytes, bytes = new Uint8Array(limit);
  const reader = response.body.getReader(); let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const expired = () => signal.aborted || Date.now() >= expiresAt;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) throw protocolError(response.status);
    for (;;) {
      if (expired()) throw timeoutError();
      const part = await reader.read();
      if (expired()) throw timeoutError();
      if (part.done) break;
      if (part.value.byteLength > limit - length) throw protocolError(response.status);
      bytes.set(part.value, length); length += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } catch (error) {
    cancel();
    if (expired() || error instanceof ClipDraftRequestError && error.code === 'LOCAL_DRAFT_TIMEOUT_UNKNOWN') throw timeoutError();
    throw protocolError(response.status);
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Complete outgoing admission, before fetch. A refusal does not replace any
 * existing record or establish the outcome of an earlier uncertain write. */
export function admitClipDraftRequest(method: 'PUT' | 'DELETE', input: ClipDraftWrite | ClipDraftDelete): void {
  if (bytes(input) > LOCAL_DRAFT_LIMITS.httpBytes) throw new ClipDraftRequestError('Local draft input exceeds the size limit.', 'LOCAL_DRAFT_LIMIT', 413);
  if (method === 'PUT') {
    const write = input as ClipDraftWrite;
    const row = { projectId: write.projectId, timelineId: write.timelineId, clipId: write.clipId, revision: write.expectedRevision + 1,
      draft: { baseRevision: write.baseRevision, source: write.source, raw: write.raw, updatedAt: '2000-01-01T00:00:00.000Z' } };
    if (bytes(row) > LOCAL_DRAFT_LIMITS.rowBytes || bytes({ ok: true, data: { supported: true, workspaceScope: write.workspaceScope, instanceId: write.instanceId,
      key: { projectId: write.projectId, timelineId: write.timelineId, clipId: write.clipId }, revision: row.revision, targetStatus: 'matching', draft: row.draft } }) > LOCAL_DRAFT_LIMITS.httpBytes)
      throw new ClipDraftRequestError('Local draft input exceeds the size limit.', 'LOCAL_DRAFT_LIMIT', 413);
  }
  const parsed = (method === 'PUT' ? clipDraftWriteSchema : clipDraftDeleteSchema).safeParse(input);
  if (!parsed.success) throw new ClipDraftRequestError('Invalid local draft input.', 'LOCAL_DRAFT_VALIDATION', 400);
}
/** Deadlines bound HTTP transport only, including response headers and body.
 * They do not cancel backend writes, establish refusal, or authorize a retry. */
export function createClipDraftClient(fetcher: typeof fetch = (...args) => fetch(...args), { timeoutMs = 10000 }: { timeoutMs?: number } = {}): ClipDraftClient {
  async function request(method: 'GET' | 'PUT' | 'DELETE', input: ClipDraftKey | ClipDraftWrite | ClipDraftDelete): Promise<ClipDraftRead> {
    if (method !== 'GET') admitClipDraftRequest(method, input as ClipDraftWrite | ClipDraftDelete);
    const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(60000, timeoutMs)) : 10000;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = perform(method, input, controller.signal, Date.now() + deadline);
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(timeoutError()); controller.abort();
      }, deadline); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function perform(method: 'GET' | 'PUT' | 'DELETE', input: ClipDraftKey | ClipDraftWrite | ClipDraftDelete, signal: AbortSignal, expiresAt: number): Promise<ClipDraftRead> {
    const query = method === 'GET' ? `?${new URLSearchParams(input as unknown as Record<string, string>)}` : '';
    let response: Response;
    try { response = await fetcher(endpoint + query, { method, credentials: 'same-origin', cache: 'no-store', signal, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }); }
    catch {
      if (signal.aborted || Date.now() >= expiresAt) throw timeoutError();
      throw new ClipDraftRequestError('本地草稿请求未收到确认；写入结果可能仍待确认。', 'LOCAL_DRAFT_NETWORK_UNKNOWN');
    }
    if (signal.aborted || Date.now() >= expiresAt) {
      if (response.body) void response.body.cancel().catch(() => {});
      throw timeoutError();
    }
    const protocol = () => protocolError(response.status);
    const body = await boundedJSON(response, signal, expiresAt);
    if (!object(body) || typeof body.ok !== 'boolean' || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'ok')) throw protocol();
    if (!body.ok) {
      const error = body.error;
      if (response.ok || !Object.hasOwn(body, 'error') || !object(error) ||
          Object.keys(error).length !== 4 || !['code', 'message', 'details', 'retryable'].every(key => Object.hasOwn(error, key)) ||
          typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ||
          typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
          !object(error.details) || Object.keys(error.details).length !== 0 || error.retryable !== false) throw protocol();
      throw new ClipDraftRequestError(error.message, error.code, response.status);
    }
    if (response.status !== 200 || !Object.hasOwn(body, 'data')) throw protocol();
    const value = clipDraftEnvelopeSchema.safeParse(body.data);
    if (!value.success) throw protocol();
    if (value.data.supported && value.data.draft && bytes({ ...value.data.key, revision: value.data.revision, draft: value.data.draft }) > LOCAL_DRAFT_LIMITS.rowBytes) throw protocol();
    return value.data;
  }
  async function write(method: 'PUT' | 'DELETE', input: ClipDraftWrite | ClipDraftDelete): Promise<ClipDraftEnvelope> {
    const result = await request(method, input);
    if (!result.supported) throw new ClipDraftRequestError('恢复分支暂不支持本地片段草稿。', 'LOCAL_DRAFT_WRITE_UNSUPPORTED');
    return result;
  }
  return { get: key => request('GET', key), put: value => write('PUT', value), remove: value => write('DELETE', value) };
}
