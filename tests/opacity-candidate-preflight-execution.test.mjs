import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Replace only codec transport. Store ownership, SQL, source bytes/hash/inodes,
// preflight/service cancellation, receipts, worker authority and the shared
// renderer execute their application implementation. No socket or child starts.
let childAttempts = 0;
const forbidden = () => {childAttempts++; throw Error('Candidate preflight execution tests may not spawn subprocesses');};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const runtimeKey = Symbol.for('mioon.test.opacity-preflight-codec');
const expression = 'globalThis[Symbol.for("mioon.test.opacity-preflight-codec")]';
const runtimeUrl = new URL('../packages/business/src/media-runtime.ts', import.meta.url).href;
const actualUrl = runtimeUrl + '?opacity-preflight-actual-runtime';
let activeCodec;
globalThis[runtimeKey] = {
  run: (...args) => activeCodec.run(...args),
  runStreaming: () => {throw Error('Synthetic video must not start image/subtitle/float decoding');},
};
const hooks = registerHooks({load(url, context, next) {
  if (url === runtimeUrl) return {format: 'module', shortCircuit: true,
    source: `export * from ${JSON.stringify(actualUrl)};export const run=(...args)=>${expression}.run(...args);export const runStreaming=(...args)=>${expression}.runStreaming(...args);`};
  return next(url, context);
}});
await import('@mioon/contracts');
const runtime = await import(actualUrl);
const {openOpacityCandidateStore} = await import('../packages/business/src/opacity-candidate-store.ts');
const {createServices} = await import('../packages/business/src/services.ts');
const {startWorker} = await import('../packages/business/src/jobs.ts');
const restore = await import('../packages/business/src/workspace-restore-schema-v43.ts');
const {createOpacityCandidateDomain} = await import('../packages/business/src/opacity-candidate-domain.ts');
const {timelineSnapshotHash} = await import('../packages/business/src/timeline-preflight.ts');
const {callObservedRpc} = await import('../apps/server/src/rpc-observation.ts');
const {onMediaProcess, waitForMediaProcesses} = await import('../packages/business/src/media-processes.ts');
const mediaEvents = [];
const unobserve = onMediaProcess(event => mediaEvents.push(event));
after(async () => {unobserve();hooks.deregister();delete globalThis[runtimeKey];mock.restoreAll();syncBuiltinESMExports();assert.equal(childAttempts, 0);assert.deepEqual(mediaEvents, []);await bounded(waitForMediaProcesses());});

const stamp = '2026-10-16T00:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const curve = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 3, opacity: .5}, {frame: 6, opacity: 1}]});
const sourceBytes = Buffer.from('Synthetic preflight source; never decoded by a native media child.\n'.repeat(4));
const outputBytes = Buffer.from('Synthetic worker output; publication inode and hash are real.\n');
const deferred = () => {let resolve;return {promise: new Promise(r => {resolve = r;}), resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Synthetic operation did not settle in 2s')), 2000);})]);}
  finally {clearTimeout(timer);}
}
function probeData({source = false, frames = 6} = {}) {
  const duration = source ? 1 : frames / 30;
  return {streams: [{index: 0, codec_type: 'video', codec_name: 'h264', width: source ? 64 : 720,
    height: source ? 48 : 1280, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1',
    duration: String(duration), nb_frames: String(source ? 30 : frames), sample_aspect_ratio: '1:1',
    has_b_frames: 0, time_base: '1/30000', start_pts: 0, start_time: '0'},
  {index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
    channel_layout: 'stereo', duration: String(duration), time_base: '1/48000', start_pts: 0, start_time: '0'}],
  format: {format_name: 'mov,mp4', duration: String(duration), start_time: '0'}};
}
function codecFor(f) {
  const calls = [];
  return {calls, frames: 6, sourceGate: null,
    async run(command, argv, options = {}) {
      runtime.checkMediaEffect(options.beforeEffect, options.signal);
      options.beforeSpawn?.();runtime.checkMediaEffect(options.beforeEffect, options.signal);
      if (command === 'ffprobe') {
        const file = argv.at(-1), source = file === f.source;
        assert.ok(source || file.startsWith(path.join(f.root, 'media', 'export-')));
        calls.push({command, argv: [...argv], source});
        if (source && this.sourceGate) await this.sourceGate(options);
        runtime.checkMediaEffect(options.beforeEffect, options.signal);
        return JSON.stringify(probeData({source, frames: this.frames}));
      }
      assert.equal(command, 'ffmpeg');
      assert.equal(f.preflightActive, false, 'preflight must never start an encoder or create its output file');
      const graphAt = argv.indexOf('-filter_complex'), scriptAt = argv.indexOf('-/filter_complex');
      const graph = graphAt >= 0 ? argv[graphAt + 1] : scriptAt >= 0 ? fs.readFileSync(argv[scriptAt + 1], 'utf8') : null;
      const file = argv.at(-1);
      assert.ok(path.isAbsolute(file) && file.startsWith(f.root + path.sep));
      const before = fs.lstatSync(file);
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
      calls.push({command, argv: [...argv], graph, file, inode: before.ino});
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {assert.equal(fs.fstatSync(fd).ino, before.ino);fs.ftruncateSync(fd, 0);fs.writeSync(fd, outputBytes, 0, outputBytes.length, 0);}
      finally {fs.closeSync(fd);}
      assert.equal(fs.lstatSync(file).ino, before.ino);
      return '';
    },
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-preflight-'));
  let store = openOpacityCandidateStore(root), services = createServices(store, new Map()), worker;
  const project = {id: randomUUID(), name: 'Synthetic candidate preflight', revision: 1, createdAt: stamp, updatedAt: stamp};
  const source = path.join(root, 'media', 'synthetic-source.mp4');
  fs.writeFileSync(source, sourceBytes, {flag: 'wx', mode: 0o600});
  const asset = {id: randomUUID(), projectId: project.id, name: 'Synthetic bytes.mp4', mimeType: 'video/mp4',
    duration: 1, width: 64, height: 48, hasVideo: true, hasAudio: true, sha256: sha(sourceBytes),
    sizeBytes: sourceBytes.length, relativePath: 'media/synthetic-source.mp4', provenance: 'user-import', createdAt: stamp};
  const clip = {id: randomUUID(), trackId: randomUUID(), assetId: asset.id, name: 'Opacity clip', startFrame: 0,
    durationFrames: 6, sourceInFrame: 2, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, opacityEnvelope: curve()};
  const timeline = {id: randomUUID(), projectId: project.id, revision: 1, fps: 30, width: 720, height: 1280,
    durationFrames: 6, tracks: [{id: clip.trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [clip], createdAt: stamp, updatedAt: stamp};
  store.put('projects', project);store.put('assets', asset);store.put('timelines', timeline);
  const f = {root, source, project, asset, clip, timeline, preflightActive: false,
    get store() {return store;}, get services() {return services;},
    input: patch => ({projectId: project.id, expectedRevision: store.get('timelines', timeline.id).revision, ...patch}),
    changes: () => store.db.prepare('SELECT total_changes() AS n').get().n,
    state: () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])),
    files: () => fs.readdirSync(root, {recursive: true}).sort(),
    async preflight(patch = {}, context = {}) {
      activeCodec = f.codec;f.preflightActive = true;
      try {return await services.call('timeline.export.preflight', f.input(patch), context);}
      finally {f.preflightActive = false;}
    },
    render(patch = {}, context = {}) {return services.call('timeline.render', f.input({requestId: randomUUID(), purpose: 'export', ...patch}), context);},
    start() {activeCodec = f.codec;return worker ??= startWorker(store, services, new Map());},
    async close() {await worker?.stop();worker = undefined;await services.drain();store.close();},
    async restore() {
      await f.close();
      const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
        manifestHash: 'b'.repeat(64), sourceDbHash: 'c'.repeat(64), createdAt: stamp};
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
      try {db.exec('PRAGMA foreign_keys=ON;');restore.installWorkspaceRestoreSchemaV43(db, metadata);} finally {db.close();}
      store = openOpacityCandidateStore(root);services = createServices(store, new Map());return metadata;
    },
  };
  f.codec = codecFor(f);activeCodec = f.codec;
  t.after(async () => {try {await f.close();} finally {fs.rmSync(root, {recursive: true, force: true});}});
  return f;
}
function assertNoWrites(f, before) {
  assert.equal(f.changes(), before.changes);assert.deepEqual(f.state(), before.state);assert.deepEqual(f.files(), before.files);
}
const beforeRead = f => ({changes: f.changes(), state: f.state(), files: f.files()});
const receipt = (f, requestId) => f.store.db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(requestId);
function assertPublished(f, accepted) {
  const completed = f.store.get('exports', accepted.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  assert.deepEqual(completed.snapshot, accepted.snapshot);
  const asset = f.store.get('assets', completed.assetId), file = path.join(f.root, asset.relativePath);
  assert.deepEqual(fs.readFileSync(file), outputBytes);assert.equal(asset.sha256, sha(outputBytes));
  assert.equal(fs.lstatSync(file).nlink, 1);
}

for (const [name, input] of [
  ['omitted purpose defaults to export', {}], ['explicit preview', {purpose: 'preview'}],
  ['explicit export', {purpose: 'export'}],
  ['selected export range and exact delivery name', {purpose: 'export', exportRange: {startFrame: 1, endFrame: 5}, deliveryName: ' 透明度 · opacity ' }],
]) test(`candidate42 actual preflight → raw snapshot hash → shared worker: ${name}`, async t => {
  const f = fixture(t), before = beforeRead(f), report = await f.preflight(input);
  assert.equal(report.status, 'ready', JSON.stringify(report));assertNoWrites(f, before);
  assert.deepEqual(report.checks, {totalAssets: 1, checkedAssets: 1, bytesHashed: sourceBytes.length, fullDecode: false});
  assert.equal(f.codec.calls.length, 1);assert.equal(f.codec.calls[0].command, 'ffprobe');
  const raw = createOpacityCandidateDomain(f.store).readPreflightSnapshot(f.input(input)).snapshot;
  assert.deepEqual(raw.timeline.clips[0].opacityEnvelope, curve());assert.ok(raw.opacityPlan);
  assert.equal(report.snapshotHash, timelineSnapshotHash(raw));
  const projected = clone(raw);delete projected.opacityPlan;delete projected.timeline.clips[0].opacityEnvelope;
  assert.notEqual(report.snapshotHash, timelineSnapshotHash(projected), 'hash covers the original opacity and plan');
  const accepted = await f.render({...input, preflightSnapshotHash: report.snapshotHash});
  const savedReceipt = receipt(f, accepted.requestId);
  assert.deepEqual(accepted.snapshot, raw);assert.equal(savedReceipt.response, JSON.stringify(accepted));
  if (input.exportRange) f.codec.frames = input.exportRange.endFrame - input.exportRange.startFrame;
  await f.start().tick();assertPublished(f, accepted);
  assert.deepEqual(receipt(f, accepted.requestId), savedReceipt);
  const encoded = f.codec.calls.filter(call => call.graph);assert.equal(encoded.length, 1);assert.match(encoded[0].graph, /format=gbrap,geq=/u);
  assert.equal(f.codec.calls.filter(call => call.source).length, 2, 'worker hashes/probes again rather than trusting the report');
  assert.deepEqual(fs.readFileSync(f.source), sourceBytes);assert.equal(childAttempts, 0);
});

for (const [name, change, reportCode, workerCode] of [
  ['missing source', f => fs.unlinkSync(f.source), 'PREFLIGHT_SOURCE_INVALID', 'MANAGED_SOURCE_INVALID'],
  ['changed bytes', f => fs.writeFileSync(f.source, Buffer.alloc(sourceBytes.length, 7)), 'PREFLIGHT_SOURCE_CHANGED', 'MANAGED_SOURCE_CHANGED'],
]) test(`candidate preflight and actual worker both refuse ${name} without codec or publication`, async t => {
  const f = fixture(t);change(f);const before = beforeRead(f), report = await f.preflight();
  assert.equal(report.status, 'blocked');assert.equal(report.issues[0].code, reportCode);assertNoWrites(f, before);
  assert.equal(f.codec.calls.length, 0);assert.ok(!JSON.stringify(report).includes(f.root));
  // This advisory report never bypasses the normal worker's independent checks.
  const accepted = await f.render({preflightSnapshotHash: report.snapshotHash}), savedReceipt = receipt(f, accepted.requestId);
  await f.start().tick();const failed = f.store.get('exports', accepted.id);
  assert.equal(failed.status, 'failed');assert.equal(failed.error.code, workerCode);
  assert.equal(failed.assetId, null);assert.equal(failed.url, null);assert.equal(f.codec.calls.length, 0);
  assert.deepEqual(receipt(f, accepted.requestId), savedReceipt);assert.equal(f.store.list('assets', f.project.id).length, 1);
});

test('a real opacity edit makes the original preflight hash stale without queuing an export or receipt', async t => {
  const f = fixture(t), old = await f.preflight(), replacement = curve();replacement.points[1].opacity = .25;
  const changed = await f.services.call('timeline.clip.update', f.input({requestId: randomUUID(), clipId: f.clip.id, patch: {opacityEnvelope: replacement}}));
  assert.equal(changed.revision, 2);const requestId = randomUUID(), before = beforeRead(f);
  await assert.rejects(f.render({requestId, preflightSnapshotHash: old.snapshotHash}), {code: 'PREFLIGHT_STALE'});
  assert.equal(receipt(f, requestId), undefined);assert.equal(f.store.list('exports', f.project.id).length, 0);
  assert.equal(f.changes(), before.changes);assert.deepEqual(f.state(), before.state);
  const current = await f.preflight();assert.equal(current.status, 'ready');assert.notEqual(current.snapshotHash, old.snapshotHash);
  const accepted = await f.render({preflightSnapshotHash: current.snapshotHash});
  assert.deepEqual(accepted.snapshot.timeline.clips[0].opacityEnvelope, replacement);
  await f.start().tick();assertPublished(f, accepted);
});

test('candidate43 preflight keeps origin admission and held rows intact through a fresh worker export', async t => {
  const f = fixture(t), held = await f.render(), heldReceipt = receipt(f, held.requestId), metadata = await f.restore();
  const heldRaw = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(held.id).data;
  const before = beforeRead(f);
  await assert.rejects(f.preflight(), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.preflight({}, {expectedWorkspaceOrigin: randomUUID()}), {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  assertNoWrites(f, before);assert.equal(f.codec.calls.length, 0);
  const context = {expectedWorkspaceOrigin: metadata.workspaceOrigin}, report = await f.preflight({}, context);
  assert.equal(report.status, 'ready', JSON.stringify(report));assertNoWrites(f, before);
  const previewReport = await f.preflight({purpose: 'preview'}, context);
  assert.equal(previewReport.status, 'ready', JSON.stringify(previewReport));assertNoWrites(f, before);
  const fresh = [await f.render({preflightSnapshotHash: report.snapshotHash}, context),
    await f.render({purpose: 'preview', preflightSnapshotHash: previewReport.snapshotHash}, context)];
  for (const accepted of fresh)
    assert.equal(f.store.db.prepare('SELECT workspaceOrigin FROM workspace_restore_export_origins WHERE exportId=?').get(accepted.id).workspaceOrigin, metadata.workspaceOrigin);
  await f.start().tick();for (const accepted of fresh) assertPublished(f, accepted);
  assert.equal(f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(held.id).data, heldRaw);
  assert.deepEqual(receipt(f, held.requestId), heldReceipt);assert.equal(f.store.get('exports', held.id).status, 'queued');
  assert.equal(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(held.id) !== undefined, true);
  assert.equal(f.codec.calls.filter(call => call.graph).length, 2);restore.validateWorkspaceRestoreSchemaV43(f.store.db);
});

test('actual callObservedRpc disconnect revokes candidate preflight, retains the in-flight gate and never publishes false ready', async t => {
  const f = fixture(t), entered = deferred(), release = deferred(), probeSettled = deferred();
  let probeSignal;
  f.codec.sourceGate = async ({signal}) => {probeSignal = signal;entered.resolve();try {await release.promise;} finally {probeSettled.resolve();}};
  const req = new EventEmitter(), res = new EventEmitter(), before = beforeRead(f);
  f.preflightActive = true;
  const pending = callObservedRpc(req, res, f.services, 'timeline.export.preflight', f.input());
  const rejected = assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  await bounded(entered.promise);res.emit('close');await bounded(rejected);
  assert.equal(probeSignal.aborted, true);assert.equal(req.listenerCount('aborted'), 0);assert.equal(res.listenerCount('close'), 0);
  assert.deepEqual(mediaEvents, []);await bounded(waitForMediaProcesses());assert.equal(childAttempts, 0);assertNoWrites(f, before);
  const busy = await f.preflight();assert.equal(busy.status, 'incomplete');assert.equal(busy.issues[0].code, 'PREFLIGHT_BUSY');
  assert.equal(f.codec.calls.length, 1, 'disconnect does not admit a second preparation while the original is outstanding');
  fs.writeFileSync(f.source, Buffer.alloc(sourceBytes.length, 9));release.resolve();await bounded(probeSettled.promise);f.codec.sourceGate = null;
  let next;
  for (let n = 0; n < 20; n++) {await tick();next = await f.preflight();if (next.issues[0]?.code !== 'PREFLIGHT_BUSY') break;}
  assert.equal(next.status, 'blocked');assert.equal(next.issues[0].code, 'PREFLIGHT_SOURCE_CHANGED');
  assert.equal(f.codec.calls.length, 1, 'cancelled probe value cannot become ready or start another codec on changed bytes');
  assert.deepEqual(mediaEvents, []);await bounded(waitForMediaProcesses());assert.equal(f.changes(), before.changes);assert.deepEqual(f.state(), before.state);
});
