import { LAST_PROJECT_LIMITS, lastProjectEnvelopeSchema, lastProjectPutSchema } from '@mioon/contracts/last-project';
import type { LastProjectEnvelope, LastProjectPut } from '@mioon/contracts/last-project';

export type LastProjectSupported = Extract<LastProjectEnvelope, { supported: true }>;
export type LastProjectFailureKind = 'refused' | 'conflict' | 'unknown' | 'unavailable';
export interface LastProjectFailure { code: string; status: number | null; kind: LastProjectFailureKind }
export interface LastProjectClient {
  get(): Promise<LastProjectEnvelope>;
  put(input: LastProjectPut): Promise<LastProjectSupported>;
}
const refusals: Readonly<Record<string, number>> = Object.freeze({ LAST_PROJECT_VALIDATION: 400, LAST_PROJECT_OWNER_REQUIRED: 403, LAST_PROJECT_NOT_FOUND: 404, LAST_PROJECT_LIMIT: 413 });
const conflicts: Readonly<Record<string, number>> = Object.freeze({ LAST_PROJECT_CONFLICT: 409, LAST_PROJECT_STALE_INSTANCE: 409, LAST_PROJECT_SCOPE_MISMATCH: 409 });
export class LastProjectRequestError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly kind: LastProjectFailureKind;
  constructor(code = 'LAST_PROJECT_RESPONSE_UNKNOWN', status: number | null = null) {
    super('最近项目位置尚未得到有效确认。');
    this.name = 'LastProjectRequestError';
    this.code = /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'LAST_PROJECT_RESPONSE_UNKNOWN';
    this.status = Number.isInteger(status) && status !== null && status >= 100 && status <= 599 ? status : null;
    this.kind = refusals[this.code] === this.status ? 'refused' : conflicts[this.code] === this.status ? 'conflict'
      : this.code === 'LAST_PROJECT_STORAGE_UNAVAILABLE' && this.status === 503 ? 'unavailable' : 'unknown';
  }
}
export function lastProjectFailure(error: unknown): LastProjectFailure {
  return error instanceof LastProjectRequestError ? { code: error.code, status: error.status, kind: error.kind }
    : { code: 'LAST_PROJECT_RESPONSE_UNKNOWN', status: null, kind: 'unknown' };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new LastProjectRequestError('LAST_PROJECT_PROTOCOL_UNKNOWN', response.status);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > LAST_PROJECT_LIMITS.fileBytes) { await reader.cancel(); throw new Error('Response exceeds limit'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new LastProjectRequestError('LAST_PROJECT_PROTOCOL_UNKNOWN', response.status); }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
export function createLastProjectClient(fetcher: typeof fetch = (...args) => fetch(...args), { timeoutMs = 5000 }: { timeoutMs?: number } = {}): LastProjectClient {
  async function request(method: 'GET' | 'PUT', input?: LastProjectPut): Promise<LastProjectEnvelope> {
    const controller = new AbortController();
    const deadline = Number.isFinite(timeoutMs) ? Math.min(10000, Math.max(1, timeoutMs)) : 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = perform(method, input, controller.signal);
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new LastProjectRequestError('LAST_PROJECT_TIMEOUT_UNKNOWN'));
      }, deadline); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function perform(method: 'GET' | 'PUT', input: LastProjectPut | undefined, signal: AbortSignal): Promise<LastProjectEnvelope> {
    let response: Response;
    try {
      response = await fetcher('/api/last-project', { method, credentials: 'same-origin', cache: 'no-store', signal,
        ...(method === 'PUT' ? { keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    } catch { throw new LastProjectRequestError('LAST_PROJECT_NETWORK_UNKNOWN'); }
    if (signal.aborted) {
      if (response.body) void response.body.cancel().catch(() => {});
      throw new LastProjectRequestError('LAST_PROJECT_TIMEOUT_UNKNOWN');
    }
    const protocol = () => new LastProjectRequestError('LAST_PROJECT_PROTOCOL_UNKNOWN', response.status);
    const body = await boundedJSON(response, signal);
    if (!object(body) || Object.keys(body).length !== 2 || typeof body.ok !== 'boolean') throw protocol();
    if (!body.ok) {
      const error = body.error;
      if (response.ok || !Object.hasOwn(body, 'error') || !object(error) || Object.keys(error).length !== 4 ||
          !['code', 'message', 'details', 'retryable'].every(key => Object.hasOwn(error, key)) ||
          typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ||
          typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 1000 ||
          !object(error.details) || Object.keys(error.details).length !== 0 || error.retryable !== false) throw protocol();
      throw new LastProjectRequestError(error.code, response.status);
    }
    if (response.status !== 200 || !Object.hasOwn(body, 'data')) throw protocol();
    const parsed = lastProjectEnvelopeSchema.safeParse(body.data);
    if (!parsed.success) throw protocol();
    return parsed.data;
  }
  return {
    get: () => request('GET'),
    async put(input) {
      const parsed = lastProjectPutSchema.safeParse(input);
      if (!parsed.success) throw new LastProjectRequestError('LAST_PROJECT_VALIDATION', 400);
      const result = await request('PUT', parsed.data);
      if (!result.supported) throw new LastProjectRequestError('LAST_PROJECT_WRITE_UNSUPPORTED');
      return result;
    },
  };
}
