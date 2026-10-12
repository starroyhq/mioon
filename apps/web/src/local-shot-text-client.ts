import { createLocalShotTextSchemas, LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import type { LocalShotTextDraftPut, LocalShotTextDraftDelete, LocalShotTextPrepare, LocalShotTextExecute, LocalShotTextEnvelope, LocalShotTextExecution } from '@mioon/contracts/local-shot-text';

export type LocalShotTextFailureKind = 'refused' | 'conflict' | 'unknown';
export interface LocalShotTextFailure { code: string; status: number | null; kind: LocalShotTextFailureKind }
const refusals: Readonly<Record<string, number>> = Object.freeze({ LOCAL_SHOT_TEXT_LOCAL_VALIDATION: 400, LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT: 400, LOCAL_SHOT_TEXT_VALIDATION: 400, LOCAL_SHOT_TEXT_OWNER_REQUIRED: 403, LOCAL_SHOT_TEXT_NOT_FOUND: 404, LOCAL_SHOT_TEXT_LIMIT: 413, LOCAL_SHOT_TEXT_CAPACITY: 507 });
const conflicts: Readonly<Record<string, number>> = Object.freeze({ LOCAL_SHOT_TEXT_CONFLICT: 409, LOCAL_SHOT_TEXT_STALE_INSTANCE: 409, LOCAL_SHOT_TEXT_SCOPE_MISMATCH: 409 });
export class LocalShotTextRequestError extends Error {
  readonly code: string; readonly status: number | null; readonly kind: LocalShotTextFailureKind;
  constructor(message: string, code = 'LOCAL_SHOT_TEXT_RESPONSE_UNKNOWN', status: number | null = null) {
    super(message); this.name = 'LocalShotTextRequestError'; this.code = code; this.status = status;
    this.kind = refusals[code] === status ? 'refused' : conflicts[code] === status ? 'conflict' : 'unknown';
  }
}
export function localShotTextFailure(error: unknown): LocalShotTextFailure {
  return error instanceof LocalShotTextRequestError ? { code: error.code, status: error.status, kind: error.kind }
    : { code: 'LOCAL_SHOT_TEXT_RESPONSE_UNKNOWN', status: null, kind: 'unknown' };
}
export const localShotTextProtocolError = () => new LocalShotTextRequestError('本地镜头文字确认不完整。当前名称与原文字保存请求仍保留，请重新核对。', 'LOCAL_SHOT_TEXT_PROTOCOL_UNKNOWN');
export interface LocalShotTextClient {
  get(projectId: string, shotId: string): Promise<LocalShotTextEnvelope>;
  put(input: LocalShotTextDraftPut): Promise<LocalShotTextEnvelope>;
  discard(input: LocalShotTextDraftDelete): Promise<LocalShotTextEnvelope>;
  prepare(input: LocalShotTextPrepare): Promise<LocalShotTextEnvelope>;
  execute(input: LocalShotTextExecute): Promise<LocalShotTextExecution>;
  recover(input: LocalShotTextExecute): Promise<LocalShotTextExecution>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function boundedJSON(response: Response, signal: AbortSignal, limit: number, expiresAt: number): Promise<unknown> {
  if (!response.body) throw localShotTextProtocolError();
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) { cancel(); throw localShotTextProtocolError(); }
    for (;;) {
      if (signal.aborted || Date.now() >= expiresAt) { cancel(); throw new LocalShotTextRequestError('本地镜头文字请求超时，结果仍待确认。', 'LOCAL_SHOT_TEXT_TIMEOUT_UNKNOWN'); }
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > limit - length) { cancel(); throw localShotTextProtocolError(); }
      bytes.set(part.value, length); length += part.value.byteLength;
    }
    if (signal.aborted) throw localShotTextProtocolError();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } catch (error) { if (error instanceof LocalShotTextRequestError && error.code === 'LOCAL_SHOT_TEXT_TIMEOUT_UNKNOWN') throw error; throw localShotTextProtocolError(); }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
/** This transport has fixed-purpose endpoints only. A renderer never supplies
 * an operation, a settlement outcome, or a substitute input during recovery.
 * A timeout aborts only HTTP transport. It does not cancel backend business work. */
export function createLocalShotTextClient({ isShotUpdateInput, fetcher = (...args) => fetch(...args), timeoutMs = 10000, executionTimeoutMs = 35000 }: {
  isShotUpdateInput: (value: unknown) => boolean; fetcher?: typeof fetch; timeoutMs?: number; executionTimeoutMs?: number;
}): LocalShotTextClient {
  const schemas = createLocalShotTextSchemas(isShotUpdateInput);
  async function request(method: 'GET' | 'PUT' | 'DELETE' | 'POST', path: string, input?: unknown): Promise<unknown> {
    const execution = path === '/execute' || path === '/recover', requested = execution ? executionTimeoutMs : timeoutMs;
    const deadline = Number.isFinite(requested) ? Math.max(1, Math.min(60000, requested)) : execution ? 35000 : 10000;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const work = perform(method, path, input, controller.signal, execution ? LOCAL_SHOT_TEXT_LIMITS.executeResponseBytes : LOCAL_SHOT_TEXT_LIMITS.httpBytes, Date.now() + deadline);
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
        reject(new LocalShotTextRequestError('本地镜头文字请求超时，结果仍待确认。中断连接不会取消保存或原文字保存请求。', 'LOCAL_SHOT_TEXT_TIMEOUT_UNKNOWN'));
        controller.abort();
      }, deadline); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function perform(method: 'GET' | 'PUT' | 'DELETE' | 'POST', path: string, input: unknown, signal: AbortSignal, limit: number, expiresAt: number): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(`/api/local-shot-text${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal, ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) }); }
    catch { throw new LocalShotTextRequestError('本地镜头文字请求未收到确认。不会自动重试，原请求结果可能仍待确认。', 'LOCAL_SHOT_TEXT_NETWORK_UNKNOWN'); }
    if (signal.aborted || Date.now() >= expiresAt) {
      if (response.body) void response.body.cancel().catch(() => {});
      throw new LocalShotTextRequestError('本地镜头文字请求超时，原请求结果仍待确认。', 'LOCAL_SHOT_TEXT_TIMEOUT_UNKNOWN');
    }
    const body = await boundedJSON(response, signal, limit, expiresAt);
    if (!object(body) || typeof body.ok !== 'boolean' || Object.keys(body).length !== 2) throw localShotTextProtocolError();
    if (!body.ok) {
      const error = body.error;
      if (response.ok || !object(error) || Object.keys(error).length !== 4 || !['code', 'message', 'details', 'retryable'].every(key => Object.hasOwn(error, key)) ||
          typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) || typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
          !object(error.details) || Object.keys(error.details).length !== 0 || error.retryable !== false) throw localShotTextProtocolError();
      // These refusal codes are issued only before this client sends a PUT.
      // A wire response cannot claim that local no-request evidence.
      if (error.code === 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION' || error.code === 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT') throw localShotTextProtocolError();
      throw new LocalShotTextRequestError(error.message, error.code, response.status);
    }
    if (response.status !== 200 || !Object.hasOwn(body, 'data')) throw localShotTextProtocolError();
    return body.data;
  }
  async function envelope(method: 'GET' | 'PUT' | 'DELETE' | 'POST', path: string, input?: unknown): Promise<LocalShotTextEnvelope> {
    const parsed = schemas.envelope.safeParse(await request(method, path, input));
    if (!parsed.success) throw localShotTextProtocolError();
    return parsed.data;
  }
  async function execution(path: '/execute' | '/recover', input: LocalShotTextExecute): Promise<LocalShotTextExecution> {
    const parsed = schemas.execution.safeParse(await request('POST', path, input));
    if (!parsed.success) throw localShotTextProtocolError();
    return parsed.data;
  }
  return {
    get: (projectId, shotId) => envelope('GET', `?${new URLSearchParams({ projectId, shotId })}`),
    put: input => envelope('PUT', '/draft', input), discard: input => envelope('DELETE', '/draft', input),
    prepare: input => envelope('POST', '/prepare', input), execute: input => execution('/execute', input), recover: input => execution('/recover', input),
  };
}
