import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, rm, readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {startServer} from '../apps/server/src/index.mjs';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.mjs';
import {createAgentSettings} from '../packages/business/src/agent/settings.mjs';

const token = 'synthetic-agent-settings-http-token';
const input = (expectedRevision = 0, secret = {action: 'keep'}, configuration = {...DEFAULT_AGENT_CONFIGURATION}) => ({expectedRevision, configuration, secret});
async function fixture(t, {prepare, agentSettings} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-agent-http-'));
  if (prepare) await prepare(root);
  let server = await startServer({dataDir: root, port: 0, token, agentSettings});
  t.after(async () => { await server.close(); await rm(root, {recursive: true, force: true}); });
  return {root, get server() { return server; },
    async restart() { await server.close(); server = await startServer({dataDir: root, port: 0, token, agentSettings}); },
    async request(route = '/api/agent/settings', {method = 'GET', payload, raw, authenticated = true, headers = {}} = {}) {
      const response = await fetch(server.url + route, {method, headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers}, ...(payload !== undefined || raw !== undefined ? {body: raw ?? JSON.stringify(payload)} : {})});
      return {status: response.status, headers: response.headers, body: await response.json()};
    },
  };
}
async function fileContents(directory) {
  const files = await readdir(directory, {withFileTypes: true});
  return (await Promise.all(files.map(async entry => entry.isDirectory() ? fileContents(path.join(directory, entry.name)) : readFile(path.join(directory, entry.name)).then(b => b.toString('utf8'))))).flat();
}

test('settings HTTP keeps token/cookie auth, rejects hostile host/origin, disallows extra methods and bounds input', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'PUT']) {
    const params = {method, ...(method === 'PUT' ? {payload: input()} : {})};
    assert.equal((await f.request(undefined, {...params, authenticated: false})).status, 401);
    assert.equal((await f.request(undefined, {...params, authenticated: false, headers: {authorization: 'Bearer wrong'}})).status, 401);
    for (const origin of ['null', 'https://evil.example.com']) assert.equal((await f.request(undefined, {...params, headers: {origin}})).status, 403);
  }
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(f.server.url + '/api/agent/settings', {headers: {host: 'evil.example.com', authorization: `Bearer ${token}`}}, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(hostileHost, 403);
  const login = await f.request('/api/login', {method: 'POST', authenticated: false, payload: {token}});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request(undefined, {authenticated: false, headers: {cookie, origin: f.server.url}})).status, 200);
  assert.equal((await f.request(undefined, {method: 'PUT', authenticated: false, headers: {cookie, origin: f.server.url}, payload: input()})).status, 200);
  assert.equal((await f.request(undefined, {method: 'POST', payload: input()})).status, 405);
  assert.equal((await f.request(undefined, {method: 'PUT', raw: '{'})).status, 400);
  assert.equal((await f.request(undefined, {method: 'PUT', raw: JSON.stringify(input()) + ' '.repeat(16 * 1024)})).status, 413);
  assert.equal((await f.request()).body.data.revision, 1);
});

test('web settings store metadata only, survive restart, expire keys, preserve business content and stay absent from RPC', async t => {
  const f = await fixture(t), marker = 'SYNTHETIC_AGENT_HTTP_SECRET_DO_NOT_PERSIST';
  const project = (await f.request('/api/rpc', {method: 'POST', payload: {operation: 'project.create', input: {name: 'Synthetic existing project'}}})).body.data;
  const before = (await f.request('/api/rpc', {method: 'POST', payload: {operation: 'project.get', input: {projectId: project.id}}})).body;
  const initial = await f.request();
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(initial.body.data.presets.length, 9);
  const saved = await f.request(undefined, {method: 'PUT', payload: input(0, {action: 'replace', storage: 'session', value: marker})});
  assert.equal(saved.status, 200); assert.equal(saved.body.data.secret.storage, 'session');
  assert.equal(JSON.stringify(saved.body).includes(marker), false);
  assert.equal((await fileContents(f.root)).some(content => content.includes(marker)), false, 'no plaintext key in envelope, SQLite, WAL, or other workspace file');
  const file = path.join(f.root, 'agent-settings/settings.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(envelope.secret, null); assert.equal(envelope.revision, 1); assert.equal(envelope.version, 2); assert.equal(envelope.configuration.protocol, 'chat_completions');
  const noPersistent = await f.request(undefined, {method: 'PUT', payload: input(1, {action: 'replace', storage: 'persistent', value: marker})});
  assert.equal(noPersistent.status, 409); assert.equal(noPersistent.body.error.code, 'AGENT_SETTINGS_STORAGE_UNAVAILABLE');
  await f.restart();
  const restarted = (await f.request()).body.data;
  assert.equal(restarted.revision, 1); assert.equal(restarted.secret.configured, false); assert.equal(restarted.storage.sessionScope, 'server');
  assert.deepEqual((await f.request('/api/rpc', {method: 'POST', payload: {operation: 'project.get', input: {projectId: project.id}}})).body, before);
  for (const operation of ['agent.settings.get', 'agent.settings.put', 'agent.secret.get']) {
    const response = await f.request('/api/rpc', {method: 'POST', payload: {operation, input: {}}});
    assert.equal(response.status, 404); assert.equal(response.body.error.code, 'UNKNOWN_OPERATION');
  }
});

test('real concurrent HTTP CAS accepts one save and rejects stale deletion or lost-response retry', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({length: 8}, (_, i) => f.request(undefined, {method: 'PUT', payload: input(0, {action: 'replace', storage: 'session', value: `synthetic-${i}`})})));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409 && r.body.error.code === 'AGENT_SETTINGS_CONFLICT').length, 7);
  assert.equal((await f.request()).body.data.revision, 1);
  assert.equal((await f.request(undefined, {method: 'PUT', payload: input(0, {action: 'remove'})})).status, 409);
  assert.equal((await f.request()).body.data.secret.configured, true);
});

test('setting a local endpoint performs no provider probe and self-service endpoint remains forbidden', async t => {
  let requests = 0;
  const trap = http.createServer((req, res) => { requests++; res.writeHead(500).end(); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => trap.close(resolve)));
  const f = await fixture(t);
  const config = {presetId: 'ollama', platformId: 'local', baseUrl: `http://127.0.0.1:${trap.address().port}/v1`, model: 'synthetic-local-model', protocol: 'chat_completions'};
  assert.equal((await f.request(undefined, {method: 'PUT', payload: input(0, {action: 'keep'}, config)})).status, 200);
  await f.request();
  assert.equal(requests, 0);
  const self = {...config, baseUrl: `${f.server.url}/v1`};
  assert.equal((await f.request(undefined, {method: 'PUT', payload: input(1, {action: 'keep'}, self)})).status, 400);
  assert.equal((await f.request()).body.data.configuration.baseUrl, config.baseUrl);
  assert.equal((await f.request(undefined, {method: 'PUT', payload: input(1, {action: 'keep'}, {...config, protocol: 'responses'})})).status, 200);
  assert.equal(requests, 0, 'a protocol change does not probe either transport');
});

test('HTTP projects legacy metadata without rewriting and rejects old clients after an explicit Responses save', async t => {
  const {protocol, ...legacy} = DEFAULT_AGENT_CONFIGURATION;
  const bytes = JSON.stringify({version: 1, revision: 9, configuration: legacy, secret: null}, null, 2) + '\n';
  const f = await fixture(t, {prepare: async root => {
    await mkdir(path.join(root, 'agent-settings'), {mode: 0o700});
    await writeFile(path.join(root, 'agent-settings/settings.json'), bytes, {mode: 0o600});
  }});
  const file = path.join(f.root, 'agent-settings/settings.json');
  const initial = await f.request();
  assert.equal(initial.status, 200); assert.equal(initial.body.data.revision, 9);
  assert.equal(initial.body.data.configuration.protocol, 'chat_completions');
  assert.equal(await readFile(file, 'utf8'), bytes);
  const configuration = {...DEFAULT_AGENT_CONFIGURATION, protocol: 'responses'};
  const saved = await f.request(undefined, {method: 'PUT', payload: input(9, {action: 'replace', storage: 'session', value: 'SYNTHETIC_HTTP_MIGRATION_KEY'}, configuration)});
  assert.equal(saved.status, 200); assert.equal(saved.body.data.revision, 10);
  assert.equal(saved.body.data.configuration.protocol, 'responses');
  assert.equal(saved.body.data.secret.configured, true);
  const committed = await readFile(file, 'utf8');
  assert.equal(JSON.parse(committed).version, 2);
  const oldClient = await f.request(undefined, {method: 'PUT', payload: input(10, {action: 'remove'}, legacy)});
  assert.equal(oldClient.status, 400); assert.equal(oldClient.body.error.code, 'AGENT_SETTINGS_VALIDATION');
  const staleProtocol = await f.request(undefined, {method: 'PUT', payload: input(9, {action: 'remove'}, {...DEFAULT_AGENT_CONFIGURATION})});
  assert.equal(staleProtocol.status, 409); assert.equal(staleProtocol.body.error.code, 'AGENT_SETTINGS_CONFLICT');
  assert.deepEqual((await f.request()).body, saved.body);
  assert.equal(await readFile(file, 'utf8'), committed);
  await f.restart();
  const restarted = (await f.request()).body.data;
  assert.equal(restarted.revision, 10); assert.equal(restarted.configuration.protocol, 'responses'); assert.equal(restarted.secret.configured, false);
});

test('corrupt settings are isolated from server startup and unrelated project operations', async t => {
  const f = await fixture(t, {prepare: async root => {
    await mkdir(path.join(root, 'agent-settings'), {mode: 0o700});
    await writeFile(path.join(root, 'agent-settings/settings.json'), '{synthetic-corruption', {mode: 0o600});
  }});
  assert.equal((await f.request('/health', {authenticated: false})).status, 200);
  const response = await f.request();
  assert.equal(response.status, 503); assert.equal(response.body.error.code, 'AGENT_SETTINGS_CORRUPT');
  assert.equal(JSON.stringify(response.body).includes('synthetic-corruption'), false);
  assert.equal((await f.request('/api/rpc', {method: 'POST', payload: {operation: 'project.create', input: {name: 'Editing still works'}}})).status, 200);
});

test('HTTP output allowlist and failure serialization never expose trusted-store hidden values', async t => {
  const hidden = 'SYNTHETIC_HIDDEN_STORE_VALUE';
  const engine = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const agentSettings = {get: async () => ({...await engine.get(), encrypted: hidden, value: hidden}), put: async () => { throw Object.assign(Error(hidden), {code: '__proto__', details: {value: hidden}}); }};
  const f = await fixture(t, {agentSettings});
  const read = await f.request();
  assert.equal(read.status, 200); assert.equal(JSON.stringify(read.body).includes(hidden), false);
  const write = await f.request(undefined, {method: 'PUT', payload: input()});
  assert.equal(write.status, 503); assert.equal(write.body.error.code, 'AGENT_SETTINGS_SAVE_FAILED');
  assert.equal(JSON.stringify(write.body).includes(hidden), false);
});
