import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import type {ProjectApiRoute} from '../../../../packages/contracts/src/project-file.ts';
import {projectHistoryResolveSchema} from '../../../../packages/contracts/src/project-history-recovery.ts';
import {projectVersionSchemas} from '../../../../packages/contracts/src/project-version-operations.ts';
import {body, json} from '../http-json.ts';
import type {ProjectHostRuntime} from './host.ts';
import type {ProjectHostManager} from './manager.ts';

/** Resolve owns no request lease: exclusivity must never wait for the same
 * request that is asking to replace history. Normal requests remain gated. */
export async function handleProjectHistoryHttp<Runtime extends ProjectHostRuntime>(manager: ProjectHostManager<Runtime>, req: IncomingMessage, res: ServerResponse, url: URL, route: ProjectApiRoute): Promise<boolean> {
  if (route.kind !== 'other' || route.segments[0] !== 'history' || route.segments.length !== 2) return false;
  const operation = route.segments[1], projectId = route.projectId;
  if (operation === 'resolve' && req.method === 'POST') {
    const parsed = projectHistoryResolveSchema.safeParse(await body(req, 16 * 1024));
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '本机记录处置参数无效。', 400, {issues: parsed.error.issues});
    if (parsed.data.projectId !== projectId) throw new AppError('PROJECT_ID_MISMATCH', '处置请求与项目地址不一致。', 400);
    const result = await manager.resolveHistory(parsed.data);
    json(res, 200, {ok: true, data: result}); return true;
  }
  if (req.method !== 'GET' || !['status', 'versions', 'preview'].includes(operation)) return false;
  const lease = await manager.acquire(projectId, 'request');
  try {
    const session = lease.host.recovery;
    if (!session) throw new AppError('PROJECT_HISTORY_NOT_DIVERGED', '本项目不需要本机记录处置。', 409);
    lease.signal.throwIfAborted();
    let result: unknown;
    if (operation === 'status') result = session.status();
    else {
      const raw = {projectId, ...(url.searchParams.has('limit') ? {limit: Number(url.searchParams.get('limit'))} : {}),
        ...(url.searchParams.has('cursor') ? {cursor: url.searchParams.get('cursor')} : {}),
        ...(operation === 'preview' ? {versionId: url.searchParams.get('versionId')} : {})};
      if (operation === 'versions') {
        const parsed = projectVersionSchemas['project.version.list'].safeParse(raw);
        if (!parsed.success) throw new AppError('VALIDATION_ERROR', '版本列表参数无效。', 400);
        result = session.listVersions(parsed.data);
      } else {
        const parsed = projectVersionSchemas['project.version.preview'].safeParse(raw);
        if (!parsed.success) throw new AppError('VALIDATION_ERROR', '版本预览参数无效。', 400);
        result = session.previewVersion(parsed.data);
      }
    }
    lease.signal.throwIfAborted(); json(res, 200, {ok: true, data: result});
    return true;
  } finally {lease.release();}
}
