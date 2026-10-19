import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {createClient, discoverSchema, effectAnnotations} from '../packages/client/src/index.ts';
import {operationEffect} from '../packages/contracts/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {READ_TOOL_DEFINITIONS, READ_TOOL_OPERATIONS, parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {RESTORE_READ_OPERATIONS, RESTORE_LOCAL_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {pillowJfifFixture} from './helpers/timeline-jpeg-fixtures.ts';
import {sha, stamp} from './helpers/timeline-image-fixtures.ts';

const operation = 'timeline.colour.jpeg.inspect';
const pngOperation = 'timeline.colour.image.inspect';
const repo = fileURLToPath(new URL('../', import.meta.url));
const wireGuard = path.join(repo, 'tests/helpers/inspection-wire-fixture.ts');
const token = 'synthetic-timeline-jpeg-transport-token';
const input = {projectId: '11111111-1111-4111-8111-111111111111', assetId: '22222222-2222-4222-8222-222222222222'};
const bytes = pillowJfifFixture('444');
interface DiscoveryView {toolName: string; command: string; requiresRequestId: boolean; inputSchema: {required: string[]; properties: Record<string, unknown>; additionalProperties: boolean}; effects: {notes: string[]; localProcess: boolean; fileEdit?: boolean; [key: string]: unknown}}
interface EvidenceView {colourTag?: string; sampling?: string; sha256?: string; [key: string]: unknown}
interface JpegResponseView {projectId: string; assetId: string; assetSha256: string; kind: string; evidence: EvidenceView; status: string; [key: string]: unknown}
interface AssetFixture {id: string; projectId: string; name: string; mimeType: string; relativePath: string; sizeBytes: number; sha256: string; width: number; height: number; duration: null; hasVideo: boolean; hasAudio: boolean; provenance: string; createdAt: string}
interface WireEnvelope {ok?: boolean; data?: unknown; error?: {code?: string; [key: string]: unknown}; [key: string]: unknown}
const response: JpegResponseView = {...input, assetSha256: sha(bytes), kind: 'image', evidence: {
  profileId: 'jfif-ycbcr8-srgb-v1', sha256: sha(bytes), sourceByteLength: bytes.length,
  width: 17, height: 13, bitDepth: 8, alphaMode: 'opaque', orientation: 1, colourTag: 'untagged',
  sampling: '444', decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1',
}, status: 'needs_interpretation'};

function clientFixture(value: unknown): {client: ReturnType<typeof createClient>; requests: {url: string; headers: unknown; body: unknown}[]} {
  const requests: {url: string; headers: unknown; body: unknown}[] = [];
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:9999', MIOON_TOKEN: token},
    fetchImpl: async (url: RequestInfo | URL, options: RequestInit = {}) => {
      requests.push({url: String(url), headers: options.headers, body: JSON.parse(String(options.body))});
      return new Response(JSON.stringify({ok: true, data: value}), {status: 200});
    }});
  return {client, requests};
}

test('JPEG discovery declares a local decoder but remains read-only, private and outside generic Agent tools', () => {
  const definition = discoverSchema({operation}) as unknown as DiscoveryView;
  assert.equal(definition.toolName, 'timeline_colour_jpeg_inspect');
  assert.equal(definition.command, 'timeline colour jpeg inspect');
  assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(definition.inputSchema.required, ['projectId', 'assetId']);
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), ['assetId', 'projectId']);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.effects, operationEffect(operation));
  const {notes, ...effects} = definition.effects;
  assert.ok(notes.length > 0);
  assert.deepEqual(effects, {readOnly: true, idempotent: true, destructive: false, openWorld: false,
    databaseWrite: false, fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false});
  assert.deepEqual(effectAnnotations(definition.effects as never), {readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false});
  assert.equal(operationEffect(pngOperation).localProcess, false, 'the historical PNG operation stays decoder-free');
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name), [
    'mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect',
  ]);
  assert.deepEqual(Object.values(READ_TOOL_OPERATIONS), ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect']);
  for (const name of ['timeline_colour_jpeg_inspect', 'mioon_timeline_colour_jpeg_inspect'])
    assert.throws(() => parseReadToolArguments(name, JSON.stringify(input)), {code: 'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  assert.equal(RESTORE_READ_OPERATIONS.includes(operation), false);
  assert.equal(RESTORE_LOCAL_OPERATIONS.includes(operation), false);
});

test('JPEG client accepts only exact SHA-bound untagged baseline decoder evidence', async () => {
  for (const sampling of ['444', '422', '420']) {
    const value = {...response, evidence: {...response.evidence, sampling}};
    const f = clientFixture(value);
    assert.deepEqual(await f.client.rpc(operation, input), value);
    assert.deepEqual(f.requests.map(request => request.body), [{operation, input}]);
  }
});

test('JPEG client rejects wrong hash, kind, profile, status and unbounded/path-bearing replies without retry', async () => {
  const invalid = [
    null, {...response, projectId: input.assetId}, {...response, assetId: input.projectId},
    {...response, assetSha256: 'b'.repeat(64)},
    {...response, evidence: {...response.evidence, sha256: 'b'.repeat(64)}},
    {...response, evidence: {...response.evidence, profileId: 'png-rgb8-srgb-v1'}},
    {...response, evidence: {...response.evidence, decoderPolicy: 'auto'}},
    {...response, evidence: {...response.evidence, colourTag: 'srgb'}},
    {...response, status: 'compatible'}, {...response, status: 'unsupported'},
    {...response, kind: 'video'}, {...response, streamIndex: 0}, {...response, reason: null},
    {...response, evidence: {...response.evidence, bitDepth: 16}},
    {...response, evidence: {...response.evidence, width: 4097}},
    {...response, evidence: {...response.evidence, width: 4096, height: 4096}},
    {...response, evidence: {...response.evidence, sourceByteLength: 32 * 1024 * 1024 + 1}},
    {...response, evidence: {...response.evidence, alphaMode: 'straight'}},
    {...response, evidence: {...response.evidence, orientation: 6}},
    {...response, evidence: {...response.evidence, sampling: '411'}},
    {...response, evidence: {...response.evidence, path: '/private/source.jpg'}},
    {...response, relativePath: 'media/source.jpg'}, {...response, dataBase64: bytes.toString('base64')},
  ];
  for (const value of invalid) {
    const f = clientFixture(value);
    await assert.rejects(f.client.rpc(operation, input), (error: unknown) => {
      const failure=error as {code?: string; details?: Record<string, unknown>};
      assert.equal(failure.code, 'BACKEND_PROTOCOL_ERROR');
      assert.notEqual(failure.details?.['submissionMayHaveSucceeded'], true);
      assert.equal(Object.hasOwn(failure.details ?? {}, 'requestId'), false);
      assert.equal(Object.hasOwn(failure.details ?? {}, 'dataBase64'), false);
      return true;
    });
    assert.equal(f.requests.length, 1, 'a malformed read acknowledgement is not retried');
  }
  for (const oldOperation of [pngOperation, 'timeline.colour.source.inspect']) {
    const old = clientFixture(response);
    await assert.rejects(old.client.rpc(oldOperation, input), {code: 'BACKEND_PROTOCOL_ERROR'});
    assert.equal(old.requests.length, 1, 'JPEG does not widen historical PNG or video replies');
  }
});

test('JPEG inspection refuses caller paths, bytes, decoder options and mutation identities before transport', async () => {
  const f = clientFixture(response);
  for (const extra of [{path: '/tmp/source.jpg'}, {relativePath: 'media/source.jpg'}, {url: 'file:///tmp/source.jpg'},
    {dataBase64: bytes.toString('base64')}, {ffmpegArgs: ['-i', '/tmp/source.jpg']},
    {decoderPolicy: response.evidence.decoderPolicy}, {requestId: 'invented-inspection-key'}, {expectedRevision: 1}]) {
    await assert.rejects(f.client.rpc(operation, {...input, ...extra}), {code: 'VALIDATION_ERROR'});
  }
  assert.equal(f.requests.length, 0);
});

async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function childEnvironment(root: string, origin: string, audit: string): Record<string, string> {
  return {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test',
    MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_BASE_URL: origin, MIOON_TOKEN: token,
    MIOON_INSPECTION_WIRE_GUARD: '1', MIOON_INSPECTION_WIRE_ALLOWED_ORIGIN: origin,
    MIOON_INSPECTION_WIRE_AUDIT: audit};
}

interface CliResult {code: number | null; signal: string | null; envelope: WireEnvelope}
async function cli(args: string[], env: Record<string, string | undefined>): Promise<CliResult> {
  const child = spawn(process.execPath, ['--import', wireGuard, 'apps/cli/src/index.ts', ...args],
    {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure: Error | undefined;
  const closed = new Promise<{code: number | null; signal: string | null}>(resolve => { child.once('close', (code: number | null, signal: string | null) => resolve({code, signal})); });
  child.once('error', error => { failure = error; });
  assert.ok(child.stdout && child.stderr);
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as [string, NodeJS.ReadableStream][])
    stream.on('data', (value: string) => {
      if (name === 'stdout') stdout += value; else stderr += value;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024) {
        failure = Error('Owned image CLI output exceeded its bound'); child.kill('SIGKILL');
      }
    });
  try {
    const result = await bounded(closed, 'Owned image CLI response');
    if (failure) throw failure;
    assert.equal(result.signal, null, stderr);
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

function databaseSnapshot(db: DatabaseSync): {rows: [string, Record<string, unknown>[]][]; version: unknown} {
  const rows = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[])
    .map(({name}: {name: string}): [string, Record<string, unknown>[]] => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() as Record<string, unknown>[]]);
  return {rows, version: (db.prepare('PRAGMA data_version').get() as {data_version: unknown}).data_version};
}

interface TransportFixture {root: string; dataDir: string; assets: AssetFixture[]; otherProjectId: string; rpc(name: string, value: Record<string, unknown>, options?: {authenticated?: boolean; expectedWorkspaceOrigin?: string}): Promise<{status: number; envelope: WireEnvelope}>; readonly mediaProcesses: {type?: string; kind?: string}[]; readonly client: ReturnType<typeof createClient>; readonly env: Record<string, string>; snapshot(): {rows: [string, Record<string, unknown>[]][]; version: unknown}; verifyFiles(): Promise<void>; connectMcp(): Promise<{client: Client; call(name: string, value: Record<string, unknown>): Promise<WireEnvelope>}>}
async function fixture(t: import('node:test').TestContext): Promise<TransportFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-jpeg-transports-'));
  const dataDir = path.join(root, 'data'), audit = path.join(root, 'forbidden-effects.jsonl');
  let server: Awaited<ReturnType<typeof startServer>> | undefined, db: DatabaseSync | undefined, mcp: Client | undefined, transport: StdioClientTransport | undefined, off: (() => void) | undefined;
  t.after(async () => {
    try { if (mcp) await bounded(mcp.close(), 'Owned image MCP cleanup', 7_000); }
    finally {
      try { await transport?.close(); }
      finally { off?.(); db?.close(); await server?.close(); await rm(root, {recursive: true, force: true}); }
    }
  });
  await writeFile(audit, '');
  // Seed only fixture-owned bytes and ordinary saved metadata. No asset import,
  // external provider or production application startup is needed. The JPEG
  // operation itself must run its bounded local decoder.
  const store = openStore(dataDir), projectId = input.projectId as string, otherProjectId = randomUUID();
  const fixtures = [bytes, pillowJfifFixture('420')];
  const assets: AssetFixture[] = [];
  try {
    for (const id of [projectId, otherProjectId]) store.put('projects', {id, name: 'Synthetic image inspection',
      description: '', revision: 1, createdAt: stamp, updatedAt: stamp} as never);
    for (const [index, content] of fixtures.entries()) {
      const id = index === 0 ? input.assetId : randomUUID();
      const asset: AssetFixture = {id, projectId, name: 'Synthetic owned JFIF JPEG', mimeType: 'image/jpeg', relativePath: `media/${id}.jpg`,
        sizeBytes: content.length, sha256: sha(content), width: 17, height: 13,
        duration: null, hasVideo: true, hasAudio: false, provenance: 'user-import', createdAt: stamp};
      await writeFile(path.join(dataDir, asset.relativePath), content, {mode: 0o600});
      store.put('assets', asset as never); assets.push(asset);
    }
  } finally { store.close(); }
  const mediaProcesses: {type?: string; kind?: string}[] = [], backendEffects: string[] = [];
  const denyBackendEffect = (kind: string): never => { backendEffects.push(kind); throw Error(`No ${kind} is allowed`); };
  off = onMediaProcess((event: {type?: string; kind?: string}) => { if (event.type === 'started') mediaProcesses.push(event); });
  const open = async () => {
    server = await startServer({dataDir, distDir: path.join(root, 'unused-dist'), port: 0, token,
      imageNetwork: {lookup() { denyBackendEffect('provider DNS'); }, httpsRequest() { denyBackendEffect('provider request'); }},
      chatGateway: async function* () { denyBackendEffect('model request'); }} as never);
    db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), {readOnly: true});
    assert.ok(server);assert.equal(new URL(server.url).hostname, '127.0.0.1');
  };
  await open();
  const rpc = async (name: string, value: Record<string, unknown>, {authenticated = true, expectedWorkspaceOrigin}: {authenticated?: boolean; expectedWorkspaceOrigin?: string} = {}): Promise<{status: number; envelope: WireEnvelope}> => {
    assert.ok(server);
    const result = await fetch(server.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({operation: name, input: value, ...(expectedWorkspaceOrigin ? {expectedWorkspaceOrigin} : {})})});
    return {status: result.status, envelope: await result.json() as WireEnvelope};
  };
  return {root, dataDir, assets, otherProjectId, rpc, mediaProcesses: mediaProcesses as {type?: string; kind?: string}[],
    get client() { assert.ok(server);return createClient({env: {MIOON_BASE_URL: server.url, MIOON_TOKEN: token}}); },
    get env() { assert.ok(server);return childEnvironment(root, server.url, audit); },
    snapshot: () => { assert.ok(db);return databaseSnapshot(db); },
    async verifyFiles() {
      assert.deepEqual((await readdir(path.join(dataDir, 'media'))).sort(), assets.map(asset => path.basename(asset.relativePath)).sort());
      for (const [index, asset] of assets.entries()) assert.deepEqual(await readFile(path.join(dataDir, asset.relativePath)), fixtures[index]);
      assert.equal(await readFile(audit, 'utf8'), '', 'CLI/MCP attempt no non-owned network or media subprocess');
      assert.ok(mediaProcesses.length >= 4, 'JPEG inspection explicitly uses a bounded local decoder');
      assert.equal(mediaProcesses.every(event => event.kind === 'ffmpeg'), true, 'no media process other than FFmpeg is used');
      assert.deepEqual(backendEffects, [], 'inspection never attempts provider or model work, even if errors are caught');
    },
    async connectMcp() {
      assert.ok(server);
      const client = new Client({name: 'timeline-jpeg-inspection-test', version: '1.0.0'}, {capabilities: {}}); mcp = client;
      const stdio = new StdioClientTransport({command: process.execPath, cwd: repo, stderr: 'pipe',
        args: ['--import', wireGuard, 'apps/mcp/src/index.ts'], env: childEnvironment(root, server.url, audit)}); transport = stdio;
      let stderr = '';
      assert.ok(stdio.stderr);(stdio.stderr as unknown as NodeJS.ReadableStream).on('data', (value: string) => { stderr = (stderr + value).slice(-65_536); });
      await bounded(client.connect(stdio), 'Owned image MCP connect');
      return {client, async call(name: string, value: Record<string, unknown>): Promise<WireEnvelope> {
        const result = await client.callTool({name, arguments: value} as never, undefined, {timeout: 5_000}) as {content: {type: string; text: string}[]; structuredContent: WireEnvelope; isError?: boolean};
        assert.equal(stderr.includes(token), false);
        const text = result.content.filter((block: {type: string}) => block.type === 'text');
        assert.equal(text.length, 1); assert.deepEqual(JSON.parse(text[0]?.text ?? '{}'), result.structuredContent);
        assert.equal(Boolean(result.isError), !result.structuredContent.ok);
        return result.structuredContent;
      }};
    },
  };
}
test('actual authenticated HTTP, CLI and official MCP inspect JPEG without changing rows or managed files',
  {timeout: 60_000}, async t => {
    const f = await fixture(t), before = f.snapshot();
    const direct = await f.rpc(operation, input);
    assert.equal(direct.status, 200); assert.deepEqual(direct.envelope, {ok: true, data: response});
    assert.deepEqual(await f.client.rpc(operation, input), response);
    const other = await f.client.rpc(operation, {projectId: input.projectId, assetId: f.assets[1]!.id}) as JpegResponseView;
    assert.equal(other.status, 'needs_interpretation'); assert.equal(other.evidence.colourTag, 'untagged');
    assert.equal(other.evidence.sampling, '420'); assert.equal(other.evidence.sha256, f.assets[1].sha256);
    const decodedBeforeRejections = f.mediaProcesses.length;
    assert.equal((await f.rpc(operation, input, {authenticated: false})).status, 401);
    for (const extra of [{path: '/tmp/not-authorized.jpg'}, {requestId: 'not-a-mutation'}, {dataBase64: bytes.toString('base64')}]) {
      const rejected = await f.rpc(operation, {...input, ...extra});
      assert.equal(rejected.status, 400); assert.equal(rejected.envelope.error?.code, 'VALIDATION_ERROR');
    }
    await assert.rejects(f.client.rpc(operation, {...input, projectId: f.otherProjectId}), {code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
    await assert.rejects(f.client.rpc(pngOperation, input), {code: 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
    assert.equal(f.mediaProcesses.length, decodedBeforeRejections, 'denials do not launch the decoder');

    const command = await cli(['timeline', 'colour', 'jpeg', 'inspect', '--input', JSON.stringify(input)], f.env);
    assert.equal(command.code, 0); assert.deepEqual(command.envelope, direct.envelope);
    const schema = await cli(['schema', operation], f.env);
    assert.equal(schema.code, 0); assert.deepEqual(schema.envelope.data, discoverSchema({operation}));
    const invalidFile = await cli(['timeline', 'colour', 'jpeg', 'inspect', '--input', JSON.stringify(input),
      '--file', path.join(f.root, 'not-readable-and-not-authorized.jpg')], f.env);
    assert.equal(invalidFile.code, 2); assert.equal(invalidFile.envelope.error?.code, 'VALIDATION_ERROR');
    const invalidInput = await cli(['rpc', operation, '--input', JSON.stringify({...input, path: '/private/source.jpg'})], f.env);
    assert.equal(invalidInput.code, 2); assert.equal(invalidInput.envelope.error?.code, 'VALIDATION_ERROR');

    const mcp = await f.connectMcp(), listed = await bounded(mcp.client.listTools(), 'Owned JPEG MCP discovery');
    const tool = listed.tools.find(item => item.name === 'timeline_colour_jpeg_inspect');
    assert.ok(tool); assert.deepEqual(tool.inputSchema, (discoverSchema({operation}) as unknown as DiscoveryView).inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(operationEffect(operation)));
    assert.deepEqual(await mcp.call(tool.name, input), direct.envelope);
    assert.equal((await mcp.call(tool.name, {...input, path: '/private/source.jpg'})).error?.code, 'VALIDATION_ERROR');
    assert.deepEqual((await mcp.call('mioon_schema', {operation})).data, discoverSchema({operation}) as unknown as DiscoveryView);
    assert.deepEqual(f.snapshot(), before, 'all inspections and denials preserve every row and the SQLite commit version');
    await f.verifyFiles();
  });
