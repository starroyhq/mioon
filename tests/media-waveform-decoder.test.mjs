import test from 'node:test';
import assert from 'node:assert/strict';
import { once, getEventListeners } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runStreaming, MEDIA_RUNTIME_LIMITS } from '../packages/business/src/media-runtime.ts';
import { onMediaProcess, terminateMediaProcesses, hasUnconfirmedMediaProcesses } from '../packages/business/src/media-processes.ts';
import { createWaveformAccumulator, decodeWaveform, WAVEFORM_DECODE_LIMITS } from '../packages/business/src/waveform-decoder.ts';

const fixture = fileURLToPath(new URL('./helpers/media-child-fixture.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantize = value => Math.round(Math.min(1, value) * 65535);
const safeCode = code => error => error.code === code && !error.message.includes('synthetic-private') && !Object.hasOwn(error, 'cause');
async function sandbox(t) { const root = await mkdtemp(path.join(tmpdir(), 'waveform-decode-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function ready(file) { const end = Date.now() + 5000; while (Date.now() < end) { if (await stat(file).catch(() => null)) return; await pause(10); } throw Error('Synthetic child did not become ready'); }
function pcm(frames, channels, sample) {
  const bytes = Buffer.alloc(frames * channels * 4);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) bytes.writeFloatLE(sample(frame, channel), (frame * channels + channel) * 4);
  return bytes;
}
function floatWave(frames, channels, sample, rate = 48000) {
  const data = pcm(frames, channels, sample), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('incremental mono bins preserve unaligned float bytes and the final partial bin', () => {
  const bytes = pcm(961, 1, frame => frame < 480 ? -0.25 : frame < 960 ? 0.5 : -0.75);
  for (const sizes of [[1], [3, 7, 4, 13, 1], [479, 480, 481, 5000], [bytes.length]]) {
    const accumulator = createWaveformAccumulator({ channels: 1, duration: 961 / 48000 });
    let offset = 0, index = 0;
    while (offset < bytes.length) {
      const size = sizes[index++ % sizes.length];
      accumulator.write(bytes.subarray(offset, offset + size)); offset += size;
      accumulator.write(Buffer.alloc(0));
    }
    const result = accumulator.finish();
    assert.ok(result.peaks instanceof Uint16Array);
    assert.deepEqual([...result.peaks], [quantize(0.25), quantize(0.5), quantize(0.75)]);
    assert.equal(result.clipped, false); assert.equal(result.sampleFrames, 961);
    assert.throws(() => accumulator.finish(), { code: 'WAVEFORM_INVALID_PCM' });
  }
});

test('stereo reduction keeps channel/frame boundaries and never cancels opposite phase', () => {
  const bytes = pcm(960, 2, (frame, channel) => (channel ? -1 : 1) * (frame < 480 ? 0.5 : 0.75));
  for (const size of [1, 3, 4, 7, 8, 13, 3839, bytes.length]) {
    const accumulator = createWaveformAccumulator({ channels: 2, duration: 0.02 });
    for (let offset = 0; offset < bytes.length; offset += size) accumulator.write(bytes.subarray(offset, offset + size));
    assert.deepEqual(accumulator.finish(), { peaks: new Uint16Array([32768, 49151]), clipped: false, sampleFrames: 960 });
  }
});

test('full scale is stable; any finite magnitude is accepted and values above one are marked clipped', () => {
  for (const [amplitude, clipped] of [[0, false], [1, false], [1.0001, true], [3.4028234663852886e38, true]]) {
    const accumulator = createWaveformAccumulator({ channels: 2, duration: 0.01 });
    accumulator.write(pcm(480, 2, (_, channel) => channel ? -amplitude : amplitude));
    const result = accumulator.finish();
    assert.equal(result.peaks[0], quantize(amplitude)); assert.equal(result.clipped, clipped);
  }
});

test('nonfinite PCM, empty input, partial floats and incomplete stereo frames never succeed', () => {
  for (const sample of [NaN, Infinity, -Infinity]) {
    const accumulator = createWaveformAccumulator({ channels: 1, duration: 0.01 });
    assert.throws(() => accumulator.write(pcm(480, 1, () => sample)), { code: 'WAVEFORM_INVALID_PCM' });
    assert.throws(() => accumulator.finish(), { code: 'WAVEFORM_INVALID_PCM' });
  }
  for (const [channels, byteLength] of [[1, 0], [1, 1], [1, 5], [2, 4], [2, 7], [2, 11]]) {
    const accumulator = createWaveformAccumulator({ channels, duration: 0.01 });
    accumulator.write(Buffer.alloc(byteLength));
    assert.throws(() => accumulator.finish(), { code: 'WAVEFORM_INVALID_PCM' });
  }
});

test('duration tolerance is explicit and rejects otherwise whole-frame truncated decodes', () => {
  assert.equal(WAVEFORM_DECODE_LIMITS.durationToleranceSeconds, 0.1);
  for (const difference of [-4801, 4801]) {
    const accumulator = createWaveformAccumulator({ channels: 1, duration: 1 });
    accumulator.write(pcm(48000 + difference, 1, () => 0));
    assert.throws(() => accumulator.finish(), { code: 'WAVEFORM_DURATION_MISMATCH' });
  }
  for (const difference of [-4800, 4800]) {
    const accumulator = createWaveformAccumulator({ channels: 1, duration: 1 });
    accumulator.write(pcm(48000 + difference, 1, () => 0));
    assert.equal(accumulator.finish().sampleFrames, 48000 + difference);
  }
});

test('PCM storage is bounded to 60000 bins and a byte over 600 seconds is rejected without truncation', () => {
  for (const channels of [1, 2]) {
    const accumulator = createWaveformAccumulator({ channels, duration: 600 });
    const oneSecond = Buffer.alloc(48000 * channels * 4);
    for (let second = 0; second < 600; second++) accumulator.write(oneSecond);
    const result = accumulator.finish();
    assert.equal(result.peaks.length, 60000); assert.equal(result.sampleFrames, 28800000);
    assert.equal(result.peaks.every(value => value === 0), true);
    // A separate live accumulator proves excess bytes fail, rather than merely
    // invoking write() after the accumulator has already been finalized.
    const excess = createWaveformAccumulator({ channels, duration: 600 });
    for (let second = 0; second < 600; second++) excess.write(oneSecond);
    assert.throws(() => excess.write(Buffer.from([0])), { code: 'MEDIA_OUTPUT_LIMIT' });
    assert.throws(() => excess.finish(), { code: 'MEDIA_OUTPUT_LIMIT' });
  }
});

test('decoder rejects invalid bounds, protocol inputs and already-aborted work before any spawn', async () => {
  const events = [], off = onMediaProcess(event => events.push(event));
  try {
    for (const options of [{ channels: 0, duration: 1 }, { channels: 3, duration: 1 }, { channels: 1, duration: 0 }, { channels: 1, duration: 600.01 }, { channels: 1, duration: NaN }]) {
      await assert.rejects(decodeWaveform('/synthetic-private/audio.wav', options), { code: 'MEDIA_INVALID_CONFIGURATION' });
    }
    for (const file of ['https://example.invalid/audio.wav', 'pipe:0', 'concat:a|b', '', 'bad\0file']) {
      await assert.rejects(decodeWaveform(file, { channels: 1, duration: 1 }), { code: 'MEDIA_INVALID_CONFIGURATION' });
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(decodeWaveform('/synthetic-private/audio.wav', { channels: 1, duration: 1, signal: controller.signal }), { code: 'MEDIA_CANCELLED' });
    assert.deepEqual(events, []);
  } finally { off(); }
});

test('streaming runner consumes binary stdout beyond the buffered cap without weakening run()', async () => {
  const bytes = MEDIA_RUNTIME_LIMITS.stdoutBytes + 1;
  let total = 0, chunks = 0;
  const result = await runStreaming(process.execPath, ['-e', `process.stdout.write(Buffer.alloc(${bytes}, 255))`], {
    maxStdoutBytes: bytes,
    onStdout(chunk) { assert.ok(Buffer.isBuffer(chunk)); assert.equal(chunk[0], 255); total += chunk.length; chunks++; },
  });
  assert.deepEqual(result, { stdoutBytes: bytes }); assert.equal(total, bytes); assert.ok(chunks > 1);
  await assert.rejects(run(process.execPath, [fixture, 'stdout', 'x'], { maxStdoutBytes: bytes }), { code: 'MEDIA_INVALID_CONFIGURATION' });
  await assert.rejects(runStreaming(process.execPath, [], { onStdout() {}, maxStdoutBytes: MEDIA_RUNTIME_LIMITS.streamingStdoutBytes + 1 }), { code: 'MEDIA_INVALID_CONFIGURATION' });
  await assert.rejects(runStreaming(process.execPath, [], {}), { code: 'MEDIA_INVALID_CONFIGURATION' });
});

test('streaming byte budgets count binary bytes exactly and abort before spawn remains side-effect free', async () => {
  const bytes = Buffer.from([0, 255, 128, 10]), received = [], events = [], off = onMediaProcess(event => events.push(event));
  try {
    assert.deepEqual(await runStreaming(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`], {
      maxStdoutBytes: bytes.length, onStdout(chunk) { received.push(...chunk); },
    }), { stdoutBytes: 4 });
    assert.deepEqual(received, [...bytes]);
    await assert.rejects(runStreaming(process.execPath, [fixture, 'stdout', '12345'], { maxStdoutBytes: 4, onStdout() {} }), { code: 'MEDIA_OUTPUT_LIMIT' });
    const before = events.length, controller = new AbortController(); controller.abort();
    await assert.rejects(runStreaming(process.execPath, [fixture, 'stdout', 'never'], { signal: controller.signal, onStdout() {} }), { code: 'MEDIA_CANCELLED' });
    assert.equal(events.length, before); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { off(); }
});

test('streaming runner enforces stdout/stderr limits and synchronously failing consumers are safely reaped', async () => {
  const cases = [
    { mode: 'flood', args: ['stdout', '131072'], onStdout() {}, code: 'MEDIA_OUTPUT_LIMIT' },
    { mode: 'flood', args: ['stderr', '131072'], onStdout() {}, code: 'MEDIA_OUTPUT_LIMIT' },
    { mode: 'flood', args: ['stdout', '4'], onStdout() { throw Error('synthetic-private-consumer-error'); }, code: 'MEDIA_STREAM_FAILED' },
    { mode: 'flood', args: ['stdout', '4'], async onStdout() { throw Error('synthetic-private-async-error'); }, code: 'MEDIA_INVALID_CONFIGURATION' },
  ];
  for (const current of cases) {
    const events = [], off = onMediaProcess(event => events.push(event)), controller = new AbortController();
    try {
      await assert.rejects(runStreaming(process.execPath, [fixture, current.mode, ...current.args], {
        onStdout: current.onStdout, maxStdoutBytes: 4096, maxStderrBytes: 4096, signal: controller.signal,
      }), safeCode(current.code));
      assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
      assert.equal(events[0].pid, events[1].pid); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { controller.abort(); off(); }
  }
});

test('streaming spawn/exit errors are sanitized and do not leave active children or signal listeners', async () => {
  const controller = new AbortController();
  await assert.rejects(runStreaming(path.join(tmpdir(), 'synthetic-private-missing-command'), [], { onStdout() {}, signal: controller.signal }), safeCode('MEDIA_SPAWN_FAILED'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(runStreaming(process.execPath, [fixture, 'fail'], { onStdout() {}, signal: controller.signal }), safeCode('MEDIA_EXIT_FAILED'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(await terminateMediaProcesses(), []);
});

test('streaming timeout/abort reap owned children and remove abort listeners', async t => {
  const root = await sandbox(t);
  for (const reason of ['timeout', 'abort']) {
    const events = [], off = onMediaProcess(event => events.push(event)), controller = new AbortController();
    const marker = path.join(root, reason);
    try {
      const result = runStreaming(process.execPath, [fixture, 'wait', marker], { onStdout() {}, signal: controller.signal, timeout: reason === 'timeout' ? 100 : 5000 });
      const rejected = assert.rejects(result, safeCode(reason === 'timeout' ? 'MEDIA_TIMEOUT' : 'MEDIA_CANCELLED'));
      if (reason === 'abort') { await ready(marker); controller.abort(); }
      await rejected;
      assert.deepEqual(events.map(event => event.type), ['started', 'exited']);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.throws(() => process.kill(events[0].pid, 0), { code: 'ESRCH' });
    } finally { controller.abort(); off(); }
  }
});

test('streaming legacy shutdown preserves terminationUnconfirmed and the new-spawn gate until real close', async t => {
  const root = await sandbox(t), marker = path.join(root, 'unconfirmed');
  const originalKill = ChildProcess.prototype.kill, events = [], off = onMediaProcess(event => events.push(event));
  let owned;
  const intercept = t.mock.method(ChildProcess.prototype, 'kill', function () { owned = this; return false; });
  try {
    const result = runStreaming(process.execPath, [fixture, 'wait', marker], { onStdout() {} });
    const rejected = assert.rejects(result, { code: 'MEDIA_CANCELLED', terminationUnconfirmed: true });
    await ready(marker);
    assert.deepEqual(await terminateMediaProcesses(), [{ status: 'unconfirmed', forced: true }]);
    await rejected;
    assert.deepEqual(events.map(event => event.type), ['started']); assert.equal(hasUnconfirmedMediaProcesses(), true);
    await assert.rejects(runStreaming(process.execPath, [fixture, 'stdout', 'blocked'], { onStdout() {} }), { code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true });
    intercept.mock.restore();
    const closed = once(owned, 'close'); originalKill.call(owned, 'SIGKILL'); await closed;
    assert.deepEqual(events.map(event => event.type), ['started', 'exited']); assert.equal(hasUnconfirmedMediaProcesses(), false);
  } finally { intercept.mock.restore(); if (owned?.exitCode === null && owned?.signalCode === null) originalKill.call(owned, 'SIGKILL'); off(); }
});

test('real FFmpeg decodes mono, opposite-phase stereo, clipping and resampled audio', async t => {
  const root = await sandbox(t), controller = new AbortController();
  for (const [name, channels, amplitude, rate] of [['mono', 1, 0.25, 48000], ['anti-phase', 2, 0.75, 48000], ['clipped', 2, 1.5, 48000], ['resampled', 1, 0.5, 44100]]) {
    const file = path.join(root, `${name}.wav`), duration = 0.04;
    await writeFile(file, floatWave(Math.round(rate * duration), channels, (_, channel) => channel ? -amplitude : amplitude, rate));
    const decoded = await decodeWaveform(file, { channels, duration, signal: controller.signal });
    assert.equal(decoded.sampleFrames, 1920); assert.equal(decoded.peaks.length, 4);
    for (const peak of decoded.peaks) assert.ok(Math.abs(peak - quantize(amplitude)) <= 1);
    assert.equal(decoded.clipped, amplitude > 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('real FFmpeg selects only the first audio stream and rejects malformed/duration-mismatched audio', async t => {
  const root = await sandbox(t), file = path.join(root, 'two-audio-streams.mka');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-f', 'lavfi', '-i', 'aevalsrc=0.25:s=48000:d=0.04', '-f', 'lavfi', '-i', 'aevalsrc=0.75:s=48000:d=0.04',
    '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_f32le', '-threads', '1', file]);
  const decoded = await decodeWaveform(file, { channels: 1, duration: 0.04 });
  assert.equal(decoded.sampleFrames, 1920); assert.deepEqual([...decoded.peaks], [16384, 16384, 16384, 16384]);
  await assert.rejects(decodeWaveform(file, { channels: 1, duration: 1 }), { code: 'WAVEFORM_DURATION_MISMATCH' });
  const bad = path.join(root, 'nonfinite.wav'); await writeFile(bad, floatWave(480, 1, () => NaN));
  await assert.rejects(decodeWaveform(bad, { channels: 1, duration: 0.01 }), { code: 'WAVEFORM_INVALID_PCM' });
  const invalid = path.join(root, 'invalid.wav'); await writeFile(invalid, 'synthetic-private-malformed-audio');
  await assert.rejects(decodeWaveform(invalid, { channels: 1, duration: 1 }), safeCode('MEDIA_EXIT_FAILED'));
});

test('real FFmpeg MP4 selects the first audio stream while ignoring video and the second louder audio stream', async t => {
  const root = await sandbox(t), file = path.join(root, 'video-two-audio-streams.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30:d=0.2',
    '-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*1000*t):s=48000:d=0.2',
    '-f', 'lavfi', '-i', 'aevalsrc=0.8*sin(2*PI*1000*t):s=48000:d=0.2',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '128k', '-threads', '1', file]);
  const decoded = await decodeWaveform(file, { channels: 1, duration: 0.2 });
  assert.ok(Math.abs(decoded.sampleFrames - 9600) <= 4800);
  assert.ok(decoded.peaks.some(peak => peak > 8000));
  assert.ok(decoded.peaks.every(peak => peak < 20000), 'the second stream must not be mixed into the first');
  assert.equal(decoded.clipped, false);
});

test('real FFmpeg container allowlist rejects valid local concat and HLS reference playlists', async t => {
  const root = await sandbox(t), audio = path.join(root, 'referenced.wav');
  await writeFile(audio, floatWave(1920, 1, () => 0.25));
  const concat = path.join(root, 'synthetic-private-local.ffconcat');
  await writeFile(concat, "ffconcat version 1.0\nfile 'referenced.wav'\n");
  // This is a valid local-reference container that ordinary FFmpeg can open.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', concat, '-vn', '-threads', '1', '-f', 'null', '-']);
  await assert.rejects(decodeWaveform(concat, { channels: 1, duration: 0.04 }), safeCode('MEDIA_EXIT_FAILED'));
  const hls = path.join(root, 'synthetic-private-local.m3u8');
  await writeFile(hls, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:0.04,\nreferenced.wav\n#EXT-X-ENDLIST\n');
  await assert.rejects(decodeWaveform(hls, { channels: 1, duration: 0.04 }), safeCode('MEDIA_EXIT_FAILED'));
});

test('decoder keeps terminationUnconfirmed when rejecting nonfinite PCM before child close is confirmed', async t => {
  const root = await sandbox(t), file = path.join(root, 'nonfinite-unconfirmed.wav');
  await writeFile(file, floatWave(480, 1, () => NaN));
  const originalEmit = ChildProcess.prototype.emit, originalKill = ChildProcess.prototype.kill;
  let owned, deferredClose;
  const intercept = t.mock.method(ChildProcess.prototype, 'emit', function (event, ...args) {
    if (event === 'close') { owned = this; deferredClose = args; return true; }
    return originalEmit.call(this, event, ...args);
  });
  try {
    await assert.rejects(decodeWaveform(file, { channels: 1, duration: 0.01 }), { code: 'WAVEFORM_INVALID_PCM', terminationUnconfirmed: true });
    assert.ok(deferredClose); assert.equal(hasUnconfirmedMediaProcesses(), true);
    intercept.mock.restore(); originalEmit.call(owned, 'close', ...deferredClose);
    assert.equal(hasUnconfirmedMediaProcesses(), false);
  } finally {
    intercept.mock.restore();
    if (deferredClose) originalEmit.call(owned, 'close', ...deferredClose);
    if (owned?.exitCode === null && owned?.signalCode === null) originalKill.call(owned, 'SIGKILL');
  }
});

test('real FFmpeg protocol allowlist blocks a local playlist from fetching HTTP segments', async t => {
  const root = await sandbox(t); let requests = 0;
  const server = createServer((_, response) => { requests++; response.writeHead(404); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const file = path.join(root, 'remote-segment.m3u8');
  await writeFile(file, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nhttp://127.0.0.1:${server.address().port}/segment.ts\n#EXT-X-ENDLIST\n`);
  await assert.rejects(decodeWaveform(file, { channels: 1, duration: 1 }), { code: 'MEDIA_EXIT_FAILED' });
  assert.equal(requests, 0);
});
