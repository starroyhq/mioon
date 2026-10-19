import {safeChatRuntimeError, chatRuntimeError} from '@mioon/business/agent/chat-runtime';
import {agentChatError} from '@mioon/business/agent/chat-errors';
import {createAgentEditHttp} from './agent-edit-http.ts';
import {createChatSse, CHAT_SSE_LIMITS} from './chat-sse.ts';

const MAX_BODY_BYTES = 16 * 1024;
const json = (res, status, data) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw agentChatError('AGENT_CHAT_VALIDATION');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw agentChatError('AGENT_CHAT_LIMIT');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw agentChatError('AGENT_CHAT_VALIDATION'); }
}
function query(url, allowed) {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw agentChatError('AGENT_CHAT_VALIDATION');
}
/** Dedicated authenticated route family. Authentication/host/origin are checked
 * by startServer before calling this handler, never bypassed for SSE. */
export function createChatHttp({runtime, sseOptions}) {
  const clients = new Set();
  // Constructor-only synthetic QA overrides; no request or environment input.
  const maxClients = sseOptions?.clients ?? CHAT_SSE_LIMITS.clients;
  if (!Number.isSafeInteger(maxClients) || maxClients <= 0) throw new TypeError('Invalid SSE client limit');
  const editHttp = createAgentEditHttp({runtime});
  return {
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/api/agent/chat/')) return false;
      if (await editHttp(req, res, url)) return true;
      try {
        const match = /^\/api\/agent\/chat\/([^/]+)(?:\/(runs|requests|history)(?:\/([^/]+)(?:\/(events|stop))?)?)?$/.exec(url.pathname);
        if (!match || match[2] === 'requests' && (!match[3] || match[4]) || match[2] === 'history' && match[3]) { json(res, 404, {ok: false, error: {code: 'AGENT_CHAT_NOT_FOUND', message: '接口不存在。', details: {}, retryable: false}}); return true; }
        let projectId, runId;
        try { projectId = decodeURIComponent(match[1]); runId = match[3] ? decodeURIComponent(match[3]) : null; }
        catch { throw agentChatError('AGENT_CHAT_VALIDATION'); }
        if (/[\u0000-\u001f/\\]/u.test(projectId) || (runId && !/^[0-9a-f-]{36}$/u.test(runId))) throw agentChatError('AGENT_CHAT_VALIDATION');
        const action = match[4], method = !match[2] || ['requests', 'history'].includes(match[2]) || runId && action !== 'stop' ? 'GET' : 'POST';
        if (req.method !== method) {
          res.setHeader('Allow', method);
          json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: `请使用 ${method}`, details: {}, retryable: false}}); return true;
        }
        if (!match[2]) { query(url, []); json(res, 200, {ok: true, data: await runtime.snapshot(projectId)}); }
        else if (match[2] === 'requests') {
          // Lost acknowledgements are resolved by a read, including after an
          // epoch change. This endpoint never resumes or re-sends inference.
          query(url, []); json(res, 200, {ok: true, data: runtime.lookup(projectId, runId)});
        }
        else if (match[2] === 'history') {
          query(url, ['before']); json(res, 200, {ok: true, data: runtime.history(projectId, {before: url.searchParams.get('before')})});
        }
        else if (!runId) { query(url, []); json(res, 200, {ok: true, data: await runtime.send(projectId, await readBody(req))}); }
        else if (action === 'stop') { query(url, []); json(res, 200, {ok: true, data: runtime.stop(projectId, runId, await readBody(req))}); }
        else if (!action) { query(url, ['instanceId']); json(res, 200, {ok: true, data: runtime.get(projectId, runId, url.searchParams.get('instanceId'))}); }
        else {
          query(url, ['instanceId', 'after']);
          const cursor = url.searchParams.get('after') ?? '0';
          if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw agentChatError('AGENT_CHAT_VALIDATION');
          if (clients.size >= maxClients) throw chatRuntimeError('AGENT_CHAT_BUSY');
          let stream;
          stream = createChatSse({res, options: sseOptions, onSettled: () => clients.delete(stream)});
          clients.add(stream);
          try {
            stream.attach(runtime.subscribe(projectId, runId, url.searchParams.get('instanceId'), Number(cursor), stream.event, stream.end));
            stream.start();
          } catch (error) { stream.reject(); throw error; }
        }
      } catch (error) {
        if (res.headersSent) res.destroy();
        else { const safe = safeChatRuntimeError(error); json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}}); }
      }
      return true;
    },
    close() { for (const stream of [...clients]) stream.close(); },
  };
}
