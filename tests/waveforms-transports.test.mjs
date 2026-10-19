import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {openStore} from '../packages/business/src/db.ts';
import {discoverSchema} from '../packages/client/src/index.ts';
import {parse, operationEffect, isWaveformResponse, WAVEFORM_ALGORITHM, WAVEFORM_MAX_POINTS} from '../packages/contracts/src/index.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {IDS, TOKEN, NOW, uuid, snapshot, seedMutationStore} from './helpers/mutation-wire-fixture.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const target = {projectId: IDS.project, assetId: IDS.asset};
const alias = uuid(81), imageId = uuid(82), missingId = uuid(9999);
const operations = ['asset.waveform.request', 'asset.waveform.get'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const toolName = operation => operation.replaceAll('.', '_');
const PRIVATE = 'WAVEFORM_PRIVATE_FIXTURE_MARKER';
const environment = extra => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra});
const noPrivate = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, 'Bearer ']) assert.ok(!text.includes(secret), 'public result omits fixture-private fields and credentials');
};

async function bounded(promise, label, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await bounded(ended, 'Owned child cleanup', 8_000); } finally { clearTimeout(timer); }
}
function launch(t, args, env) {
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure;
  // JSON descriptions may cross pipe chunks inside a UTF-8 character.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.setEncoding('utf8').on('data', chunk => {
    if (name === 'stdout') stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > 512 * 1024) { failure = Error('Owned child exceeded bounded output'); child.kill('SIGKILL'); }
  });
  child.on('error', error => { failure = error; });
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  t.after(() => stopOwned(child));
  return {child, get stdout() { return stdout; }, get stderr() { return stderr; },
    lines: () => stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        for (const line of stdout.split('\n').slice(0, -1)) { const value = JSON.parse(line); if (value.ready) return value; }
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

// An in-memory PCM WAV keeps every input synthetic and requires no fixture
// generator subprocess. Peak amplitude changes halfway through its two seconds.
function syntheticWav() {
  const rate = 48_000, channels = 2, frames = rate * 2, dataBytes = frames * channels * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  for (let sample = 0; sample < frames; sample++) {
    const amplitude = sample < rate ? 0.25 : 0.75;
    const value = Math.round(Math.sin(sample * 2 * Math.PI * 440 / rate) * amplitude * 32767);
    bytes.writeInt16LE(value, 44 + sample * 4); bytes.writeInt16LE(-value, 46 + sample * 4);
  }
  return bytes;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-waveform-wire-'));
  let run, url, port = 0, db;
  const cleanups = [];
  t.after(async () => {
    const failures = [];
    for (const cleanup of [...cleanups.reverse(), () => stopOwned(run?.child), () => db?.close(), () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned waveform fixture cleanup failed');
  });
  const dataDir = path.join(root, 'data'), auditPath = path.join(root, 'network-denials.jsonl');
  const mediaAudit = path.join(root, 'media-processes.jsonl'), helper = path.join(root, 'wire-helper.mjs');
  await writeFile(auditPath, ''); await writeFile(mediaAudit, '');
  await seedMutationStore(dataDir);
  const wav = syntheticWav(), sha256 = createHash('sha256').update(wav).digest('hex');
  const relativePath = `media/${PRIVATE}.wav`, seed = openStore(dataDir);
  try {
    await writeFile(path.join(dataDir, relativePath), wav, {mode: 0o600});
    const audio = (id, projectId) => ({id, projectId, name: 'Synthetic source waveform', mimeType: 'audio/wav',
      relativePath, sha256, sizeBytes: wav.length, duration: 2, hasVideo: false, hasAudio: true, provenance: 'user-import', createdAt: NOW});
    seed.put('assets', audio(IDS.asset, IDS.project)); seed.put('assets', audio(alias, IDS.project));
    seed.put('assets', audio(IDS.otherAsset, IDS.other));
    seed.put('assets', {...audio(imageId, IDS.project), mimeType: 'image/png', hasVideo: true, hasAudio: false, duration: 0, sha256: '9'.repeat(64)});
  } finally { seed.close(); }
  // Guards are installed before production imports in every real child. Only
  // backend spawn of local FFmpeg/ffprobe is admitted; CLI/MCP cannot spawn.
  // The optional gate is a bounded synthetic owned decoder used solely to
  // establish a running attempt before graceful shutdown (no orphaned child).
  await writeFile(helper, `
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {installWireGuard} from ${JSON.stringify(pathToFileURL(path.join(repo, 'tests/helpers/inspection-wire-fixture.mjs')).href)};
const originalSpawn = childProcess.spawn;
const serverMode = process.argv[2] === 'waveform-server';
const {deny} = installWireGuard({origin:process.env.MIOON_WAVEFORM_WIRE_ORIGIN || '',auditPath:process.env.MIOON_WAVEFORM_WIRE_AUDIT});
if(serverMode){
  childProcess.spawn = (command,args,options) => {
    const kind = path.basename(command);
    if(!['ffmpeg','ffprobe'].includes(kind) || options?.shell !== false) return deny('non-waveform subprocess');
    const input = kind === 'ffprobe' ? args.at(-1) : args[args.indexOf('-i')+1];
    if(typeof input !== 'string' || !input.startsWith(path.join(process.env.MIOON_DATA_DIR,'media')+path.sep)) return deny('non-managed media input');
    if(kind === 'ffmpeg' && !['pipe:1','-'].includes(args.at(-1))) return deny('media output file write');
    const child = kind === 'ffmpeg' && process.env.MIOON_WAVEFORM_WIRE_GATE === '1'
      ? originalSpawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],options)
      : originalSpawn(command,args,options);
    fs.appendFileSync(process.env.MIOON_WAVEFORM_WIRE_MEDIA,JSON.stringify({event:'start',kind,pid:child.pid})+'\\n');
    child.once('close',()=>fs.appendFileSync(process.env.MIOON_WAVEFORM_WIRE_MEDIA,JSON.stringify({event:'close',kind,pid:child.pid})+'\\n'));
    return child;
  };
  syncBuiltinESMExports();
  const {startServer} = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'apps/server/src/index.ts')).href)});
  const server = await startServer({dataDir:process.env.MIOON_DATA_DIR,port:Number(process.env.PORT || 0),token:${JSON.stringify(TOKEN)},
    chatGateway:async function*(){deny('model gateway');}});
  process.stdout.write(JSON.stringify({ready:true,url:server.url,pid:process.pid})+'\\n');
  let closing;
  const close = () => closing ??= server.close().catch(()=>{process.exitCode=1;});
  process.on('SIGTERM',close); process.on('SIGINT',close);
}
`);
  const baseEnv = {MIOON_DATA_DIR: dataDir, MIOON_WAVEFORM_WIRE_AUDIT: auditPath, MIOON_WAVEFORM_WIRE_MEDIA: mediaAudit};
  async function start(gated = false) {
    run = launch(t, [helper, 'waveform-server'], {...baseEnv, PORT: String(port), MIOON_WAVEFORM_WIRE_GATE: gated ? '1' : '0'});
    const ready = await run.ready(); url = ready.url; port = Number(new URL(url).port);
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal((await fetch(url + '/health', {signal: AbortSignal.timeout(5_000)})).status, 200);
    return ready.pid;
  }
  await start(true);
  db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), {readOnly: true});
  const storage = () => snapshot(db), version = () => db.prepare('PRAGMA data_version').get().data_version;
  const audit = async () => (await readFile(mediaAudit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoint = async () => ({rows: storage(), version: version(), audit: await audit()});
  const unchanged = async (before, label) => {
    assert.deepEqual(storage(), before.rows, `${label}: all persisted rows remain unchanged`);
    assert.equal(version(), before.version, `${label}: no equal-value SQLite commit`);
    assert.deepEqual(await audit(), before.audit, `${label}: no media probe/decode`);
  };
  const env = () => ({...baseEnv, MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_WAVEFORM_WIRE_ORIGIN: url});
  async function request(operation, input, expectedError, base = url, authorization = `Bearer ${TOKEN}`) {
    const response = await fetch(base + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: JSON.stringify({operation, input})});
    const raw = await response.text(), envelope = JSON.parse(raw); noPrivate(raw);
    assert.equal(envelope.ok, !expectedError, raw);
    if (expectedError) { assert.equal(envelope.error.code, expectedError, raw); assert.equal(response.status, expectedError === 'NOT_FOUND' ? 404 : expectedError === 'UNAUTHORIZED' ? 401 : 400, raw); }
    else assert.equal(response.status, 200, raw);
    return {raw, envelope};
  }
  async function cliArgs(args, expectedError) {
    const child = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.ts'), ...args], env());
    const {code, signal} = await child.finish(); noPrivate(child.stdout); noPrivate(child.stderr);
    assert.equal(signal, null, child.stderr);
    const lines = child.lines(); assert.equal(lines.length, 1, 'real CLI returns one JSON envelope');
    const result = lines[0]; assert.equal(result.ok, !expectedError, child.stdout + child.stderr);
    if (expectedError) { assert.notEqual(code, 0); assert.equal(result.error.code, expectedError); }
    else assert.equal(code, 0, child.stderr);
    return result;
  }
  const cli = (operation, input, error) => cliArgs([...operation.split('.'), '--input', JSON.stringify(input)], error);
  const client = new Client({name: 'waveform-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, cwd: repo, env: environment(env()), stderr: 'pipe',
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.ts')]});
  let stderr = '';
  transport.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  cleanups.push(() => bounded(client.close(), 'Official MCP cleanup', 7_000));
  await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal(client.getServerVersion().name, 'mioon'); assert.ok(client.getServerCapabilities().tools);
  async function mcp(operation, input = {}, expectedError) {
    const result = await client.callTool({name: operation === 'mioon_schema' ? operation : toolName(operation), arguments: input}, undefined, {timeout: 5_000});
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
  return {root, dataDir, storage, checkpoint, unchanged, request, cli, cliArgs, client, mcp, audit,
    http: async (...args) => (await request(...args)).envelope,
    get url() { return url; }, get pid() { return run.child.pid; },
    async restart({crashRow = false} = {}) {
      await stopOwned(run.child);
      if (crashRow) {
        const writer = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'));
        try { assert.equal(writer.prepare("UPDATE waveform_cache SET status='running',data='{}',reservedBytes=393216 WHERE projectId=? AND sourceSha256=?").run(IDS.project, sha256).changes, 1); }
        finally { writer.close(); }
      }
      return start();
    },
    denials: async () => (await readFile(auditPath, 'utf8')).trim(),
    originalBytes: async () => readFile(path.join(dataDir, relativePath)), wav,
  };
}

function onlyWaveformWrites(before, after) {
  assert.deepEqual(Object.keys(after), Object.keys(before), 'requests cannot create new tables');
  for (const table of Object.keys(before)) {
    if (table === 'waveform_cache') continue;
    if (table === 'sqlite_sequence') {
      assert.deepEqual(after[table].filter(row => row.name !== 'waveform_cache'), before[table].filter(row => row.name !== 'waveform_cache'), 'other table sequences remain unchanged');
    } else assert.deepEqual(after[table], before[table], `${table}: assets, revisions, timelines, journals and preferences remain unchanged`);
  }
}
async function waitStatus(backend, status, input = target) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = (await backend.http('asset.waveform.get', input)).data;
    assert.equal(isWaveformResponse(result, input), true, JSON.stringify(result));
    if (result.status === status) return result;
    assert.ok(['queued', 'running'].includes(result.status), `Expected ${status}; got ${JSON.stringify(result)}`);
    await pause(20);
  }
  throw Error(`Waveform ${status} timed out`);
}
async function lossProxy(t, backend) {
  let captured, failure;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), submitted = JSON.parse(bytes);
      const upstream = await fetch(backend.url + '/api/rpc', {method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: {authorization: request.headers.authorization, 'content-type': 'application/json'}, body: bytes});
      const raw = await upstream.text(); captured = {raw, envelope: JSON.parse(raw), submitted};
      assert.equal(upstream.status, 200, raw); response.destroy();
    } catch (error) { failure = error; response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'Owned proxy cleanup', 5_000); });
  return async input => {
    await assert.rejects(backend.request('asset.waveform.request', input, undefined, `http://127.0.0.1:${server.address().port}`), /fetch failed|socket|network/i);
    if (failure) throw failure;
    assert.deepEqual(captured.submitted, {operation: 'asset.waveform.request', input});
    return captured;
  };
}

test('waveform contracts are strict, bounded and validate only safe public responses', () => {
  assert.deepEqual(parse('asset.waveform.request', target), {...target, retry: false});
  assert.deepEqual(parse('asset.waveform.get', target), {...target, sourceStartFrame: 0, points: 512});
  for (const operation of operations) for (const key of ['sourceSha256', 'path', 'command', 'url', 'requestId', 'token'])
    assert.throws(() => parse(operation, {...target, [key]: 'not-authorized'}), {code: 'VALIDATION_ERROR'});
  for (const patch of [{sourceStartFrame: -1}, {sourceStartFrame: 18000}, {sourceStartFrame: 0.1}, {sourceEndFrame: 0},
    {sourceEndFrame: 18001}, {sourceStartFrame: 20, sourceEndFrame: 20}, {sourceStartFrame: 20, sourceEndFrame: 19},
    {points: 0}, {points: WAVEFORM_MAX_POINTS + 1}, {points: 1.5}])
    assert.throws(() => parse('asset.waveform.get', {...target, ...patch}), {code: 'VALIDATION_ERROR'});
  const ready = {...target, algorithm: WAVEFORM_ALGORITHM, binsPerSecond: 100, status: 'ready', attemptId: uuid(5000),
    duration: 2, sourceFrames: 60, decodedSampleFrames: 96000, sourceStartFrame: 0, sourceEndFrame: 60, peaks: [0, 0.5, 1], clipped: false};
  assert.equal(isWaveformResponse(ready, target), true);
  for (const key of ['duration', 'sourceFrames', 'decodedSampleFrames', 'clipped', 'attemptId']) {
    const incomplete = {...ready}; delete incomplete[key];
    assert.equal(isWaveformResponse(incomplete), false, `ready metadata requires ${key}`);
  }
  const {peaks, sourceStartFrame, sourceEndFrame, ...readyRequest} = ready;
  assert.equal(isWaveformResponse(readyRequest, target), true, 'ready request may omit peaks and display bounds');
  assert.equal(isWaveformResponse({...readyRequest, sourceFrames: 59}), false);
  assert.equal(isWaveformResponse({...readyRequest, duration: 3}), false);
  assert.equal(isWaveformResponse({...readyRequest, decodedSampleFrames: 90_000}), false);
  assert.equal(isWaveformResponse({...readyRequest, decodedSampleFrames: 91_200}), true, '100ms decoded coverage tolerance is explicit');
  assert.equal(isWaveformResponse({...ready, peaks: [0.5, null]}, target), true);
  assert.equal(isWaveformResponse({...ready, decodedSampleFrames: 28_800_001}), false);
  assert.equal(isWaveformResponse({...ready, decodedSampleFrames: 0}), false);
  assert.equal(isWaveformResponse({...ready, assetId: IDS.otherAsset}, target), false);
  assert.equal(isWaveformResponse(ready, {...target, points: 2}), false);
  for (const patch of [{path: PRIVATE}, {algorithm: 'unknown'}, {peaks: [Infinity]}, {peaks: [-0.1]}, {peaks: [1.1]},
    {peaks: Array(2049).fill(0)}, {sourceEndFrame: 61}, {status: 'error'}, {reason: {code: 'ERROR', message: 'safe', stderr: PRIVATE}}])
    assert.equal(isWaveformResponse({...ready, ...patch}), false);
  const requestEffects = operationEffect('asset.waveform.request'), getEffects = operationEffect('asset.waveform.get');
  assert.equal(requestEffects.idempotent, false); assert.equal(requestEffects.localProcess, true); assert.equal(requestEffects.databaseWrite, true);
  assert.equal(getEffects.readOnly, true); assert.equal(getEffects.idempotent, true);
  assert.equal(requestEffects.destructive, true); assert.equal(getEffects.destructive, false);
  for (const effects of [requestEffects, getEffects]) for (const key of ['externalIO', 'paidGeneration', 'fileWrite', 'openWorld']) assert.equal(effects[key], false);
});

test('waveforms have project-scoped HTTP, real CLI and official MCP parity across loss, restart and explicit retry', {timeout: 120_000}, async t => {
  const backend = await fixture(t), drop = await lossProxy(t, backend), baseline = backend.storage();
  let attempt, ready;
  const all = async (operation, input, expectedError) => {
    const result = await backend.http(operation, input, expectedError);
    assert.deepEqual(await backend.cli(operation, input, expectedError), result);
    assert.deepEqual(await backend.mcp(operation, input, expectedError), result);
    if (!expectedError) assert.equal(isWaveformResponse(result.data, input), true, JSON.stringify(result));
    return result;
  };

  await t.test('discovery matches strict contracts and effects without expanding built-in Agent tools', async () => {
    const before = await backend.checkpoint(), catalog = discoverSchema(), listed = (await backend.client.listTools()).tools;
    assert.deepEqual((await backend.cliArgs(['schema'])).data, catalog);
    assert.deepEqual((await backend.mcp('mioon_schema')).data, catalog);
    for (const operation of operations) {
      const definition = catalog.operations.find(value => value.operation === operation), request = operation.endsWith('.request');
      assert.ok(definition); assert.deepEqual((await backend.cliArgs(['schema', operation])).data, definition);
      assert.deepEqual((await backend.mcp('mioon_schema', {operation})).data, definition);
      const tool = listed.find(value => value.name === toolName(operation));
      assert.deepEqual(tool.inputSchema, definition.inputSchema);
      assert.deepEqual([...definition.inputSchema.required].sort(), ['assetId', 'projectId']);
      assert.equal(definition.inputSchema.additionalProperties, false); assert.equal(definition.requiresRequestId, false);
      assert.equal(tool.annotations.readOnlyHint, !request); assert.equal(tool.annotations.idempotentHint, !request);
      assert.equal(tool.annotations.destructiveHint, request); assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(definition.effects.databaseWrite, request); assert.equal(definition.effects.localProcess, request);
      for (const key of ['fileWrite', 'externalIO', 'paidGeneration']) assert.equal(definition.effects[key], false);
      for (const definitions of [READ_TOOL_DEFINITIONS, EDIT_TOOL_DEFINITIONS])
        assert.ok(!JSON.stringify(definitions).includes(operation), `${operation} is absent from built-in Agent tools`);
    }
    await backend.unchanged(before, 'discovery');
  });

  await t.test('missing gets and ownership/validation errors cause no write or local media work', async () => {
    const before = await backend.checkpoint();
    const result = await all('asset.waveform.get', target); assert.equal(result.data.status, 'missing');
    for (const operation of operations) {
      for (const input of [{...target, assetId: missingId}, {...target, assetId: IDS.otherAsset}, {...target, projectId: IDS.other}])
        await all(operation, input, 'NOT_FOUND');
      for (const key of ['path', 'sourceSha256', 'command', 'requestId']) await all(operation, {...target, [key]: PRIVATE}, 'VALIDATION_ERROR');
      await backend.request(operation, target, 'UNAUTHORIZED', undefined, null);
    }
    for (const patch of [{points: 2049}, {points: 0}, {sourceStartFrame: 5, sourceEndFrame: 5}, {sourceEndFrame: 18001}])
      await all('asset.waveform.get', {...target, ...patch}, 'VALIDATION_ERROR');
    await backend.unchanged(before, 'missing, rejected and unauthenticated calls');
  });

  await t.test('lost request acknowledgement is recovered by get; duplicates reuse one running attempt', async () => {
    const accepted = await drop(target); attempt = accepted.envelope.data.attemptId;
    assert.ok(attempt); await waitStatus(backend, 'running');
    const running = await all('asset.waveform.get', target); assert.equal(running.data.attemptId, attempt);
    for (const call of [backend.http, backend.cli, backend.mcp]) {
      const duplicate = (await call('asset.waveform.request', target)).data;
      assert.equal(duplicate.attemptId, attempt); assert.equal(duplicate.status, 'running');
    }
    const sameSource = (await backend.http('asset.waveform.request', {...target, assetId: alias})).data;
    assert.equal(sameSource.attemptId, attempt, 'same-project source hash shares one cache attempt');
    assert.equal(sameSource.assetId, alias, 'cache response remains bound to the requested asset');
    const records = await backend.audit();
    assert.equal(records.filter(row => row.event === 'start' && row.kind === 'ffmpeg').length, 1);
    assert.equal(records.filter(row => row.event === 'start' && row.kind === 'ffprobe').length, 1);
    onlyWaveformWrites(baseline, backend.storage());
  });

  await t.test('real backend restart reconciles an unfinished crash row without automatically decoding', async () => {
    const oldPid = backend.pid; await backend.restart({crashRow: true}); assert.notEqual(backend.pid, oldPid);
    const records = await backend.audit();
    for (const started of records.filter(row => row.event === 'start')) assert.ok(records.some(row => row.event === 'close' && row.pid === started.pid), 'every owned pre-restart media child is reaped');
    const before = await backend.checkpoint();
    const interrupted = await all('asset.waveform.get', target);
    assert.equal(interrupted.data.status, 'interrupted'); assert.equal(interrupted.data.attemptId, attempt);
    for (const call of [backend.http, backend.cli, backend.mcp]) {
      const same = (await call('asset.waveform.request', target)).data;
      assert.equal(same.status, 'interrupted'); assert.equal(same.attemptId, attempt);
    }
    await pause(100); await backend.unchanged(before, 'startup and get never resume interrupted work');
    const retry = (await backend.mcp('asset.waveform.request', {...target, retry: true})).data;
    assert.notEqual(retry.attemptId, attempt); assert.ok(['queued', 'running'].includes(retry.status));
    ready = await waitStatus(backend, 'ready');
    assert.equal(ready.attemptId, retry.attemptId); assert.equal(ready.duration, 2); assert.equal(ready.sourceFrames, 60); assert.equal(ready.decodedSampleFrames, 96_000);
    assert.equal(ready.sourceStartFrame, 0); assert.equal(ready.sourceEndFrame, 60);
    assert.ok(ready.peaks.length <= 512); assert.ok(ready.peaks.some(value => value > 0.7));
  });

  await t.test('ready source ranges and duplicate requests have exact transport parity with no extra work', async () => {
    const before = await backend.checkpoint();
    assert.deepEqual((await all('asset.waveform.get', target)).data, ready);
    const first = (await all('asset.waveform.get', {...target, sourceStartFrame: 0, sourceEndFrame: 30, points: 17})).data;
    const second = (await all('asset.waveform.get', {...target, sourceStartFrame: 30, sourceEndFrame: 60, points: 31})).data;
    assert.ok(first.peaks.length <= 17); assert.ok(second.peaks.length <= 31);
    assert.ok(Math.max(...first.peaks) < 0.3); assert.ok(Math.min(...second.peaks) > 0.7);
    assert.equal(first.sourceEndFrame, 30); assert.equal(second.sourceStartFrame, 30);
    const one = (await all('asset.waveform.get', {...target, points: 1})).data;
    assert.equal(one.peaks.length, 1); assert.ok(one.peaks[0] > 0.7);
    const maximum = (await all('asset.waveform.get', {...target, points: 2048})).data;
    assert.ok(maximum.peaks.length <= 2048);
    await all('asset.waveform.get', {...target, sourceEndFrame: 61}, 'SOURCE_BOUNDS');
    await all('asset.waveform.get', {...target, sourceStartFrame: 60}, 'SOURCE_BOUNDS');
    const duplicate = await all('asset.waveform.request', target);
    assert.equal(duplicate.data.status, 'ready'); assert.equal(duplicate.data.attemptId, ready.attemptId);
    const foreign = (await all('asset.waveform.get', {projectId: IDS.other, assetId: IDS.otherAsset})).data;
    assert.equal(foreign.status, 'missing', 'identical source hash in another project does not expose this cache');
    await backend.unchanged(before, 'ready/ranged reads and retained duplicate request');
  });

  await t.test('identical bytes stay project-scoped and unsupported audio stays explicit', async () => {
    const foreign = {projectId: IDS.other, assetId: IDS.otherAsset};
    const accepted = (await backend.cli('asset.waveform.request', foreign)).data;
    assert.notEqual(accepted.attemptId, ready.attemptId);
    const otherReady = await waitStatus(backend, 'ready', foreign);
    assert.notEqual(otherReady.attemptId, ready.attemptId); assert.deepEqual(otherReady.peaks, ready.peaks);
    assert.deepEqual((await all('asset.waveform.get', target)).data, ready);
    const image = {...target, assetId: imageId}, oldAudit = await backend.audit();
    await backend.mcp('asset.waveform.request', image);
    const unsupported = await waitStatus(backend, 'unsupported', image);
    assert.equal(unsupported.reason.code, 'WAVEFORM_NO_AUDIO');
    assert.deepEqual(await backend.audit(), oldAudit, 'unsupported metadata never enters a media subprocess');
    const before = await backend.checkpoint();
    assert.deepEqual((await all('asset.waveform.get', image)).data, unsupported);
    assert.deepEqual((await all('asset.waveform.request', image)).data, unsupported);
    await backend.unchanged(before, 'unsupported get and ordinary duplicate do not retry');
  });

  await t.test('ready cache and exact peaks survive real process restart without startup/get decoding', async () => {
    const oldPid = backend.pid, oldAudit = await backend.audit(); await backend.restart(); assert.notEqual(backend.pid, oldPid);
    assert.deepEqual(await backend.audit(), oldAudit, 'startup starts no probe or decode');
    const before = await backend.checkpoint();
    assert.deepEqual((await all('asset.waveform.get', target)).data, ready);
    await backend.unchanged(before, 'retained ready cache read after restart');
    onlyWaveformWrites(baseline, backend.storage());
    assert.deepEqual(await backend.originalBytes(), backend.wav, 'source bytes remain unchanged');
    assert.deepEqual(await readdir(path.join(backend.dataDir, 'media')), [`${PRIVATE}.wav`], 'no waveform output media file');
    assert.equal(await backend.denials(), '', 'no network/provider/model or forbidden subprocess attempt');
  });
});
