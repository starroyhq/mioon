import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile, readFile, readdir, unlink, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AUDIO_PREVIEW_LIMITS, isAudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import {installCurrentWorkspaceRestoreSchema, openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelineAudioPreviewServices} from '../packages/business/src/timeline-audio-preview.ts';
import {readTimelinePreflightSnapshot, readTimelineSourceGraph} from '../packages/business/src/timeline-sources.ts';
import {validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.ts';
import {workspaceRestoreError} from '../packages/business/src/workspace-restore-policy.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {resolve, promise};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function readSaved(store, projectId) {
  const {db} = store, outer = db.isTransaction;
  if (!outer) db.exec('BEGIN DEFERRED');
  try {
    const {timeline} = readTimelinePreflightSnapshot(store, projectId);
    if (!timeline) return null;
    const assets = readTimelineSourceGraph(db, projectId, timeline);
    validateTimeline(timeline, assets, {structureOnly: true});
    return {timeline, assets: [...assets.values()]};
  } finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
}
function decoded(request, sourceBytes, value = 0.25, durationSeconds = 60) {
  const pcm = Buffer.alloc(request.frameCount * 1600 * 8);
  for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(value, offset);
  return {pcm, sampleRate: 48000, channels: 2, sampleFrames: request.frameCount * 1600,
    source: {streamIndex: 0, codecName: 'pcm_f32le', sampleRate: 48000, channels: 2, channelLayout: 'stereo',
      layoutOrigin: 'declared', durationSeconds, audioDurationSeconds: durationSeconds, container: 'wav', sizeBytes: sourceBytes}};
}
async function files(root) {
  const result = [];
  for (const item of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!item.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(item.name) || item.name === 'server.lock') continue;
    const full = path.join(item.parentPath, item.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, {durationFrames = 60, sourceInFrame = 17, startFrame = 0, clipStartFrame = 0, runtime: overrides = {}} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-audio-preview-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Owned saved sound'}), foreign = await services.call('project.create', {name: 'Other project'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const id = randomUUID(), bytes = Buffer.alloc(96 * 1024, 7);
  const asset = {id, projectId: project.id, name: 'Owned sound.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
    sha256: sha(bytes), sizeBytes: bytes.length, duration: 60, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: clipStartFrame, sourceInFrame,
    durationFrames, gain: 0.75, fadeInFrames: 10, fadeOutFrames: 10});
  const runtime = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    readSavedTimeline: projectId => readSaved(store, projectId), validateSource: validateManagedSource, hash: verifiedManagedHash,
    decode: async (_file, request, options) => {options.beforeEffect(); return decoded(request, bytes.length);},
    terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides};
  const audio = createTimelineAudioPreviewServices(store, {runtime}), extras = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await audio.drain().catch(() => {});
    await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = {projectId: project.id, timelineId: timeline.id, expectedRevision: timeline.revision, startFrame};
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const f = {root, store, services, project, foreign, asset, bytes, timeline, input, audio, runtime, extras,
    plan: (value = input, options) => audio.handlers['timeline.audioPreview.plan'](value, options),
    sourceInput: plan => ({...input, clipId: plan.sources[0].clipId, sourceHash: plan.sources[0].sourceHash, planHash: plan.planHash}),
    checkpoint: async () => ({rows: rows(), writes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await files(root)}),
    unchanged: async before => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.writes); assert.deepEqual(await files(root), before.files);}};
  f.consume = async (options = {}) => audio.consumeSource(f.sourceInput(await f.plan()), {consume: async value => value, ...options});
  return f;
}
const replace = (f, table, value) => f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);

// Fake PCM and causal runtimes isolate lifecycle/authorization here. Canonical
// and resampling signal parity are covered by the dedicated real-media suites.
test('plan and source bind actual owned saved revision, clipped interval, exact hashes and zero writes', async t => {
  let hashes = 0, decodedRequest, consumedBuffer;
  const f = await fixture(t, {durationFrames: 900, sourceInFrame: 31, startFrame: 121, clipStartFrame: 100, runtime: {
    hash: (...args) => {hashes++; return verifiedManagedHash(...args);}, decode: async (_file, request, options) => {
      options.beforeEffect(); decodedRequest = request; const result = decoded(request, 96 * 1024); consumedBuffer = result.pcm; return result;
    }}});
  const before = await f.checkpoint(), plan = await f.plan();
  assert.ok(isAudioPreviewPlan(plan, f.input)); assert.deepEqual(plan.range, {startFrame: 121, endFrame: 721, startSample: 193600, endSample: 1153600, sampleFrames: 960000});
  assert.equal(plan.sources[0].sourceInFrame, 52); assert.equal(plan.sources[0].durationFrames, 600);
  assert.equal(plan.memory.retainedPcmBytes, 7_680_000); assert.equal(plan.memory.admittedBytes, 4 * 7_680_000 + 2 * 1024 * 1024);
  assert.equal(plan.memory.hashReadBytes, 2 * f.bytes.length); assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.sources[0]));
  assert.ok(!JSON.stringify(plan).includes(f.root) && !JSON.stringify(plan).includes(f.asset.relativePath));
  const result = await f.audio.consumeSource(f.sourceInput(plan), {consume: async (result, context) => {
    context.beforeEffect(); assert.equal(result.pcm, consumedBuffer); assert.equal(context.plan.planHash, plan.planHash);
    assert.equal(context.source.sourceKey, plan.sources[0].sourceKey); assert.equal(context.signal.aborted, false); return result.pcm.byteLength;
  }});
  assert.equal(result, 7_680_000); assert.deepEqual(decodedRequest, {sourceInFrame: 52, frameCount: 600, segments: [{sourceInFrame: 31, frameCount: 900, trimStartFrame: 21, outputFrames: 600}]}); assert.deepEqual(plan.work, {decodedSourceFrames: 901, decodeSegments: 1}); assert.equal(hashes, 2); await f.unchanged(before);
});

test('strict public and fixed-source identity rejects paths, filters, streams, source substitutions and stale plans before bytes', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}}});
  const plan = await f.plan(), input = f.sourceInput(plan), consume = async () => assert.fail('no consumer');
  for (const extra of [{path: '/private/file'}, {streamIndex: 1}, {filter: 'volume=9'}, {timeoutMs: 1}, {sourceInFrame: 0}, {assetId: f.asset.id}]) {
    await assert.rejects(f.plan({...f.input, ...extra}), {code: 'VALIDATION_ERROR'});
    await assert.rejects(f.audio.consumeSource({...input, ...extra}, {consume}), {code: 'VALIDATION_ERROR'});
  }
  await assert.rejects(f.plan({...f.input, expectedRevision: f.input.expectedRevision + 1}), {code: 'AUDIO_PREVIEW_REVISION_CONFLICT'});
  await assert.rejects(f.audio.consumeSource({...input, planHash: 'b'.repeat(64)}, {consume}), {code: 'AUDIO_PREVIEW_STALE'});
  await assert.rejects(f.audio.consumeSource({...input, clipId: randomUUID()}, {consume}), {code: 'AUDIO_PREVIEW_UNAVAILABLE'});
  await assert.rejects(f.audio.consumeSource({...input, sourceHash: 'c'.repeat(64)}, {consume}), {code: 'AUDIO_PREVIEW_UNAVAILABLE'});
  await assert.rejects(f.plan({...f.input, projectId: f.foreign.id}), {code: 'AUDIO_PREVIEW_UNAVAILABLE'});
  assert.equal(reads, 0);
});

test('missing timeline never initializes; corrupt/foreign graph rejects before file access', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}}});
  const cases = [
    () => f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify({...f.timeline, id: randomUUID()}), f.timeline.id),
    () => replace(f, 'timelines', {...f.timeline, projectId: f.foreign.id}),
    () => replace(f, 'timelines', {...f.timeline, clips: [...f.timeline.clips, f.timeline.clips[0]]}),
    () => replace(f, 'timelines', {...f.timeline, clips: f.timeline.clips.map(clip => ({...clip, speed: 2}))}),
    () => replace(f, 'timelines', {...f.timeline, clips: f.timeline.clips.map(clip => ({...clip, versionId: randomUUID()}))}),
    () => replace(f, 'assets', {...f.asset, projectId: f.foreign.id}),
    () => replace(f, 'assets', {...f.asset, sha256: 'broken'}),
    () => f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run('x'.repeat(4 * 1024 * 1024 + 1), f.timeline.id),
  ];
  for (const change of cases) {
    change(); const before = await f.checkpoint(); await assert.rejects(f.plan()); await f.unchanged(before);
    replace(f, 'timelines', f.timeline); replace(f, 'assets', f.asset);
  }
  f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(f.timeline.id);
  const before = await f.checkpoint(); await assert.rejects(f.plan(), {code: 'AUDIO_PREVIEW_UNAVAILABLE'}); await f.unchanged(before); assert.equal(reads, 0);
});

test('actual native owner proof denies unlocked reader; copied store cannot create another decoder permit', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {decode: async (_file, request, options) => {decodes++; entered.resolve(); await gate.promise; options.beforeEffect(); return decoded(request, 96 * 1024);}}});
  const reader = openStore(f.root, {lock: false}); t.after(() => reader.close());
  const unauthorized = createTimelineAudioPreviewServices(reader, {runtime: {...f.runtime, ownsLock: () => ownsStoreLock(reader)}}); f.extras.push(unauthorized);
  await assert.rejects(unauthorized.handlers['timeline.audioPreview.plan'](f.input), {code: 'AUDIO_PREVIEW_OWNER_REQUIRED'});
  const copied = createTimelineAudioPreviewServices({...f.store}, {runtime: f.runtime}); f.extras.push(copied);
  const source = f.sourceInput(await f.plan()), pending = f.audio.consumeSource(source, {consume: async value => value.sampleFrames}); await entered.promise;
  await assert.rejects(copied.consumeSource(source, {consume: async () => {}}), {code: 'AUDIO_PREVIEW_BUSY'});
  assert.equal(decodes, 1); gate.resolve(); assert.equal(await pending, 96000);
});

test('permit covers binary consumption and does not free on caller cancellation until consumer settles', async t => {
  const entered = deferred(), gate = deferred(), controller = new AbortController(); const f = await fixture(t);
  const source = f.sourceInput(await f.plan()); let combined, publishes = 0;
  const pending = f.audio.consumeSource(source, {signal: controller.signal, consume: async (_value, context) => {
    combined = context.signal; entered.resolve(); await gate.promise; context.beforeEffect(); publishes++;
  }});
  await entered.promise; await assert.rejects(f.audio.consumeSource(source, {consume: async () => {}}), {code: 'AUDIO_PREVIEW_BUSY'});
  controller.abort(); await assert.rejects(pending, {code: 'OPERATION_CANCELLED'}); assert.equal(combined.aborted, true);
  await assert.rejects(f.audio.consumeSource(source, {consume: async () => {}}), {code: 'AUDIO_PREVIEW_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(publishes, 0);
  assert.equal((await f.consume()).sampleFrames, 96000);
});

test('cancelled non-cooperative hash retains admission and bounded drain fails until underlying read settles', async t => {
  const entered = deferred(), gate = deferred(), controller = new AbortController(); let decodes = 0, consumes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);},
    decode: async () => {decodes++; throw Error('must not decode');}}});
  const before = await f.checkpoint(); t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.consume({signal: controller.signal, consume: async () => {consumes++;}}); await entered.promise;
  controller.abort(); await assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  await assert.rejects(f.consume(), {code: 'AUDIO_PREVIEW_BUSY'}); assert.equal(decodes, 0);
  const draining = f.audio.drain(), rejected = assert.rejects(draining, {code: 'AUDIO_PREVIEW_STOP_TIMEOUT'});
  t.mock.timers.tick(5001); await rejected; gate.resolve(); await tick(); await tick(); await f.audio.drain(); t.mock.timers.reset();
  assert.equal(consumes, 0); assert.equal(decodes, 0); await f.unchanged(before);
});

test('deadline revokes late hash results without decode, write, or automatic retry', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: async () => {decodes++;}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.consume(); await entered.promise; t.mock.timers.tick(AUDIO_PREVIEW_LIMITS.prepareTimeoutMs + 1);
  await assert.rejects(pending, {code: 'AUDIO_PREVIEW_TIMEOUT'}); await assert.rejects(f.consume(), {code: 'AUDIO_PREVIEW_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('same-revision metadata, revision, owned hash, bytes and owner revocation fence every decoder return', async t => {
  for (const phase of ['metadata', 'revision', 'hash', 'bytes', 'foreign', 'lock']) await t.test(phase, async t => {
    let f, consumed = 0; f = await fixture(t, {runtime: {decode: async (_file, request) => {
      if (phase === 'metadata') replace(f, 'assets', {...f.asset, name: 'Changed after admission'});
      if (phase === 'revision') replace(f, 'timelines', {...f.timeline, revision: f.timeline.revision + 1});
      if (phase === 'hash') replace(f, 'assets', {...f.asset, sha256: 'b'.repeat(64)});
      if (phase === 'bytes') await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 8));
      if (phase === 'foreign') replace(f, 'assets', {...f.asset, projectId: f.foreign.id});
      if (phase === 'lock') await unlink(path.join(f.root, 'server.lock'));
      return decoded(request, f.bytes.length);
    }}});
    await assert.rejects(f.consume({consume: async () => {consumed++;}}), error => ['AUDIO_PREVIEW_STALE', 'AUDIO_PREVIEW_REVISION_CONFLICT', 'AUDIO_PREVIEW_UNAVAILABLE', 'AUDIO_PREVIEW_OWNER_REQUIRED'].includes(error.code));
    assert.equal(consumed, 0);
  });
});

test('source bytes, symlinks and independently invalid PCM never reach publication', async t => {
  for (const kind of ['bytes', 'symlink', 'nan', 'short', 'extra', 'rate', 'source-size']) await t.test(kind, async t => {
    let decodes = 0, consumed = 0;
    const f = await fixture(t, {runtime: {decode: async (_file, request) => {
      decodes++; const value = decoded(request, 96 * 1024);
      if (kind === 'nan') value.pcm.writeFloatLE(NaN, value.pcm.length - 4);
      if (kind === 'short') value.pcm = value.pcm.subarray(0, value.pcm.length - 8);
      if (kind === 'extra') value.pcm = Buffer.alloc(value.pcm.length + 8);
      if (kind === 'rate') value.sampleRate = 44100;
      if (kind === 'source-size') value.source.sizeBytes++;
      return value;
    }}});
    const file = path.join(f.root, f.asset.relativePath);
    if (kind === 'bytes') await writeFile(file, Buffer.alloc(f.bytes.length, 9));
    if (kind === 'symlink') {await unlink(file); await symlink(path.join(f.root, 'private.wav'), file);}
    const before = await f.checkpoint();
    await assert.rejects(f.consume({consume: async () => {consumed++;}}));
    assert.equal(consumed, 0); if (kind === 'bytes' || kind === 'symlink') assert.equal(decodes, 0); await f.unchanged(before);
  });
});

test('unknown child termination pins shared failure and permit until actual close; no unrelated signal cleanup', async t => {
  const closing = deferred(), enteredClose = deferred(), controller = new AbortController(); let attempt, terminated, waited, decodes = 0;
  const f = await fixture(t, {runtime: {
    decode: async (_file, _request, options) => {attempt = options.signal; decodes++; throw Object.assign(Error('PRIVATE child stderr'), {terminationUnconfirmed: true});},
    terminate: async signal => {terminated = signal; return [{status: 'unconfirmed'}];},
    waitForClose: async signal => {waited = signal; enteredClose.resolve(); await closing.promise; return [{status: 'exited'}];},
  }});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.consume({signal: controller.signal}); await enteredClose.promise; controller.abort();
  await assert.rejects(pending, error => error.code === 'MEDIA_TERMINATION_UNCONFIRMED' && !error.message.includes('PRIVATE'));
  await assert.rejects(f.consume(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); assert.equal(decodes, 1); assert.equal(terminated, attempt); assert.equal(waited, attempt);
  const draining = f.audio.drain(), rejected = assert.rejects(draining, {code: 'AUDIO_PREVIEW_STOP_TIMEOUT'});
  t.mock.timers.tick(5001); await rejected; closing.resolve(); await tick(); await tick();
  await assert.rejects(f.audio.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'}); t.mock.timers.reset();
});

test('all source memory/hash admissions are counted before any byte read, even with fewer than twelve tracks', async t => {
  let reads = 0; const f = await fixture(t, {durationFrames: 600, runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}}});
  const base = f.timeline, track = base.tracks.find(track => track.kind === 'audio'), clip = base.clips[0];
  const tracks = Array.from({length: 7}, (_, orderIndex) => ({...track, id: randomUUID(), orderIndex}));
  // Distinct source offsets require distinct PCM allocations despite one asset.
  const clips = tracks.map((track, index) => ({...clip, id: randomUUID(), trackId: track.id, sourceInFrame: index}));
  replace(f, 'timelines', {...base, tracks, clips});
  await assert.rejects(f.plan(), {code: 'AUDIO_PREVIEW_MEMORY_LIMIT'}); assert.equal(reads, 0);
  // One exact source reused across voices has one retained AudioBuffer payload.
  replace(f, 'timelines', {...base, tracks, clips: clips.map(clip => ({...clip, sourceInFrame: 0}))});
  const deduped = await f.plan(); assert.equal(deduped.sources.length, 1); assert.equal(deduped.voices.length, 7); assert.equal(deduped.memory.retainedPcmBytes, 7_680_000);
  replace(f, 'timelines', base); replace(f, 'assets', {...f.asset, sizeBytes: AUDIO_PREVIEW_LIMITS.sourceBytes + 1});
  await assert.rejects(f.plan(), {code: 'AUDIO_PREVIEW_SOURCE_LIMIT'}); assert.equal(reads, 0);
  replace(f, 'assets', {...f.asset, sizeBytes: 300 * 1024 * 1024});
  replace(f, 'timelines', {...base, tracks: tracks.slice(0, 2), clips: clips.slice(0, 2)});
  await assert.rejects(f.plan(), {code: 'AUDIO_PREVIEW_HASH_LIMIT'}); assert.equal(reads, 0);
});

test('restored workspace rejects hostile payload before getters, ownership readers or source effects', async t => {
  const f = await fixture(t); let payload = 0, effects = 0;
  const denied = createTimelineAudioPreviewServices(f.store, {runtime: {...f.runtime,
    assertOrdinaryWorkspace: () => {throw workspaceRestoreError();}, ownsLock: () => {effects++; return true;},
    readSavedTimeline: () => {effects++; return null;}, validateSource: () => {effects++; throw Error('no bytes');}}});
  const hostile = {get projectId() {payload++; throw Error('payload getter');}};
  await assert.rejects(denied.handlers['timeline.audioPreview.plan'](hostile), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  await assert.rejects(denied.consumeSource(hostile, {consume: async () => {effects++;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(payload, 0); assert.equal(effects, 0);
});

test('real restored schema remains zero-write and denies source payload access', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-audio-')); let store = openStore(root);
  store.close(); const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  try {installCurrentWorkspaceRestoreSchema(db, {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()}); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root); let getters = 0, effects = 0;
  const denied = () => {effects++; throw Error('Unexpected effect');};
  const audio = createTimelineAudioPreviewServices(store, {runtime: {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();},
    ownsLock: denied, readSavedTimeline: denied, validateSource: denied, hash: denied, decode: denied,
    terminate: async () => [], waitForClose: async () => [], boundedShutdown}});
  t.after(async () => {await audio.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const beforeFiles = await files(root), writes = store.db.prepare('SELECT total_changes() AS n').get().n;
  const hostile = {get projectId() {getters++; throw Error('must not inspect');}};
  await assert.rejects(audio.handlers['timeline.audioPreview.plan'](hostile), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  await assert.rejects(audio.consumeSource(hostile, {consume: denied}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters, 0); assert.equal(effects, 0); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes); assert.deepEqual(await files(root), beforeFiles);
});
