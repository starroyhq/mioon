// Explicit, finite historical-domain transport fixture. No production entry,
// environment flag, project host, providers, worker or Mio runtime enables it.
import {timingSafeEqual, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import http from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {isAsyncFunction, isPromise} from 'node:util/types';
import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../packages/contracts/src/app-error.ts';
import {parseProjectApiPath} from '../../packages/contracts/src/project-file.ts';
import {isAppLevelOperation} from '../../packages/contracts/src/project-addressing.ts';
import {openLegacyWorkspaceStore, getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createProjectPackageService} from '../../packages/business/src/project-package/service.ts';
import {createProjectPackageHttp} from '../../apps/server/src/project-package-http.ts';
import {assertProjectRpc} from '../../apps/server/src/project-host/request.ts';
import {callObservedRpc} from '../../apps/server/src/rpc-observation.ts';

type Domain = 'packages' | 'lifecycle' | 'inspection';
const OPERATIONS: Readonly<Record<Domain, ReadonlySet<string>>> = {
  packages: new Set(['project.get', 'task.disposition.list']),
  lifecycle: new Set(['project.create', 'project.rename', 'project.delete', 'project.summary.list']),
  inspection: new Set(['workspace.backup.inspect']),
};
const send = (res: ServerResponse, status: number, value: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(value));
};
const equal = (a: string | undefined, b: string): boolean => {
  if (a === undefined) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function rpcBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '')) throw new AppError('VALIDATION_ERROR', 'Expected JSON', 400);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new AppError('VALIDATION_ERROR', 'Fixture body is too large', 413);
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
  catch { throw new AppError('VALIDATION_ERROR', 'Invalid JSON', 400); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 'Expected an object', 400);
  return value as Record<string, unknown>;
}

export async function startLegacyProjectHttp({root, token, domain}: {root: string; token: string; domain: Domain}) {
  if (typeof token !== 'string' || token.length < 20 || !Object.hasOwn(OPERATIONS, domain)) throw new TypeError('A finite test domain and synthetic token are required');
  const store = openLegacyWorkspaceStore(root), shutdown = new AbortController();
  let services: ReturnType<typeof createServices> | undefined;
  let packages: ReturnType<typeof createProjectPackageService> | undefined;
  try {
    if (getWorkspaceRestoreContext(store) !== null) throw new TypeError('This fixture only serves ordinary historical workspaces');
    services = createServices(store, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, imageOptions: {autoRun: false}});
    const ownedServices = services;
    if (domain === 'lifecycle') {
      const noDrafts = (): void => {
        for (const file of ['local-drafts-v1.json', 'local-delivery-v1.json', 'local-shot-text-v1.json']) {
          if (existsSync(path.join(root, file))) throw new TypeError('This lifecycle fixture has no draft companions');
        }
      };
      ownedServices.setProjectDeletionCompanions({assertDeletable: noDrafts, removeProject: noDrafts});
    }
    if (domain === 'packages') {
      packages = createProjectPackageService({store, appVersion: '0.4.1', afterCreate: async ({projectId, jobIds}) => {
        for (let index = 0; index < jobIds.length; index += 100) {
          await ownedServices.call('task.disposition.archiveCompleted', {projectId, requestId: randomUUID(), targets: jobIds.slice(index, index + 100).map(taskId => ({kind: 'generation', taskId, expectedRevision: 0, expectedStatus: 'succeeded'}))});
        }
      }});
      packages.clearStale();
    }
    const packageService = packages;
    const packageHttp = packageService ? createProjectPackageHttp({service: () => packageService, available: () => true, signal: shutdown.signal}) : null;
    let origin = '', closing: Promise<void> | undefined;
    const server = http.createServer((req, res) => { void handle(req, res); });
    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        shutdown.signal.throwIfAborted();
        const authority = new URL(origin);
        if (![authority.host, `localhost:${authority.port}`].includes(req.headers.host ?? '') || req.headers.origin && req.headers.origin !== origin) throw new AppError('ORIGIN_REJECTED', 'Fixture requires its loopback origin', 403);
        if (!equal(req.headers.authorization?.replace(/^Bearer /u, ''), token)) throw new AppError('UNAUTHORIZED', 'Fixture token required', 401);
        const url = new URL(req.url ?? '/', origin);
        if (packageHttp && await packageHttp(req, res, url)) return;
        const route = parseProjectApiPath(url.pathname);
        if ((url.pathname !== '/api/rpc' && route?.kind !== 'rpc') || req.method !== 'POST') throw new AppError('NOT_FOUND', 'Outside the finite fixture', 404);
        const envelope = await rpcBody(req), {operation, input} = envelope;
        if (Object.keys(envelope).some(key => !['operation', 'input'].includes(key)) || typeof operation !== 'string' || !OPERATIONS[domain].has(operation)) throw new AppError('UNKNOWN_OPERATION', 'Outside the finite fixture', 404);
        if (route?.kind === 'rpc') assertProjectRpc(store.db, {projectId: route.projectId}, operation, input);
        else if (!isAppLevelOperation(operation)) throw new AppError('VALIDATION_ERROR', 'Project RPC needs an address', 400);
        send(res, 200, {ok: true, data: await callObservedRpc(req, res, ownedServices, operation, input)});
      } catch (error) {
        const fields = error !== null && typeof error === 'object' ? error as {status?: unknown; code?: unknown; message?: unknown; details?: unknown} : {};
        const status = typeof fields.status === 'number' && fields.status >= 400 && fields.status < 600 ? fields.status : 500;
        send(res, status, {ok: false, error: {code: status === 500 ? 'INTERNAL_ERROR' : fields.code, message: status === 500 ? 'Historical test domain failed' : fields.message, details: fields.details ?? {}, retryable: false}});
      }
    }
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new TypeError('A loopback TCP listener is required');
    origin = `http://127.0.0.1:${address.port}`;
    return {url: origin,
      inspect<T>(read: (db: DatabaseSync) => T): T {
        if (closing || !store.db.isOpen || typeof read !== 'function' || isAsyncFunction(read)) throw new TypeError('Inspection requires a live synchronous callback');
        const result = read(store.db);
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
          if (isPromise(result)) Promise.resolve(result).catch(() => {});
          throw new TypeError('Inspection requires a synchronous result');
        }
        return result;
      },
      close: () => closing ??= (async () => {
        shutdown.abort(); server.closeAllConnections();
        try {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await packageService?.close(); await ownedServices.drain();
        } finally { store.close(); }
      })(),
    };
  } catch (error) {
    shutdown.abort();
    try { await packages?.close(); await services?.drain(); } finally {store.close();}
    throw error;
  }
}
