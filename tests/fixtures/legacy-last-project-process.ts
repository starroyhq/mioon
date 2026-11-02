// Only the historical sidecar backup/restored cases use this owned process.
// Ordinary locator transport tests keep the real production B1 server.
import {installWireGuard} from '../helpers/inspection-wire-fixture.ts';
import {once} from 'node:events';
const guard = installWireGuard({auditPath: process.argv[2]});
const {openLegacyWorkspaceStore, ownsStoreLock, getWorkspaceRestoreContext} = await import('../../packages/business/src/db.ts');
const {createServices} = await import('../../packages/business/src/services.ts');
const {createLastProject, readLastProjectTarget} = await import('../../packages/business/src/last-project.ts');
const {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} = await import('../../packages/contracts/src/private-storage.ts');
const {createLastProjectHttp} = await import('../../apps/server/src/last-project-http.ts');
const {callObservedRpc} = await import('../../apps/server/src/rpc-observation.ts');
const {AppError} = await import('../../packages/contracts/src/app-error.ts');
const {timingSafeEqual} = await import('node:crypto');
const http = await import('node:http');
type Message = {type?: unknown; id?: unknown; root?: unknown; token?: unknown};
const report = (value: unknown): void => {if (process.connected) process.send?.(value);};
let close: (() => Promise<void>) | undefined;
let inspect: (() => unknown) | undefined;
let started = false;
process.on('message', async (value: unknown) => {
  const message = value as Message;
  try {
    if (message?.type === 'start' && !started && typeof message.root === 'string' && typeof message.token === 'string') {
      started = true;
      const root = message.root, token = message.token, store = openLegacyWorkspaceStore(root), shutdown = new AbortController();
      const services = createServices(store, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, imageOptions: {autoRun: false}});
      const locator = createLastProject({root, signal: shutdown.signal, storage: {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile},
        guards: {ownsLock: () => ownsStoreLock(store), isRestored: () => getWorkspaceRestoreContext(store) !== null, readProject: id => readLastProjectTarget(store.db, id)}});
      const locatorHttp = createLastProjectHttp({lastProject: locator, signal: shutdown.signal});
      let origin = '', closing: Promise<void> | undefined;
      const send = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
        res.end(JSON.stringify(body));
      };
      const server = http.createServer((req, res) => {void (async () => {
        try {
          const authority = new URL(origin), bearer = req.headers.authorization?.replace(/^Bearer /u, '');
          if (![authority.host, `localhost:${authority.port}`].includes(req.headers.host ?? '') || req.headers.origin && req.headers.origin !== origin) throw new AppError('ORIGIN_REJECTED', 'Historical fixture origin rejected', 403);
          const a = Buffer.from(bearer ?? ''), b = Buffer.from(token);
          if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError('UNAUTHORIZED', 'Fixture token required', 401);
          const url = new URL(req.url ?? '/', origin);
          if (await locatorHttp(req, res, url)) return;
          if (url.pathname !== '/api/rpc' || req.method !== 'POST' || getWorkspaceRestoreContext(store) === null) throw new AppError('NOT_FOUND', 'Outside historical locator fixture', 404);
          const chunks: Buffer[] = [];let size = 0;
          for await (const chunk of req) {size += chunk.length;if (size > 8192) throw new AppError('VALIDATION_ERROR', 'Fixture body too large', 413);chunks.push(chunk);}
          const envelope: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
          if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) throw new AppError('VALIDATION_ERROR', 'Expected object', 400);
          const fields = envelope as Record<string, unknown>;
          if (fields.operation !== 'project.create' || Object.keys(fields).some(key => !['operation', 'input', 'expectedWorkspaceOrigin'].includes(key))) throw new AppError('UNKNOWN_OPERATION', 'Outside historical locator fixture', 404);
          send(res, 200, {ok: true, data: await callObservedRpc(req, res, services, 'project.create', fields.input, {expectedWorkspaceOrigin: fields.expectedWorkspaceOrigin})});
        } catch (error) {
          const fields = error as {status?: unknown; code?: unknown; message?: unknown; details?: unknown} | null;
          const status = typeof fields?.status === 'number' ? fields.status : 500;
          send(res, status, {ok: false, error: {code: status === 500 ? 'INTERNAL_ERROR' : fields?.code, message: status === 500 ? 'Historical locator fixture failed' : fields?.message, details: fields?.details ?? {}, retryable: false}});
        }
      })();});
      close = () => closing ??= (async () => {
        shutdown.abort();server.closeAllConnections();
        try {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));await services.drain();}
        finally {store.close();if (process.connected) process.disconnect();}
      })();
      inspect = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))]));
      server.listen(0, '127.0.0.1');await once(server, 'listening');
      const address = server.address();if (address === null || typeof address === 'string') throw new TypeError('Loopback listener required');
      origin = `http://127.0.0.1:${address.port}`;
      report({type: 'ready', pid: process.pid, url: origin});
    } else if (message?.type === 'snapshot' && typeof message.id === 'string' && inspect) report({type: 'reply', id: message.id, data: inspect()});
    else if (message?.type === 'observe' && typeof message.id === 'string') report({type: 'reply', id: message.id, data: {phases: []}});
    else if (message?.type === 'close') await close?.();
    else guard.deny('unsupported historical locator IPC');
  } catch (error) {report({type: 'fatal', message: String(error).slice(0, 2000)});process.exitCode = 1;await close?.();}
});
process.once('disconnect', () => {void close?.();});
