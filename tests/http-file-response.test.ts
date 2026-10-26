import type {RootFailure} from './helpers/strict-root-error-types.ts';
import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {Readable} from 'node:stream';
import {mkdtemp, mkdir, writeFile, readFile, open, rename, unlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '@mioon/business';
import {startServer} from '@mioon/server';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {createFileResponses, FILE_RESPONSE_LIMITS, type FileResponsesOptions} from '../apps/server/src/file-response.ts';
import {authorizeHttpSnapshot} from './helpers/agent-authorizations.ts';
import type { PathLike } from 'fs';
import type { CreateReadStreamOptions, FileHandle } from 'fs/promises';

const token = 'synthetic-q4-file-response-token';
const delay = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve}; };
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) assert.fail(message); await delay(5); }
}
async function actual(t: test.TestContext, {gateway}: {gateway?: NonNullable<Parameters<typeof startServer>[0]>['chatGateway']} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-http-files-'));
  const dataDir = path.join(root, 'data'), distDir = path.join(root, 'dist');
  await mkdir(distDir); await writeFile(path.join(distDir, 'index.html'), '<html>synthetic renderer</html>');
  await writeFile(path.join(distDir, 'entry.js'), 'console.log("synthetic")');
  const store = (openStore(dataDir) as unknown as TypedStore), id = randomUUID(), projectId = randomUUID();
  const file = path.join(dataDir, 'media', id + '.bin'), bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  await writeFile(file, bytes, {mode: 0o600});
  store.put('projects', {id: projectId, name: 'Synthetic HTTP project'});
  store.put('assets', {id, projectId, name: 'Synthetic media', mimeType: 'video/mp4', relativePath: `media/${id}.bin`, sizeBytes: bytes.length, url: `/media/${id}`});
  store.close();
  const options = {dataDir, distDir, port: 0, token, ...(gateway ? {chatGateway: gateway} : {})};
  let service = await startServer(options);
  t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  return {root, file, distDir, get service() {return service;}, bytes, id, projectId,
    async restart() {await service.close(); service = await startServer(options);},
    request: (route: string = `/media/${id}`, options: RequestInit|undefined = {}) => fetch(service.url + route, {...options, headers: {authorization: `Bearer ${token}`, ...options.headers}})};
}
interface TestReadHandle {stat(): Promise<{isFile(): boolean; size: number}>; createReadStream(options?: CreateReadStreamOptions): Readable; close(): Promise<void>}
interface Tracking {opens: number; closes: number; streams: number; lastStream: Readable}
async function harness(t: test.TestContext, {openFile, limits, headers, ranges = true}: {openFile?: (file: string, flags: number) => Promise<TestReadHandle>; limits?: FileResponsesOptions['limits']; headers?: Record<string, string>; ranges?: boolean} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-file-pipeline-'));
  const file = path.join(root, 'fixture.bin'); await writeFile(file, Buffer.alloc(512 * 1024, 0x61));
  const response = createFileResponses({openFile: openFile as FileResponsesOptions['openFile'], limits});
  const errors: unknown[] = [], sockets = new Set<net.Socket>();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end('healthy');
    try { await response.send(req, res, {file, headers: headers || {'Content-Type': 'application/octet-stream'}, ranges}); }
    catch (error) { errors.push(error); if (!res.destroyed && !res.headersSent) {res.writeHead((error as RootFailure).status || 500); res.end((error as RootFailure).message);} }
  });
  server.on('connection', socket => {sockets.add(socket); socket.once('close', () => sockets.delete(socket));});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  t.after(async () => { await response.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true}); });
  return {root, file, response, server, url, errors, sockets};
}
async function health(f: {url: string}) { assert.equal(await (await fetch(f.url + '/health', {headers: {connection: 'close'}})).text(), 'healthy'); }
function trackedOpen(state: Tracking, decorate: (value: TestReadHandle, handle: FileHandle) => TestReadHandle = value => value) {
  return async (file: string, flags: number) => {
    state.opens++;
    const handle = await open(file, flags);
    return decorate({stat: () => handle.stat(), createReadStream: (options?: CreateReadStreamOptions|undefined) => {state.streams++; state.lastStream = handle.createReadStream(options); return state.lastStream;},
      close: async () => {state.closes++; await handle.close();}}, handle);
  };
}
const tracking = () => ({opens: 0, closes: 0, streams: 0} as Tracking);

test('actual media full/HEAD/range/cache/auth and static fallback contracts remain intact', async t => {
  const f = await actual(t);
  let response = await f.request();
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('cache-control'), 'private, max-age=3600'); assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  for (const [range, expected] of [['bytes=0-3', f.bytes.subarray(0, 4)], ['bytes=3-', f.bytes.subarray(3)], ['bytes=-4', f.bytes.subarray(-4)], ['bytes=-999', f.bytes], ['bytes=3-999', f.bytes.subarray(3)]] as const) {
    response = await f.request(undefined, {headers: {range}}); assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  response = await f.request(undefined, {method: 'HEAD', headers: {range: 'bytes=2-5'}});
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes 2-5/${f.bytes.length}`); assert.equal(await response.text(), '');
  response = await f.request(undefined, {method: 'HEAD'}); assert.equal(response.status, 200); assert.equal(await response.text(), '');
  for (const range of ['bytes=', 'bytes=99-', 'bytes=4-3', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
    response = await f.request(undefined, {headers: {range}}); assert.equal(response.status, 416, range); assert.equal(await response.text(), '');
  }
  response = await f.request(`/media/${f.id}?download`); assert.equal(response.headers.get('content-disposition'), 'attachment; filename="mioon.mp4"'); await response.arrayBuffer();
  response = await fetch(f.service.url + `/media/${f.id}`); assert.equal(response.status, 401);
  response = await f.request(undefined, {headers: {origin: 'https://invalid.example'}}); assert.equal(response.status, 403);
  response = await f.request('/entry.js'); assert.match(response.headers.get('content-type')!, /javascript/); assert.equal(response.headers.get('cache-control'), 'no-cache'); await response.text();
  response = await f.request('/missing-route'); assert.match(response.headers.get('content-type')!, /text\/html/); assert.match(await response.text(), /synthetic renderer/);
  response = await f.request('/', {method: 'HEAD'}); assert.equal(response.status, 404, 'static HEAD was not previously supported');
});

test('missing managed bytes and absent renderer return sanitized failures; backend stays healthy', async t => {
  const f = await actual(t); await unlink(f.file);
  const missing = await f.request(); assert.equal(missing.status, 404); const text = await missing.text();
  assert.match(text, /FILE_UNAVAILABLE/); assert.ok(!text.includes(f.root));
  await unlink(path.join(f.distDir, 'index.html'));
  const noBuild = await f.request('/'); assert.equal(noBuild.status, 503); assert.match(await noBuild.text(), /BUILD_REQUIRED/);
  assert.equal((await (await f.request('/health')).json()).ok, true);
});

test('descriptor-backed stat and stream survive path replacement with the original bytes', async t => {
  const state = tracking(); let replaced = false;
  const f = await harness(t, {openFile: async (file: string, flags?: string|number|undefined) => {
    const handle = await open(file, flags); state.opens++;
    if (!replaced) {replaced = true; await rename(file, file + '.old'); await writeFile(file, 'replacement');}
    return {stat: () => handle.stat(), createReadStream: (options?: CreateReadStreamOptions|undefined) => handle.createReadStream(options), close: async () => {state.closes++; await handle.close();}};
  }});
  const response = await fetch(f.url); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, 512 * 1024); assert.equal(bytes[0], 0x61);
  await until(() => state.closes === 1, 'opened original fd must close'); assert.equal(state.opens, 1); await health(f);
});

for (const [name, options, status] of [['HEAD', {method: 'HEAD'}, 200], ['range rejection', {headers: {range: 'bytes=99999999-'}}, 416], ['empty GET', {}, 200]] as const) {
  test(`${name} releases its descriptor without constructing a read stream`, async t => {
    const state = tracking(), f = await harness(t, {openFile: trackedOpen(state)});
    if (name === 'empty GET') await writeFile(f.file, '');
    const response = await fetch(f.url, options); assert.equal(response.status, status); await response.arrayBuffer();
    await until(() => state.closes === 1, 'descriptor closed'); assert.equal(state.streams, 0); await health(f);
  });
}

test('regularity and invalid size are rejected before headers without leaking source errors', async t => {
  for (const metadata of [{isFile: () => false, size: 20}, {isFile: () => true, size: Infinity}]) {
    const state = tracking(), f = await harness(t, {openFile: trackedOpen(state, wrapped => ({...wrapped, stat: async () => metadata}))});
    const response = await fetch(f.url); assert.ok([404, 500].includes(response.status)); await response.text();
    await until(() => state.closes === 1, 'invalid metadata closes'); assert.equal(state.streams, 0); await health(f);
  }
});

test('open and synchronous stream construction failures are safe before headers', async t => {
  for (const at of ['open', 'construct']) {
    const state = tracking(), raw = 'synthetic-secret-path-marker';
    const openFile = at === 'open' ? async () => {throw Object.assign(Error(raw), {code: 'EIO'});} : trackedOpen(state, wrapped => ({...wrapped, createReadStream() {throw Error(raw);}}));
    const f = await harness(t, {openFile}); const response = await fetch(f.url); assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes(raw)); if (at === 'construct') await until(() => state.closes === 1, 'construction failure closes'); await health(f);
  }
});

test('asynchronous read error and truncation abort only their response after headers', async t => {
  for (const mode of ['error', 'truncated']) {
    const state = tracking(), f = await harness(t, {openFile: trackedOpen(state, wrapped => ({...wrapped, createReadStream() {
      let sent = false; const stream = new Readable({read() {if (sent) return; sent = true; this.push(Buffer.from('partial'));
        setTimeout(() => mode === 'error' ? this.destroy(Error('synthetic-private-error-marker')) : this.push(null), 15);}});
      state.lastStream = stream; return stream;
    }}))});
    await assert.rejects(async () => { const response = await fetch(f.url); await response.arrayBuffer(); });
    await until(() => state.closes === 1, 'failed read closes descriptor'); assert.equal(state.lastStream.destroyed, true); await health(f);
  }
});

for (const range of [undefined, 'bytes=0-33554431']) test(`client abort closes a ${range ? 'range' : 'full'} file source without affecting business data`, async t => {
  const state = tracking(), f = await harness(t, {openFile: trackedOpen(state)});
  const handle = await open(f.file, 'r+'); await handle.truncate(64 * 1024 * 1024); await handle.close();
  await new Promise<(void)>((resolve, reject) => {
    const req = http.get(f.url, {headers: range ? {range} : {}}, res => {res.once('data', () => {res.destroy(); resolve();}); res.on('error', () => {});}); req.on('error', reject);
  });
  await until(() => state.closes === 1, 'aborted source closes descriptor'); assert.equal(state.lastStream.destroyed, true); await health(f);
});

test('disconnect and shutdown during a delayed open close the late descriptor without a stream', async t => {
  for (const mode of ['disconnect', 'shutdown']) {
    const state = tracking(), entered = deferred(), release = deferred();
    const f = await harness(t, {openFile: async (...args) => {(entered.resolve)!(); await release.promise; return trackedOpen(state)(...args);}});
    const req = http.get(f.url); req.on('error', () => {}); await entered.promise;
    let closing;
    if (mode === 'shutdown') closing = f.response.close(); else req.destroy();
    await delay(10); (release.resolve)!(); await closing;
    await until(() => state.closes === 1, 'late open closes'); assert.equal(state.streams, 0); await health(f);
  }
});

test('paused raw client is bounded; active-transfer cap rejects before opening another file', {timeout: 10000}, async t => {
  const state = tracking(), f = await harness(t, {limits: {active: 1, idleMs: 100}, openFile: trackedOpen(state)});
  const handle = await open(f.file, 'r+'); await handle.truncate(64 * 1024 * 1024); await handle.close();
  const socket = net.connect((f.server.address() as net.AddressInfo).port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'); socket.pause();
  await until(() => state.streams === 1, 'first transfer started');
  const busy = await fetch(f.url); assert.equal(busy.status, 503); assert.match(await busy.text(), /繁忙/); assert.equal(state.opens, 1);
  await until(() => state.closes === 1, 'stalled socket closes source'); assert.equal(state.lastStream.destroyed, true);
  socket.destroy(); await health(f);
});

test('server shutdown owns active download and rejects late file starts', async t => {
  const state = tracking(), f = await harness(t, {openFile: trackedOpen(state)});
  const handle = await open(f.file, 'r+'); await handle.truncate(64 * 1024 * 1024); await handle.close();
  const socket = net.connect((f.server.address() as net.AddressInfo).port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve)); socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'); socket.pause();
  await until(() => state.streams === 1, 'download began'); const began = Date.now(); await f.response.close();
  assert.ok(Date.now() - began < 1000); assert.equal(state.closes, 1); assert.equal(state.lastStream.destroyed, true); socket.destroy();
  const late = await fetch(f.url); assert.equal(late.status, 503); await late.text(); assert.equal(state.opens, 1); await health(f);
});

test('file transport policy refuses unknown or widened test overrides', () => {
  for (const limits of [{idleMs: FILE_RESPONSE_LIMITS.idleMs + 1}, {active: 0}, {secret: 1}]) assert.throws(() => createFileResponses({limits}), /Invalid file response limit/);
});

for (const protocol of ['chat_completions', 'responses']) test(`actual server disconnect/replay and simultaneous SSE/media shutdown preserve durable ${protocol} run`, {timeout: 10000}, async t => {
  let calls = 0;
  const f = await actual(t, {gateway: async function* ({signal}) {
    calls++; yield {type: 'delta', text: 'Synthetic committed prefix'};
    await new Promise<(void)>(resolve => {if (signal!.aborted) resolve(); else signal!.addEventListener('abort', resolve as () => void, {once: true});});
    yield {type: 'delta', text: 'LATE_NOT_COMMITTED'}; yield {type: 'done', finishReason: 'stop'};
  }});
  const requestJson = async (route?: string|undefined, {method = 'GET', input}: {method?: string; input?: unknown} = {}) => {
    const response = await f.request(route, {method, headers: {'content-type': 'application/json'}, ...(input ? {body: JSON.stringify(input)} : {})});
    return {status: response.status, body: await response.json()};
  };
  const json = async (route?: string|undefined, method: string|undefined = 'GET', input?: unknown) => {
    const response = await requestJson(route, {method,input});
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.ok, true, `${method} ${route}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const data = async (...args: Parameters<typeof json>) => { const body = await json(...args); assert.ok(Object.hasOwn(body, 'data'), 'successful API response has a data envelope'); return body.data; };
  const settings = await data('/api/agent/settings');
  assert.equal((await json('/api/agent/settings', 'PUT', {expectedRevision: settings.revision,
    configuration: {...settings.configuration, protocol}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_Q4_ONLY'}})).ok, true);
  const base = `/api/agent/chat/${f.projectId}`;
  await authorizeHttpSnapshot(requestJson, await data(base), 'typed_chat_only');
  const snapshot = await data(base);
  assert.ok(snapshot.authorization.scopes.includes('typed_chat_only'), 'the real server persisted the exact typed-chat grant');
  const input = {requestId: randomUUID(), instanceId: snapshot.instanceId, expectedSettingsRevision: snapshot.settings.revision,
    expectedConversationRevision: snapshot.revision, message: 'Synthetic typed-only transport check',
    consent: {destination: deriveAgentEndpoint(snapshot.settings.configuration), protocol, model: snapshot.settings.configuration.model, context: 'typed_chat_only'}};
  const accepted = await data(base + '/runs', 'POST', input);
  const events = `${base}/runs/${accepted.run.id}/events?instanceId=${accepted.instanceId}&after=0`;
  const first = await f.request(events); assert.equal(first.status, 200); assert.match(first.headers.get('content-type')!, /text\/event-stream/);
  const reader = (first.body)!.getReader(); await reader.read(); await reader.cancel();
  const running = await data(`${base}/runs/${accepted.run.id}?instanceId=${accepted.instanceId}`);
  assert.equal(running.run.status, 'running');
  const replay = await data(base + '/runs', 'POST', input); assert.equal(replay.run.id, accepted.run.id); assert.equal(calls, 1);
  const handle = await open(f.file, 'r+'); await handle.truncate(64 * 1024 * 1024); await handle.close();
  const sockets = [];
  for (const route of [`/media/${f.id}`, events]) {
    const socket = net.connect(f.service.port, '127.0.0.1'); socket.on('error', () => {}); sockets.push(socket);
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${f.service.port}\r\nAuthorization: Bearer ${token}\r\n\r\n`); socket.pause();
  }
  await delay(20); const started = Date.now(); await f.service.close();
  assert.ok(Date.now() - started < 5000); for (const socket of sockets) socket.destroy();
  await f.restart(); const recovered = await data(`${base}/requests/${input.requestId}`);
  assert.equal(recovered.run.id, accepted.run.id); assert.equal(recovered.run.status, 'interrupted');
  assert.ok(!recovered.run.assistantText.includes('LATE_NOT_COMMITTED')); assert.equal(calls, 1);
  const current = await data(base);
  assert.equal(current.authorization.revision, snapshot.authorization.revision);
  assert.ok(current.authorization.scopes.includes('typed_chat_only'), 'disconnect, shutdown and restart do not revoke the saved grant');
  const health = await json('/health'); assert.equal(health.ok, true);
  const assets = await json('/api/rpc', 'POST', {operation: 'asset.list', input: {projectId: f.projectId}});
  assert.equal(assets.data.length, 1, 'transport cancellation must not create or remove business assets');
});
