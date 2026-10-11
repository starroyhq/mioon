import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.js';

const repo = fileURLToPath(new URL('..', import.meta.url)), token = 'synthetic-workspace-preferences-test-token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => { const value = defaultWorkspaceState(); delete value.shared.assetSearch; return value; };
function environment(extra = {}) {
  const env = {...process.env};
  for (const name of Object.keys(env)) if (/^(MIOON_|MIOON_|ARK_|VEO_|RUNWAY|MINIMAX_|VIDU_|GEMINI_|GOOGLE_)/.test(name)) delete env[name];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}
async function backend(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-preferences-http-'));
  let child, url;
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const ended = once(child, 'exit'); child.kill(signal);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  async function start() {
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.mjs')], {cwd: repo, env: environment({MIOON_DATA_DIR: root, MIOON_TOKEN: token, PORT: '0'}), stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk); child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, stderr);
      const ready = /Mioon ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (ready) { url = ready[1]; assert.equal((await fetch(url + '/health')).status, 200); return child.pid; }
      await pause(25);
    }
    throw Error(stderr || 'Backend did not start');
  }
  const f = {root, get url() { return url; }, get pid() { return child.pid; }, restart: async signal => { await stop(signal); return start(); },
    async request(route, {method = 'GET', input, raw, authenticated = true, headers = {}} = {}) {
      const response = await fetch(url + route, {method, headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers}, ...(input !== undefined || raw !== undefined ? {body: raw ?? JSON.stringify(input)} : {})});
      return {status: response.status, headers: response.headers, body: await response.json()};
    },
    async rpc(operation, input = {}) {
      const response = await this.request('/api/rpc', {method: 'POST', input: {operation, input}});
      assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
    },
    inspect() {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return Object.fromEntries(['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'reference_requests', 'idempotency', 'job_events'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
      finally { db.close(); }
    },
  };
  t.after(async () => { await stop(); await rm(root, {recursive: true, force: true}); });
  await start(); return f;
}

test('dedicated preferences HTTP survives a real killed/restarted backend and leaves project/history unchanged', {timeout: 30000}, async t => {
  const f = await backend(t), project = await f.rpc('project.create', {name: 'Synthetic durable view'}), projectId = project.id;
  const route = `/api/workspace-preferences/${projectId}`;
  await f.rpc('shot.create', {projectId, title: 'Business shot', prompt: 'Keep business content intact'});
  const timeline = await f.rpc('timeline.get', {projectId});
  await f.rpc('timeline.track.add', {projectId, expectedRevision: timeline.revision, requestId: randomUUID(), kind: 'audio', name: 'Persistent history'});
  const businessBefore = await f.rpc('project.get', {projectId}), bytesBefore = f.inspect();
  const initial = await f.request(route);
  assert.equal(initial.status, 200); assert.deepEqual(initial.body, {ok: true, data: {projectId, revision: 0, state: null}});
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const value = state(); value.activeMode = 'editing'; value.canvas.viewport = {x: -350, y: 250, zoom: 1.25};
  value.canvas.selectedId = businessBefore.shots[0].id; value.canvas.selectedEdgeId = randomUUID(); value.canvas.highlightedVersionId = randomUUID();
  value.canvas.storyboardOpen = true; value.canvas.miniMap = true; value.canvas.inspectorTab = 'versions';
  value.editing = {selectedClipId: randomUUID(), quickAssetId: randomUUID(), previewKind: 'source', playhead: 92, pixelsPerSecond: 156, scrollLeft: 800, scrollTop: 120, timelineCollapsed: true, snappingEnabled: false};
  value.shared = {assetFilter: 'audio', assetsCollapsed: true, inspectorCollapsed: true};
  value.layout.canvas = {assetsWidth: 450, inspectorWidth: 500, assetsCollapsed: false, inspectorCollapsed: true};
  value.layout.editing = {assetsWidth: 215, inspectorWidth: 280, assetsCollapsed: true, inspectorCollapsed: false, timelineHeight: 560};
  const payload = {expectedRevision: 0, state: value};
  const saved = await f.request(route, {method: 'PUT', input: payload});
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.data, {projectId, revision: 1, state: value});
  assert.deepEqual(f.inspect(), bytesBefore);
  const pid = f.pid; assert.notEqual(await f.restart('SIGKILL'), pid);
  assert.deepEqual((await f.request(route)).body, saved.body);
  assert.deepEqual((await f.request(route, {method: 'PUT', input: payload})).body, saved.body, 'lost-response retry survives restart without another revision');
  const stale = await f.request(route, {method: 'PUT', input: {expectedRevision: 0, state: state()}});
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'PREFERENCES_CONFLICT'); assert.equal(stale.body.error.details.currentRevision, 1);
  assert.equal(stale.body.error.retryable, false);
  assert.deepEqual(f.inspect(), bytesBefore); assert.deepEqual(await f.rpc('project.get', {projectId}), businessBefore);
  const other = await f.rpc('project.create', {name: 'Isolated preferences'});
  assert.deepEqual((await f.request(`/api/workspace-preferences/${other.id}`)).body.data, {projectId: other.id, revision: 0, state: null});
  const candidates = [10, 20, 30, 40].map(playhead => { const s = state(); s.editing.playhead = playhead; return s; });
  const outcomes = await Promise.all(candidates.map(s => f.request(route, {method: 'PUT', input: {expectedRevision: 1, state: s}})));
  assert.equal(outcomes.filter(result => result.status === 200).length, 1);
  for (const result of outcomes.filter(result => result.status !== 200)) { assert.equal(result.status, 409); assert.equal(result.body.error.code, 'PREFERENCES_CONFLICT'); assert.equal(result.body.error.details.currentRevision, 2); }
  assert.equal((await f.request(route)).body.data.revision, 2);
  const final = state(); final.editing.playhead = 200;
  const retries = await Promise.all(Array.from({length: 4}, () => f.request(route, {method: 'PUT', input: {expectedRevision: 2, state: final}})));
  for (const result of retries) { assert.equal(result.status, 200); assert.equal(result.body.data.revision, 3); }
});

test('preferences endpoint retains token/cookie authentication, strict origin/host validation and the 16 KiB body cap', {timeout: 30000}, async t => {
  const f = await backend(t), projectId = (await f.rpc('project.create', {name: 'Synthetic HTTP security'})).id, route = `/api/workspace-preferences/${projectId}`;
  const input = {expectedRevision: 0, state: state()};
  for (const method of ['GET', 'PUT']) {
    const options = {method, ...(method === 'PUT' ? {input} : {})};
    for (const headers of [{}, {authorization: 'Bearer wrong'}]) {
      const result = await f.request(route, {...options, authenticated: false, headers});
      assert.equal(result.status, 401); assert.equal(result.body.error.code, 'UNAUTHORIZED');
    }
    for (const headers of [{origin: 'https://untrusted.example'}, {origin: 'null'}]) {
      const result = await f.request(route, {...options, headers});
      assert.equal(result.status, 403); assert.equal(result.body.error.code, 'ORIGIN_REJECTED');
    }
  }
  const rejectedHost = await new Promise((resolve, reject) => {
    const request = http.get(f.url + route, {headers: {host: 'untrusted.example', authorization: `Bearer ${token}`}}, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rejectedHost, 403);
  const login = await f.request('/api/login', {method: 'POST', authenticated: false, input: {token}});
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request(route, {authenticated: false, headers: {cookie, origin: f.url}})).status, 200);
  const saved = await f.request(route, {method: 'PUT', input, authenticated: false, headers: {cookie, origin: f.url}});
  assert.equal(saved.status, 200); assert.equal(saved.body.data.revision, 1);
  assert.equal((await f.request(route, {method: 'POST', input})).status, 405);
  const rejected = [
    {raw: '{'}, {raw: JSON.stringify(input).replace('"playhead":0', '"playhead":1e400')},
    {input: {...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1}},
    {input: {...input, state: {...input.state, token: 'sensitive-value-must-not-persist'}}},
    {input: {...input, state: {...input.state, shared: {...input.state.shared, assetSearch: 'local-only search'}}}},
    {input: {...input, state: {...input.state, editing: {...input.state.editing, snappingEnabled: 'false'}}}},
    {input: {...input, state: {...input.state, layout: null}}},
    {input: {...input, state: {...input.state, layout: {canvas: input.state.layout.canvas}}}},
    {input: {...input, state: {...input.state, layout: {...input.state.layout, canvas: {...input.state.layout.canvas, assetsWidth: 481}}}}},
    {input: {...input, state: {...input.state, layout: {...input.state.layout, editing: {...input.state.layout.editing, timelineHeight: 159}}}}},
    {input: {...input, state: {...input.state, layout: {...input.state.layout, editing: {...input.state.layout.editing, inspectorCollapsed: 'false'}}}}},
    {raw: JSON.stringify(input).replace('"shared":{', '"shared":{"__proto__":{},')},
    {input: {...input, state: null}},
  ];
  for (const options of rejected) {
    const result = await f.request(route, {method: 'PUT', ...options});
    assert.equal(result.status, 400, JSON.stringify(result.body));
  }
  const tooLarge = await f.request(route, {method: 'PUT', raw: JSON.stringify(input) + ' '.repeat(16 * 1024)});
  assert.equal(tooLarge.status, 413);
  assert.deepEqual((await f.request(route)).body, saved.body);
  for (const invalid of ['not-a-uuid', 'x'.repeat(200), '%2F', '%ZZ']) assert.equal((await f.request(`/api/workspace-preferences/${invalid}`)).status, 400);
  const missing = `/api/workspace-preferences/${randomUUID()}`;
  assert.equal((await f.request(missing)).status, 404);
  assert.equal((await f.request(missing, {method: 'PUT', input})).status, 404);
  for (const operation of ['workspace.preferences.get', 'workspace.preferences.put']) {
    const result = await f.request('/api/rpc', {method: 'POST', input: {operation, input: {projectId}}});
    assert.equal(result.status, 404); assert.equal(result.body.error.code, 'UNKNOWN_OPERATION');
  }
  const responseText = JSON.stringify((await f.request(route)).body);
  for (const privateText of [token, 'sensitive-value-must-not-persist', 'local-only search']) assert.ok(!responseText.includes(privateText));
});

test('official MCP discovery and calls cannot reach renderer workspace preferences', {timeout: 20000}, async t => {
  const client = new Client({name: 'workspace-preferences-boundary-test', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(), stderr: 'pipe'});
  transport.stderr?.resume(); t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some(tool => /preference|workspace/.test(tool.name)));
  for (const name of ['workspace_preferences_get', 'workspace_preferences_put']) {
    const result = await client.callTool({name, arguments: {projectId: randomUUID()}});
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'UNKNOWN_OPERATION');
  }
});
