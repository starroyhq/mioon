import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {isProjectId} from '../../../../packages/contracts/src/project-file.ts';
import {BACKGROUND_TASK_QUERY_LIMITS, backgroundTaskQueryResponseSchema} from '../../../../packages/contracts/src/background-task-query.ts';
import type {createBackgroundCoordinator} from './background-coordinator.ts';

/** Application metadata only: no project acquisition, task payload, provider
 * credentials, source path or result/staging content is returned here. */
export function createBackgroundTaskHttp(coordinator: Pick<ReturnType<typeof createBackgroundCoordinator>, 'listUnavailableProjects'>) {
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (url.pathname !== '/api/background-tasks') return false;
    if (req.method !== 'GET') {res.setHeader('Allow', 'GET'); throw new AppError('METHOD_NOT_ALLOWED', '请使用 GET', 405);}
    const query = url.searchParams, keys = [...query.keys()];
    const after = query.get('after'), rawLimit = query.get('limit');
    if (keys.some(key => !['after', 'limit'].includes(key)) || new Set(keys).size !== keys.length
      || after !== null && !isProjectId(after) || rawLimit !== null
        && (!/^[1-9][0-9]*$/u.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) > BACKGROUND_TASK_QUERY_LIMITS.maxPageSize)
      || req.headers['transfer-encoding'] !== undefined
      || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
      throw new AppError('VALIDATION_ERROR', '后台任务查询参数无效', 400);
    }
    const limit = rawLimit === null ? BACKGROUND_TASK_QUERY_LIMITS.defaultPageSize : Number(rawLimit);
    const pending = coordinator.listUnavailableProjects().filter(item => after === null || item.projectId > after);
    const projects = pending.slice(0, limit);
    const data = backgroundTaskQueryResponseSchema.safeParse({version: 1, projects,
      nextCursor: pending.length > limit ? projects.at(-1)!.projectId : null});
    if (!data.success) throw new AppError('BACKGROUND_TASK_QUERY_UNAVAILABLE', '后台任务摘要暂时不可用', 503);
    const payload = JSON.stringify({ok: true, data: data.data});
    if (Buffer.byteLength(payload) > BACKGROUND_TASK_QUERY_LIMITS.responseBytes) throw new AppError('BACKGROUND_TASK_QUERY_LIMIT', '后台任务摘要超过上限', 413);
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(payload); return true;
  };
}
