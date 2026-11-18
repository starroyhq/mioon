import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createMediaEncoderPool, withMediaEncoderSlot} from '../packages/business/src/media-encoder-pool.ts';
import type {MediaEncoderSlotPool} from '../packages/business/src/media-encoder-pool.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';

type Asset = Awaited<ReturnType<typeof sourceAsset>>;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, label: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}
function trackingPool(limit: number) {
  const inner = createMediaEncoderPool(limit);
  let active = 0, peak = 0, maxWaiting = 0;
  const sample = () => { maxWaiting = Math.max(maxWaiting, inner.stats().waiting); };
  const pool: MediaEncoderSlotPool = {
    limit,
    async acquire(signal, owner) {
      const release = await inner.acquire(signal, owner);
      active += 1;
      peak = Math.max(peak, active);
      sample();
      let released = false;
      return () => { if (released) return; released = true; active -= 1; release(); };
    },
    stats: () => { sample(); return inner.stats(); },
  };
  return {pool, peak: () => peak, active: () => active, maxWaiting: () => maxWaiting};
}

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-encoder-pool-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

/** A tiny real H.264 source; content is synthetic and identical in both test files. */
async function sourceAsset(root: string) {
  const width = 64, height = 48, frames = 90, plane = width * height, file = path.join(root, `${randomUUID()}.mp4`), raw = `${file}.yuv`;
  const frame = Buffer.concat([Buffer.alloc(plane, 100), Buffer.alloc(plane, 110), Buffer.alloc(plane, 140)]);
  await writeFile(raw, Buffer.concat(Array<Buffer>(frames).fill(frame)));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-threads', '1',
    '-f', 'rawvideo', '-pixel_format', 'yuv444p', '-video_size', `${width}x${height}`, '-framerate', '30',
    '-i', raw, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-threads', '1', file], {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 65536});
  const media = await probe(file);
  return {id: randomUUID(), mimeType: 'video/mp4', path: file, relativePath: path.basename(file),
    sha256: sha(await readFile(file)), sizeBytes: (await readFile(file)).length, ...media, colourProbe: media.probe};
}

/** Two 20-frame clips: one render plans exactly two encoder segments. */
function fixture(asset: Asset) {
  const projectId = randomUUID(), trackId = randomUUID(), at = '2026-01-01T00:00:00.000Z';
  const clip = (index: number) => ({id: randomUUID(), trackId, assetId: asset.id, name: `clip-${index}`,
    startFrame: index * 20, durationFrames: 20, sourceInFrame: index * 20,
    rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1});
  const timeline = {id: randomUUID(), projectId, revision: 1, fps: 30, width: 720, height: 720, durationFrames: 40,
    tracks: [{id: trackId, kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false}],
    clips: [clip(0), clip(1)], createdAt: at, updatedAt: at};
  return freezeTimelineSnapshot(timeline as never, new Map([[asset.id, asset]]) as never, undefined);
}

/** The same fixture with a frozen MP4 delivery profile, so every render runs
 * the process-wide one-at-a-time local capability check before encoding. */
function deliveryFixture(asset: Asset) {
  const projectId = randomUUID(), trackId = randomUUID(), at = '2026-01-01T00:00:00.000Z';
  const timeline = {id: randomUUID(), projectId, revision: 1, fps: 30, width: 720, height: 720, durationFrames: 20,
    tracks: [{id: trackId, kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: randomUUID(), trackId, assetId: asset.id, name: 'clip-0', startFrame: 0, durationFrames: 20,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1}], createdAt: at, updatedAt: at};
  return freezeTimelineSnapshot(timeline as never, new Map([[asset.id, asset]]) as never,
    {profileId: 'mp4_h264_v1', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}});
}

type RenderOptions = Parameters<typeof renderTimeline>[3];
const render = (root: string, name: string, asset: Asset, snapshot: unknown, options: RenderOptions) =>
  renderTimeline(snapshot as never, new Map([[asset.id, asset]]) as never, path.join(root, name), options);

test('two concurrent exports share one encoder cap and stay byte-identical to a lone export', {timeout: 240000}, async t => {
  const root = await sandbox(t), asset = await sourceAsset(root), snapshot = fixture(asset);
  // A lone export must still use its full segment concurrency when uncontended.
  const lone = trackingPool(4);
  await render(root, 'lone.mp4', asset, snapshot, {segmentConcurrency: 2, encoderPool: lone.pool});
  const loneHash = sha(await readFile(path.join(root, 'lone.mp4')));
  assert.equal(lone.peak(), 2, 'an uncontended export still runs every planned segment encoder');
  assert.deepEqual(lone.pool.stats(), {limit: 4, active: 0, waiting: 0, owners: 0});

  // Two exports at once with the shared cap: never more encoders than the cap.
  const shared = trackingPool(2), progress: number[][] = [[], []];
  await Promise.all([0, 1].map(index => render(root, `concurrent-${index}.mp4`, asset, snapshot,
    {segmentConcurrency: 2, encoderPool: shared.pool, onSegmentProgress(completed) { progress[index]!.push(completed); }})));
  assert.equal(shared.peak(), 2, 'the shared pool caps both exports together');
  assert.ok(shared.maxWaiting() >= 1, 'the second export had to queue for a slot');
  for (const values of progress) {
    assert.ok(values.length > 0);
    assert.deepEqual(values, [...values].sort((a, b) => a - b), 'a queued export reports monotonically increasing progress');
    assert.equal(values.at(-1), snapshot.timeline.durationFrames);
  }
  for (const name of ['concurrent-0.mp4', 'concurrent-1.mp4']) assert.equal(sha(await readFile(path.join(root, name))), loneHash);
  assert.equal(shared.pool.stats().active, 0);
});

test('cancelling a queued export starts no encoder and returns its place', {timeout: 240000}, async t => {
  const root = await sandbox(t), asset = await sourceAsset(root), snapshot = fixture(asset);
  const lone = createMediaEncoderPool(4);
  await render(root, 'lone.mp4', asset, snapshot, {segmentConcurrency: 2, encoderPool: lone});
  const loneHash = sha(await readFile(path.join(root, 'lone.mp4')));

  const shared = trackingPool(1), controller = new AbortController();
  let firstLaunches = 0, secondLaunches = 0;
  const first = render(root, 'first.mp4', asset, snapshot,
    {segmentConcurrency: 2, encoderPool: shared.pool, beforeStart() { firstLaunches += 1; }});
  await waitFor(() => firstLaunches >= 1 && shared.pool.stats().active === 1, 'the first export to start encoding');
  const second = render(root, 'second.mp4', asset, snapshot,
    {segmentConcurrency: 2, encoderPool: shared.pool, signal: controller.signal, beforeStart() { secondLaunches += 1; }});
  await waitFor(() => shared.pool.stats().waiting >= 1, 'the second export to queue');
  controller.abort();
  await assert.rejects(second, {code: 'MEDIA_CANCELLED'});
  assert.equal(secondLaunches, 0, 'a queued export must never start an encoder process');
  await first;
  assert.equal(sha(await readFile(path.join(root, 'first.mp4'))), loneHash);
  assert.equal(shared.pool.stats().active, 0);
});

test('cancelling the running export hands its slot to the queued one', {timeout: 240000}, async t => {
  const root = await sandbox(t), asset = await sourceAsset(root), snapshot = fixture(asset);
  const lone = createMediaEncoderPool(4);
  await render(root, 'lone.mp4', asset, snapshot, {segmentConcurrency: 2, encoderPool: lone});
  const loneHash = sha(await readFile(path.join(root, 'lone.mp4')));

  const shared = trackingPool(1), controller = new AbortController();
  let runningLaunches = 0;
  const running = render(root, 'cancelled.mp4', asset, snapshot,
    {segmentConcurrency: 2, encoderPool: shared.pool, signal: controller.signal, beforeStart() { runningLaunches += 1; }});
  await waitFor(() => runningLaunches >= 1 && shared.pool.stats().active === 1, 'the cancelled export to start encoding');
  const waiting = render(root, 'waiting.mp4', asset, snapshot, {segmentConcurrency: 2, encoderPool: shared.pool});
  await waitFor(() => shared.pool.stats().waiting >= 1, 'the other export to queue');
  controller.abort();
  await assert.rejects(running, {code: 'MEDIA_CANCELLED'});
  await waiting;
  assert.equal(sha(await readFile(path.join(root, 'waiting.mp4'))), loneHash);
  assert.equal(shared.pool.stats().active, 0);
});

test('two exports started at the same moment wait out the one-at-a-time capability check', {timeout: 120000}, async t => {
  const root = await sandbox(t), asset = await sourceAsset(root), snapshot = deliveryFixture(asset);
  const pool = createMediaEncoderPool(2);
  const names = ['capability-a.mp4', 'capability-b.mp4'];
  await Promise.all(names.map(name => render(root, name, asset, snapshot, {segmentConcurrency: 1, encoderPool: pool})));
  const hashes = await Promise.all(names.map(name => readFile(path.join(root, name)).then(sha)));
  assert.equal(hashes[0], hashes[1], 'the waited render must match the simultaneous one byte for byte');
  assert.equal(pool.stats().active, 0);
});

test('a killed encoder process and a failed one both return their slot', {timeout: 120000}, async t => {
  const root = await sandbox(t), asset = await sourceAsset(root);
  assert.ok(asset.sha256.length === 64);
  const pool = createMediaEncoderPool(1);
  let killed = false;
  const stopWatching = onMediaProcess(({type, kind, pid}) => {
    if (type !== 'started' || kind !== 'ffmpeg' || killed || pid === undefined) return;
    killed = true;
    process.kill(pid, 'SIGKILL');
  });
  t.after(stopWatching);
  const killedAttempt = withMediaEncoderSlot(pool, undefined, () => run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-threads', '1', '-f', 'null', '-'], {timeout: 60000}));
  const queuedAttempt = withMediaEncoderSlot(pool, undefined, () => run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30', '-frames:v', '1', '-f', 'null', '-'], {timeout: 30000}));
  await assert.rejects(killedAttempt, {code: 'MEDIA_EXIT_FAILED'});
  await queuedAttempt;
  assert.equal(killed, true);
  assert.deepEqual(pool.stats(), {limit: 1, active: 0, waiting: 0, owners: 0});
  const failedAttempt = withMediaEncoderSlot(pool, undefined, () => run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=30', '-frames:v', '1', '-c:v', 'not-a-real-encoder', '-f', 'null', '-'], {timeout: 30000}));
  await assert.rejects(failedAttempt, {code: 'MEDIA_EXIT_FAILED'});
  assert.deepEqual(pool.stats(), {limit: 1, active: 0, waiting: 0, owners: 0});
  await withMediaEncoderSlot(pool, undefined, () => Promise.resolve('ok'));
});
