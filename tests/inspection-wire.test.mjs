import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HOSTILE, PRIVATE, TOKEN, IDS, NOW, uuid} from './helpers/inspection-wire-fixture.mjs';
import {runInspectionProcess} from './helpers/inspection-wire-lifecycle.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/inspection-wire-fixture.mjs');
const operations = ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect'];
const paged = new Set(['asset.inspect', 'shot.inspect']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolName = operation => operation.replaceAll('.', '_');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFiles = [
  'apps/server/src/index.ts', 'apps/cli/src/index.ts', 'apps/mcp/src/index.ts',
  'packages/business/src/db.ts', 'packages/business/src/services.ts', 'packages/business/src/inspection.ts',
  'packages/business/src/inspection-query.ts', 'packages/contracts/src/index.ts',
  'packages/contracts/src/inspection.ts', 'packages/contracts/src/operation-effects.ts', 'packages/client/src/index.ts',
  'tests/inspection-wire.test.mjs', 'tests/helpers/inspection-wire-fixture.mjs', 'tests/helpers/inspection-wire-lifecycle.mjs',
];
const sourceSnapshot = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')])));

function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:MIOON_|RUNWAY_|ARK_|VEO_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  }
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0',
    MIOON_INSPECTION_WIRE_GUARD: '1', ...extra};
}

async function runCli(args, env, expectedError, testSignal) {
  const {stdout, stderr, code, signal} = await runInspectionProcess(
    ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args], {
      cwd: repo, env: environment({...env, MIOON_INSPECTION_WIRE_TRACE: '1'}), signal: testSignal,
    });
  assert.equal(signal, null, `CLI must terminate normally: ${stderr}`);
  assert.equal(stdout.trim().split('\n').length, 1, 'CLI emits exactly one JSON result envelope');
  assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN), 'CLI never prints the synthetic credential');
  const result = JSON.parse(stdout);
  assert.equal(code, expectedError ? expectedError === 'VALIDATION_ERROR' ? 2 : 6 : 0, stdout + stderr);
  assert.equal(result.ok, !expectedError, stdout + stderr);
  if (expectedError) {
    assert.equal(result.error.code, expectedError, stdout + stderr);
    assert.ok(stderr.includes(expectedError), 'CLI has useful error stderr in addition to JSON stdout');
  }
  return result;
}

async function backendFixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-inspection-wire-'));
  const auditPath = path.join(root, 'forbidden-side-effects.jsonl');
  await writeFile(auditPath, '');
  let child, port = 0, url, readOnly;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { await exit; } finally { clearTimeout(timer); }
  }
  t.after(async () => { readOnly?.close(); await stop(); await rm(root, {recursive: true, force: true}); });
  async function start() {
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [helper, 'server'], {
      cwd: repo, env: environment({MIOON_DATA_DIR: root, PORT: String(port), MIOON_INSPECTION_WIRE_AUDIT: auditPath}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Fixture backend stopped: ${stdout}\n${stderr}`);
      assert.equal(child.signalCode, null, `Fixture backend was killed: ${stdout}\n${stderr}`);
      const line = stdout.split('\n').find(value => value.startsWith('{"ready":true,'));
      if (line) {
        const ready = JSON.parse(line); url = ready.url; port = Number(new URL(url).port);
        assert.equal(new URL(url).hostname, '127.0.0.1');
        assert.equal((await fetch(url + '/health')).status, 200);
        return;
      }
      await pause(20);
    }
    throw Error(`Fixture backend did not become ready: ${stdout}\n${stderr}`);
  }
  await start();
  readOnly = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const tables = readOnly.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  function storage() {
    return Object.fromEntries(tables.map(table => [table, readOnly.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))]));
  }
  const version = () => readOnly.prepare('PRAGMA data_version').get().data_version;
  async function http(operation, input, expectedError) {
    const response = await fetch(url + '/api/rpc', {method: 'POST', redirect: 'error',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const body = await response.json();
    assert.equal(response.status, expectedError ? expectedError === 'INSPECTION_UNAVAILABLE' ? 404 : 400 : 200, JSON.stringify(body));
    assert.equal(body.ok, !expectedError, JSON.stringify(body));
    if (expectedError) assert.equal(body.error.code, expectedError, JSON.stringify(body));
    return body;
  }
  return {root, tables, storage, version, http, get url() { return url; },
    get env() { return {MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: url, MIOON_INSPECTION_WIRE_AUDIT: auditPath}; },
    audit: async () => (await readFile(auditPath, 'utf8')).trim(),
    restart: async () => { await stop(); await start(); },
  };
}

async function mcpFixture(t, env) {
  const client = new Client({name: 'inspection-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath,
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env: environment(env), stderr: 'pipe'});
  let stderr = '';
  transport.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'mioon', 'official SDK initialize negotiates with the actual MCP server');
  assert.ok(client.getServerCapabilities().tools, 'initialize advertises tools capability');
  async function call(name, input = {}, expectedError) {
    const result = await client.callTool({name, arguments: input}, undefined, {timeout: 10_000});
    const textBlocks = result.content.filter(block => block.type === 'text');
    assert.equal(textBlocks.length, 1, 'MCP returns one JSON text envelope');
    const envelope = JSON.parse(textBlocks[0].text);
    assert.deepEqual(result.structuredContent, envelope, 'MCP structured and text content are identical');
    assert.equal(Boolean(result.isError), Boolean(expectedError), textBlocks[0].text);
    assert.equal(envelope.ok, !expectedError, textBlocks[0].text);
    if (expectedError) assert.equal(envelope.error.code, expectedError, textBlocks[0].text);
    assert.ok(!JSON.stringify(result).includes(TOKEN) && !stderr.includes(TOKEN), 'MCP never leaks connection credentials');
    return envelope;
  }
  return {client, call};
}

const bannedKeys = new Set(['projectId', 'path', 'relativePath', 'url', 'urls', 'dataBase64', 'bytes', 'providerJobId', 'jobId',
  'snapshot', 'requestHash', 'token', 'accessToken', 'apiKey', 'secret', 'password', 'authorization', 'parameters']);
function assertSafe(value) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, 'inspect result respects the byte bound');
  assert.ok(!JSON.stringify(value).includes(PRIVATE), 'private structural fields and journal snapshots never enter the result');
  const walk = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, entry] of Object.entries(item)) {
      assert.ok(!bannedKeys.has(key), `inspection excludes structural ${key}`);
      walk(entry);
    }
  };
  walk(value);
}
function exactKeys(value, names) { assert.deepEqual(Object.keys(value).sort(), [...names].sort()); }
function invalidInputs(operation) {
  const base = {projectId: IDS.project};
  const inputs = [{}, {projectId: 'not-a-uuid'}, {projectId: 1}, {projectId: IDS.project, unexpected: true},
    {...base, requestId: 'must-not-be-accepted'}, {...base, projectScope: IDS.other}];
  if (paged.has(operation)) {
    for (const limit of [0, -1, 26, 1.5, '10', null, true]) inputs.push({...base, limit});
    for (const cursor of ['x'.repeat(513), 1, null, {}, []]) inputs.push({...base, cursor});
  } else inputs.push({...base, limit: 1}, {...base, cursor: 'not-supported'});
  return inputs;
}

// One sequential fixture bounds process concurrency to the backend, one MCP
// server and at most one CLI child. No provider/media generation is used.
test('scoped inspection is read-only and identical over actual HTTP, CLI, and official MCP stdio', {timeout: 120_000}, async t => {
  const sourceHashes = await sourceSnapshot();
  const backend = await backendFixture(t);
  let mcp;
  const report = {scenario: 'scoped inspection actual transport parity', simulated: true, officialMcpSdk: true,
    sourceHashes, startedAt: new Date().toISOString(), initialize: null, cases: [], zeroWrites: [], schemas: [], failures: [], forbiddenSideEffects: null};
  const section = (name, run) => t.test(name, async subtest => {
    try { await run(subtest); }
    catch (error) { report.failures.push({section: name, message: error.message}); throw error; }
  });
  const initial = backend.storage(), initialVersion = backend.version();
  assert.ok(backend.tables.length >= 20, 'the snapshot covers business, timeline, reference, workspace and chat journals');
  for (const table of ['projects', 'assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines',
    'timeline_requests', 'timeline_history', 'timeline_history_cursors', 'reference_requests', 'idempotency', 'job_events',
    'workspace_preferences', 'agent_chat_threads', 'agent_chat_requests', 'agent_chat_runs', 'agent_chat_events', 'agent_chat_quota']) {
    assert.ok(initial[table]?.length > 0, `${table} has sentinel rows, not just an empty-table write check`);
  }
  const cli = (operation, input, error) => runCli([...operation.split('.'), '--input', JSON.stringify(input)], backend.env, error, t.signal);
  async function parity(operation, input, error) {
    const http = await backend.http(operation, input, error);
    assert.deepEqual(await cli(operation, input, error), http, `${operation} CLI/HTTP envelope parity`);
    assert.deepEqual(await mcp.call(toolName(operation), input, error), http, `${operation} official MCP/HTTP envelope parity`);
    if (!error) assertSafe(http.data);
    else if (error !== 'VALIDATION_ERROR') assert.deepEqual(http.error.details, {}, 'inspection failures expose no record or project metadata');
    report.cases.push({operation, arguments: {...input, ...(input.cursor ? {cursor: '<signed cursor>'} : {})}, expectedError: error || null,
      resultDigest: digest(http), resultBytes: Buffer.byteLength(JSON.stringify(http))});
    return error ? http.error : http.data;
  }
  function unchanged(label, before = initial, dataVersion = initialVersion) {
    assert.deepEqual(backend.storage(), before, `${label}: every table remains byte-for-byte identical`);
    assert.equal(backend.version(), dataVersion, `${label}: no committed writes, including writes of equal data`);
    report.zeroWrites.push({label, tables: backend.tables, snapshotSha256: digest(before), dataVersionUnchanged: true});
  }

  await section('CLI schema and MCP initialize/list/schema expose identical strict inputs and explicit effects offline', async subtest => {
    const offlineEnv = {MIOON_INSPECTION_WIRE_AUDIT: path.join(backend.root, 'forbidden-side-effects.jsonl')};
    const offline = await mcpFixture(subtest, offlineEnv);
    report.initialize = offline.client.getServerVersion();
    const catalog = (await runCli(['schema'], offlineEnv, undefined, subtest.signal)).data;
    assert.deepEqual((await offline.call('mioon_schema')).data, catalog);
    const tools = (await offline.client.listTools()).tools;
    for (const operation of [...operations, 'project.get', 'timeline.get']) {
      const definition = (await runCli(['schema', operation], offlineEnv, undefined, subtest.signal)).data;
      const tool = tools.find(item => item.name === toolName(operation));
      assert.ok(tool, `${operation} is discoverable`);
      assert.deepEqual(definition, catalog.operations.find(item => item.operation === operation));
      assert.deepEqual((await offline.call('mioon_schema', {operation})).data, definition);
      assert.deepEqual(tool.inputSchema, definition.inputSchema);
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.inputSchema.properties.projectId.format, 'uuid');
      assert.equal(definition.requiresRequestId, false);
      assert.equal(definition.command, operation.replaceAll('.', ' '));
      assert.equal(definition.toolName, tool.name);
      const inspection = operations.includes(operation), effects = definition.effects;
      assert.equal(effects.readOnly, inspection);
      assert.equal(effects.databaseWrite, !inspection);
      assert.equal(effects.idempotent, true);
      for (const flag of ['destructive', 'openWorld', 'fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(effects[flag], false);
      assert.ok(typeof effects.notes === 'string' && effects.notes.length);
      assert.deepEqual(tool.annotations, {readOnlyHint: effects.readOnly, destructiveHint: effects.destructive,
        idempotentHint: effects.idempotent, openWorldHint: effects.openWorld});
      assert.deepEqual(definition.inputSchema.required, ['projectId']);
      exactKeys(definition.inputSchema.properties, paged.has(operation) ? ['projectId', 'limit', 'cursor'] : ['projectId']);
      if (paged.has(operation)) {
        assert.equal(definition.inputSchema.properties.limit.type, 'integer');
        assert.equal(definition.inputSchema.properties.limit.minimum, 1);
        assert.equal(definition.inputSchema.properties.limit.maximum, 25);
        assert.equal(definition.inputSchema.properties.limit.default, 10);
        assert.equal(definition.inputSchema.properties.cursor.maxLength, 512);
      }
      report.schemas.push(definition);
    }
    unchanged('Discovery');
  });

  mcp = await mcpFixture(t, backend.env);

  await section('strict argument validation is identical on all three interfaces', async () => {
    for (const operation of operations) for (const input of invalidInputs(operation)) await parity(operation, input, 'VALIDATION_ERROR');
    unchanged('Invalid input');
  });


  await section('HTTP authentication and local-origin checks still protect every inspection operation', async () => {
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'UNAUTHORIZED'],
        [{authorization: 'Bearer synthetic-wrong-token'}, 401, 'UNAUTHORIZED'],
        [{authorization: `Bearer ${TOKEN}`, origin: 'https://untrusted.invalid'}, 403, 'ORIGIN_REJECTED'],
      ]) {
        const response = await fetch(backend.url + '/api/rpc', {method: 'POST', redirect: 'error',
          headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify({operation, input: {projectId: IDS.project}})});
        const result = await response.json();
        assert.equal(response.status, status); assert.equal(result.ok, false); assert.equal(result.error.code, code);
        assert.ok(!JSON.stringify(result).includes(TOKEN));
      }
    }
    report.authentication = {operationsChecked: operations, unauthorizedRejected: true, untrustedOriginRejected: true};
    unchanged('Authentication and origin rejection');
  });

  let oldCursor;
  await section('bounded allowlisted DTOs retain hostile metadata only as inert text', async () => {
    const project = await parity('project.inspect', {projectId: IDS.project});
    assert.deepEqual(project, {id: IDS.project, name: HOSTILE, description: HOSTILE, revision: 7,
      counts: {assets: 27, shots: 27, nodes: 1, edges: 1, jobs: 1, versions: 1, exports: 1, timelines: 1}});
    const assets = await parity('asset.inspect', {projectId: IDS.project});
    assert.equal(assets.items.length, 10, 'default page is ten');
    assert.deepEqual(assets.items[0], {id: IDS.asset, name: HOSTILE, mimeType: 'image/png', width: 720, height: 1280,
      duration: 0, hasAudio: false, hasVideo: true, provenance: 'user-import', createdAt: NOW});
    oldCursor = assets.nextCursor;
    assert.ok(typeof oldCursor === 'string' && oldCursor.length <= 512);
    const shots = await parity('shot.inspect', {projectId: IDS.project});
    assert.equal(shots.items.length, 10);
    const selected = shots.items[0];
    exactKeys(selected, ['id', 'title', 'prompt', 'promptTruncated', 'referenceAssetIds', 'aspectRatio', 'duration', 'orderIndex', 'revision', 'selectedVersionId', 'selectedVersion']);
    assert.equal(selected.title, HOSTILE); assert.equal(selected.prompt, HOSTILE); assert.equal(selected.promptTruncated, false);
    assert.deepEqual(selected.referenceAssetIds, [IDS.asset]);
    assert.equal(selected.selectedVersionId, IDS.version);
    assert.deepEqual(selected.selectedVersion, {id: IDS.version, number: 1, assetId: IDS.asset, providerId: 'mock', model: 'synthetic-model', isMock: true, createdAt: NOW});
    const excerpt = shots.items[1];
    assert.equal(excerpt.promptTruncated, true);
    assert.ok(Buffer.byteLength(excerpt.prompt) <= 1000);
    assert.ok((HOSTILE + '🧪'.repeat(800)).startsWith(excerpt.prompt));
    assert.ok(!excerpt.prompt.includes('\ufffd'), 'UTF-8 excerpt does not split a character');
    assert.equal(excerpt.selectedVersionId, null); assert.equal(excerpt.selectedVersion, null);
    const timeline = await parity('timeline.inspect', {projectId: IDS.project});
    assert.deepEqual(timeline, {id: IDS.timeline, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 60,
      tracks: [{id: IDS.track, name: HOSTILE, kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [{id: IDS.clip, trackId: IDS.track, assetId: IDS.asset, name: HOSTILE, startFrame: 0, durationFrames: 60,
        sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}]});
    assert.equal(await backend.audit(), '', 'hostile saved text produces no model, provider, network or subprocess activity');
    unchanged('Safe metadata DTOs');
  });

  await section('pages are stable, bounded, exhaustive, and cursors bind project, operation and page size', async () => {
    for (const operation of ['asset.inspect', 'shot.inspect']) {
      const single = await parity(operation, {projectId: IDS.project, limit: 1});
      assert.equal(single.items.length, 1);
      const maximum = await parity(operation, {projectId: IDS.project, limit: 25});
      assert.equal(maximum.items.length, 25);
      const last = await parity(operation, {projectId: IDS.project, limit: 25, cursor: maximum.nextCursor});
      assert.equal(last.items.length, 2); assert.equal(last.nextCursor, null);
      const all = [...maximum.items, ...last.items].map(item => item.id);
      assert.equal(new Set(all).size, 27);
      assert.deepEqual(all, Array.from({length: 27}, (_, index) => uuid((operation === 'asset.inspect' ? 100 : 200) + index)), 'ascending ID pagination has no duplicates or omitted rows');
      assert.deepEqual(await parity(operation, {projectId: IDS.project, limit: 25}), maximum, 'repeat page is stable');
      await parity(operation, {projectId: IDS.other, limit: 1, cursor: single.nextCursor}, 'INVALID_CURSOR');
      await parity(operation === 'asset.inspect' ? 'shot.inspect' : 'asset.inspect', {projectId: IDS.project, limit: 1, cursor: single.nextCursor}, 'INVALID_CURSOR');
      await parity(operation, {projectId: IDS.project, limit: 2, cursor: single.nextCursor}, 'INVALID_CURSOR');
      await parity(operation, {projectId: IDS.project, limit: 1, cursor: `${single.nextCursor.slice(0, -1)}${single.nextCursor.endsWith('A') ? 'B' : 'A'}`}, 'INVALID_CURSOR');
      for (const cursor of ['', 'not-a-cursor', 'x'.repeat(512)]) await parity(operation, {projectId: IDS.project, cursor}, 'INVALID_CURSOR');
      const empty = await parity(operation, {projectId: IDS.absentTimeline});
      assert.deepEqual(empty, {items: [], nextCursor: null});
      const foreign = await parity(operation, {projectId: IDS.other});
      assert.deepEqual(foreign.items.map(item => item.id), [operation === 'asset.inspect' ? IDS.otherAsset : IDS.otherShot]);
    }
    unchanged('Pagination and cursor rejection');
  });

  await section('missing timelines stay absent and corrupt cross-project links fail uniformly without leakage', async () => {
    for (let repeat = 0; repeat < 2; repeat++) assert.equal(await parity('timeline.inspect', {projectId: IDS.absentTimeline}), null);
    const summary = await parity('project.inspect', {projectId: IDS.absentTimeline});
    assert.equal(summary.counts.timelines, 0);
    const missingErrors = [];
    for (const operation of operations) missingErrors.push(await parity(operation, {projectId: IDS.missing}, 'INSPECTION_UNAVAILABLE'));
    for (const error of missingErrors) assert.deepEqual(error, missingErrors[0]);
    for (const [operation, projectId] of [
      ['shot.inspect', IDS.foreignReference], ['shot.inspect', IDS.foreignSelection], ['timeline.inspect', IDS.foreignClip],
      ['asset.inspect', IDS.mismatchedAsset], ['shot.inspect', IDS.mismatchedShot], ['timeline.inspect', IDS.mismatchedTimeline],
      ['shot.inspect', IDS.foreignVersionAsset], ['shot.inspect', IDS.foreignVersionJob],
    ]) assert.deepEqual(await parity(operation, {projectId}, 'INSPECTION_UNAVAILABLE'), missingErrors[0]);
    unchanged('Absent and corrupt project inspection');
    assert.equal(await backend.audit(), '');
  });

  await section('signed cursors expire after backend restart without requiring a different CLI or MCP connection', async () => {
    unchanged('All inspection calls before restart');
    await backend.restart();
    const restarted = backend.storage(), restartedVersion = backend.version();
    assert.deepEqual(restarted, initial, 'recovery does not modify already-terminal synthetic records');
    await parity('asset.inspect', {projectId: IDS.project, cursor: oldCursor}, 'INVALID_CURSOR');
    const fresh = await parity('asset.inspect', {projectId: IDS.project});
    assert.ok(fresh.nextCursor && fresh.nextCursor !== oldCursor);
    assert.equal(await parity('timeline.inspect', {projectId: IDS.absentTimeline}), null);
    unchanged('Post-restart inspection', restarted, restartedVersion);
  });

  await section('legacy get initialization and exact request replay retain their established mutation semantics', async () => {
    // This separate final phase intentionally uses legacy writes after all
    // inspection zero-write assertions, only in its own untouched projects.
    assert.equal((await backend.http('timeline.inspect', {projectId: IDS.legacyGet})).data, null);
    const fromProject = (await backend.http('project.get', {projectId: IDS.legacyGet})).data;
    assert.ok(fromProject.timeline.id);
    assert.deepEqual((await cli('project.get', {projectId: IDS.legacyGet})).data, fromProject);
    assert.deepEqual((await mcp.call('project_get', {projectId: IDS.legacyGet})).data, fromProject);
    assert.equal((await backend.http('timeline.inspect', {projectId: IDS.legacyTimeline})).data, null);
    const created = (await backend.http('timeline.get', {projectId: IDS.legacyTimeline})).data;
    assert.ok(created.id); assert.equal(created.revision, 1);
    assert.deepEqual((await cli('timeline.get', {projectId: IDS.legacyTimeline})).data, created);
    assert.deepEqual((await mcp.call('timeline_get', {projectId: IDS.legacyTimeline})).data, created);
    const input = {projectId: IDS.legacyTimeline, expectedRevision: created.revision, requestId: 'inspection-wire-legacy-exact-replay', kind: 'video', name: 'Synthetic replay sentinel'};
    const edited = await backend.http('timeline.track.add', input);
    const afterMutation = backend.storage(), afterMutationVersion = backend.version();
    assert.deepEqual(await cli('timeline.track.add', input), edited);
    assert.deepEqual(await mcp.call('timeline_track_add', input), edited);
    await parity('timeline.inspect', {projectId: IDS.legacyTimeline});
    unchanged('Legacy exact replay plus inspection', afterMutation, afterMutationVersion);
    report.legacy = {projectGetInitializesTimeline: true, timelineGetInitializesTimeline: true, exactRequestReplayPreserved: true};
  });

  report.forbiddenSideEffects = await backend.audit();
  assert.equal(report.forbiddenSideEffects, '', 'there were zero attempted forbidden model/provider/network/media side effects');
  assert.deepEqual(report.failures, [], 'failed sections cannot produce a successful evidence report');
  assert.deepEqual(await sourceSnapshot(), sourceHashes, 'tested source files remained frozen throughout the run');
  report.status = 'passed';
  report.finishedAt = new Date().toISOString();
  report.parityCaseCount = report.cases.length;
  report.parityInterfaceChecks = report.cases.length * 3;
  if (process.env.MIOON_INSPECTION_EVIDENCE_DIR) {
    const directory = path.resolve(process.env.MIOON_INSPECTION_EVIDENCE_DIR);
    await mkdir(directory, {recursive: true});
    await writeFile(path.join(directory, 'inspection-wire-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
});
