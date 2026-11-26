import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
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

const at = '2026-01-01T00:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
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

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let tries = 0; tries < 200; tries++) {
    const value = read(); if (value !== undefined) return value;
    await delay(10);
  }
  throw new Error('Timed out reading processing state');
}

async function fixture(t: test.TestContext, options: {enabled?: boolean; format?: 5 | 6;
  engine?: ProcessingServiceOptions['engine'] | 'real'; scheduler?: ProcessingServiceOptions['scheduler'];
  cache?: Parameters<typeof createProcessingCache>[1]} = {}) {
  const parent = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-processing-lifecycle-'));
  const projectId = randomUUID(), projectFile = path.join(parent, 'project.mioon');
  const locate = () => ({localDir: path.join(parent, 'local'), cacheDir: path.join(parent, 'cache'), tempDir: path.join(parent, 'tmp')});
  const opening = {projectFile, locate, allowFormat6: true as const};
  let store = createProjectStore({...opening, projectId, targetFormat: options.format ?? FORMAT6_PROJECT_SCHEMA_VERSION});
  let unregister = registerProjectMediaStore(store);
  const cacheRoot = path.join(parent, 'global-cache');
  const scheduler = options.scheduler ?? createProcessingScheduler();
  const createService = () => createTimelineProcessingService(store, {
    enabled: options.enabled ?? true, scheduler, cache: createProcessingCache(cacheRoot, options.cache), beforeEffect: noEffect,
    ...(options.engine === 'real' ? {} : {engine: options.engine ?? fakeEngine}),
  });
  let processing = createService();
  async function reopen() {
    await processing.close(); unregister(); store.close();
    store = openProjectStore(opening);
    unregister = registerProjectMediaStore(store);
    processing = createService(); processing.activate();
  }
  t.after(async () => {await processing.close(); unregister(); store.close(); rmSync(parent, {recursive: true, force: true});});
  const assetId = randomUUID(), mainTrackId = randomUUID(), rootId = randomUUID();
  const audioTrack = {id: randomUUID(), name: 'A1', kind: 'audio' as const, orderIndex: 1, hidden: false, muted: false};
  const media = path.join(parent, 'media'); mkdirSync(media, {mode: 0o700});
  const file = path.join(media, 'processing-source.wav');
  writeFileSync(file, silentWave(), {mode: 0o600});
  const source = await referenceForPublishedMedia(store, file);
  const initialClip: Format5Clip = {id: randomUUID(), trackId: audioTrack.id, name: 'Audio', startFrame: 0, durationFrames: 30,
    sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId, sourceState: 'ready', anchor: null};
  const timeline: Format5Timeline = {id: randomUUID(), projectId, revision: 1, width: 720, height: 1280, fps: 30,
    durationFrames: 30, createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
    tracks: [{id: mainTrackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}, audioTrack], clips: [initialClip]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Processing lifecycle', createdAt: at, updatedAt: at, revision: 1});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Timeline', position: {x: 0, y: 0}, createdAt: at});
    store.put('assets', {id: assetId, projectId, name: 'processing-source.wav', mimeType: 'audio/wav', duration: 2, hasAudio: true,
      width: null, height: null, createdAt: at, ...source});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timeline.id, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  processing.activate();
  function direction(direction: 'forward' | 'reverse', numerator = 1) {
    const service = createFormat5SequenceEditService(store);
    const reviewed = service.preview({projectId, requestId: randomUUID(), speedIntent: {side: 'timeline',
      operation: {kind: 'clip-speed', clipId: initialClip.id, setting: {speed: {kind: 'constant', rate: {numerator, denominator: 1}},
        direction, pitchShift: false, interpolation: 'off'}}}});
    assert.ok('envelope' in reviewed, JSON.stringify(reviewed));
    return service.commit({projectId, envelope: reviewed.envelope, expectedPlanDigest: reviewed.planDigest});
  }
  return {projectId, file, cacheRoot, assetId, direction, reopen,
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
  const receipt = JSON.parse(readFileSync(path.join(directory, entry, 'receipt.json'), 'utf8'));
  assert.equal(receipt.result.sampleCount, 48000);
  for (const file of receipt.result.files) {
    const hash = createHash('sha256').update(readFileSync(path.join(directory, entry, file.fileName))).digest('hex');
    assert.equal(hash, file.sha256);
  }
  await f.reopen();
  assert.deepEqual(f.processing.inspect({projectId: f.projectId, taskId: task.taskId}), {item: result.item});
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
