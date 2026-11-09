import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {startServer} from '../apps/server/src/index.ts';
import {createAgentModelListHttp} from '../apps/server/src/agent-model-list-http.ts';
import {agentSettingsSnapshotSchema, agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import {AGENT_MODEL_LIST_LIMITS, agentModelListResultSchema, agentModelListCacheResultSchema} from '../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListSuccess} from '../packages/contracts/src/agent-model-list.ts';
import {createAgentSettingsClient, createAgentSettingsBroker} from '../apps/desktop/src/secret-broker.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentModelListService} from '../packages/business/src/agent/model-list-service.ts';
import {connectionFor} from '../packages/business/src/agent/settings-envelope.ts';

const token = 'synthetic-model-list-http-token';
const listRoute = '/api/agent/models/list', cacheRoute = '/api/agent/models/cache';
interface Envelope {ok: boolean; data?: unknown; error?: {code: string}}
interface RequestOptions {method?: string; payload?: unknown; raw?: string; headers?: Record<string, string>; authenticated?: boolean}
async function fixture(t: test.TestContext, handler: http.RequestListener = (_req, res) => {res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({data: [{id: 'local-model'}]}));}) {
  let requests = 0;
  const trap = http.createServer((req, res) => {requests++; handler(req, res);});
  await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve));
  const port = (trap.address() as {port: number}).port;
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-model-list-http-'));
  let changes: (() => number) | undefined;
  const start = () => startServer({dataDir: root, port: 0, token,
    inspectApplication: inspect => {changes = () => inspect(db => Number((db.prepare('SELECT total_changes() AS count').get() as {count: number}).count));}});
  let server = await start();
  t.after(async () => {
    trap.closeAllConnections(); await new Promise<void>(resolve => trap.close(() => resolve()));
    await server.close(); await rm(root, {recursive: true, force: true});
  });
  const request = async (route: string, {method = 'POST', payload, raw, headers = {}, authenticated = true}: RequestOptions = {}) => {
    const response = await fetch(server.url + route, {method, headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers}, ...(payload !== undefined || raw !== undefined ? {body: raw ?? JSON.stringify(payload)} : {})});
    return {status: response.status, headers: response.headers, body: await response.json() as Envelope};
  };
  const initial = agentSettingsSnapshotSchema.parse((await request('/api/agent/settings', {method: 'GET'})).body.data);
  const saved = await request('/api/agent/settings', {method: 'PUT', payload: {expectedRevision: initial.revision,
    services: initial.services.map(entry => ({...agentServiceInput(entry), ...(entry.serviceKey === 'ollama' ? {addressInput: `http://127.0.0.1:${port}`} : {})})),
    mioSelection: null, secretActions: []}});
  assert.equal(saved.status, 200);
  const snapshot = agentSettingsSnapshotSchema.parse(saved.body.data);
  const location = {serviceKey: 'ollama', expectedSettingsRevision: snapshot.revision, selection: {presetId: 'ollama', platformId: 'local', protocol: 'chat_completions', baseUrl: `http://127.0.0.1:${port}/v1`}};
  return {root, location, request, get server() {return server;}, get requests() {return requests;}, changes: () => changes!(),
    async restart() {await server.close(); server = await start();}};
}

test('model-list routes inherit token/cookie/Host/Origin admission and strict bounded POST input', async t => {
  const f = await fixture(t);
  const payload = {...f.location, credential: {source: 'none'}};
  for (const route of [listRoute, cacheRoute]) {
    const value = route === listRoute ? payload : f.location;
    assert.equal((await f.request(route, {payload: value, authenticated: false})).status, 401);
    assert.equal((await f.request(route, {payload: value, headers: {origin: 'https://evil.example.com'}})).status, 403);
    assert.equal((await f.request(route, {method: 'GET'})).status, 405);
    assert.equal((await f.request(route + '?key=must-not-be-used', {payload: value})).status, 400);
    assert.equal((await f.request(route, {raw: '{'})).status, 400);
    assert.equal((await f.request(route, {payload: value, headers: {'content-type': 'text/plain'}})).status, 400);
    assert.equal((await f.request(route, {payload: {...value, unexpected: true}})).status, 400);
    const raw = JSON.stringify(value);
    assert.equal((await f.request(route, {raw: raw + ' '.repeat(AGENT_MODEL_LIST_LIMITS.requestBytes + 1 - Buffer.byteLength(raw))})).status, 413);
  }
  assert.equal(f.requests, 0);
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(f.server.url + listRoute, {method: 'POST', headers: {host: 'evil.example.com', authorization: `Bearer ${token}`}}, res => {res.resume(); resolve(res.statusCode);});
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
  assert.equal(hostileHost, 403);
  const login = await f.request('/api/login', {payload: {token}, authenticated: false});
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const raw = JSON.stringify(payload);
  const accepted = await f.request(listRoute, {raw: raw + ' '.repeat(AGENT_MODEL_LIST_LIMITS.requestBytes - Buffer.byteLength(raw)), authenticated: false, headers: {cookie, origin: f.server.url}});
  assert.equal(accepted.status, 200); assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.equal(agentModelListResultSchema.parse(accepted.body.data).outcome, 'success');
  assert.equal(f.requests, 1);
});

test('list writes only its independent cache; restart cache read needs no key, project, or provider request', async t => {
  const f = await fixture(t);
  const settingsFile = path.join(f.root, 'agent-settings/settings.json');
  const before = await readFile(settingsFile), changes = f.changes();
  const missing = await f.request(cacheRoute, {payload: f.location});
  assert.deepEqual(agentModelListCacheResultSchema.parse(missing.body.data), {status: 'miss'}); assert.equal(f.requests, 0);
  await assert.rejects(readdir(path.join(f.root, 'agent-settings/model-list-cache')), {code: 'ENOENT'});
  const listed = await f.request(listRoute, {payload: {...f.location, credential: {source: 'none'}}});
  assert.equal(listed.status, 200);
  const result = agentModelListResultSchema.parse(listed.body.data); assert.equal(result.outcome, 'success');
  assert.deepEqual(await readFile(settingsFile), before); assert.equal(f.changes(), changes);
  assert.equal((await readdir(path.join(f.root, 'agent-settings/model-list-cache'))).length, 1);
  assert.equal(f.requests, 1);
  await f.restart();
  const afterRestartChanges = f.changes();
  const cached = await f.request(cacheRoute, {payload: f.location});
  assert.equal(cached.headers.get('cache-control'), 'no-store');
  const cache = agentModelListCacheResultSchema.parse(cached.body.data); assert.equal(cache.status, 'hit');
  if (cache.status === 'hit') assert.deepEqual(cache.result, result);
  assert.equal(f.requests, 1); assert.equal(f.changes(), afterRestartChanges); assert.deepEqual(await readFile(settingsFile), before);
  const settings = agentSettingsSnapshotSchema.parse((await f.request('/api/agent/settings', {method: 'GET'})).body.data);
  assert.equal(settings.verification, 'not_tested'); assert.equal(settings.mioSelection, null);
  for (const operation of ['agent.models.list', 'agent.models.cache']) {
    const rejected = await f.request('/api/rpc', {payload: {operation, input: {}}});
    assert.equal(rejected.status, 404); assert.equal(rejected.body.error?.code, 'UNKNOWN_OPERATION');
  }
});

test('input key is one-shot on the pinned list GET, and stale revision rejects before dispatch', async t => {
  const observed: {method?: string; url?: string; authorization?: string}[] = [];
  const key = 'synthetic-one-shot-http-list-secret';
  const f = await fixture(t, (req, res) => {
    observed.push({method: req.method, url: req.url, authorization: req.headers.authorization});
    res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({data: [{id: 'local-model'}]}));
  });
  const before = await readFile(path.join(f.root, 'agent-settings/settings.json'));
  const response = await f.request(listRoute, {payload: {...f.location, credential: {source: 'input', value: key}}});
  assert.equal(response.status, 200); assert.equal(JSON.stringify(response.body).includes(key), false);
  assert.deepEqual(observed, [{method: 'GET', url: '/v1/models', authorization: `Bearer ${key}`}]);
  assert.deepEqual(await readFile(path.join(f.root, 'agent-settings/settings.json')), before);
  const files = await readdir(path.join(f.root, 'agent-settings/model-list-cache'));
  for (const file of files) assert.equal((await readFile(path.join(f.root, 'agent-settings/model-list-cache', file), 'utf8')).includes(key), false);
  const stale = await f.request(listRoute, {payload: {...f.location, expectedSettingsRevision: f.location.expectedSettingsRevision - 1, credential: {source: 'none'}}});
  assert.equal(stale.status, 409); assert.equal(stale.body.error?.code, 'AGENT_SETTINGS_CONFLICT'); assert.equal(f.requests, 1);
});

test('client disconnect cancels remote discovery and leaves no late cache', async t => {
  let begun!: () => void, closed!: () => void;
  const started = new Promise<void>(resolve => {begun = resolve;}), ended = new Promise<void>(resolve => {closed = resolve;});
  const f = await fixture(t, (req, res) => {res.once('close', closed); begun();});
  const cancel = new AbortController();
  const pending = fetch(f.server.url + listRoute, {method: 'POST', headers: {'Content-Type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({...f.location, credential: {source: 'none'}}), signal: cancel.signal});
  await started; cancel.abort(); await assert.rejects(pending);
  await ended;
  await assert.rejects(readdir(path.join(f.root, 'agent-settings/model-list-cache')), {code: 'ENOENT'});
  assert.equal(f.requests, 1);
});

test('provider failures stay safe data and never overwrite a good cache or start unavailable descriptors', async t => {
  const key = 'synthetic-provider-error-must-stay-private';
  let status = 200, reflect = false;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(status === 200 ? {data: [{id: reflect ? key : 'cached-model'}]} : {message: key, secret: key}));
  });
  const input = {...f.location, credential: {source: 'input', value: key}};
  const first = agentModelListResultSchema.parse((await f.request(listRoute, {payload: input})).body.data);
  assert.equal(first.outcome, 'success');
  for (const [httpStatus, outcome] of [[401, 'invalid_key'], [404, 'unavailable'], [500, 'unreachable']] as const) {
    status = httpStatus;
    const result = await f.request(listRoute, {payload: input}); assert.equal(result.status, 200);
    assert.equal(agentModelListResultSchema.parse(result.body.data).outcome, outcome);
    assert.equal(JSON.stringify(result.body).includes(key), false);
  }
  status = 200; reflect = true;
  const reflected = await f.request(listRoute, {payload: input}); assert.equal(reflected.status, 200);
  assert.equal(agentModelListResultSchema.parse(reflected.body.data).outcome, 'unreachable');
  assert.equal(JSON.stringify(reflected.body).includes(key), false);
  const cached = agentModelListCacheResultSchema.parse((await f.request(cacheRoute, {payload: f.location})).body.data);
  assert.equal(cached.status, 'hit'); if (cached.status === 'hit') assert.deepEqual(cached.result, first);
  const before = f.requests;
  const unavailable = await f.request(listRoute, {payload: {...f.location, serviceKey: 'qwen', selection: {presetId: 'qwen', platformId: 'beijing', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat_completions'}, credential: {source: 'saved'}}});
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.body.data, {outcome: 'unavailable', reason: 'not_provided'});
  assert.equal(f.requests, before);
});

test('the application-entry deadline cancels pending discovery and returns a safe timeout outcome', async t => {
  let begun!: () => void;
  const entered = new Promise<void>(resolve => {begun = resolve;});
  const controller = new AbortController();
  const handler = createAgentModelListHttp({signal: controller.signal, selfPort: () => 4318, models: {
    async list(_input, options) {
      begun();
      return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {once: true}));
    },
    async cache() {return {status: 'miss'};},
  }});
  const server = http.createServer((req, res) => {void handler(req, res, new URL(req.url!, 'http://127.0.0.1'));});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  t.mock.timers.enable({apis: ['setTimeout']});
  const response = new Promise<{status: number | undefined; value: unknown}>((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port: (server.address() as {port: number}).port, path: listRoute, method: 'POST', headers: {'Content-Type': 'application/json'}}, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    req.on('error', reject);
    req.end(JSON.stringify({serviceKey: 'openai', expectedSettingsRevision: 0, selection: {presetId: 'openai', platformId: 'global', baseUrl: 'https://api.openai.com/v1', protocol: 'chat_completions'}, credential: {source: 'none'}}));
  });
  await entered; t.mock.timers.tick(AGENT_MODEL_LIST_LIMITS.totalTimeoutMs);
  assert.deepEqual(await response, {status: 200, value: {ok: true, data: {outcome: 'unreachable', reason: 'timeout'}}});
});

test('desktop model-list route traverses the real settings client and broker for input, saved keys and cache', async t => {
  const selfPort = 4318, savedKey = 'SYNTHETIC_SAVED_LIST', inputKey = 'SYNTHETIC_INPUT_LIST';
  const owner = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const initial = await owner.get();
  const snapshot = await owner.put({expectedRevision: initial.revision, services: initial.services.map(agentServiceInput), mioSelection: null,
    secretActions: [{serviceKey: 'openai', action: 'replace', storage: 'session', value: savedKey}]});
  let posts = 0, providerCalls = 0;
  const providerKeys: (string | null)[] = [], entries = new Map<string, AgentModelListSuccess>();
  // Electron's message transport is the only desktop boundary replaced here.
  // The utility client and main broker retain their real strict option checks.
  const port = Object.assign(new EventEmitter(), {postMessage(message: unknown) {posts++; queueMicrotask(() => {void broker.handle(message);});}});
  const broker = createAgentSettingsBroker({agentSettings: owner, getSelfPort: () => selfPort,
    send: message => queueMicrotask(() => port.emit('message', {data: message}))});
  const client = createAgentSettingsClient({port});
  const models = createAgentModelListService({settings: client, selfPort: () => selfPort,
    cache: {read: key => entries.get(JSON.stringify(key)) ?? null, write: (key, value) => {entries.set(JSON.stringify(key), value); return true;}, remove: () => {}},
    fetch: async options => {providerCalls++; providerKeys.push(options.apiKey); return {outcome: 'success', models: [{id: 'gpt-4.1-mini', adaptation: 'adapted'}], complete: true, source: 'current_protocol', fetchedAt: '2026-11-09T00:00:00.000Z'};},
  });
  const lifetime = new AbortController();
  const route = createAgentModelListHttp({models, signal: lifetime.signal, selfPort: () => selfPort});
  const server = http.createServer((req, res) => {void route(req, res, new URL(req.url!, 'http://127.0.0.1'));});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {lifetime.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await models.close(); client.close(); broker.close(); await owner.close();});
  const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const {model: _model, ...selection} = connectionFor(snapshot.services.find(entry => entry.serviceKey === 'openai')!);
  const location = {serviceKey: 'openai', expectedSettingsRevision: snapshot.revision, selection};
  const request = async (path: string, payload: unknown) => {
    const response = await fetch(endpoint + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    return {status: response.status, body: await response.json() as Envelope};
  };
  const firstCache = await request(cacheRoute, location);
  assert.equal(firstCache.status, 200); assert.deepEqual(firstCache.body, {ok: true, data: {status: 'miss'}});
  assert.equal(providerCalls, 0); assert.ok(posts > 0, 'Cache must read settings through desktop IPC');
  const invalid = await client.get({selfPort, isActive: () => true} as Parameters<typeof client.get>[0]).then(() => null, (error: unknown) => error);
  assert.equal((invalid as {code: string}).code, 'VALIDATION_ERROR', 'The broker client still rejects foreign option keys');
  for (const credential of [{source: 'input', value: inputKey}, {source: 'saved'}] as const) {
    const listed = await request(listRoute, {...location, credential});
    assert.equal(listed.status, 200); assert.equal(listed.body.ok, true);
    const result = agentModelListResultSchema.parse(listed.body.data); assert.equal(result.outcome, 'success');
    const cached = await request(cacheRoute, location); assert.equal(cached.status, 200);
    const cache = agentModelListCacheResultSchema.parse(cached.body.data); assert.equal(cache.status, 'hit');
    if (cache.status === 'hit') assert.deepEqual(cache.result, result);
    for (const value of [listed.body, cached.body, [...entries.values()]]) {
      assert.equal(JSON.stringify(value).includes(inputKey), false); assert.equal(JSON.stringify(value).includes(savedKey), false);
    }
  }
  assert.deepEqual(providerKeys, [inputKey, savedKey]); assert.equal(providerCalls, 2);
  assert.deepEqual(await client.get({selfPort}), snapshot, 'Discovery never mutates saved settings or verification');
});
