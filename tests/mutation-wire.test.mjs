import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {IDS, TOKEN, snapshot, uuid} from './helpers/mutation-wire-fixture.ts';
import {optionalRequestIdOperations} from './helpers/catalog-input-branches.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/mutation-wire-fixture.ts');
const operations = ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolName = operation => operation.replaceAll('.', '_');
const ownedChildren = new WeakMap();
const preservedTables = ['assets', 'edges', 'jobs', 'versions', 'exports', 'timelines', 'timeline_requests',
  'timeline_history', 'timeline_history_cursors', 'reference_requests', 'idempotency', 'job_events', 'workspace_preferences',
  'agent_chat_requests', 'agent_chat_runs', 'agent_chat_events', 'agent_chat_steps', 'agent_chat_quota'];

function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:MIOON_|RUNWAY_|ARK_|VEO_|GOOGLE_|GEMINI_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_MUTATION_WIRE_GUARD: '1', ...extra};
}

// Cleanup only ever targets the exact ChildProcess object created by this
// fixture, never a guessed PID, port owner, or unrelated application.
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await ended; } finally { clearTimeout(timer); }
}

function launch(t, args, env = {}, ipc = false) {
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env),
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])]});
  if (!ownedChildren.has(t)) ownedChildren.set(t, new Set());
  ownedChildren.get(t).add(child);
  let stdout = '', stderr = '', error;
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', value => { error = value; });
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  t.after(() => stopOwned(child));
  const lines = () => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function waitFor(predicate, label, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (error) throw error;
      // A partial final stdout line is expected while a child is still writing.
      for (const line of stdout.split('\n').slice(0, -1)) {
        const value = JSON.parse(line);
        if (predicate(value)) return value;
      }
      assert.equal(child.exitCode, null, `Owned child exited before ${label}: ${stdout}\n${stderr}`);
      assert.equal(child.signalCode, null, `Owned child stopped before ${label}: ${stdout}\n${stderr}`);
      await pause(10);
    }
    throw Error(`Owned child timed out waiting for ${label}: ${stdout}\n${stderr}`);
  }
  async function finish(timeout = 15_000) {
    let timer;
    try {
      return await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Owned child timeout: ${stdout}\n${stderr}`)), timeout); })]);
    } finally { clearTimeout(timer); }
  }
  return {child, lines, waitFor, finish, get stdout() { return stdout; }, get stderr() { return stderr; }};
}

async function runCli(t, args, env, expectedError) {
  const run = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args], env);
  const {code, signal} = await run.finish();
  assert.equal(signal, null, run.stderr);
  const results = run.lines();
  assert.equal(results.length, 1, 'real CLI emits exactly one JSON envelope');
  const result = results[0];
  assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN), 'synthetic bearer token never reaches CLI output');
  assert.equal(result.ok, !expectedError, run.stdout + run.stderr);
  if (expectedError) {
    assert.notEqual(code, 0, run.stdout + run.stderr);
    assert.equal(result.error.code, expectedError, run.stdout + run.stderr);
    assert.ok(run.stderr.includes(expectedError), 'CLI error has an actionable stderr summary');
  } else assert.equal(code, 0, run.stderr);
  return result;
}

async function backendFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mutation-wire-'));
  const auditPath = path.join(root, 'forbidden-side-effects.jsonl');
  await writeFile(auditPath, '');
  let run, url, port = 0, db;
  t.after(async () => {
    for (const child of ownedChildren.get(t) || []) await stopOwned(child);
    db?.close(); await rm(root, {recursive: true, force: true});
  });
  async function start() {
    run = launch(t, [helper, 'server'], {MIOON_DATA_DIR: root, PORT: String(port), MIOON_MUTATION_WIRE_AUDIT: auditPath});
    const ready = await run.waitFor(value => value.ready, 'backend startup');
    url = ready.url; port = Number(new URL(url).port);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal((await fetch(url + '/health', {signal: AbortSignal.timeout(5_000)})).status, 200);
    return ready.pid;
  }
  await start();
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const storage = () => snapshot(db);
  const version = () => db.prepare('PRAGMA data_version').get().data_version;
  const record = (table, id) => JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id).data);
  const unchanged = (before, dataVersion, label) => {
    assert.deepEqual(storage(), before, `${label}: every persisted row and revision remains identical`);
    assert.equal(version(), dataVersion, `${label}: replay must not commit even equal-value writes`);
  };
  async function request(operation, input, expectedError, target = url, authorization = `Bearer ${TOKEN}`) {
    const response = await fetch(target + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: JSON.stringify({operation, input})});
    const raw = await response.text(), envelope = JSON.parse(raw);
    assert.equal(envelope.ok, !expectedError, raw);
    if (expectedError) {
      assert.equal(envelope.error.code, expectedError, raw);
      assert.equal(response.status, expectedError === 'UNAUTHORIZED' ? 401 : expectedError === 'NOT_FOUND' ? 404 :
        ['IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'INVALID_MUTATION_RECORD'].includes(expectedError) ? 409 : 400, raw);
    } else assert.equal(response.status, 200, raw);
    return {envelope, raw};
  }
  return {root, auditPath, storage, version, record, unchanged, request,
    http: async (...args) => (await request(...args)).envelope,
    get url() { return url; }, get pid() { return run.child.pid; },
    get env() { return {MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_MUTATION_WIRE_ALLOWED_ORIGIN: url,
      MIOON_MUTATION_WIRE_AUDIT: auditPath}; },
    audit: async () => (await readFile(auditPath, 'utf8')).trim(),
    stop: () => stopOwned(run.child), restart: async () => { await stopOwned(run.child); return start(); },
  };
}

async function mcpFixture(t, env) {
  const client = new Client({name: 'mutation-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath,
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(env), stderr: 'pipe'});
  let stderr = '', timer;
  transport.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  try { await Promise.race([client.connect(transport), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Official MCP initialization timed out')), 15_000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(client.getServerVersion().name, 'mioon');
  assert.ok(client.getServerCapabilities().tools);
  return {client, async call(operation, input = {}, expectedError) {
    const result = await client.callTool({name: operation === 'mioon_schema' ? operation : toolName(operation), arguments: input}, undefined, {timeout: 5_000});
    const blocks = result.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1, 'official SDK receives one JSON text envelope');
    const envelope = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, envelope, 'MCP text and structured envelopes match');
    assert.equal(Boolean(result.isError), Boolean(expectedError), blocks[0].text);
    assert.equal(envelope.ok, !expectedError, blocks[0].text);
    if (expectedError) assert.equal(envelope.error.code, expectedError, blocks[0].text);
    assert.ok(!JSON.stringify(result).includes(TOKEN) && !stderr.includes(TOKEN));
    return envelope;
  }};
}

async function lossProxy(t, backend) {
  let captured, failure;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const upstream = await fetch(backend.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: {authorization: request.headers.authorization, 'content-type': 'application/json'}, body: bytes});
      const raw = await upstream.text(), envelope = JSON.parse(raw);
      captured = {request: JSON.parse(bytes), raw, envelope, status: upstream.status};
      // The production backend has sent its complete success response, after
      // COMMIT. Verify its receipt before dropping only this proxy connection.
      const requestId = captured.request.input.requestId;
      assert.equal(upstream.status, 200, raw);
      assert.ok(backend.storage().mutation_requests.some(row => row.requestId === requestId));
      response.destroy();
    } catch (error) { failure = error; response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {async drop(operation, input) {
    captured = null; failure = null;
    const target = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(backend.request(operation, input, undefined, target), /fetch failed|socket|network/i);
    if (failure) throw failure;
    assert.ok(captured, 'loss occurred after the owned upstream response was received');
    assert.equal(captured.status, 200, captured.raw);
    assert.deepEqual(captured.request, {operation, input});
    return captured;
  }};
}

function operationInputs(backend) {
  const projectId = IDS.project;
  return {
    'shot.create': {projectId, title: 'Original private shot marker', prompt: 'Original prompt', position: {x: 10, y: 20}},
    'shot.update': {shotId: IDS.shot, expectedRevision: backend.record('shots', IDS.shot).revision, patch: {title: 'Original update marker', prompt: 'Updated prompt'}},
    'shot.reorder': {projectId, expectedRevision: backend.record('projects', projectId).revision,
      shotIds: backend.storage().shots.filter(row => row.projectId === projectId).map(row => row.id).reverse()},
    'node.create': {projectId, type: 'text', label: 'Original node marker', text: 'Original node text', position: {x: 10, y: 20}},
    'node.update': {nodeId: IDS.node, expectedRevision: backend.record('nodes', IDS.node).revision, patch: {label: 'Original label marker', text: 'Original update text'}},
    'version.select': {shotId: IDS.shot, versionId: IDS.version, expectedRevision: backend.record('shots', IDS.shot).revision},
  };
}

// One sequential wire fixture owns one backend, one official MCP stdio server
// and at most one CLI child. No generated media, model, or provider is used.
test('six optional mutation keys retain exact results through lost HTTP responses, real CLI, official MCP and restart', {timeout: 120_000}, async t => {
  const backend = await backendFixture(t), mcp = await mcpFixture(t, backend.env), proxy = await lossProxy(t, backend);
  const cli = (operation, input, error) => runCli(t, [...operation.split('.'), '--input', JSON.stringify(input)], backend.env, error);
  const initial = backend.storage(), accepted = [];

  await t.test('all discovery surfaces expose optional keys and conservative non-idempotent hints', async () => {
    const before = backend.storage(), dataVersion = backend.version();
    const catalog = (await runCli(t, ['schema'], backend.env)).data;
    assert.deepEqual((await mcp.call('mioon_schema')).data, catalog);
    const optionalKeyOperations = optionalRequestIdOperations(catalog);
    assert.deepEqual(optionalKeyOperations, [...operations].sort(), 'optional keys are added only to the approved six operations');
    const tools = (await mcp.client.listTools()).tools;
    for (const operation of operations) {
      const definition = (await runCli(t, ['schema', operation], backend.env)).data;
      const tool = tools.find(item => item.name === toolName(operation));
      assert.deepEqual(definition, catalog.operations.find(item => item.operation === operation));
      assert.deepEqual((await mcp.call('mioon_schema', {operation})).data, definition);
      assert.deepEqual(tool.inputSchema, definition.inputSchema);
      assert.equal(definition.requiresRequestId, false);
      assert.ok(!definition.inputSchema.required.includes('requestId'));
      const keySchema = definition.inputSchema.properties.requestId;
      assert.equal(keySchema.type, 'string'); assert.equal(keySchema.minLength, 8); assert.equal(keySchema.maxLength, 200);
      assert.match(keySchema.description, /optional.*replay/i);
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.effects.idempotent, false, 'optional keys cannot make unkeyed calls idempotent');
      assert.equal(tool.annotations.idempotentHint, false);
      assert.equal(tool.annotations.readOnlyHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(definition.effects.databaseWrite, true);
      for (const name of ['fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(definition.effects[name], false);
      assert.match(definition.effects.notes, /requestId|request ID|replay/i);
    }
    backend.unchanged(before, dataVersion, 'discovery');
  });

  await t.test('each of the six commits once despite response loss, and old responses survive newer changes', async () => {
    for (const [index, operation] of operations.entries()) {
      const input = {...operationInputs(backend)[operation], requestId: `mutation-wire-original-${index}`};
      const original = await proxy.drop(operation, input), result = original.envelope.data;
      accepted.push({operation, input, ...original});
      const afterCommit = backend.storage(), dataVersion = backend.version();
      assert.equal(afterCommit.mutation_requests.filter(row => row.requestId === input.requestId).length, 1);
      assert.equal(afterCommit.mutation_requests.length, index + 1);
      assert.deepEqual((await backend.request(operation, input)).raw, original.raw, 'immediate HTTP replay is the complete original wire response');
      backend.unchanged(afterCommit, dataVersion, `${operation} immediate replay`);
      if (operation === 'shot.create' || operation === 'shot.update') {
        await backend.http('shot.update', {shotId: result.id, expectedRevision: result.revision, patch: {title: 'Intervening shot update', prompt: 'Intervening prompt'}});
      } else if (operation === 'node.create' || operation === 'node.update') {
        assert.ok(!Object.hasOwn(result, 'requestId'), 'transport identity does not leak into node records');
        assert.ok(!Object.hasOwn(backend.record('nodes', result.id), 'requestId'), 'durable node rows also exclude requestId');
        await backend.http('node.update', {nodeId: result.id, expectedRevision: result.revision, patch: {text: 'Intervening node text'}});
      } else if (operation === 'shot.reorder') {
        await backend.http('shot.reorder', {projectId: IDS.project, expectedRevision: result.revision, shotIds: [...input.shotIds].reverse()});
      } else {
        await backend.http('version.select', {shotId: result.id, expectedRevision: result.revision, versionId: IDS.secondVersion});
      }
      const afterChange = backend.storage(), changedVersion = backend.version();
      assert.deepEqual(await cli(operation, input), original.envelope, `${operation} CLI returns original, not current record`);
      assert.deepEqual(await mcp.call(operation, input), original.envelope, `${operation} MCP returns original, not current record`);
      backend.unchanged(afterChange, changedVersion, `${operation} stale-revision cross-transport replay`);
    }
    for (const table of preservedTables) assert.deepEqual(backend.storage()[table], initial[table], `${table} is untouched by all six mutations`);
  });

  await t.test('actual backend restart and canonical object-key order retain every original response', async () => {
    assert.equal(accepted.length, 6, 'all six original committed responses are present');
    const before = backend.storage(), priorPid = backend.pid;
    assert.notEqual(await backend.restart(), priorPid, 'restart uses a new actual process');
    assert.deepEqual(backend.storage(), before);
    const dataVersion = backend.version();
    for (const {operation, input, envelope, raw} of accepted) {
      // Reconstruct nested fields in reverse insertion order. Object ordering
      // is insignificant, while arrays/revisions/field presence remain exact.
      const reorderKeys = value => Array.isArray(value) ? value.map(reorderKeys) : value && typeof value === 'object' ?
        Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorderKeys(item)])) : value;
      assert.equal((await backend.request(operation, reorderKeys(input))).raw, raw);
      assert.deepEqual(await cli(operation, input), envelope);
      assert.deepEqual(await mcp.call(operation, input), envelope);
    }
    const {requestId, ...fields} = accepted[0].input;
    assert.deepEqual(await runCli(t, ['shot', 'create', '--input', JSON.stringify(fields), '--request-id', requestId], backend.env),
      accepted[0].envelope, 'real CLI --request-id forwards the caller-owned optional identity unchanged');
    backend.unchanged(before, dataVersion, 'post-restart replays');
  });

  await t.test('changed payload, operation or project cannot consume or reveal another request receipt', async () => {
    assert.equal(accepted.length, 6);
    const before = backend.storage(), dataVersion = backend.version();
    for (const original of accepted) {
      const {operation, input, envelope} = original;
      const changed = operation === 'shot.create' ? {...input, title: 'Changed'} : operation === 'node.create' ? {...input, text: 'Changed'} :
        {...input, expectedRevision: input.expectedRevision + 50};
      const foreign = {...input, ...(input.projectId ? {projectId: IDS.other} : input.nodeId ? {nodeId: IDS.otherNode} : {shotId: IDS.otherShot})};
      for (const attempt of [changed, foreign]) {
        const result = await backend.http(operation, attempt, 'IDEMPOTENCY_CONFLICT');
        assert.equal(result.data, undefined);
        assert.ok(!JSON.stringify(result).includes(JSON.stringify(envelope.data)), 'conflicts do not reveal stored output');
        for (const key of ['current', 'response', 'snapshot', 'canonicalInput', 'projectId', 'operation', 'mutationOutcome']) {
          assert.ok(!Object.hasOwn(result.error.details || {}, key), `conflict does not disclose ${key}`);
        }
        for (const marker of ['Original private shot marker', 'Original update marker', 'Original node marker', 'Original label marker']) {
          assert.ok(!JSON.stringify(result).includes(marker), 'a foreign/reused key cannot reveal original record fields');
        }
        await mcp.call(operation, attempt, 'IDEMPOTENCY_CONFLICT');
      }
      await cli(operation, changed, 'IDEMPOTENCY_CONFLICT');
      const otherOperation = operation === 'node.create' ? 'shot.create' : 'node.create';
      await backend.http(otherOperation, {...operationInputs(backend)[otherOperation], requestId: input.requestId}, 'IDEMPOTENCY_CONFLICT');
      await backend.http(operation, input, 'UNAUTHORIZED', undefined, 'Bearer wrong-synthetic-token');
      await backend.http(operation, input, 'UNAUTHORIZED', undefined, '');
    }
    backend.unchanged(before, dataVersion, 'reused-key and authentication failures');
  });

  await t.test('strict validation rejects invalid optional keys before any write on all transports', async () => {
    const before = backend.storage(), dataVersion = backend.version();
    for (const operation of operations) {
      const base = operationInputs(backend)[operation];
      for (const requestId of ['', '1234567', 'x'.repeat(201), null, 42]) {
        await backend.http(operation, {...base, requestId}, 'VALIDATION_ERROR');
        await mcp.call(operation, {...base, requestId}, 'VALIDATION_ERROR');
      }
      await cli(operation, {...base, requestId: 'short'}, 'VALIDATION_ERROR');
      await backend.http(operation, {...base, requestId: 'valid-optional-key', unexpected: true}, 'VALIDATION_ERROR');
    }
    await runCli(t, ['shot', 'create', '--input', JSON.stringify({...operationInputs(backend)['shot.create'], requestId: 'first-stable-key'}),
      '--request-id', 'different-stable-key'], backend.env, 'VALIDATION_ERROR');
    backend.unchanged(before, dataVersion, 'malformed keys and unknown fields');
  });

  await t.test('only a fresh-key definite rejection proves not applied, and it does not reserve the key', async () => {
    const before = backend.storage(), dataVersion = backend.version();
    const input = {nodeId: IDS.node, expectedRevision: 1, patch: {label: 'Definite rejection'}, requestId: 'mutation-definite-rejection'};
    const rejected = await backend.http('node.update', input, 'REVISION_CONFLICT');
    assert.equal(rejected.error.details.mutationOutcome, 'not_applied');
    assert.equal(rejected.error.details.requestId, input.requestId);
    assert.deepEqual(await cli('node.update', input, 'REVISION_CONFLICT'), rejected);
    assert.deepEqual(await mcp.call('node.update', input, 'REVISION_CONFLICT'), rejected);
    backend.unchanged(before, dataVersion, 'definite rejected request');
    assert.ok(!before.mutation_requests.some(row => row.requestId === input.requestId));
    const corrected = {...input, expectedRevision: backend.record('nodes', IDS.node).revision};
    const accepted = await backend.http('node.update', corrected);
    assert.equal(accepted.data.label, input.patch.label, 'a rejected key has not been consumed');
    const committed = backend.storage(), committedVersion = backend.version();
    const reused = await backend.http('node.update', input, 'IDEMPOTENCY_CONFLICT');
    assert.ok(!Object.hasOwn(reused.error.details, 'mutationOutcome'), 'a committed key must never authorize clearing a pending receipt');
    backend.unchanged(committed, committedVersion, 'prior-key failure lacks not-applied proof');
  });

  await t.test('omitting requestId preserves legacy create and optimistic-revision behavior', async () => {
    const beforeJournal = backend.storage().mutation_requests;
    for (const operation of ['shot.create', 'node.create']) {
      const input = operationInputs(backend)[operation];
      const first = await backend.http(operation, input), second = await cli(operation, input);
      assert.notEqual(first.data.id, second.data.id, 'legacy creation does not silently invent a replay identity');
      assert.ok(!Object.hasOwn(first.data, 'requestId') && !Object.hasOwn(second.data, 'requestId'));
    }
    for (const operation of ['shot.update', 'node.update', 'shot.reorder', 'version.select']) {
      const input = operationInputs(backend)[operation], first = await mcp.call(operation, input);
      assert.equal(first.data.revision, input.expectedRevision + 1);
      await backend.http(operation, input, 'REVISION_CONFLICT');
    }
    assert.deepEqual(backend.storage().mutation_requests, beforeJournal, 'legacy calls never create keyed receipts');
    for (const table of preservedTables) assert.deepEqual(backend.storage()[table], initial[table]);
    assert.equal(await backend.audit(), '', 'guard observed zero outbound/model/provider/media/subprocess attempts');
  });

  await t.test('an existing receipt cannot disclose a removed target or falsely prove not applied', async () => {
    const original = accepted.find(item => item.operation === 'node.create');
    const journal = backend.storage().mutation_requests;
    await backend.stop();
    const deletion = launch(t, [helper, 'delete-node'], {MIOON_DATA_DIR: backend.root, MIOON_MUTATION_WIRE_AUDIT: backend.auditPath,
      MIOON_MUTATION_WIRE_NODE_ID: original.envelope.data.id});
    assert.equal((await deletion.finish()).code, 0, deletion.stderr);
    assert.deepEqual(deletion.lines(), [{deleted: 1}]);
    await backend.restart();
    const before = backend.storage(), dataVersion = backend.version();
    assert.deepEqual(before.mutation_requests, journal, 'removing the target cannot evict the retained receipt');
    for (const result of [await backend.http(original.operation, original.input, 'NOT_FOUND'),
      await cli(original.operation, original.input, 'NOT_FOUND'), await mcp.call(original.operation, original.input, 'NOT_FOUND')]) {
      assert.equal(result.data, undefined);
      assert.ok(!Object.hasOwn(result.error.details, 'mutationOutcome'), 'missing target is not proof the original mutation never committed');
      assert.ok(!JSON.stringify(result).includes('Original node marker'), 'retained original fields remain private after removal');
    }
    backend.unchanged(before, dataVersion, 'removed target replay refusals');
    assert.equal(await backend.audit(), '');
  });
});

function writer(t, backend, operation, input, extra = {}, ipc = false) {
  return launch(t, [helper, 'writer'], {MIOON_DATA_DIR: backend.root, MIOON_MUTATION_WIRE_AUDIT: backend.auditPath,
    MIOON_MUTATION_WIRE_REQUEST: JSON.stringify({operation, input}), ...extra}, ipc);
}

test('real competing SQLite writers converge on one stable mutation and production ownership stays locked', {timeout: 45_000}, async t => {
  const backend = await backendFixture(t);
  // A normal second owner still fails; only the explicitly marked test writers
  // below opt out of the production lock on this disposable database.
  const input = {projectId: IDS.project, title: 'Concurrent original', requestId: 'mutation-real-concurrent-key'};
  const rejected = writer(t, backend, 'shot.create', input);
  const rejectedExit = await rejected.finish();
  assert.notEqual(rejectedExit.code, 0);
  assert.match(rejected.stderr, /already has a running backend/);
  const before = backend.storage();
  const extra = {MIOON_MUTATION_WIRE_COMPETING_WRITER: '1'};
  const first = writer(t, backend, 'shot.create', input, {...extra, MIOON_MUTATION_WIRE_ROLE: 'holder'}, true);
  const second = writer(t, backend, 'shot.create', input, {...extra, MIOON_MUTATION_WIRE_ROLE: 'contender'}, true);
  await Promise.all([first.waitFor(value => value.event === 'ready', 'first writer ready'), second.waitFor(value => value.event === 'ready', 'second writer ready')]);
  first.child.send('go');
  await first.waitFor(value => value.event === 'holding-transaction', 'first transaction lock', 5_000);
  second.child.send('go');
  await second.waitFor(value => value.event === 'begin-attempt', 'competing BEGIN IMMEDIATE', 5_000);
  assert.ok(!second.lines().some(value => value.event === 'result'), 'contender cannot complete while the first writer owns the transaction');
  await writeFile(path.join(backend.root, 'release-writer'), 'release only owned test transaction');
  for (const process of [first, second]) {
    const result = await process.finish(); assert.equal(result.code, 0, process.stderr); assert.equal(result.signal, null);
  }
  const a = first.lines().find(value => value.event === 'result'), b = second.lines().find(value => value.event === 'result');
  assert.equal(a.ok, true, JSON.stringify(a)); assert.deepEqual(b, a, 'both real writer processes return exactly one stable result');
  const after = backend.storage();
  assert.equal(after.shots.length, before.shots.length + 1);
  assert.equal(after.mutation_requests.length, before.mutation_requests.length + 1);
  assert.equal(backend.record('projects', IDS.project).revision, JSON.parse(before.projects.find(row => row.id === IDS.project).data).revision + 1);
  const dataVersion = backend.version();
  assert.deepEqual((await backend.http('shot.create', input)).data, a.data);
  backend.unchanged(after, dataVersion, 'concurrent result replay');
  for (const table of preservedTables) assert.deepEqual(after[table], before[table]);
  assert.equal(await backend.audit(), '');
});

test('test-child rollback and actual crash boundaries keep mutation and exact response receipt atomic', {timeout: 90_000}, async t => {
  for (const boundary of ['rollback', 'crash-before-commit', 'crash-after-commit']) {
    await t.test(boundary, async subtest => {
      const backend = await backendFixture(subtest);
      await backend.stop();
      const before = backend.storage();
      const input = {projectId: IDS.project, title: `Atomic ${boundary}`, requestId: `mutation-wire-${boundary}`};
      const child = writer(subtest, backend, 'shot.create', input, {MIOON_MUTATION_WIRE_BOUNDARY: boundary});
      const exited = await child.finish();
      if (boundary === 'rollback') {
        assert.equal(exited.code, 0); assert.equal(exited.signal, null);
        assert.equal(child.lines().find(value => value.event === 'result').ok, false);
      } else assert.equal(exited.signal, 'SIGKILL', `only the explicit fixture child crashes: ${child.stderr}`);
      const receipt = JSON.parse(await readFile(path.join(backend.root, `receipt-${boundary}.json`), 'utf8'));
      const observed = receipt.uncommitted || receipt.committed;
      assert.equal(observed.shots.length, before.shots.length + 1, 'injection reached the actual business write');
      assert.equal(observed.mutation_requests.length, before.mutation_requests.length + 1, 'injection reached the actual journal write');
      if (boundary !== 'crash-after-commit') assert.deepEqual(backend.storage(), before, 'rollback/crash removes both uncommitted changes');
      else assert.deepEqual(backend.storage(), receipt.committed, 'both committed changes survive process death');
      await backend.restart();
      const recovered = await backend.http('shot.create', input);
      if (boundary === 'crash-after-commit') assert.deepEqual(recovered.data, receipt.result, 'post-commit crash replays the exact result without recreating it');
      const after = backend.storage(), dataVersion = backend.version();
      assert.equal(after.shots.length, before.shots.length + 1);
      assert.equal(after.mutation_requests.length, before.mutation_requests.length + 1);
      assert.deepEqual(await backend.http('shot.create', input), recovered);
      backend.unchanged(after, dataVersion, `${boundary} recovered replay`);
      for (const table of preservedTables) assert.deepEqual(after[table], before[table]);
      assert.equal(await backend.audit(), '');
    });
  }
});
