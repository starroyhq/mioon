import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable, Writable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {opacityBackupFixture} from './opacity-backup-fixture.ts';
import {reopenOpacityCandidateApplicationStore} from '../../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../../packages/business/src/opacity-candidate-services.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../../packages/business/src/opacity-candidate-backup.ts';
import {createRestoredOpacityCandidateLaunch} from '../../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../../apps/server/src/index.ts';

export const restoredApplicationToken = 'synthetic-restored-opacity-application-token';
export interface RestoredRequestOptions {
  readonly method?: string; readonly input?: unknown; readonly headers?: Record<string, string>;
  readonly authenticate?: boolean; readonly aborted?: boolean;
  readonly beforeHandle?: (req: Readable & {method?: string; url?: string; aborted?: boolean; headers?: Record<string, unknown>}, res: Writable & {status?: number; headers?: Record<string, unknown>; headersSent?: boolean}) => void;
}
export interface RestoredHttpResult {
  readonly status: number; readonly text: string; readonly bytes: Buffer;
  readonly headers: Record<string, unknown>; readonly data: unknown; readonly req: unknown; readonly res: unknown;
}
interface RequestApplication {handleRequest?: (req: never, res: never) => Promise<void>; close?(): Promise<unknown>}
type Application = Awaited<ReturnType<typeof createOpacityCandidateRequestApplication>>;

/** Invoke the real shared handler without a listener or native worker. Optional
 * disconnected requests exercise its actual observation boundary. */
export async function request(app: RequestApplication, pathname: string, {method = 'GET', input, headers: extra = {}, authenticate = true,
  aborted = false, beforeHandle}: RestoredRequestOptions = {}): Promise<RestoredHttpResult> {
  const data = input === undefined ? null : Buffer.from(JSON.stringify(input));
  const req = Readable.from(data ? [data] : []);
  Object.assign(req, {method, url: pathname, aborted, headers: {host: '127.0.0.1:4319',
    ...(authenticate ? {authorization: `Bearer ${restoredApplicationToken}`} : {}),
    ...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), ...extra}});
  const chunks: Buffer[] = [];
  type MockResponse = Writable & {status: number; headers: Record<string, unknown>; headersSent: boolean;
    setHeader(name: string, value: unknown): void; writeHead(status: number, headers?: Record<string, unknown>): MockResponse};
  const res = new Writable({write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error|null)=>void) {chunks.push(Buffer.from(chunk)); callback();}}) as MockResponse;
  res.status = 0; res.headers = {}; res.headersSent = false;
  res.setHeader = (name: string, value: unknown) => {res.headers[name.toLowerCase()] = value;};
  res.writeHead = (status: number, headers: Record<string, unknown> = {}) => {
    res.status = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.headersSent = true; return res;
  };
  beforeHandle?.(req as Readable & {method?: string; url?: string; aborted?: boolean; headers?: Record<string, unknown>}, res);
  const handler = app.handleRequest;
  if (!handler) throw Error('Synthetic application has no request handler');
  await (handler as unknown as (reqValue: unknown, resValue: unknown) => Promise<void>)(req, res);
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
  return {status: res.status, text, bytes, headers: res.headers,
    data: /^application\/json/u.test(String(res.headers['content-type'] ?? '')) ? JSON.parse(text) : null, req, res};
}
export const rpc = (app: RequestApplication, operation: string, input: unknown = {}, context: Record<string, unknown> = {}): Promise<RestoredHttpResult> => request(app, '/api/rpc', {
  method: 'POST', input: {operation, input, ...context},
});
export interface RestoredFixtureContext {
  readonly base: string; readonly source: string; readonly backup: string; readonly destination: string;
  readonly projectId: string; readonly restored: {readonly workspaceOrigin: string; readonly [key: string]: unknown};
  readonly app: Application; readonly [key: string]: unknown;
}
export async function prepareTask(f: RestoredFixtureContext, operation: string, input: unknown): Promise<{task: {id: string; digest: string; [key: string]: unknown}; instanceId: string; [key: string]: unknown}> {
  const prepared = await request(f.app, '/api/tasks/prepare', {method: 'POST', input: {
    projectId: f.projectId, operation, input, origin: 'new', expectedWorkspaceOrigin: f.restored.workspaceOrigin,
  }});
  const body = prepared.data as {ok?: boolean; data?: {task: {id: string; digest: string; [key: string]: unknown}; instanceId: string}};
  assert.equal(body.ok, true, prepared.text);
  if (!body.data) throw Error('Synthetic prepare returned no data');
  return body.data;
}
export async function applyTask(f: RestoredFixtureContext, operation: string, input: unknown): Promise<{prepared: {task: {id: string; digest: string; [key: string]: unknown}; instanceId: string}; executed: Record<string, unknown>; acknowledged: Record<string, unknown>; result: unknown}> {
  const prepared = await prepareTask(f, operation, input), authority = {
    projectId: f.projectId, digest: prepared.task.digest, expectedWorkspaceOrigin: f.restored.workspaceOrigin,
  };
  const executed = await request(f.app, `/api/tasks/${prepared.task.id}/execute`, {method: 'POST', input: {
    ...authority, instanceId: prepared.instanceId,
  }});
  const executedBody = executed.data as {ok?: boolean; data?: {task: {status?: unknown; revision?: unknown}; result?: unknown}};
  assert.equal(executedBody.ok, true, executed.text);
  const executedData = executedBody.data as {task: {status?: unknown; revision?: unknown}; result?: unknown} | undefined;
  assert.equal(executedData?.task.status, 'applied', executed.text);
  const acknowledged = await request(f.app, `/api/tasks/${prepared.task.id}/acknowledge`, {method: 'POST', input: {
    ...authority, expectedRevision: executedData?.task.revision, status: 'applied',
  }});
  const acknowledgedBody = acknowledged.data as {ok?: boolean; data?: Record<string, unknown>};
  assert.equal(acknowledgedBody.ok, true, acknowledged.text);
  return {prepared, executed: executedData as Record<string, unknown>, acknowledged: acknowledgedBody.data as Record<string, unknown>, result: executedData?.result};
}

/** Real cold42 archive -> distinct43 publication -> fixed one-shot application
 * launch. Every path and opaque source byte is owned by this test. */
export async function restoredApplicationFixture(t: unknown) {
  const f = await opacityBackupFixture(t) as unknown as RestoredFixtureContext, source = reopenOpacityCandidateApplicationStore(f.source);
  const services = createOpacityCandidateApplicationServices(source);
  let captured;
  try {
    captured = await services.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, purpose: 'preview'});
  } finally {await services.drain(); source.close();}
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  const restored = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  const dist = path.join(f.base, 'candidate-dist'); fs.mkdirSync(dist, {mode: 0o700});
  fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
  fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>isolated restored opacity43 entry</html>');
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>ordinary entry</html>');
  let app: Application|undefined;
  const close = async (): Promise<void> => {await app?.close();};
  const reopen = async (): Promise<Application> => {
    await close();
    app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: createRestoredOpacityCandidateLaunch(f.destination),
      port: 4319, distDir: dist, token: restoredApplicationToken});
    return app;
  };
  (f.manage as (finish: ()=>Promise<void>)=>void)(close); await reopen();
  return {...f, restored, captured, dist, get app(): Application {if(!app)throw Error('Application not opened');return app;}, close, reopen,
    readDb<T>(callback: (db: DatabaseSync)=>T): T {
      const db = new DatabaseSync(path.join(f.destination, 'workbench.sqlite'), {readOnly: true});
      try {return callback(db);} finally {db.close();}
    },
  };
}
