import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {TestCatalog as DiscoverySchemaResult} from './helpers/strict-timeline-transport-types.ts';
import type {TestOperationDefinition as OperationDefinition} from './helpers/strict-timeline-transport-types.ts';
type ImageNetworkSeam = NonNullable<NonNullable<Parameters<typeof startServer>[0]>['imageNetwork']>;
import type {TypedClient as FixtureClient, TypedStore as FixtureStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createClient, discoverSchema, effectAnnotations} from '../packages/client/src/index.ts';
import {operationEffect} from '../packages/contracts/src/index.ts';
import {classifyCurrentWorkspaceSchema, installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {READ_TOOL_DEFINITIONS, READ_TOOL_OPERATIONS, parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {RESTORE_READ_OPERATIONS, RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {png, sha, stamp} from './helpers/timeline-image-fixtures.ts';
import {createServerProject, schemaObjects} from './helpers/project-database.ts';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport';

const operation = 'timeline.colour.image.inspect';
const videoOperation = 'timeline.colour.source.inspect';
const repo = fileURLToPath(new URL('../', import.meta.url));
const wireGuard = path.join(repo, 'tests/helpers/inspection-wire-fixture.ts');
const token = 'synthetic-timeline-image-transport-token';
const input = {projectId: '11111111-1111-4111-8111-111111111111', assetId: '22222222-2222-4222-8222-222222222222'};
const bytes = png({width: 3, height: 2});
const response = {...input, assetSha256: sha(bytes), kind: 'image', evidence: {
  profileId: 'png-rgb8-srgb-v1', sha256: sha(bytes), sourceByteLength: bytes.length,
  width: 3, height: 2, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'srgb',
}, status: 'compatible'};
const videoResponse = {...input, assetSha256: 'a'.repeat(64), streamIndex: 2,
  evidence: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited',
    pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false}, status: 'compatible', reason: null};

function clientFixture(value: string|{ assetSha256: string; kind: string; evidence: { profileId: string; sha256: string; sourceByteLength: number; width: number; height: number; bitDepth: number; alphaMode: string; orientation: number; colourTag: string; }; status: string; projectId: string; assetId: string; }|{ assetSha256: string; streamIndex: number; evidence: { primaries: string; transfer: string; matrix: string; range: string; pixelFormat: string; bitDepth: number; hdrMetadata: boolean; }; status: string; reason: null; projectId: string; assetId: string; }|null) {
  const requests: { url: URL|RequestInfo; headers: HeadersInit|undefined; body: unknown; }[] = [];
  const client = (createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:9999', MIOON_TOKEN: token},
    fetchImpl: async (url, options) => {
      requests.push({url, headers: (options)!.headers, body: JSON.parse((((options)!.body) as unknown as Parameters<typeof JSON.parse>[0]))});
      return new Response(JSON.stringify({ok: true, data: value}), {status: 200});
    }}) as FixtureClient);
  return {client, requests};
}

test('image inspection shares exact bounded effects and does not widen the generic Agent read catalog', () => {
  const definition = (discoverSchema({operation}) as OperationDefinition);
  assert.equal(definition.toolName, 'timeline_colour_image_inspect');
  assert.equal(definition.command, 'timeline colour image inspect');
  assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(definition.inputSchema.required, ['projectId', 'assetId']);
  assert.deepEqual(Object.keys(((definition.inputSchema.properties) as unknown as Parameters<NonNullable<(typeof Object)["keys"]>>[0])).sort(), ['assetId', 'projectId']);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.effects, operationEffect(operation));
  const {notes, ...effects} = definition.effects;
  assert.ok((notes)!.length > 0);
  assert.deepEqual(effects, {readOnly: true, idempotent: true, destructive: false, openWorld: false,
    databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false});
  assert.deepEqual(effectAnnotations(definition.effects), {readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false});
  assert.equal(operationEffect(videoOperation).localProcess, true, 'video probe effects remain separate');
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name), [
    'mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect',
  ]);
  assert.deepEqual(Object.values(READ_TOOL_OPERATIONS), ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect']);
  for (const name of (['timeline_colour_image_inspect', 'mioon_timeline_colour_image_inspect'] as const))
    assert.throws(() => parseReadToolArguments(name, JSON.stringify(input)), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  assert.equal(RESTORE_READ_OPERATIONS.includes(operation), false);
  assert.equal(RESTORE_LOCAL_OPERATIONS.includes(operation), false);
});

test('shared image client preserves SHA-bound image evidence and the historical video DTO unchanged', async () => {
  const untagged = {...response, evidence: {...response.evidence, colourTag: 'untagged'}, status: 'needs_interpretation'};
  for (const [name, value] of ([[operation, response], [operation, untagged], [videoOperation, videoResponse]] as const)) {
    const f = clientFixture(value);
    assert.deepEqual(await f.client.rpc(name, input), value);
    assert.deepEqual(f.requests.map(request => request.body), [{operation: name, input}]);
  }
  assert.deepEqual(Object.keys(videoResponse).sort(), ['assetId', 'assetSha256', 'evidence', 'projectId', 'reason', 'status', 'streamIndex']);
});

test('shared image client rejects foreign, unbound, contradictory and path-bearing DTOs once without mutation uncertainty', async () => {
  const invalid = [
    null, videoResponse,
    {...response, projectId: input.assetId}, {...response, assetId: input.projectId},
    {...response, assetSha256: 'b'.repeat(64)},
    {...response, evidence: {...response.evidence, sha256: 'b'.repeat(64)}},
    {...response, evidence: {...response.evidence, colourTag: 'untagged'}},
    {...response, status: 'needs_interpretation'}, {...response, status: 'unsupported'},
    {...response, kind: 'video'}, {...response, streamIndex: 0}, {...response, reason: null},
    {...response, evidence: {...response.evidence, bitDepth: 16}},
    {...response, evidence: {...response.evidence, width: 4097}},
    {...response, evidence: {...response.evidence, width: 4096, height: 4096}},
    {...response, evidence: {...response.evidence, sourceByteLength: 32 * 1024 * 1024 + 1}},
    {...response, evidence: {...response.evidence, alphaMode: 'premultiplied'}},
    {...response, evidence: {...response.evidence, orientation: 6}},
    {...response, evidence: {...response.evidence, path: '/private/source.png'}},
    {...response, relativePath: 'media/source.png'}, {...response, dataBase64: bytes.toString('base64')},
  ];
  for (const value of invalid) {
    const f = clientFixture(value);
    await assert.rejects(f.client.rpc(operation, input), error => {
      assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code, 'BACKEND_PROTOCOL_ERROR');
      assert.deepEqual((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details, {operation});
      return true;
    });
    assert.equal(f.requests.length, 1, 'invalid read acknowledgement is never retried');
  }
  const old = clientFixture(response);
  await assert.rejects(old.client.rpc(videoOperation, input), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(old.requests.length, 1, 'image evidence never changes the closed video DTO');
});

test('image inspection refuses caller paths, bytes, decoder arguments and request identities before transport', async () => {
  const f = clientFixture(response);
  for (const extra of ([{path: '/tmp/source.png'}, {relativePath: 'media/source.png'}, {url: 'file:///tmp/source.png'},
    {dataBase64: bytes.toString('base64')}, {ffmpegArgs: ['-i', '/tmp/source.png']},
    {requestId: 'invented-image-inspection-key'}, {expectedRevision: 1}] as const)) {
    await assert.rejects(f.client.rpc(operation, {...input, ...extra}), {code: 'VALIDATION_ERROR'});
  }
  assert.equal(f.requests.length, 0);
});

async function bounded<T>(promise: Promise<T>, label: string, ms: number|undefined = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function childEnvironment(root: string, origin: unknown, audit: string) {
  return {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test',
    MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_BASE_URL: origin, MIOON_TOKEN: token,
    MIOON_INSPECTION_WIRE_GUARD: '1', MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: origin,
    MIOON_INSPECTION_WIRE_AUDIT: audit};
}

async function cli(args: string[], env: { PATH: string; HOME: unknown; TMPDIR: unknown; LANG: string; NODE_ENV: string; MIOON_ENABLE_LIVE_PROVIDER: string; MIOON_BASE_URL: unknown; MIOON_TOKEN: string; MIOON_INSPECTION_WIRE_GUARD: string; MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: unknown; MIOON_INSPECTION_WIRE_AUDIT: unknown; }) {
  const child = spawn(process.execPath, ['--import', wireGuard, 'apps/cli/src/index.ts', ...args],
    (({cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']}) as unknown as Parameters<typeof spawn>[2]));
  let stdout = '', stderr = '', failure;
  const closed = new Promise<{ code: number | null | undefined; signal: NodeJS.Signals | null | undefined; }>(resolve => child.once('close', (code?, signal?) => resolve({code, signal})));
  child.once('error', (error?) => { failure = error; });
  for (const [name, stream] of ([['stdout', child.stdout], ['stderr', child.stderr]] as const))
    (stream)!.setEncoding('utf8').on('data', (value: string) => {
      if (name === 'stdout') stdout += value; else stderr += value;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024) {
        failure = Error('Owned image CLI output exceeded its bound'); child.kill('SIGKILL');
      }
    });
  try {
    const result = await bounded(closed, 'Owned image CLI response');
    if (failure) throw failure;
    assert.equal((result.signal as unknown), null, stderr);
    assert.equal(stdout.includes(token) || stderr.includes(token), false);
    assert.equal(stdout.trim().split('\n').length, 1, 'CLI returns one envelope');
    return {...result, envelope: JSON.parse(stdout)};
  } finally {
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1_000);
      try { await bounded(closed, 'Owned image CLI cleanup', 4_000); }
      finally { clearTimeout(kill); }
    }
  }
}

// Read on the server's own connection. data_version counts other connections'
// commits only; total_changes() adds this connection's own writes.
function databaseSnapshot(db: DatabaseSync) {
  const rows = schemaObjects(db).filter(({type, name}) => type === 'table' && !name.startsWith('sqlite_'))
    .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
  return {rows, version: [db.prepare('PRAGMA data_version').get()!.data_version, db.prepare('SELECT total_changes() AS n').get()!.n]};
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-image-transports-'));
  const audit = path.join(root, 'forbidden-effects.jsonl');
  let dataDir = path.join(root, 'data'), source32!: { database: unknown; sha256: unknown; directory: unknown; }, server!:Awaited<ReturnType<typeof startServer>>|undefined, inspect!: InspectProject, mcp!: Client<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }|undefined; },{ [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string|number|undefined; "io.modelcontextprotocol/related-task"?: { taskId: string; }|undefined; }|undefined; }>|undefined, transport!: Transport|StdioClientTransport|undefined, off!: () => void;
  t.after(async () => {
    try { if (mcp) await bounded(mcp.close(), 'Owned image MCP cleanup', 7_000); }
    finally {
      try { await transport?.close(); }
      finally { off?.(); await server?.close(); await rm(root, {recursive: true, force: true}); }
    }
  });
  await writeFile(audit, '');
  // Seed only fixture-owned bytes and ordinary saved metadata. No asset import,
  // external provider, FFmpeg launch or production application startup is needed.
  // The project and the other one are registered where the server finds them;
  // the project ID comes from createServerProject, the asset keeps its fixed ID.
  const created = createServerProject(dataDir, {name: 'Synthetic image inspection'}), store = (created.store as unknown as FixtureStore), projectId = created.projectId;
  const fixtures = [bytes, png({width: 2, height: 1, rgba: false, tagged: false})];
  const assets: ({ id: string; projectId: string; name: string; mimeType: string; relativePath: string; sizeBytes: number; sha256: string; width: number; height: number; duration: null; hasVideo: boolean; hasAudio: boolean; provenance: string; createdAt: string; })[] = [];
  try {
    for (const [index, content] of fixtures.entries()) {
      const id = index === 0 ? input.assetId : randomUUID();
      const asset = {id, projectId, name: 'Synthetic owned PNG', mimeType: 'image/png', relativePath: `media/${id}.png`,
        sizeBytes: content.length, sha256: sha(content), width: index === 0 ? 3 : 2, height: index === 0 ? 2 : 1,
        duration: null, hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: stamp};
      await writeFile(path.join(dataDir, asset.relativePath), content, {mode: 0o600});
      store.put('assets', asset); assets.push(asset);
    }
  } finally { store.close(); }
  const other = createServerProject(dataDir, {name: 'Synthetic image inspection'}), otherProjectId = other.projectId;
  other.store.close();
  const mediaProcesses: (import("../packages/business/src/media-processes.ts").MediaProcessEvent)[] = [], backendEffects: (string)[] = [];
  const denyBackendEffect = (kind: string) => { backendEffects.push(kind); throw Error(`No ${kind} is allowed`); };
  off = onMediaProcess(event => { if (event.type === 'started') mediaProcesses.push(event); });
  const open = async () => {
    server = await startServer({dataDir, distDir: path.join(root, 'unused-dist'), port: 0, token,
      imageNetwork: (({lookup() { denyBackendEffect('provider DNS'); }, httpsRequest() { denyBackendEffect('provider request'); }}) as unknown as ImageNetworkSeam | undefined),
      chatGateway: async function* () { denyBackendEffect('model request'); },
      // Each server that starts hands over its own connection.
      inspectProject: received => { inspect = received; }});
    assert.equal(new URL(server!.url).hostname, '127.0.0.1');
  };
  // The server holds the project while it runs: read on its own connection.
  const use = <T>(read: (db: DatabaseSync) => T): T => inspect(projectId, read);
  await open();
  const rpc = async (name?: string, value?: unknown, {authenticated = true, expectedWorkspaceOrigin}:{authenticated?:boolean;expectedWorkspaceOrigin?:string} = {}) => {
    const result = await fetch((server)!.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({operation: name, input: value, ...(expectedWorkspaceOrigin ? {expectedWorkspaceOrigin} : {})})});
    return {status: result.status, envelope: await result.json()};
  };
  return {root, dataDir, assets, otherProjectId, rpc, mediaProcesses,
    input: {projectId, assetId: input.assetId}, response: {...response, projectId},
    get client() { return (createClient({env: {MIOON_BASE_URL: (server)!.url, MIOON_TOKEN: token}}) as FixtureClient); },
    get env() { return childEnvironment(root, (server)!.url, audit); },
    snapshot: () => use(databaseSnapshot),
    async verifyFiles() {
      assert.deepEqual((await readdir(path.join(dataDir, 'media'))).sort(), assets.map(asset => path.basename(asset.relativePath)).sort());
      for (const [index, asset] of assets.entries()) assert.deepEqual(await readFile(path.join(dataDir, asset.relativePath)), fixtures[index]);
      assert.equal(await readFile(audit, 'utf8'), '', 'CLI/MCP attempt no non-owned network or media subprocess');
      assert.deepEqual((mediaProcesses as unknown), [], 'image inspection never invokes a media process');
      assert.deepEqual((backendEffects as unknown), [], 'inspection never attempts provider or model work, even if errors are caught');
      if (source32) {
        assert.equal(sha(await readFile(((source32.database) as unknown as Parameters<NonNullable<typeof readFile>>[0]))), source32.sha256, 'Installing and serving restored33 cannot change its historical source32 database');
        for (const [index, asset] of assets.entries()) assert.deepEqual(await readFile(path.join(((source32.directory) as unknown as Parameters<typeof path.join>[0]), asset.relativePath)), fixtures[index]);
      }
    },
    async connectMcp(expectedWorkspaceOrigin?: string|undefined) {
      if (mcp) { await bounded(mcp.close(), 'Owned image MCP reconnect cleanup'); mcp = undefined; }
      await transport?.close(); transport = undefined;
      mcp = new Client({name: 'timeline-image-inspection-test', version: '1.0.0'}, {capabilities: {}});
      transport = new StdioClientTransport({command: process.execPath, cwd: repo, stderr: 'pipe',
        args: ['--import', wireGuard, 'apps/mcp/src/index.ts', ...(expectedWorkspaceOrigin ? ['--workspace-origin', expectedWorkspaceOrigin] : [])], env: ((childEnvironment(root, (server)!.url, audit)) as unknown as Record<string, string> | undefined)});
      let stderr = '';
      (((transport as StdioClientTransport).stderr as import('node:stream').Readable|null))!.setEncoding('utf8').on('data', (value: string) => { stderr = (stderr + value).slice(-65_536); });
      await bounded(mcp.connect(transport), 'Owned image MCP connect');
      return {client: mcp, async call(name: string, value: { projectId?: string; assetId?: string; path?: string; operation?: string; }) {
        const result = (await (mcp)!.callTool({name, arguments: value}, undefined, {timeout: 5_000}) as CallToolResult);
        assert.equal(stderr.includes(token), false);
        const text = result.content.filter((block) => block.type === 'text');
        assert.equal(text.length, 1); assert.deepEqual(JSON.parse(text[0].text), result.structuredContent);
        assert.equal(Boolean(result.isError), !(result.structuredContent)!.ok);
        return result.structuredContent;
      }};
    },
    async restore33() {
      if (mcp) { await bounded(mcp.close(), 'Owned image MCP close before restore'); mcp = undefined; }
      await transport?.close(); transport = undefined;
      const {projectRows, assetRows} = use(db => ({projectRows: db.prepare('SELECT id,data FROM projects ORDER BY id').all(),
        assetRows: db.prepare('SELECT id,projectId,data FROM assets ORDER BY id').all()}));
      await server!.close(); server = undefined;
      // Construct the fixed historical schema, never relabel a current database
      // by deleting markers while its newer tables and protections remain.
      const sourceDirectory = path.join(root, 'source32'), sourceDatabase = path.join(sourceDirectory, 'workbench.sqlite');
      await mkdir(path.join(sourceDirectory, 'media'), {recursive:true, mode:0o700});
      await writeFile(sourceDatabase, '', {flag:'wx', mode:0o600});
      const source = new DatabaseSync(sourceDatabase);
      try {
        source.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
        initializeWorkspaceSchemaThrough24(source);
        initializeWorkspaceSchema26(source); initializeWorkspaceSchema28(source);
        initializeWorkspaceSchema30(source); initializeWorkspaceSchema32(source);
        for (const row of projectRows) source.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(row.id, row.data);
        for (const row of assetRows) source.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(row.id, row.projectId, row.data);
        assert.deepEqual(classifyCurrentWorkspaceSchema(source), {schemaVersion:32, profile:'ordinary'});
        assert.deepEqual(source.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => row.version), [...Array.from({length:24}, (_, index) => index + 1),26,28,30,32]);
      } finally { source.close(); }
      for (const [index, asset] of assets.entries()) await writeFile(path.join(sourceDirectory, asset.relativePath), fixtures[index], {mode:0o600});
      source32 = {directory:sourceDirectory, database:sourceDatabase, sha256:sha(await readFile(sourceDatabase))};
      // Installation acts on a separate fixture-owned copy. Retain the exact
      // source database and PNG bytes to verify no historical repair occurs.
      dataDir = path.join(root, 'restored33');
      await mkdir(path.join(dataDir, 'media'), {recursive:true, mode:0o700});
      await copyFile(sourceDatabase, path.join(dataDir, 'workbench.sqlite'));
      for (const asset of assets) await copyFile(path.join(sourceDirectory, asset.relativePath), path.join(dataDir, asset.relativePath));
      const database = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'));
      let restored;
      try {
        database.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
        assert.deepEqual(classifyCurrentWorkspaceSchema(database), {schemaVersion:32, profile:'ordinary'});
        restored = installCurrentWorkspaceRestoreSchema(database, {restorationId: randomUUID(), workspaceOrigin: randomUUID(),
          sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64), sourceDbHash: ((source32.sha256) as unknown as string), createdAt: stamp});
        assert.equal(restored.sourceSchema, 32);
        assert.deepEqual(classifyCurrentWorkspaceSchema(database), {schemaVersion:33, profile:restored.profile});
        assert.deepEqual(database.prepare('SELECT id,data FROM projects ORDER BY id').all(), projectRows);
        assert.deepEqual(database.prepare('SELECT id,projectId,data FROM assets ORDER BY id').all(), assetRows);
      }
      finally { database.close(); }
      assert.equal(restored.schemaVersion, 33);
      assert.equal(sha(await readFile(sourceDatabase)), source32.sha256);
      await open(); return restored;
    },
  };
}

test('actual authenticated HTTP, CLI and official MCP preserve image inspection scope; restored33 refuses even an explicit origin',
  {timeout: 60_000}, async t => {
    const f = await fixture(t), before = f.snapshot();
    // The project ID comes from createServerProject: the requests and the expected response use it.
    const {input, response} = f;
    const direct = await f.rpc(operation, input);
    assert.equal(direct.status, 200); assert.deepEqual(direct.envelope, {ok: true, data: response});
    assert.deepEqual(await f.client.rpc(operation, input), response);
    const untagged = await f.client.rpc(operation, {projectId: input.projectId, assetId: f.assets[1].id});
    assert.equal(untagged.status, 'needs_interpretation'); assert.equal(untagged.evidence.colourTag, 'untagged');
    assert.equal(untagged.evidence.alphaMode, 'opaque'); assert.equal(untagged.evidence.sha256, f.assets[1].sha256);
    assert.equal((await f.rpc(operation, input, {authenticated: false})).status, 401);
    for (const extra of ([{path: '/tmp/not-authorized.png'}, {requestId: 'not-a-mutation'}, {dataBase64: bytes.toString('base64')}] as const)) {
      const rejected = await f.rpc(operation, {...input, ...extra});
      assert.equal(rejected.status, 400); assert.equal(rejected.envelope.error.code, 'VALIDATION_ERROR');
    }
    await assert.rejects(f.client.rpc(operation, {...input, projectId: f.otherProjectId}), {code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});

    const command = await cli(['timeline', 'colour', 'image', 'inspect', '--input', JSON.stringify(input)], f.env);
    assert.equal(command.code, 0); assert.deepEqual(command.envelope, direct.envelope);
    const schema = await cli(['schema', operation], f.env);
    assert.equal(schema.code, 0); assert.deepEqual(schema.envelope.data, (discoverSchema({operation}) as OperationDefinition));
    const invalidFile = await cli(['timeline', 'colour', 'image', 'inspect', '--input', JSON.stringify(input),
      '--file', path.join(f.root, 'not-readable-and-not-authorized.png')], f.env);
    assert.equal(invalidFile.code, 2); assert.equal(invalidFile.envelope.error.code, 'VALIDATION_ERROR');
    const invalidInput = await cli(['rpc', operation, '--input', JSON.stringify({...input, path: '/private/source.png'})], f.env);
    assert.equal(invalidInput.code, 2); assert.equal(invalidInput.envelope.error.code, 'VALIDATION_ERROR');

    const mcp = await f.connectMcp(), listed = await bounded(mcp.client.listTools(), 'Owned image MCP tool discovery');
    const tool = listed.tools.find((item) => item.name === 'timeline_colour_image_inspect');
    assert.ok(tool); assert.deepEqual(tool.inputSchema, (discoverSchema({operation}) as OperationDefinition).inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(operationEffect(operation)));
    assert.deepEqual(await mcp.call(tool.name, input), direct.envelope);
    assert.equal(((await mcp.call(tool.name, {...input, path: '/private/source.png'})) as unknown as import('./helpers/strict-timeline-transport-types.ts').RpcEnvelope<unknown>).error.code, 'VALIDATION_ERROR');
    assert.deepEqual(((await mcp.call('mioon_schema', {operation})))!.data, (discoverSchema({operation}) as OperationDefinition));
    assert.deepEqual(f.snapshot(), before, 'all inspections and rejections preserve every row and the SQLite commit version');
    await f.verifyFiles();

    const restored = await f.restore33(), restoredBefore = f.snapshot();
    const inspection = await f.client.rpc('workspace.restore.inspect', {});
    assert.equal((inspection as {schemaVersion:number}).schemaVersion, 33); assert.equal((inspection as {source:{schemaVersion:number}}).source.schemaVersion, 32);
    for (const expectedWorkspaceOrigin of ([undefined, restored.workspaceOrigin] as const)) {
      const rejected = await f.rpc(operation, input, (({expectedWorkspaceOrigin}) as unknown as Parameters<typeof f.rpc>[2]));
      assert.equal(rejected.status, 409); assert.equal(rejected.envelope.error.code, 'RESTORE_OPERATION_UNAVAILABLE');
      await assert.rejects(f.client.rpc(operation, input, expectedWorkspaceOrigin ? {expectedWorkspaceOrigin} : {}),
        {code: 'RESTORE_OPERATION_UNAVAILABLE'});
      const command = await cli(['timeline', 'colour', 'image', 'inspect', '--input', JSON.stringify(input),
        ...(expectedWorkspaceOrigin ? ['--workspace-origin', expectedWorkspaceOrigin] : [])], f.env);
      assert.equal(command.code, 3); assert.equal(command.envelope.ok, false);
      assert.equal(command.envelope.error.code, 'RESTORE_OPERATION_UNAVAILABLE');
      const restoredMcp = await f.connectMcp(expectedWorkspaceOrigin);
      const rejectedMcp = await restoredMcp.call('timeline_colour_image_inspect', input);
      assert.equal((rejectedMcp)!.ok, false); assert.equal((rejectedMcp as unknown as import('./helpers/strict-timeline-transport-types.ts').RpcEnvelope<unknown>).error.code, 'RESTORE_OPERATION_UNAVAILABLE');
    }
    assert.deepEqual(f.snapshot(), restoredBefore, 'denial does not mutate captured evidence or restoration state');
    await f.verifyFiles();
  });
