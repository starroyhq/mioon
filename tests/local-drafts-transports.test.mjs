import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {LOCAL_DRAFT_LIMITS, clipDraftEnvelopeSchema, clipDraftListSchema} from '@mioon/contracts/local-drafts';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {syntheticPng} from './helpers/runway-unknown-fixture.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const workerPath = fileURLToPath(new URL('./fixtures/local-drafts-process.mjs', import.meta.url));
const token = 'synthetic-local-drafts-http-process-token';
const clipRoute = key => '/api/local-drafts/clip?' + new URLSearchParams(key);
const listRoute = projectId => '/api/local-drafts?projectId=' + projectId;
const taskRoute = (id, action = '') => `/api/tasks/${id}${action ? '/' + action : ''}`;
const authority = value => ({workspaceScope: value.workspaceScope, instanceId: value.instanceId});
const discard = value => ({...authority(value), ...value.key, expectedRevision: value.revision});
const taskAction = (f, value) => ({projectId: f.project.id, digest: value.task.digest, instanceId: value.instanceId});
const rowData = row => JSON.parse(row.data);

function deadline(promise, label, milliseconds = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function request(url, route, {method = 'GET', input, raw, authenticated = true, headers = {}, chunked = false} = {}) {
  const payload = raw ?? (input === undefined ? undefined : JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, {method, agent: false, headers: {
      'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}),
      ...(payload !== undefined && !chunked ? {'content-length': Buffer.byteLength(payload)} : {}), ...headers,
    }}, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 2 * 1024 * 1024) res.destroy(Error('Synthetic response cap')); });
      res.once('error', reject);
      res.once('end', () => {
        try { resolve({status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null}); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(Error('Synthetic HTTP request timeout')));
    req.once('error', reject);
    req.end(payload);
  });
}

function startProcess(root, auditPath) {
  const child = spawn(process.execPath, [workerPath, auditPath], {cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', NODE_ENV: 'test',
      MIOON_ENABLE_LIVE_PROVIDER: '0', RUNWAY_MAX_GENERATIONS: '0'},
  });
  let output = '', outputBytes = 0, stopped;
  // One inventoried text-consumer registration, shared by the two owned pipes.
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => {
    output = (output + chunk).slice(-8000);
    outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + Buffer.byteLength(chunk));
  });
  const ready = Promise.withResolvers(), exited = Promise.withResolvers(), pending = new Map();
  const rejectPending = error => { ready.reject(error); for (const reply of pending.values()) reply.reject(error); };
  child.once('error', rejectPending);
  child.once('close', (code, signal) => {
    stopped = {code, signal};
    rejectPending(Object.assign(Error(`Owned backend closed (${code}, ${signal}); ${outputBytes} output bytes\n${output}`), {code: 'FIXTURE_EXITED'}));
    exited.resolve(stopped);
  });
  child.on('message', message => {
    if (message.type === 'ready') ready.resolve(message);
    else if (message.type === 'reply') pending.get(message.id)?.resolve(message.data);
    else if (message.type === 'fatal') rejectPending(Error(message.message));
  });
  child.send({type: 'start', root, token}, error => { if (error) rejectPending(error); });
  return {child, ready: ready.promise, exited: exited.promise,
    diagnostic: () => ({pid: child.pid, outputBytes, output, exitCode: child.exitCode, signalCode: child.signalCode}),
    async ask(type, fields = {}) {
      assert.equal(stopped, undefined, 'fixture IPC cannot contact a stopped child');
      const id = randomUUID(), reply = Promise.withResolvers(); pending.set(id, reply);
      child.send({type, id, ...fields}, error => { if (error) reply.reject(error); });
      try { return await deadline(reply.promise, 'fixture IPC'); } finally { pending.delete(id); }
    },
    async close() {
      if (stopped) return stopped;
      if (child.connected) child.send({type: 'close'}, () => {});
      try { return await deadline(exited.promise, 'owned backend close'); }
      catch (error) { child.kill('SIGKILL'); await deadline(exited.promise, 'owned backend kill'); throw error; }
    },
    async kill() {
      if (!stopped) child.kill('SIGKILL');
      const result = await deadline(exited.promise, 'owned backend crash');
      assert.deepEqual(result, {code: null, signal: 'SIGKILL'});
      return result;
    },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-local-drafts-')));
  const auditPath = path.join(root, 'synthetic-forbidden-effects.jsonl');
  await writeFile(auditPath, '');
  const processes = [], reservations = [], requests = [], observed = [];
  let backend, url, proxy, dropRoute;
  t.after(async () => {
    const failures = [];
    for (const cleanup of [
      async () => { if (proxy) { proxy.closeAllConnections(); await deadline(new Promise(resolve => proxy.close(resolve)), 'proxy close'); } },
      ...reservations.map(server => async () => { server.closeAllConnections(); await deadline(new Promise(resolve => server.close(resolve)), 'port reservation close'); }),
      ...processes.map(worker => () => worker.close()),
      () => rm(root, {recursive: true, force: true}),
    ]) { try { await cleanup(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, 'Owned local-drafts fixture cleanup failed');
  });
  const store = openStore(root);
  let project, other, source, sourceRelativePath, timeline;
  try {
    const services = createServices(store, new Map());
    project = await services.call('project.create', {name: 'Synthetic local clip draft'});
    other = await services.call('project.create', {name: 'FOREIGN_DRAFT_PROJECT_MUST_NOT_LEAK'});
    // Exercise the real importer and its ownership/hash lineage, using a shared
    // inert PNG. No hand-written asset rows or fake generated-source lineage.
    source = await services.call('asset.import', {projectId: project.id, name: 'Synthetic imported pixel.png',
      mimeType: 'image/png', dataBase64: syntheticPng.toString('base64')});
    // Public service results deliberately omit private managed paths; retain
    // only this fixture-owned row's actual path for exact backup verification.
    sourceRelativePath = store.get('assets', source.id).relativePath;
    timeline = await services.call('timeline.get', {projectId: project.id});
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision,
      requestId: randomUUID(), assetId: source.id, trackId: timeline.tracks[0].id,
      startFrame: 0, durationFrames: 90, name: 'Original saved clip'});
  } finally { store.close(); }
  const key = {projectId: project.id, timelineId: timeline.id, clipId: timeline.clips[0].id};
  const start = async () => {
    backend = startProcess(root, auditPath); processes.push(backend);
    let ready;
    try { ready = await deadline(backend.ready, 'owned backend readiness'); }
    catch (error) { t.diagnostic(JSON.stringify(backend.diagnostic())); throw error; }
    assert.equal(ready.pid, backend.child.pid); assert.notEqual(ready.pid, process.pid);
    assert.equal(new URL(ready.url).hostname, '127.0.0.1');
    url = ready.url;
    assert.equal((await request(url, '/health')).status, 200);
  };
  await start();
  proxy = http.createServer(async (req, res) => {
    try {
      req.setEncoding('utf8');
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32 * 1024) throw Error('Synthetic proxy body cap'); }
      requests.push({method: req.method, route: req.url});
      const result = await request(url, req.url, {method: req.method, ...(raw ? {raw} : {})});
      observed.push({route: req.url, ...result});
      if (dropRoute === req.url) { dropRoute = undefined; res.destroy(); return; }
      res.writeHead(result.status, {'content-type': 'application/json'}); res.end(JSON.stringify(result.body));
    } catch { res.destroy(); }
  });
  await deadline(new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); }), 'proxy listen');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  return {root, project, other, source, sourceRelativePath, timeline, key, requests, observed,
    get url() { return url; }, get backend() { return backend; },
    request: (route, options) => request(url, route, options),
    viaProxy: (route, options) => request(proxyUrl, route, options),
    lose: route => { dropRoute = route; },
    async data(route, options) {
      const result = await this.request(route, options);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.ok, true);
      return result.body.data;
    },
    get: () => request(url, clipRoute(key)),
    async draft() { const value = await this.data(clipRoute(key)); assert.ok(clipDraftEnvelopeSchema.safeParse(value).success); return value; },
    async list(projectId = project.id) { const value = await this.data(listRoute(projectId)); assert.ok(clipDraftListSchema.safeParse(value).success); return value; },
    rpc(operation, input) { return this.data('/api/rpc', {method: 'POST', input: {operation, input}}); },
    prepare(input) { return this.data('/api/tasks/prepare', {method: 'POST', input: {projectId: project.id, operation: 'timeline.clip.update', input, origin: 'new'}}); },
    async restart() {
      const oldUrl = url, oldPid = backend.child.pid;
      if (backend.child.exitCode === null && backend.child.signalCode === null) await backend.kill();
      else await deadline(backend.exited, 'crashed backend close');
      // Reserve the old listener while port:0 binds: the new-port assertion is
      // deterministic rather than depending on the kernel's ephemeral choice.
      const reservation = http.createServer((_req, res) => res.end()); reservations.push(reservation);
      await deadline(new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(Number(new URL(oldUrl).port), '127.0.0.1', resolve); }), 'old port reservation');
      await start();
      assert.notEqual(url, oldUrl); assert.notEqual(backend.child.pid, oldPid);
    },
    read(fn) {
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
      try { return fn(db); } finally { db.close(); }
    },
    snapshot() {
      return this.read(db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])));
    },
    async noEffects() {
      assert.equal(await readFile(auditPath, 'utf8'), '', 'draft work attempted no network/provider/media action');
      assert.deepEqual((await backend.ask('observe')).phases, [], 'draft reads/writes never prepare or dispatch durable tasks');
    },
  };
}

const rawClip = (f, patch = {}) => {
  const clip = f.timeline.clips[0];
  return {name: clip.name, trackId: clip.trackId, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
    sourceInFrame: clip.sourceInFrame, rect: {...clip.rect}, gain: clip.gain, ...patch};
};
const write = (f, envelope, raw = rawClip(f)) => ({...authority(envelope), ...f.key, expectedRevision: envelope.revision,
  baseRevision: f.timeline.revision, source: {assetId: f.source.id, assetSha256: f.source.sha256}, raw});
const safeError = (result, f, code, status = 400) => {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false);
  if (code) assert.equal(result.body.error.code, code);
  assert.equal(result.body.error.retryable, false); assert.deepEqual(result.body.error.details, {});
  for (const value of [token, f.root, 'FOREIGN_DRAFT_PROJECT_MUST_NOT_LEAK', 'SECRET_FIELD_MUST_NOT_PERSIST'])
    assert.equal(JSON.stringify(result.body).includes(value), false);
};

test('clip drafts survive SIGKILL/new port with exact raw text; authenticated rediscovery stays read-only', {timeout: 30000}, async t => {
  const f = await fixture(t), before = f.snapshot(), sidecar = path.join(f.root, 'local-drafts-v1.json');
  const initial = await f.draft();
  assert.equal(initial.revision, 0); assert.equal(initial.draft, null); assert.equal(initial.targetStatus, 'matching');
  assert.deepEqual((await f.list()).items, []);
  await assert.rejects(stat(sidecar), {code: 'ENOENT'});
  const raw = rawClip(f, {name: '  未保存 🎬  ', startFrame: '-', durationFrames: '', sourceInFrame: '1e',
    gain: ' 0.50 ', rect: {x: '', y: '-.', width: '003.00', height: '1e+'}, fadeInFrames: '', fadeOutFrames: '-'});
  const input = write(f, initial, raw);
  const saved = await f.data('/api/local-drafts/clip', {method: 'PUT', input});
  assert.equal(saved.revision, 1); assert.deepEqual(saved.draft.raw, raw); assert.deepEqual(saved.draft.source, input.source);
  assert.deepEqual(f.snapshot(), before, 'draft persistence cannot touch any main database table');
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
  const bytes = await readFile(sidecar), diskBefore = await stat(sidecar);
  assert.equal(bytes.includes(Buffer.from(token)), false);
  await f.noEffects();
  await f.restart();
  const restored = await f.draft();
  assert.notEqual(restored.instanceId, saved.instanceId); assert.equal(restored.workspaceScope, saved.workspaceScope);
  assert.deepEqual(restored.draft, saved.draft); assert.equal(restored.revision, 1);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input}), f, 'LOCAL_DRAFT_STALE_INSTANCE', 409);
  safeError(await f.request('/api/local-drafts/clip', {method: 'DELETE', input: discard(saved)}), f, 'LOCAL_DRAFT_STALE_INSTANCE', 409);
  for (let count = 0; count < 3; count++) {
    assert.deepEqual((await f.viaProxy(clipRoute(f.key))).body.data, restored);
    assert.deepEqual((await f.list()).items.map(item => ({key: item.key, name: item.name})), [{key: f.key, name: raw.name}]);
  }
  assert.ok(f.requests.every(value => value.method === 'GET'));
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(await readFile(sidecar), bytes);
  assert.equal((await stat(sidecar)).mtimeMs, diskBefore.mtimeMs);
  await f.noEffects();
});

test('concurrent windows and lost PUT/DELETE acknowledgements use strict CAS across process crashes', {timeout: 30000}, async t => {
  const f = await fixture(t), initial = await f.draft(), before = f.snapshot();
  const candidates = ['window α', 'window β'].map(name => write(f, initial, rawClip(f, {name})));
  const outcomes = await Promise.all(candidates.map(input => f.request('/api/local-drafts/clip', {method: 'PUT', input})));
  assert.equal(outcomes.filter(value => value.status === 200).length, 1);
  safeError(outcomes.find(value => value.status !== 200), f, 'LOCAL_DRAFT_CONFLICT', 409);
  const winner = outcomes.find(value => value.status === 200).body.data;
  const next = write(f, winner, rawClip(f, {name: 'newer window, lost ACK 🎞️'}));
  f.lose('/api/local-drafts/clip');
  await assert.rejects(f.viaProxy('/api/local-drafts/clip', {method: 'PUT', input: next}));
  const accepted = f.observed.at(-1).body.data;
  assert.equal(accepted.revision, 2);
  safeError(await f.request('/api/local-drafts/clip', {method: 'DELETE', input: discard(winner)}), f, 'LOCAL_DRAFT_CONFLICT', 409);
  await f.restart();
  const recovered = await f.draft();
  assert.deepEqual(recovered.draft, accepted.draft);
  const replay = {...next, ...authority(recovered)};
  assert.deepEqual(await f.data('/api/local-drafts/clip', {method: 'PUT', input: replay}), recovered);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: {...replay, raw: rawClip(f)}}), f, 'LOCAL_DRAFT_CONFLICT', 409);
  const deletion = discard(recovered);
  f.lose('/api/local-drafts/clip');
  await assert.rejects(f.viaProxy('/api/local-drafts/clip', {method: 'DELETE', input: deletion}));
  const tombstone = f.observed.at(-1).body.data;
  assert.equal(tombstone.revision, 3); assert.equal(tombstone.draft, null);
  await f.restart();
  const current = await f.draft();
  assert.equal(current.revision, 3); assert.equal(current.draft, null);
  assert.deepEqual(await f.data('/api/local-drafts/clip', {method: 'DELETE', input: {...deletion, ...authority(current)}}), current);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: {...replay, ...authority(current)}}), f, 'LOCAL_DRAFT_CONFLICT', 409);
  assert.deepEqual((await f.list()).items, []);
  assert.deepEqual(f.requests.map(value => value.method), ['PUT', 'DELETE']);
  assert.deepEqual(f.snapshot(), before); await f.noEffects();
});

test('local draft HTTP keeps token/cookie/origin auth, exact fields, bounded bodies and project isolation', {timeout: 30000}, async t => {
  const f = await fixture(t), initial = await f.draft(), input = write(f, initial), before = f.snapshot();
  const routes = [
    {route: clipRoute(f.key)}, {route: listRoute(f.project.id)},
    {route: '/api/local-drafts/clip', method: 'PUT', input},
    {route: '/api/local-drafts/clip', method: 'DELETE', input: {...discard(initial), expectedRevision: 1}},
  ];
  for (const entry of routes) {
    for (const headers of [{}, {authorization: 'Bearer wrong'}]) {
      const result = await f.request(entry.route, {...entry, authenticated: false, headers});
      assert.equal(result.status, 401); assert.equal(result.body.error.code, 'UNAUTHORIZED');
    }
    for (const headers of [{origin: 'https://foreign.invalid'}, {origin: 'null'}, {host: 'foreign.invalid'}])
      assert.equal((await f.request(entry.route, {...entry, headers})).status, 403);
  }
  const login = await f.request('/api/login', {method: 'POST', input: {token}, authenticated: false});
  assert.equal(login.status, 200); const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const cookieRead = await f.request(clipRoute(f.key), {authenticated: false, headers: {cookie, origin: f.url}});
  assert.equal(cookieRead.status, 200); assert.equal(cookieRead.headers['cache-control'], 'no-store');
  assert.equal(cookieRead.headers['x-content-type-options'], 'nosniff');
  const invalidInputs = [
    {...input, extra: true}, {...input, expectedRevision: -1}, {...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1},
    {...input, projectId: 'bad'}, {...input, source: {...input.source, apiKey: 'SECRET_FIELD_MUST_NOT_PERSIST'}},
    {...input, raw: {...input.raw, requestId: randomUUID()}}, {...input, raw: {...input.raw, prompt: 'SECRET_FIELD_MUST_NOT_PERSIST'}},
    {...input, raw: {...input.raw, name: 'x'.repeat(201)}}, {...input, raw: {...input.raw, gain: 'x'.repeat(49)}},
    {...input, raw: {...input.raw, name: '\ud800'}}, {...input, raw: {...input.raw, gain: null}},
    {...input, raw: {...input.raw, rect: {...input.raw.rect, path: 'SECRET_FIELD_MUST_NOT_PERSIST'}}},
    {...input, raw: {...input.raw, fadeInFrames: true}}, {...input, raw: []},
  ];
  for (const value of invalidInputs) safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: value}), f, 'LOCAL_DRAFT_VALIDATION');
  for (const raw of ['{', 'null', '[]', 'true', '{"__proto__":{}}', JSON.stringify(input).replace('"gain":1', '"gain":1e400')])
    safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', raw}), f, 'LOCAL_DRAFT_VALIDATION');
  for (const headers of [{'content-type': 'text/plain'}, {'content-encoding': 'gzip'}])
    safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input, headers}), f, 'LOCAL_DRAFT_VALIDATION');
  for (const chunked of [false, true]) safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', chunked,
    raw: JSON.stringify(input) + ' '.repeat(LOCAL_DRAFT_LIMITS.httpBytes)}), f, 'LOCAL_DRAFT_LIMIT', 413);
  for (const route of [clipRoute(f.key) + '&extra=1', clipRoute(f.key) + '&projectId=' + f.project.id,
    listRoute(f.project.id) + '&extra=1', listRoute(f.project.id) + '&projectId=' + f.project.id])
    safeError(await f.request(route), f, 'LOCAL_DRAFT_VALIDATION');
  assert.equal((await f.request('/api/local-drafts/clip', {method: 'POST', input})).status, 405);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: {...input, workspaceScope: 'f'.repeat(64)}}), f, 'LOCAL_DRAFT_SCOPE_MISMATCH', 409);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: {...input, instanceId: randomUUID()}}), f, 'LOCAL_DRAFT_STALE_INSTANCE', 409);
  safeError(await f.request('/api/local-drafts/clip', {method: 'PUT', input: {...input, source: {...input.source, assetId: randomUUID()}}}), f, 'LOCAL_DRAFT_CONFLICT', 409);
  const saved = await f.data('/api/local-drafts/clip', {method: 'PUT', input, authenticated: false, headers: {cookie, origin: f.url}});
  assert.equal(saved.revision, 1); assert.deepEqual((await f.list(f.other.id)).items, []);
  assert.equal((await f.data(clipRoute({...f.key, projectId: f.other.id}))).draft, null);
  assert.deepEqual(f.snapshot(), before); await f.noEffects();
});

test('a real cold schema-26 backup excludes populated local drafts and preserves the source sidecar exactly', {timeout: 30000}, async t => {
  const f = await fixture(t), initial = await f.draft();
  const saved = await f.data('/api/local-drafts/clip', {method: 'PUT', input: write(f, initial,
    rawClip(f, {name: 'LOCAL_DRAFT_EXCLUDED_FROM_BACKUP_🎬', startFrame: '-', gain: ''}))});
  assert.equal(saved.revision, 1); await f.noEffects();
  await f.backend.close();
  await assert.rejects(stat(path.join(f.root, 'server.lock')), {code: 'ENOENT'});
  const sidecar = path.join(f.root, 'local-drafts-v1.json');
  const before = {bytes: await readFile(sidecar), stat: await stat(sidecar), database: await readFile(path.join(f.root, 'workbench.sqlite'))};
  const backupRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-local-drafts-backup-')));
  t.after(() => rm(backupRoot, {recursive: true, force: true}));
  const destination = path.join(backupRoot, 'capture');
  const result = await createWorkspaceBackup({source: f.root, destination});
  assert.equal(result.integrity, 'verified'); assert.equal(result.databaseSchemaVersion, 26);
  assert.equal(result.inventory.complete, true);
  assert.deepEqual(await verifyWorkspaceBackup({directory: destination}), result);
  const manifestText = await readFile(path.join(destination, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
  assert.equal(manifest.databaseSchemaVersion, 26);
  assert.deepEqual(manifest.entries.map(entry => entry.path).sort(),
    ['payload/workbench.sqlite', `payload/${f.sourceRelativePath}`].sort());
  assert.equal(manifestText.includes('local-drafts'), false);
  assert.equal(manifestText.includes('LOCAL_DRAFT_EXCLUDED_FROM_BACKUP'), false);
  await assert.rejects(stat(path.join(destination, 'payload/local-drafts-v1.json')), {code: 'ENOENT'});
  assert.deepEqual(await readFile(path.join(destination, 'payload/workbench.sqlite')), before.database);
  assert.deepEqual(await readFile(path.join(f.root, 'workbench.sqlite')), before.database);
  assert.deepEqual(await readFile(sidecar), before.bytes);
  const after = await stat(sidecar);
  assert.equal(after.mode & 0o777, 0o600); assert.equal(after.mode, before.stat.mode);
  assert.equal(after.ino, before.stat.ino); assert.equal(after.mtimeMs, before.stat.mtimeMs);
});

for (const phase of ['afterPreparePersist', 'afterBusinessCommit', 'lostExecuteAcknowledgement']) {
  test(`durable clip Save at ${phase} preserves draft and reuses the original request key after crash`, {timeout: 30000}, async t => {
    const f = await fixture(t), baseline = f.snapshot(), initial = await f.draft();
    const raw = rawClip(f, {name: 'Explicitly saved 🎬', startFrame: '12', gain: '0.75'});
    const savedDraft = await f.data('/api/local-drafts/clip', {method: 'PUT', input: write(f, initial, raw)});
    assert.deepEqual(f.snapshot(), baseline, 'the raw draft is durable before business preparation begins');
    await f.noEffects();
    const input = {projectId: f.project.id, clipId: f.key.clipId, expectedRevision: f.timeline.revision,
      requestId: randomUUID(), patch: {name: raw.name, startFrame: Number(raw.startFrame), gain: Number(raw.gain)}};
    let prepared, originalResult;
    const oldTaskInstance = (await f.data('/api/tasks?projectId=' + f.project.id)).instanceId;
    if (phase === 'afterPreparePersist') {
      await f.backend.ask('arm', {phase});
      await assert.rejects(f.prepare(input));
    } else {
      prepared = await f.prepare(input);
      if (phase === 'afterBusinessCommit') {
        await f.backend.ask('arm', {phase});
        await assert.rejects(f.request(taskRoute(prepared.task.id, 'execute'), {method: 'POST', input: taskAction(f, prepared)}));
      } else {
        const route = taskRoute(prepared.task.id, 'execute'); f.lose(route);
        await assert.rejects(f.viaProxy(route, {method: 'POST', input: taskAction(f, prepared)}));
        originalResult = f.observed.at(-1).body.data.result;
      }
    }
    if (phase !== 'lostExecuteAcknowledgement') assert.deepEqual(await deadline(f.backend.exited, 'armed SIGKILL'), {code: null, signal: 'SIGKILL'});
    const interrupted = f.snapshot(), [retained] = interrupted.edit_tasks;
    assert.equal(interrupted.edit_tasks.length, 1); assert.equal(retained.requestId, input.requestId);
    assert.deepEqual(JSON.parse(retained.input), input);
    assert.equal(interrupted.timeline_requests.length, baseline.timeline_requests.length + (phase === 'afterPreparePersist' ? 0 : 1));
    await f.restart();
    const restoredDraft = await f.draft();
    assert.deepEqual(restoredDraft.draft, savedDraft.draft);
    assert.equal(restoredDraft.targetStatus, phase === 'afterPreparePersist' ? 'matching' : 'changed');
    const current = await f.data(taskRoute(retained.id) + '?projectId=' + f.project.id);
    assert.equal(current.task.requestId, input.requestId); assert.deepEqual(current.task.input, input);
    assert.notEqual(current.instanceId, oldTaskInstance);
    assert.equal(current.task.status, phase === 'afterPreparePersist' ? 'prepared' : 'applied');
    const observed = f.snapshot();
    await f.draft(); await f.list(); await f.data('/api/tasks?projectId=' + f.project.id);
    assert.deepEqual(f.snapshot(), observed);
    await f.noEffects();
    const stale = await f.request(taskRoute(retained.id, 'execute'), {method: 'POST', input: {...taskAction(f, current), instanceId: oldTaskInstance}});
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'EDIT_TASK_STALE_INSTANCE');
    // Only this explicit durable task action can turn a persisted raw draft into
    // a saved timeline edit. Rediscovery above used GETs and never dispatched.
    const applied = await f.data(taskRoute(retained.id, 'execute'), {method: 'POST', input: taskAction(f, current)});
    assert.equal(applied.task.status, 'applied'); assert.equal(applied.task.requestId, input.requestId);
    assert.equal(applied.result.revision, f.timeline.revision + 1);
    if (originalResult) assert.deepEqual(applied.result, originalResult);
    const committed = f.snapshot();
    assert.equal(committed.timeline_requests.length, baseline.timeline_requests.length + 1);
    assert.equal(committed.timeline_history.length, baseline.timeline_history.length + 1);
    const timeline = committed.timelines.map(rowData).find(value => value.id === f.timeline.id);
    assert.equal(timeline.revision, f.timeline.revision + 1);
    assert.deepEqual(timeline.clips[0], {...f.timeline.clips[0], ...input.patch});
    assert.equal(committed.jobs.length, baseline.jobs.length); assert.equal(committed.versions.length, baseline.versions.length);
    const receipt = committed.timeline_requests.find(row => row.requestId === input.requestId);
    assert.ok(receipt);
    const replayPrepared = await f.prepare(input);
    assert.equal(replayPrepared.task.id, applied.task.id);
    assert.deepEqual((await f.data(taskRoute(applied.task.id, 'execute'), {method: 'POST', input: taskAction(f, replayPrepared)})).result, applied.result);
    assert.deepEqual(f.snapshot(), committed, 'same-key prepare/execute cannot create a new timeline revision or task');
    const retainedDraft = await f.draft(); assert.deepEqual(retainedDraft.draft, savedDraft.draft);
    const discarded = await f.data('/api/local-drafts/clip', {method: 'DELETE', input: discard(retainedDraft)});
    assert.equal(discarded.draft, null); assert.deepEqual(f.snapshot(), committed);
    assert.equal(await readFile(path.join(f.root, 'synthetic-forbidden-effects.jsonl'), 'utf8'), '');
  });
}
