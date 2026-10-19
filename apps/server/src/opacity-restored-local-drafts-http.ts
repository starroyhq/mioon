/** Explicit current-origin43 draft routes. Authentication/Host/Origin checks
 * remain in the shared server before this bounded UI-only handler. */
import type {IncomingMessage, ServerResponse} from 'node:http';
import {LOCAL_DRAFT_LIMITS} from '../../../packages/contracts/src/local-drafts.ts';
import {LocalDraftError, safeLocalDraftError} from '../../../packages/business/src/local-drafts.ts';
import type {LocalDraftHttpService} from './local-drafts-http.ts';
import {sendLocalDraftHttpResponse as send, readLocalDraftHttpQuery as query, readLocalDraftHttpBody as body} from './local-drafts-http.ts';

export function createOpacityRestoredLocalDraftHttp({drafts, signal}: {drafts: LocalDraftHttpService; signal?: AbortSignal}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!/^\/api\/local-drafts\/restored43(?:\/|$)/u.test(url.pathname)) return false;
    try {
      if (Buffer.byteLength(req.url || '') > LOCAL_DRAFT_LIMITS.urlBytes) throw new LocalDraftError('LOCAL_DRAFT_LIMIT');
      const clip = url.pathname === '/api/local-drafts/restored43/clip';
      if (!clip && url.pathname !== '/api/local-drafts/restored43') throw new LocalDraftError('LOCAL_DRAFT_NOT_FOUND');
      const methods = clip ? ['GET', 'PUT', 'DELETE'] : ['GET'];
      if (!methods.includes(req.method || '')) {
        res.setHeader('Allow', methods.join(', '));
        send(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '此接口不支持该请求方法。', details: {}, retryable: false}}); return true;
      }
      if (signal?.aborted) throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
      let result: unknown;
      if (req.method === 'GET') {
        const values = query(url, [...(clip ? ['projectId', 'timelineId', 'clipId'] : ['projectId']), 'schemaVersion', 'expectedWorkspaceOrigin']);
        if (values.schemaVersion !== '1') throw new LocalDraftError('LOCAL_DRAFT_VALIDATION');
        const input = {...values, schemaVersion: 1};
        result = clip ? drafts.get(input) : drafts.list(input);
      } else {
        query(url, []); const input = await body(req, res);
        if (signal?.aborted) throw new LocalDraftError('LOCAL_DRAFT_STORAGE_UNAVAILABLE');
        result = req.method === 'PUT' ? drafts.put(input) : drafts.discard(input);
      }
      send(res, 200, {ok: true, data: result});
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {const safe = safeLocalDraftError(error); send(res, safe.status, {ok: false, error: {code: safe.code, message: safe.message, details: {}, retryable: false}});}
    }
    return true;
  };
}
