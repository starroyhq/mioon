import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient, discoverSchema, effectAnnotations} from '@mioon/client';
import {isExportPreflightResponse, isTimelineMutationResponse, publicValue} from '@mioon/contracts';
import {startServer} from '../apps/server/src/index.mjs';
import {openStore} from '../packages/business/src/db.mjs';
import {mediaEnvironment} from '../packages/business/src/media-environment.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.mjs';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'synthetic-named-delivery-transport-token';
const NAME = ' 交付 Café e\u0301 🎬 / Final.mp4 ';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const environment = url => ({...mediaEnvironment(), MIOON_ENABLE_LIVE_PROVIDER: '0',
  ...(url ? {MIOON_BASE_URL: url, MIOON_TOKEN: TOKEN} : {})});
const noPrivate = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(TOKEN), 'public output omits the synthetic bearer token');
  assert.ok(!text.includes('Bearer '), 'public output omits authorization headers');
};
async function bounded(promise, label, milliseconds = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Text listeners: CLI stdout, CLI stderr, and official SDK stderr only. Set the
// stream decoder before attaching each data listener so split UTF-8 survives.
// Official MCP stdout framing belongs to the SDK and remains binary Buffer data.
async function cli(url, args) {
  const child = spawn(process.execPath, [path.join(REPO, 'apps/cli/src/index.mjs'), ...args], {
    cwd: REPO, env: environment(url), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '', stderr = '', bytes = 0, failure, timedOut = false, closed = false;
  const ended = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({code, signal}); }));
  child.once('error', error => { failure = error; });
  for (const [stream, append] of [[child.stdout, part => { stdout += part; }], [child.stderr, part => { stderr += part; }]]) {
    stream.setEncoding('utf8').on('data', part => {
      bytes += Buffer.byteLength(part);
      if (bytes > 4 * 1024 * 1024) { failure ??= Error('CLI output exceeded its byte cap'); child.kill('SIGKILL'); return; }
      append(part);
    });
  }
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
  let result;
  try { result = await bounded(ended, 'CLI close', 33_000); }
  finally {
    clearTimeout(deadline);
    if (!closed) { child.kill('SIGKILL'); await bounded(ended, 'Owned CLI forced close', 3_000); }
  }
  if (failure) throw failure;
  assert.equal(timedOut, false, 'CLI completed before its deadline');
  assert.equal(result.signal, null, stderr);
  noPrivate(stdout); noPrivate(stderr);
  assert.equal(stdout.trim().split('\n').length, 1, 'exactly one actual CLI JSON acknowledgement');
  const body = JSON.parse(stdout);
  assert.equal(result.code === 0, body.ok, stdout + stderr);
  return body;
}

async function officialMcp(t, url) {
  const client = new Client({name: 'named-delivery-transport-acceptance', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(REPO, 'apps/mcp/src/index.mjs')],
    cwd: REPO, env: environment(url), stderr: 'pipe', maxBufferSize: 4 * 1024 * 1024});
  let stderr = '', stderrBytes = 0, overflow = false, closing;
  const close = () => closing ??= bounded(client.close(), 'Owned official MCP close', 8_000);
  transport.stderr.setEncoding('utf8').on('data', part => {
    stderrBytes += Buffer.byteLength(part);
    if (stderrBytes > 64 * 1024) { overflow = true; void close().catch(() => {}); return; }
    stderr += part;
  });
  t.after(async () => { await close(); assert.equal(overflow, false); noPrivate(stderr); assert.equal(transport.pid, null); });
  await bounded(client.connect(transport), 'Official MCP initialization', 10_000);
  assert.equal(client.getServerVersion().name, 'mioon');
  const call = async (operation, input) => {
    const result = await client.callTool({name: operation === 'mioon_schema' ? operation : operation.replaceAll('.', '_'), arguments: input},
      undefined, {timeout: 30_000});
    const blocks = result.content.filter(block => block.type === 'text');
    assert.equal(blocks.length, 1, 'official MCP has one text acknowledgement');
    const body = JSON.parse(blocks[0].text);
    assert.deepEqual(result.structuredContent, body, 'text and structuredContent carry the real same envelope');
    assert.equal(Boolean(result.isError), !body.ok);
    noPrivate(result); noPrivate(stderr); assert.equal(overflow, false);
    return body;
  };
  return {client, call, close};
}

// Same actual-business fixture strategy as export-settings-transports: valid
// CRCs, compressed synthetic pixels, real HTTP import, SQLite and local worker.
// Only two three-frame renders are admitted in this file, independent of the
// number of protocol checks. No paid provider or fixture-generation child runs.
function syntheticPng() {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(16 * 49, 90); for (let row = 0; row < 16; row++) rows[row * 49] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function manifest(root, relative = '') {
  const entries = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push({directory: name}, ...await manifest(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock')
      entries.push({file: name, sha256: sha256(await readFile(path.join(root, name)))});
  }
  return entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function responseBytes(response, cap = 4 * 1024 * 1024) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let bytes = 0;
  for await (const part of response.body) {
    bytes += part.byteLength;
    if (bytes > cap) throw Error('HTTP response exceeded its byte cap');
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-named-delivery-wire-'));
  let backend, proxy, db, official, dropNext = false;
  const submissions = [], observed = [], proxyErrors = [];
  const start = () => startServer({dataDir: root, port: 0, token: TOKEN,
    chatGateway: async function* () { throw Error('No model or provider call is permitted'); }});
  t.after(async () => {
    const failures = [];
    for (const cleanup of [() => official?.close(), async () => {
      if (proxy) { proxy.closeAllConnections(); await bounded(new Promise(resolve => proxy.close(resolve)), 'Proxy close', 5_000); }
    }, () => backend?.close(), () => db?.close(), () => rm(root, {recursive: true, force: true})]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Named-delivery fixture cleanup failed');
    assert.deepEqual(proxyErrors, [], 'the fixture did not hide an upstream or parsing failure');
  });
  backend = await start();
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = []; let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 32 * 1024) throw Error('Proxy request exceeded its byte cap');
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
      submissions.push(body);
      const upstream = await fetch(backend.url + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'}, body: raw});
      const bytesOut = await responseBytes(upstream), text = bytesOut.toString('utf8');
      observed.push({body, text, status: upstream.status});
      if (dropNext && body.operation === 'timeline.render') { dropNext = false; response.destroy(); return; }
      response.writeHead(upstream.status, {'content-type': 'application/json'}); response.end(bytesOut);
    } catch (error) { proxyErrors.push(error.message); response.destroy(); }
  });
  proxy.listen(0, '127.0.0.1'); await bounded(once(proxy, 'listening'), 'Proxy startup', 5_000);
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const direct = createClient({env: environment(backend.url)}), client = createClient({env: environment(url)});
  const project = await direct.rpc('project.create', {name: 'Unrelated editable project title'});
  let timeline = await direct.rpc('timeline.get', {projectId: project.id});
  const png = syntheticPng(), source = await direct.rpc('asset.import', {projectId: project.id,
    name: 'Synthetic pixels.png', mimeType: 'image/png', dataBase64: png.toString('base64')});
  assert.equal(source.sha256, sha256(png)); assert.equal(source.sizeBytes, png.length);
  timeline = await direct.rpc('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision,
    requestId: randomUUID(), assetId: source.id, trackId: timeline.tracks.find(track => track.kind === 'video').id,
    startFrame: 0, durationFrames: 3});
  db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const rows = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) =>
    [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  const checkpoint = async () => ({rows: rows(), version: db.prepare('PRAGMA data_version').get().data_version, files: await manifest(root)});
  const unchanged = async before => {
    assert.deepEqual(rows(), before.rows, 'no additional persisted rows or equal-value changes');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before.version, 'no SQLite commit');
    assert.deepEqual(await manifest(root), before.files, 'no source/output/cache file writes');
  };
  official = await officialMcp(t, url);
  const raw = async (operation, input) => {
    const response = await fetch(url + '/api/rpc', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'}, body: JSON.stringify({operation, input})});
    const body = JSON.parse((await responseBytes(response)).toString('utf8'));
    assert.equal(response.ok, body.ok); noPrivate(body); return body;
  };
  return {root, project, source, timeline, db, client, submissions, observed, checkpoint, unchanged,
    lose: () => { dropNext = true; },
    transports: [{name: 'HTTP', call: raw}, {name: 'CLI', call: (operation, input) => cli(url, [...operation.split('.'), '--input', JSON.stringify(input)])},
      {name: 'MCP', call: official.call}],
    async restartAndRename() {
      await backend.close();
      // There is no public project.rename RPC. Change this disposable fixture's
      // editable project through the real store only while the server is closed.
      const store = openStore(root);
      try {
        const current = store.get('projects', project.id);
        store.put('projects', {...current, name: 'Renamed after delivery 新项目', revision: current.revision + 1});
      } finally { store.close(); }
      backend = await start();
    },
    async finished(exportId) {
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        const value = await client.rpc('export.get', {exportId}, {timeoutMs: Math.max(1, deadline - Date.now())});
        if (['succeeded', 'failed'].includes(value.status)) {
          assert.equal(value.status, 'succeeded', JSON.stringify(value.error)); return value;
        }
        await pause(Math.max(0, Math.min(25, deadline - Date.now())));
      }
      assert.fail('The synthetic local render did not reach a terminal state');
    },
    async media(relative, options = {}) {
      const response = await fetch(backend.url + relative, {redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: {authorization: 'Bearer ' + TOKEN, ...options.headers}, ...options});
      const bytes = await responseBytes(response);
      return {response, bytes};
    },
  };
}

function success(envelope) { assert.equal(envelope.ok, true, JSON.stringify(envelope)); return envelope.data; }
function failure(envelope, code) {
  assert.equal(envelope.ok, false, JSON.stringify(envelope)); assert.equal(envelope.error.code, code, JSON.stringify(envelope)); return envelope.error;
}
function downloadName(header) {
  assert.match(header, /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/u);
  return decodeURIComponent(/filename\*=UTF-8''([^;\s]+)/u.exec(header)[1]);
}


test('named delivery discovery stays identical in offline CLI and official MCP and does not expand unrelated operations', {timeout: 45_000}, async t => {
  const catalog = discoverSchema(); assert.deepEqual(success(await cli(undefined, ['schema'])), catalog);
  const official = await officialMcp(t), tools = (await official.client.listTools()).tools;
  assert.deepEqual(success(await official.call('mioon_schema', {})), catalog);
  for (const operation of ['timeline.render', 'timeline.export.preflight', 'timeline.export.capabilities', 'export.create']) {
    const definition = catalog.operations.find(item => item.operation === operation);
    const tool = tools.find(item => item.name === operation.replaceAll('.', '_'));
    assert.ok(definition && tool); assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(definition.effects));
    assert.equal(definition.inputSchema.additionalProperties, false);
    const acceptsName = ['timeline.render', 'timeline.export.preflight'].includes(operation);
    assert.equal(Object.hasOwn(definition.inputSchema.properties, 'deliveryName'), acceptsName);
    assert.equal(definition.inputSchema.required?.includes('deliveryName') ?? false, false);
  }
  assert.ok(!JSON.stringify(READ_TOOL_DEFINITIONS).includes('deliveryName'));
  assert.ok(!JSON.stringify(EDIT_TOOL_DEFINITIONS).includes('deliveryName'));
});


test('actual HTTP CLI and official MCP preserve named and omitted delivery identities through preflight, lost ACK, restart and historical download', {timeout: 180_000}, async t => {
  const w = await fixture(t), base = {projectId: w.project.id, expectedRevision: w.timeline.revision};
  let namedReport;
  await t.test('preflight binds exact Unicode name presence and refuses unrelated fields without writes', async () => {
    const before = await w.checkpoint();
    for (const transport of w.transports) {
      const input = {...base, deliveryName: NAME};
      const report = success(await transport.call('timeline.export.preflight', input));
      assert.equal(isExportPreflightResponse(report, input), true); assert.equal(report.status, 'ready');
      assert.equal(report.summary.deliveryName, NAME, 'display metadata is neither trimmed nor Unicode-normalized');
      if (namedReport) assert.equal(report.snapshotHash, namedReport.snapshotHash); else namedReport = report;
      const omitted = success(await transport.call('timeline.export.preflight', base));
      assert.equal(Object.hasOwn(omitted.summary, 'deliveryName'), false); assert.notEqual(omitted.snapshotHash, report.snapshotHash);
      const changed = success(await transport.call('timeline.export.preflight', {...input, deliveryName: NAME + ' v2'}));
      assert.notEqual(changed.snapshotHash, report.snapshotHash);
      for (const deliveryName of ['', '   ', null, 'unsafe\nheader', 'x'.repeat(121), '\ud800']) {
        failure(await transport.call('timeline.export.preflight', {...base, deliveryName}), 'VALIDATION_ERROR');
        failure(await transport.call('timeline.render', {...base, requestId: randomUUID(), purpose: 'export', deliveryName}), 'VALIDATION_ERROR');
      }
      failure(await transport.call('timeline.render', {...base, requestId: randomUUID(), purpose: 'preview', deliveryName: NAME}), 'VALIDATION_ERROR');
      failure(await transport.call('timeline.export.capabilities', {...base, deliveryName: NAME,
        exportSettings: {profileId: 'mp4_h264_v1', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}}}), 'VALIDATION_ERROR');
      failure(await transport.call('export.create', {projectId: w.project.id, requestId: randomUUID(), deliveryName: NAME}), 'VALIDATION_ERROR');
      failure(await transport.call('timeline.export.preflight', {...input, filename: 'caller.mp4'}), 'VALIDATION_ERROR');
      await w.unchanged(before);
    }
  });

  const namedInput = {...base, requestId: randomUUID(), purpose: 'export', deliveryName: NAME,
    preflightSnapshotHash: namedReport.snapshotHash};
  let original, receipt;
  await t.test('all three transports can lose the same committed named ACK without creating more than one render', async () => {
    for (const transport of w.transports) {
      const count = w.submissions.length; w.lose();
      if (transport.name === 'HTTP') await assert.rejects(transport.call('timeline.render', namedInput), /fetch failed|socket|terminated/i);
      else {
        const lost = await transport.call('timeline.render', namedInput);
        assert.equal(lost.ok, false); assert.equal(lost.error.details.submissionMayHaveSucceeded, true);
        assert.equal(lost.error.details.requestId, namedInput.requestId);
        assert.notEqual(lost.error.details.mutationOutcome, 'not_applied');
      }
      assert.equal(w.submissions.length, count + 1, 'no transport silently retries an ambiguous submit');
      const observed = w.observed.at(-1); assert.equal(observed.status, 200);
      const accepted = JSON.parse(observed.text);
      if (original) assert.deepEqual(accepted, original); else original = accepted;
      const render = success(accepted); assert.equal(isTimelineMutationResponse('timeline.render', namedInput, render), true);
      assert.equal(render.snapshot.deliveryName, NAME); assert.equal(Object.hasOwn(render.snapshot, 'delivery'), false, 'name-only export does not opt into encoding settings');
      const stored = w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(namedInput.requestId).response;
      if (receipt) assert.equal(stored, receipt); else receipt = stored;
      assert.deepEqual(publicValue(JSON.parse(stored)), render);
      assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports').get().n, 1);
    }
  });
  const completed = await w.finished(original.data.id);
  assert.deepEqual(completed.snapshot, original.data.snapshot);
  const artifact = (await w.client.rpc('asset.list', {projectId: w.project.id})).find(asset => asset.id === completed.assetId);
  assert.equal(artifact.mimeType, 'video/mp4');
  const downloadPath = `/media/${completed.assetId}?download=1&exportId=${completed.id}`;
  const downloaded = await w.media(downloadPath); assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.response.headers.get('content-type'), 'video/mp4');
  assert.equal(sha256(downloaded.bytes), artifact.sha256);
  assert.equal(downloaded.bytes.length, artifact.sizeBytes);
  const disposition = downloaded.response.headers.get('content-disposition');
  assert.equal(downloadName(disposition), `交付 Café e\u0301 🎬 _ Final-${completed.id.slice(-12)}.mp4`);
  assert.ok(!disposition.includes(w.project.name));

  const legacyInput = {...base, requestId: randomUUID(), purpose: 'export'};
  const legacy = await w.transports[1].call('timeline.render', legacyInput);
  assert.equal(Object.hasOwn(success(legacy).snapshot, 'deliveryName'), false);
  assert.equal(Object.hasOwn(legacy.data.snapshot, 'delivery'), false);
  const legacyReceipt = w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(legacyInput.requestId).response;
  const legacyCompleted = await w.finished(legacy.data.id);
  const legacyDownload = await w.media(`/media/${legacyCompleted.assetId}?download=1`);
  assert.equal(legacyDownload.response.status, 200);
  assert.equal(legacyDownload.response.headers.get('content-disposition'), 'attachment; filename="mioon.mp4"');
  assert.equal((await w.media(`/media/${legacyCompleted.assetId}?download=1&exportId=${legacyCompleted.id}`)).response.status, 404);

  // Later timeline changes remove even the original source clip, while the
  // source asset remains owned and the historical frozen render stays readable.
  const edited = await w.client.rpc('timeline.clip.remove', {...base, requestId: randomUUID(), clipId: w.timeline.clips[0].id});
  assert.ok(edited.revision > base.expectedRevision);
  await w.restartAndRename();
  await t.test('exact named and omitted ACKs win over stale revisions and changed project metadata after restart', async () => {
    const before = await w.checkpoint(), events = [], off = onMediaProcess(event => events.push(event));
    try {
      for (const transport of w.transports) {
        assert.deepEqual(await transport.call('timeline.render', namedInput), original);
        assert.deepEqual(await transport.call('timeline.render', legacyInput), legacy);
        const removed = {...namedInput}; delete removed.deliveryName;
        for (const changed of [{...namedInput, deliveryName: NAME + ' changed'}, removed, {...legacyInput, deliveryName: NAME}])
          failure(await transport.call('timeline.render', changed), 'IDEMPOTENCY_CONFLICT');
        failure(await transport.call('timeline.render', {...namedInput, requestId: randomUUID()}), 'REVISION_CONFLICT');
        await w.unchanged(before);
      }
      assert.deepEqual(events, [], 'replay and stable-key conflicts do not start media processes');
    } finally { off(); }
    assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(namedInput.requestId).response, receipt);
    assert.equal(w.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(legacyInput.requestId).response, legacyReceipt);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM exports').get().n, 2, 'only two local renders were admitted');
    const historical = await w.client.rpc('export.get', {exportId: completed.id});
    assert.deepEqual(historical.snapshot, original.data.snapshot); assert.equal(historical.status, 'succeeded');
    const renamed = await w.client.rpc('project.get', {projectId: w.project.id});
    assert.equal(renamed.project.name, 'Renamed after delivery 新项目');
    await w.unchanged(before);
  });
  await t.test('authenticated historical download keeps exact server-derived filename and bytes while forged identities fail closed', async () => {
    const before = await w.checkpoint();
    const historical = await w.media(downloadPath);
    assert.equal(historical.response.status, 200); assert.equal(historical.response.headers.get('content-disposition'), disposition);
    assert.deepEqual(historical.bytes, downloaded.bytes);
    const head = await w.media(downloadPath, {method: 'HEAD'});
    assert.equal(head.response.status, 200); assert.equal(head.response.headers.get('content-disposition'), disposition); assert.equal(head.bytes.length, 0);
    const denied = await w.media(downloadPath, {headers: {authorization: 'Bearer incorrect-synthetic-token'}});
    assert.equal(denied.response.status, 401); assert.equal(denied.response.headers.get('content-disposition'), null);
    for (const relative of [downloadPath + '&filename=caller.mp4', downloadPath + '&deliveryName=caller',
      downloadPath + `&exportId=${completed.id}`, downloadPath.replace('download=1', 'download=0'),
      `/media/${w.source.id}?download=1&exportId=${completed.id}`, `/media/${completed.assetId}?download=1&exportId=${randomUUID()}`]) {
      const rejected = await w.media(relative); assert.equal(rejected.response.status, 404, relative);
      assert.equal(rejected.response.headers.get('content-disposition'), null);
      assert.notDeepEqual(rejected.bytes, downloaded.bytes);
    }
    await w.unchanged(before);
  });
});
