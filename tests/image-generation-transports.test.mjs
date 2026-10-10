import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry} from '../packages/business/src/provider-registry.mjs';
import {createClient} from '../packages/client/src/index.mjs';
import {IMAGE_FIXED_OPTIONS, IMAGE_LIMITS, IMAGE_MODELS, IMAGE_MUTATION_OPERATIONS, imageSchemas,
  isImageTaskResponse, isImageProfilesResponse, isImageRequestResponse,
  isImageListResponse} from '../packages/contracts/src/images.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'image-transport-synthetic-local-token';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const toolName = operation => operation.replaceAll('.', '_');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputFor = (projectId, changes = {}) => ({projectId, name: 'Synthetic image',
  providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'A synthetic image transport fixture.',
  options: {...IMAGE_FIXED_OPTIONS}, requestId: randomUUID(), ...changes});

// No inherited provider credential, activation flag, custom endpoint or proxy is
// passed to these owned synthetic processes. Only loopback HTTP is exercised.
function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GEMINI_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await ended; } finally { clearTimeout(timer); }
}

function noPrivate(value, root) {
  const text = JSON.stringify(value);
  assert.ok(Buffer.byteLength(text) <= IMAGE_LIMITS.responseBytes + 64, 'public image envelope remains bounded');
  assert.ok(!text.includes(token) && !text.includes(root), 'public DTO omits credentials and local storage paths');
  function walk(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      assert.ok(!/^(?:dataBase64|b64_json|bytes|path|relativePath|stagedReceipt|canonicalInput|snapshot|apiKey|api_key|authorization|secret|token)$/i.test(key), `public image DTO excludes ${key}`);
      walk(child);
    }
  }
  walk(value);
}

async function cli(args, env, expectedError) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), ...args], {
    cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  let code, signal;
  try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timer); }
  assert.equal(signal, null, stderr);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI prints exactly one JSON envelope');
  assert.ok(!stdout.includes(token) && !stderr.includes(token));
  const result = JSON.parse(stdout);
  assert.equal(result.ok, !expectedError, stdout + stderr);
  if (expectedError) { assert.equal(result.error.code, expectedError); assert.notEqual(code, 0); }
  else assert.equal(code, 0, stderr);
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-wire-'));
  const store = openStore(root);
  let project, other, queued, dispatched;
  try {
    const services = createServices(store, createProviderRegistry({db: store.db, root, env: {}}),
      {env: {}, imageOptions: {autoRun: false}});
    project = await services.call('project.create', {name: 'Image transport acceptance'});
    other = await services.call('project.create', {name: 'Foreign image project'});
    queued = await services.call('image.generate', inputFor(project.id, {name: 'Before-dispatch restart fixture'}));
    dispatched = await services.call('image.generate', inputFor(project.id, {name: 'Dispatched restart fixture'}));
    // A synthetic dispatch fence with no durable output, never a real request.
    store.db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=revision+1 WHERE id=?").run(dispatched.id);
    await services.drain();
  } finally { store.close(); }

  let child, db, url, port = 0, proxy, proxyUrl, dropped, dropNext = false;
  let stderr = '', stdout = '';
  const proxyRequests = [];
  async function start() {
    stdout = ''; stderr = '';
    child = spawn(process.execPath, [path.join(repo, 'apps/server/src/cli.mjs')], {
      cwd: repo, env: environment({MIOON_DATA_DIR: root, MIOON_TOKEN: token, PORT: String(port)}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, stdout + stderr);
      assert.equal(child.signalCode, null, stdout + stderr);
      url = /Mioon ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
      if (url) { port = Number(new URL(url).port); return; }
      await pause(20);
    }
    throw Error('Owned image backend did not start: ' + stdout + stderr);
  }
  t.after(async () => {
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    db?.close(); await stopOwned(child); await rm(root, {recursive: true, force: true});
  });
  await start();
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const snapshot = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))]));
  const checkpoint = () => ({rows: snapshot(), version: db.prepare('PRAGMA data_version').get().data_version});
  const unchanged = (before, label) => {
    assert.deepEqual(snapshot(), before.rows, label + ': no persisted row changed');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version, label + ': no write transaction committed');
  };
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const operation = JSON.parse(body).operation;
      proxyRequests.push(operation);
      const upstream = await fetch(url + '/api/rpc', {method: 'POST', redirect: 'error',
        headers: {'content-type': 'application/json', authorization: request.headers.authorization}, body,
        signal: AbortSignal.timeout(10_000)});
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (dropNext && operation === 'image.generate') {
        dropNext = false; dropped = JSON.parse(bytes); response.destroy(); return;
      }
      response.writeHead(upstream.status, {'content-type': 'application/json'}); response.end(bytes);
    } catch { response.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  async function rpc(operation, input = {}, error, base = url) {
    const response = await fetch(base + '/api/rpc', {method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({operation, input}), signal: AbortSignal.timeout(10_000)});
    const result = await response.json();
    assert.equal(result.ok, !error, JSON.stringify(result));
    if (error) assert.equal(result.error.code, error);
    else assert.equal(response.status, 200, JSON.stringify(result));
    noPrivate(result, root);
    return result;
  }
  async function succeeded(id) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const task = (await rpc('image.task.get', {projectId: project.id, taskId: id})).data;
      assert.ok(isImageTaskResponse(task));
      if (task.state === 'succeeded') return task;
      assert.ok(['queued', 'dispatching', 'receiving', 'persisting'].includes(task.state), JSON.stringify(task));
      await pause(20);
    }
    throw Error('Mock image did not complete');
  }
  return {root, project, other, queued, dispatched, rpc, succeeded, checkpoint, unchanged,
    get url() { return url; }, get proxyUrl() { return proxyUrl; }, get dropped() { return dropped; }, proxyRequests,
    get env() { return {MIOON_BASE_URL: url, MIOON_TOKEN: token}; },
    dropAcknowledgement() { dropNext = true; },
    async restart() { db.close(); db = null; await stopOwned(child); await start(); db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true}); },
  };
}

async function mcpFixture(t, env) {
  const client = new Client({name: 'image-transport-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(env), stderr: 'pipe'});
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'mioon');
  return {client, async call(operation, input = {}, error) {
    const result = await client.callTool({name: operation.startsWith('mioon_') ? operation : toolName(operation), arguments: input});
    const blocks = result.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1);
    const envelope = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(error), blocks[0].text);
    assert.equal(envelope.ok, !error, blocks[0].text);
    if (error) assert.equal(envelope.error.code, error);
    assert.ok(!JSON.stringify(result).includes(token) && !stderr.includes(token));
    return envelope;
  }};
}

// One sequential fixture: one backend, one SDK bridge and at most one CLI child.
// PNG generation is local/in-process; no paid provider or media subprocess runs.
test('image generation uses one durable contract across real HTTP, CLI and official MCP', {timeout: 120_000}, async t => {
  const f = await fixture(t);
  let mcp = await mcpFixture(t, f.env);
  const command = (operation, input = {}, error) => cli([...operation.split('.'), '--input', JSON.stringify(input)], f.env, error);
  async function parity(operation, input = {}, error) {
    const response = await f.rpc(operation, input, error);
    assert.deepEqual(await command(operation, input, error), response, operation + ': CLI parity');
    assert.deepEqual(await mcp.call(operation, input, error), response, operation + ': official MCP parity');
    return response;
  }

  await t.test('discovery has strict matching schemas/effects and keeps built-in Agent catalogs unchanged', async () => {
    const before = f.checkpoint();
    const catalog = (await cli(['schema'], {})).data;
    assert.deepEqual((await mcp.call('mioon_schema')).data, catalog);
    const tools = (await mcp.client.listTools()).tools;
    for (const operation of Object.keys(imageSchemas)) {
      const definition = catalog.operations.find(item => item.operation === operation);
      assert.ok(definition, operation + ' is discoverable');
      const tool = tools.find(item => item.name === toolName(operation));
      assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.requiresRequestId, IMAGE_MUTATION_OPERATIONS.includes(operation) || operation === 'image.request.get');
      const effects = definition.effects;
      assert.equal(effects.idempotent, true);
      assert.equal(effects.readOnly, !IMAGE_MUTATION_OPERATIONS.includes(operation));
      for (const flag of ['externalIO', 'localProcess', 'paidGeneration', 'openWorld']) assert.equal(effects[flag], false);
      assert.deepEqual(tool.annotations, {readOnlyHint: effects.readOnly, destructiveHint: effects.destructive,
        idempotentHint: effects.idempotent, openWorldHint: effects.openWorld});
    }
    const profiles = (await parity('image.profile.list')).data;
    assert.ok(isImageProfilesResponse(profiles));
    assert.equal(profiles.liveEnabled, false);
    assert.equal(profiles.items.find(item => item.providerId === 'mock').enabled, true);
    assert.equal(profiles.items.find(item => item.providerId === 'openai').enabled, false);
    assert.deepEqual(READ_TOOL_DEFINITIONS.map(item => item.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
    assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(item => item.name), ['mioon_propose_shot_update']);
    f.unchanged(before, 'schema/profile discovery');
  });

  await t.test('startup never dispatches retained queued or ambiguous work; cancellation is explicit and replayable', async () => {
    const queued = (await parity('image.task.get', {projectId: f.project.id, taskId: f.queued.id})).data;
    assert.equal(queued.state, 'interrupted_before_dispatch'); assert.equal(queued.dispatched, false);
    const unknown = (await parity('image.task.get', {projectId: f.project.id, taskId: f.dispatched.id})).data;
    assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.dispatched, true);
    const before = f.checkpoint();
    await pause(100);
    await parity('image.task.list', {projectId: f.project.id});
    await parity('image.request.get', {projectId: f.project.id, requestId: f.queued.requestId});
    await parity('image.task.cancelQueued', {projectId: f.project.id, taskId: unknown.id,
      expectedRevision: unknown.revision, requestId: randomUUID()}, 'IMAGE_STATE_CONFLICT');
    await parity('image.task.recoverResult', {projectId: f.project.id, taskId: unknown.id,
      expectedRevision: unknown.revision, requestId: randomUUID()}, 'IMAGE_RESULT_INVALID');
    f.unchanged(before, 'reading or refusing ambiguous work');
    const cancel = {projectId: f.project.id, taskId: queued.id, expectedRevision: queued.revision, requestId: randomUUID()};
    const cancelled = (await parity('image.task.cancelQueued', cancel)).data;
    assert.equal(cancelled.state, 'cancelled_before_dispatch'); assert.equal(cancelled.dispatched, false);
    assert.deepEqual((await parity('image.request.get', {projectId: f.project.id, requestId: cancel.requestId})).data,
      {projectId: f.project.id, requestId: cancel.requestId, operation: 'image.task.cancelQueued', response: cancelled});
  });

  await t.test('OpenAI is hard-disabled and scoped rejections never create image work', async () => {
    const before = f.checkpoint();
    await parity('image.generate', inputFor(f.project.id, {providerId: 'openai', model: IMAGE_MODELS.openai}), 'IMAGE_LIVE_DISABLED');
    await parity('image.task.get', {projectId: f.other.id, taskId: f.queued.id}, 'IMAGE_NOT_FOUND');
    await parity('image.group.get', {projectId: f.other.id, groupId: f.queued.groupId}, 'IMAGE_NOT_FOUND');
    await parity('image.version.list', {projectId: f.other.id, groupId: f.queued.groupId}, 'IMAGE_NOT_FOUND');
    assert.equal((await parity('image.request.get', {projectId: f.project.id, requestId: 'no-such-image-request'})).data, null);
    assert.equal((await parity('image.request.get', {projectId: f.other.id, requestId: f.queued.requestId})).data, null);
    f.unchanged(before, 'disabled live request and wrong-project reads');
  });

  let original, accepted, finished, version, bytes;
  await t.test('a lost HTTP acknowledgement recovers the exact receipt with one persistent real Mock PNG', async () => {
    original = inputFor(f.project.id);
    f.dropAcknowledgement();
    const browserClient = createClient({env: environment({MIOON_BASE_URL: f.proxyUrl, MIOON_TOKEN: token})});
    await assert.rejects(browserClient.rpc('image.generate', original));
    assert.equal(f.dropped?.ok, true); accepted = f.dropped.data;
    assert.ok(isImageTaskResponse(accepted)); assert.equal(accepted.state, 'queued');
    assert.equal(f.proxyRequests.filter(operation => operation === 'image.generate').length, 1, 'client does not automatically retry a dropped write');
    finished = await f.succeeded(accepted.id);
    const before = f.checkpoint();
    assert.deepEqual((await parity('image.generate', original)).data, accepted, 'replay returns original queued ACK, not current result');
    const receipt = (await parity('image.request.get', {projectId: f.project.id, requestId: original.requestId})).data;
    assert.ok(isImageRequestResponse(receipt)); assert.deepEqual(receipt.response, accepted);
    await parity('image.generate', {...original, prompt: 'Changed request identity'}, 'IMAGE_REQUEST_CONFLICT');
    await parity('image.generate', {...original, projectId: f.other.id}, 'IMAGE_REQUEST_CONFLICT');
    f.unchanged(before, 'historical receipt reads/exact replay/conflicting reuse');
    const versions = (await parity('image.version.list', {projectId: f.project.id, groupId: accepted.groupId})).data;
    assert.ok(isImageListResponse('image.version.list', {projectId: f.project.id, groupId: accepted.groupId}, versions));
    assert.equal(versions.items.length, 1); version = versions.items[0];
    assert.equal(version.id, finished.versionId); assert.equal(version.isMock, true);
    const response = await fetch(f.url + '/media/' + version.assetId, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), 1024); assert.equal(bytes.readUInt32BE(20), 1024);
    assert.equal(bytes.length, version.byteLength); assert.equal(hash(bytes), version.sha256);
    const tasks = (await parity('image.task.list', {projectId: f.project.id, groupId: accepted.groupId})).data;
    assert.equal(tasks.items.length, 1, 'all transport replays share one task');
  });

  await t.test('backend and client restart lookup is read-only, preserves bytes, and cannot start new inference', async () => {
    await mcp.client.close(); await f.restart(); mcp = await mcpFixture(t, f.env);
    const before = f.checkpoint();
    const freshBrowserClient = createClient({env: environment(f.env)});
    const receipt = await freshBrowserClient.rpc('image.request.get', {projectId: f.project.id, requestId: original.requestId});
    assert.deepEqual(receipt.response, accepted);
    assert.deepEqual((await parity('image.request.get', {projectId: f.project.id, requestId: original.requestId})).data, receipt);
    assert.deepEqual((await parity('image.task.get', {projectId: f.project.id, taskId: accepted.id})).data, finished);
    await parity('image.group.list', {projectId: f.project.id});
    await parity('image.group.get', {projectId: f.project.id, groupId: accepted.groupId});
    await parity('image.version.list', {projectId: f.project.id, groupId: accepted.groupId});
    await parity('image.profile.list');
    assert.deepEqual((await parity('image.generate', original)).data, accepted);
    const response = await fetch(f.url + '/media/' + version.assetId, {headers: {authorization: `Bearer ${token}`}});
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    f.unchanged(before, 'restart rediscovery/exact replay/media retrieval');
  });

  await t.test('explicit group generation adds an immutable version without implicit timeline/reference/subject edits', async () => {
    const groups = (await f.rpc('image.group.list', {projectId: f.project.id})).data.items;
    const group = groups.find(item => item.id === accepted.groupId);
    const before = f.checkpoint();
    const input = inputFor(f.project.id, {groupId: group.id, expectedRevision: group.revision,
      name: original.name, prompt: 'An intentionally different prompt still has deterministic Mock bytes.'});
    const next = (await parity('image.generate', input)).data;
    await f.succeeded(next.id);
    const result = (await parity('image.version.list', {projectId: f.project.id, groupId: group.id})).data;
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.find(item => item.id === version.id), version, 'old immutable version retains exact metadata');
    const newer = result.items.find(item => item.id !== version.id);
    assert.equal(newer.number, 2); assert.equal(newer.sha256, version.sha256, 'Mock is deliberately not conditioned on prompt text');
    assert.notEqual(newer.assetId, version.assetId, 'new version retains its own managed asset identity');
    const committed = f.checkpoint();
    await parity('image.generate', {...input, requestId: randomUUID()}, 'IMAGE_REVISION_CONFLICT');
    assert.deepEqual((await parity('image.generate', original)).data, accepted, 'older receipt survives a newer group head');
    f.unchanged(committed, 'stale revision rejection and old-version receipt replay');
    const after = f.checkpoint();
    for (const table of ['projects', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines',
      'timeline_requests', 'timeline_history', 'reference_requests', 'subjects', 'subject_versions', 'subject_bindings']) {
      assert.deepEqual(after.rows[table], before.rows[table], `${table}: image result creates no compound edit`);
    }
  });
});
