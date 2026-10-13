import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile, readFile, readdir, unlink, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {installWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {onMediaProcess, spawnMedia, terminateMediaProcesses, waitForMediaProcesses, hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.mjs';
import {runStreaming} from '../packages/business/src/media-runtime.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {EXPORT_SAMPLE_PEAK_LIMITS, isExportSamplePeakResponse} from '@mioon/contracts/export-sample-peak';
import {openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createExportSamplePeakServices} from '../packages/business/src/export-sample-peak.ts';
import {readTimelineDeliveryDownload} from '../packages/business/src/timeline-delivery-read.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.mjs';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.mjs';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.mjs';
import {workspaceRestoreError, RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {let resolve; return {promise: new Promise(r => {resolve = r;}), resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function measurement(seconds = 1, left = 0.5, right = 0.25) {
  const peak = value => ({peakLinear: value, peakDbfs: value === 0 ? null : 20 * Math.log10(value), silent: value === 0});
  return {sampleRate: 48000, channels: 2, sampleFrames: Math.round(seconds * 48000), decodedDurationSeconds: seconds,
    ...peak(Math.max(left, right)), overFullScale: Math.max(left, right) > 1,
    channelPeaks: [{channel: 0, label: 'left', ...peak(left)}, {channel: 1, label: 'right', ...peak(right)}]};
}
async function files(root) {
  const result = [];
  for (const name of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!name.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(name.name) || name.name === 'server.lock') continue;
    const full = path.join(name.parentPath, name.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, {named = false, range = false, durationFrames = range ? 90 : 30, exportRange = {startFrame: 30, endFrame: 60}, runtime: overrides = {}} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-sample-peak-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Synthetic owned output'}), foreign = await services.call('project.create', {name: 'Private other project'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Original source', mimeType: 'image/png', sha256: 'a'.repeat(64),
    relativePath: `media/${sourceId}.png`, width: 720, height: 1280, duration: 0, hasAudio: false, sizeBytes: 20, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames});
  const intent = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
    ...(named ? {deliveryName: '已导出文件'} : {}), ...(range ? {exportRange} : {})};
  const queued = await services.call('timeline.render', intent), assetId = randomUUID();
  const relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`, bytes = Buffer.alloc(96 * 1024, 7);
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  const asset = {id: assetId, projectId: project.id, name: 'Historical output', mimeType: 'video/mp4', provenance: 'export', relativePath,
    url: `/media/${assetId}`, sha256: sha(bytes), sizeBytes: bytes.length, createdAt: new Date().toISOString()};
  store.put('assets', asset);
  const record = {...store.get('exports', queued.id), status: 'succeeded', assetId, url: asset.url, updatedAt: new Date().toISOString()}; store.put('exports', record);
  // The operation is historical: no current timeline/source is required.
  store.db.prepare('DELETE FROM timelines WHERE id=?').run(timeline.id); store.db.prepare('DELETE FROM assets WHERE id=?').run(sourceId);
  const runtime = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    isTimelineRenderRecord, readOwnedAsset: (projectId, id) => readOwnedTimelineAsset(store.db, projectId, id),
    validateSource: validateManagedSource, hash: verifiedManagedHash, decode: async (_file, duration, options) => {options.beforeEffect(); return measurement(duration);},
    terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides};
  const peak = createExportSamplePeakServices(store, {runtime});
  const extras = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await peak.drain().catch(() => {}); await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = {projectId: project.id, exportId: record.id};
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {root, store, services, peak, runtime, extras, project, foreign, queued, record, asset, bytes, input, intent,
    call: (arg = input, options) => peak.handlers['timeline.export.samplePeak'](arg, options), rows,
    unchanged: async before => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.writes); assert.deepEqual(await files(root), before.files);},
    checkpoint: async () => ({rows: rows(), writes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await files(root)})};
}
function corruptible(f) {f.store.db.exec('DROP TRIGGER immutable_timeline_render_snapshot; DROP TRIGGER immutable_timeline_responses;');}
function replace(f, table, value) {f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);}

test('named/unnamed and ranged historical outputs use two actual hashes, preserve optional identity and never write', async t => {
  for (const options of [{}, {named: true, range: true}]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options), before = await f.checkpoint(), result = await f.call();
    assert.ok(isExportSamplePeakResponse(result, f.input)); assert.equal(result.status, 'ready');
    assert.equal(result.checks.bytesHashed, 2 * f.bytes.length); assert.equal(result.artifact.sha256, sha(f.bytes));
    assert.equal(result.measurement.decodedDurationSeconds, 1); assert.equal(Object.hasOwn(result.artifact, 'deliveryName'), Boolean(options.named));
    assert.equal(Object.hasOwn(result.artifact, 'exportRange'), Boolean(options.range));
    assert.equal(result.artifact.timelineRevision, f.intent.expectedRevision);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.artifact) && Object.isFrozen(result.measurement.channelPeaks[0]));
    assert.ok(!JSON.stringify(result).includes(f.root) && !JSON.stringify(result).includes(f.asset.relativePath));
    await f.unchanged(before);
    const url = new URL(`/media/${f.asset.id}?download=1&exportId=${f.record.id}`, 'http://localhost');
    assert.equal(readTimelineDeliveryDownload(f.store.db, url, f.runtime) !== null, Boolean(options.named), 'old named route still requires name');
  });
});

test('strict input, missing/foreign/corrupt ownership and output substitution are opaque before file access', async t => {
  let reads = 0, decodes = 0; const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}, decode: async () => {decodes++; return measurement();}}});
  for (const extra of [{path: '/secret'}, {assetId: f.asset.id}, {verified: true}, {timeoutMs: 1}]) await assert.rejects(f.call({...f.input, ...extra}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(f.call({...f.input, projectId: f.foreign.id}), {code: 'EXPORT_SAMPLE_PEAK_UNAVAILABLE'});
  await assert.rejects(f.call({...f.input, exportId: randomUUID()}), {code: 'EXPORT_SAMPLE_PEAK_UNAVAILABLE'});
  corruptible(f);
  const receipt = f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.record.requestId).response;
  const cases = [
    () => replace(f, 'exports', {...f.record, projectId: f.foreign.id}),
    () => replace(f, 'exports', {...f.record, purpose: 'preview'}),
    () => replace(f, 'exports', {...f.record, mode: 'storyboard'}),
    () => replace(f, 'exports', {...f.record, status: 'running', assetId: null, url: null}),
    () => replace(f, 'exports', {...f.record, url: `/media/${randomUUID()}`}),
    () => f.store.db.prepare('UPDATE exports SET data=? WHERE id=?').run('x'.repeat(4 * 1024 * 1024 + 1), f.record.id),
    () => f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(f.record), f.record.requestId),
    () => replace(f, 'assets', {...f.asset, projectId: f.foreign.id}),
    () => replace(f, 'assets', {...f.asset, provenance: 'user-import'}),
    () => replace(f, 'assets', {...f.asset, relativePath: `media/export-${randomUUID()}-${randomUUID()}.mp4`}),
    () => replace(f, 'assets', {...f.asset, sha256: 'bad'}),
    () => replace(f, 'assets', {...f.asset, sizeBytes: 0}),
    () => f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project, id: f.foreign.id}), f.project.id),
  ];
  for (const change of cases) {
    change(); const before = await f.checkpoint();
    await assert.rejects(f.call(), error => error.code === 'EXPORT_SAMPLE_PEAK_UNAVAILABLE' && !error.message.includes(f.foreign.id)); await f.unchanged(before);
    replace(f, 'exports', f.record); replace(f, 'assets', f.asset); replace(f, 'projects', f.project);
    f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(receipt, f.record.requestId);
  }
  assert.equal(reads, 0); assert.equal(decodes, 0);
});

test('real lock:false readers cannot admit analysis; wrappers on the exact owner DB share one permit', async t => {
  const entered = deferred(), gate = deferred(); const f = await fixture(t, {runtime: {decode: async (_file, duration, options) => {entered.resolve(); await gate.promise; options.beforeEffect(); return measurement(duration);}}});
  const auxiliary = openStore(f.root, {lock: false}); t.after(() => auxiliary.close());
  const unauthorized = createExportSamplePeakServices(auxiliary, {runtime: {...f.runtime, ownsLock: () => ownsStoreLock(auxiliary)}}); f.extras.push(unauthorized);
  await assert.rejects(unauthorized.handlers['timeline.export.samplePeak'](f.input), {code: 'EXPORT_SAMPLE_PEAK_OWNER_REQUIRED'});
  const wrapper = createExportSamplePeakServices({...f.store}, {runtime: f.runtime}); f.extras.push(wrapper);
  const pending = f.call(); await entered.promise;
  const busy = await wrapper.handlers['timeline.export.samplePeak'](f.input); assert.equal(busy.reason.code, 'BUSY'); assert.equal(busy.checks.bytesHashed, 0);
  gate.resolve(); assert.equal((await pending).status, 'ready');
});

test('cancelled nonsettled hash retains shared admission, never decodes/publishes, and drain is unsafe', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0, hashing = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {hashing++; entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: async () => {decodes++; return measurement();}}});
  const controller = new AbortController(), before = await f.checkpoint(), pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  controller.abort(); assert.equal((await pending).reason.code, 'CANCELLED');
  assert.equal((await f.call()).reason.code, 'BUSY'); assert.equal(hashing, 1); assert.equal(decodes, 0);
  t.mock.timers.enable({apis: ['setTimeout']});
  const draining = f.peak.drain(); const rejected = assert.rejects(draining, {code: 'EXPORT_SAMPLE_PEAK_STOP_TIMEOUT'}); t.mock.timers.tick(5001); await rejected;
  gate.resolve(); await tick(); await tick(); await f.peak.drain(); assert.equal(decodes, 0); await f.unchanged(before);
  t.mock.timers.reset();
});

test('end-to-end timeout returns no partial result and keeps outstanding hash admitted', async t => {
  const gate = deferred(), entered = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: async () => {decodes++; return measurement();}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.call(); await entered.promise; t.mock.timers.tick(EXPORT_SAMPLE_PEAK_LIMITS.timeoutMs + 1);
  const result = await pending; assert.equal(result.reason.code, 'TIMEOUT'); assert.equal(result.artifact, null); assert.equal(result.measurement, null);
  assert.equal((await f.call()).reason.code, 'BUSY'); gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('same-owned metadata/bytes drift discards measurement; foreign owner revocation outranks decode errors', async t => {
  for (const kind of ['metadata', 'bytes', 'foreign', 'lock']) await t.test(kind, async t => {
    let f; f = await fixture(t, {runtime: {decode: async () => {
      if (kind === 'metadata') replace(f, 'assets', {...f.asset, name: 'Changed'});
      if (kind === 'bytes') await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 9));
      if (kind === 'foreign') f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.foreign.id, JSON.stringify({...f.asset, projectId: f.foreign.id}), f.asset.id);
      if (kind === 'lock') await unlink(path.join(f.root, 'server.lock'));
      throw Object.assign(Error('SECRET stderr /private/path'), {code: 'MEDIA_PROCESS_FAILED'});
    }}});
    if (kind === 'foreign') await assert.rejects(f.call(), {code: 'EXPORT_SAMPLE_PEAK_UNAVAILABLE'});
    else if (kind === 'lock') await assert.rejects(f.call(), {code: 'EXPORT_SAMPLE_PEAK_OWNER_REQUIRED'});
    else {const result = await f.call(); assert.equal(result.status, 'stale'); assert.equal(result.reason.code, 'ARTIFACT_CHANGED'); assert.equal(result.measurement, null); assert.ok(!JSON.stringify(result).includes('SECRET'));}
  });
});

test('untrusted decoder success is independently rejected before the second hash', async t => {
  let hashes = 0;
  const f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);}, decode: async () => ({...measurement(), peakDbfs: 0})}});
  const result = await f.call(); assert.equal(result.reason.code, 'INVALID_PCM'); assert.equal(hashes, 1); assert.equal(result.measurement, null);
});

test('bad bytes, symlinks and recorded input cap never become a decoded success', async t => {
  const f = await fixture(t, {runtime: {decode: async () => {assert.fail('invalid input must never decode');}}});
  const file = path.join(f.root, f.asset.relativePath); await writeFile(file, Buffer.alloc(f.bytes.length, 8));
  assert.equal((await f.call()).reason.code, 'ARTIFACT_CHANGED');
  await unlink(file); await symlink(path.join(f.root, 'foreign-secret.mp4'), file);
  assert.equal((await f.call()).reason.code, 'ARTIFACT_CHANGED');
  replace(f, 'assets', {...f.asset, sizeBytes: EXPORT_SAMPLE_PEAK_LIMITS.inputBytes + 1});
  assert.equal((await f.call()).reason.code, 'INPUT_TOO_LARGE');
});

test('unconfirmed exact-child cleanup retains admission until actual close and permanently fails drain', async t => {
  const closing = deferred(), enteredClose = deferred(), controller = new AbortController(); let decodes = 0;
  const f = await fixture(t, {runtime: {decode: async () => {decodes++; throw Object.assign(Error('raw private diagnostic'), {code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true});},
    terminate: async () => [{status: 'unconfirmed'}], waitForClose: async () => {enteredClose.resolve(); await closing.promise; return [{status: 'exited'}];}}});
  const pending = f.call(f.input, {signal: controller.signal}); await enteredClose.promise; controller.abort();
  await assert.rejects(pending, error => error.code === 'MEDIA_TERMINATION_UNCONFIRMED' && !error.message.includes('private'));
  await assert.rejects(f.call(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); assert.equal(decodes, 1);
  t.mock.timers.enable({apis: ['setTimeout']}); const draining = f.peak.drain(), rejected = assert.rejects(draining, {code: 'EXPORT_SAMPLE_PEAK_STOP_TIMEOUT'}); t.mock.timers.tick(5001); await rejected;
  closing.resolve(); await tick(); await tick(); await assert.rejects(f.peak.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); t.mock.timers.reset();
});

test('restored denial catalogue and service boundary reject before touching payload', async t => {
  const f = await fixture(t); let touched = 0, effects = 0;
  const denied = createExportSamplePeakServices(f.store, {runtime: {...f.runtime, assertOrdinaryWorkspace: () => {throw workspaceRestoreError();},
    ownsLock: () => {effects++; return true;}, decode: async () => {effects++; return measurement();}}});
  assert.ok(RESTORE_DENIED_OPERATIONS.includes('timeline.export.samplePeak'));
  await assert.rejects(denied.handlers['timeline.export.samplePeak']({get projectId() {touched++; return f.project.id;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(touched, 0); assert.equal(effects, 0);
});


test('actual restored-v1 shared service denies valid and hostile payloads before getters, bytes, or local processes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-peak-'));
  let store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Restored output owner'});
  await services.drain(); store.close();
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()};
  try {installWorkspaceRestoreSchema(db, metadata); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root);
  services = createServices(store, new Proxy(new Map(), {get() {throw Error('Must not inspect a provider');}}));
  let media = 0, getters = 0; const off = onMediaProcess(() => {media++;});
  t.after(async () => {off(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const beforeFiles = await files(root), beforeChanges = store.db.prepare('SELECT total_changes() AS n').get().n;
  const hostile = {get projectId() {getters++; throw Error('payload access');}, get exportId() {getters++; throw Error('payload access');}};
  for (const value of [hostile, {projectId: project.id, exportId: randomUUID()}, null]) {
    await assert.rejects(services.call('timeline.export.samplePeak', value, {expectedWorkspaceOrigin: metadata.workspaceOrigin}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
    await assert.rejects(services.handlers['timeline.export.samplePeak'](value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(getters, 0); assert.equal(media, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges); assert.deepEqual(await files(root), beforeFiles);
});


test('actual runner registry retains exact advisory handle until late close and never kills unrelated render handle', async t => {
  const spawned = deferred(), waiting = deferred(), controller = new AbortController();
  let attemptSignal, cleanupSignal, closeSignal;
  const f = await fixture(t, {runtime: {
    decode: async (_file, _duration, options) => {
      attemptSignal = options.signal;
      return runStreaming('ffmpeg', [], {signal: options.signal, beforeEffect: options.beforeEffect,
        onStdout: () => {throw Error('synthetic invalid PCM callback');}});
    },
    terminate: signal => {cleanupSignal = signal; return terminateMediaProcesses({signal});},
    waitForClose: signal => {closeSignal = signal; waiting.resolve(); return waitForMediaProcesses({signal});},
  }});
  const originalSpawn = childProcess.spawn, children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.pid = 900000 + children.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.refs = 0; child.unrefs = 0;
    child.kill = signal => {child.kills.push(signal); return true;};
    child.ref = () => {child.refs++; return child;}; child.unref = () => {child.unrefs++; return child;};
    children.push(child);
    queueMicrotask(() => {child.emit('spawn'); if (children.length === 2 && child === children[1]) spawned.resolve(child);});
    return child;
  };
  syncBuiltinESMExports();
  t.mock.timers.enable({apis: ['setTimeout']});
  const restore = () => {
    for (const child of children) child.emit('close', 0);
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); t.mock.timers.reset();
  };
  t.after(restore);
  const unrelatedSignal = new AbortController().signal;
  const unrelated = spawnMedia('ffmpeg', [], {stdio: ['ignore', 'pipe', 'pipe']}, {kind: 'ffmpeg', signal: unrelatedSignal});
  try {
    const pending = f.call(f.input, {signal: controller.signal});
    const advisory = await spawned.promise;
    advisory.stdout.write(Buffer.from([1]));
    assert.deepEqual(advisory.kills, ['SIGTERM']);
    assert.deepEqual(unrelated.kills, []);
    t.mock.timers.tick(3001);
    await waiting.promise;
    assert.deepEqual(advisory.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true);
    assert.equal(cleanupSignal, attemptSignal); assert.equal(closeSignal, attemptSignal);
    assert.notEqual(attemptSignal, controller.signal); assert.notEqual(attemptSignal, unrelatedSignal);
    assert.equal(advisory.unrefs, 1); assert.equal(advisory.refs, 1);
    controller.abort();
    await assert.rejects(pending, {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(f.call(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); assert.equal(children.length, 2);
    const draining = f.peak.drain(), rejected = assert.rejects(draining, {code: 'EXPORT_SAMPLE_PEAK_STOP_TIMEOUT'});
    t.mock.timers.tick(5001); await rejected;
    assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true, 'runner settled but exact child is still admitted');
    assert.deepEqual(unrelated.kills, []);
    // Neither kill nor exit synthesized this close. Only this observed event
    // releases the exact registry waiter. This is not an OS-reaping claim.
    advisory.emit('exit', 1); advisory.emit('close', 1);
    await tick(); await tick();
    assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), false);
    await assert.rejects(f.peak.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(f.call(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    advisory.emit('close', 1); await tick();
    assert.equal(children.length, 2, 'late close cannot admit or release a replacement attempt');
    assert.deepEqual(unrelated.kills, []);
  } finally {restore();}
});


test('full and ranged 600-second outputs accept exactly 4800-frame discrepancy and reject 4801', async t => {
  for (const range of [false, true]) await t.test(range ? 'ranged' : 'full', async t => {
    const f = await fixture(t, {range, durationFrames: 18000, exportRange: {startFrame: 0, endFrame: 18000}});
    f.runtime.decode = async () => measurement((28800000 - 4800) / 48000);
    assert.equal((await f.call()).status, 'ready');
    f.runtime.decode = async () => measurement((28800000 - 4801) / 48000);
    const beyond = await f.call(); assert.equal(beyond.reason.code, 'INVALID_PCM'); assert.equal(beyond.measurement, null);
  });
});

test('ready advisory preserves silence, exact full scale, and over-full-scale values without normalization', async t => {
  const f = await fixture(t), before = await f.checkpoint();
  for (const peak of [0, 1, 1.25]) {
    f.runtime.decode = async () => measurement(1, peak, peak / 2);
    const result = await f.call(); assert.equal(result.status, 'ready');
    assert.equal(result.measurement.peakLinear, peak); assert.equal(result.measurement.silent, peak === 0);
    assert.equal(result.measurement.peakDbfs, peak === 0 ? null : 20 * Math.log10(peak));
    assert.equal(result.reason?.code ?? null, peak > 1 ? 'OVER_FULL_SCALE' : null);
    assert.equal(result.checks.bytesHashed, f.bytes.length * 2);
  }
  await f.unchanged(before);
});
