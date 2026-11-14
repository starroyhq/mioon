import type {IncomingMessage, ServerResponse} from 'node:http';
import {agentSettingsError, safeAgentSettingsError} from '@mioon/business/agent/config';
import type {SettingsContextOptions} from '@mioon/business/agent/settings';
import {
  AGENT_MODEL_LIST_LIMITS, agentModelListRequestSchema, agentModelListResultSchema,
  agentModelListCacheRequestSchema, agentModelListCacheResultSchema,
  agentDraftConnectionTestRequestSchema, agentDraftConnectionTestResultSchema,
} from '../../../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListRequest, AgentModelListCacheRequest, AgentDraftConnectionTestRequest} from '../../../packages/contracts/src/agent-model-list.ts';

interface ModelLists {
  list(input: AgentModelListRequest, options?: SettingsContextOptions): Promise<unknown>;
  cache(input: AgentModelListCacheRequest, options?: SettingsContextOptions): Promise<unknown>;
  test(input: AgentDraftConnectionTestRequest, options?: SettingsContextOptions): Promise<unknown>;
}
const listRoute = '/api/agent/models/list', cacheRoute = '/api/agent/models/cache', testRoute = '/api/agent/models/test';
function validation(): never {throw agentSettingsError('AGENT_SETTINGS_VALIDATION');}
function send(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > AGENT_MODEL_LIST_LIMITS.resultBytes) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(serialized);
}
async function readInput(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') validation();
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)))) validation();
  const oversized = (): never => {
    res.setHeader('Connection', 'close'); req.resume();
    throw Object.assign(agentSettingsError('AGENT_SETTINGS_VALIDATION'), {status: 413});
  };
  if (length !== undefined && Number(length) > AGENT_MODEL_LIST_LIMITS.requestBytes) oversized();
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of req.iterator({destroyOnReturn: false})) {
    signal.throwIfAborted(); const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string);
    bytes += chunk.byteLength; if (bytes > AGENT_MODEL_LIST_LIMITS.requestBytes) oversized(); chunks.push(chunk);
  }
  signal.throwIfAborted();
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;}
  catch {return validation();}
}

/** Application auth/Host/Origin checks precede this dispatcher. Discovery is
 * isolated from project RPC, diagnostics and the bounded credential broker. */
export function createAgentModelListHttp({models, signal, selfPort}: {models: ModelLists; signal: AbortSignal; selfPort: () => number | undefined}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== listRoute && url.pathname !== cacheRoute && url.pathname !== testRoute) return false;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      send(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 POST。', details: {}, retryable: false}});
      return true;
    }
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    const disconnected = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, AGENT_MODEL_LIST_LIMITS.totalTimeoutMs);
    // The original request deadline includes a slow body, not only the remote
    // provider phase. Destroy an unfinished upload to settle its iterator.
    const stopUpload = () => {if (!req.complete) req.destroy();};
    active.addEventListener('abort', stopUpload, {once: true});
    req.once('aborted', disconnected); res.once('close', disconnected);
    try {
      active.throwIfAborted();
      if (url.search || url.hash) validation();
      const input = await readInput(req, res, active);
      const context = {signal: active, selfPort: selfPort(), isActive: () => !active.aborted && !res.destroyed};
      let data: unknown;
      if (url.pathname === listRoute) {
        const parsed = agentModelListRequestSchema.safeParse(input); if (!parsed.success) validation();
        const result = agentModelListResultSchema.safeParse(await models.list(parsed.data, context));
        if (!result.success) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        data = result.data;
        // Do not trust a remote/provider or injected adapter to reflect a key
        // into an otherwise structurally valid public result.
        if (parsed.data.credential.source === 'input' && result.data.outcome === 'success') {
          const key = parsed.data.credential.value;
          if (result.data.models.some(model => model.id.includes(key) || model.displayName?.includes(key))) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        }
      } else if (url.pathname === testRoute) {
        const parsed = agentDraftConnectionTestRequestSchema.safeParse(input); if (!parsed.success) validation();
        const result = agentDraftConnectionTestResultSchema.safeParse(await models.test(parsed.data, context));
        if (!result.success) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        data = result.data;
      } else {
        const parsed = agentModelListCacheRequestSchema.safeParse(input); if (!parsed.success) validation();
        const result = agentModelListCacheResultSchema.safeParse(await models.cache(parsed.data, context));
        if (!result.success) throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED');
        data = result.data;
      }
      active.throwIfAborted(); send(res, 200, {ok: true, data});
    } catch (error) {
      if (timedOut && req.complete && !signal.aborted && url.pathname !== cacheRoute) {
        send(res, 200, {ok: true, data: {outcome: url.pathname === listRoute ? 'unreachable' : 'failed', reason: 'timeout'}});
        return true;
      }
      const safe = safeAgentSettingsError(error);
      const status = safe.code === 'AGENT_SETTINGS_VALIDATION' && error !== null && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : safe.status;
      send(res, status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
    } finally {
      clearTimeout(timer); active.removeEventListener('abort', stopUpload);
      req.off('aborted', disconnected); res.off('close', disconnected);
    }
    return true;
  };
}
