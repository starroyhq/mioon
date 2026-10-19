import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile, readFile, readdir, unlink, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {isTimelineRenderRecord} from '@mioon/contracts';
import {EXPORT_LOUDNESS_PROFILE, EXPORT_LOUDNESS_LIMITS, isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {installCurrentWorkspaceRestoreSchema, openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createExportLoudnessServices} from '../packages/business/src/export-loudness.ts';
import {createExportLoudnessAccumulator} from '../packages/business/src/export-loudness-meter.ts';
import {createExportSamplePeakServices} from '../packages/business/src/export-sample-peak.ts';
import {createExportSamplePeakAccumulator} from '../packages/business/src/export-sample-peak-decoder.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.ts';
import {workspaceRestoreError, RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {floatSnapshotSha256} from '../packages/business/src/timeline-float-outcome.ts';
import {onMediaProcess, spawnMedia, terminateMediaProcesses, waitForMediaProcesses, hasUnconfirmedMediaProcesses} from '../packages/business/src/media-processes.ts';
import {runStreaming} from '../packages/business/src/media-runtime.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {let resolve; return {promise: new Promise(r => {resolve = r;}), resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function pcm(seconds = 1, amplitude = 0.1) {
  const bytes = Buffer.alloc(Math.round(seconds * 48000) * 8);
  for (let frame = 0; frame < bytes.length / 8; frame++) {
    const sample = amplitude * Math.sin(2 * Math.PI * 1000 * frame / 48000);
    bytes.writeFloatLE(sample, frame * 8); bytes.writeFloatLE(-sample, frame * 8 + 4);
  }
  return bytes;
}
function measurement(seconds = 1, amplitude = 0.1) {
  const accumulator = createExportLoudnessAccumulator(seconds); accumulator.write(pcm(seconds, amplitude)); return accumulator.finish();
}
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(entry.name) || entry.name === 'server.lock') continue;
    const full = path.join(entry.parentPath, entry.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, {named = false, range = false, retainTimeline = false, runtime: overrides = {}} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-loudness-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Owned loudness fixture'}), foreign = await services.call('project.create', {name: 'Other project'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sourceId = randomUUID();
  store.put('assets', {id: sourceId, projectId: project.id, name: 'Original source', mimeType: 'image/png', sha256: 'a'.repeat(64),
    relativePath: `media/${sourceId}.png`, width: 720, height: 1280, duration: 0, hasAudio: false, sizeBytes: 20, createdAt: new Date().toISOString()});
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks[0].id, assetId: sourceId, startFrame: 0, durationFrames: range ? 90 : 30});
  const intent = {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
    ...(named ? {deliveryName: '已导出响度文件'} : {}), ...(range ? {exportRange: {startFrame: 30, endFrame: 60}} : {})};
  const queued = await services.call('timeline.render', intent), assetId = randomUUID();
  const relativePath = `media/export-${queued.id}-${randomUUID()}.mp4`, bytes = Buffer.alloc(96 * 1024, 7);
  await writeFile(path.join(root, relativePath), bytes, {mode: 0o600});
  const asset = {id: assetId, projectId: project.id, name: 'Historical output', mimeType: 'video/mp4', provenance: 'export', relativePath,
    url: `/media/${assetId}`, sha256: sha(bytes), sizeBytes: bytes.length, createdAt: new Date().toISOString()};
  store.put('assets', asset);
  const record = {...store.get('exports', queued.id), status: 'succeeded', assetId, url: asset.url, updatedAt: new Date().toISOString()}; store.put('exports', record);
  if (!retainTimeline) {
    store.db.prepare('DELETE FROM timelines WHERE id=?').run(timeline.id); store.db.prepare('DELETE FROM assets WHERE id=?').run(sourceId);
  }
  const runtime = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    isTimelineRenderRecord, readOwnedAsset: (projectId, id) => readOwnedTimelineAsset(store.db, projectId, id),
    validateSource: validateManagedSource, hash: verifiedManagedHash, decode: async (_file, duration, options) => {options.beforeEffect(); return measurement(duration);},
    terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides};
  const loudness = createExportLoudnessServices(store, {runtime}), extras = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await loudness.drain().catch(() => {}); await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = {projectId: project.id, exportId: record.id, expectedArtifactSha256: asset.sha256, measurementProfile: EXPORT_LOUDNESS_PROFILE};
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {root, store, services, loudness, runtime, extras, project, foreign, timeline, record, asset, bytes, input, intent,
    call: (arg = input, options) => loudness.handlers['timeline.export.loudness'](arg, options),
    unchanged: async before => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.writes); assert.deepEqual(await files(root), before.files);},
    checkpoint: async () => ({rows: rows(), writes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await files(root)})};
}
function replace(f, table, value) {f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);}
function samplePeak(f, runtime = {}) {
  const peak = createExportSamplePeakServices({...f.store}, {runtime: {...f.runtime, decode: async (_file, duration) => {
    const accumulator = createExportSamplePeakAccumulator(duration); accumulator.write(pcm(duration)); return accumulator.finish();
  }, ...runtime}});
  f.extras.push(peak); return (context) => peak.handlers['timeline.export.samplePeak']({projectId: f.input.projectId, exportId: f.input.exportId}, context);
}

test('loudness binds two actual hashes and frozen full/ranged delivery without database or file writes', async t => {
  for (const options of [{}, {named: true, range: true}]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options), before = await f.checkpoint(), result = await f.call();
    assert.ok(isExportLoudnessResponse(result, f.input)); assert.equal(result.status, 'ready');
    assert.equal(result.checks.bytesHashed, 2 * f.bytes.length); assert.equal(result.artifact.sha256, sha(f.bytes));
    assert.equal(result.artifact.snapshotSha256, floatSnapshotSha256(f.record.snapshot));
    assert.equal(result.artifact.timelineRevision, f.intent.expectedRevision); assert.equal(result.measurement.decodedDurationSeconds, 1);
    assert.equal(Object.hasOwn(result.artifact, 'deliveryName'), Boolean(options.named)); assert.equal(Object.hasOwn(result.artifact, 'exportRange'), Boolean(options.range));
    assert.equal(result.suggestion, null); assert.ok(Object.isFrozen(result.measurement));
    assert.ok(!JSON.stringify(result).includes(f.root) && !JSON.stringify(result).includes(f.asset.relativePath));
    await f.unchanged(before);
  });
});

test('current timeline edits do not invalidate a historical measured export or authorize gain application', async t => {
  const f = await fixture(t, {retainTimeline: true});
  const updated = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: f.timeline.revision,
    requestId: randomUUID(), clipId: f.timeline.clips[0].id, patch: {durationFrames: 60}});
  assert.ok(updated.revision > f.intent.expectedRevision);
  const before = await f.checkpoint(), result = await f.call({...f.input, target: {integratedLufs: -5, truePeakCeilingDbtp: -20}});
  assert.equal(result.status, 'ready'); assert.equal(result.artifact.timelineRevision, f.intent.expectedRevision); assert.equal(result.measurement.decodedDurationSeconds, 1);
  assert.equal(result.suggestion.applyAllowed, false); assert.equal(result.suggestion.currentTimelineValidated, false);
  assert.equal(result.suggestion.requiredGainDb, -5 - result.measurement.integratedLufs); assert.equal(result.suggestion.conflictsWithCeiling, true);
  await f.unchanged(before);
});

test('strict input, hash pin and opaque ownership checks precede every managed file read', async t => {
  let reads = 0, decodes = 0;
  const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}, decode: async () => {decodes++; return measurement();}}});
  for (const extra of [{path: '/secret'}, {assetId: f.asset.id}, {verified: true}, {timeoutMs: 1}, {target: undefined}, {target: {integratedLufs: -61, truePeakCeilingDbtp: -1}}])
    await assert.rejects(f.call({...f.input, ...extra}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(f.call({...f.input, projectId: f.foreign.id}), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
  await assert.rejects(f.call({...f.input, exportId: randomUUID()}), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
  const stale = await f.call({...f.input, expectedArtifactSha256: 'f'.repeat(64)});
  assert.equal(stale.status, 'stale'); assert.equal(stale.checks.bytesHashed, 0); assert.equal(stale.measurement, null);
  assert.equal(reads, 0); assert.equal(decodes, 0);
  replace(f, 'assets', {...f.asset, provenance: 'user-import'});
  await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'}); assert.equal(reads, 0);
});

test('same native database serializes loudness and samplePeak in both directions without a queue', async t => {
  for (const first of ['loudness', 'samplePeak']) await t.test(first, async t => {
    const entered = deferred(), gate = deferred(), f = await fixture(t);
    const original = f.runtime.decode;
    const peak = samplePeak(f, first === 'samplePeak' ? {decode: async (_file, duration, options) => {
      entered.resolve(); await gate.promise; options.beforeEffect(); const reducer = createExportSamplePeakAccumulator(duration); reducer.write(pcm(duration)); return reducer.finish();
    }} : {});
    if (first === 'loudness') f.runtime.decode = async (...args) => {entered.resolve(); await gate.promise; return original(...args);};
    const wrapper = createExportLoudnessServices({...f.store}, {runtime: f.runtime}); f.extras.push(wrapper);
    const pending = first === 'loudness' ? f.call() : peak(); await entered.promise;
    const busy = first === 'loudness' ? await peak() : await wrapper.handlers['timeline.export.loudness'](f.input);
    assert.equal(busy.reason.code, 'BUSY'); assert.equal(busy.checks.bytesHashed, 0);
    gate.resolve(); assert.equal((await pending).status, 'ready');
  });
});

test('read-only database wrappers cannot claim the writer observation permit', async t => {
  const f = await fixture(t), auxiliary = openStore(f.root, {lock: false}); t.after(() => auxiliary.close());
  const denied = createExportLoudnessServices(auxiliary, {runtime: {...f.runtime, ownsLock: () => ownsStoreLock(auxiliary)}}); f.extras.push(denied);
  await assert.rejects(denied.handlers['timeline.export.loudness'](f.input), {code: 'EXPORT_LOUDNESS_OWNER_REQUIRED'});
});

test('cancellation retains nonsettled hash and cross-operation admission until exact underlying work settles', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0, hashes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {hashes++; entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: async () => {decodes++; return measurement();}}});
  const peak = samplePeak(f), controller = new AbortController(), pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  controller.abort(); const cancelled = await pending; assert.equal(cancelled.reason.code, 'CANCELLED'); assert.equal(cancelled.measurement, null);
  assert.equal((await peak()).reason.code, 'BUSY'); assert.equal((await f.call()).reason.code, 'BUSY');
  assert.equal(hashes, 1); assert.equal(decodes, 0); gate.resolve(); await tick(); await tick();
  assert.equal((await peak()).status, 'ready'); assert.equal(decodes, 0);
});

test('one operation deadline covers an outstanding hash and never publishes its late result', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: async () => {decodes++; return measurement();}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.call(); await entered.promise; t.mock.timers.tick(EXPORT_LOUDNESS_LIMITS.timeoutMs + 1);
  assert.equal((await pending).reason.code, 'TIMEOUT'); assert.equal((await f.call()).reason.code, 'BUSY');
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('metadata, same-size byte and path replacement discard measurement; owner revocation outranks decoder failure', async t => {
  for (const kind of ['metadata', 'bytes', 'symlink', 'foreign', 'lock']) await t.test(kind, async t => {
    let f; f = await fixture(t, {runtime: {decode: async () => {
      if (kind === 'metadata') replace(f, 'assets', {...f.asset, name: 'Changed'});
      if (kind === 'bytes') await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 9));
      if (kind === 'symlink') {await unlink(path.join(f.root, f.asset.relativePath)); await symlink(path.join(f.root, 'secret.mp4'), path.join(f.root, f.asset.relativePath));}
      if (kind === 'foreign') f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.foreign.id, JSON.stringify({...f.asset, projectId: f.foreign.id}), f.asset.id);
      if (kind === 'lock') await unlink(path.join(f.root, 'server.lock'));
      throw Object.assign(Error('PRIVATE decoder diagnostic'), {code: 'MEDIA_PROCESS_FAILED'});
    }}});
    if (kind === 'foreign') await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_UNAVAILABLE'});
    else if (kind === 'lock') await assert.rejects(f.call(), {code: 'EXPORT_LOUDNESS_OWNER_REQUIRED'});
    else {const result = await f.call(); assert.equal(result.reason.code, 'ARTIFACT_CHANGED'); assert.equal(result.measurement, null); assert.ok(!JSON.stringify(result).includes('PRIVATE'));}
  });
});

test('invalid reducer relationships cannot pass as success or trigger the second hash', async t => {
  let hashes = 0;
  const f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);}, decode: async () => ({...measurement(), truePeakDbtp: 0})}});
  const result = await f.call(); assert.equal(result.reason.code, 'INVALID_PCM'); assert.equal(hashes, 1); assert.equal(result.measurement, null);
});

test('recorded input size and cumulative hash budgets fail before decode without partial measurements', async t => {
  let reads = 0, decodes = 0;
  const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);},
    decode: async () => {decodes++; return measurement();}}});
  replace(f, 'assets', {...f.asset, sizeBytes: EXPORT_LOUDNESS_LIMITS.inputBytes + 1});
  const tooLarge = await f.call(); assert.equal(tooLarge.reason.code, 'INPUT_TOO_LARGE'); assert.equal(reads, 0); assert.equal(decodes, 0);
  replace(f, 'assets', f.asset);
  f.runtime.hash = async (_root, asset, options) => {options.onBytes(asset.sizeBytes * 2 + 1); throw Error('Budget callback must throw');};
  const budget = await f.call(); assert.equal(budget.reason.code, 'RESOURCE_LIMIT'); assert.equal(budget.measurement, null); assert.equal(decodes, 0);
});

test('no audio is distinct from silence and still needs the second successful byte hash', async t => {
  for (const tamper of [false, true]) await t.test(String(tamper), async t => {
    let f, hashes = 0;
    f = await fixture(t, {runtime: {hash: async (...args) => {hashes++; if (tamper && hashes === 2) await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 9)); return verifiedManagedHash(...args);},
      decode: async () => {throw Object.assign(Error('No audio'), {code: 'LOUDNESS_NO_AUDIO'});}}});
    const result = await f.call(); assert.equal(result.reason.code, tamper ? 'ARTIFACT_CHANGED' : 'NO_AUDIO');
    assert.equal(result.measurement, null); assert.equal(result.suggestion, null); assert.equal(hashes, 2);
    if (!tamper) assert.equal(result.checks.bytesHashed, f.bytes.length * 2);
  });
  const f = await fixture(t, {runtime: {decode: async () => measurement(1, 0)}}), result = await f.call({...f.input, target: {integratedLufs: -23, truePeakCeilingDbtp: -1}});
  assert.equal(result.status, 'ready'); assert.equal(result.measurement.state, 'digital_silence'); assert.equal(result.measurement.integratedLufs, null); assert.equal(result.suggestion, null);
});

test('restored denial occurs before payload getters or any file/media adapter', async t => {
  const f = await fixture(t); let getters = 0, effects = 0;
  assert.ok(RESTORE_DENIED_OPERATIONS.includes('timeline.export.loudness'));
  const restored = createExportLoudnessServices({...f.store}, {runtime: {...f.runtime, assertOrdinaryWorkspace() {throw workspaceRestoreError();},
    validateSource() {effects++;}, decode() {effects++;}}}); f.extras.push(restored);
  await assert.rejects(restored.handlers['timeline.export.loudness']({get projectId() {getters++; return f.project.id;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters, 0); assert.equal(effects, 0);
});

test('actual restored-v1 composition denies loudness before parsing valid or hostile payloads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-loudness-'));
  let store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Restored loudness owner'});
  await services.drain(); store.close();
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()};
  try {installCurrentWorkspaceRestoreSchema(db, metadata); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root);
  services = createServices(store, new Proxy(new Map(), {get() {throw Error('Must not inspect providers');}}));
  let media = 0, getters = 0; const off = onMediaProcess(() => {media++;});
  t.after(async () => {off(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const beforeFiles = await files(root), beforeChanges = store.db.prepare('SELECT total_changes() AS n').get().n;
  const hostile = {get projectId() {getters++; throw Error('Payload access');}, get target() {getters++; throw Error('Payload access');}};
  const valid = {projectId: project.id, exportId: randomUUID(), expectedArtifactSha256: 'c'.repeat(64), measurementProfile: EXPORT_LOUDNESS_PROFILE};
  for (const value of [hostile, valid, null]) {
    await assert.rejects(services.call('timeline.export.loudness', value, {expectedWorkspaceOrigin: metadata.workspaceOrigin}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
    await assert.rejects(services.handlers['timeline.export.loudness'](value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(getters, 0); assert.equal(media, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges); assert.deepEqual(await files(root), beforeFiles);
});

test('service drain propagates an audioPreview owner rejection after the added loudness owner', async t => {
  const f = await fixture(t), expected = Object.assign(Error('Audio preview cleanup failed'), {code: 'AUDIO_PREVIEW_SHUTDOWN_FAILED'});
  const original = f.services.audioPreview.drain;
  f.services.audioPreview.drain = async () => {throw expected;};
  try {await assert.rejects(f.services.drain(), error => error === expected);}
  finally {f.services.audioPreview.drain = original;}
});

test('actual exact-child registry pins cross-operation cleanup and sticky termination failure through late close', async t => {
  const spawned = deferred(), waiting = deferred(), controller = new AbortController(); let attemptSignal, cleanupSignal, closeSignal;
  const f = await fixture(t, {runtime: {
    decode: async (_file, _duration, options) => {attemptSignal = options.signal; return runStreaming('ffmpeg', [], {signal: options.signal,
      beforeEffect: options.beforeEffect, onStdout: () => {throw Error('Invalid PCM callback');}});},
    terminate: signal => {cleanupSignal = signal; return terminateMediaProcesses({signal});},
    waitForClose: signal => {closeSignal = signal; waiting.resolve(); return waitForMediaProcesses({signal});},
  }}), peak = samplePeak(f);
  const originalSpawn = childProcess.spawn, children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter(); child.pid = 910000 + children.length; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.refs = 0; child.unrefs = 0;
    child.kill = signal => {child.kills.push(signal); return true;}; child.ref = () => {child.refs++; return child;}; child.unref = () => {child.unrefs++; return child;};
    children.push(child); queueMicrotask(() => {child.emit('spawn'); if (children.length === 2 && child === children[1]) spawned.resolve(child);}); return child;
  };
  syncBuiltinESMExports(); t.mock.timers.enable({apis: ['setTimeout']});
  const restore = () => {for (const child of children) child.emit('close', 0); childProcess.spawn = originalSpawn; syncBuiltinESMExports(); t.mock.timers.reset();}; t.after(restore);
  const unrelatedSignal = new AbortController().signal;
  const unrelated = spawnMedia('ffmpeg', [], {stdio: ['ignore', 'pipe', 'pipe']}, {kind: 'ffmpeg', signal: unrelatedSignal});
  try {
    const pending = f.call(f.input, {signal: controller.signal}), advisory = await spawned.promise;
    advisory.stdout.write(Buffer.from([1])); assert.deepEqual(advisory.kills, ['SIGTERM']); assert.deepEqual(unrelated.kills, []);
    t.mock.timers.tick(3001); await waiting.promise;
    assert.deepEqual(advisory.kills, ['SIGTERM', 'SIGKILL']); assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true);
    assert.equal(cleanupSignal, attemptSignal); assert.equal(closeSignal, attemptSignal); assert.notEqual(attemptSignal, controller.signal);
    controller.abort(); await assert.rejects(pending, {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(peak(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); assert.equal(children.length, 2);
    const draining = f.loudness.drain(), rejection = assert.rejects(draining, {code: 'EXPORT_LOUDNESS_STOP_TIMEOUT'});
    t.mock.timers.tick(5001); await rejection; assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), true);
    advisory.emit('exit', 1); advisory.emit('close', 1); await tick(); await tick();
    assert.equal(hasUnconfirmedMediaProcesses({signal: attemptSignal}), false);
    await assert.rejects(f.loudness.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    await assert.rejects(peak(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
    assert.deepEqual(unrelated.kills, []); assert.equal(children.length, 2);
  } finally {restore();}
});
