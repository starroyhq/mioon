import {safeChatRuntimeError} from '@mioon/business/agent/chat-runtime';
import {agentChatError} from '@mioon/business/agent/chat-errors';

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
};
function query(url, allowed) {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw agentChatError('AGENT_CHAT_VALIDATION');
}
async function approvalBody(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) throw agentChatError('AGENT_CHAT_VALIDATION');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) throw agentChatError('AGENT_CHAT_LIMIT');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw agentChatError('AGENT_CHAT_VALIDATION'); }
}

/** User review endpoints only. The parent server authenticates every request
 * and checks Host/Origin before this module runs. No endpoint is a model tool;
 * GET never approves, dispatches, retries or acquires a provider credential. */
export function createAgentEditHttp({runtime}) {
  return async function handle(req, res, url) {
    if (!/^\/api\/agent\/chat\/[^/]+\/edits(?:\/|$)/u.test(url.pathname)) return false;
    try {
      const match = /^\/api\/agent\/chat\/([^/]+)\/edits(?:\/([^/]+)(?:\/(approve|reject|recover))?)?$/u.exec(url.pathname);
      if (!match) throw agentChatError('AGENT_CHAT_NOT_FOUND');
      let projectId, proposalId;
      try { projectId = decodeURIComponent(match[1]); proposalId = match[2] ? decodeURIComponent(match[2]) : undefined; }
      catch { throw agentChatError('AGENT_CHAT_VALIDATION'); }
      if (!uuid(projectId) || proposalId !== undefined && !uuid(proposalId)) throw agentChatError('AGENT_CHAT_VALIDATION');
      const action = match[3], method = action ? 'POST' : 'GET';
      if (req.method !== method) {
        res.setHeader('Allow', method);
        json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: `请使用 ${method}`, details: {}, retryable: false}});
        return true;
      }
      let result;
      if (!proposalId) {
        query(url, ['limit', 'cursor', 'view']);
        const rawLimit = url.searchParams.get('limit'), cursor = url.searchParams.get('cursor'), view = url.searchParams.get('view');
        if (rawLimit !== null && (!/^[1-9][0-9]?$/u.test(rawLimit) || Number(rawLimit) > 50) ||
          cursor !== null && (!cursor || cursor.length > 512) || view !== null && !['unresolved', 'all'].includes(view)) throw agentChatError('AGENT_CHAT_VALIDATION');
        result = await runtime.editList(projectId, {...(rawLimit === null ? {} : {limit: Number(rawLimit)}),
          ...(cursor === null ? {} : {cursor}), ...(view === null ? {} : {view})});
      } else {
        query(url, []);
        if (!action) result = await runtime.editGet(projectId, proposalId);
        else {
          const input = await approvalBody(req);
          if (action === 'approve') result = await runtime.editApprove(projectId, proposalId, input);
          else if (action === 'reject') result = await runtime.editReject(projectId, proposalId, input);
          else result = await runtime.editRecover(projectId, proposalId, input);
        }
      }
      json(res, 200, {ok: true, data: result});
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        const safe = safeChatRuntimeError(error);
        json(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});
      }
    }
    return true;
  };
}
