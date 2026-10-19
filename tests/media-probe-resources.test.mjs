import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProbeOutput, withProbePermit, MEDIA_PROBE_LIMITS } from '../packages/business/src/media-probe.ts';
import { run, probe, fileHash, fileInfo, stitch } from '../packages/business/src/media.ts';
import { renderTimeline } from '../packages/business/src/timeline-media.ts';
import { onMediaProcess } from '../packages/business/src/media-processes.ts';
import { createMockProvider } from '../packages/business/src/providers/mock.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const video = (width = 1920, height = 1080, extra = {}) => ({ index: 0, codec_type: 'video', codec_name: 'h264', width, height, ...extra });
const audio = extra => ({ index: 1, codec_type: 'audio', codec_name: 'aac', ...extra });
const document = streams => ({ streams, format: { duration: '2.5' } });
const parse = value => parseProbeOutput(JSON.stringify(value));
async function sandbox(t) { const root = await mkdtemp(path.join(tmpdir(), 'media-resources-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('metadata accepts portrait/landscape 4K and 8K plus audio/image inputs without a codec or duration upper ban', () => {
  for (const [width, height] of [[360, 640], [1920, 1080], [3840, 2160], [2160, 3840], [7680, 4320], [4320, 7680], [8192, 8192]]) {
    const result = parse(document([video(width, height), audio()]));
    assert.equal(result.width, width); assert.equal(result.height, height); assert.equal(result.duration, 2.5);
    assert.equal(result.hasVideo, true); assert.equal(result.hasAudio, true);
  }
  assert.equal(parse(document([audio()])).hasVideo, false);
  const image = parse({ streams: [video(1000, 1500, { codec_name: 'arbitrary-decoder' })] });
  assert.equal(image.duration, 0); assert.equal(image.codec, 'arbitrary-decoder');
  assert.equal(parse({ streams: [audio({ duration: 'N/A' })] }).duration, 0);
  assert.equal(parse({ streams: [audio({ duration: '1000000000' })] }).duration, 1e9);
  const cover = parse(document([video(200, 200, { disposition: { attached_pic: 1 } }), audio()]));
  assert.equal(cover.hasVideo, false);
});

test('stream selection skips unidentified codecs without adding a codec allowlist', () => {
  for (const codec_name of [undefined, null, '', 'unknown']) {
    const result = parse(document([
      video(200, 200, { index: 0, disposition: { attached_pic: 1 } }),
      video(640, 360, { index: 1, codec_name }),
      audio({ index: 2, codec_name }),
      video(320, 180, { index: 3, codec_name: 'arbitrary-decoder' }),
      audio({ index: 4 }),
    ]));
    assert.equal(result.videoStreamIndex, 3);
    assert.equal(result.audioStreamIndex, 4);
    assert.equal(result.width, 320);
    assert.equal(result.codec, 'arbitrary-decoder');
    assert.throws(() => parse(document([video(640, 360, { codec_name }), audio({ codec_name })])), { code: 'MEDIA_NO_STREAM' });
  }
});

test('unidentified optional audio is absent and duration fallback remains bounded metadata only', () => {
  const result = parse(document([video(), audio({ codec_name: undefined })]));
  assert.equal(result.hasAudio, false);
  assert.equal(result.audioStreamIndex, undefined);
  for (const unavailable of [undefined, null, '', 'N/A', 0, '0']) {
    const fallback = parse({ streams: [video(320, 180, { duration: '1' }), audio({ duration: '2' })], format: { duration: unavailable } });
    assert.equal(fallback.duration, 1);
    assert.equal(parse({ streams: [audio({ duration: '2' })], format: { duration: unavailable } }).duration, 2);
    assert.equal(parse({ streams: [video(320, 180, { duration: unavailable })] }).duration, 0);
  }
  assert.equal(parse({ streams: [video(320, 180, { duration: '1' }), audio({ duration: '2' })], format: { duration: '3' } }).duration, 3);
});

test('corrupt, excessive, nonfinite and negative metadata fails safely', () => {
  for (const output of ['{not-json synthetic-private', 'null', '[]', '{}']) assert.throws(() => parseProbeOutput(output), error => error.code === 'MEDIA_INVALID_METADATA' && !error.message.includes('synthetic-private'));
  const invalid = [
    { streams: {} }, { streams: [null] }, { streams: [video()], format: [] },
    document(Array.from({ length: MEDIA_PROBE_LIMITS.streams + 1 }, () => audio())),
    document([video(16385, 1)]), document([video(8193, 8192)]), document([video(-1, 1080)]), document([video(1.5, 1080)]), document([video('1920', 1080)]),
    document([video(1920, 1080, { index: -1 })]), document([video(1920, 1080, { duration: 'Infinity' })]),
    { streams: [audio()], format: { duration: '-2' } }, { streams: [audio()], format: { duration: 'NaN' } },
    { streams: [audio()], format: { duration: {} } },
  ];
  for (const value of invalid) assert.throws(() => parse(value), { code: 'MEDIA_INVALID_METADATA' });
  assert.throws(() => parse({ streams: [] }), { code: 'MEDIA_NO_STREAM' });
  assert.equal(parse(document(Array.from({ length: 256 }, () => audio()))).hasAudio, true);
});

test('probe concurrency queues twelve inputs and an aborted queued operation never starts', async () => {
  let active = 0, maximum = 0, total = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = async () => { total += 1; active += 1; maximum = Math.max(maximum, active); await gate; active -= 1; };
  const first = Array.from({ length: 12 }, () => withProbePermit(undefined, work));
  const controller = new AbortController(); let cancelledStarted = false;
  const cancelled = withProbePermit(controller.signal, async () => { cancelledStarted = true; });
  const check = assert.rejects(cancelled, { code: 'MEDIA_CANCELLED' });
  await pause(0); assert.equal(active, 4); controller.abort(); await check;
  release(); await Promise.all(first);
  assert.equal(total, 12); assert.equal(maximum, 4); assert.equal(active, 0); assert.equal(cancelledStarted, false);
  await assert.rejects(withProbePermit(undefined, async () => { throw Error('synthetic-probe-failure'); }));
  assert.equal(await withProbePermit(undefined, async () => 'slot-released'), 'slot-released');
});

test('actual probe timeout and in-flight abort reap the selected synthetic executable', async t => {
  if (process.platform === 'win32') { t.skip('Executable script fixture is POSIX; native Windows verification is separate'); return; }
  const root = await sandbox(t), binary = path.join(root, 'synthetic probe 工具');
  await writeFile(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const media = new URL('../packages/business/src/media.ts', import.meta.url).href;
  const processes = new URL('../packages/business/src/media-processes.ts', import.meta.url).href;
  const source = `import {probe} from ${JSON.stringify(media)};import {onMediaProcess,terminateMediaProcesses} from ${JSON.stringify(processes)};
    const outcomes=[];for(const mode of ['timeout','abort']){const events=[],c=new AbortController();const off=onMediaProcess(e=>{events.push(e.type);if(e.type==='started'&&mode==='abort')c.abort()});try{await probe('synthetic-only',{timeout:60,signal:c.signal});throw Error('unexpected success')}catch(e){outcomes.push({code:e.code,events})}finally{off()}}
    console.log(JSON.stringify({outcomes,remaining:await terminateMediaProcesses()}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root, MIOON_FFPROBE_PATH: binary }, timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { outcomes: [{ code: 'MEDIA_TIMEOUT', events: ['started', 'exited'] }, { code: 'MEDIA_CANCELLED', events: ['started', 'exited'] }], remaining: [] });
});

test('pre-aborted media APIs do not spawn or write and hashing aborts while streaming', async t => {
  const root = await sandbox(t), source = path.join(root, 'synthetic.bin');
  const bytes = Buffer.alloc(1024 * 1024, 7); await writeFile(source, bytes);
  assert.equal(await fileHash(source), createHash('sha256').update(bytes).digest('hex'));
  const controller = new AbortController(); controller.abort();
  const events = [], off = onMediaProcess(event => events.push(event));
  try {
    for (const operation of [() => probe(source, { signal: controller.signal }), () => fileInfo(source, { signal: controller.signal }), () => fileHash(source, { signal: controller.signal }), () => stitch([], path.join(root, 'never.mp4'), { signal: controller.signal }), () => renderTimeline(null, new Map(), path.join(root, 'never.mp4'), { signal: controller.signal })]) await assert.rejects(operation(), { code: 'MEDIA_CANCELLED', name: 'AbortError' });
    assert.deepEqual(events, []); assert.deepEqual(await readdir(root), ['synthetic.bin']);
    const hashing = new AbortController(), promise = fileHash(source, { signal: hashing.signal }); hashing.abort();
    await assert.rejects(promise, { code: 'MEDIA_CANCELLED' });
  } finally { off(); }
});

test('mixed settled media failures preserve the exact unconfirmed error before ordinary failures or cancellation', async t => {
  const root = await sandbox(t), source = path.join(root, 'synthetic-not-media.bin');
  await writeFile(source, 'synthetic bytes');
  const originalAllSettled = Promise.allSettled;
  for (const operation of ['fileInfo', 'stitch']) for (const abortAtSettlement of [false, true]) {
    const controller = new AbortController();
    const ordinary = Object.assign(new Error('Synthetic ordinary sibling failure.'), { code: 'SYNTHETIC_SIBLING_FAILURE' });
    const unconfirmed = Object.assign(new Error('Local media tool exceeded its output limit.'), { code: 'MEDIA_OUTPUT_LIMIT', terminationUnconfirmed: true });
    let settledCalls = 0;
    const mocked = t.mock.method(Promise, 'allSettled', async function (promises) {
      // Await every actual synthetic hash/probe sibling before injecting the
      // mixed completion results. No process or filesystem operation is orphaned.
      await originalAllSettled.call(Promise, promises); settledCalls += 1;
      if (abortAtSettlement) controller.abort();
      return [{ status: 'rejected', reason: ordinary }, { status: 'rejected', reason: unconfirmed }];
    });
    try {
      const result = operation === 'fileInfo' ? fileInfo(source, { signal: controller.signal }) : stitch([source, source], path.join(root, 'never.mp4'), { signal: controller.signal });
      await assert.rejects(result, error => error === unconfirmed);
      assert.equal(settledCalls, 1);
    } finally { mocked.mock.restore(); }
  }
  assert.deepEqual(await readdir(root), ['synthetic-not-media.bin']);
});

test('mock abort checkpoints preserve ledger counts and prevent any later DB use', async t => {
  const root = await sandbox(t), db = new DatabaseSync(':memory:');
  const provider = createMockProvider({ root, db });
  const snapshot = { duration: 2, aspectRatio: '9:16', parameters: { scenario: 'success', delayMs: 0 } };
  const { providerJobId } = await provider.submit(snapshot, { requestId: 'mock-abort-test' });
  const controller = new AbortController(); controller.abort();
  const context = { requestId: 'never-submit', signal: controller.signal };
  for (const call of [() => provider.submit(snapshot, context), () => provider.poll(providerJobId, context), () => provider.reconcile('mock-abort-test', context), () => provider.cancel(providerJobId, context), () => provider.download(providerJobId, path.join(root, 'never.mp4'), context)]) await assert.rejects(call(), { code: 'MEDIA_CANCELLED' });
  assert.deepEqual(provider.stats(), { submissionCount: 1, taskCount: 1, downloadAttempts: 0, pollCount: 0 });
  db.close();
  await assert.rejects(provider.poll(providerJobId, context), { code: 'MEDIA_CANCELLED' });
  assert.deepEqual(await readdir(root), []);
});

test('real synthetic portrait, landscape, 4K and audio-only files retain probe/hash behavior', { timeout: 60000 }, async t => {
  const root = await sandbox(t);
  for (const [name, size] of [['portrait', '64x96'], ['landscape', '96x64'], ['4k', '3840x2160']]) {
    const file = path.join(root, `${name}.mp4`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=30`, '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', file]);
    const info = await fileInfo(file), [width, height] = size.split('x').map(Number);
    assert.equal(info.width, width); assert.equal(info.height, height); assert.equal(info.hasVideo, true); assert.equal(info.hasAudio, false); assert.match(info.sha256, /^[0-9a-f]{64}$/);
    await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  }
  const audioPath = path.join(root, 'tone.wav');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1', '-c:a', 'pcm_s16le', audioPath]);
  const info = await fileInfo(audioPath);
  assert.equal(info.hasAudio, true); assert.equal(info.hasVideo, false); assert.equal(info.width, 0); assert.equal(info.height, 0); assert.equal(info.duration, 0.1);
});

test('mock cancellation at renderer completion never renames or publishes a partial output', async t => {
  const root = await sandbox(t), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const provider = createMockProvider({ root, db }), controller = new AbortController();
  const { providerJobId } = await provider.submit({ duration: 2, aspectRatio: '9:16', parameters: { scenario: 'success', delayMs: 0 } }, { requestId: 'mock-completion-abort' });
  const events = [], off = onMediaProcess(event => { events.push(event); if (event.kind === 'ffmpeg' && event.type === 'exited') controller.abort(); });
  try {
    await assert.rejects(provider.download(providerJobId, path.join(root, 'never-published.mp4'), { signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(provider.stats(), { submissionCount: 1, taskCount: 1, downloadAttempts: 1, pollCount: 0 });
  } finally { off(); }
});

test('timeline cancellation between segments prevents another spawn and removes segment files', { timeout: 60000 }, async t => {
  const root = await sandbox(t), image = path.join(root, 'synthetic.png');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x96', '-frames:v', '1', '-threads', '1', image]);
  const timeline = { fps: 30, width: 720, height: 1280, durationFrames: 6,
    tracks: [{ id: 'video', kind: 'video', orderIndex: 0, hidden: false, muted: false }],
    clips: [0, 3].map((startFrame, i) => ({ id: `clip-${i}`, trackId: 'video', assetId: 'image', startFrame, durationFrames: 3, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 })) };
  const assets = new Map([['image', { path: image, mimeType: 'image/png', hasVideo: true, hasAudio: false, duration: 0 }]]);
  const events = [], controller = new AbortController();
  const off = onMediaProcess(event => { events.push(event); if (event.kind === 'ffmpeg' && event.type === 'exited') controller.abort(); });
  try {
    await assert.rejects(renderTimeline({ timeline }, assets, path.join(root, 'never.mp4'), { signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
    assert.deepEqual(await readdir(root), ['synthetic.png']);
  } finally { off(); }
});
