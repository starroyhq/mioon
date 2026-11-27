import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {registerProjectMediaStore, referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {createProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import {createProcessingScheduler} from '../packages/business/src/timeline-processing/scheduler.ts';
import {createTimelineProcessingService} from '../packages/business/src/timeline-processing/service.ts';
import type {ProcessingServiceOptions} from '../packages/business/src/timeline-processing/service.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import type {Format5Clip, Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {processingCacheReceiptSchema, processingResultSchema} from '../packages/contracts/src/timeline-processing-storage.ts';
import {timeMapPlanInfo} from '../packages/contracts/src/timeline-time-map.ts';
import {compileClipTimeMap} from '../packages/contracts/src/timeline-clip-timing.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import type {SpeedInterpolation} from '../packages/contracts/src/timeline-speed.ts';
import {ProcessingFailure} from '../packages/business/src/timeline-processing/cache.ts';
import {timelineProcessingResponseSchemas} from '../packages/contracts/src/timeline-processing.ts';
import {REVERSE_PROXY_COVERAGE_VERSION} from '../packages/business/src/timeline-processing/reverse-profile.ts';
import {TIMELINE_PREVIEW_CACHE_PROFILE} from '../packages/business/src/timeline-processing/preview-port.ts';
import type {PreviewProcessingRenderer} from '../packages/business/src/timeline-processing/preview-port.ts';
import {reversePictureCoverage} from '../packages/business/src/timeline-processing/picture-coverage.ts';

const at = '2026-01-01T00:00:00.000Z';
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const noEffect = () => {};
function silentWave(): Buffer {
  const rate = 48000, sampleBytes = rate * 2 * 2;
  const bytes = Buffer.alloc(44 + sampleBytes);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(sampleBytes, 40);
  return bytes;
}
const fakeEngine: NonNullable<ProcessingServiceOptions['engine']> = {
  prepare: async () => ({profile: {id: 'timeline-reverse-source-v1', buildSha256: sha('test build'), storage: 'matroska', video: null,
    coverageVersion: REVERSE_PROXY_COVERAGE_VERSION,
    audio: {index: 0, codec: 'pcm_s16le', rate: 48000, channels: 1, layout: 'mono', firstMediaSample: 0}}, reservationBytes: 65536}),
  render: async (input, _prepared, {stagingDirectory, signal, beforeEffect}) => {
    signal?.throwIfAborted();
    beforeEffect();
    const files = [['proxy.mkv', 'fixture audio'], ['clock.json', '{}']].map(([fileName, bytes]) => {
      writeFileSync(path.join(stagingDirectory, fileName!), bytes!, {mode: 0o600, flag: 'wx'});
      return {fileName: fileName!, bytes: Buffer.byteLength(bytes!), sha256: sha(bytes!)};
    });
    return {profileId: 'timeline-reverse-source-v1', mapHash: input.mapHash, files, frameCount: 0, sampleCount: 48000};
  },
};

const fakePreview: PreviewProcessingRenderer = {
  async prepare(input) {
    const plan = timeMapPlanInfo(input.plan);
    assert.ok(plan.ok);
    return {profile: {profileId: TIMELINE_PREVIEW_CACHE_PROFILE, mapHash: plan.value.mapHash, sourceSha256: input.sourceSha256,
      sourceStream: '0:v:0', buildSha256: sha('preview build'), width: 24, height: 24, fps: 30, effectiveInterpolation: 'off'},
    reservationBytes: 65536};
  },
  async render(input, prepared, {stagingDirectory, beforeEffect}) {
    beforeEffect();
    const frameCount = input.plan.durationFrames;
    const payloads = {'preview.mp4': 'preview fixture', 'clock.json': JSON.stringify({...prepared.profile, frameCount})};
    const files = Object.entries(payloads).map(([fileName, contents]) => {
      writeFileSync(path.join(stagingDirectory, fileName), contents, {mode: 0o600, flag: 'wx'});
      return {fileName, bytes: Buffer.byteLength(contents), sha256: sha(contents)};
    });
    return {profileId: prepared.profile.profileId, mapHash: prepared.profile.mapHash, files, frameCount, sampleCount: 0};
  },
};

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let tries = 0; tries < 200; tries++) {
    const value = read(); if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error('Timed out reading processing state');
}

async function fixture(t: test.TestContext, options: {enabled?: boolean; format?: 5 | 6;
  engine?: ProcessingServiceOptions['engine'] | 'real'; scheduler?: ProcessingServiceOptions['scheduler'];
  cache?: Parameters<typeof createProcessingCache>[1]; video?: boolean; previewRenderer?: PreviewProcessingRenderer} = {}) {
  const parent = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-processing-lifecycle-'));
  const projectId = randomUUID(), projectFile = path.join(parent, 'project.mioon');
  const locate = () => ({localDir: path.join(parent, 'local'), cacheDir: path.join(parent, 'cache'), tempDir: path.join(parent, 'tmp')});
  const opening = {projectFile, locate, allowFormat6: true as const};
  let store = createProjectStore({...opening, projectId, targetFormat: options.format ?? FORMAT6_PROJECT_SCHEMA_VERSION});
  let unregister = registerProjectMediaStore(store);
  const cacheRoot = path.join(parent, 'global-cache');
  const scheduler = options.scheduler ?? createProcessingScheduler();
  let previewRenderer = options.previewRenderer;
  const createService = () => createTimelineProcessingService(store, {
    enabled: options.enabled ?? true, scheduler, cache: createProcessingCache(cacheRoot, options.cache), beforeEffect: noEffect,
    ...(previewRenderer ? {previewRenderer} : {}),
    ...(options.engine === 'real' ? {} : {engine: options.engine ?? fakeEngine}),
  });
  let processing = createService();
  async function reopen(renderer = previewRenderer) {
    await processing.close(); unregister(); store.close();
    store = openProjectStore(opening);
    unregister = registerProjectMediaStore(store);
    previewRenderer = renderer;
    processing = createService(); processing.activate();
  }
  t.after(async () => {await processing.close(); unregister(); store.close(); rmSync(parent, {recursive: true, force: true});});
  const assetId = randomUUID(), mainTrackId = randomUUID(), rootId = randomUUID();
  const secondaryTrack = {id: randomUUID(), name: options.video ? 'V2' : 'A1',
    kind: options.video ? 'video' as const : 'audio' as const, orderIndex: 1, hidden: false, muted: false};
  const media = path.join(parent, 'media'); mkdirSync(media, {mode: 0o700});
  const file = path.join(media, options.video ? 'processing-source.mp4' : 'processing-source.wav');
  if (options.video) {
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30',
      '-frames:v', '60', '-c:v', 'libx264', '-threads:v', '1', '-pix_fmt', 'yuv420p', '-n', file], {timeout: 30_000});
  } else writeFileSync(file, silentWave(), {mode: 0o600});
  const source = await referenceForPublishedMedia(store, file);
  const initialClip: Format5Clip = {id: randomUUID(), trackId: secondaryTrack.id,
    name: options.video ? 'Picture' : 'Audio', startFrame: 0, durationFrames: 30,
    sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId, sourceState: 'ready', anchor: null};
  const timeline: Format5Timeline = {id: randomUUID(), projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 30, createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
    tracks: [{id: mainTrackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}, secondaryTrack], clips: [initialClip]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Processing lifecycle', createdAt: at, updatedAt: at, revision: 1});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Timeline', position: {x: 0, y: 0}, createdAt: at});
    store.put('assets', {id: assetId, projectId, name: path.basename(file),
      mimeType: options.video ? 'video/mp4' : 'audio/wav', duration: 2, hasAudio: !options.video, hasVideo: options.video ?? false,
      width: options.video ? 64 : null, height: options.video ? 64 : null, createdAt: at, ...source});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timeline.id, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  processing.activate();
  function direction(direction: 'forward' | 'reverse', numerator = 1, denominator = 1, interpolation: SpeedInterpolation = 'off') {
    const service = createFormat5SequenceEditService(store);
    const reviewed = service.preview({projectId, requestId: randomUUID(), speedIntent: {side: 'timeline',
      operation: {kind: 'clip-speed', clipId: initialClip.id, setting: {speed: {kind: 'constant', rate: {numerator, denominator}},
        direction, pitchShift: false, interpolation}}}});
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    return service.commit({projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest});
  }
  return {projectId, file, cacheRoot, assetId, clipId: initialClip.id, direction, reopen,
    get processing() { return processing; }, get store() { return store; }};
}

test('committed speed changes share a proxy and a late result stays with the original demand', async t => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  let renders = 0;
  const f = await fixture(t, {engine: {...fakeEngine, render: async (...args) => {
    renders++;
    if (renders === 1) await hold;
    return fakeEngine.render(...args);
  }}});
  t.after(release);
  f.direction('reverse');
  const first = await until(() => f.processing.list(f).items[0]);
  await until(() => renders === 1 ? true : undefined);
  f.store.tx(() => {
    const timeline = readFormat5TimelineRecord(f.store.db, 'project')!;
    const clip = timeline.clips[0]!;
    const twin = {...clip, id: randomUUID(), startFrame: clip.durationFrames};
    f.store.put('timelines', {...timeline, revision: timeline.revision + 1, durationFrames: clip.durationFrames * 2, clips: [clip, twin]});
  });
  const twins = f.processing.list(f).items;
  assert.equal(twins.length, 2);
  assert.ok(twins.every(item => item.taskId === first.taskId));
  f.direction('reverse', 2);
  const oneChanged = await until(() => f.processing.list(f).items.find(item => item.taskId !== first.taskId));
  assert.equal(renders, 1, 'the second request cannot start before its predecessor');
  release();
  const [old, latest] = await Promise.all([first, oneChanged].map(item => f.processing.wait({projectId: f.projectId, taskId: item.taskId})));
  assert.equal(old.item.status, 'ready');
  assert.equal(latest.item.status, 'ready');
  assert.notEqual(latest.item.taskId, old.item.taskId);
  assert.equal(renders, 2);
  assert.equal(f.processing.cacheClear(f).freedBytes, 0);
  await f.reopen();
  assert.deepEqual(f.processing.list(f).items.map(item => item.taskId).sort(), [first.taskId, oneChanged.taskId].sort());
  assert.equal(renders, 2, 'reopen checks prior results without dispatching them again');
});

test('cancel confirms owned work and removes its stage, and retry has an exact stable receipt', async t => {
  let entered = false;
  const f = await fixture(t, {engine: {...fakeEngine, async render(input, prepared, options) {
    entered = true;
    writeFileSync(path.join(options.stagingDirectory, 'partial.raw'), 'partial', {mode: 0o600});
    await delay(10_000, undefined, {signal: options.signal});
    return fakeEngine.render(input, prepared, options);
  }}});
  f.direction('reverse');
  const task = await until(() => f.processing.list(f).items[0]);
  await until(() => entered ? true : undefined);
  assert.equal((await f.processing.wait({...f, taskId: task.taskId, timeoutMs: 1})).timedOut, true);
  const observation = new AbortController();
  const wait = f.processing.wait({projectId: f.projectId, taskId: task.taskId}, observation.signal);
  observation.abort();
  await assert.rejects(wait, {name: 'AbortError'});
  const result = await f.processing.cancel({projectId: f.projectId, taskId: task.taskId});
  assert.deepEqual(result, {status: 'failed'});
  assert.equal(readdirSync(path.join(f.cacheRoot, 'timeline-processing')).some(name => name.startsWith('stage-')), false);
  assert.equal(f.store.db.prepare('SELECT state FROM main.timeline_processing_tasks WHERE id=?').get(task.taskId)?.state, 'cancelled');
  const original = f.store.db.prepare('SELECT input FROM main.timeline_processing_tasks WHERE id=?').get(task.taskId)?.input;
  const request = {projectId: f.projectId, taskId: task.taskId, requestId: randomUUID()};
  assert.deepEqual(f.processing.retry(request), {taskId: task.taskId});
  assert.deepEqual(f.processing.retry(request), {taskId: task.taskId});
  assert.equal(f.store.db.prepare('SELECT input FROM main.timeline_processing_tasks WHERE id=?').get(task.taskId)?.input, original);
  await f.processing.cancel(request);
  f.direction('forward');
  assert.throws(() => f.processing.retry({...request, requestId: randomUUID()}), {code: 'SPEED_PROCESSING_STALE'});
  assert.deepEqual(f.processing.retry(request), {taskId: task.taskId});
});

test('source bytes changed while a task waits for admission and the original ID reopens without retry', async t => {
  const scheduler = createProcessingScheduler();
  const blocker = new AbortController();
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  const held = scheduler.schedule(blocker.signal, async () => await hold);
  t.after(release);
  const f = await fixture(t, {scheduler});
  f.direction('reverse');
  const task = await until(() => f.processing.list(f).items[0]);
  assert.equal(task.status, 'queued');
  writeFileSync(f.file, 'changed originally owned bytes');
  release(); await held;
  const ended = await f.processing.wait({projectId: f.projectId, taskId: task.taskId});
  assert.equal(ended.item.status, 'failed');
  assert.equal(ended.item.reason, 'SOURCE_UNAVAILABLE');
  await f.reopen();
  assert.deepEqual(f.processing.inspect({projectId: f.projectId, taskId: task.taskId}).item, ended.item);
});

test('an owned committed source runs the real worker and reopens its verified output by task ID', async t => {
  const f = await fixture(t, {engine: 'real'});
  f.direction('reverse');
  const task = await until(() => f.processing.list(f).items[0]);
  const result = await f.processing.wait({...f, taskId: task.taskId});
  assert.equal(result.item.status, 'ready', JSON.stringify(result.item));
  const directory = path.join(f.cacheRoot, 'timeline-processing');
  const entry = readdirSync(directory).find(name => /^[0-9a-f]{64}$/u.test(name));
  assert.ok(entry);
  const receipt = processingCacheReceiptSchema.parse(JSON.parse(readFileSync(path.join(directory, entry, 'receipt.json'), 'utf8')));
  assert.equal(receipt.result.sampleCount, 48000);
  for (const file of receipt.result.files) {
    assert.equal(sha(readFileSync(path.join(directory, entry, file.fileName))), file.sha256);
  }
  await f.reopen();
  assert.deepEqual(f.processing.inspect({projectId: f.projectId, taskId: task.taskId}), {item: result.item});
  const timeline = readFormat5TimelineRecord(f.store.db, 'project')!;
  const clip = timeline.clips.find(value => value.id === f.clipId)!;
  const timeMap = compileClipTimeMap(clip, timeline);
  assert.ok(timeMap.ok);
  const plan = timeMapPlanInfo(timeMap.value);
  assert.ok(plan.ok);
  assert.ok(clip.timing?.profile === 'timeline-speed-v1');
  const picture = reversePictureCoverage(timeMap.value, clip.timing, plan.value.sourceWindow, 60, 2, 0);
  assert.equal(picture?.endFrame, plan.value.sourceWindow.endFrame + 2);
  assert.equal(reversePictureCoverage(timeMap.value, clip.timing, plan.value.sourceWindow, 60, 0, 2), undefined);
  const request = {projectId: f.projectId, timelineId: timeline.id, clipId: f.clipId, assetId: f.assetId,
    sourceSha256: sha(readFileSync(f.file)), mapHash: plan.value.mapHash, media: 'audio' as const,
    sourceFps: timeMap.value.root.sourceFps, sourceWindow: plan.value.sourceWindow, pictureWindows: [],
    needsAudio: true, audioWindow: {fromSample: 0, toSample: 48_000}};
  const proof = f.processing.reverseProxy.lookup(request);
  assert.ok(proof?.readySha256);
  assert.equal(proof.taskId, task.taskId);
  const leased = await f.processing.reverseProxy.acquire(request, {taskId: proof.taskId, sha256: proof.readySha256}, {});
  assert.ok(leased?.audio);
  assert.deepEqual(leased.audio.clock, request.audioWindow);
  f.direction('forward');
  assert.equal(f.processing.reverseProxy.lookup(request), null);
  assert.equal(leased.verify(), true, 'a frozen export retains its verified original attempt');
  leased.release();
});

test('a stopped attempt reopens under its existing ID without starting another writer', async t => {
  let renders = 0;
  const f = await fixture(t, {engine: {...fakeEngine, async render(input, prepared, options) {
    renders++;
    await delay(10_000, undefined, {signal: options.signal});
    return fakeEngine.render(input, prepared, options);
  }}});
  f.direction('reverse');
  const original = await until(() => f.processing.list(f).items[0]);
  await until(() => renders ? true : undefined);
  await f.reopen();
  assert.deepEqual(f.processing.inspect({...f, taskId: original.taskId}).item, {
    taskId: original.taskId, clipId: original.clipId, kind: original.kind, status: 'failed', reason: 'PROCESSING_FAILED',
  });
  assert.equal(renders, 1);
});

test('outside media without a grant and full disk are reported as distinct failures', async t => {
  const f = await fixture(t);
  const outside = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-processing-outside-'));
  t.after(() => rmSync(outside, {recursive: true, force: true}));
  const relocated = path.join(outside, 'source.wav');
  renameSync(f.file, relocated);
  symlinkSync(relocated, f.file);
  f.direction('reverse');
  const inaccessible = await until(() => f.processing.list(f).items[0]);
  assert.equal((await f.processing.wait({...f, taskId: inaccessible.taskId})).item.reason, 'SOURCE_UNAVAILABLE');
  const g = await fixture(t, {cache: {freeBytes: () => 0n}});
  g.direction('reverse');
  const limited = await until(() => g.processing.list(g).items[0]);
  assert.equal((await g.processing.wait({...g, taskId: limited.taskId})).item.reason, 'DISK_FULL');
});

test('format 6 with the developer flag disabled creates no row or cache root', async t => {
  const f = await fixture(t, {enabled: false});
  f.direction('reverse');
  await delay(30);
  assert.deepEqual(f.processing.list(f), {items: []});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.timeline_processing_tasks').get()?.n, 0);
  assert.deepEqual(f.processing.cacheGet(f), {usedBytes: 0, limitBytes: 10 * 1024 ** 3});
  const old = await fixture(t, {format: FORMAT5_PROJECT_SCHEMA_VERSION});
  assert.equal(old.processing.enabled(), false);
  assert.deepEqual(old.processing.list(old), {items: []});
});

function opticalRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const timeline = readFormat5TimelineRecord(f.store.db, 'project')!;
  const clip = timeline.clips[0]!;
  const plan = compileClipTimeMap(clip, timeline);
  assert.ok(plan.ok && clip.timing && clip.assetId);
  return {projectId: f.projectId, timelineId: timeline.id, clipId: clip.id, assetId: clip.assetId,
    mapHash: plan.value.root.mapHash, sourceSha256: sha(readFileSync(f.file)), timing: clip.timing,
    outputWindow: {fromFrame: 0, toFrame: clip.durationFrames}};
}

test('a real optical task reopens with an authenticated output lease and retries changed bytes', async t => {
  const f = await fixture(t, {video: true});
  f.direction('forward', 1, 2, 'optical');
  const task = await until(() => f.processing.list(f).items[0]);
  const ready = await f.processing.wait({...f, taskId: task.taskId});
  assert.equal(ready.item.status, 'ready', JSON.stringify(ready.item));
  const request = opticalRequest(f);
  const snapshot = f.processing.opticalProxy.lookup(request);
  assert.ok(snapshot?.readySha256);
  assert.equal(snapshot.taskId, task.taskId);
  assert.equal(f.processing.opticalProxy.lookup({...request, sourceSha256: '0'.repeat(64)}), null);
  assert.equal(f.processing.opticalProxy.lookup({...request, outputWindow: {fromFrame: -1, toFrame: 0}})?.readySha256, undefined);
  const proof = {taskId: snapshot.taskId, sha256: snapshot.readySha256};
  await f.reopen();
  assert.deepEqual(f.processing.opticalProxy.lookup(request), snapshot);
  assert.equal(await f.processing.opticalProxy.acquire(request, {...proof, sha256: '0'.repeat(64)}), null);
  const lease = await f.processing.opticalProxy.acquire(request, proof);
  assert.ok(lease);
  assert.equal(lease.verify(), true);
  assert.equal(lease.video.firstOutputFrame, 0);
  assert.equal(lease.video.frameCount, request.outputWindow.toFrame);
  const original = readFileSync(lease.video.file);
  original[0] = original[0]! ^ 0xff;
  writeFileSync(lease.video.file, original);
  assert.equal(lease.verify(), false);
  assert.equal(f.processing.opticalProxy.lookup(request)?.readySha256, undefined);
  assert.equal(await f.processing.opticalProxy.acquire(request, proof), null);
  lease.release();
  assert.equal(f.processing.inspect({...f, taskId: task.taskId}).item.status, 'failed');
  f.processing.retry({...f, taskId: task.taskId, requestId: randomUUID()});
  assert.equal((await f.processing.wait({...f, taskId: task.taskId})).item.status, 'ready');
  const regenerated = f.processing.opticalProxy.lookup(request);
  assert.ok(regenerated?.readySha256);
  assert.notEqual(regenerated.readySha256, snapshot.readySha256);
  const newProof = {taskId: regenerated.taskId, sha256: regenerated.readySha256};
  const frozen = await f.processing.opticalProxy.acquire(request, newProof);
  assert.ok(frozen);
  f.direction('forward');
  assert.equal(f.processing.opticalProxy.lookup(request), null);
  assert.equal(frozen.verify(), true);
  assert.equal(f.processing.cacheClear(f).freedBytes, 0);
  const frozenAgain = await f.processing.opticalProxy.acquire(request, newProof);
  assert.ok(frozenAgain);
  f.store.tx(() => f.store.db.prepare('DELETE FROM main.timeline_processing_tasks WHERE id=?').run(task.taskId));
  assert.equal(frozen.verify(), false);
  assert.equal(await f.processing.opticalProxy.acquire(request, newProof), null);
  frozenAgain.release();
  frozen.release();
  assert.ok(f.processing.cacheClear(f).freedBytes > 0);
});

test('cancelling an active optical encoder reaps its owned process and discards the stage', async t => {
  const f = await fixture(t, {video: true});
  const root = path.join(f.cacheRoot, 'timeline-processing');
  const children = new Set<number>();
  let cancellation: Promise<{status: string}> | undefined;
  const unsubscribe = onMediaProcess(event => {
    if (!event.pid) return;
    if (event.type === 'exited') {children.delete(event.pid); return;}
    if (!(existsSync(root) && readdirSync(root, {withFileTypes: true}).some(entry => entry.name.startsWith('stage-')))) return;
    children.add(event.pid);
    const task = f.processing.list(f).items.find(item => item.kind === 'optical');
    if (task && !cancellation) cancellation = f.processing.cancel({...f, taskId: task.taskId});
  });
  t.after(unsubscribe);
  f.direction('forward', 1, 2, 'optical');
  const terminal = await until(() => cancellation ? {cancellation} : undefined);
  assert.deepEqual(await terminal.cancellation, {status: 'failed'});
  const request = opticalRequest(f);
  const task = f.processing.opticalProxy.lookup(request);
  assert.ok(task);
  assert.equal(task.readySha256, undefined);
  assert.equal(await f.processing.opticalProxy.acquire(request, {taskId: task.taskId, sha256: '0'.repeat(64)}), null);
  assert.equal(children.size, 0);
  assert.equal(readdirSync(root).some(name => name.startsWith('stage-') || /^[a-f0-9]{64}$/u.test(name)), false);
});

test('preview submission runs only after a commit and leases are tied to the current clip and profile', async t => {
  const f = await fixture(t, {video: true, previewRenderer: fakePreview});
  assert.equal(f.processing.preview.lookup(f), null);
  assert.deepEqual(f.processing.list(f), {items: []});
  f.direction('reverse');
  const previewTask = await until(() => f.processing.list(f).items.find(value => value.kind === 'preview'));
  const reverseTask = await until(() => f.processing.list(f).items.find(value => value.kind === 'reverse'));
  assert.notEqual(previewTask.taskId, reverseTask.taskId);
  assert.equal((await f.processing.wait({...f, taskId: previewTask.taskId})).item.status, 'ready');
  const found = f.processing.preview.lookup(f);
  assert.ok(found?.ready);
  assert.equal(found.ready.durationFrames, 30);
  const {proof} = found.ready;
  const lease = await f.processing.preview.acquire(proof);
  assert.ok(lease);
  assert.equal(lease.verify(), true);
  assert.equal(path.basename(lease.file), 'preview.mp4');
  assert.equal(await f.processing.preview.acquire({...proof, taskId: reverseTask.taskId}), null);
  assert.equal(await f.processing.preview.acquire({...proof, projectId: randomUUID()}), null);
  assert.equal(await f.processing.preview.acquire({...proof, clipId: randomUUID()}), null);
  assert.equal(await f.processing.preview.acquire({...proof, sha256: sha('different')}), null);
  f.direction('forward');
  assert.equal(f.processing.preview.lookup(f), null);
  assert.equal(lease.verify(), false);
  assert.equal(await f.processing.preview.acquire(proof), null);
  f.processing.cacheClear(f);
  assert.equal(readFileSync(lease.file, 'utf8'), 'preview fixture');
  lease.release();
  assert.ok(f.processing.cacheClear(f).freedBytes > 0);
});

test('a host with a preview renderer submits missing tasks when it restores committed clips', async t => {
  const f = await fixture(t, {video: true});
  f.direction('reverse');
  const reverse = await until(() => f.processing.list(f).items.find(value => value.kind === 'reverse'));
  await f.processing.wait({...f, taskId: reverse.taskId});
  assert.equal(f.processing.preview.lookup(f), null);
  await f.reopen(fakePreview);
  const preview = await until(() => f.processing.preview.lookup(f) ?? undefined);
  assert.equal((await f.processing.wait({...f, taskId: preview.item.taskId})).item.status, 'ready');
  assert.ok(f.processing.preview.lookup(f)?.ready);
});

test('the shared list, inspect and wait outcomes preserve the interpolation rejection', async t => {
  const f = await fixture(t, {video: true, previewRenderer: {...fakePreview, async prepare() {
    throw new ProcessingFailure('INTERPOLATION_UNAVAILABLE');
  }}});
  f.direction('reverse');
  const preview = await until(() => f.processing.preview.lookup(f) ?? undefined);
  const request = {projectId: f.projectId, taskId: preview.item.taskId};
  const outcome = timelineProcessingResponseSchemas['timeline.processing.wait'].parse(await f.processing.wait(request));
  assert.equal(outcome.item.kind, 'preview');
  assert.equal(outcome.item.reason, 'INTERPOLATION_UNAVAILABLE');
  const inspection = timelineProcessingResponseSchemas['timeline.processing.inspect'].parse(f.processing.inspect(request));
  assert.deepEqual(inspection.item, outcome.item);
  const listed = timelineProcessingResponseSchemas['timeline.processing.list'].parse(f.processing.list(f));
  assert.deepEqual(listed.items.find(item => item.taskId === request.taskId), outcome.item);
});

test('reusing a ready demand refreshes LRU before the next cache admission', async t => {
  const f = await fixture(t, {cache: {limitBytes: 65536 + 720}});
  const root = path.join(f.cacheRoot, 'timeline-processing');
  const ready = async (rate: number) => {
    f.direction('reverse', rate);
    const active = await until(() => f.processing.list(f).items[0]);
    assert.equal((await f.processing.wait({...f, taskId: active.taskId})).item.status, 'ready');
    const row = f.store.db.prepare('SELECT result FROM main.timeline_processing_tasks WHERE id=?').get(active.taskId);
    const evidence = processingResultSchema.parse(JSON.parse(String(row?.result)));
    return path.join(root, evidence.cacheKey);
  };
  const first = await ready(1), second = await ready(2);
  utimesSync(first, 100, 100);
  utimesSync(second, 200, 200);
  assert.equal(await ready(1), first);
  await until(() => statSync(first).mtimeMs > statSync(second).mtimeMs ? true : undefined);
  f.direction('forward');
  await delay(0);
  await ready(3);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), false);
});

test('renewing an evicted completed demand regenerates under the same task and a new attempt', async t => {
  const f = await fixture(t);
  f.direction('reverse');
  const target = await until(() => f.processing.list(f).items[0]);
  const id = target.taskId;
  assert.equal((await f.processing.wait({...f, taskId: id})).item.status, 'ready');
  const query = f.store.db.prepare('SELECT requestId FROM main.timeline_processing_tasks WHERE id=?');
  const previous = query.get(id)?.requestId;
  f.direction('forward');
  assert.ok(f.processing.cacheClear(f).freedBytes > 0);
  f.direction('reverse');
  await until(() => query.get(id)?.requestId !== previous ? true : undefined);
  assert.equal(f.processing.list(f).items[0]?.taskId, id);
  assert.equal((await f.processing.wait({...f, taskId: id})).item.status, 'ready');
});
