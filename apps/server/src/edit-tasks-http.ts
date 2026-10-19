import type {IncomingMessage, ServerResponse} from 'node:http';
import {editTaskError, safeEditTaskError} from '@mioon/business/edit-tasks';
import type {createEditTasks} from '@mioon/business/edit-tasks';

// The operation input is independently capped at 8 KiB by the business layer.
// This small additional allowance covers the fixed prepare envelope only.
export const EDIT_TASK_HTTP_LIMITS = Object.freeze({prepareBytes: 12 * 1024, actionBytes: 1024, urlBytes: 2048});
type EditTasks = ReturnType<typeof createEditTasks>;
export interface EditTasksHttpOptions {tasks: EditTasks; signal?: AbortSignal}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const json = (res: ServerResponse, status: number, value: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
};
const validation = () => editTaskError('EDIT_TASK_VALIDATION');

function query(url: URL, allowed: readonly string[]): void {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw validation();
}

async function readBody(req: IncomingMessage, res: ServerResponse, maximum: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '') ||
    req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw validation();
  const tooLarge = () => {
    // Do not accumulate an over-limit stream or leave its keep-alive socket
    // available for another request. The JSON refusal can still reach the peer.
    res.setHeader('Connection', 'close');
    req.resume();
    return editTaskError('EDIT_TASK_LIMIT');
  };
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || !Number.isSafeInteger(Number(length)))) throw validation();
  if (length !== undefined && Number(length) > maximum) throw tooLarge();
  let bytes = 0;
  const chunks: Buffer[] = [];
  // An early return from the default async iterator destroys IncomingMessage,
  // preventing a deterministic 413. Preserve it solely to finish the refusal.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    bytes += chunk.length;
    if (bytes > maximum) throw tooLarge();
    chunks.push(chunk);
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
  catch { throw validation(); }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw validation();
  return input as Record<string, unknown>;
}

/** Small UI-only route family. startServer performs its existing Host, Origin
 * and token/cookie checks before this handler. No RPC/model-tool registration,
 * polling, automatic dispatch or request-disconnect cancellation occurs here. */
export function createEditTasksHttp({tasks, signal}: EditTasksHttpOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!/^\/api\/tasks(?:\/|$)/u.test(url.pathname)) return false;
    try {
      if (Buffer.byteLength(req.url ?? '', 'utf8') > EDIT_TASK_HTTP_LIMITS.urlBytes) throw editTaskError('EDIT_TASK_LIMIT');
      const match = /^\/api\/tasks(?:\/(prepare|[^/]+)(?:\/(execute|reconcile|acknowledge))?)?$/u.exec(url.pathname);
      if (!match || match[1] === 'prepare' && match[2]) throw editTaskError('EDIT_TASK_NOT_FOUND');
      const preparing = match[1] === 'prepare', action = match[2], method = preparing || action ? 'POST' : 'GET';
      if (req.method !== method) {
        res.setHeader('Allow', method);
        json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: `请使用 ${method}`, details: {}, retryable: false}});
        return true;
      }
      let taskId: string | undefined;
      if (match[1] && !preparing) {
        try { taskId = decodeURIComponent(match[1]); } catch { throw validation(); }
        if (!uuid(taskId)) throw validation();
      }
      let result;
      if (method === 'GET') {
        query(url, taskId ? ['projectId'] : ['projectId', 'pendingOnly', 'limit', 'cursor']);
        const projectId = url.searchParams.get('projectId');
        if (!uuid(projectId)) throw validation();
        if (taskId) result = await tasks.get({projectId, taskId});
        else {
          const limit = url.searchParams.get('limit'), pendingOnly = url.searchParams.get('pendingOnly'), cursor = url.searchParams.get('cursor');
          if (limit !== null && (!/^[1-9][0-9]?$/u.test(limit) || Number(limit) > 50) ||
            pendingOnly !== null && !['true', 'false'].includes(pendingOnly) ||
            cursor !== null && (!cursor || cursor.length > 512)) throw validation();
          result = await tasks.list({projectId, ...(limit === null ? {} : {limit: Number(limit)}),
            ...(pendingOnly === null ? {} : {pendingOnly: pendingOnly === 'true'}), ...(cursor === null ? {} : {cursor})});
        }
      } else {
        query(url, []);
        const envelope = await readBody(req, res, preparing ? EDIT_TASK_HTTP_LIMITS.prepareBytes : EDIT_TASK_HTTP_LIMITS.actionBytes);
        const {expectedWorkspaceOrigin, ...input} = envelope;
        const context = Object.hasOwn(envelope, 'expectedWorkspaceOrigin') ? {expectedWorkspaceOrigin} : {};
        // The backend checks every fixed action's complete closed schema. Never
        // overwrite a supplied taskId and thereby hide a conflicting field.
        if (Object.hasOwn(input, 'taskId')) throw validation();
        if (signal?.aborted) throw editTaskError('EDIT_TASK_STORAGE_UNAVAILABLE');
        if (preparing) result = await tasks.prepare(input, context);
        else if (action === 'execute') result = await tasks.execute({...input, taskId}, context);
        else if (action === 'reconcile') result = await tasks.reconcile({...input, taskId}, context);
        else result = await tasks.acknowledge({...input, taskId}, context);
      }
      json(res, 200, {ok: true, data: result});
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (res.headersSent) res.destroy();
      else {
        const safe = safeEditTaskError(error);
        json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
      }
    }
    return true;
  };
}
