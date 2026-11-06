import { projectApiPath } from '../../../packages/contracts/src/project-file.ts';
import { MIO_RULES_ERROR_STATUS, projectRulesEnableInputSchema, projectRulesSaveInputSchema, projectRulesSnapshotSchema, projectRulesRequestLookupSchema, rulesRequestIdSchema } from '../../../packages/contracts/src/mio-rules.ts';
import type { ProjectRulesEnableInput, ProjectRulesSaveInput, ProjectRulesSnapshot, ProjectRulesRequestLookup } from '../../../packages/contracts/src/mio-rules.ts';

export class ProjectRulesRequestError extends Error {
  readonly code: string; readonly outcomeUnknown: boolean;
  constructor(code: string, outcomeUnknown = false) { super('The project rules request did not complete.'); this.name = 'ProjectRulesRequestError'; this.code = code; this.outcomeUnknown = outcomeUnknown; }
}
export interface RulesReadOptions { readonly signal?: AbortSignal }
export interface WebProjectRulesClient {
  read(projectId: string, options?: RulesReadOptions): Promise<ProjectRulesSnapshot>;
  save(projectId: string, input: ProjectRulesSaveInput, options?: RulesReadOptions): Promise<ProjectRulesSnapshot>;
  enable(projectId: string, input: ProjectRulesEnableInput, options?: RulesReadOptions): Promise<ProjectRulesSnapshot>;
  lookup(projectId: string, requestId: string, options?: RulesReadOptions): Promise<ProjectRulesRequestLookup>;
  reconcile(projectId: string, requestId: string, options?: RulesReadOptions): Promise<ProjectRulesRequestLookup>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface SafeSchema<T> {safeParse(value: unknown): {success: true; data: T} | {success: false}}
const protocol = (): never => { throw new ProjectRulesRequestError('BACKEND_PROTOCOL_ERROR'); };
const changeListeners = new Map<string, Set<() => void>>();
export function subscribeProjectRulesChanges(projectId: string, listener: () => void): () => void {
  const listeners = changeListeners.get(projectId) ?? new Set(); changeListeners.set(projectId, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) changeListeners.delete(projectId); };
}
function changed(projectId: string): void { for (const listener of changeListeners.get(projectId) ?? []) listener(); }
function parse<T>(schema: SafeSchema<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new ProjectRulesRequestError('MIO_RULES_INVALID'); return result.data;
}
async function json(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') || !response.body) return protocol();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 64 * 1024) return protocol(); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown; } catch { return protocol(); }
}
/** Browser-only, same-origin R2 transport. An interrupted write is observed by
 * its original identity; this layer never retries or reconciles it. */
export function createWebProjectRulesClient({fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), timeoutMs = 30_000}: {readonly fetcher?: typeof fetch; readonly timeoutMs?: number} = {}): WebProjectRulesClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new ProjectRulesRequestError('MIO_RULES_INVALID');
  const route = (projectId: string): string => { try { return projectApiPath(projectId, 'rules'); } catch { throw new ProjectRulesRequestError('MIO_RULES_INVALID'); } };
  const requestRoute = (projectId: string, requestId: string): string => `${route(projectId)}/requests/${encodeURIComponent(parse(rulesRequestIdSchema, requestId))}`;
  async function request<T extends {projectId: string}>(url: string, projectId: string, schema: SafeSchema<T>, method: 'GET' | 'PUT' | 'POST', input: unknown, options: RulesReadOptions, write = false, requestId?: string): Promise<T> {
    if (options.signal?.aborted) throw new ProjectRulesRequestError('INTERRUPTED');
    const timer = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
    let dispatched = false;
    try {
      dispatched = true;
      const response = await fetcher(url, {method, credentials: 'same-origin', redirect: 'error', signal, ...(input === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(input)})});
      const value = await json(response);
      if (!object(value) || typeof value.ok !== 'boolean' || value.ok !== response.ok) return protocol();
      if (!value.ok) {
        const code = object(value.error) ? value.error.code : undefined;
        if (typeof code !== 'string' || !(Object.hasOwn(MIO_RULES_ERROR_STATUS, code) || ['UNAUTHORIZED', 'ORIGIN_REJECTED', 'METHOD_NOT_ALLOWED', 'PROJECT_NOT_FOUND', 'NOT_FOUND', 'PROJECT_FILE_COPY', 'PROJECT_FILE_MOVED', 'PROJECT_IN_USE', 'PROJECT_UNAVAILABLE', 'PROJECT_READONLY'].includes(code))) return protocol();
        throw new ProjectRulesRequestError(code, write && (response.status >= 500 || code === 'MIO_RULES_WRITE_UNCERTAIN'));
      }
      if (Object.keys(value).some(key => key !== 'ok' && key !== 'data')) return protocol();
      const parsed = schema.safeParse(value.data);
      if (!parsed.success || parsed.data.projectId !== projectId || requestId !== undefined && (!('requestId' in parsed.data) || parsed.data.requestId !== requestId)) return protocol();
      return parsed.data;
    } catch (error) {
      if (error instanceof ProjectRulesRequestError && error.code !== 'BACKEND_PROTOCOL_ERROR') throw error;
      throw new ProjectRulesRequestError(options.signal?.aborted ? 'INTERRUPTED' : timer.aborted ? 'TIMEOUT' : error instanceof ProjectRulesRequestError ? error.code : 'BACKEND_UNAVAILABLE', write && dispatched);
    }
  }
  return {
    read: (id, options = {}) => request(route(id), id, projectRulesSnapshotSchema, 'GET', undefined, options),
    async save(id, input, options = {}) { const result = await request(route(id), id, projectRulesSnapshotSchema, 'PUT', parse(projectRulesSaveInputSchema, input), options, true); changed(id); return result; },
    async enable(id, input, options = {}) { const result = await request(route(id) + '/enable', id, projectRulesSnapshotSchema, 'POST', parse(projectRulesEnableInputSchema, input), options, true); changed(id); return result; },
    lookup: (id, requestId, options = {}) => request(requestRoute(id, requestId), id, projectRulesRequestLookupSchema, 'GET', undefined, options, false, requestId),
    async reconcile(id, requestId, options = {}) { const result = await request(requestRoute(id, requestId) + '/reconcile', id, projectRulesRequestLookupSchema, 'POST', {}, options, true, requestId); changed(id); return result; },
  };
}
