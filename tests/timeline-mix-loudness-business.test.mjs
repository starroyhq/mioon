import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createTimelineMixLoudnessServices} from '../packages/business/src/timeline-mix-loudness.ts';
import {planTimelineMixLoudnessDecode} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {readTimelinePreflightSnapshot, readTimelineSourceGraph} from '../packages/business/src/timeline-sources.mjs';
import {validateTimeline} from '../packages/business/src/timeline-inputs.mjs';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.mjs';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.mjs';
import {workspaceRestoreError, RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.mjs';
import {installCurrentWorkspaceRestoreSchema as installWorkspaceRestoreSchema} from '../packages/business/src/db.mjs';
import {exportAudioObservationAdmission} from '../packages/business/src/export-audio-observation.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {resolve, promise};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const inputFor = timeline => ({projectId: timeline.projectId, expectedRevision: timeline.revision,
  mixProfile: 'timeline-float-mix-v1', measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1',
  target: {integratedLufs: -30, truePeakCeilingDbtp: -1}});
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
async function fakeDecode(timeline, assets, options, sampleScale = 1, sampleDelta = 0) {
  options.beforeEffect();
  const plan = planTimelineMixLoudnessDecode(timeline, assets), frameCount = plan.sampleFrames + sampleDelta;
  // Use the actual per-clip gain on each pass. The service must never multiply
  // previously mixed PCM instead of invoking this independent candidate pass.
  const gain = timeline.clips[0].gain, block = Buffer.alloc(Math.min(frameCount, 8192) * 8);
  for (let begin = 0; begin < frameCount; begin += 8192) {
    const frames = Math.min(8192, frameCount - begin), chunk = block.subarray(0, frames * 8);
    for (let frame = 0; frame < frames; frame++) {
      const value = sampleScale * gain * .1 * Math.sin(2 * Math.PI * 997 * (begin + frame) / 48000);
      chunk.writeFloatLE(value, frame * 8); chunk.writeFloatLE(-value, frame * 8 + 4);
    }
    options.onPcm(chunk);
  }
  return {sampleRate: 48000, channels: 2, ...plan, sampleFrames: frameCount, pcmBytes: frameCount * 8};
}
async function files(root) {
  const result = [];
  for (const item of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!item.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(item.name) || item.name === 'server.lock') continue;
    const full = path.join(item.parentPath, item.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
async function fixture(t, {durationFrames = 60, runtime: overrides = {}} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-')), store = openStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Owned full timeline loudness'}), foreign = await services.call('project.create', {name: 'Other project'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const id = randomUUID(), bytes = Buffer.alloc(96 * 1024, 7);
  const asset = {id, projectId: project.id, name: 'Owned sound.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
    sha256: sha(bytes), sizeBytes: bytes.length, duration: 60, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio').id, assetId: id, startFrame: 0, sourceInFrame: 17,
    durationFrames, gain: .75});
  const runtime = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    readSavedTimeline: projectId => readSaved(store, projectId), validateSource: validateManagedSource, hash: verifiedManagedHash,
    decode: fakeDecode, terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides};
  const mix = createTimelineMixLoudnessServices(store, {runtime}), extras = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await mix.drain().catch(() => {});
    await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = inputFor(timeline);
  const rows = () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {root, store, services, project, foreign, asset, bytes, timeline, input, mix, runtime, extras,
    call: (value = input, options) => mix.handlers['timeline.loudness.prepare'](value, options),
    checkpoint: async () => ({rows: rows(), writes: store.db.prepare('SELECT total_changes() AS n').get().n, files: await files(root)}),
    unchanged: async before => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before.writes); assert.deepEqual(await files(root), before.files);}};
}
const replace = (f, table, value) => f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);

test('full saved original and separately rendered candidate are byte-pinned and have no durable effects', async t => {
  const requests = []; let hashes = 0;
  const f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);},
    decode: (timeline, assets, options) => {requests.push(timeline); return fakeDecode(timeline, assets, options);}}});
  const before = await f.checkpoint(), result = await f.call();
  assert.equal(requests.length, 2); assert.equal(requests[0].clips[0].gain, .75); assert.notEqual(requests[1].clips[0].gain, .75);
  assert.equal(result.stage, 'preencode_float_mix'); assert.equal(result.applyAllowed, false); assert.equal(hashes, 2);
  assert.equal(result.original.sampleFrames, 96000); assert.equal(result.candidate.measurement.sampleFrames, 96000);
  assert.ok(Math.abs(result.candidate.measurement.integratedLufs - f.input.target.integratedLufs) < .1);
  assert.ok(Object.isFrozen(result)); assert.ok(!JSON.stringify(result).includes(f.root) && !JSON.stringify(result).includes(f.asset.relativePath));
  assert.ok(!JSON.stringify(result).includes('candidateId')); await f.unchanged(before);
});

test('strict target and fixed profiles reject arbitrary execution fields before any source read', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}}});
  for (const extra of [{path: '/private/file'}, {filter: 'volume=9'}, {gain: 2}, {timeoutMs: 1}, {exportRange: {startFrame: 0, endFrame: 1}},
    {mixProfile: 'mp4_h264_v1'}, {measurementProfile: 'other'}, {target: undefined}, {target: {integratedLufs: -4, truePeakCeilingDbtp: -1}},
    {target: {integratedLufs: -30, truePeakCeilingDbtp: 1}}]) await assert.rejects(f.call({...f.input, ...extra}), {code: 'VALIDATION_ERROR'});
  const {target, ...withoutTarget} = f.input; await assert.rejects(f.call(withoutTarget), {code: 'VALIDATION_ERROR'});
  let getters = 0; await assert.rejects(f.call({get projectId() {getters++; return f.project.id;}}), {code: 'VALIDATION_ERROR'});
  assert.equal(getters, 0); assert.equal(reads, 0);
});

test('invalid original LUFS and out-of-range group gains skip candidate render without clipping', async t => {
  for (const mode of ['silence', 'too_short', 'gain_limit']) await t.test(mode, async t => {
    let decodes = 0; const f = await fixture(t, {durationFrames: mode === 'too_short' ? 1 : 60, runtime: {
      decode: (timeline, assets, options) => {decodes++; return fakeDecode(timeline, assets, options, mode === 'silence' ? 0 : 1);}}});
    const result = await f.call(mode === 'gain_limit' ? {...f.input, target: {...f.input.target, integratedLufs: -5}} : f.input);
    assert.equal(decodes, 1); assert.equal(result.candidate.status, 'unavailable'); assert.equal(result.applyAllowed, false);
  });
});

test('exact full-mix sample frame count rejects even one frame accepted by AAC tolerance', async t => {
  for (const delta of [-1, 1]) await t.test(String(delta), async t => {
    const f = await fixture(t, {runtime: {decode: (timeline, assets, options) => fakeDecode(timeline, assets, options, 1, delta)}});
    await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_INVALID_PCM'});
  });
});

test('missing or corrupt owned timeline graph never initializes or reaches media', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);}}});
  for (const change of [
    () => f.store.db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify({...f.timeline, id: randomUUID()}), f.timeline.id),
    () => replace(f, 'timelines', {...f.timeline, projectId: f.foreign.id}),
    () => replace(f, 'timelines', {...f.timeline, clips: [...f.timeline.clips, f.timeline.clips[0]]}),
    () => replace(f, 'timelines', {...f.timeline, clips: f.timeline.clips.map(clip => ({...clip, speed: 2}))}),
    () => replace(f, 'assets', {...f.asset, projectId: f.foreign.id}),
    () => replace(f, 'assets', {...f.asset, sha256: 'broken'}),
  ]) {
    change(); const before = await f.checkpoint(); await assert.rejects(f.call()); await f.unchanged(before);
    replace(f, 'timelines', f.timeline); replace(f, 'assets', f.asset);
  }
  f.store.db.prepare('DELETE FROM timelines WHERE id=?').run(f.timeline.id);
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_UNAVAILABLE'}); await f.unchanged(before); assert.equal(reads, 0);
});

test('same-revision metadata, source bytes, ownership and revision drift discard both observations', async t => {
  for (const phase of ['metadata', 'revision', 'bytes', 'foreign', 'lock']) await t.test(phase, async t => {
    let f; f = await fixture(t, {runtime: {decode: async (timeline, assets, options) => {
      const result = await fakeDecode(timeline, assets, options);
      if (phase === 'metadata') replace(f, 'assets', {...f.asset, name: 'Changed same revision'});
      if (phase === 'revision') replace(f, 'timelines', {...f.timeline, revision: f.timeline.revision + 1});
      if (phase === 'bytes') await writeFile(path.join(f.root, f.asset.relativePath), Buffer.alloc(f.bytes.length, 8));
      if (phase === 'foreign') replace(f, 'assets', {...f.asset, projectId: f.foreign.id});
      if (phase === 'lock') await unlink(path.join(f.root, 'server.lock'));
      return result;
    }}});
    await assert.rejects(f.call());
  });
});

test('native-db audio observation admission is shared and retains noncooperative reads through cancellation', async t => {
  const entered = deferred(), gate = deferred(), controller = new AbortController(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);},
    decode: (...args) => {decodes++; return fakeDecode(...args);}}});
  const copy = createTimelineMixLoudnessServices({...f.store}, {runtime: f.runtime}); f.extras.push(copy);
  const pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  assert.ok(exportAudioObservationAdmission(f.store.db).active);
  await assert.rejects(copy.handlers['timeline.loudness.prepare'](f.input), {code: 'TIMELINE_MIX_LOUDNESS_BUSY'});
  controller.abort(); await assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); assert.equal(exportAudioObservationAdmission(f.store.db).active, null);
});

test('late timeout results cannot decode or publish and a live permit remains held', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: () => {decodes++;}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.call(); await entered.promise; t.mock.timers.tick(120001);
  await assert.rejects(pending, {code: 'TIMELINE_MIX_LOUDNESS_TIMEOUT'}); await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('unconfirmed exact child cleanup keeps shared admission sticky even after late close', async t => {
  const entered = deferred(), close = deferred(), controller = new AbortController(); let terminationSignal, closeSignal;
  const f = await fixture(t, {runtime: {terminate: async signal => {terminationSignal = signal; return [{status: 'unconfirmed'}];},
    waitForClose: async signal => {closeSignal = signal; entered.resolve(); await close.promise; return [{status: 'exited'}];}}});
  const pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  assert.equal(terminationSignal, closeSignal); assert.notEqual(terminationSignal, controller.signal);
  controller.abort(); await assert.rejects(pending, {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
  assert.ok(exportAudioObservationAdmission(f.store.db).active); await assert.rejects(f.call(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
  close.resolve(); await tick(); await tick(); await assert.rejects(f.mix.drain(), {code: 'MEDIA_TERMINATION_UNCONFIRMED'});
});

test('restored direct and composed boundaries refuse before any payload getters or media', async t => {
  const f = await fixture(t); let getters = 0;
  assert.ok(RESTORE_DENIED_OPERATIONS.includes('timeline.loudness.prepare'));
  const restored = createTimelineMixLoudnessServices({...f.store}, {runtime: {...f.runtime, assertOrdinaryWorkspace() {throw workspaceRestoreError();}}}); f.extras.push(restored);
  await assert.rejects(restored.handlers['timeline.loudness.prepare']({get projectId() {getters++; return f.project.id;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters, 0);
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-mix-loudness-')); let store = openStore(root), services = createServices(store, new Map());
  await services.call('project.create', {name: 'Restore fixture'}); await services.drain(); store.close();
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  try {installWorkspaceRestoreSchema(db, {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()}); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root); services = createServices(store, new Map());
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const hostile = {get projectId() {getters++; throw Error('no payload');}};
  for (const value of [hostile, f.input, null]) {
    await assert.rejects(services.call('timeline.loudness.prepare', value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
    await assert.rejects(services.handlers['timeline.loudness.prepare'](value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(getters, 0);
});

test('source and scheduled two-pass work budgets reject before file or child work', async t => {
  for (const mode of ['source_bytes', 'decode_work']) await t.test(mode, async t => {
    let reads = 0, decodes = 0;
    const f = await fixture(t, {runtime: {validateSource: (...args) => {reads++; return validateManagedSource(...args);},
      decode: (...args) => {decodes++; return fakeDecode(...args);}}});
    if (mode === 'source_bytes') replace(f, 'assets', {...f.asset, sizeBytes: 512 * 1024 * 1024 + 1});
    else {
      const extraTrack = {...f.timeline.tracks.find(track => track.kind === 'audio'), id: randomUUID(), orderIndex: 2};
      const clip = {...f.timeline.clips[0], sourceInFrame: 0, durationFrames: 18000};
      replace(f, 'assets', {...f.asset, duration: 600});
      replace(f, 'timelines', {...f.timeline, durationFrames: 18000, tracks: [...f.timeline.tracks, extraTrack],
        clips: [clip, {...clip, id: randomUUID(), trackId: extraTrack.id}]});
    }
    const before = await f.checkpoint(); await assert.rejects(f.call()); assert.equal(reads, 0); assert.equal(decodes, 0); await f.unchanged(before);
  });
});

test('a second source hash failure discards measured original and candidate', async t => {
  let hashes = 0, decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {
    const result = await verifiedManagedHash(...args); return ++hashes === 2 ? {...result, sha256: 'c'.repeat(64)} : result;
  }, decode: (...args) => {decodes++; return fakeDecode(...args);}}});
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_STALE'});
  assert.equal(decodes, 2); assert.equal(hashes, 2); await f.unchanged(before);
});

test('candidate uses audible clips only, preserving hidden video while excluding muted and zero gain', async t => {
  const requests = []; const f = await fixture(t, {runtime: {decode: (timeline, assets, options) => {
    requests.push(timeline); return fakeDecode(timeline, assets, options);
  }}});
  const videoTrack = f.timeline.tracks.find(track => track.kind === 'video'), audioTrack = f.timeline.tracks.find(track => track.kind === 'audio');
  const embeddedId = randomUUID(), embedded = {...f.asset, id: embeddedId, relativePath: `media/${embeddedId}.mp4`, mimeType: 'video/mp4', hasVideo: true};
  await writeFile(path.join(f.root, embedded.relativePath), f.bytes); f.store.put('assets', embedded);
  const hiddenClip = {...f.timeline.clips[0], id: randomUUID(), trackId: videoTrack.id, assetId: embeddedId, gain: .5};
  const zeroClip = {...f.timeline.clips[0], id: randomUUID(), startFrame: 60, gain: 0};
  const mutedTrack = {...audioTrack, id: randomUUID(), orderIndex: 2, muted: true};
  const mutedClip = {...f.timeline.clips[0], id: randomUUID(), trackId: mutedTrack.id, gain: 1.25};
  replace(f, 'timelines', {...f.timeline, durationFrames: 120,
    tracks: f.timeline.tracks.map(track => track.id === videoTrack.id ? {...track, hidden: true} : track).concat(mutedTrack),
    clips: [...f.timeline.clips, hiddenClip, zeroClip, mutedClip]});
  const result = await f.call(); assert.equal(result.candidate.status, 'measured');
  assert.deepEqual(new Set(result.candidate.gains.map(item => item.clipId)), new Set([f.timeline.clips[0].id, hiddenClip.id]));
  assert.equal(requests[1].clips.find(clip => clip.id === zeroClip.id).gain, 0);
  assert.equal(requests[1].clips.find(clip => clip.id === mutedClip.id).gain, 1.25);
  assert.notEqual(requests[1].clips.find(clip => clip.id === hiddenClip.id).gain, .5);
});

test('decoder stderr, private paths and unrecognized code strings never enter safe public failures', async t => {
  for (const code of ['FFMPEG_ERROR', 'TIMELINE_MIX_LOUDNESS_/private/source.wav']) await t.test(code, async t => {
    const f = await fixture(t, {runtime: {decode: async () => {throw Object.assign(Error('/private/source.wav token-secret decoder stderr'), {code});}}});
    await assert.rejects(f.call(), error => {
      assert.equal(error.code, 'TIMELINE_MIX_LOUDNESS_DECODE_FAILED');
      assert.ok(!JSON.stringify(error).includes('/private/') && !error.message.includes('token-secret')); return true;
    });
  });
});

test('potentially audible video with saved false audio metadata is still pinned and hashed before the decoder verifies presence', async t => {
  let f, hashes = 0, calls = 0, observedFile;
  f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);},
    decode: async (timeline, assets, options) => {
      calls++; options.beforeEffect(); observedFile = assets.get(f.asset.id).file;
      assert.equal(observedFile, path.join(f.root, f.asset.relativePath));
      assert.equal(assets.get(f.asset.id).hasAudio, false);
      assert.equal(hashes, 1, 'The real byte hash precedes any audio-presence probe.');
      throw Object.assign(Error('Actual probe found audio on saved silent video'), {code: 'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
    }}});
  const video = f.timeline.tracks.find(track => track.kind === 'video');
  replace(f, 'assets', {...f.asset, mimeType: 'video/mp4', hasAudio: false, hasVideo: true});
  replace(f, 'timelines', {...f.timeline, clips: f.timeline.clips.map(clip => ({...clip, trackId: video.id}))});
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  assert.equal(calls, 1); assert.equal(hashes, 1); assert.ok(observedFile); await f.unchanged(before);
});
