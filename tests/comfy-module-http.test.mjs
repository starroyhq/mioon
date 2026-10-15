import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Readable} from 'node:stream';
import {createComfyHttp} from '../apps/server/src/comfy-http.mjs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.mjs';
import {operationDefinition, EXIT_CODES} from '../packages/client/src/index.mjs';
import {COMFY_IMAGE_OPTIONS, DEFAULT_COMFY_IMAGE_CONFIGURATION, comfyImageSettingsResultSchema} from '../packages/contracts/src/comfy-images.mjs';
import {startComfyFixture, COMFY_FIXTURE_MODEL} from './helpers/comfy-http-fixture.mjs';
import {availability, imageRows, until} from './helpers/comfy-module-fixture.mjs';

const token = 'synthetic-optional-comfy-http-access-token';
const modes = {load: 'available', skip: 'not_loaded', 'not-provided': 'not_provided'};
const repo = fileURLToPath(new URL('..', import.meta.url));
const cliEnvironment = f => ({...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'SYSTEMROOT', 'COMSPEC']
  .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
  TZ: 'UTC', MIOON_BASE_URL: f.server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'});
async function cli(f, operation, input) {
  // Feature-specific invocation against this test's owned ephemeral backend.
  // No doctor, startup measurement, native QA workspace, or external service.
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), 'rpc', operation, '--input', JSON.stringify(input)],
    {cwd: repo, env: cliEnvironment(f), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  let result;
  try { result = await once(child, 'close'); } finally { clearTimeout(deadline); }
  assert.equal(result[1], null, stderr);
  for (const text of [stdout, stderr]) assert.ok(!text.includes(token) && !text.includes(f.root), 'CLI must not expose credentials or workspace paths');
  return {code: result[0], envelope: JSON.parse(stdout)};
}
function retainedRows(f) {
  const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'), {readOnly: true});
  try { return imageRows({db}); } finally { db.close(); }
}
async function fixture(t, {mode, comfyNetwork} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-comfy-module-http-'));
  let server;
  t.after(async () => { await server?.close(); await rm(root, {recursive: true, force: true}); });
  const start = selected => startServer({dataDir: root, port: 0, token, ...(selected === undefined ? {} : {comfyModule: selected}), ...(comfyNetwork ? {comfyNetwork} : {})});
  server = await start(mode);
  const f = {root, get server() { return server; },
    async request(route, {method = 'GET', input, authenticated = true, headers = {}} = {}) {
      const response = await fetch(server.url + route, {method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {'Content-Type': 'application/json', ...(authenticated ? {Authorization: `Bearer ${token}`} : {}), ...headers},
        ...(input === undefined ? {} : {body: JSON.stringify(input)})});
      const text = await response.text();
      assert.ok(!text.includes(root) && !text.includes(token), 'public HTTP response must not expose storage paths or credentials');
      return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
    },
    async rpc(operation, input = {}) { const result = await f.request('/api/rpc', {method: 'POST', input: {operation, input}});
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true); return result.body.data; },
    async approve(review) { const result = await f.request('/api/images/reviews/approve', {method: 'POST', input: {projectId: review.projectId, reviewId: review.id, expectedRevision: 1}});
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; },
    task: ack => f.rpc('image.task.get', {projectId: ack.projectId, taskId: ack.id}),
    remote: ack => f.rpc('image.task.remote.get', {projectId: ack.projectId, taskId: ack.id}),
    async reopen(selected) { await server.close(); server = await start(selected); },
  };
  return f;
}
const inputFor = projectId => ({projectId, requestId: randomUUID(), name: 'Synthetic optional Comfy image', providerId: 'comfy-local',
  model: COMFY_FIXTURE_MODEL, prompt: 'Exact synthetic local-only retained image.', options: COMFY_IMAGE_OPTIONS});
async function configured(f, comfy) {
  const check = await f.request('/api/images/comfy-check', {method: 'POST', input: {baseUrl: comfy.baseUrl}});
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const configuration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: comfy.baseUrl, model: COMFY_FIXTURE_MODEL};
  const result = await f.request('/api/images/comfy-settings', {method: 'PUT', input: {expectedRevision: 0, configuration}});
  assert.equal(result.status, 200); assert.equal(result.body.data.readiness.checked, true); return result.body.data;
}

test('actual HTTP Comfy availability is fixed, minimal and behind existing bearer/session/Origin/Host gates', async t => {
  for (const mode of ['load', 'skip', 'not-provided']) await t.test(mode, async t => {
    let networkCalls = 0;
    const f = await fixture(t, {mode, comfyNetwork: {httpRequest() { networkCalls++; throw Error('No transport should be reached'); }}});
    const route = '/api/images/comfy-availability';
    assert.equal((await f.request(route, {authenticated: false})).status, 401);
    assert.equal((await f.request(route, {headers: {Origin: 'http://attacker.invalid'}})).status, 403);
    const forgedHost = await new Promise((resolve, reject) => {
      const request = http.request(f.server.url + route, {headers: {Authorization: `Bearer ${token}`, Host: 'attacker.invalid'}}, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      }); request.on('error', reject); request.end();
    });
    assert.equal(forgedHost, 403);
    const result = await f.request(route);
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body, {ok: true, data: availability(modes[mode])});
    const login = await f.request('/api/login', {method: 'POST', authenticated: false, input: {token}});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.deepEqual((await f.request(route, {authenticated: false, headers: {Cookie: cookie, Origin: f.server.url}})).body, result.body);
    const badMethod = await f.request(route, {method: 'POST', input: {comfyModule: 'load'}});
    assert.equal(badMethod.status, 405); assert.equal(badMethod.headers.get('allow'), 'GET');
    assert.equal((await f.request(`${route}?comfyModule=load`)).status, 400);
    const settings = await f.request('/api/images/comfy-settings');
    assert.deepEqual(settings.body.data, {revision: 0, configuration: DEFAULT_COMFY_IMAGE_CONFIGURATION, readiness: {checked: false, checkedAt: null}});
    assert.equal(comfyImageSettingsResultSchema.safeParse(settings.body.data).success, true);
    const configuration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'http://127.0.0.1:8188', model: COMFY_FIXTURE_MODEL};
    const saved = await f.request('/api/images/comfy-settings', {method: 'PUT', input: {expectedRevision: 0, configuration}});
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data, {revision: 1, configuration, readiness: {checked: false, checkedAt: null}});
    assert.deepEqual((await f.request(route)).body, result.body, 'saving enabled settings cannot load the module');
    assert.equal(networkCalls, 0);
    if (mode !== 'load') {
      const before = await readFile(path.join(f.root, 'comfy-settings', 'settings.json'));
      const checked = await f.request('/api/images/comfy-check', {method: 'POST', input: {baseUrl: configuration.baseUrl}});
      assert.equal(checked.status, 503); assert.equal(checked.body.error.code, 'COMFY_MODULE_UNAVAILABLE');
      assert.equal(checked.body.error.retryable, false);
      assert.deepEqual(await readFile(path.join(f.root, 'comfy-settings', 'settings.json')), before);
      assert.deepEqual((await f.request('/api/images/comfy-settings')).body, saved.body);
      assert.deepEqual((await f.request(route)).body, result.body);
      assert.equal(networkCalls, 0);
    }
  });
});

test('default server keeps Comfy available and omitted module keeps exact receipts and managed media readable over HTTP', async t => {
  const comfy = await startComfyFixture(); t.after(() => comfy.close());
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/images/comfy-availability')).body.data, availability('available'));
  await configured(f, comfy);
  const project = await f.rpc('project.create', {name: 'Retained optional Comfy history'}), input = inputFor(project.id);
  const review = await f.rpc('image.review.prepare', {input, settingsRevision: 1}), ack = await f.approve(review);
  await until(() => f.task(ack), task => task.state === 'receiving');
  const remote = await f.remote(ack), observation = {projectId: project.id, taskId: ack.id, requestId: randomUUID(), expectedRevision: remote.remote.revision};
  const observed = await f.rpc('image.task.observeRemote', observation);
  const finished = await until(() => f.task(ack), task => task.state === 'succeeded');
  await until(() => f.remote(ack), value => value.observation?.state === 'finished');
  const savedReview = await f.rpc('image.review.prepare', {input, settingsRevision: 1});
  const versions = await f.rpc('image.version.list', {projectId: project.id, groupId: ack.groupId});
  const settingsFile = await readFile(path.join(f.root, 'comfy-settings', 'settings.json'));
  const counts = comfy.counts();
  for (const mode of ['skip', 'not-provided']) {
    await f.reopen(mode);
    assert.deepEqual((await f.request('/api/images/comfy-availability')).body.data, availability(modes[mode]));
    assert.deepEqual(await readFile(path.join(f.root, 'comfy-settings', 'settings.json')), settingsFile);
    assert.deepEqual(await f.rpc('image.generate', input), ack);
    assert.deepEqual(await f.rpc('image.review.prepare', {input, settingsRevision: 1}), savedReview);
    assert.deepEqual(await f.approve(review), ack);
    assert.deepEqual(await f.rpc('image.task.observeRemote', observation), observed);
    const beforeCli = retainedRows(f);
    assert.deepEqual(await cli(f, 'image.generate', input), {code: EXIT_CODES.success, envelope: {ok: true, data: ack}});
    assert.deepEqual(await cli(f, 'image.task.observeRemote', observation), {code: EXIT_CODES.success, envelope: {ok: true, data: observed}});
    assert.deepEqual(retainedRows(f), beforeCli, 'CLI receipt replay must not rewrite any retained image row');
    assert.deepEqual(await f.task(ack), finished);
    assert.deepEqual(await f.rpc('image.version.list', {projectId: project.id, groupId: ack.groupId}), versions);
    const media = await fetch(`${f.server.url}/media/${versions.items[0].assetId}`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000)});
    assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), comfy.png);
    const fresh = inputFor(project.id);
    for (const [operation, request] of [['image.generate', fresh], ['image.review.prepare', {input: fresh, settingsRevision: 1}]]) {
      const denied = await f.request('/api/rpc', {method: 'POST', input: {operation, input: request}});
      assert.equal(denied.status, 503, JSON.stringify(denied.body)); assert.equal(denied.body.error.code, 'COMFY_MODULE_UNAVAILABLE');
    }
    const beforeCliRefusal = retainedRows(f);
    const refused = await cli(f, 'image.review.prepare', {input: inputFor(project.id), settingsRevision: 1});
    assert.equal(refused.code, EXIT_CODES.unavailable);
    assert.equal(refused.envelope.ok, false); assert.equal(refused.envelope.error.code, 'COMFY_MODULE_UNAVAILABLE');
    assert.deepEqual(retainedRows(f), beforeCliRefusal, 'CLI refusal must create no review, task, request receipt or observation');
    assert.deepEqual(comfy.counts(), counts, 'reading and replay after omission must not submit or observe remotely');
  }
  assert.deepEqual(comfy.errors, []);
});

test('omitting Comfy preserves official MCP discovery and CLI refusal but grants no settings, approval or module-loading capability', async t => {
  let networkCalls = 0;
  const f = await fixture(t, {mode: 'not-provided', comfyNetwork: {httpRequest() { networkCalls++; throw Error('Unexpected connector I/O'); }}});
  const project = await f.rpc('project.create', {name: 'Optional MCP discovery'});
  const beforeCli = retainedRows(f);
  const refused = await cli(f, 'image.review.prepare', {input: inputFor(project.id), settingsRevision: 1});
  assert.equal(refused.code, EXIT_CODES.unavailable);
  assert.equal(refused.envelope.ok, false); assert.equal(refused.envelope.error.code, 'COMFY_MODULE_UNAVAILABLE');
  assert.deepEqual(retainedRows(f), beforeCli, 'unavailable CLI preparation must create no review, task or request receipt');
  assert.equal(networkCalls, 0);
  const client = new Client({name: 'synthetic-optional-comfy-acceptance', version: '1.0.0'}, {capabilities: {}});
  const clean = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'SYSTEMROOT', 'COMSPEC'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo,
    env: {...clean, TZ: 'UTC', MIOON_BASE_URL: f.server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'}, stderr: 'pipe'});
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const operation of ['image.generate', 'image.review.prepare', 'image.review.get', 'image.task.remote.get', 'image.task.observeRemote']) {
    const actual = tools.find(tool => tool.name === operationDefinition(operation).toolName);
    assert.ok(actual, operation); assert.deepEqual(actual.inputSchema, operationDefinition(operation).inputSchema);
  }
  assert.ok(!tools.some(tool => /comfy.*(?:settings|check|availability|module)|image_review_approve/i.test(tool.name)));
  const result = await client.callTool({name: operationDefinition('image.review.prepare').toolName, arguments: {input: inputFor(project.id), settingsRevision: 1}});
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'COMFY_MODULE_UNAVAILABLE');
  const injected = await client.callTool({name: operationDefinition('image.review.prepare').toolName, arguments: {input: inputFor(project.id), settingsRevision: 1, comfyModule: 'load'}});
  assert.equal(injected.isError, true); assert.equal(injected.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.deepEqual((await f.request('/api/images/comfy-availability')).body.data, availability('not_provided'));
  assert.equal(networkCalls, 0);
});


test('missing-module check refuses before invalidating any retained advisory readiness', async () => {
  const configuration = {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'http://127.0.0.1:8188', model: COMFY_FIXTURE_MODEL};
  const existing = {revision: 1, configuration, readiness: {checked: true, checkedAt: '2026-10-15T00:00:00.000Z'}};
  for (const state of ['not_provided', 'not_loaded']) {
    let writes = 0;
    const settings = {get: async () => structuredClone(existing), clearCheck() { writes++; }, recordCheck() { writes++; }, put() { writes++; }};
    const route = createComfyHttp({settings, availability: availability(state)});
    const request = Readable.from([Buffer.from(JSON.stringify({baseUrl: configuration.baseUrl}))]);
    request.url = '/api/images/comfy-check'; request.method = 'POST'; request.headers = {'content-type': 'application/json'};
    const response = new EventEmitter(); let status, body;
    Object.assign(response, {setHeader() {}, writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); response.writableEnded = true; response.writableFinished = true; }});
    assert.equal(await route(request, response, new URL(request.url, 'http://127.0.0.1:4318')), true);
    assert.equal(status, 503); assert.equal(body.error.code, 'COMFY_MODULE_UNAVAILABLE');
    assert.equal(writes, 0, 'absence must be checked before clearCheck or any settings mutation');
    assert.deepEqual(await settings.get(), existing);
  }
});
