import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {createClient, discoverSchema} from '../packages/client/src/index.mjs';
import {parse, schemas, operationEffect, exportPreflightSchemas, exportPreflightResponseSchema,
  isExportPreflightResponse, EXPORT_PREFLIGHT_LIMITS} from '../packages/contracts/src/index.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';
import {IDS, TOKEN, NOW, uuid, snapshot, seedMutationStore} from './helpers/mutation-wire-fixture.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const operation = 'timeline.export.preflight';
const input = {projectId: IDS.project, expectedRevision: 4};
const imageId = uuid(80), videoTrack = uuid(81), audioTrack = uuid(82), imageClip = uuid(83), audioClip = uuid(84), audioId = uuid(85);
const PRIVATE = 'PREFLIGHT_PRIVATE_SOURCE_MARKER';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const environment = extra => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAY_MAX_GENERATIONS: '0', ...extra});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => sha256(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
const noPrivate = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [TOKEN, PRIVATE, 'Bearer ']) assert.ok(!text.includes(secret), 'public reports omit source locations and credentials');
};
const readyReport = () => ({...input, timelineId: IDS.timeline, timelineRevision: 4, snapshotHash: 'a'.repeat(64), checkedAt: NOW,
  status: 'ready', summary: {fps: 30, width: 720, height: 1280, durationFrames: 60, trackCount: 2, clipCount: 2,
    assetCount: 2, visualClipCount: 1, audibleClipCount: 1, mutedTrackCount: 0, hiddenVideoTrackCount: 0},
  checks: {totalAssets: 2, checkedAssets: 2, bytesHashed: 1000, fullDecode: false}, issues: []});

async function bounded(promise, label, milliseconds = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const ended = once(child, 'close'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await bounded(ended, 'Owned child cleanup', 8_000); } finally { clearTimeout(timer); }
}
function launch(t, args, env) {
  const child = spawn(process.execPath, args, {cwd: repo, env: environment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', failure;
  child.stdout.on('data', chunk => { stdout += chunk; enforceOutput(); });
  child.stderr.on('data', chunk => { stderr += chunk; enforceOutput(); });
  function enforceOutput() { if (stdout.length + stderr.length > 512 * 1024) { failure = Error('Owned child exceeded bounded output'); child.kill('SIGKILL'); } }
  child.on('error', error => { failure = error; });
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  t.after(() => stopOwned(child));
  return {child, get stdout() { return stdout; }, get stderr() { return stderr; },
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        for (const line of stdout.split('\n').slice(0, -1)) { const value = JSON.parse(line); if (value.ready) return value; }
        noPrivate(stderr); assert.equal(child.exitCode, null, stderr); assert.equal(child.signalCode, null, stderr);
        await pause(10);
      }
      throw Error('Owned backend startup timed out');
    },
    async finish() { const result = await bounded(finished, 'CLI response'); if (failure) throw failure; return result; },
  };
}

// All media bytes are generated in memory. No fixture-creation subprocess,
// credentials, provider calls, full decode or render are needed for this test.
function syntheticWav() {
  const rate = 48_000, frames = rate * 2, dataBytes = frames * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * 8000), 44 + frame * 2);
  return bytes;
}
function syntheticPng() {
  const chunk = (name, data) => {
    const type = Buffer.from(name), body = Buffer.concat([type, data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(16 * (1 + 16 * 3), 90); for (let row = 0; row < 16; row++) rows[row * 49] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function fileManifest(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await fileManifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'backend.lock')
      result.push({file: name, hash: sha256(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-preflight-wire-')), dataDir = path.join(root, 'data');
  let run, db, client;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => client && bounded(client.close(), 'Official MCP cleanup', 7_000), () => stopOwned(run?.child), () => db?.close(), () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned preflight fixture cleanup failed');
  });
  await seedMutationStore(dataDir);
  const wav = syntheticWav(), png = syntheticPng(), wavPath = `media/${PRIVATE}.wav`, pngPath = `media/${PRIVATE}.png`;
  const saved = [], seed = openStore(dataDir);
  try {
    await writeFile(path.join(dataDir, wavPath), wav, {mode: 0o600}); await writeFile(path.join(dataDir, pngPath), png, {mode: 0o600});
    const source = (id, bytes, relativePath, properties) => ({id, projectId: IDS.project, name: 'Synthetic preflight source', relativePath,
      sha256: sha256(bytes), sizeBytes: bytes.length, provenance: 'user-import', createdAt: NOW, ...properties});
    seed.put('assets', source(audioId, wav, wavPath, {mimeType: 'audio/wav', duration: 2, width: 0, height: 0, hasVideo: false, hasAudio: true}));
    seed.put('assets', source(imageId, png, pngPath, {mimeType: 'image/png', duration: 0, width: 16, height: 16, hasVideo: true, hasAudio: false}));
    const clip = (id, trackId, assetId) => ({id, trackId, assetId, name: 'Synthetic fixture clip', startFrame: 0, durationFrames: 60,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1});
    seed.put('timelines', {...seed.get('timelines', IDS.timeline), durationFrames: 60,
      tracks: [{id: videoTrack, kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false},
        {id: audioTrack, kind: 'audio', name: 'Audio', orderIndex: 1, hidden: false, muted: false}],
      clips: [clip(imageClip, videoTrack, imageId), clip(audioClip, audioTrack, audioId)]});
    // Historical terminal receipts establish replay-before-freshness without
    // starting any new export. Their original revision/digest are now stale.
    for (const [index, extra] of [{}, {preflightSnapshotHash: 'b'.repeat(64)}].entries()) {
      const request = {projectId: IDS.project, expectedRevision: 1, requestId: `historical-preflight-render-${index}`, purpose: 'export', ...extra};
      const response = {id: uuid(90 + index), projectId: IDS.project, requestId: request.requestId, mode: 'timeline', purpose: 'export',
        timelineRevision: 1, snapshot: {
          timeline: {...seed.get('timelines', IDS.timeline), revision: 1, durationFrames: 30,
            clips: seed.get('timelines', IDS.timeline).clips.map(clip => ({...clip, durationFrames: 30}))},
          // Real legacy frozen shape, deliberately omitting optional hasAudio
          // and private relativePath fields rather than seeding a malformed DTO.
          assets: [imageId, audioId].map(id => {const source = seed.get('assets', id);
            return Object.fromEntries(['id', 'sha256', 'mimeType', 'duration', 'width', 'height'].map(key => [key, source[key]]));}),
        },
        status: 'failed', assetId: null, url: null, error: {code: 'SYNTHETIC_FAILURE', message: 'Historical synthetic render', retryable: false}, createdAt: NOW, updatedAt: NOW};
      seed.put('exports', response);
      const raw = JSON.stringify(response);
      seed.db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(request.requestId, canonicalHash({operation: 'timeline.render', input: request}), raw);
      saved.push({request, response, raw});
    }
  } finally { seed.close(); }
  const auditPath = path.join(root, 'network-denials.jsonl'), mediaAudit = path.join(root, 'media-processes.jsonl'), helper = path.join(root, 'wire-helper.mjs');
  await writeFile(auditPath, ''); await writeFile(mediaAudit, '');
  await writeFile(helper, `
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {installWireGuard} from ${JSON.stringify(pathToFileURL(path.join(repo, 'tests/helpers/inspection-wire-fixture.mjs')).href)};
const originalSpawn = childProcess.spawn;
const {deny} = installWireGuard({origin:process.env.MIOON_PREFLIGHT_WIRE_ORIGIN || '',auditPath:process.env.MIOON_PREFLIGHT_WIRE_AUDIT});
if(process.argv[2] === 'preflight-server'){
  childProcess.spawn = (command,args,options) => {
    if(path.basename(command) !== 'ffprobe' || options?.shell !== false) return deny('non-preflight subprocess');
    const input = args.at(-1);
    if(typeof input !== 'string' || !input.startsWith(path.join(process.env.MIOON_DATA_DIR,'media')+path.sep)) return deny('non-managed preflight input');
    const child = originalSpawn(command,args,options);
    fs.appendFileSync(process.env.MIOON_PREFLIGHT_WIRE_MEDIA,JSON.stringify({event:'start',kind:'ffprobe',pid:child.pid})+'\\n');
    child.once('close',()=>fs.appendFileSync(process.env.MIOON_PREFLIGHT_WIRE_MEDIA,JSON.stringify({event:'close',kind:'ffprobe',pid:child.pid})+'\\n'));
    return child;
  };
  syncBuiltinESMExports();
  const {startServer} = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'apps/server/src/index.mjs')).href)});
  const server = await startServer({dataDir:process.env.MIOON_DATA_DIR,port:0,token:${JSON.stringify(TOKEN)},chatGateway:async function*(){deny('model gateway');}});
  process.stdout.write(JSON.stringify({ready:true,url:server.url,pid:process.pid})+'\\n');
  let closing; const close = () => closing ??= server.close().catch(()=>{process.exitCode=1;});
  process.on('SIGTERM',close); process.on('SIGINT',close);
}
`);
  const baseEnv = {MIOON_DATA_DIR: dataDir, MIOON_PREFLIGHT_WIRE_AUDIT: auditPath, MIOON_PREFLIGHT_WIRE_MEDIA: mediaAudit};
  run = launch(t, [helper, 'preflight-server'], baseEnv);
  const {url} = await run.ready(); assert.equal(new URL(url).hostname, '127.0.0.1');
  db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), {readOnly: true});
  const env = {...baseEnv, MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN, MIOON_PREFLIGHT_WIRE_ORIGIN: url};
  const audit = async () => (await readFile(mediaAudit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoint = async () => ({rows: snapshot(db), version: db.prepare('PRAGMA data_version').get().data_version, files: await fileManifest(dataDir)});
  const unchanged = async (before, label) => {
    assert.deepEqual(snapshot(db), before.rows, `${label}: no persisted changes, exports or cache writes`);
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version, `${label}: no equal-value SQLite commit`);
    assert.deepEqual(await fileManifest(dataDir), before.files, `${label}: no output/source/cache file writes`);
  };
  const validateEnvelope = (envelope, expectedError) => {
    noPrivate(envelope); assert.equal(envelope.ok, !expectedError, JSON.stringify(envelope));
    if (expectedError) assert.equal(envelope.error.code, expectedError, JSON.stringify(envelope));
    return expectedError ? envelope.error : envelope.data;
  };
  async function http(op, request, expectedError) {
    const response = await fetch(url + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({operation: op, input: request})});
    const envelope = await response.json();
    assert.equal(response.status, !expectedError ? 200 : expectedError === 'NOT_FOUND' ? 404 : /CONFLICT|STALE/.test(expectedError) ? 409 : 400, JSON.stringify(envelope));
    return validateEnvelope(envelope, expectedError);
  }
  async function cliArgs(args, expectedError) {
    const child = launch(t, ['--import', helper, path.join(repo, 'apps/cli/src/index.mjs'), ...args], env);
    const {code, signal} = await child.finish(); noPrivate(child.stdout); noPrivate(child.stderr);
    assert.equal(signal, null, child.stderr); assert.equal(child.stdout.trim().split('\n').length, 1);
    assert.equal(code === 0, !expectedError, child.stdout + child.stderr);
    return validateEnvelope(JSON.parse(child.stdout), expectedError);
  }
  const cli = (op, request, error) => cliArgs([...op.split('.'), '--input', JSON.stringify(request)], error);
  client = new Client({name: 'timeline-preflight-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, cwd: repo, env: environment(env), stderr: 'pipe',
    args: ['--import', helper, path.join(repo, 'apps/mcp/src/index.mjs')]});
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  await bounded(client.connect(transport), 'Official MCP initialization');
  assert.equal(client.getServerVersion().name, 'mioon'); assert.ok(client.getServerCapabilities().tools);
  async function mcp(op, request, expectedError) {
    const result = await client.callTool({name: op === 'mioon_schema' ? op : op.replaceAll('.', '_'), arguments: request}, undefined, {timeout: 10_000});
    noPrivate(result); noPrivate(stderr);
    const blocks = result.content.filter(block => block.type === 'text'); assert.equal(blocks.length, 1);
    const envelope = JSON.parse(blocks[0].text); assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), Boolean(expectedError)); return validateEnvelope(envelope, expectedError);
  }
  return {http, cli, cliArgs, mcp, client, checkpoint, unchanged, audit, saved, db,
    totalBytes: wav.length + png.length, removeSource: () => unlink(path.join(dataDir, wavPath)),
    denials: async () => (await readFile(auditPath, 'utf8')).trim()};
}

test('export preflight contracts reject malformed DTOs and preserve omitted legacy render input', () => {
  assert.equal(schemas[operation], exportPreflightSchemas[operation]);
  assert.deepEqual(parse(operation, input), input);
  assert.deepEqual(EXPORT_PREFLIGHT_LIMITS, {assets: 100, sourceBytes: 536870912, totalBytes: 1073741824, timeoutMs: 30000, issues: 128});
  assert.equal(Object.isFrozen(EXPORT_PREFLIGHT_LIMITS), true);
  for (const invalid of [{}, {projectId: IDS.project}, {expectedRevision: 4}, {...input, projectId: 'invalid'},
    ...[0, -1, 0.5, '4', null, Infinity].map(expectedRevision => ({...input, expectedRevision})),
    ...['path', 'url', 'command', 'requestId', 'token', 'purpose', 'preflightSnapshotHash'].map(key => ({...input, [key]: 'unapproved'}))])
    assert.throws(() => parse(operation, invalid), {code: 'VALIDATION_ERROR'});
  const legacy = {...input, requestId: 'legacy-render-0001', purpose: 'export'};
  assert.equal(JSON.stringify(parse('timeline.render', legacy)), JSON.stringify(legacy));
  assert.equal(Object.hasOwn(parse('timeline.render', legacy), 'preflightSnapshotHash'), false);
  assert.deepEqual(parse('timeline.render', {...legacy, preflightSnapshotHash: 'c'.repeat(64)}), {...legacy, preflightSnapshotHash: 'c'.repeat(64)});
  for (const preflightSnapshotHash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), null, 1])
    assert.throws(() => parse('timeline.render', {...legacy, preflightSnapshotHash}), {code: 'VALIDATION_ERROR'});
  const ready = readyReport(); assert.equal(isExportPreflightResponse(ready, input), true); assert.deepEqual(exportPreflightResponseSchema.parse(ready), ready);
  assert.equal(isExportPreflightResponse(ready, {...input, projectId: IDS.other}), false);
  assert.equal(isExportPreflightResponse(ready, {...input, expectedRevision: 5}), false);
  for (const status of ['ready', 'blocked', 'incomplete', 'stale']) assert.equal(isExportPreflightResponse({...ready, status}), true);
  const missing = {...ready, timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
    status: 'blocked', checks: {totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false}, issues: [{code: 'TIMELINE_MISSING', severity: 'error', message: 'No timeline exists.'}]};
  assert.equal(isExportPreflightResponse(missing), true);
  for (const key of Object.keys(ready)) { const bad = {...ready}; delete bad[key]; assert.equal(isExportPreflightResponse(bad), false, `report requires ${key}`); }
  for (const patch of [{projectId: 'bad'}, {timelineId: ''}, {timelineId: null}, {timelineRevision: null}, {summary: null}, {snapshotHash: null},
    {timelineRevision: 0}, {timelineRevision: 3}, {expectedRevision: -1}, {snapshotHash: 'A'.repeat(64)},
    {checkedAt: 'yesterday'}, {status: 'success'}, {path: PRIVATE}, {summary: {...ready.summary, fps: 60}}, {summary: {...ready.summary, width: 1080}},
    {summary: {...ready.summary, height: 1920}}, {summary: {...ready.summary, durationFrames: 18001}}, {summary: {...ready.summary, trackCount: 13}},
    {summary: {...ready.summary, clipCount: 101}}, {summary: {...ready.summary, assetCount: 101}}, {summary: {...ready.summary, visualClipCount: 101}},
    {summary: {...ready.summary, audibleClipCount: -1}}, {summary: {...ready.summary, audibleClipCount: 3}}, {summary: {...ready.summary, visualClipCount: 3}},
    {summary: {...ready.summary, assetCount: 1}}, {summary: {...ready.summary, mutedTrackCount: 13}}, {summary: {...ready.summary, hiddenVideoTrackCount: 13}},
    {summary: {...ready.summary, secret: PRIVATE}}, {checks: {...ready.checks, fullDecode: true}}, {checks: {...ready.checks, checkedAssets: 3}},
    {checks: {...ready.checks, checkedAssets: 1}}, {checks: {...ready.checks, totalAssets: 101}}, {checks: {...ready.checks, bytesHashed: 1073741825}}, {checks: {...ready.checks, command: PRIVATE}},
    {issues: [{code: 'KNOWN_BLOCKER', severity: 'error', message: 'Not ready'}]},
    {issues: [{code: 'lowercase', severity: 'error', message: 'Safe'}]}, {issues: [{code: 'A'.repeat(65), severity: 'warning', message: 'Safe'}]},
    {issues: [{code: 'SAFE', severity: 'info', message: 'Safe'}]}, {issues: [{code: 'SAFE', severity: 'error', message: 'a'.repeat(241)}]},
    {issues: [{code: 'SAFE', severity: 'error', message: 'Safe', assetId: 'bad'}]}, {issues: [{code: 'SAFE', severity: 'error', message: 'Safe', stderr: PRIVATE}]},
    {issues: Array.from({length: 129}, () => ({code: 'SAFE', severity: 'warning', message: 'Safe'}))}])
    assert.equal(isExportPreflightResponse({...ready, ...patch}), false, JSON.stringify(patch));
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect']);
  assert.deepEqual(EDIT_TOOL_DEFINITIONS.map(tool => tool.name), ['mioon_propose_shot_update']);
});

test('shared client grants only preflight default transport grace and honors explicit deadlines without retry', async t => {
  const timeouts = [], signals = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds); const signal = new AbortController().signal; signals.push(signal); return signal;
  });
  const env = {MIOON_TOKEN: TOKEN};
  for (const [op, clientOptions, callOptions, expectedTimeout] of [
    [operation, {}, undefined, 35_000],
    ['timeline.inspect', {}, undefined, 30_000],
    [operation, {requestTimeoutMs: 30_000}, undefined, 30_000],
    ['timeline.inspect', {requestTimeoutMs: 30_000}, undefined, 30_000],
    [operation, {requestTimeoutMs: 8_000}, undefined, 8_000],
    ['timeline.inspect', {requestTimeoutMs: 8_000}, undefined, 8_000],
    [operation, {}, {timeoutMs: 7_000}, 7_000],
    [operation, {requestTimeoutMs: 8_000}, {timeoutMs: 7_000}, 7_000],
    ['timeline.inspect', {}, {timeoutMs: 7_000}, 7_000],
  ]) {
    const requests = [], request = op === operation ? input : {projectId: IDS.project};
    const data = op === operation ? readyReport() : null;
    const client = createClient({env, ...clientOptions, fetchImpl: async (url, options) => {
      requests.push({url, method: options.method, body: JSON.parse(options.body), signal: options.signal});
      return {ok: true, status: 200, json: async () => ({ok: true, data})};
    }});
    assert.deepEqual(await client.rpc(op, request, callOptions), data);
    assert.equal(timeouts.at(-1), expectedTimeout);
    assert.equal(requests.length, 1, 'exactly one POST, no implicit retry');
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].signal, signals.at(-1));
    assert.deepEqual(requests[0].body, {operation: op, input: request}, 'transport grace never adds input defaults or request keys');
  }
});

test('shared client rejects malformed or mismatched preflight reports without mutation uncertainty or retry', async () => {
  const report = readyReport();
  for (const data of [null, [], {}, {...report, projectId: IDS.other}, {...report, expectedRevision: 5}, {...report, snapshotHash: null},
    {...report, checks: {...report.checks, fullDecode: true}}, {...report, path: PRIVATE},
    {...report, issues: [{code: 'KNOWN_BLOCKER', severity: 'error', message: 'Not ready'}]}]) {
    let posts = 0;
    const client = createClient({env: {MIOON_TOKEN: TOKEN}, fetchImpl: async () => {
      posts++; return {ok: true, status: 200, json: async () => ({ok: true, data})};
    }});
    await assert.rejects(client.rpc(operation, input), error => {
      assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.deepEqual(error.details, {});
      assert.equal(Object.hasOwn(error.details, 'submissionMayHaveSucceeded'), false); return true;
    });
    assert.equal(posts, 1);
  }
  let posts = 0;
  const client = createClient({env: {MIOON_TOKEN: TOKEN}, fetchImpl: async () => { posts++; throw Error('Synthetic lost response'); }});
  await assert.rejects(client.rpc(operation, input), error => error.code === 'BACKEND_UNAVAILABLE' && !Object.hasOwn(error.details, 'submissionMayHaveSucceeded'));
  assert.equal(posts, 1);
});

test('preflight agrees across actual HTTP, CLI and official MCP without export/cache/file writes', {timeout: 120_000}, async t => {
  const backend = await fixture(t), before = await backend.checkpoint();
  const transports = [{name: 'HTTP', call: backend.http}, {name: 'CLI', call: backend.cli}, {name: 'MCP', call: backend.mcp}];
  const definition = discoverSchema({operation});
  assert.deepEqual(await backend.cliArgs(['schema', operation]), definition);
  assert.deepEqual(await backend.mcp('mioon_schema', {operation}), definition);
  const tools = (await backend.client.listTools()).tools, tool = tools.find(item => item.name === 'timeline_export_preflight');
  assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
  assert.deepEqual(tool.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
  assert.equal(definition.requiresRequestId, false); assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.inputSchema.required, ['projectId', 'expectedRevision']);
  assert.deepEqual(definition.effects, operationEffect(operation)); assert.equal(definition.effects.localProcess, true);
  for (const key of ['databaseWrite', 'fileWrite', 'externalIO', 'paidGeneration']) assert.equal(definition.effects[key], false);
  const render = await backend.cliArgs(['schema', 'timeline.render']);
  assert.equal(render.inputSchema.required.includes('preflightSnapshotHash'), false);
  assert.equal(Object.hasOwn(render.inputSchema.properties.preflightSnapshotHash, 'default'), false);
  assert.deepEqual(tools.find(item => item.name === 'timeline_render').inputSchema, render.inputSchema);
  const reports = [];
  for (const {name, call} of transports) {
    const report = await call(operation, input); reports.push(report);
    assert.equal(isExportPreflightResponse(report, input), true, `${name}: ${JSON.stringify(report)}`);
    assert.equal(report.status, 'ready', `${name}: ${JSON.stringify(report.issues)}`);
    assert.equal(report.timelineId, IDS.timeline); assert.equal(report.timelineRevision, 4); assert.match(report.snapshotHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.summary, readyReport().summary);
    assert.deepEqual(report.checks, {totalAssets: 2, checkedAssets: 2, bytesHashed: backend.totalBytes, fullDecode: false});
    await backend.unchanged(before, name);
  }
  const comparable = ({checkedAt, ...report}) => report;
  reports.forEach(report => assert.deepEqual(comparable(report), comparable(reports[0]), 'safe check results agree apart from check time'));
  const generic = await backend.cliArgs(['rpc', operation, '--input', JSON.stringify(input)]);
  assert.deepEqual(comparable(generic), comparable(reports[0]), 'generic CLI command shares the same service');
  const probes = await backend.audit(); assert.ok(probes.some(event => event.event === 'start'), 'real backend invokes bounded local ffprobe');
  assert.ok(probes.every(event => event.kind === 'ffprobe'), 'neither rendering nor full decode is allowed');
  assert.equal(probes.filter(event => event.event === 'start').length, probes.filter(event => event.event === 'close').length, 'all owned probes settled');

  const beforeStale = await backend.audit();
  for (const {name, call} of transports) {
    const stale = await call(operation, {...input, expectedRevision: 3});
    assert.equal(isExportPreflightResponse(stale, {...input, expectedRevision: 3}), true, name); assert.equal(stale.status, 'stale');
    const missing = await call(operation, {projectId: IDS.other, expectedRevision: 1});
    assert.equal(isExportPreflightResponse(missing, {projectId: IDS.other, expectedRevision: 1}), true, name);
    assert.equal(missing.status, 'blocked'); assert.equal(missing.timelineId, null); assert.equal(missing.timelineRevision, null); assert.equal(missing.snapshotHash, null);
    await call(operation, {projectId: uuid(9999), expectedRevision: 1}, 'NOT_FOUND');
    for (const invalid of [{...input, expectedRevision: 0}, {...input, token: 'not-a-credential'}, {projectId: IDS.project}]) await call(operation, invalid, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await backend.audit(), beforeStale, 'stale, absent and malformed inputs never start source analysis');
  await backend.unchanged(before, 'all stale/missing/invalid reads');

  // Bad digest admission errors are real render calls but must not queue work.
  for (const {call} of transports) await call('timeline.render', {...input, requestId: 'preflight-mismatch-0001', purpose: 'export', preflightSnapshotHash: '0'.repeat(64)}, 'PREFLIGHT_STALE');
  await backend.unchanged(before, 'rejected snapshot digest');
  await backend.removeSource(); const afterRemoval = await backend.checkpoint();
  for (const {name, call} of transports) {
    const report = await call(operation, input);
    assert.equal(isExportPreflightResponse(report, input), true, name); assert.equal(report.status, 'blocked');
    assert.ok(report.issues.some(issue => issue.severity === 'error' && issue.assetId === audioId), 'missing source is a known blocker');
    await backend.unchanged(afterRemoval, `${name} missing source`);
  }
  const beforeReplay = await backend.audit();
  for (const {call} of transports) for (const saved of backend.saved) {
    assert.deepEqual(await call('timeline.render', saved.request), saved.response, 'exact legacy/digest replay wins over stale revision and missing media');
    assert.equal(backend.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(saved.request.requestId).response, saved.raw, 'historical response bytes remain intact');
  }
  for (const {call} of transports) await call('timeline.render', {...backend.saved[0].request, preflightSnapshotHash: reports[0].snapshotHash}, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await backend.audit(), beforeReplay, 'historical replay and changed reuse do not probe or render');
  await backend.unchanged(afterRemoval, 'exact replay and changed reuse');
  assert.equal(await backend.denials(), '', 'no forbidden network, model, provider, FFmpeg or other subprocess attempts');
});
