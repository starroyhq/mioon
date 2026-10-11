import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
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
const token = 'image-edit-transport-synthetic-local-token';
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
  const validationIssues = value?.error?.code === 'VALIDATION_ERROR' && Array.isArray(value.error.details?.issues) ? new Set(value.error.details.issues) : new Set();
  function walk(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      // Zod issues use a bounded field-segment path array, never a local file path.
      if (key === 'path' && validationIssues.has(item) && Array.isArray(child) && child.length <= 20 && child.every(part => typeof part === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,199}$/.test(part) || Number.isSafeInteger(part) && part >= 0 && part <= 1_000_000)) continue;
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
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
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
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-edit-wire-'));
  let store = openStore(root), project, other, queued, dispatched, source;
  try {
    const services = createServices(store, createProviderRegistry({db: store.db, root, env: {}}), {env: {}});
    project = await services.call('project.create', {name: 'Image edit transport acceptance'});
    other = await services.call('project.create', {name: 'Foreign image edit project'});
    const input = inputFor(project.id, {name: 'Original Mock T2I source'});
    const ack = await services.call('image.generate', input);
    let task;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      task = await services.call('image.task.get', {projectId: project.id, taskId: ack.id});
      if (task.state === 'succeeded') break;
      assert.ok(['queued', 'dispatching', 'receiving', 'persisting'].includes(task.state));
      await pause(20);
    }
    assert.equal(task.state, 'succeeded');
    const version = (await services.call('image.version.list', {projectId: project.id, groupId: ack.groupId})).items[0];
    const asset = store.get('assets', version.assetId);
    source = {input, ack, task, version, asset, bytes: await readFile(path.join(root, asset.relativePath))};
    await services.drain();
  } finally { store.close(); }
  store = openStore(root);
  try {
    const services = createServices(store, createProviderRegistry({db: store.db, root, env: {}}), {env: {}, imageOptions: {autoRun: false}});
    const edit = changes => inputFor(project.id, {purpose: 'edit', inputImage: {assetId: source.asset.id, sha256: source.asset.sha256}, ...changes});
    queued = await services.call('image.generate', edit({name: 'Queued edit restart fixture'}));
    dispatched = await services.call('image.generate', edit({name: 'Dispatched edit restart fixture'}));
    // Synthetic durable fence only: no external request and no durable output.
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
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-20_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
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
  return {root, project, other, queued, dispatched, source, rpc, succeeded, checkpoint, unchanged,
    retainedSource() { return {asset: db.prepare('SELECT * FROM assets WHERE id=?').get(source.asset.id),
      task: db.prepare('SELECT * FROM image_tasks WHERE id=?').get(source.ack.id),
      version: db.prepare('SELECT * FROM image_versions WHERE id=?').get(source.version.id),
      request: db.prepare('SELECT * FROM image_requests WHERE requestId=?').get(source.input.requestId),
      group: db.prepare('SELECT * FROM image_groups WHERE id=?').get(source.ack.groupId)}; },
    get url() { return url; }, get proxyUrl() { return proxyUrl; }, get dropped() { return dropped; }, proxyRequests,
    get env() { return {MIOON_BASE_URL: url, MIOON_TOKEN: token}; },
    dropAcknowledgement() { dropNext = true; },
    async restart() { db.close(); db = null; await stopOwned(child); await start(); db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true}); },
  };
}

async function mcpFixture(t, env) {
  const client = new Client({name: 'image-edit-transport-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [path.join(repo, 'apps/mcp/src/index.mjs')], cwd: repo, env: environment(env), stderr: 'pipe'});
  let stderr = ''; transport.stderr?.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
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

// One owned backend and official MCP bridge, with CLI children run sequentially.
// All source and output media are clearly labeled static Mock test cards.
test('image edits preserve one durable contract across real HTTP, CLI and official MCP', {timeout: 180_000}, async t => {
  const f = await fixture(t), source = f.source, sourceRows = f.retainedSource();
  let mcp = await mcpFixture(t, f.env);
  const command = (operation, input = {}, error) => cli([...operation.split('.'), '--input', JSON.stringify(input)], f.env, error);
  async function parity(operation, input = {}, error) {
    const result = await f.rpc(operation, input, error);
    assert.deepEqual(await command(operation, input, error), result, operation + ': CLI parity');
    assert.deepEqual(await mcp.call(operation, input, error), result, operation + ': official MCP parity');
    return result;
  }
  const editFor = (changes = {}) => inputFor(f.project.id, {purpose: 'edit', inputImage: {assetId: source.asset.id, sha256: source.asset.sha256}, ...changes});
  const descriptor = {assetId: source.asset.id, sha256: source.asset.sha256, mimeType: 'image/png', byteLength: source.asset.sizeBytes,
    width: 1024, height: 1024, name: source.asset.name, origin: {kind: 'synthetic-mock', imageSource: {imageGroupId: source.ack.groupId, imageTaskId: source.ack.id, imageVersionId: source.version.id}}};
  async function media(assetId) {
    const response = await fetch(f.url + '/media/' + assetId, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10_000)});
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); return Buffer.from(await response.arrayBuffer());
  }
  async function originalUnchanged() {
    assert.deepEqual(f.retainedSource(), sourceRows, 'original source records remain byte-for-byte unchanged');
    assert.deepEqual(await media(source.asset.id), source.bytes, 'original source file remains byte-for-byte unchanged');
    assert.deepEqual((await parity('image.task.get', {projectId: f.project.id, taskId: source.ack.id})).data, source.task);
    assert.deepEqual((await parity('image.generate', source.input)).data, source.ack, 'old T2I omission remains exact and replayable');
  }

  await t.test('discovery exposes only paired strict Mock/official edit fields and leaves built-in Agent catalogs unchanged', async () => {
    const before = f.checkpoint(), catalog = (await cli(['schema'], {})).data;
    const issue = path => ({ok: false, error: {code: 'VALIDATION_ERROR', details: {issues: [{path}]}}});
    noPrivate(issue(['inputImage', 'assetId', 0]), f.root);
    for (const value of [issue(['/local/private.png']), issue(['../secret']), issue([-1]), {ok: true, data: {path: ['inputImage']}}, {ok: true, data: {bytes: 'private'}}, {ok: true, data: {message: token}}, {ok: true, data: {message: f.root}}]) assert.throws(() => noPrivate(value, f.root));
    assert.deepEqual((await mcp.call('mioon_schema')).data, catalog);
    const tools = (await mcp.client.listTools()).tools, definition = catalog.operations.find(value => value.operation === 'image.generate');
    const tool = tools.find(value => value.name === 'image_generate'); assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.equal(definition.inputSchema.anyOf.length, 3);
    const edits = definition.inputSchema.anyOf.filter(branch => branch.properties.purpose?.const === 'edit'); assert.equal(edits.length, 1);
    for (const branch of definition.inputSchema.anyOf) { assert.equal(branch.additionalProperties, false); assert.ok(branch.required.includes('requestId')); }
    assert.ok(edits[0].required.includes('purpose')); assert.ok(edits[0].required.includes('inputImage'));
    assert.deepEqual(edits[0].properties.providerId.enum, ['mock', 'openai']); assert.equal(edits[0].properties.inputImage.additionalProperties, false);
    assert.deepEqual(edits[0].properties.inputImage.required, ['assetId', 'sha256']);
    for (const field of ['sourceBytes', 'sourceImage', 'images', 'mask', 'input_fidelity', 'url', 'apiKey']) assert.equal(Object.hasOwn(edits[0].properties, field), false);
    assert.ok(!tools.some(value => /image_(?:review_(?:approve|reject)|(?:custom_?)?settings_)/i.test(value.name)));
    assert.deepEqual(READ_TOOL_DEFINITIONS.map(value => value.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
    assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(value => value.name), ['mioon_propose_shot_update']);
    const profiles = (await parity('image.profile.list')).data; assert.equal(profiles.liveEnabled, false); assert.ok(isImageProfilesResponse(profiles));
    f.unchanged(before, 'edit schema and profile discovery');
  });

  await t.test('original real Mock T2I source keeps legacy omission, exact PNG bytes and independent provenance', async () => {
    const before = f.checkpoint();
    for (const value of [source.ack, source.task, source.version]) { assert.equal(Object.hasOwn(value, 'purpose'), false); assert.equal(Object.hasOwn(value, 'inputImage'), false); assert.equal(Object.hasOwn(value, 'sourceImage'), false); }
    assert.equal(source.version.isMock, true); assert.equal(hash(source.bytes), source.version.sha256); assert.equal(source.bytes.length, source.version.byteLength);
    assert.deepEqual((await parity('image.version.list', {projectId: f.project.id, groupId: source.ack.groupId})).data.items, [source.version]);
    await originalUnchanged(); f.unchanged(before, 'old T2I reads and historical replay');
  });

  await t.test('restart retains interrupted and unknown edits without implicit resume or remote retry', async () => {
    const queued = (await parity('image.task.get', {projectId: f.project.id, taskId: f.queued.id})).data;
    const unknown = (await parity('image.task.get', {projectId: f.project.id, taskId: f.dispatched.id})).data;
    assert.equal(queued.purpose, 'edit'); assert.deepEqual(queued.sourceImage, descriptor); assert.equal(queued.state, 'interrupted_before_dispatch'); assert.equal(queued.dispatched, false);
    assert.equal(unknown.purpose, 'edit'); assert.deepEqual(unknown.sourceImage, descriptor); assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.dispatched, true);
    const before = f.checkpoint(); await pause(60);
    await parity('image.task.cancelQueued', {projectId: f.project.id, taskId: unknown.id, expectedRevision: unknown.revision, requestId: randomUUID()}, 'IMAGE_STATE_CONFLICT');
    await parity('image.task.recoverResult', {projectId: f.project.id, taskId: unknown.id, expectedRevision: unknown.revision, requestId: randomUUID()}, 'IMAGE_RESULT_INVALID');
    await parity('image.task.list', {projectId: f.project.id}); f.unchanged(before, 'ambiguous edit reads and forbidden retry-like operations');
    const cancel = {projectId: f.project.id, taskId: queued.id, expectedRevision: queued.revision, requestId: randomUUID()}, cancelled = (await parity('image.task.cancelQueued', cancel)).data;
    assert.equal(cancelled.state, 'cancelled_before_dispatch'); assert.equal(cancelled.dispatched, false); assert.deepEqual(cancelled.sourceImage, descriptor);
  });

  await t.test('all transports reject unpaired edit selectors, unsupported provider and public source/URL/byte overrides before writes', async () => {
    const before = f.checkpoint(), valid = editFor();
    const {purpose, ...noPurpose} = valid, {inputImage, ...noImage} = valid;
    const malformed = [noPurpose, noImage, {...valid, purpose: 'generate'}, {...valid, inputImage: {...valid.inputImage, url: 'https://example.invalid/source.png'}},
      {...valid, sourceImage: descriptor}, {...valid, sourceBytes: 'not-accepted'}, {...valid, images: [{image_url: 'https://example.invalid/source.png'}]},
      {...valid, providerId: 'openai-compatible', model: 'custom-model'}, {...valid, inputImage: {...valid.inputImage, sha256: 'not-a-hash'}}];
    for (const input of malformed) await parity('image.generate', input, 'VALIDATION_ERROR');
    f.unchanged(before, 'strict edit input rejection');
  });

  await t.test('cross-project sources and wrong source hashes cannot reserve work; live editing is still disabled', async () => {
    const before = f.checkpoint();
    await parity('image.generate', editFor({projectId: f.other.id}), 'IMAGE_SOURCE_INVALID');
    await parity('image.generate', editFor({inputImage: {...editFor().inputImage, sha256: 'a'.repeat(64)}}), 'IMAGE_SOURCE_INVALID');
    await parity('image.generate', editFor({inputImage: {assetId: randomUUID(), sha256: source.asset.sha256}}), 'IMAGE_SOURCE_INVALID');
    await parity('image.generate', editFor({providerId: 'openai', model: IMAGE_MODELS.openai}), 'IMAGE_LIVE_DISABLED');
    await parity('image.task.get', {projectId: f.other.id, taskId: f.queued.id}, 'IMAGE_NOT_FOUND');
    await parity('image.version.list', {projectId: f.other.id, groupId: source.ack.groupId}, 'IMAGE_NOT_FOUND');
    f.unchanged(before, 'source ownership/hash and disabled live denials');
  });

  let original, accepted, finished, version, output;
  await t.test('a lost HTTP edit ACK resolves through one durable receipt and one independent Mock asset across HTTP/CLI/MCP', async () => {
    original = editFor(); f.dropAcknowledgement();
    const client = createClient({env: environment({MIOON_BASE_URL: f.proxyUrl, MIOON_TOKEN: token})});
    await assert.rejects(client.rpc('image.generate', original)); assert.equal(f.dropped?.ok, true); accepted = f.dropped.data;
    assert.equal(accepted.state, 'queued'); assert.equal(accepted.purpose, 'edit'); assert.deepEqual(accepted.inputImage, original.inputImage); assert.deepEqual(accepted.sourceImage, descriptor);
    assert.equal(f.proxyRequests.filter(operation => operation === 'image.generate').length, 1, 'lost write ACK does not trigger automatic retry');
    finished = await f.succeeded(accepted.id); const before = f.checkpoint();
    assert.deepEqual((await parity('image.generate', original)).data, accepted);
    const receipt = (await parity('image.request.get', {projectId: f.project.id, requestId: original.requestId})).data;
    assert.ok(isImageRequestResponse(receipt)); assert.deepEqual(receipt.response, accepted); assert.deepEqual(receipt.response.sourceImage, descriptor);
    const versions = (await parity('image.version.list', {projectId: f.project.id, groupId: accepted.groupId})).data;
    assert.ok(isImageListResponse('image.version.list', {projectId: f.project.id, groupId: accepted.groupId}, versions)); assert.equal(versions.items.length, 1); version = versions.items[0];
    assert.equal(version.purpose, 'edit'); assert.deepEqual(version.inputImage, original.inputImage); assert.deepEqual(version.sourceImage, descriptor); assert.equal(version.isMock, true);
    assert.notEqual(version.assetId, source.asset.id); assert.notEqual(version.id, source.version.id); assert.notEqual(version.taskId, source.ack.id);
    output = await media(version.assetId); assert.equal(hash(output), version.sha256); assert.deepEqual(output, source.bytes, 'Mock is a static test card, never a claim of conditioned editing');
    assert.equal((await parity('image.task.list', {projectId: f.project.id, groupId: accepted.groupId})).data.items.length, 1);
    await originalUnchanged(); f.unchanged(before, 'receipt/result reads and exact edit replay');
  });

  await t.test('same request key with changed prompt, source hash, purpose or project conflicts without new work', async () => {
    const before = f.checkpoint(), {purpose, inputImage, ...generationInput} = original;
    for (const input of [{...original, prompt: 'Changed edit instruction'}, {...original, inputImage: {...original.inputImage, sha256: 'b'.repeat(64)}}, generationInput,
      {...original, projectId: f.other.id}, {...source.input, purpose: 'edit', inputImage: original.inputImage}]) await parity('image.generate', input, 'IMAGE_REQUEST_CONFLICT');
    assert.equal((await parity('image.request.get', {projectId: f.other.id, requestId: original.requestId})).data, null);
    await originalUnchanged(); f.unchanged(before, 'changed key-content and cross-project replay denials');
  });

  await t.test('CLI and official MCP can each initiate one fresh edit; replays share the same task without compound project edits', async () => {
    const before = f.checkpoint();
    for (const first of [command, mcp.call]) {
      const input = editFor({name: first === command ? 'CLI-authored synthetic edit' : 'MCP-authored synthetic edit'}), ack = (await first('image.generate', input)).data;
      assert.deepEqual((await parity('image.generate', input)).data, ack); await f.succeeded(ack.id);
      const versions = (await parity('image.version.list', {projectId: f.project.id, groupId: ack.groupId})).data.items;
      assert.equal(versions.length, 1); assert.deepEqual(versions[0].sourceImage, descriptor); assert.notEqual(versions[0].assetId, source.asset.id);
      assert.equal((await parity('image.task.list', {projectId: f.project.id, groupId: ack.groupId})).data.items.length, 1);
    }
    const after = f.checkpoint();
    for (const table of ['projects', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines', 'timeline_requests', 'timeline_history', 'reference_requests', 'subjects', 'subject_versions', 'subject_bindings']) assert.deepEqual(after.rows[table], before.rows[table], `${table}: no compound edit`);
    await originalUnchanged();
  });

  await t.test('on-disk source hash changes reject admission without writes and restoring the exact bytes permits the original unaccepted key', async () => {
    const sourceInput = inputFor(f.project.id, {name: 'Separate source for local integrity test'}), ack = (await f.rpc('image.generate', sourceInput)).data;
    await f.succeeded(ack.id); const sourceVersion = (await f.rpc('image.version.list', {projectId: f.project.id, groupId: ack.groupId})).data.items[0];
    const file = path.join(f.root, 'media', `${sourceVersion.assetId}.png`), bytes = await readFile(file), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    const input = editFor({name: 'Restored exact source', inputImage: {assetId: sourceVersion.assetId, sha256: sourceVersion.sha256}}), before = f.checkpoint();
    try { await writeFile(file, changed); await parity('image.generate', input, 'IMAGE_SOURCE_INVALID'); f.unchanged(before, 'on-disk hash mismatch rejects before acceptance'); }
    finally { await writeFile(file, bytes); }
    const edited = (await parity('image.generate', input)).data; await f.succeeded(edited.id); await originalUnchanged();
  });

  await t.test('backend and MCP restart preserve exact edit/source receipts and bytes without automatic generation', async () => {
    await mcp.client.close(); await f.restart(); mcp = await mcpFixture(t, f.env); const before = f.checkpoint();
    assert.deepEqual((await parity('image.generate', original)).data, accepted);
    assert.deepEqual((await parity('image.request.get', {projectId: f.project.id, requestId: original.requestId})).data.response, accepted);
    assert.deepEqual((await parity('image.task.get', {projectId: f.project.id, taskId: accepted.id})).data, finished);
    assert.deepEqual((await parity('image.version.list', {projectId: f.project.id, groupId: accepted.groupId})).data.items, [version]);
    assert.deepEqual(await media(version.assetId), output); await originalUnchanged();
    const unknown = (await parity('image.task.get', {projectId: f.project.id, taskId: f.dispatched.id})).data; assert.equal(unknown.state, 'outcome_unknown');
    await pause(60); f.unchanged(before, 'post-restart discovery, exact replay and source/output retrieval');
  });

  await t.test('strict client rejects malformed edit ACK purpose/source identities without retrying a potentially accepted write', async () => {
    let calls = 0, data; const server = http.createServer(async (request, response) => { calls++; for await (const _chunk of request) {} response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({ok: true, data})); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = createClient({env: {MIOON_BASE_URL: `http://127.0.0.1:${server.address().port}`, MIOON_TOKEN: token}});
      for (const patch of [{purpose: undefined}, {inputImage: undefined}, {sourceImage: undefined}, {inputImage: {...accepted.inputImage, sha256: 'b'.repeat(64)}},
        {sourceImage: {...accepted.sourceImage, assetId: randomUUID()}}, {sourceImage: {...accepted.sourceImage, path: '/not-public'}}, {sourceBytes: 'not-public'}, {requestId: randomUUID()}]) {
        data = {...accepted, ...patch}; const before = calls;
        await assert.rejects(client.rpc('image.generate', original), error => { assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(error.details.submissionMayHaveSucceeded, true); assert.equal(error.details.requestId, original.requestId); return true; }); assert.equal(calls, before + 1);
      }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});
