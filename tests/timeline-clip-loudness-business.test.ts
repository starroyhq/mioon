import type {TypedServices, Failure, SavedAudioSnapshotReader} from './helpers/strict-timeline-audio-types.ts';
import type {TestContext} from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, readdir, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createTimelineClipLoudnessServices} from '../packages/business/src/timeline-clip-loudness.ts';
import {planTimelineClipLoudnessDecode} from '../packages/business/src/timeline-clip-loudness-decoder.ts';
import {readTimelinePreflightSnapshot, readTimelineSourceGraph} from '../packages/business/src/timeline-sources.ts';
import {validateTimeline} from '../packages/business/src/timeline-inputs.ts';
import {validateManagedSource, verifiedManagedHash} from '../packages/business/src/managed-media.ts';
import {boundedShutdown} from '../packages/business/src/operation-lifecycle.ts';
import {workspaceRestoreError, RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {installCurrentWorkspaceRestoreSchema as installWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {exportAudioObservationAdmission} from '../packages/business/src/export-audio-observation.ts';

import type {TimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import type {TimelineClipLoudnessRuntime} from '../packages/business/src/timeline-clip-loudness.ts';
import type {TimelineClipLoudnessSignal} from '../packages/business/src/timeline-clip-loudness-decoder.ts';
import type {TimelineMixLoudnessDecodeOptions} from '../packages/business/src/timeline-mix-loudness-decoder.ts';
import {schemaObjects} from './helpers/project-database.ts';
type RuntimeOverrides = Partial<Omit<TimelineClipLoudnessRuntime, 'decode'>> & {decode?: (...args: Parameters<TimelineClipLoudnessRuntime['decode']>) => unknown};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const deferred = <T = void>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {resolve, promise};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const inputFor = (timeline: TimelineRecord, asset: {sha256: string}) => ({projectId: timeline.projectId, timelineId: timeline.id, expectedRevision: timeline.revision, clipId: timeline.clips[0].id, expectedAssetSha256: asset.sha256, measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'});
function readSaved(store: ReturnType<typeof openStore>, projectId: string) {
  const {db} = store, outer = db.isTransaction;
  if (!outer) db.exec('BEGIN DEFERRED');
  try {
    const {timeline} = (readTimelinePreflightSnapshot as SavedAudioSnapshotReader)(store, projectId);
    if (!timeline) return null;
    const assets = readTimelineSourceGraph(db, projectId, timeline as Parameters<typeof readTimelineSourceGraph>[2]);
    validateTimeline(timeline, assets, {structureOnly: true});
    return {timeline, assets: [...assets.values()]};
  } finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
}
async function fakeDecode(signal: TimelineClipLoudnessSignal, options: TimelineMixLoudnessDecodeOptions, sampleScale = 1, sampleDelta = 0) {
  options.beforeEffect();
  const plan = planTimelineClipLoudnessDecode(signal), frameCount = plan.sampleFrames + sampleDelta;
  // Emit only this saved clip's gain. Reusing the backing block also verifies
  // that target analysis retains its own complete isolated PCM bytes.
  const gain = signal.clip.gain, block = Buffer.alloc(Math.min(frameCount, 8192) * 8);
  for (let begin = 0; begin < frameCount; begin += 8192) {
    const frames = Math.min(8192, frameCount - begin), chunk = block.subarray(0, frames * 8);
    for (let frame = 0; frame < frames; frame++) {
      const value = sampleScale * gain * .1 * Math.sin(2 * Math.PI * 997 * (begin + frame) / 48000);
      chunk.writeFloatLE(value, frame * 8); chunk.writeFloatLE(-value, frame * 8 + 4);
    }
    options.onPcm(chunk);
  }
  return {sampleRate: 48000 as const, channels: 2 as const, ...plan, sampleFrames: frameCount, pcmBytes: frameCount * 8};
}
async function files(root: string) {
  const result: [string, string][] = [];
  for (const item of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!item.isFile() || /^workbench\.sqlite(?:-wal|-shm)?$/.test(item.name) || item.name === 'server.lock') continue;
    const full = path.join(item.parentPath, item.name); result.push([path.relative(root, full), sha(await readFile(full))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: TestContext, name = 'Foreign project') {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-clip-loudness-foreign-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = openStore(root), services = (createServices(store, new Map()) as TypedServices);
  try {return await services.call('project.create', {name});}
  finally {await services.drain(); store.close();}
}
const byName = (a: {name: string}, b: {name: string}) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
async function fixture(t: TestContext, {durationFrames = 60, runtime: overrides = {}}: {durationFrames?: number; runtime?: RuntimeOverrides} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-mix-loudness-')), store = openStore(root), services = (createServices(store, new Map()) as TypedServices);
  const project = await services.call('project.create', {name: 'Owned full timeline loudness'}), foreign = await foreignProject(t, 'Other project');
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const id = randomUUID(), bytes = Buffer.alloc(96 * 1024, 7);
  const asset = {id, projectId: project.id, name: 'Owned sound.wav', mimeType: 'audio/wav', relativePath: `media/${id}.wav`,
    sha256: sha(bytes), sizeBytes: bytes.length, duration: 60, hasAudio: true, hasVideo: false, width: 0, height: 0,
    url: `/media/${id}`, createdAt: new Date().toISOString()};
  await writeFile(path.join(root, asset.relativePath), bytes, {mode: 0o600}); store.put('assets', asset);
  timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
    trackId: timeline.tracks.find(track => track.kind === 'audio')!.id, assetId: id, startFrame: 0, sourceInFrame: 17,
    durationFrames, gain: .75});
  const runtime: TimelineClipLoudnessRuntime = {assertOrdinaryWorkspace: () => {if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();}, ownsLock: () => ownsStoreLock(store),
    readSavedTimeline: (projectId: string) => readSaved(store, projectId), validateSource: validateManagedSource, hash: verifiedManagedHash,
    decode: fakeDecode, terminate: async () => [], waitForClose: async () => [], boundedShutdown, ...overrides} as TimelineClipLoudnessRuntime;
  const mix = createTimelineClipLoudnessServices(store, {runtime}), extras: ReturnType<typeof createTimelineClipLoudnessServices>[] = [];
  t.after(async () => {for (const extra of extras) await extra.drain().catch(() => {}); await mix.drain().catch(() => {});
    await services.drain().catch(() => {}); store.close(); await rm(root, {recursive: true, force: true});});
  const input = inputFor(timeline, asset);
  const rows = () => Object.fromEntries(schemaObjects(store.db).filter(({type}) => type === 'table').sort(byName).map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  return {root, store, services, project, foreign, asset, bytes, timeline, input, mix, runtime, extras,
    call: (value: unknown = input, options?: Parameters<typeof mix.handlers['timeline.clip.loudness']>[1]) => mix.handlers['timeline.clip.loudness'](value, options),
    checkpoint: async () => ({rows: rows(), writes: store.db.prepare('SELECT total_changes() AS n').get()!.n, files: await files(root)}),
    unchanged: async (before: {rows: ReturnType<typeof rows>; writes: unknown; files: [string, string][]}) => {assert.deepEqual(rows(), before.rows); assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, before.writes); assert.deepEqual(await files(root), before.files);}};
}
const replace = (f: {store: ReturnType<typeof openStore>}, table: string, value: {id: string; [key: string]: unknown}) => f.store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);


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
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_UNAVAILABLE'}); await f.unchanged(before); assert.equal(reads, 0);
});

test('same-revision metadata, source bytes, ownership and revision drift discard the observation', async t => {
  for (const phase of ['metadata', 'revision', 'bytes', 'foreign', 'lock']) await t.test(phase, async t => {
    let f!: Awaited<ReturnType<typeof fixture>>; f = await fixture(t, {runtime: {decode: async (signal, options) => {
      const result = await fakeDecode(signal, options);
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
  const copy = createTimelineClipLoudnessServices({...f.store}, {runtime: f.runtime}); f.extras.push(copy);
  const pending = f.call(f.input, {signal: controller.signal}); await entered.promise;
  assert.ok(exportAudioObservationAdmission(f.store.db).active);
  await assert.rejects(copy.handlers['timeline.clip.loudness'](f.input), {code: 'TIMELINE_CLIP_LOUDNESS_BUSY'});
  controller.abort(); await assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
  await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); assert.equal(exportAudioObservationAdmission(f.store.db).active, null);
});

test('late timeout results cannot decode or publish and a live permit remains held', async t => {
  const entered = deferred(), gate = deferred(); let decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {entered.resolve(); await gate.promise; return verifiedManagedHash(...args);}, decode: () => {decodes++;}}});
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = f.call(); await entered.promise; t.mock.timers.tick(120001);
  await assert.rejects(pending, {code: 'TIMELINE_CLIP_LOUDNESS_TIMEOUT'}); await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_BUSY'});
  gate.resolve(); await tick(); await tick(); assert.equal(decodes, 0); t.mock.timers.reset();
});

test('unconfirmed exact child cleanup keeps shared admission sticky even after late close', async t => {
  const entered = deferred(), close = deferred(), controller = new AbortController(); let terminationSignal: AbortSignal | undefined, closeSignal: AbortSignal | undefined;
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
  assert.ok(RESTORE_DENIED_OPERATIONS.includes('timeline.clip.loudness'));
  const restored = createTimelineClipLoudnessServices({...f.store}, {runtime: {...f.runtime, assertOrdinaryWorkspace() {throw workspaceRestoreError();}}}); f.extras.push(restored);
  await assert.rejects(restored.handlers['timeline.clip.loudness']({get projectId() {getters++; return f.project.id;}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(getters, 0);
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-restored-mix-loudness-')); let store = openStore(root), services = (createServices(store, new Map()) as TypedServices);
  await services.call('project.create', {name: 'Restore fixture'}); await services.drain(); store.close();
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
  try {installWorkspaceRestoreSchema(db, {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
    manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()}); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  store = openStore(root); services = (createServices(store, new Map()) as TypedServices);
  t.after(async () => {await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  const hostile = {get projectId() {getters++; throw Error('no payload');}};
  for (const value of [hostile, f.input, null]) {
    await assert.rejects(services.call('timeline.clip.loudness', value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
    await assert.rejects((services.handlers['timeline.clip.loudness'] as (input: unknown) => Promise<unknown>)(value), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  }
  assert.equal(getters, 0);
});

test('a second source hash failure discards the measured clip', async t => {
  let hashes = 0, decodes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {
    const result = await verifiedManagedHash(...args); return ++hashes === 2 ? {...result, sha256: 'c'.repeat(64)} : result;
  }, decode: (...args) => {decodes++; return fakeDecode(...args);}}});
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_STALE'});
  assert.equal(decodes, 1); assert.equal(hashes, 2); await f.unchanged(before);
});

test('decoder stderr, private paths and unrecognized code strings never enter safe public failures', async t => {
  for (const code of ['FFMPEG_ERROR', 'TIMELINE_CLIP_LOUDNESS_/private/source.wav']) await t.test(code, async t => {
    const f = await fixture(t, {runtime: {decode: async () => {throw Object.assign(Error('/private/source.wav token-secret decoder stderr'), {code});}}});
    await assert.rejects(f.call(), error => {
      assert.equal((error as Failure).code, 'TIMELINE_CLIP_LOUDNESS_DECODE_FAILED');
      assert.ok(!JSON.stringify(error).includes('/private/') && !(error as Failure).message.includes('token-secret')); return true;
    });
  });
});

test('one selected saved signal is double-hashed, bound and measured without any durable effects', async t => {
  const calls: TimelineClipLoudnessSignal[] = []; let hashes = 0;
  const f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);},
    decode: (signal, options) => {calls.push(signal); return fakeDecode(signal, options);}}});
  const before = await f.checkpoint(), report = await f.call();
  assert.equal(calls.length, 1); assert.equal(hashes, 2); assert.equal(report.measurement.sampleFrames, 96000);
  assert.equal(report.stage, 'isolated_clip_post_gain_fades_pre_mix'); assert.equal(report.applyAllowed, false);
  assert.equal(report.clipId, f.timeline.clips[0].id); assert.equal(report.timelineId, f.timeline.id);
  assert.equal(report.identity.gain, .75); assert.equal(report.identity.sourceInFrame, 17);
  assert.equal(report.identity.assetSha256, f.asset.sha256); assert.equal(report.checks.segmentCount, 1);
  assert.ok(Object.isFrozen(report)); assert.ok(!JSON.stringify(report).includes(f.root));
  assert.ok(!Object.hasOwn(report, 'candidate')); assert.ok(!Object.hasOwn(report, 'target')); await f.unchanged(before);
});

test('an explicit target measures a complete owned candidate with one decode and no durable effects', async t => {
  let hashes = 0, decodes = 0;
  const f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);},
    decode: (...args) => {decodes++; return fakeDecode(...args);}}});
  const before = await f.checkpoint(), target = {integratedLufs: -24, truePeakCeilingDbtp: -1};
  const report = await f.call({...f.input, target});
  assert.deepEqual(report.target, target); assert.equal(report.candidate!.status, 'measured');
  assert.equal(report.candidate!.meetsTarget, true); assert.equal(report.candidate!.meetsTruePeak, true);
  assert.equal(report.candidate!.beforeGain, .75); assert.equal(report.candidate!.afterGain, .75 * report.candidate!.gainMultiplier!);
  assert.equal(report.candidate!.measuredPcmBytes, 768000); assert.equal(report.candidate!.measurement!.sampleFrames, 96000);
  assert.ok(Math.abs(report.candidate!.measurement!.integratedLufs! + 24) < .1);
  assert.equal(report.candidate!.applyAllowed, false); assert.equal(report.applyAllowed, false);
  assert.equal(report.checks.passes, 1); assert.equal(report.checks.pcmBytes, 768000);
  assert.equal(decodes, 1); assert.equal(hashes, 2); assert.ok(Object.isFrozen(report.candidate));
  await f.unchanged(before);
});

test('unreachable target gain is reported without clamping, target substitution or write', async t => {
  const f = await fixture(t), before = await f.checkpoint(), target = {integratedLufs: -5, truePeakCeilingDbtp: -1};
  const report = await f.call({...f.input, target});
  assert.deepEqual(report.target, target); assert.equal(report.candidate!.status, 'unavailable');
  assert.equal(report.candidate!.reason, 'GAIN_OUT_OF_RANGE'); assert.equal(report.candidate!.afterGain, null);
  assert.ok(report.candidate!.gainMultiplier! * report.identity.gain > 2);
  assert.equal(report.candidate!.measurement, null); assert.equal(report.candidate!.measuredPcmBytes, 0);
  await f.unchanged(before);
});

test('second source hash still fences a completed target candidate', async t => {
  let hashes = 0;
  const f = await fixture(t, {runtime: {hash: async (...args) => {
    const result = await verifiedManagedHash(...args); return ++hashes === 2 ? {...result, sha256: 'c'.repeat(64)} : result;
  }}});
  const before = await f.checkpoint();
  await assert.rejects(f.call({...f.input, target: {integratedLufs: -24, truePeakCeilingDbtp: -1}}), {code: 'TIMELINE_CLIP_LOUDNESS_STALE'});
  assert.equal(hashes, 2); await f.unchanged(before);
});

test('cancellation and revision change during candidate replay discard it before the final hash', async t => {
  for (const mode of ['cancel', 'revision']) await t.test(mode, async t => {
    const controller = new AbortController(); let f!: Awaited<ReturnType<typeof fixture>>, hashes = 0;
    f = await fixture(t, {runtime: {hash: (...args) => {hashes++; return verifiedManagedHash(...args);}, decode: async (...args) => {
      const result = await fakeDecode(...args);
      setImmediate(() => {if (mode === 'cancel') controller.abort();
        else replace(f, 'timelines', {...f.timeline, revision: f.timeline.revision + 1});});
      return result;
    }}});
    const before = await f.checkpoint();
    await assert.rejects(f.call({...f.input, target: {integratedLufs: -24, truePeakCeilingDbtp: -1}}, {signal: controller.signal}),
      {code: mode === 'cancel' ? 'OPERATION_CANCELLED' : 'TIMELINE_CLIP_LOUDNESS_REVISION_CONFLICT'});
    await tick(); await tick(); assert.equal(hashes, 1);
    if (mode === 'cancel') await f.unchanged(before);
  });
});
test('wrong selection, source hash, timeline identity and extra authority refuse before media', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: () => {reads++; throw Error('No read');}}});
  for (const extra of [{clipId: randomUUID()}, {timelineId: randomUUID()}, {projectId: f.foreign.id},
    {expectedAssetSha256: 'c'.repeat(64)}, {expectedRevision: f.timeline.revision + 1}, {target: {}},
    {candidate: {}}, {applyAllowed: true}, {requestId: randomUUID()}, {path: '/private'}, {filter: 'volume=2'},
    {gain: 2}, {measurementProfile: 'other'}]) await assert.rejects(f.call({...f.input, ...extra}));
  assert.equal(reads, 0);
});
test('muted and zero gain selections are explicit rejections, never source-only substitutes', async t => {
  const f = await fixture(t);
  for (const [mode, code] of [['muted', 'TIMELINE_CLIP_LOUDNESS_MUTED'], ['gain', 'TIMELINE_CLIP_LOUDNESS_ZERO_GAIN']]) {
    const value = mode === 'muted' ? {...f.timeline, tracks: f.timeline.tracks.map(track => ({...track, muted: true}))}
      : {...f.timeline, clips: f.timeline.clips.map(clip => ({...clip, gain: 0}))};
    replace(f, 'timelines', value); const before = await f.checkpoint();
    await assert.rejects(f.call(), {code}); await f.unchanged(before);
  }
});
test('unrelated edges and overlapping tracks change snapshot identity but not selected signal or measurement', async t => {
  const signals: TimelineClipLoudnessSignal[] = []; const f = await fixture(t, {runtime: {decode: (signal, options) => {signals.push(signal); return fakeDecode(signal, options);}}});
  const before = await f.call(), extraTrack = {...f.timeline.tracks.find(track => track.kind === 'audio'), id: randomUUID(), orderIndex: 2};
  replace(f, 'timelines', {...f.timeline, tracks: [...f.timeline.tracks, extraTrack],
    clips: [...f.timeline.clips, {...f.timeline.clips[0], id: randomUUID(), trackId: extraTrack.id, startFrame: 7, durationFrames: 5, gain: 2}]});
  const after = await f.call();
  assert.notEqual(before.identity.snapshotSha256, after.identity.snapshotSha256);
  assert.deepEqual(before.measurement, after.measurement); assert.deepEqual(before.checks, after.checks);
  assert.deepEqual(signals[0], signals[1]);
});
test('selected exact sample count rejects one missing or extra sample frame', async t => {
  for (const delta of [-1, 1]) await t.test(String(delta), async t => {
    const f = await fixture(t, {runtime: {decode: (signal, options) => fakeDecode(signal, options, 1, delta)}});
    await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_INVALID_PCM'});
  });
});
test('source resource admission refuses over 512 MiB before file access', async t => {
  let reads = 0; const f = await fixture(t, {runtime: {validateSource: () => {reads++; throw Error('No read');}}});
  replace(f, 'assets', {...f.asset, sizeBytes: 512 * 1024 * 1024 + 1});
  await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_SOURCE_LIMIT'}); assert.equal(reads, 0);
});

test('complete clip longer than 1800 frames is explicitly refused before hash, file or process work, never auto-trimmed', async t => {
  let reads = 0, decodes = 0, hashes = 0;
  const f = await fixture(t, {runtime: {validateSource: () => {reads++; throw Error('No read');},
    hash: () => {hashes++; throw Error('No hash');}, decode: () => {decodes++; throw Error('No process');}}});
  replace(f, 'assets', {...f.asset, duration: 600});
  replace(f, 'timelines', {...f.timeline, durationFrames: 1801, clips: f.timeline.clips.map(clip => ({...clip, durationFrames: 1801}))});
  const before = await f.checkpoint(); await assert.rejects(f.call(), {code: 'TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT'});
  assert.equal(reads, 0); assert.equal(hashes, 0); assert.equal(decodes, 0); await f.unchanged(before);
});
