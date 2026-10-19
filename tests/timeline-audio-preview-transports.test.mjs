import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient, discoverSchema} from '@mioon/client';
import {parse, effectAnnotations, operationEffect} from '@mioon/contracts';
import {AUDIO_PREVIEW_PROFILE, isAudioPreviewPlan, audioPreviewPlanDigestMaterial} from '@mioon/contracts/timeline-audio-preview';
import {startServer} from '../apps/server/src/index.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {onMediaProcess, hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';
import {TIMELINE_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-edit-tool-policy.mjs';
import {TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const operation = 'timeline.audioPreview.plan', toolName = 'timeline_audioPreview_plan';
const token = 'synthetic-timeline-audio-preview-transport-token';
const sha = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const environment = url => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  ...(url ? {MIOON_BASE_URL: url, MIOON_TOKEN: token} : {})});
async function bounded(promise, label, ms = 15000) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);})]);}
  finally {clearTimeout(timer);}
}
function publicOnly(value, root = '') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const privateValue of [token, 'Bearer ', ...(root ? [root] : [])]) assert.ok(!text.includes(privateValue), 'No credential or local path leakage');
}
function cli(t, url, args) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), ...args],
    {cwd: repo, env: environment(url), stdio: ['ignore', 'pipe', 'pipe'], shell: false});
  let stdout = '', stderr = '', failure, timer;
  const close = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.on('error', error => {failure = error;});
  const enforce = () => {if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) {failure = Error('Bounded CLI output exceeded'); child.kill('SIGKILL');}};
  // Continuous UTF-8 collectors preserve the exact multilingual discovery description.
  child.stdout.setEncoding('utf8').on('data', value => {stdout += value; enforce();});
  child.stderr.setEncoding('utf8').on('data', value => {stderr += value; enforce();});
  timer = setTimeout(() => {failure = Error('CLI deadline exceeded'); child.kill('SIGKILL');}, 15000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(close, 'Exact owned CLI close');
  });
  return (async () => {
    const result = await bounded(close, 'CLI response', 20000); clearTimeout(timer);
    if (failure) throw failure;
    assert.equal(result.signal, null, stderr); publicOnly(stdout); publicOnly(stderr);
    assert.equal(stdout.trim().split('\n').length, 1, stdout);
    return {...result, body: JSON.parse(stdout)};
  })();
}
async function official(t, url) {
  const client = new Client({name: 'timeline-audio-preview-transports', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.mjs')],
    cwd: repo, env: environment(url), stderr: 'pipe'});
  let stderr = '', overflow = false;
  transport.stderr?.setEncoding('utf8').on('data', value => {
    stderr += value;
    if (Buffer.byteLength(stderr) > 64 * 1024) {overflow = true; void client.close();}
  });
  t.after(async () => {await bounded(client.close(), 'Official MCP child cleanup'); assert.equal(overflow, false); publicOnly(stderr);});
  await bounded(client.connect(transport), 'Official MCP connection');
  return {client, async call(name, input) {
    const result = await client.callTool({name, arguments: input}, undefined, {timeout: 15000});
    const blocks = result.content.filter(block => block.type === 'text'); assert.equal(blocks.length, 1);
    const body = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, body); assert.equal(Boolean(result.isError), !body.ok); publicOnly(body);
    return body;
  }};
}
function stereoWav() {
  // Integer values make independent f32 expectations exact, including offset and channel order.
  const sampleFrames = 48000, bytes = Buffer.alloc(44 + sampleFrames * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(sampleFrames * 4, 40);
  for (let sample = 0; sample < sampleFrames; sample++) {
    bytes.writeInt16LE((sample % 257) * 64 - 8192, 44 + sample * 4);
    bytes.writeInt16LE(16384 - (sample % 509) * 32, 46 + sample * 4);
  }
  return bytes;
}
async function fileManifest(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await fileManifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(name) && name !== 'server.lock')
      result.push({file: name, sha256: sha(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-audio-preview-wire-'));
  let backend, db;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [() => db?.close(), () => backend && bounded(backend.close(), 'Owned backend cleanup'), () => rm(root, {recursive: true, force: true})]) {
      try {await cleanup();} catch (error) {errors.push(error);}
    }
    if (errors.length) throw new AggregateError(errors, 'Audio preview fixture cleanup failed');
  });
  backend = await startServer({dataDir: root, port: 0, token, chatGateway: async function* () {throw Error('No model call permitted');}});
  const client = createClient({env: environment(backend.url)});
  const project = await client.rpc('project.create', {name: '合成声音 🎬 transport parity'});
  const foreign = await client.rpc('project.create', {name: 'Other synthetic project'});
  let timeline = await client.rpc('timeline.get', {projectId: project.id});
  const bytes = stereoWav();
  const asset = await client.rpc('asset.import', {projectId: project.id, name: 'Synthetic stereo.wav', mimeType: 'audio/wav', dataBase64: bytes.toString('base64')});
  timeline = await client.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: asset.id, startFrame: 2, durationFrames: 12,
    sourceInFrame: 3, gain: 0.5, fadeInFrames: 3, fadeOutFrames: 3});
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const savedAsset = JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(asset.id).data);
  const rows = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, startFrame: 5};
  return {root, backend, client, db, project, foreign, timeline, asset, bytes, input,
    sourceInput: plan => ({...input, clipId: plan.sources[0].clipId, sourceHash: plan.sources[0].sourceHash, planHash: plan.planHash}),
    async checkpoint() {return {rows: rows(), version: db.prepare('PRAGMA data_version').get().data_version, files: await fileManifest(root)};},
    async unchanged(before) {
      assert.deepEqual(rows(), before.rows, 'No durable jobs, receipts, history or other database changes');
      assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version, 'No database write, including same-value updates');
      assert.deepEqual(await fileManifest(root), before.files, 'No cache or sidefiles');
      assert.equal(sha(await readFile(path.join(root, savedAsset.relativePath))), sha(bytes), 'Original source bytes unchanged');
      assert.equal(savedAsset.sha256, sha(bytes));
    },
  };
}
const pcmUrl = (base, input) => `${base}/api/timeline-audio-preview/pcm?${new URLSearchParams(input)}`;
async function rpc(url, input) {
  const response = await fetch(url + '/api/rpc', {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    body: JSON.stringify({operation, input}), signal: AbortSignal.timeout(15000)});
  return {response, body: await response.json()};
}
function verifyPcm(bytes, plan, wav) {
  const source = plan.sources[0]; assert.equal(bytes.length, source.pcmBytes); assert.equal(bytes.length / 8, source.sampleFrames);
  for (let sample = 0; sample < source.sampleFrames; sample++) for (let channel = 0; channel < 2; channel++) {
    const actual = bytes.readFloatLE(sample * 8 + channel * 4);
    const expected = wav.readInt16LE(44 + (source.sourceInFrame * 1600 + sample) * 4 + channel * 2) / 32768;
    assert.equal(actual, expected, `Exact pre-gain/pre-fade sample ${sample}, channel ${channel}`);
  }
}
function verifyHeaders(response, plan) {
  const source = plan.sources[0]; assert.equal(response.status, 200);
  for (const [name, value] of Object.entries({'content-type': 'application/octet-stream', 'content-length': String(source.pcmBytes),
    'cache-control': 'no-store', 'x-mioon-audio-profile': AUDIO_PREVIEW_PROFILE, 'x-mioon-audio-plan-hash': plan.planHash,
    'x-mioon-audio-source-hash': source.sourceHash, 'x-mioon-audio-clip-id': source.clipId, 'x-mioon-audio-sample-frames': String(source.sampleFrames)}))
    assert.equal(response.headers.get(name), value, name);
  assert.equal(response.headers.get('content-encoding'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('real startServer HTTP, CLI and official MCP expose identical read-only plans; authenticated PCM is exact and disposable', {timeout: 90000}, async t => {
  const f = await fixture(t), mcp = await official(t, f.backend.url), definition = discoverSchema({operation});
  const events = [], off = onMediaProcess(event => events.push(event)); t.after(off);
  const before = await f.checkpoint();
  const discovery = await cli(t, undefined, ['schema', operation]); assert.equal(discovery.code, 0); assert.deepEqual(discovery.body, {ok: true, data: definition});
  assert.deepEqual(await mcp.call('mioon_schema', {operation}), {ok: true, data: definition});
  const tool = (await mcp.client.listTools()).tools.find(value => value.name === toolName);
  assert.ok(tool); assert.deepEqual(tool.inputSchema, definition.inputSchema); assert.deepEqual(tool.annotations, effectAnnotations(operationEffect(operation)));
  assert.deepEqual(definition.inputSchema.required, ['projectId', 'timelineId', 'expectedRevision', 'startFrame']);
  assert.equal(definition.inputSchema.additionalProperties, false); assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(Object.keys(definition.inputSchema.properties), definition.inputSchema.required);
  const {notes, ...effects} = operationEffect(operation);
  assert.deepEqual(effects, {readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false,
    fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false});
  assert.match(notes, /Not a built-in Agent tool/);
  for (const catalog of [READ_TOOL_DEFINITIONS, EDIT_TOOL_DEFINITIONS, TIMELINE_EDIT_TOOL_DEFINITIONS, TIMELINE_GAIN_EDIT_TOOL_DEFINITIONS])
    assert.ok(catalog.every(value => !/audioPreview|audio_preview|audition/i.test(value.name)), 'No new built-in Agent execution authority');
  const httpResult = await rpc(f.backend.url, f.input); assert.equal(httpResult.response.status, 200); assert.equal(httpResult.body.ok, true);
  const cliResult = await cli(t, f.backend.url, [...operation.split('.'), '--input', JSON.stringify(f.input)]);
  assert.equal(cliResult.code, 0); assert.deepEqual(cliResult.body, httpResult.body);
  assert.deepEqual(await mcp.call(toolName, f.input), httpResult.body);
  const plan = httpResult.body.data; publicOnly(plan, f.root); assert.equal(isAudioPreviewPlan(plan, f.input), true);
  assert.equal(plan.planHash, sha(audioPreviewPlanDigestMaterial(plan)));
  assert.deepEqual(plan.range, {startFrame: 5, endFrame: 14, startSample: 8000, endSample: 22400, sampleFrames: 14400});
  assert.equal(plan.sources[0].sourceInFrame, 6); assert.equal(plan.sources[0].durationFrames, 9); assert.equal(plan.sources[0].sourceHash, sha(f.bytes));
  assert.equal(plan.voices[0].gain, 0.5); assert.equal(plan.voices[0].fadeInFrames, 3); assert.equal(plan.voices[0].fadeOutFrames, 3);
  assert.deepEqual(events, [], 'Metadata planning/discovery must not launch decoder/probe processes');
  await f.unchanged(before);
  // Both existing authenticated modes are exercised; no new handle or credential is minted.
  const login = await fetch(f.backend.url + '/api/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({token}), signal: AbortSignal.timeout(15000)});
  assert.equal(login.status, 200); await login.json();
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('mioon_session=')).split(';')[0];
  for (const headers of [{authorization: 'Bearer ' + token}, {cookie, origin: f.backend.url}]) {
    const response = await fetch(pcmUrl(f.backend.url, f.sourceInput(plan)), {headers, signal: AbortSignal.timeout(15000)});
    verifyHeaders(response, plan); verifyPcm(Buffer.from(await response.arrayBuffer()), plan, f.bytes); await f.unchanged(before);
  }
  assert.equal(events.filter(event => event.type === 'started' && event.kind === 'ffmpeg').length, 2);
  assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.pid).sort(), events.filter(event => event.type === 'exited').map(event => event.pid).sort());
  assert.equal(hasUnconfirmedMediaProcesses(), false);
});

test('real fixed PCM endpoint rejects unauthorized, foreign, stale, malformed and caller-selected source input before decoding', {timeout: 90000}, async t => {
  const f = await fixture(t), plan = await f.client.rpc(operation, f.input), input = f.sourceInput(plan);
  const events = [], off = onMediaProcess(event => events.push(event)); t.after(off);
  const before = await f.checkpoint(), validUrl = pcmUrl(f.backend.url, input);
  const cases = [
    ['unauthenticated', validUrl, {}, 401, 'UNAUTHORIZED'],
    ['foreign origin', validUrl, {headers: {authorization: 'Bearer ' + token, origin: 'https://foreign.invalid'}}, 403, 'ORIGIN_REJECTED'],
    ['foreign project', pcmUrl(f.backend.url, {...input, projectId: f.foreign.id}), null, 404, 'AUDIO_PREVIEW_UNAVAILABLE'],
    ['foreign clip', pcmUrl(f.backend.url, {...input, clipId: randomUUID()}), null, 404, 'AUDIO_PREVIEW_UNAVAILABLE'],
    ['stale revision', pcmUrl(f.backend.url, {...input, expectedRevision: input.expectedRevision + 1}), null, 409, 'AUDIO_PREVIEW_REVISION_CONFLICT'],
    ['stale plan hash', pcmUrl(f.backend.url, {...input, planHash: 'b'.repeat(64)}), null, 409, 'AUDIO_PREVIEW_STALE'],
    ['stale source hash', pcmUrl(f.backend.url, {...input, sourceHash: 'c'.repeat(64)}), null, 404, 'AUDIO_PREVIEW_UNAVAILABLE'],
    ...['path', 'url', 'codec', 'filter', 'streamIndex', 'assetId', 'sourceInFrame', 'frameCount', 'requestId'].map(key =>
      [key, validUrl + '&' + new URLSearchParams({[key]: key === 'path' ? '/private/source.wav' : '1'}), null, 400, 'AUDIO_PREVIEW_INVALID_INPUT']),
    ['repeated query', validUrl + '&startFrame=5', null, 400, 'AUDIO_PREVIEW_INVALID_INPUT'],
    ['noncanonical integer', pcmUrl(f.backend.url, {...input, startFrame: '05'}), null, 400, 'AUDIO_PREVIEW_INVALID_INPUT'],
    ['missing field', pcmUrl(f.backend.url, Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'clipId'))), null, 400, 'AUDIO_PREVIEW_INVALID_INPUT'],
    ['path-selected endpoint', f.backend.url + '/api/timeline-audio-preview/pcm/private.wav?' + new URLSearchParams(input), null, 404, 'NOT_FOUND'],
    ['wrong method', validUrl, {method: 'POST', headers: {authorization: 'Bearer ' + token}}, 405, 'METHOD_NOT_ALLOWED'],
    ['body-bearing GET', validUrl, {method: 'GET', headers: {authorization: 'Bearer ' + token, 'content-length': '1'}}, 400, 'AUDIO_PREVIEW_INVALID_INPUT'],
  ];
  for (const [label, url, options, status, code] of cases) {
    // Node's fetch disallows body-bearing GET; a raw HTTP request proves the server boundary.
    let response, body;
    if (label === 'body-bearing GET') {
      const raw = await bounded(new Promise((resolve, reject) => {
        const request = http.request(url, options, incoming => {
          let text = ''; incoming.setEncoding('utf8'); incoming.on('data', part => {text += part; if (Buffer.byteLength(text) > 65536) request.destroy(Error('Raw GET response bound exceeded'));});
          incoming.once('end', () => {try {resolve({status: incoming.statusCode, body: JSON.parse(text)});} catch (error) {reject(error);}}); incoming.once('error', reject);
        });
        const closed = new Promise(done => request.once('close', done));
        t.after(async () => {request.destroy(); await bounded(closed, 'Exact raw GET close');});
        request.setTimeout(5000, () => request.destroy(Error('Raw GET deadline exceeded'))); request.once('error', reject); request.end('x');
      }), label);
      response = {status: raw.status}; body = raw.body;
    } else {response = await fetch(url, {...(options ?? {headers: {authorization: 'Bearer ' + token}}), signal: AbortSignal.timeout(15000)}); body = await response.json();}
    assert.equal(response.status, status, label + ': ' + JSON.stringify(body)); assert.equal(body.ok, false, label); assert.equal(body.error.code, code, label); publicOnly(body, f.root);
  }
  for (const extra of [{path: '/private/source.wav'}, {requestId: randomUUID()}, {endFrame: 10}, {gain: 2}]) {
    assert.throws(() => parse(operation, {...f.input, ...extra}));
    const result = await rpc(f.backend.url, {...f.input, ...extra}); assert.equal(result.response.status, 400); assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  }
  const cliBad = await cli(t, f.backend.url, [...operation.split('.'), '--input', JSON.stringify({...f.input, path: '/private/source.wav'})]);
  assert.notEqual(cliBad.code, 0); assert.equal(cliBad.body.error.code, 'VALIDATION_ERROR');
  const mcp = await official(t, f.backend.url), mcpBad = await mcp.call(toolName, {...f.input, path: '/private/source.wav'});
  assert.equal(mcpBad.ok, false); assert.equal(mcpBad.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(events, [], 'Rejected inputs never launch a media child'); await f.unchanged(before);
});

test('shared client rejects malformed audio plan identity and accounting without retry or mutation recovery claims', {timeout: 30000}, async t => {
  const f = await fixture(t), plan = await f.client.rpc(operation, f.input), before = await f.checkpoint();
  for (const change of [value => {value.projectId = randomUUID();}, value => {value.timelineId = randomUUID();},
    value => {value.timelineRevision++;}, value => {value.range.startFrame++;}, value => {value.memory.admittedBytes++;},
    value => {value.sources[0].pcmBytes--;}, value => {value.unrecognized = true;}]) {
    const invalid = structuredClone(plan); change(invalid); let requests = 0;
    const client = createClient({env: environment(f.backend.url), fetchImpl: async (_url, options) => {
      requests++; assert.deepEqual(JSON.parse(options.body), {operation, input: f.input});
      return new Response(JSON.stringify({ok: true, data: invalid}), {headers: {'content-type': 'application/json'}});
    }});
    await assert.rejects(client.rpc(operation, f.input), error => error.code === 'BACKEND_PROTOCOL_ERROR' && !Object.hasOwn(error.details ?? {}, 'submissionMayHaveSucceeded'));
    assert.equal(requests, 1);
  }
  await f.unchanged(before);
});

test('real HTTP disconnect during an actual bounded FFmpeg decode reaps the exact child and leaves a fresh explicit preparation available', {timeout: 45000}, async t => {
  const f = await fixture(t), plan = await f.client.rpc(operation, f.input), before = await f.checkpoint();
  const events = [], entered = Promise.withResolvers(), reaped = Promise.withResolvers(); let request, targetPid, receivedResponse = false;
  const off = onMediaProcess(event => {
    events.push(event);
    if (event.type === 'started' && event.kind === 'ffmpeg' && targetPid === undefined) {
      targetPid = event.pid; request.destroy(); entered.resolve(event);
    }
    if (event.type === 'exited' && event.pid === targetPid) reaped.resolve(event);
  }); t.after(off);
  request = http.get(pcmUrl(f.backend.url, f.sourceInput(plan)), {headers: {authorization: 'Bearer ' + token}}, response => {receivedResponse = true; response.resume();});
  const closed = new Promise(resolve => request.once('close', resolve)); request.on('error', () => {});
  t.after(async () => {request.destroy(); await bounded(closed, 'Exact cancelled request close');});
  await bounded(entered.promise, 'Actual PCM decoder start'); await bounded(closed, 'Cancelled HTTP close');
  assert.equal((await bounded(reaped.promise, 'Exact owned decoder reap')).pid, targetPid);
  assert.equal(receivedResponse, false, 'No partial source becomes a successful HTTP response');
  await tick(); await tick();
  assert.equal(hasUnconfirmedMediaProcesses(), false); await f.unchanged(before);
  const response = await fetch(pcmUrl(f.backend.url, f.sourceInput(plan)), {headers: {authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000)});
  verifyHeaders(response, plan); verifyPcm(Buffer.from(await response.arrayBuffer()), plan, f.bytes);
  assert.equal(events.filter(event => event.type === 'started' && event.kind === 'ffmpeg').length, 2, 'Only the cancelled attempt and new explicit preparation decode');
  assert.equal(events.filter(event => event.type === 'exited' && event.pid === targetPid).length, 1);
  assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.pid).sort(), events.filter(event => event.type === 'exited').map(event => event.pid).sort());
  await f.unchanged(before);
});
