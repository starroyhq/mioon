interface DispositionSchema{required:string[];additionalProperties:boolean;properties:Record<string,DispositionSchema>;$ref?:string;items:DispositionSchema;enum:string[];minimum:number;minLength:number;maxLength:number;minItems:number;maxItems:number;format:string}
type DispositionCatalog=Omit<DiscoverySchemaResult,'operations'>&{operations:(Omit<import('@mioon/client').OperationDefinition,'inputSchema'>&{inputSchema:DispositionSchema})[]};
import type {DiscoverySchemaResult} from '@mioon/client';
import type {ChildProcess} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import {optionalRequestIdOperations} from './helpers/catalog-input-branches.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {IDS, TOKEN, snapshot} from './helpers/mutation-wire-fixture.ts';
import {PRIVATE, DISPOSITION_IDS, BATCH_IDS, ORIGINAL_BYTES} from './helpers/asset-disposition-wire-fixture.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/asset-disposition-wire-fixture.ts');
const pause = (ms: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const target = {projectId: IDS.project, assetId: IDS.asset};
const operations = ['asset.disposition.list', 'asset.disposition.set'];
const oldMutations = ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select'];
const dispositionTables = new Set(['asset_dispositions', 'asset_disposition_requests']);
const toolName = (operation: string) => operation.replaceAll('.', '_');
const environment = (extra: NodeJS.ProcessEnv) => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  MIOON_DISPOSITION_WIRE_GUARD: '1', ...extra});
const noPrivate = (value: string|{ [x: string]: unknown; content: ({ type: "text"; text: string; annotations?: { audience?: ("user"|"assistant")[]|undefined; priority?: number|undefined; lastModified?: string|undefined; }|undefined; _meta?: Record<string,unknown>|undefined; }|{ type: "image"; data: string; mimeType: string; annotations?: { audience?: ("user"|"assistant")[]|undefined; priority?: number|undefined; lastModified?: string|undefined; }|undefined; _meta?: Record<string,unknown>|undefined; }|{ type: "audio"; data: string; mimeType: string; annotations?: { audience?: ("user"|"assistant")[]|undefined; priority?: number|undefined; lastModified?: string|undefined; }|undefined; _meta?: Record<string,unknown>|undefined; }|{ type: "resource"; resource: { uri: string; text: string; mimeType?: string|undefined; _meta?: Record<string,unknown>|undefined; }|{ uri: string; blob: string; mimeType?: string|undefined; _meta?: Record<string,unknown>|undefined; }; annotations?: { audience?: ("user"|"assistant")[]|undefined; priority?: number|undefined; lastModified?: string|undefined; }|undefined; _meta?: Record<string,unknown>|undefined; }|{ uri: string; name: string; type: "resource_link"; description?: string|undefined; mimeType?: string|undefined; size?: number|undefined; annotations?: { audience?: ("user"|"assistant")[]|undefined; priority?: number|undefined; lastModified?: string|undefined; }|undefined; _meta?: { [x: string]: unknown; }|undefined; icons?: { src: string; mimeType?: string|undefined; sizes?: string[]|undefined; theme?: "light"|"dark"|undefined; }[]|undefined; title?: string|undefined; })[]; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; structuredContent?: Record<string,unknown>|undefined; isError?: boolean|undefined; }|{ [x: string]: unknown; toolResult: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, 'Bearer ']) assert.ok(!text.includes(secret), 'wire output omits fixture-private fields and credentials');
};

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Only owned ChildProcess handles are signalled. SDK transport.close similarly
// owns its child and has bounded TERM/KILL escalation in the official SDK.
async function stopOwned(child: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 3_000);
  try { await bounded(ended, 'Owned child cleanup', 6_000); } finally { clearTimeout(timer); }
}

// Test-only observation: a timeout remains a failure. Reap this exact handle
// before later subtests, retaining the original deadline error if cleanup fails.
async function finishOwned<T>(finished: Promise<T>, child: ReturnType<typeof spawn>, snapshot: () => unknown, diagnostic: (value:unknown) => unknown) {
  try { return await bounded(finished, 'CLI response'); }
  catch (error) {
    diagnostic(snapshot());
    try { await stopOwned(child); }
    catch { diagnostic({cleanup: 'unconfirmed owned-child close'}); }
    throw error;
  }
}

function launch(t: test.TestContext, args: readonly string[], env: NodeJS.ProcessEnv, label = 'fixture') {
  const started = performance.now(), milestones: {spawnMs?:number;exitMs?:number;exitCode?:number|null;exitSignal?:NodeJS.Signals|null;firstOutputMs?:number;lastOutputMs?:number;closeMs?:number} = {};
  const elapsed = () => Math.round((performance.now() - started) * 1000) / 1000;
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure: Error;
  child.once('spawn', () => { milestones.spawnMs = elapsed(); });
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => { milestones.exitMs = elapsed(); milestones.exitCode = code; milestones.exitSignal = signal; });
  const snapshot = () => {
    const phases: Record<string, string | number>[] = [];
    for (const line of stderr.split('\n')) {
      if (!line.startsWith('MIOON_WIRE_PHASE ')) continue;
      try {
        const row = JSON.parse(line.slice('MIOON_WIRE_PHASE '.length));
        if (!['preload-ready', 'fetch-start', 'fetch-headers', 'fetch-rejected'].includes(row.stage)) continue;
        const safe: Record<string, string | number> = {stage: row.stage};
        for (const key of ['uptimeMs', 'userCPUTime', 'systemCPUTime', 'maxRSS'])
          if (Number.isFinite(row[key]) && row[key] >= 0) safe[key] = row[key];
        phases.push(safe);
      } catch {}
    }
    let envelopeObserved = false;
    try { envelopeObserved = typeof JSON.parse(stdout.trim()).ok === 'boolean'; } catch {}
    return {label, pid: child.pid ?? null, elapsedMs: elapsed(), ...milestones,
      exitCode: child.exitCode, signalCode: child.signalCode,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      envelopeObserved, phases: phases.slice(-16)};
  };
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) stream.setEncoding('utf8').on('data', (chunk: string) => {
    milestones.firstOutputMs ??= elapsed(); milestones.lastOutputMs = elapsed();
    if (name === 'stdout') stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > 512 * 1024) { failure = Error('Owned child exceeded bounded output'); child.kill('SIGKILL'); }
  });
  child.on('error', (error: Error) => { failure = error; });
  const finished = new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve => child.once('close', (code: number | null, signal: NodeJS.Signals | null) => { milestones.closeMs = elapsed(); resolve({code, signal}); }));
  t.after(() => stopOwned(child));
  return {child, get stdout() { return stdout; }, get stderr() { return stderr; },
    lines: () => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        for (const line of stdout.split('\n').slice(0, -1)) {
          const value = JSON.parse(line); if (value.ready) return value;
        }
        noPrivate(stderr);
        assert.equal(child.exitCode, null, `Backend exited before readiness: ${stderr}`);
        assert.equal(child.signalCode, null, 'Backend stopped before readiness');
        await pause(10);
      }
      throw Error('Owned backend startup timed out');
    },
    async finish() { const result = await finishOwned(finished, child, snapshot, (value: unknown) => t.diagnostic(JSON.stringify(value))); if (failure) throw failure; return result; },
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-disposition-wire-'));
  const auditPath = path.join(root, 'forbidden-side-effects.jsonl');
  await writeFile(auditPath, '');
  let run: ReturnType<typeof launch>, db: DatabaseSync, url: string, port = 0;
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const failures: (unknown)[] = [];
    for (const cleanup of [...cleanups.reverse(), () => stopOwned(run?.child), () => db?.close(),
      () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned disposition-wire fixture cleanup failed');
  });
  async function start() {
    run = launch(t, [helper, 'server'], {MIOON_DATA_DIR: root, PORT: String(port), MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
    const ready = await run.ready(); url = ready.url; port = Number(new URL(url).port);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal((await fetch(url + '/health', {signal: AbortSignal.timeout(5_000)})).status, 200);
    return ready.pid;
  }
  await start();
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const storage = () => snapshot(db);
  const version = () => db.prepare('PRAGMA data_version').get()!.data_version;
  const checkpoint = () => ({rows: storage(), version: version()});
  const unchanged = (before: { rows: unknown; version: unknown; }, label: unknown) => {
    assert.deepEqual(storage(), before.rows, `${label}: all persisted rows stay identical`);
    assert.equal(version(), before.version, `${label}: no extra commit, including equal-value writes`);
  };
  const env = () => ({MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_DISPOSITION_WIRE_ALLOWED_ORIGIN: url, MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
  async function request(operation: string, input: unknown, expectedError?: string, base = url, authorization = `Bearer ${TOKEN}`) {
    const response = await fetch(base + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: JSON.stringify({operation, input})});
    const raw = await response.text(), envelope = JSON.parse(raw); noPrivate(raw);
    assert.equal(envelope.ok, !expectedError, raw);
    if (expectedError) {
      assert.equal(envelope.error.code, expectedError, raw);
      const status = expectedError === 'UNAUTHORIZED' ? 401 : expectedError === 'NOT_FOUND' ? 404 :
        ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_ASSET_DISPOSITION_RECORD'].includes(expectedError) ? 409 : 400;
      assert.equal(response.status, status, raw);
    } else assert.equal(response.status, 200, raw);
    return {raw, envelope};
  }
  async function cliArgs(args: readonly string[], expectedError?: string) {
    const label = args.slice(0, args.indexOf('--input') < 0 ? args.length : args.indexOf('--input'))
      .filter((value: string) => /^[a-z][a-z0-9.-]{0,80}$/.test(value)).slice(0, 4).join('.') || 'cli';
    const child = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args],
      {...env(), MIOON_DISPOSITION_PHASE_TRACE: '1'}, label);
    const {code, signal} = await child.finish(); noPrivate(child.stdout); noPrivate(child.stderr);
    assert.equal(signal, null, child.stderr);
    const lines = child.lines(); assert.equal(lines.length, 1, 'real CLI returns one JSON envelope');
    const result = lines[0]; assert.equal(result.ok, !expectedError, child.stdout + child.stderr);
    if (expectedError) { assert.notEqual(code, 0); assert.equal(result.error.code, expectedError); assert.match(child.stderr, new RegExp(expectedError)); }
    else assert.equal(code, 0, child.stderr);
    return result;
  }
  const cli = (operation: string, input: unknown, error?: string) => cliArgs([...operation.split('.'), '--input', JSON.stringify(input)], error);
  const client = new Client({name: 'asset-disposition-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, cwd: repo, env: environment(env()), stderr: 'pipe',
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')]});
  let stderr = '';
  (transport.stderr! as import("node:stream").Readable).setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
  cleanups.push(() => bounded(client.close(), 'Official MCP cleanup', 7_000));
  await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal(client.getServerVersion()!.name, 'mioon');
  assert.ok(client.getServerCapabilities()!.tools);
  async function mcp(operation: string, input: unknown = {}, expectedError?: string) {
    const result = (await client.callTool({name: operation === 'mioon_schema' ? operation : toolName(operation), arguments: input as Record<string, unknown>}, undefined, {timeout: 5_000}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);
    noPrivate(result); noPrivate(stderr);
    const blocks = result.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1, 'official SDK receives one text JSON envelope');
    const envelope = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(expectedError), blocks[0].text);
    assert.equal(envelope.ok, !expectedError, blocks[0].text);
    if (expectedError) assert.equal(envelope.error.code, expectedError);
    return envelope;
  }
  return {root, storage, checkpoint, unchanged, request, cli, cliArgs, client, mcp,
    http: async (...args: Parameters<typeof request>) => (await request(...args)).envelope,
    get url() { return url; }, get pid() { return run.child.pid; },
    stop: () => stopOwned(run.child),
    moveAsset: async () => {
      await stopOwned(run.child);
      const child = launch(t, [helper, 'move-asset'], {MIOON_DATA_DIR: root, MIOON_DISPOSITION_WIRE_AUDIT: auditPath});
      assert.equal((await child.finish()).code, 0, child.stderr);
      assert.deepEqual(child.lines(), [{moved: 1}]);
      return start();
    },
    restart: async () => { await stopOwned(run.child); return start(); },
    audit: async () => (await readFile(auditPath, 'utf8')).trim(),
  };
}

async function lossProxy(t: test.TestContext, backend: Awaited<ReturnType<typeof fixture>>) {
  let captured: { submitted: unknown; raw: string; envelope: unknown; }, failure: unknown;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks: Uint8Array[] = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), submitted = JSON.parse(bytes as unknown as string);
      const upstream = await fetch(backend.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: {authorization: request.headers.authorization!, 'content-type': 'application/json'}, body: bytes});
      const raw = await upstream.text(); captured = {raw, envelope: JSON.parse(raw), submitted};
      assert.equal(upstream.status, 200, raw);
      assert.ok(backend.storage().asset_disposition_requests.some((row: Record<string, unknown>) => row.requestId === submitted.input.requestId),
        'durable receipt is visible after backend COMMIT and before proxy drops the HTTP response');
      response.destroy();
    } catch (error) { failure = error; response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'Owned proxy cleanup', 5_000); });
  return async (input: unknown) => {
    await assert.rejects(backend.request('asset.disposition.set', input, undefined, `http://127.0.0.1:${(server.address()! as import('node:net').AddressInfo).port}`), /fetch failed|socket|network/i);
    if (failure) throw failure;
    assert.deepEqual(captured.submitted, {operation: 'asset.disposition.set', input});
    return captured;
  };
}

function onlyDispositionWrites(before: Record<string,Record<string,unknown>[]>, after: Record<string,Record<string,unknown>[]>, expectedTargets: {assetId:string;revision:number;projectId:string;previousRevision?:number}[]) {
  assert.deepEqual(Object.keys(after), Object.keys(before), 'a disposition cannot create tables');
  const targets=before.agent_task_target_revisions_v2.map(row=>({...row}));
  for(const{projectId,assetId,previousRevision,revision}of expectedTargets){
    const index=targets.findIndex(row=>row.projectId===projectId&&row.kind==='asset_disposition'&&row.targetId===assetId);
    if(index<0){assert.equal(previousRevision,undefined);targets.push({projectId,kind:'asset_disposition',targetId:assetId,revision});}
    else{assert.equal(targets[index].revision,previousRevision,'the exact saved disposition target starts at its expected revision');targets[index]={...targets[index],revision};}
  }
  for (const table of Object.keys(before)) if (!dispositionTables.has(table))
    assert.deepEqual(after[table], table==='agent_task_target_revisions_v2'?targets:before[table], `${table}: only the exact saved disposition target revisions may change`);
}

function noDispositionFields(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['disposition', 'dispositionRevision'].includes(key), 'legacy and Agent DTOs retain their existing field allowlist');
    noDispositionFields(child);
  }
}

const item = (assetId: string, revision = 0, disposition = 'neutral', projectId = IDS.project) =>
  ({id: assetId, assetId, projectId, revision, disposition});
const batch = (assetIds: string|string[], projectId = IDS.project) => ({projectId, assetIds});

// All media is synthetic local fixture data. The guard denies model/provider
// requests, non-owned sockets and media subprocesses in every production child.
test('asset dispositions share exact HTTP, real CLI and official MCP semantics without media work', {timeout: 120_000}, async (t: test.TestContext) => {
  const backend = await fixture(t), drop = await lossProxy(t, backend);
  const originalStorage = backend.storage();
  const first = {...target, expectedRevision: 0, requestId: 'asset-disposition-lost-response', disposition: 'favorite'};
  const second = {...target, expectedRevision: 1, requestId: 'asset-disposition-later-reject', disposition: 'rejected'};
  let original: { envelope: unknown; raw: unknown; }, rejected: unknown;
  const all = async (operation: string, input: unknown, expectedError?: string) => {
    const result = await backend.http(operation, input, expectedError);
    assert.deepEqual(await backend.cli(operation, input, expectedError), result);
    assert.deepEqual(await backend.mcp(operation, input, expectedError), result);
    return result;
  };

  await t.test('discovery preserves strict inputs, bounded lists, required set keys and effect annotations', async () => {
    const before = backend.checkpoint(), catalog = discoverSchema() as unknown as DispositionCatalog;
    assert.deepEqual((await backend.cliArgs(['schema'])).data, catalog);
    assert.deepEqual((await backend.mcp('mioon_schema')).data, catalog);
    const listed = (await backend.client.listTools()).tools;
    for (const operation of operations) {
      const definition = catalog.operations.find((value: { operation: string; }) => value.operation === operation), saved = operation.endsWith('.set');
      assert.ok(definition, `${operation} is publicly discoverable`);
      assert.deepEqual((await backend.cliArgs(['schema', operation])).data, definition);
      assert.deepEqual((await backend.mcp('mioon_schema', {operation})).data, definition);
      const tool = listed.find(value => value.name === toolName(operation));
      assert.deepEqual(tool!.inputSchema, definition.inputSchema);
      assert.deepEqual([...definition.inputSchema.required].sort(), (saved ?
        ['projectId', 'assetId', 'expectedRevision', 'requestId', 'disposition'] : ['projectId', 'assetIds']).sort());
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.requiresRequestId, saved);
      assert.equal(definition.effects.readOnly, !saved); assert.equal(definition.effects.databaseWrite, saved);
      assert.equal(definition.effects.idempotent, true); assert.equal(tool!.annotations!.idempotentHint, true);
      assert.equal(tool!.annotations!.readOnlyHint, !saved); assert.equal(tool!.annotations!.openWorldHint, false);
      for (const effect of ['fileWrite', 'externalIO', 'localProcess', 'paidGeneration']) assert.equal(definition.effects[(effect as keyof typeof definition.effects)], false);
      if (saved) {
        assert.equal(definition.inputSchema.properties.expectedRevision.minimum, 0);
        assert.equal(definition.inputSchema.properties.requestId.minLength, 8);
        assert.equal(definition.inputSchema.properties.requestId.maxLength, 200);
        assert.deepEqual([...definition.inputSchema.properties.disposition.enum].sort(), ['favorite', 'neutral', 'rejected']);
      } else {
        assert.equal(definition.inputSchema.properties.assetIds.minItems, 1);
        assert.equal(definition.inputSchema.properties.assetIds.maxItems, 100);
        const element = definition.inputSchema.properties.assetIds.items;
        const resolved = element.$ref ? element.$ref.slice(2).split('/').reduce((value: DispositionSchema, key: string) => (value as unknown as Record<string,DispositionSchema>)[key], definition.inputSchema) : element;
        assert.equal(resolved.format, 'uuid', 'shared UUID references retain their discovery constraint');
      }
    }
    assert.deepEqual(optionalRequestIdOperations(catalog), [...oldMutations].sort());
    assert.deepEqual(READ_TOOL_DEFINITIONS.map(value => value.name).sort(),
      ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect'].sort());
    assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(value => value.name), ['mioon_propose_shot_update']);
    backend.unchanged(before, 'discovery');
  });

  await t.test('neutral defaults, requested order, all asset types and 100-item boundary are non-creating reads', async () => {
    const before = backend.checkpoint();
    assert.equal(before.rows.asset_dispositions.length, 0); assert.equal(before.rows.asset_disposition_requests.length, 0);
    const ids = [DISPOSITION_IDS.unknown, IDS.asset, DISPOSITION_IDS.image, DISPOSITION_IDS.audio];
    assert.deepEqual(await all('asset.disposition.list', batch(ids)),
      {ok: true, data: {projectId: IDS.project, items: ids.map(id => item(id))}});
    const reverse = [...BATCH_IDS].reverse();
    assert.deepEqual(await all('asset.disposition.list', batch(reverse, DISPOSITION_IDS.batchProject)),
      {ok: true, data: {projectId: DISPOSITION_IDS.batchProject, items: reverse.map(id => item(id, 0, 'neutral', DISPOSITION_IDS.batchProject))}});
    assert.deepEqual(await all('asset.disposition.list', batch([IDS.otherAsset], IDS.other)),
      {ok: true, data: {projectId: IDS.other, items: [item(IDS.otherAsset, 0, 'neutral', IDS.other)]}});
    assert.ok(!backend.storage().timelines.some(row => row.projectId === IDS.other), 'read does not create an absent timeline');
    backend.unchanged(before, 'all neutral and bounded batch reads');
  });

  await t.test('a lost committed result replays exactly after a newer rejection and actual backend restart', async () => {
    const before = backend.storage();
    const inspected = await backend.http('asset.inspect', {projectId: IDS.project, limit: 25});
    const assets = await backend.http('asset.list', {projectId: IDS.project});
    noDispositionFields(inspected); noDispositionFields(assets);
    original = await drop(first);
    assert.deepEqual(original.envelope, {ok: true, data: item(IDS.asset, 1, 'favorite')});
    const committed = backend.checkpoint();
    assert.equal(committed.rows.asset_dispositions.length, 1); assert.equal(committed.rows.asset_disposition_requests.length, 1);
    assert.equal((await backend.request('asset.disposition.set', first)).raw, original.raw);
    backend.unchanged(committed, 'immediate exact replay');
    rejected = await backend.mcp('asset.disposition.set', second);
    assert.deepEqual(rejected, {ok: true, data: item(IDS.asset, 2, 'rejected')});
    const newer = backend.checkpoint();
    assert.deepEqual(await backend.cli('asset.disposition.set', first), original.envelope);
    assert.deepEqual(await backend.mcp('asset.disposition.set', first), original.envelope);
    backend.unchanged(newer, 'historical replay before CAS despite newer rejection');
    const priorPid = backend.pid;
    assert.notEqual(await backend.restart(), priorPid, 'restart launches a new actual backend process');
    assert.deepEqual(backend.storage(), newer.rows);
    const restarted = backend.checkpoint();
    assert.equal((await backend.request('asset.disposition.set', Object.fromEntries(Object.entries(first).reverse()))).raw, original.raw);
    const {requestId, ...fields} = first;
    assert.deepEqual(await backend.cliArgs(['asset', 'disposition', 'set', '--input', JSON.stringify(fields), '--request-id', requestId]), original.envelope);
    assert.deepEqual(await backend.mcp('asset.disposition.set', first), original.envelope);
    assert.deepEqual((await all('asset.disposition.list', batch([IDS.asset]))).data.items, [rejected.data]);
    assert.deepEqual(await backend.http('asset.inspect', {projectId: IDS.project, limit: 25}), inspected);
    assert.deepEqual(await backend.http('asset.list', {projectId: IDS.project}), assets, 'legacy list retains rejected assets and its old DTO');
    backend.unchanged(restarted, 'post-restart reads and replays');
    onlyDispositionWrites(before, backend.storage(), [{...target,revision:2}]);
    assert.deepEqual(await readFile(path.join(backend.root, 'media/original.mp4')), ORIGINAL_BYTES);
  });

  await t.test('changed keys, stale revisions, malformed set inputs and unauthorized calls do not write', async () => {
    const before = backend.checkpoint();
    for (const changed of [{...first, disposition: 'neutral'}, {...first, expectedRevision: 2},
      {...first, assetId: DISPOSITION_IDS.image}, {...first, projectId: IDS.other, assetId: IDS.otherAsset}]) {
      const result = await all('asset.disposition.set', changed, 'IDEMPOTENCY_CONFLICT');
      assert.equal(result.data, undefined); assert.deepEqual(Object.keys(result.error.details), ['requestId']);
    }
    await all('asset.disposition.set', {...first, requestId: 'asset-disposition-fresh-stale'}, 'REVISION_CONFLICT');
    const base = {...first, expectedRevision: 2, requestId: 'asset-disposition-rejected-key'};
    const {requestId: omitted, ...keyless} = base;
    for (const invalid of [keyless, {...base, requestId: 'short'}, {...base, requestId: 'x'.repeat(201)},
      {...base, requestId: null}, {...base, requestId: 42}, {...base, expectedRevision: -1},
      {...base, expectedRevision: 0.5}, {...base, expectedRevision: Number.MAX_SAFE_INTEGER + 1},
      {...base, disposition: 'hidden'}, {...base, disposition: null}, {...base, disposition: true},
      {...base, assetId: 'not-a-uuid'}, {...base, unexpected: true}]) {
      await backend.http('asset.disposition.set', invalid, 'VALIDATION_ERROR');
      await backend.cli('asset.disposition.set', invalid, 'VALIDATION_ERROR');
      await backend.mcp('asset.disposition.set', invalid, 'VALIDATION_ERROR');
    }
    await backend.cliArgs(['asset', 'disposition', 'set', '--input', JSON.stringify(base), '--request-id', 'different-stable-key'], 'VALIDATION_ERROR');
    for (const operation of operations) await backend.request(operation,
      operation.endsWith('.set') ? first : batch([IDS.asset]), 'UNAUTHORIZED', undefined, '');
    backend.unchanged(before, 'all invalid, conflicting and unauthorized requests');
    assert.ok(!backend.storage().asset_disposition_requests.some(row => row.requestId === base.requestId));
  });

  await t.test('batch validation and all-or-nothing ownership failures agree without partial metadata or writes', async () => {
    const before = backend.checkpoint();
    for (const invalid of [{projectId: IDS.project}, batch([]), batch([IDS.asset, IDS.asset]), batch(['not-a-uuid']),
      batch([...BATCH_IDS, DISPOSITION_IDS.image]), {...batch([IDS.asset]), limit: 1}, batch('not-an-array')]) {
      await backend.http('asset.disposition.list', invalid, 'VALIDATION_ERROR');
      await backend.cli('asset.disposition.list', invalid, 'VALIDATION_ERROR');
      await backend.mcp('asset.disposition.list', invalid, 'VALIDATION_ERROR');
    }
    let absent;
    for (const input of [batch([DISPOSITION_IDS.missing]), batch([IDS.otherAsset]),
      batch([IDS.asset, DISPOSITION_IDS.missing]), batch([IDS.asset, IDS.otherAsset]),
      batch([IDS.otherAsset, IDS.asset]), batch([IDS.asset], DISPOSITION_IDS.missing),
      batch([DISPOSITION_IDS.mismatchedOwner], DISPOSITION_IDS.corruptProject)]) {
      const result = await all('asset.disposition.list', input, 'NOT_FOUND');
      assert.equal(result.data, undefined); assert.deepEqual(result.error.details, {});
      if (absent) assert.deepEqual(result, absent, 'missing, mixed and foreign scopes have the same public error');
      absent = result;
    }
    for (const scope of [{...target, assetId: DISPOSITION_IDS.missing}, {...target, assetId: IDS.otherAsset},
      {...target, projectId: DISPOSITION_IDS.missing},
      {projectId: DISPOSITION_IDS.corruptProject, assetId: DISPOSITION_IDS.mismatchedOwner}]) {
      const result = await all('asset.disposition.set', {...scope, expectedRevision: 0,
        requestId: 'asset-disposition-no-target', disposition: 'favorite'}, 'NOT_FOUND');
      assert.deepEqual(result.error.details, {}, 'ownership errors do not claim definite non-application');
      assert.deepEqual(result, absent);
    }
    for (const [operation, input] of [
      ['asset.disposition.list', batch([DISPOSITION_IDS.mismatchedId], DISPOSITION_IDS.corruptProject)],
      ['asset.disposition.set', {projectId: DISPOSITION_IDS.corruptProject, assetId: DISPOSITION_IDS.mismatchedId,
        expectedRevision: 0, requestId: 'asset-disposition-corrupt-identity', disposition: 'favorite'}],
    ] as const) {
      const result = await all(operation, input, 'INVALID_ASSET_DISPOSITION_RECORD');
      assert.equal(result.data, undefined); assert.deepEqual(result.error.details, {});
    }
    backend.unchanged(before, 'batch validation, safe ownership and corrupt-identity failures');
  });

  await t.test('neutral reset retains monotonic revision and supports image, audio and unknown-duration sources', async () => {
    const before = backend.storage();
    const reset = {...target, expectedRevision: 2, requestId: 'asset-disposition-rejected-key', disposition: 'neutral'};
    const neutral = await all('asset.disposition.set', reset);
    assert.deepEqual(neutral, {ok: true, data: item(IDS.asset, 3, 'neutral')}, 'invalid attempts did not consume the corrected request key');
    assert.equal(backend.storage().asset_dispositions.filter(row => row.assetId === IDS.asset).length, 1, 'neutral reset retains its row and revision');
    assert.deepEqual((await all('asset.disposition.list', batch([IDS.asset]))).data.items, [neutral.data]);
    const same = await backend.cli('asset.disposition.set', {...reset, expectedRevision: 3, requestId: 'asset-disposition-new-neutral-intent'});
    assert.deepEqual(same.data, item(IDS.asset, 4, 'neutral'), 'a new same-value intent is a new revision');
    for (const assetId of [DISPOSITION_IDS.image, DISPOSITION_IDS.audio, DISPOSITION_IDS.unknown]) {
      const input = {...target, assetId, expectedRevision: 0, requestId: `asset-disposition-kind-${assetId}`, disposition: 'favorite'};
      assert.deepEqual((await all('asset.disposition.set', input)).data, item(assetId, 1, 'favorite'));
    }
    const after = backend.checkpoint();
    assert.equal((await backend.request('asset.disposition.set', first)).raw, original.raw);
    assert.deepEqual(await all('asset.disposition.set', second), rejected);
    backend.unchanged(after, 'historical favorite/rejected receipts survive neutral reset');
    onlyDispositionWrites(before, backend.storage(), [
      {...target,previousRevision:2,revision:4},
      ...[DISPOSITION_IDS.image,DISPOSITION_IDS.audio,DISPOSITION_IDS.unknown].map(assetId=>({...target,assetId,revision:1})),
    ]);
  });

  await t.test('all eight local mutations share key collision checks while legacy optional behavior remains', async () => {
    const record = (table: string, id: unknown) => JSON.parse(backend.storage()[table].find(row => row.id === id)!.data as string);
    const oldInputs = () => ({
      'shot.create': {projectId: IDS.project, title: 'Legacy keyed shot'},
      'shot.update': {shotId: IDS.shot, expectedRevision: record('shots', IDS.shot).revision, patch: {title: 'Legacy keyed update'}},
      'shot.reorder': {projectId: IDS.project, expectedRevision: record('projects', IDS.project).revision,
        shotIds: backend.storage().shots.filter(row => row.projectId === IDS.project).map(row => row.id).reverse()},
      'node.create': {projectId: IDS.project, type: 'text', text: 'Legacy keyed node', position: {x: 0, y: 0}},
      'node.update': {nodeId: IDS.node, expectedRevision: record('nodes', IDS.node).revision, patch: {text: 'Legacy keyed update'}},
      'version.select': {shotId: IDS.shot, versionId: IDS.version, expectedRevision: record('shots', IDS.shot).revision},
      'asset.range.set': {...target, expectedRevision: 0, requestId: 'overridden', inFrame: 3, outFrame: 31},
    });
    const accepted: ({ operation: string; input: unknown; result: unknown; })[] = [];
    for (const [index, operation] of [...oldMutations, 'asset.range.set'].entries()) {
      const input = {...oldInputs()[(operation as "shot.create"|"shot.update"|"shot.reorder"|"node.create"|"node.update"|"version.select"|"asset.range.set")], requestId: `asset-disposition-shared-legacy-${index}`};
      const result = await all(operation, input);
      accepted.push({operation, input, result});
      const stable = backend.checkpoint();
      await all('asset.disposition.set', {...first, expectedRevision: 4, requestId: input.requestId}, 'IDEMPOTENCY_CONFLICT');
      await all(operation, {...input, requestId: first.requestId}, 'IDEMPOTENCY_CONFLICT');
      backend.unchanged(stable, `${operation} collides with disposition in both directions`);
    }
    const stable = backend.checkpoint();
    for (const {operation, input, result} of accepted) assert.deepEqual(await all(operation, input), result);
    backend.unchanged(stable, 'all existing keyed responses still replay exactly');
    const keyless = {projectId: IDS.project, type: 'text', text: 'Legacy keyless node', position: {x: 1, y: 1}};
    const firstNode = await backend.cli('node.create', keyless), nextNode = await backend.mcp('node.create', keyless);
    assert.notEqual(firstNode.data.id, nextNode.data.id, 'legacy keyless create still creates distinct records');
    assert.equal(backend.storage().mutation_requests.length, stable.rows.mutation_requests.length, 'legacy keyless calls do not gain receipts');
  });

  await t.test('timeline/reference/generation namespaces and explicit clip semantics remain independent', async () => {
    const before = backend.storage();
    for (const requestId of ['mutation-preserved-timeline', 'mutation-preserved-reference', 'mutation-preserved-generation']) {
      const current = (await backend.http('asset.disposition.list', batch([DISPOSITION_IDS.image]))).data.items[0];
      const value = await all('asset.disposition.set', {...target, assetId: DISPOSITION_IDS.image,
        expectedRevision: current.revision, requestId, disposition: 'rejected'});
      assert.equal(value.data.revision, current.revision + 1, 'an existing independent journal key does not collide');
    }
    onlyDispositionWrites(before, backend.storage(), [{...target,assetId:DISPOSITION_IDS.image,previousRevision:1,revision:4}]);
    const current = (await backend.http('asset.disposition.list', batch([IDS.asset]))).data.items[0];
    const baseline = backend.storage();
    await all('asset.disposition.set', {...target, expectedRevision: current.revision,
      requestId: 'asset-disposition-reject-in-use', disposition: 'rejected'});
    onlyDispositionWrites(baseline, backend.storage(), [{...target,previousRevision:4,revision:5}]);
    const timelineBefore = JSON.parse(baseline.timelines.find(row => row.id === IDS.timeline)!.data as string);
    assert.equal(timelineBefore.clips[0].assetId, IDS.asset);
    const timeline = (await backend.http('timeline.clip.add', {projectId: IDS.project, assetId: IDS.asset,
      expectedRevision: timelineBefore.revision, requestId: first.requestId, trackId: DISPOSITION_IDS.track,
      startFrame: 30, sourceInFrame: 0, durationFrames: 10})).data;
    assert.equal(timeline.clips.length, 2, 'an explicitly added rejected source retains legacy clip-add semantics');
    assert.deepEqual(timeline.clips[0], timelineBefore.clips[0], 'rejecting never changes the pre-existing clip');
    for (const table of ['assets', 'versions', 'jobs', 'exports', 'reference_requests', 'idempotency'])
      assert.deepEqual(backend.storage()[table], originalStorage[table], `${table} remains untouched by disposition and legacy tests`);
    assert.deepEqual(await readFile(path.join(backend.root, 'media/original.mp4')), ORIGINAL_BYTES, 'original bytes stay identical');
    assert.deepEqual(await readdir(path.join(backend.root, 'media')), ['original.mp4'], 'no derived media is created');
    assert.equal(await backend.audit(), '', 'zero model/provider, non-owned network or media subprocess attempts');
  });

  await t.test('exact historical replay checks current ownership before exposing a retained response', async () => {
    const before = backend.storage(), priorPid = backend.pid;
    assert.notEqual(await backend.moveAsset(), priorPid);
    assert.deepEqual(backend.storage().asset_disposition_requests, before.asset_disposition_requests, 'ownership test retains historical receipts');
    const changed = backend.checkpoint();
    const result = await all('asset.disposition.set', first, 'NOT_FOUND');
    assert.equal(result.data, undefined); assert.deepEqual(result.error.details, {});
    await all('asset.disposition.list', batch([IDS.asset]), 'NOT_FOUND');
    backend.unchanged(changed, 'foreign-owned targets cannot disclose or rewrite historical receipt data');
    assert.equal(await backend.audit(), '');
  });
});
