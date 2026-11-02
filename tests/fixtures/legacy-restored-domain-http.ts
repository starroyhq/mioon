/** Explicit test-only transport adapter for verified historical restore domains.
 * Production startServer never imports or enables this fixture. It constructs
 * no application runtime, providers, workers, Agent, settings or network ports. */
import {timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {AppError} from '../../packages/contracts/src/app-error.ts';
import {isAppLevelOperation} from '../../packages/contracts/src/project-addressing.ts';
import {isProjectId, parseProjectApiPath} from '../../packages/contracts/src/project-file.ts';
import {getWorkspaceRestoreContext, openLegacyWorkspaceStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import {workspaceRestoreError} from '../../packages/business/src/workspace-restore-policy.ts';
import {createEditTasksHttp} from '../../apps/server/src/edit-tasks-http.ts';
import {assertProjectRpc, projectHandlerTarget} from '../../apps/server/src/project-host/request.ts';
import {callObservedRpc} from '../../apps/server/src/rpc-observation.ts';

const RPC_OPERATIONS = new Set([
  'timeline.colour.image.inspect', 'timeline.track.add', 'timeline.get', 'shot.create', 'job.retry', 'project.create', 'project.rename', 'project.delete',
  'export.cancel', 'export.activity.get', 'export.output.get',
  'workspace.restore.inspect', 'workspace.backup.inspect', 'workspace.settings.get', 'workspace.settings.set',
  'workspace.backup.status', 'workspace.backup.list', 'workspace.backup.create', 'workspace.backup.restore.stage',
  'task.disposition.list', 'task.disposition.markFailed', 'task.disposition.archiveCompleted',
  'agent.authorization.list', 'agent.authorization.grant', 'agent.authorization.revoke',
]);
const DENIED_PATHS = new Set([
  '/api/agent/settings', '/api/images/settings', '/api/images/custom-settings', '/api/images/comfy-settings', '/api/images/comfy-check',
]);
const json = (res: ServerResponse, status: number, value: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
};
const equal = (value: string | undefined, token: string): boolean => {
  if (value === undefined) return false;
  const a = Buffer.from(value), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new AppError('VALIDATION_ERROR', 'Expected a JSON fixture request', 400);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new AppError('VALIDATION_ERROR', 'Fixture request is too large', 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
  catch { throw new AppError('VALIDATION_ERROR', 'Invalid JSON fixture request', 400); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 'Expected an object', 400);
  return value as Record<string, unknown>;
}

export async function startLegacyRestoredDomainHttp({root, token, inspectStore}: {readonly root: string; readonly token: string; readonly inspectStore?: (inspect: <T>(read:(db:import('node:sqlite').DatabaseSync)=>T)=>T)=>void}): Promise<{readonly url: string; close(): Promise<void>}> {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('A synthetic fixture token is required');
  const store = openLegacyWorkspaceStore(root);
  let services: ReturnType<typeof createServices> | undefined, tasks: ReturnType<typeof createEditTasks> | undefined;
  try {
    if (getWorkspaceRestoreContext(store) === null) throw new TypeError('This fixture only serves verified historical restored domains');
    inspectStore?.(read => read(store.db));
    services = createServices(store, new Map());
    tasks = createEditTasks({store, services});
    const restoredServices = services, restoredTasks = tasks;
    const finiteTasks = {...restoredTasks, prepare: (...args: Parameters<typeof restoredTasks.prepare>) => {
      const value = args[0];
      if (value === null || typeof value !== 'object' || !('operation' in value) || value.operation !== 'timeline.track.add') throw workspaceRestoreError();
      return restoredTasks.prepare(...args);
    }};
    const taskHttp = createEditTasksHttp({tasks: finiteTasks});
    const server = http.createServer((req, res) => { void handle(req, res); });
    let origin = '';
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const authority = new URL(origin);
        if (![authority.host, `localhost:${authority.port}`].includes(req.headers.host ?? '') || req.headers.origin && req.headers.origin !== origin) {
          throw new AppError('ORIGIN_REJECTED', 'Fixture requires its loopback origin', 403);
        }
        if (!equal(req.headers.authorization?.replace(/^Bearer /u, ''), token)) throw new AppError('UNAUTHORIZED', 'Fixture token required', 401);
        const url = new URL(req.url ?? '/', origin), route = parseProjectApiPath(url.pathname);
        const target = route ? projectHandlerTarget(route) : null;
        if (target?.pathname.startsWith('/api/tasks')) {
          if (!store.get('projects', target.projectId)) throw new AppError('NOT_FOUND', 'Project is absent', 404);
          const local = new URL(url); local.pathname = target.pathname;
          if (await taskHttp(req, res, local, {projectId: target.projectId})) return;
        }
        const deniedReview = route?.kind === 'other' && route.segments.length === 3 && route.segments[0] === 'images' && route.segments[1] === 'reviews' && ['approve', 'reject'].includes(route.segments[2]!);
        const chat = /^\/api\/agent\/chat\/([^/]+)\/runs$/u.exec(url.pathname);
        if (DENIED_PATHS.has(url.pathname) || deniedReview || chat && isProjectId(chat[1])) {req.resume();throw workspaceRestoreError();}
        if (url.pathname !== '/api/rpc' && route?.kind !== 'rpc') throw new AppError('NOT_FOUND', 'Route is outside the finite restore fixture', 404);
        if (req.method !== 'POST') throw new AppError('VALIDATION_ERROR', 'Fixture RPC requires POST', 405);
        const envelope = await body(req), {operation, input, expectedWorkspaceOrigin} = envelope;
        if (Object.keys(envelope).some(key => !['operation', 'input', 'expectedWorkspaceOrigin'].includes(key)) || typeof operation !== 'string' || !RPC_OPERATIONS.has(operation)) {
          throw new AppError('VALIDATION_ERROR', 'Operation is outside the finite restore fixture', 400);
        }
        if (route?.kind === 'rpc') assertProjectRpc(store.db, {projectId: route.projectId}, operation, input);
        else if (!isAppLevelOperation(operation)) throw new AppError('VALIDATION_ERROR', 'Project RPC needs an explicit project address', 400);
        const context = expectedWorkspaceOrigin === undefined ? {} : {expectedWorkspaceOrigin};
        json(res, 200, {ok: true, data: await callObservedRpc(req, res, restoredServices, operation, input, context)});
      } catch (error) {
        const known = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Historical domain fixture failed', 500);
        json(res, known.status, {ok: false, error: {code: known.code, message: known.message, details: known.details, retryable: false}});
      }
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new TypeError('Fixture needs a loopback TCP listener');
    origin = `http://127.0.0.1:${address.port}`;
    let closing: Promise<void> | undefined;
    return {url: origin, close: () => closing ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try { await restoredTasks.drain(); await restoredServices.drain(); }
      finally { store.close(); }
    })()};
  } catch (error) {
    try { await tasks?.drain(); await services?.drain(); } finally { store.close(); }
    throw error;
  }
}
