import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AppLibrary} from '@mioon/business/app-db/index';
import {createApplicationPolicy} from '@mioon/business/agent/application-policy-v2';
import {agentTaskFailure} from '@mioon/business/agent/task-runtime-v2';
import {agentDiagnosticSummarySchema} from '../../../packages/contracts/src/agent-diagnostic-summary.ts';
import {body, json} from './http-json.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createApplicationAgentHttp(library: AppLibrary, signal: AbortSignal) {
  const policy = createApplicationPolicy(library.agentPolicy), prefix = '/api/agent/tasks/v2';
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (path !== prefix + '/policy' && !path.startsWith(prefix + '/policy/requests/') && path !== prefix + '/diagnostics/latest') return false;
    signal.throwIfAborted();
    if (url.search) throw agentTaskFailure('AGENT_TASK_INVALID');
    if (path === prefix + '/diagnostics/latest') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET。'}}); return true; }
      const raw = library.documents.read('agent-diagnostic-summary-v1.json');
      json(res, 200, {ok: true, data: {test: raw === null ? null : agentDiagnosticSummarySchema.parse(JSON.parse(raw))}});
      return true;
    }
    if (path.startsWith(prefix + '/policy/requests/') && req.method === 'GET') {
      let id: string;
      try { id = decodeURIComponent(path.slice((prefix + '/policy/requests/').length)); } catch { throw agentTaskFailure('AGENT_TASK_INVALID'); }
      const saved = policy.lookupPolicy(id);
      json(res, 200, {ok: true, data: {found: saved !== null, ...(saved ? {policy: saved} : {}), readOnly: false}});
      return true;
    }
    if (path === prefix + '/policy') {
      if (req.method === 'GET') { json(res, 200, {ok: true, data: {policy: policy.policy(), readOnly: false}}); return true; }
      if (req.method === 'PUT') {
        if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '')) throw agentTaskFailure('AGENT_TASK_INVALID');
        const input = await body(req, 128 * 1024);
        signal.throwIfAborted();
        if (!object(input) || Object.keys(input).some(key => !['requestId', 'expectedRevision', 'revision', 'stepLimit', 'modes', 'acknowledgePaid'].includes(key)) || typeof input.requestId !== 'string' || input.requestId.length < 8 || !object(input.modes)) throw agentTaskFailure('AGENT_TASK_INVALID');
        const old = policy.policy();
        if (old.modes.paid !== 'direct' && input.modes.paid === 'direct' && input.acknowledgePaid !== true) throw agentTaskFailure('AGENT_TASK_APPROVAL_REQUIRED');
        const result = policy.updatePolicy({revision: input.expectedRevision ?? input.revision, stepLimit: input.stepLimit, modes: input.modes} as Parameters<typeof policy.updatePolicy>[0], input.requestId);
        json(res, 200, {ok: true, data: {policy: result, readOnly: false}});
        return true;
      }
      res.setHeader('Allow', 'GET, PUT');
      json(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: '请使用 GET 或 PUT。'}});
      return true;
    }
    return false;
  };
}
