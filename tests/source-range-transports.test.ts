import type {PipedProcess,SqlRows,ProcessOutcome,BackendReady,IpcMessage,WireMessage,WireData,WireEnvelope,WireCall} from './helpers/strict-timeline-wire-response-types.ts';
import type {SchemaNode,TestTool,TestCatalog,TestOperationDefinition,EnvelopeTransportCall} from './helpers/strict-timeline-transport-types.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {ChildProcess as OwnedChild} from 'node:child_process';
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
import {PRIVATE, RANGE_IDS} from './helpers/source-range-wire-fixture.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(repo, 'tests/helpers/source-range-wire-fixture.ts');
const pause = (ms?: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const target = {projectId: IDS.project, assetId: IDS.asset};
const operations = ['asset.range.get', 'asset.range.set'];
const oldMutations = ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select'];
const rangeTables = new Set(['asset_ranges', 'asset_range_requests']);
const toolName = (operation: string) => operation.replaceAll('.', '_');
const environment=(extra:NodeJS.ProcessEnv)=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_RANGE_WIRE_GUARD:'1',...extra});
const noPrivate = (value:unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, 'Bearer ']) assert.ok(!text.includes(secret), 'wire output omits fixture-private fields and credentials');
};

async function bounded<T>(promise: Promise<T>, label: string, milliseconds: number|undefined = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Only owned ChildProcess handles are signalled. SDK transport.close similarly
// owns its child and has bounded TERM/KILL escalation in the official SDK.
async function stopOwned(child: OwnedChild|undefined|null) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await bounded(ended, 'Owned child cleanup', 6_000); } finally { clearTimeout(timer); }
}

function launch(t:test.TestContext, args:string[], env:NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure:Error|undefined;
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) stream.setEncoding('utf8').on('data', (chunk: string) => {
    if (name === 'stdout') stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > 512 * 1024) { failure = Error('Owned child exceeded bounded output'); child.kill('SIGKILL'); }
  });
  child.on('error', (error: Error) => { failure = error; });
  const finished = new Promise<ProcessOutcome>(resolve => child.once('close', (code, signal) => resolve({code, signal})));
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
    async finish() { const result = await bounded(finished, 'CLI response'); if (failure) throw failure; return result; },
  };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-range-wire-'));
  const auditPath = path.join(root, 'forbidden-side-effects.jsonl');
  await writeFile(auditPath, '');
  let run!:ReturnType<typeof launch>, db: DatabaseSync, url:string, port = 0;
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const failures = [];
    for (const cleanup of [...cleanups.reverse(), () => stopOwned(run?.child), () => db?.close(),
      () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned range-wire fixture cleanup failed');
  });
  async function start() {
    run = launch(t, [helper, 'server'], {MIOON_DATA_DIR: root, PORT: String(port), MIOON_RANGE_WIRE_AUDIT: auditPath});
    const ready = await run.ready(); url = ready.url; port = Number(new URL(url).port);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal((await fetch(url + '/health', {signal: AbortSignal.timeout(5_000)})).status, 200);
    return ready.pid;
  }
  await start();
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const storage = () => snapshot(db);
  const version = () => (db.prepare('PRAGMA data_version').get())!.data_version;
  const checkpoint = () => ({rows: storage(), version: version()});
  const unchanged = (before:ReturnType<typeof checkpoint>,label:string) => {
    assert.deepEqual(storage(), before.rows, `${label}: all persisted rows stay identical`);
    assert.equal(version(), before.version, `${label}: no extra commit, including equal-value writes`);
  };
  const env = () => ({MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_RANGE_WIRE_ALLOWED_ORIGIN: url, MIOON_RANGE_WIRE_AUDIT: auditPath});
  async function request<O extends string>(operation: O, input?: unknown, expectedError?: string|undefined, base: string|undefined = url, authorization: string = `Bearer ${TOKEN}`):Promise<{raw:string;envelope:WireEnvelope<O>}> {
    const response = await fetch(base + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: JSON.stringify({operation, input})});
    const raw = await response.text(), envelope = JSON.parse(raw); noPrivate(raw);
    assert.equal(envelope.ok, !expectedError, raw);
    if (expectedError) {
      assert.equal(envelope.error.code, expectedError, raw);
      const status = expectedError === 'UNAUTHORIZED' ? 401 : expectedError === 'NOT_FOUND' ? 404 :
        ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_SOURCE_RANGE_RECORD'].includes(expectedError) ? 409 : 400;
      assert.equal(response.status, status, raw);
    } else assert.equal(response.status, 200, raw);
    return {raw, envelope};
  }
  async function cliArgs(args:string[], expectedError?:string|undefined) {
    const child = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args], env());
    const {code, signal} = await child.finish(); noPrivate(child.stdout); noPrivate(child.stderr);
    assert.equal(signal, null, child.stderr);
    const lines = child.lines(); assert.equal(lines.length, 1, 'real CLI returns one JSON envelope');
    const result = lines[0]; assert.equal(result.ok, !expectedError, child.stdout + child.stderr);
    if (expectedError) { assert.notEqual(code, 0); assert.equal(result.error.code, expectedError); assert.match(child.stderr, new RegExp(expectedError)); }
    else assert.equal(code, 0, child.stderr);
    return result;
  }
  const cli = <O extends string>(operation:O,input:unknown,error?:string):Promise<WireEnvelope<O>> => cliArgs([...operation.split('.'), '--input', JSON.stringify(input)], error);
  const client = new Client({name: 'source-range-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, cwd: repo, env: environment(env()), stderr: 'pipe',
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')]});
  let stderr = '';
  (transport.stderr as import('node:stream').Readable)!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
  cleanups.push(() => bounded(client.close(), 'Official MCP cleanup', 7_000));
  await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal((client.getServerVersion())!.name, 'mioon');
  assert.ok((client.getServerCapabilities())!.tools);
  async function mcp<O extends string>(operation: O, input: Record<string, unknown> = {}, expectedError?: string|undefined):Promise<WireEnvelope<O>> {
    const result = (await client.callTool({name: operation === 'mioon_schema' ? operation : toolName(operation), arguments: input}, undefined, {timeout: 5_000})) as CallToolResult;
    noPrivate(result); noPrivate(stderr);
    const blocks = result.content.filter((block) => block.type === 'text');
    assert.equal(blocks.length, 1, 'official SDK receives one text JSON envelope');
    const envelope = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(expectedError), blocks[0].text);
    assert.equal(envelope.ok, !expectedError, blocks[0].text);
    if (expectedError) assert.equal(envelope.error.code, expectedError);
    return envelope;
  }
  return {root, storage, checkpoint, unchanged, request, cli, cliArgs, client, mcp,
    http: (async (...args:Parameters<typeof request>) => (await request(...args)).envelope) as WireCall,
    get url() { return url; }, get pid() { return run.child.pid; },
    restart: async () => { await stopOwned(run.child); return start(); },
    audit: async () => (await readFile(auditPath, 'utf8')).trim(),
  };
}

async function lossProxy(t:test.TestContext, backend:Awaited<ReturnType<typeof fixture>>) {
  let captured!: {raw:string;envelope:WireEnvelope<'asset.range.set'>;submitted:unknown},failure:unknown;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), submitted = JSON.parse(bytes as unknown as string);
      const upstream = await fetch(backend.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: {authorization: request.headers.authorization!, 'content-type': 'application/json'}, body: bytes});
      const raw = await upstream.text(); captured = {raw, envelope: JSON.parse(raw), submitted};
      assert.equal(upstream.status, 200, raw);
      assert.ok(backend.storage().asset_range_requests.some(row => row.requestId === submitted.input.requestId),
        'durable receipt is visible after backend COMMIT and before proxy drops the HTTP response');
      response.destroy();
    } catch (error) { failure = error; response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'Owned proxy cleanup', 5_000); });
  return async (input:unknown) => {
    await assert.rejects(backend.request('asset.range.set', input, undefined, `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`), /fetch failed|socket|network/i);
    if (failure) throw failure;
    assert.deepEqual(captured.submitted, {operation: 'asset.range.set', input});
    return captured;
  };
}

function onlyRangeWrites(before: Record<string,Record<string,unknown>[]>, after: Record<string,Record<string,unknown>[]>, expectedTargets: { revision: number; projectId: string; assetId: string; }[]) {
  assert.deepEqual(Object.keys(after), Object.keys(before), 'saving a range cannot create tables');
  const targets = before.agent_task_target_revisions_v2.map(row => ({...row}));
  for (const {projectId, assetId, revision} of expectedTargets) {
    const index = targets.findIndex(row => row.projectId === projectId && row.kind === 'asset_range' && row.targetId === assetId);
    if (index < 0) targets.push({projectId, kind: 'asset_range', targetId: assetId, revision});
    else {
      assert.equal((targets[index].revision as number) + 1, revision, 'only the saved range target advances once');
      targets[index] = {...targets[index], revision};
    }
  }
  for (const table of Object.keys(before)) if (!rangeTables.has(table))
    assert.deepEqual(after[table], table === 'agent_task_target_revisions_v2' ? targets : before[table], `${table}: only the exact saved range target revisions may change`);
}

function noRangeInspectionFields(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['range', 'sourceRange', 'rangeRevision', 'inFrame', 'outFrame'].includes(key), 'inspection DTOs keep their existing allowlist');
    noRangeInspectionFields(child);
  }
}

test('saved source ranges have exact HTTP, real CLI and official MCP semantics without media work', {timeout: 120_000}, async t => {
  const backend = await fixture(t), drop = await lossProxy(t, backend);
  let original;
  const first = {...target, expectedRevision: 0, requestId: 'source-range-lost-response', inFrame: 7, outFrame: 31};
  const latest = {...target, expectedRevision: 1, requestId: 'source-range-later-save', inFrame: 10, outFrame: 55};

  await t.test('catalog, required keys and effect hints match every public discovery surface', async () => {
    const before = backend.checkpoint(), catalog = discoverSchema() as unknown as TestCatalog;
    assert.deepEqual((await backend.cliArgs(['schema'])).data, catalog);
    assert.deepEqual((await backend.mcp('mioon_schema')).data, catalog);
    const listed = (await backend.client.listTools()).tools;
    for (const operation of operations) {
      const definition = catalog.operations.find((item: { operation: string; }) => item.operation === operation)!, saved = operation.endsWith('.set');
      assert.deepEqual((await backend.cliArgs(['schema', operation])).data, definition);
      assert.deepEqual((await backend.mcp('mioon_schema', {operation})).data, definition);
      const tool = listed.find(item => item.name === toolName(operation));
      assert.deepEqual((tool)!.inputSchema, definition.inputSchema);
      assert.deepEqual([...definition.inputSchema.required].sort(), (saved ?
        ['projectId', 'assetId', 'requestId', 'expectedRevision', 'inFrame', 'outFrame'] : ['projectId', 'assetId']).sort());
      assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.requiresRequestId, saved);
      assert.equal(definition.effects.readOnly, !saved); assert.equal(definition.effects.databaseWrite, saved);
      assert.equal(definition.effects.idempotent, true); assert.equal(((tool)!.annotations)!.idempotentHint, true);
      assert.equal(((tool)!.annotations)!.readOnlyHint, !saved); assert.equal(((tool)!.annotations)!.openWorldHint, false);
      for (const effect of ['fileWrite', 'externalIO', 'localProcess', 'paidGeneration'] as const) assert.equal(definition.effects[effect], false);
      if (saved) {
        assert.equal(definition.inputSchema.properties.expectedRevision.minimum, 0);
        assert.equal(definition.inputSchema.properties.requestId.minLength, 8);
        assert.equal(definition.inputSchema.properties.requestId.maxLength, 200);
      }
    }
    assert.deepEqual(optionalRequestIdOperations(catalog), oldMutations.sort());
    assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name).sort(), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect'].sort());
    assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_propose_shot_update']);
    backend.unchanged(before, 'discovery');
  });

  await t.test('unsaved video/audio reads are non-creating, project scoped and use complete 30fps frames', async () => {
    const before = backend.checkpoint();
    assert.equal(before.rows.asset_ranges.length, 0); assert.equal(before.rows.asset_range_requests.length, 0);
    for (const [assetId, sourceFrameCount] of [[IDS.asset, 60], [RANGE_IDS.audio, 60], [RANGE_IDS.boundary, 61], [RANGE_IDS.long, 36_000]]) {
      const input = {...target, assetId};
      const expected = {ok: true, data: {id: assetId, assetId, projectId: IDS.project, revision: 0, range: null, sourceFrameCount, fps: 30}};
      assert.deepEqual(await backend.http('asset.range.get', input), expected);
      assert.deepEqual(await backend.cli('asset.range.get', input), expected);
      assert.deepEqual(await backend.mcp('asset.range.get', input), expected);
    }
    const foreignProject = {projectId: IDS.other, assetId: IDS.otherAsset};
    assert.equal((await backend.http('asset.range.get', foreignProject)).data.revision, 0);
    assert.ok(!backend.storage().timelines.some(row => row.projectId === IDS.other), 'read must not materialize an absent timeline');
    backend.unchanged(before, 'unsaved reads');
  });

  await t.test('lost committed response replays byte-for-byte after newer save and actual backend restart', async () => {
    const before = backend.storage();
    const inspected = await backend.http('asset.inspect', {projectId: IDS.project, limit: 25});
    noRangeInspectionFields(inspected);
    original = await drop(first);
    assert.deepEqual(original.envelope.data, {id: IDS.asset, ...target, revision: 1, range: {inFrame: 7, outFrame: 31}, sourceFrameCount: 60, fps: 30});
    const committed = backend.checkpoint();
    assert.equal(committed.rows.asset_ranges.length, 1); assert.equal(committed.rows.asset_range_requests.length, 1);
    assert.equal((await backend.request('asset.range.set', first)).raw, original.raw);
    backend.unchanged(committed, 'immediate exact replay');
    const newer = await backend.mcp('asset.range.set', latest);
    assert.equal(newer.data.revision, 2); assert.deepEqual(newer.data.range, {inFrame: 10, outFrame: 55});
    const afterSave = backend.checkpoint();
    assert.deepEqual(await backend.cli('asset.range.set', first), original.envelope);
    assert.deepEqual(await backend.mcp('asset.range.set', first), original.envelope);
    backend.unchanged(afterSave, 'historical replay despite newer range revision');
    const priorPid = backend.pid;
    assert.notEqual(await backend.restart(), priorPid, 'the backend is a new actual process');
    assert.deepEqual(backend.storage(), afterSave.rows);
    const afterRestart = backend.checkpoint();
    assert.equal((await backend.request('asset.range.set', Object.fromEntries(Object.entries(first).reverse()))).raw, original.raw);
    const {requestId, ...fields} = first;
    assert.deepEqual(await backend.cliArgs(['asset', 'range', 'set', '--input', JSON.stringify(fields), '--request-id', requestId]), original.envelope);
    assert.deepEqual(await backend.mcp('asset.range.set', first), original.envelope);
    assert.deepEqual(await backend.http('asset.range.get', target), newer);
    assert.deepEqual(await backend.http('asset.inspect', {projectId: IDS.project, limit: 25}), inspected, 'inspection DTO does not gain range fields');
    backend.unchanged(afterRestart, 'post-restart exact replay and reads');
    onlyRangeWrites(before, backend.storage(), [{...target, revision: 2}]);
  });

  await t.test('changed reuse, stale revision, missing keys and invalid bounds never write', async () => {
    const before = backend.checkpoint();
    for (const changed of [{...first, outFrame: 32}, {...first, expectedRevision: 2}, {...first, assetId: RANGE_IDS.audio},
      {...first, projectId: IDS.other, assetId: IDS.otherAsset}]) {
      const result = await backend.http('asset.range.set', changed, 'IDEMPOTENCY_CONFLICT');
      assert.equal(result.data, undefined); assert.deepEqual(Object.keys(result.error.details), ['requestId']);
      assert.deepEqual(await backend.cli('asset.range.set', changed, 'IDEMPOTENCY_CONFLICT'), result);
      assert.deepEqual(await backend.mcp('asset.range.set', changed, 'IDEMPOTENCY_CONFLICT'), result);
    }
    const fresh = {...first, requestId: 'source-range-fresh-stale'};
    const stale = await backend.http('asset.range.set', fresh, 'REVISION_CONFLICT');
    assert.deepEqual(await backend.cli('asset.range.set', fresh, 'REVISION_CONFLICT'), stale);
    assert.deepEqual(await backend.mcp('asset.range.set', fresh, 'REVISION_CONFLICT'), stale);
    const base = {...first, expectedRevision: 2, requestId: 'source-range-rejected-key'};
    const {requestId: omitted, ...keyless} = base;
    for (const invalid of [keyless, {...base, requestId: 'short'}, {...base, requestId: 'x'.repeat(201)},
      {...base, requestId: null}, {...base, requestId: 42}, {...base, inFrame: -1}, {...base, inFrame: 0.5},
      {...base, outFrame: 7}, {...base, outFrame: Number.MAX_SAFE_INTEGER + 1},
      {...base, expectedRevision: -1}, {...base, expectedRevision: 0.5}, {...base, unexpected: true}]) {
      await backend.http('asset.range.set', invalid, 'VALIDATION_ERROR');
      await backend.cli('asset.range.set', invalid, 'VALIDATION_ERROR');
      await backend.mcp('asset.range.set', invalid, 'VALIDATION_ERROR');
    }
    const outOfBounds = {...base, outFrame: 61};
    const rejected = await backend.http('asset.range.set', outOfBounds, 'SOURCE_BOUNDS');
    assert.deepEqual(await backend.cli('asset.range.set', outOfBounds, 'SOURCE_BOUNDS'), rejected);
    assert.deepEqual(await backend.mcp('asset.range.set', outOfBounds, 'SOURCE_BOUNDS'), rejected);
    for (const operation of operations) await backend.request(operation, operation.endsWith('.set') ? first : target, 'UNAUTHORIZED', undefined, '');
    backend.unchanged(before, 'rejected writes and unauthenticated calls');
    assert.ok(!backend.storage().asset_range_requests.some(row => row.requestId === base.requestId));
    const accepted = await backend.cli('asset.range.set', {...base, inFrame: 59, outFrame: 60});
    assert.equal(accepted.data.revision, 3, 'a rejected key is reusable after correction');
    assert.deepEqual(accepted.data.range, {inFrame: 59, outFrame: 60}, 'exclusive out point permits exactly one complete final frame');
  });

  await t.test('safe ownership and unsupported-media errors agree on all actual transports', async () => {
    const before = backend.checkpoint();
    for (const operation of operations) {
      const set = operation.endsWith('.set'), fields = set ? {expectedRevision: 0, requestId: 'source-range-no-target', inFrame: 0, outFrame: 1} : {};
      let absent;
      for (const scope of [{...target, assetId: RANGE_IDS.missing}, {...target, assetId: IDS.otherAsset},
        {...target, projectId: RANGE_IDS.missing}, {projectId: RANGE_IDS.corruptProject, assetId: RANGE_IDS.mismatchedOwner}]) {
        const input = {...scope, ...fields}, result = await backend.http(operation, input, 'NOT_FOUND');
        assert.deepEqual(result.error.details, {}, 'scope failures reveal no record or definite-not-applied claim');
        if (absent) assert.deepEqual(result, absent, 'missing, foreign and mismatched JSON owner are uniformly safe');
        absent = result;
        assert.deepEqual(await backend.cli(operation, input, 'NOT_FOUND'), result);
        assert.deepEqual(await backend.mcp(operation, input, 'NOT_FOUND'), result);
      }
      const corrupt = {projectId: RANGE_IDS.corruptProject, assetId: RANGE_IDS.mismatchedId, ...fields};
      const invalid = await backend.http(operation, corrupt, 'INVALID_SOURCE_RANGE_RECORD');
      assert.deepEqual(await backend.cli(operation, corrupt, 'INVALID_SOURCE_RANGE_RECORD'), invalid);
      assert.deepEqual(await backend.mcp(operation, corrupt, 'INVALID_SOURCE_RANGE_RECORD'), invalid);
      for (const assetId of [RANGE_IDS.image, RANGE_IDS.unknown]) {
        const input = {...target, assetId, ...fields};
        const result = await backend.http(operation, input, 'SOURCE_RANGE_UNSUPPORTED');
        assert.deepEqual(await backend.cli(operation, input, 'SOURCE_RANGE_UNSUPPORTED'), result);
        assert.deepEqual(await backend.mcp(operation, input, 'SOURCE_RANGE_UNSUPPORTED'), result);
      }
    }
    backend.unchanged(before, 'ownership and media-type failures');
  });

  await t.test('saved audio and long-source ranges are independent metadata and shared replay keys are global', async () => {
    const before = backend.storage();
    const longInput = {...target, assetId: RANGE_IDS.long, expectedRevision: 0, requestId: 'source-range-long-source', inFrame: 20_000, outFrame: 30_000};
    const long = await backend.cli('asset.range.set', longInput);
    assert.equal(long.data.sourceFrameCount, 36_000); assert.deepEqual(long.data.range, {inFrame: 20_000, outFrame: 30_000});
    const audioInput = {...target, assetId: RANGE_IDS.audio, expectedRevision: 0, requestId: 'source-range-audio-source', inFrame: 0, outFrame: 60};
    assert.deepEqual((await backend.mcp('asset.range.set', audioInput)).data.range, {inFrame: 0, outFrame: 60});
    onlyRangeWrites(before, backend.storage(), [
      {...target, assetId: RANGE_IDS.long, revision: 1}, {...target, assetId: RANGE_IDS.audio, revision: 1},
    ]);
    const nodeInput = {projectId: IDS.project, type: 'text', text: 'Legacy keyed mutation', position: {x: 0, y: 0}, requestId: 'source-range-legacy-global-key'};
    await backend.http('node.create', nodeInput);
    const stable = backend.checkpoint();
    for (const [operation, input] of [['asset.range.set', {...longInput, requestId: nodeInput.requestId}],
      ['node.create', {...nodeInput, requestId:first.requestId}]] as const) {
      const result = await backend.http(operation, input, 'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(await backend.cli(operation, input, 'IDEMPOTENCY_CONFLICT'), result);
      assert.deepEqual(await backend.mcp(operation, input, 'IDEMPOTENCY_CONFLICT'), result);
    }
    backend.unchanged(stable, 'cross-operation global key collisions in both directions');
  });

  await t.test('legacy clip insertion copies explicit numeric bounds and later saved ranges cannot change clips', async () => {
    const track = (await backend.http('timeline.track.add', {projectId: IDS.project, expectedRevision: 4,
      requestId: 'source-range-add-track', kind: 'video'})).data;
    const saved = (await backend.http('asset.range.get', target)).data;
    const timeline = (await backend.http('timeline.clip.add', {projectId: IDS.project, assetId: IDS.asset,
      expectedRevision: track.revision, requestId: 'source-range-explicit-clip', trackId: track.tracks[0].id,
      startFrame: 0, sourceInFrame: saved.range!.inFrame, durationFrames: saved.range!.outFrame - saved.range!.inFrame})).data;
    assert.equal(timeline.clips[0].sourceInFrame, 59); assert.equal(timeline.clips[0].durationFrames, 1);
    const before = backend.storage();
    await backend.http('asset.range.set', {...target, expectedRevision: saved.revision, requestId: 'source-range-after-clip', inFrame: 0, outFrame: 30});
    onlyRangeWrites(before, backend.storage(), [{...target, revision: 4}]);
    assert.deepEqual((await backend.http('timeline.get', {projectId: IDS.project})).data, timeline);
    assert.equal(await backend.audit(), '', 'zero model/provider, non-owned network or media subprocess attempts');
    assert.deepEqual((await readdir(path.join(backend.root, 'media')) as unknown), [], 'metadata-only wire fixture never creates media files');
  });
});
