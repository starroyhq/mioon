import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

// Only the codec process boundary is replaced. SQLite transactions, services,
// receipt/claim/origin authority, source reads/hash/inodes, shared renderer and
// attempt-owned staging/publication all run their application implementation.
// Synthetic source/output bytes intentionally are not playable media.
let childAttempts = 0;
const forbidden = () => {childAttempts++; throw Error('This candidate worker test may not spawn any subprocess');};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const runtimeKey = Symbol.for('mioon.test.opacity-worker-codec');
const expression = 'globalThis[Symbol.for("mioon.test.opacity-worker-codec")]';
const runtimeUrl = new URL('../packages/business/src/media-runtime.ts', import.meta.url).href;
const actualUrl = runtimeUrl + '?opacity-worker-actual-runtime';
let activeCodec;
globalThis[runtimeKey] = {
  run: (...args) => activeCodec.run(...args),
  runStreaming: () => {throw Error('This synthetic video fixture must not start an image/subtitle/float decoder');},
};
const hooks = registerHooks({load(url, context, next) {
  if (url === runtimeUrl) return {format: 'module', shortCircuit: true,
    source: `export * from ${JSON.stringify(actualUrl)};export const run=(...args)=>${expression}.run(...args);export const runStreaming=(...args)=>${expression}.runStreaming(...args);`};
  return next(url, context);
}});
// Fixed candidate modules use synchronous require of the historical contracts;
// finish that shared module before beginning their dependent imports.
await import('@mioon/contracts');
const runtime = await import(actualUrl);
const stores = await import('../packages/business/src/opacity-candidate-store.ts');
const serviceModule = await import('../packages/business/src/services.ts');
const workers = await import('../packages/business/src/jobs.ts');
const restore = await import('../packages/business/src/workspace-restore-schema-v43.ts');
const authority = await import('../packages/business/src/opacity-candidate-render-authority.ts');
const bindings = await import('../packages/business/src/timeline-opacity-render-binding.ts');
after(() => {hooks.deregister(); delete globalThis[runtimeKey]; mock.restoreAll(); syncBuiltinESMExports(); assert.equal(childAttempts, 0);});

const stamp = '2026-10-16T00:00:00.000Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profileId = 'mioon-clip-linear-opacity-v1';
const curve = () => ({profileId, points: [{frame: 0, opacity: 0}, {frame: 3, opacity: .5}, {frame: 6, opacity: 1}]});
const sourceBytes = Buffer.from('MIOON synthetic source bytes; no media decoder may read this fixture.\n'.repeat(4));
const outputBytes = Buffer.from('MIOON synthetic codec output bytes; hash and inode publication stay real.\n');

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
  return {calls, beforeEncode: null,
    async run(command, argv, options = {}) {
      runtime.checkMediaEffect(options.beforeEffect, options.signal);
      options.beforeSpawn?.(); runtime.checkMediaEffect(options.beforeEffect, options.signal);
      if (command === 'ffprobe') {
        const file = argv.at(-1), source = file === f.source;
        assert.ok(source || file.startsWith(path.join(f.root, 'media', 'export-')), 'codec probes only this fixture source/output');
        calls.push({command, argv: [...argv], source});
        return JSON.stringify(probeData({source}));
      }
      assert.equal(command, 'ffmpeg');
      const graphAt = argv.indexOf('-filter_complex'), scriptAt = argv.indexOf('-/filter_complex');
      const graph = graphAt >= 0 ? argv[graphAt + 1] : scriptAt >= 0 ? fs.readFileSync(argv[scriptAt + 1], 'utf8') : null;
      const file = argv.at(-1);
      assert.ok(path.isAbsolute(file) && file.startsWith(f.root + path.sep), 'codec output stays in this fixture');
      const before = fs.lstatSync(file);
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'real worker/renderer reserved the exact output inode');
      calls.push({command, argv: [...argv], graph, file, inode: before.ino});
      if (graph) this.beforeEncode?.({command, argv, graph, file});
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try {
        assert.equal(fs.fstatSync(fd).ino, before.ino);
        fs.ftruncateSync(fd, 0); fs.writeSync(fd, outputBytes, 0, outputBytes.length, 0);
      } finally {fs.closeSync(fd);}
      assert.equal(fs.lstatSync(file).ino, before.ino, 'fake codec writes retain the reserved inode');
      return '';
    },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-worker-'));
  const project = {id: randomUUID(), name: 'Synthetic opacity worker', revision: 1, createdAt: stamp, updatedAt: stamp};
  const source = path.join(root, 'media', 'synthetic-source.mp4');
  let store = stores.openOpacityCandidateStore(root), services = serviceModule.createServices(store, new Map()), worker;
  fs.writeFileSync(source, sourceBytes, {flag: 'wx', mode: 0o600});
  const asset = {id: randomUUID(), projectId: project.id, name: 'Synthetic bytes.mp4', mimeType: 'video/mp4',
    duration: 1, width: 64, height: 48, hasVideo: true, hasAudio: true, sha256: sha(sourceBytes),
    sizeBytes: sourceBytes.length, relativePath: 'media/synthetic-source.mp4', provenance: 'user-import', createdAt: stamp};
  const clip = {id: randomUUID(), trackId: randomUUID(), assetId: asset.id, name: 'Opacity clip',
    startFrame: 0, durationFrames: 6, sourceInFrame: 2, rect: {x: 0, y: 0, width: 720, height: 1280},
    gain: 1, opacityEnvelope: curve()};
  const timeline = {id: randomUUID(), projectId: project.id, revision: 1, fps: 30, width: 720, height: 1280,
    durationFrames: 6, tracks: [{id: clip.trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [clip], createdAt: stamp, updatedAt: stamp};
  store.put('projects', project); store.put('assets', asset); store.put('timelines', timeline);
  const f = {root, source, project, asset, clip, timeline, codec: null,
    get store() {return store;}, get services() {return services;},
    render(purpose = 'export', context = {}) {
      return services.call('timeline.render', {projectId: project.id, expectedRevision: timeline.revision,
        requestId: randomUUID(), purpose}, context);
    },
    start() {activeCodec = f.codec; return worker ??= workers.startWorker(store, services, new Map());},
    async close() {await worker?.stop(); worker = undefined; await services.drain(); store.close();},
    async restore() {
      await f.close();
      const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
        manifestHash: 'b'.repeat(64), sourceDbHash: 'c'.repeat(64), createdAt: stamp};
      const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
      try {db.exec('PRAGMA foreign_keys=ON;'); restore.installWorkspaceRestoreSchemaV43(db, metadata);} finally {db.close();}
      store = stores.openOpacityCandidateStore(root); services = serviceModule.createServices(store, new Map());
      return metadata;
    },
  };
  f.codec = codecFor(f); activeCodec = f.codec;
  t.after(async () => {try {await f.close();} finally {fs.rmSync(root, {recursive: true, force: true});}});
  return f;
}
const receipt = (f, accepted) => f.store.db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(accepted.requestId);
function assertPublished(f, accepted) {
  const completed = f.store.get('exports', accepted.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  assert.deepEqual(completed.snapshot, accepted.snapshot);
  const asset = f.store.get('assets', completed.assetId), file = path.join(f.root, asset.relativePath);
  assert.deepEqual(fs.readFileSync(file), outputBytes);
  assert.equal(asset.sha256, sha(fs.readFileSync(file)));
  assert.equal(asset.sizeBytes, outputBytes.length);
  assert.equal(fs.lstatSync(file).nlink, 1);
  assert.equal(fs.readdirSync(path.join(f.root, 'media')).some(name => name.startsWith('.timeline-render-') || name.endsWith('.part.mp4')), false);
  return completed;
}

test('actual42 services and worker publish preview/export through shared geq renderer without changing accepted curves, plans or receipts', async t => {
  const f = fixture(t), accepted = [await f.render('preview'), await f.render('export')];
  const beforeReceipts = accepted.map(value => receipt(f, value));
  for (const value of accepted) {
    assert.deepEqual(value.snapshot.timeline.clips[0].opacityEnvelope, curve());
    assert.equal(value.snapshot.opacityPlan.profileId, 'mioon-clip-opacity-render-v1');
    assert.equal(value.snapshot.opacityPlan.clips[0].assetSha256, f.asset.sha256);
  }
  await f.start().tick();
  for (let n = 0; n < accepted.length; n++) {
    assertPublished(f, accepted[n]); assert.deepEqual(receipt(f, accepted[n]), beforeReceipts[n]);
    assert.equal(beforeReceipts[n].response, JSON.stringify(accepted[n]));
  }
  const encoded = f.codec.calls.filter(call => call.graph);
  assert.equal(encoded.length, 2);
  for (const {graph} of encoded) {
    assert.match(graph, /trim=end_frame=6,setpts=N\/\(30\*TB\),format=gbrap,geq=/u);
    const layer = graph.slice(graph.indexOf('[0:0]'), graph.indexOf('[v0]') + 4);
    assert.match(layer, /geq=r=r\(X\\,Y\):g=g\(X\\,Y\):b=b\(X\\,Y\):a=/u, 'straight alpha changes only A');
    assert.ok(graph.indexOf('geq=') < graph.indexOf('[base][v0]overlay='));
    assert.match(graph, /\[base\]\[v0\]overlay=x=0:y=0:eof_action=pass:repeatlast=0:shortest=0\[layer0\]/u);
  }
  assert.deepEqual(fs.readFileSync(f.source), sourceBytes);
  assert.equal(childAttempts, 0);
});

test('actual43 worker ignores held exports and only publishes a fresh explicit-origin export', async t => {
  const f = fixture(t), held = await f.render(), heldReceipt = receipt(f, held), info = await f.restore();
  const heldRaw = f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(held.id).data;
  const priorCalls = f.codec.calls.length;
  await assert.rejects(f.render(), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.render('export', {expectedWorkspaceOrigin: randomUUID()}), {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  assert.equal(f.codec.calls.length, priorCalls);
  const accepted = await f.render('export', {expectedWorkspaceOrigin: info.workspaceOrigin}), savedReceipt = receipt(f, accepted);
  const origin = f.store.db.prepare('SELECT workspaceOrigin,requestScope,requestId FROM workspace_restore_export_origins WHERE exportId=?').get(accepted.id);
  assert.deepEqual({...origin}, {workspaceOrigin: info.workspaceOrigin, requestScope: 'timeline.render', requestId: accepted.requestId});
  assert.equal(f.store.db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(held.id) !== undefined, true);
  await f.start().tick(); assertPublished(f, accepted);
  assert.equal(f.store.db.prepare('SELECT data FROM exports WHERE id=?').get(held.id).data, heldRaw);
  assert.deepEqual(receipt(f, held), heldReceipt); assert.deepEqual(receipt(f, accepted), savedReceipt);
  assert.equal(f.store.get('exports', held.id).status, 'queued');
  assert.equal(f.codec.calls.filter(call => call.graph).length, 1);
  restore.validateWorkspaceRestoreSchemaV43(f.store.db);
});

test('actual candidate worker and render binding refuse copied services, foreign stores, copied records/Maps and expired attempts', async t => {
  const f = fixture(t), foreign = fixture(t), accepted = await f.render(); activeCodec = f.codec;
  assert.throws(() => workers.startWorker(f.store, {...f.services}, new Map()), {code: 'OPACITY_CANDIDATE_STORE_REQUIRED'});
  assert.throws(() => workers.startWorker(f.store, foreign.services, new Map()), {code: 'OPACITY_CANDIDATE_STORE_REQUIRED'});
  const claimed = f.store.tx(() => authority.claimOpacityCandidateExport(f.store, f.store.get('exports', accepted.id), stamp));
  const prepared = await authority.prepareOpacityCandidateRenderInputs(f.store, claimed);
  assert.throws(() => bindings.bindTimelineOpacityRenderAttempt(foreign.store, claimed, prepared));
  const recordPrepared = await authority.prepareOpacityCandidateRenderInputs(f.store, claimed);
  assert.throws(() => bindings.bindTimelineOpacityRenderAttempt(f.store, {...claimed}, recordPrepared));
  const freshPrepared = await authority.prepareOpacityCandidateRenderInputs(f.store, claimed);
  assert.throws(() => bindings.bindTimelineOpacityRenderAttempt(f.store, claimed, new Map(freshPrepared)));
  const binding = bindings.bindTimelineOpacityRenderAttempt(f.store, claimed, freshPrepared);
  assert.equal(bindings.getTimelineOpacityRenderBinding(claimed.snapshot, freshPrepared), binding);
  assert.throws(() => bindings.getTimelineOpacityRenderBinding(claimed.snapshot, new Map(freshPrepared)), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
  for (const copied of [structuredClone(claimed.snapshot), JSON.parse(JSON.stringify(claimed.snapshot))])
    assert.throws(() => bindings.getTimelineOpacityRenderBinding(copied, freshPrepared), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
  binding.close();
  assert.throws(() => bindings.getTimelineOpacityRenderBinding(claimed.snapshot, freshPrepared), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
  assert.throws(() => binding.filterForSegment(f.clip.id, 0, 6, 'straight'), {code: 'OPACITY_RENDER_BINDING_UNAVAILABLE'});
  authority.revokeOpacityCandidateExportClaim(f.store, claimed);
  assert.equal(f.codec.calls.some(call => call.graph), false, 'identity failures never encode');
});

test('a source inode replacement at the actual render fence blocks publication and preserves the replacement', async t => {
  const f = fixture(t), accepted = await f.render(), savedReceipt = receipt(f, accepted), before = fs.lstatSync(f.source);
  let changed = false;
  f.codec.beforeEncode = () => {
    assert.equal(changed, false); changed = true;
    const replacement = f.source + '.replacement'; fs.writeFileSync(replacement, sourceBytes, {flag: 'wx', mode: 0o600});
    fs.renameSync(replacement, f.source);
    assert.notEqual(fs.lstatSync(f.source).ino, before.ino);
  };
  await f.start().tick();
  assert.equal(changed, true, 'replacement happens after source hash/probe and private binding');
  const completed = f.store.get('exports', accepted.id);
  assert.equal(completed.status, 'failed', JSON.stringify(completed.error));
  assert.ok(['RESTORE_OPERATION_UNAVAILABLE', 'TIMELINE_SOURCE_UNAVAILABLE', 'MANAGED_SOURCE_CHANGED'].includes(completed.error.code));
  assert.equal(completed.assetId, null); assert.equal(completed.url, null);
  assert.equal(f.store.list('assets', f.project.id).length, 1);
  assert.deepEqual(completed.snapshot, accepted.snapshot); assert.deepEqual(receipt(f, accepted), savedReceipt);
  assert.deepEqual(fs.readFileSync(f.source), sourceBytes); assert.notEqual(fs.lstatSync(f.source).ino, before.ino);
  assert.equal(fs.readdirSync(path.join(f.root, 'media')).some(name => name.startsWith('export-')), false);
  assert.equal(f.codec.calls.filter(call => call.graph).length, 1);
});
