import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../../apps/server/src/index.ts';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';

export const TASK_TOKEN = 'synthetic-durable-edit-transport-token';
export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const DOMAIN_TABLES = ['projects', 'assets', 'nodes', 'shots', 'edges', 'jobs', 'versions', 'exports', 'timelines',
  'timeline_requests', 'reference_requests', 'timeline_history', 'timeline_history_cursors', 'idempotency', 'job_events'];
export function database<T>(root: string, read: (db: DatabaseSync)=>T, writable = false): T {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  try { return read(db); } finally { db.close(); }
}
export const snapshot = (root: string, tables: readonly string[] = DOMAIN_TABLES): Record<string, unknown> => database(root, (db: DatabaseSync) => Object.fromEntries(tables.map((table: string) =>
  [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
export const taskPath = (id: string, action?: string): string => `/api/tasks/${id}${action ? '/' + action : ''}`;
export const listPath = (projectId: string): string => `/api/tasks?projectId=${projectId}`;
export async function until<T>(check: ()=>T|Promise<T>, label: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  do { const value = await check(); if (value) return value; await delay(10); } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}
function deadline<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>|undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
}
export interface FixtureRequestOptions {method?: string; input?: unknown; raw?: string; authenticated?: boolean; headers?: Record<string, string>; chunked?: boolean}
export interface FixtureResponse {status: number; headers: Record<string, string|string[]|undefined>; body: Record<string, unknown>}
export function request(url: string, route: string, {method = 'GET', input, raw, authenticated = true, headers = {}, chunked = false}: FixtureRequestOptions = {}): Promise<FixtureResponse> {
  const payload = raw ?? (input === undefined ? undefined : JSON.stringify(input));
  return new Promise<FixtureResponse>((resolve, reject) => {
    const req = http.request(url + route, {method, agent: false, headers: {
      'content-type': 'application/json', ...(authenticated ? {authorization: 'Bearer ' + TASK_TOKEN} : {}),
      ...(payload !== undefined && !chunked ? {'content-length': Buffer.byteLength(payload)} : {}), ...headers,
    }}, (res: IncomingMessage) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part: string) => { text += part; if (text.length > 2 * 1024 * 1024) res.destroy(Error('Fixture response cap')); });
      res.once('error', reject);
      res.once('end', () => { try { resolve({status: res.statusCode ?? 0, headers: res.headers as Record<string, string|string[]|undefined>, body: text ? JSON.parse(text) as Record<string, unknown> : {}}); } catch (error) { reject(error); } });
    });
    req.setTimeout(10000, () => req.destroy(Error('Fixture request timeout')));
    req.once('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function childBackend(root: string): Promise<Record<string, unknown>> {
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL('./edit-tasks-http-process.ts', import.meta.url))], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test', MIOON_ENABLE_LIVE_PROVIDER: '0'},
  });
  let output = '';
  let resolveReady!: (value: Record<string, unknown>)=>void, rejectReady!: (error: Error)=>void;
  for (const stream of [child.stdout, child.stderr]) (stream as import('node:stream').Readable).setEncoding('utf8').on('data', (chunk: string) => { output = (output + chunk).slice(-20000); });
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise<{code: number|null; signal: NodeJS.Signals|null}>((resolve, reject) => { child.once('exit', (codeValue, signalValue) => resolve({code: codeValue, signal: signalValue})); child.once('error', reject); });
  const replies = new Map<string, (value: unknown)=>void>();
  child.on('message', (message: {type?: string; message?: string; requestId?: string; data?: unknown}) => {
    if (message.type === 'ready') resolveReady(message as Record<string, unknown>);
    else if (message.type === 'error') rejectReady(Error(message.message));
    else if (message.type === 'reply') replies.get(String(message.requestId))?.(message.data);
  });
  exited.then(result => rejectReady(Error(`Backend exited: ${JSON.stringify(result)}\n${output}`)), rejectReady);
  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  const ask = async (message: Record<string, unknown>): Promise<unknown> => {
    const requestId = randomUUID();
    try { return await deadline(new Promise<unknown>(resolve => { replies.set(requestId, resolve); child.send({...message, requestId}); }), 'fixture IPC'); }
    finally { replies.delete(requestId); }
  };
  const processHandle = {child, exited, get output() { return output; },
    arm: (phase: string) => ask({type: 'arm', phase}), observe: () => ask({type: 'observe'}),
    async close() {
      if (running()) {
        child.send({type: 'close'});
        try { return await deadline(exited, 'backend close'); }
        catch (error) { child.kill('SIGKILL'); await exited; throw error; }
      }
      return exited;
    },
  };
  try {
    child.send({type: 'start', dataDir: root, token: TASK_TOKEN});
    const started = await deadline(ready, 'backend readiness');
    assert.equal(started.pid, child.pid);
    return {...processHandle, url: started.url};
  } catch (error) { if (running()) child.kill('SIGKILL'); await exited; throw error; }
}

export interface TaskFixtureOptions {subprocess?: boolean; fault?: (...args: unknown[])=>unknown}
export async function taskFixture(t: unknown, {subprocess = false, fault}: TaskFixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-tasks-http-'));
  interface BackendHandle {readonly url: string; close(): Promise<unknown>}
  let backend: BackendHandle|undefined, proxy: http.Server|undefined, dropRoute: string|undefined;
  const requests: {method?: string; route?: string; raw: string}[] = [], observed: unknown[] = [], phases: unknown[] = [];
  (t as {after(callback: ()=>Promise<void>): void}).after(async () => {
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
    await backend?.close();
    await rm(root, {recursive: true, force: true});
  });
  const store = openStore(root);
  type FixtureRecord = Record<string, unknown> & {id: string};
  let project!: FixtureRecord, foreign!: FixtureRecord, timeline!: FixtureRecord, shot!: FixtureRecord, source!: FixtureRecord, node!: FixtureRecord;
  try {
    const services = createServices(store, new Map());
    project = await services.call('project.create', {name: 'Synthetic durable task project'}) as unknown as FixtureRecord;
    foreign = await services.call('project.create', {name: 'FOREIGN_RECORD_MUST_NOT_LEAK'}) as unknown as FixtureRecord;
    source = store.put('assets', {id: randomUUID(), projectId: project.id, name: 'Synthetic metadata image', mimeType: 'image/png',
      relativePath: 'media/synthetic.png', sha256: 'a'.repeat(64), sizeBytes: 100, duration: 0, width: 16, height: 16,
      hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: new Date().toISOString()});
    node = await services.call('node.create', {projectId: project.id, type: 'image', assetId: source.id, position: {x: 1, y: 2}, label: 'Synthetic reference'}) as unknown as FixtureRecord;
    shot = await services.call('shot.create', {projectId: project.id, title: 'Synthetic saved shot'}) as unknown as FixtureRecord;
    timeline = await services.call('timeline.get', {projectId: project.id}) as unknown as FixtureRecord;
  } finally { store.close(); }
  const start = async (): Promise<BackendHandle> => subprocess ? await childBackend(root) as unknown as BackendHandle : await startServer({dataDir: root, port: 0, token: TASK_TOKEN,
    taskFault: (...args: unknown[]) => { phases.push(args[0]); return fault?.(...args); }});
  backend = await start();
  // A real loopback proxy loses only the response after the backend has fully
  // answered. It never retries or cancels the completed upstream action.
  proxy = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      let raw = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024) throw Error('Fixture request cap'); raw += chunk; }
      requests.push({method: req.method, route: req.url, raw});
      const result = await request(backend!.url, req.url ?? '', {method: req.method, ...(raw ? {raw} : {})});
      observed.push({route: req.url, ...result});
      if (dropRoute === req.url) { dropRoute = undefined; res.destroy(); return; }
      res.writeHead(result.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(result.body));
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', () => resolve()));
  const proxyAddress = proxy!.address(), proxyPort = typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  return {root, project, foreign, source, node, shot, timeline, requests, observed, phases,
    get backend() { return backend; },
    request: (route: string, options?: FixtureRequestOptions) => request(backend!.url, route, options),
    viaProxy: (route: string, options?: FixtureRequestOptions) => request(proxyUrl, route, options),
    lose: (route: string) => { dropRoute = route; },
    async restart(): Promise<void> { await backend!.close(); backend = await start(); },
    async data(route: string, options?: FixtureRequestOptions): Promise<Record<string, unknown>> { const response = await this.request(route, options); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true); return response.body.data as Record<string, unknown>; },
    rpc(operation: string, input: unknown): Promise<Record<string, unknown>> { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    prepare(operation: string, input: unknown, origin = 'new'): Promise<Record<string, unknown>> { return this.data('/api/tasks/prepare', {method: 'POST', input: {projectId: project.id, operation, input, origin}}); },
    execute(prepared: {task: {id: string; digest: string}; instanceId: unknown}, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.data(taskPath(prepared.task.id, 'execute'), {method: 'POST', input: {projectId: project.id, digest: prepared.task.digest, instanceId: prepared.instanceId, ...overrides}}); },
    reconcile(task: {id: string; digest: string}): Promise<Record<string, unknown>> { return this.data(taskPath(task.id, 'reconcile'), {method: 'POST', input: {projectId: project.id, digest: task.digest}}); },
    get(taskId: string): Promise<Record<string, unknown>> { return this.data(taskPath(taskId) + '?projectId=' + project.id); },
    list(suffix = ''): Promise<Record<string, unknown>> { return this.data(listPath(project.id) + suffix); },
    acknowledge(task: {id: string; digest: string; revision: unknown; status: unknown}): Promise<Record<string, unknown>> { return this.data(taskPath(task.id, 'acknowledge'), {method: 'POST', input: {projectId: project.id, digest: task.digest, expectedRevision: task.revision, status: task.status}}); },
  };
}
