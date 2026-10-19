import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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
export function database(root, read, writable = false) {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: !writable});
  try { return read(db); } finally { db.close(); }
}
export const snapshot = (root, tables = DOMAIN_TABLES) => database(root, db => Object.fromEntries(tables.map(table =>
  [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
export const taskPath = (id, action) => `/api/tasks/${id}${action ? '/' + action : ''}`;
export const listPath = projectId => `/api/tasks?projectId=${projectId}`;
export async function until(check, label, ms = 5000) {
  const end = Date.now() + ms;
  do { const value = await check(); if (value) return value; await delay(10); } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}
function deadline(promise, label, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
}
export function request(url, route, {method = 'GET', input, raw, authenticated = true, headers = {}, chunked = false} = {}) {
  const payload = raw ?? (input === undefined ? undefined : JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, {method, agent: false, headers: {
      'content-type': 'application/json', ...(authenticated ? {authorization: 'Bearer ' + TASK_TOKEN} : {}),
      ...(payload !== undefined && !chunked ? {'content-length': Buffer.byteLength(payload)} : {}), ...headers,
    }}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; if (text.length > 2 * 1024 * 1024) res.destroy(Error('Fixture response cap')); });
      res.once('error', reject);
      res.once('end', () => { try { resolve({status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null}); } catch (error) { reject(error); } });
    });
    req.setTimeout(10000, () => req.destroy(Error('Fixture request timeout')));
    req.once('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
async function childBackend(root) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./edit-tasks-http-process.mjs', import.meta.url))], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: tmpdir(), LANG: 'C.UTF-8', NODE_ENV: 'test', MIOON_ENABLE_LIVE_PROVIDER: '0'},
  });
  let output = '', resolveReady, rejectReady;
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20000); });
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject); });
  const replies = new Map();
  child.on('message', message => {
    if (message.type === 'ready') resolveReady(message);
    else if (message.type === 'error') rejectReady(Error(message.message));
    else if (message.type === 'reply') replies.get(message.requestId)?.(message.data);
  });
  exited.then(result => rejectReady(Error(`Backend exited: ${JSON.stringify(result)}\n${output}`)), rejectReady);
  const running = () => child.exitCode === null && child.signalCode === null;
  const ask = async message => {
    const requestId = randomUUID();
    try { return await deadline(new Promise(resolve => { replies.set(requestId, resolve); child.send({...message, requestId}); }), 'fixture IPC'); }
    finally { replies.delete(requestId); }
  };
  const processHandle = {child, exited, get output() { return output; },
    arm: phase => ask({type: 'arm', phase}), observe: () => ask({type: 'observe'}),
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

export async function taskFixture(t, {subprocess = false, fault} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-tasks-http-'));
  let backend, proxy, dropRoute;
  const requests = [], observed = [], phases = [];
  t.after(async () => {
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await backend?.close();
    await rm(root, {recursive: true, force: true});
  });
  const store = openStore(root);
  let project, foreign, timeline, shot, source, node;
  try {
    const services = createServices(store, new Map());
    project = await services.call('project.create', {name: 'Synthetic durable task project'});
    foreign = await services.call('project.create', {name: 'FOREIGN_RECORD_MUST_NOT_LEAK'});
    source = store.put('assets', {id: randomUUID(), projectId: project.id, name: 'Synthetic metadata image', mimeType: 'image/png',
      relativePath: 'media/synthetic.png', sha256: 'a'.repeat(64), sizeBytes: 100, duration: 0, width: 16, height: 16,
      hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: new Date().toISOString()});
    node = await services.call('node.create', {projectId: project.id, type: 'image', assetId: source.id, position: {x: 1, y: 2}, label: 'Synthetic reference'});
    shot = await services.call('shot.create', {projectId: project.id, title: 'Synthetic saved shot'});
    timeline = await services.call('timeline.get', {projectId: project.id});
  } finally { store.close(); }
  const start = () => subprocess ? childBackend(root) : startServer({dataDir: root, port: 0, token: TASK_TOKEN,
    taskFault: (...args) => { phases.push(args[0]); return fault?.(...args); }});
  backend = await start();
  // A real loopback proxy loses only the response after the backend has fully
  // answered. It never retries or cancels the completed upstream action.
  proxy = http.createServer(async (req, res) => {
    try {
      let raw = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024) throw Error('Fixture request cap'); raw += chunk; }
      requests.push({method: req.method, route: req.url, raw});
      const result = await request(backend.url, req.url, {method: req.method, ...(raw ? {raw} : {})});
      observed.push({route: req.url, ...result});
      if (dropRoute === req.url) { dropRoute = undefined; res.destroy(); return; }
      res.writeHead(result.status, {'content-type': 'application/json'});
      res.end(JSON.stringify(result.body));
    } catch { res.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  return {root, project, foreign, source, node, shot, timeline, requests, observed, phases,
    get backend() { return backend; },
    request: (route, options) => request(backend.url, route, options),
    viaProxy: (route, options) => request(proxyUrl, route, options),
    lose: route => { dropRoute = route; },
    async restart() { await backend.close(); backend = await start(); },
    async data(route, options) { const response = await this.request(route, options); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.ok, true); return response.body.data; },
    rpc(operation, input) { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    prepare(operation, input, origin = 'new') { return this.data('/api/tasks/prepare', {method: 'POST', input: {projectId: project.id, operation, input, origin}}); },
    execute(prepared, overrides = {}) { return this.data(taskPath(prepared.task.id, 'execute'), {method: 'POST', input: {projectId: project.id, digest: prepared.task.digest, instanceId: prepared.instanceId, ...overrides}}); },
    reconcile(task) { return this.data(taskPath(task.id, 'reconcile'), {method: 'POST', input: {projectId: project.id, digest: task.digest}}); },
    get(taskId) { return this.data(taskPath(taskId) + '?projectId=' + project.id); },
    list(suffix = '') { return this.data(listPath(project.id) + suffix); },
    acknowledge(task) { return this.data(taskPath(task.id, 'acknowledge'), {method: 'POST', input: {projectId: project.id, digest: task.digest, expectedRevision: task.revision, status: task.status}}); },
  };
}
