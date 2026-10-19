/** Narrow private browser boundary for the project entry and read-only settings.
 * Callers must validate each operation's result from unknown. */
export type BrowserOperation = 'project.summary.list' | 'project.rename' | 'project.delete' | 'provider.list';
export class BrowserRpcError extends Error {
  readonly code: string;
  readonly definitive: boolean;
  constructor(code = 'BACKEND_PROTOCOL_ERROR', definitive = false) { super('The local operation could not be confirmed.'); this.name = 'BrowserRpcError'; this.code = code; this.definitive = definitive; }
}
const LIMIT = 48 * 1024 * 1024;
async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new BrowserRpcError();
  const decoder = new TextDecoder('utf-8', {fatal:true}); let bytes = 0, content = '';
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > LIMIT) throw new BrowserRpcError(); content += decoder.decode(next.value, {stream:true}); } content += decoder.decode(); return JSON.parse(content) as unknown; }
  catch (error) { await reader.cancel().catch(() => {}); throw error instanceof BrowserRpcError ? error : new BrowserRpcError(); }
  finally { reader.releaseLock(); }
}
export async function browserRpc(operation: BrowserOperation, input: Readonly<Record<string, unknown>> = {}, options: {signal?: AbortSignal; fetcher?: typeof fetch} = {}): Promise<unknown> {
  if (!['project.summary.list','project.rename','project.delete','provider.list'].includes(operation)) throw new BrowserRpcError('INVALID_OPERATION', true);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000), cancel = () => abort.abort();
  options.signal?.addEventListener('abort', cancel, {once:true}); if (options.signal?.aborted) abort.abort();
  try {
    const response = await (options.fetcher ?? fetch)('/api/rpc', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({operation,input}), signal:abort.signal});
    const value = await readBody(response);
    if (!value || typeof value !== 'object' || !('ok' in value)) throw new BrowserRpcError();
    if (response.status === 200 && value.ok === true && 'data' in value && Object.keys(value).every(key => key === 'ok' || key === 'data')) return value.data;
    if (value.ok === false && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error && typeof value.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code)) {
      const code = response.status === 401 ? 'UNAUTHORIZED' : value.error.code;
      const restricted = code.startsWith('RESTORE_') || code === 'RESTORED_RECORD_HELD';
      throw new BrowserRpcError(code, !restricted && response.status >= 400 && response.status < 500);
    }
    throw new BrowserRpcError();
  } catch (error) { throw error instanceof BrowserRpcError ? error : new BrowserRpcError('NETWORK'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort',cancel); }
}
