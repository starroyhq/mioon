import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.mjs';
import {createFrameServices} from '../packages/business/src/frames.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {run} from '../packages/business/src/media-runtime.mjs';
import {validatePng} from '../packages/business/src/images/png.mjs';
import {createClient} from '../packages/client/src/index.mjs';
import {FRAME_MUTATION_OPERATIONS, frameSchemas, isFrameTaskResponse, isFrameRequestResponse,
  isFrameListResponse, canonicalFrameInput} from '../packages/contracts/src/frame-extraction.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'frame-transport-synthetic-local-token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const toolName = operation => operation.replaceAll('.', '_');
const environment = extra => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER:'0', RUNWAY_MAX_GENERATIONS:'0', ...extra});
const recovery = 'Replay the exact original input with the same requestId; do not invent a replacement ID.';
async function bounded(promise, label, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await bounded(ended, 'Owned child cleanup', 6_000); } finally { clearTimeout(timer); }
}
function launch(args, env) {
  const child = spawn(process.execPath, args, {cwd:repo, env:environment(env), stdio:['ignore', 'pipe', 'pipe']});
  // Pipe chunks can split a multibyte schema description. Decode continuously
  // before concatenation; per-Buffer coercion inserts replacement characters.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, failure;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; stdoutBytes += Buffer.byteLength(chunk); if (stdoutBytes > 2 * 1024 * 1024) { failure = Error('Owned stdout exceeded its bound'); child.kill('SIGKILL'); } });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > 64 * 1024) { failure = Error('Owned stderr exceeded its bound'); child.kill('SIGKILL'); } });
  child.on('error', error => { failure = error; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  return {child, get stdout() { return stdout; }, get stderr() { return stderr; },
    async finish() { const result = await bounded(closed, 'Owned CLI response'); if (failure) throw failure; return result; },
    async ready() {
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        if (failure) throw failure;
        const match = /Mioon frame fixture ready (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
        if (match) return match[1];
        assert.equal(child.exitCode, null, stderr); assert.equal(child.signalCode, null, stderr); await pause(10);
      }
      throw Error('Owned frame server did not become ready: ' + stderr);
    }};
}
async function cli(args, env, error) {
  const proc = launch([path.join(repo, 'apps/cli/src/index.mjs'), ...args], env);
  try {
    const {code, signal} = await proc.finish(); assert.equal(signal, null, proc.stderr);
    assert.equal(proc.stdout.trim().split('\n').length, 1, 'actual CLI prints one envelope');
    assert.ok(!proc.stdout.includes(token) && !proc.stderr.includes(token));
    const result = JSON.parse(proc.stdout); assert.equal(result.ok, !error, proc.stdout + proc.stderr);
    if (error) { assert.equal(result.error.code, error); assert.notEqual(code, 0); } else assert.equal(code, 0, proc.stderr);
    return result;
  } finally { await stopOwned(proc.child); }
}
async function sdk(t, env) {
  const client = new Client({name:'frame-transport-acceptance', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo, 'apps/mcp/src/index.mjs')], cwd:repo, env:environment(env), stderr:'pipe'});
  let stderr = '', closed = false;
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  const close = async () => { if (!closed) { closed = true; try { await bounded(client.close(), 'Official MCP cleanup', 7_000); } finally { await transport.close(); } } };
  t.after(close); await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal(client.getServerVersion().name, 'mioon');
  return {client, close, async call(operation, input = {}, error) {
    const result = await client.callTool({name:operation === 'mioon_schema' ? operation : toolName(operation), arguments:input}, undefined, {timeout:10_000});
    const blocks = result.content.filter(item => item.type === 'text'); assert.equal(blocks.length, 1);
    const envelope = JSON.parse(blocks[0].text); assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(error), blocks[0].text); assert.equal(envelope.ok, !error, blocks[0].text);
    if (error) assert.equal(envelope.error.code, error);
    assert.ok(!JSON.stringify(result).includes(token) && !stderr.includes(token)); return envelope;
  }};
}
function noPrivate(value, root) {
  const text = JSON.stringify(value); assert.ok(!text.includes(root) && !text.includes(token));
  function walk(item) {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      assert.ok(!/^(?:bytes|dataBase64|relativePath|snapshot|stagedReceipt|canonicalInput|token|apiKey|authorization)$/i.test(key) && (key !== 'path' || Array.isArray(value)), `public frame field ${key} is forbidden`); walk(value);
    }
  }
  walk(value);
}
const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
  [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))]));

// A real server child with a reduced environment. All outbound network attempts
// are denied/audited; owned local FFmpeg children remain available and counted.
const serverScript = `
import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
const log = event => fs.appendFileSync(process.env.MIOON_FRAME_AUDIT, JSON.stringify(event) + '\\n');
const deny = () => { log({type:'forbidden-network'}); throw Error('Synthetic frame server forbids outbound network'); };
globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny; net.Socket.prototype.connect = deny; tls.connect = deny;
syncBuiltinESMExports();
const {onMediaProcess} = await import('./packages/business/src/media-processes.mjs'); onMediaProcess(log);
const {startServer} = await import('./apps/server/src/index.mjs');
const service = await startServer({dataDir:process.env.MIOON_DATA_DIR, port:Number(process.env.PORT), token:process.env.MIOON_TOKEN});
console.log('Mioon frame fixture ready ' + service.url);
let closing; const close = () => closing ??= service.close().catch(() => {process.exitCode = 1;}); process.on('SIGTERM', close); process.on('SIGINT', close);
`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-frame-wire-'));
  const auditFile = path.join(root, 'wire-audit.jsonl');
  let proc, db, proxy, url, port = 0;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [async () => { if (proxy) { proxy.closeAllConnections(); await bounded(new Promise(resolve => proxy.close(resolve)), 'Proxy cleanup', 5_000); } },
      () => stopOwned(proc?.child), () => db?.close(), () => rm(root, {recursive:true, force:true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Frame transport cleanup failed');
  });
  await writeFile(auditFile, '', {mode:0o600});
  let store = openStore(root), service;
  let project, other, asset, queued, started, staged, stageReceipt, originalBytes;
  const input = changes => ({projectId:project.id, sourceAssetId:asset.id, sourceHash:asset.sha256, sourceFrame:10, requestId:randomUUID(), ...changes});
  try {
    project = store.put('projects', {id:randomUUID(), name:'Frame transport project'});
    other = store.put('projects', {id:randomUUID(), name:'Other frame project'});
    const id = randomUUID(), relativePath = `media/${id}.mp4`, rawFile = path.join(root, 'fixture.rgb');
    const raw = Buffer.alloc(16 * 12 * 3 * 30);
    for (let frame = 0; frame < 30; frame++) for (let i = frame * 16 * 12 * 3; i < (frame + 1) * 16 * 12 * 3; i += 3) raw.set([frame * 7, 200 - frame * 4, 30 + frame * 5], i);
    await writeFile(rawFile, raw, {mode:0o600});
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '16x12', '-framerate', '30', '-i', rawFile,
      '-vf', 'setsar=1', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-bf', '0', '-pix_fmt', 'yuv420p', '-threads', '1', path.join(root, relativePath)], {timeout:15_000});
    await chmod(path.join(root, relativePath), 0o600); await rm(rawFile);
    originalBytes = await readFile(path.join(root, relativePath));
    asset = store.put('assets', {id, projectId:project.id, name:'Synthetic 30fps source.mp4', relativePath, mimeType:'video/mp4',
      sha256:hash(originalBytes), sizeBytes:originalBytes.length, width:16, height:12, duration:1, provenance:'user-import'});
    service = createFrameServices(store, {fault:label => { if (label === 'after_result_manifest') throw Error('Synthetic retained-stage checkpoint'); }});
    staged = await service.handlers['frame.extract'](input({sourceFrame:3}));
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const task = service.handlers['frame.task.get']({projectId:project.id, taskId:staged.id});
      if (task.state === 'local_result_error') break;
      assert.ok(['queued', 'running', 'persisting'].includes(task.state), JSON.stringify(task)); await pause(10);
    }
    assert.equal(service.handlers['frame.task.get']({projectId:project.id, taskId:staged.id}).state, 'local_result_error');
    stageReceipt = JSON.parse(await readFile(path.join(root, 'frame-staging', `${staged.id}.json`), 'utf8'));
    await service.drain(); service = null; store.close(); store = openStore(root);
    service = createFrameServices(store, {autoRun:false});
    queued = await service.handlers['frame.extract'](input({sourceFrame:1}));
    started = await service.handlers['frame.extract'](input({sourceFrame:2}));
    store.db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=revision+1 WHERE id=?").run(started.id);
  } finally { try { await service?.drain(); } finally { store.close(); } }
  async function start() {
    proc = launch(['--input-type=module', '-e', serverScript], {MIOON_DATA_DIR:root, MIOON_TOKEN:token, PORT:String(port), MIOON_FRAME_AUDIT:auditFile});
    url = await proc.ready(); port = Number(new URL(url).port);
    assert.equal((await fetch(url + '/health', {signal:AbortSignal.timeout(5_000)})).status, 200);
    db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly:true});
  }
  await start();
  const audit = async () => (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoint = async () => ({rows:snapshot(db), version:db.prepare('PRAGMA data_version').get().data_version, audit:await audit()});
  const unchanged = async (before, label) => {
    assert.deepEqual(snapshot(db), before.rows, label + ': no changed rows');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version, label + ': zero committed writes');
    assert.deepEqual(await audit(), before.audit, label + ': no new media process or network call');
  };
  let nextMode, altered;
  const proxyRequests = [];
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) throw Error('Bounded proxy request exceeded'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes); proxyRequests.push(body);
      const upstream = await fetch(url + '/api/rpc', {method:'POST', redirect:'error', signal:AbortSignal.timeout(10_000),
        headers:{'content-type':'application/json', authorization:request.headers.authorization}, body:bytes});
      const result = await upstream.json();
      if (nextMode && body.operation === 'frame.extract') {
        const mode = nextMode; nextMode = null; altered = result;
        if (mode === 'drop') { response.destroy(); return; }
        if (result.ok) result.data = {...result.data, projectId:randomUUID()};
      }
      response.writeHead(upstream.status, {'content-type':'application/json'}); response.end(JSON.stringify(result));
    } catch { response.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  async function rpc(operation, input = {}, error) {
    const response = await fetch(url + '/api/rpc', {method:'POST', redirect:'error', signal:AbortSignal.timeout(10_000),
      headers:{'content-type':'application/json', authorization:`Bearer ${token}`}, body:JSON.stringify({operation, input})});
    const result = await response.json(); noPrivate(result, root); assert.equal(result.ok, !error, JSON.stringify(result));
    if (error) assert.equal(result.error.code, error); else assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  async function succeeded(taskId) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const task = (await rpc('frame.task.get', {projectId:project.id, taskId})).data; assert.ok(isFrameTaskResponse(task));
      if (task.state === 'succeeded') return task;
      assert.ok(['queued', 'running', 'persisting'].includes(task.state), JSON.stringify(task)); await pause(10);
    }
    assert.fail('Real local frame extraction did not complete');
  }
  return {root, project, other, asset, queued, started, staged, stageReceipt, originalBytes, input, rpc, succeeded, checkpoint, unchanged, audit, proxyRequests,
    get url() { return url; }, get env() { return {MIOON_BASE_URL:url, MIOON_TOKEN:token}; },
    get proxyEnv() { return {MIOON_BASE_URL:proxyUrl, MIOON_TOKEN:token}; }, get altered() { return altered; },
    alterNext(mode) { nextMode = mode; },
    async restart() { db.close(); db = null; await stopOwned(proc.child); await start(); },
  };
}

// Sequential fixture, one backend, one official MCP bridge, one CLI child at a
// time. All source/output media are local synthetic fixtures, never providers.
test('frames share strict real HTTP, actual CLI and official MCP extraction/recovery contracts', {timeout:120_000}, async t => {
  const f = await fixture(t); let mcp = await sdk(t, f.env);
  const command = (operation, input, error, env = f.env) => cli([...operation.split('.'), '--input', JSON.stringify(input)], env, error);
  async function parity(operation, input = {}, error) {
    const backend = await f.rpc(operation, input, error), cliResult = await command(operation, input, error), sdkResult = await mcp.call(operation, input, error);
    if (!error) { assert.deepEqual(cliResult, backend); assert.deepEqual(sdkResult, backend); }
    else if (FRAME_MUTATION_OPERATIONS.includes(operation) && error !== 'VALIDATION_ERROR') {
      const proof = backend.error.details?.frameOutcome;
      for (const result of [cliResult, sdkResult]) {
        assert.equal(result.error.details.operation, operation); assert.equal(result.error.details.requestId, input.requestId);
        assert.equal(result.error.details.submissionMayHaveSucceeded, !proof);
        if (proof) {
          assert.deepEqual(proof, {status:'not_accepted', operation, projectId:input.projectId, requestId:input.requestId, inputHash:hash(canonicalFrameInput(input))});
          assert.deepEqual(result.error.details.frameOutcome, proof); assert.equal(result.error.details.recovery, undefined);
        } else { assert.equal(result.error.details.frameOutcome, undefined); assert.equal(result.error.details.recovery, recovery); }
      }
    }
    return backend;
  }
  await t.test('six strict schema/effect definitions agree without broadening built-in Agent authority', async () => {
    const before = await f.checkpoint(), catalog = (await cli(['schema'], {})).data;
    assert.deepEqual((await mcp.call('mioon_schema')).data, catalog);
    const tools = (await mcp.client.listTools()).tools;
    for (const operation of Object.keys(frameSchemas)) {
      const definition = catalog.operations.find(value => value.operation === operation), tool = tools.find(value => value.name === toolName(operation));
      assert.ok(definition); assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
      assert.equal(definition.inputSchema.type, 'object'); assert.equal(definition.inputSchema.additionalProperties, false);
      assert.equal(definition.requiresRequestId, FRAME_MUTATION_OPERATIONS.includes(operation) || operation === 'frame.request.get');
      const e = definition.effects; assert.equal(e.readOnly, !FRAME_MUTATION_OPERATIONS.includes(operation)); assert.equal(e.idempotent, true);
      for (const key of ['externalIO', 'paidGeneration', 'openWorld']) assert.equal(e[key], false);
      assert.equal(e.localProcess, operation === 'frame.extract');
      assert.equal(e.databaseWrite, FRAME_MUTATION_OPERATIONS.includes(operation));
      assert.equal(e.fileWrite, ['frame.extract', 'frame.task.recoverResult'].includes(operation));
      assert.deepEqual(tool.annotations, {readOnlyHint:e.readOnly, destructiveHint:e.destructive, idempotentHint:e.idempotent, openWorldHint:e.openWorld});
    }
    assert.deepEqual(READ_TOOL_DEFINITIONS.map(value => value.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
    assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(value => value.name), ['mioon_propose_shot_update']);
    for (const operation of Object.keys(frameSchemas)) {
      const input = operation === 'frame.extract' ? f.input() : operation === 'frame.request.get' ? {projectId:f.project.id, requestId:f.queued.requestId}
        : operation === 'frame.task.list' ? {projectId:f.project.id} : {projectId:f.project.id, taskId:f.queued.id,
          ...(FRAME_MUTATION_OPERATIONS.includes(operation) ? {expectedRevision:1, requestId:randomUUID()} : {})};
      await parity(operation, {...input, providerId:'forbidden'}, 'VALIDATION_ERROR');
    }
    await f.unchanged(before, 'discovery and strict invalid input');
  });
  await t.test('restart discovery never starts retained work; cancellation and missing-result refusal are explicit', async () => {
    const before = await f.checkpoint();
    const queued = (await parity('frame.task.get', {projectId:f.project.id, taskId:f.queued.id})).data;
    const started = (await parity('frame.task.get', {projectId:f.project.id, taskId:f.started.id})).data;
    assert.equal(queued.state, 'interrupted'); assert.equal(queued.started, false);
    assert.equal(started.state, 'interrupted'); assert.equal(started.started, true);
    await parity('frame.request.get', {projectId:f.project.id, requestId:f.queued.requestId});
    await parity('frame.task.cancelQueued', {projectId:f.project.id, taskId:started.id, expectedRevision:started.revision, requestId:randomUUID()}, 'FRAME_STATE_CONFLICT');
    await parity('frame.task.recoverResult', {projectId:f.project.id, taskId:started.id, expectedRevision:started.revision, requestId:randomUUID()}, 'FRAME_RESULT_INVALID');
    await parity('frame.extract', f.input({sourceFrame:30}), 'FRAME_SOURCE_INVALID');
    await f.unchanged(before, 'retained task reads and proven refusals');
    const cancel = {projectId:f.project.id, taskId:queued.id, expectedRevision:queued.revision, requestId:randomUUID()};
    const result = (await parity('frame.task.cancelQueued', cancel)).data;
    assert.equal(result.state, 'cancelled_before_start'); assert.equal(result.started, false);
    assert.deepEqual((await parity('frame.request.get', {projectId:f.project.id, requestId:cancel.requestId})).data.response, result);
  });
  await t.test('explicit recovery publishes the same complete staged PNG with no re-decode', async () => {
    const current = (await parity('frame.task.get', {projectId:f.project.id, taskId:f.staged.id})).data;
    const beforeAudit = await f.audit(), input = {projectId:f.project.id, taskId:current.id, expectedRevision:current.revision, requestId:randomUUID()};
    const ack = (await parity('frame.task.recoverResult', input)).data; assert.equal(ack.state, 'persisting');
    const done = await f.succeeded(current.id); assert.equal(done.result.assetId, f.stageReceipt.assetId); assert.equal(done.result.sha256, f.stageReceipt.sha256);
    assert.deepEqual(await f.audit(), beforeAudit, 'local recovery never invokes FFmpeg or network');
    assert.deepEqual((await parity('frame.request.get', {projectId:f.project.id, requestId:input.requestId})).data.response, ack);
    const before = await f.checkpoint(); await parity('frame.task.recoverResult', input); await f.unchanged(before, 'historical recovery replay');
  });
  let original, accepted, done, bytes;
  await t.test('lost acknowledgement retains identity and explicit cross-transport replay never extracts twice', async () => {
    original = f.input(); f.alterNext('drop');
    const client = createClient({env:f.proxyEnv, requestTimeoutMs:10_000});
    await assert.rejects(client.rpc('frame.extract', original), error => {
      assert.equal(error.code, 'BACKEND_UNAVAILABLE'); assert.equal(error.details.requestId, original.requestId);
      assert.equal(error.details.submissionMayHaveSucceeded, true); return true;
    });
    assert.equal(f.altered.ok, true); accepted = f.altered.data; assert.equal(accepted.state, 'queued');
    assert.equal(f.proxyRequests.length, 1); assert.deepEqual(f.proxyRequests[0], {operation:'frame.extract', input:original});
    done = await f.succeeded(accepted.id); const before = await f.checkpoint();
    assert.deepEqual((await parity('frame.extract', original)).data, accepted);
    const receipt = (await parity('frame.request.get', {projectId:f.project.id, requestId:original.requestId})).data;
    assert.ok(isFrameRequestResponse(receipt)); assert.deepEqual(receipt.response, accepted);
    await parity('frame.extract', {...original, sourceFrame:11}, 'FRAME_REQUEST_CONFLICT');
    await parity('frame.extract', {...original, projectId:f.other.id}, 'FRAME_REQUEST_CONFLICT');
    await parity('frame.task.cancelQueued', {projectId:f.project.id, taskId:accepted.id, expectedRevision:done.revision, requestId:original.requestId}, 'FRAME_REQUEST_CONFLICT');
    assert.equal((await parity('frame.request.get', {projectId:f.other.id, requestId:original.requestId})).data, null);
    await parity('frame.task.get', {projectId:f.other.id, taskId:accepted.id}, 'FRAME_NOT_FOUND');
    await f.unchanged(before, 'duplicate/conflicting/cross-project operations');
    const media = await fetch(f.url + '/media/' + done.result.assetId, {headers:{authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5_000)});
    assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png'); bytes = Buffer.from(await media.arrayBuffer());
    const png = await validatePng(bytes, {width:16, height:12}); assert.equal(png.sha256, done.result.sha256);
    assert.equal(done.result.byteLength, bytes.length); assert.notEqual(done.result.assetId, f.asset.id);
    assert.deepEqual(await readFile(path.join(f.root, f.asset.relativePath)), f.originalBytes);
  });
  await t.test('malformed 200 CLI/MCP acknowledgements preserve exact keys and accepted durable receipts', async () => {
    await mcp.close(); const proxyMcp = await sdk(t, f.proxyEnv);
    for (const transport of ['cli', 'mcp']) {
      const input = f.input({sourceFrame:transport === 'cli' ? 15 : 18}), before = f.proxyRequests.length; f.alterNext('malformed');
      const result = transport === 'cli' ? await command('frame.extract', input, 'BACKEND_PROTOCOL_ERROR', f.proxyEnv)
        : await proxyMcp.call('frame.extract', input, 'BACKEND_PROTOCOL_ERROR');
      assert.deepEqual(result.error.details, {operation:'frame.extract', requestId:input.requestId, submissionMayHaveSucceeded:true, recovery});
      assert.equal(f.proxyRequests.length, before + 1); assert.deepEqual(f.proxyRequests.at(-1), {operation:'frame.extract', input});
      const receipt = (await f.rpc('frame.request.get', {projectId:f.project.id, requestId:input.requestId})).data;
      assert.ok(isFrameRequestResponse(receipt)); assert.equal(receipt.response.projectId, f.project.id);
      await f.succeeded(receipt.response.id);
      assert.deepEqual((await command('frame.extract', input)).data, receipt.response);
    }
    await proxyMcp.close(); mcp = await sdk(t, f.env);
  });
  await t.test('bounded pagination and server recreation are read-only and retain immutable original acknowledgements', async () => {
    const before = await f.checkpoint(), ids = []; let cursor;
    do {
      const input = {projectId:f.project.id, limit:2, ...(cursor ? {cursor} : {})}, page = (await parity('frame.task.list', input)).data;
      assert.ok(isFrameListResponse('frame.task.list', input, page)); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
      assert.ok(ids.length <= 50, 'test traversal is bounded');
    } while (cursor);
    assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, 6);
    const page = (await parity('frame.task.list', {projectId:f.project.id, limit:2})).data; assert.ok(page.nextCursor);
    await parity('frame.task.list', {projectId:f.other.id, limit:2, cursor:page.nextCursor}, 'INVALID_CURSOR');
    await parity('frame.task.list', {projectId:f.project.id, limit:1, cursor:page.nextCursor}, 'INVALID_CURSOR');
    await f.unchanged(before, 'bounded pages and invalid cursor scopes');
    await mcp.close(); const auditBefore = await f.audit(); await f.restart(); mcp = await sdk(t, f.env);
    assert.deepEqual(await f.audit(), auditBefore, 'backend recreation never resumes extraction');
    const recreated = await f.checkpoint();
    await parity('frame.task.list', {projectId:f.project.id, limit:2, cursor:page.nextCursor}, 'INVALID_CURSOR');
    assert.deepEqual((await parity('frame.extract', original)).data, accepted);
    assert.deepEqual((await parity('frame.task.get', {projectId:f.project.id, taskId:accepted.id})).data, done);
    assert.deepEqual((await parity('frame.request.get', {projectId:f.project.id, requestId:original.requestId})).data.response, accepted);
    await f.unchanged(recreated, 'recreated client read/replay');
    assert.deepEqual(await readFile(path.join(f.root, f.asset.relativePath)), f.originalBytes);
    const audit = await f.audit(); assert.ok(audit.every(event => ['started', 'exited'].includes(event.type)), 'no provider/network call was attempted');
    assert.equal(audit.filter(event => event.type === 'started').length, 6, 'three new extractions each use one probe and one decoder, with no replay/recovery/read spawn');
  });
});
