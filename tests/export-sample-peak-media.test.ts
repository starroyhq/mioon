import type {MediaProcessEvent} from '../packages/business/src/media-processes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once, getEventListeners} from 'node:events';
import {ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run, runStreaming, checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {withProbePermit, MEDIA_PROBE_LIMITS} from '../packages/business/src/media-probe.ts';
import {onMediaProcess, hasUnconfirmedMediaProcesses, terminateMediaProcesses} from '../packages/business/src/media-processes.ts';
import {createExportSamplePeakDecoder} from '../packages/business/src/export-sample-peak-decoder.ts';
import type { BinaryLike } from 'crypto';
import type { PathLike } from 'fs';

// Real local media tests are serialized by the parent test runner. Fixture
// creation is separate from analysis; each assertion checks the final AAC bytes.
const runtime = {run, runStreaming, checkMediaEffect, withProbePermit};
const decode = createExportSamplePeakDecoder(runtime);
const fixture = fileURLToPath(new URL('./helpers/media-child-fixture.ts', import.meta.url));
const options = (overrides = {}) => ({beforeEffect() {}, remainingMs: () => 120000, ...overrides});
const encode = (args: string[]) => run('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1', ...args],
  {timeout: 120000, maxStdoutBytes: 0, maxStderrBytes: 64 * 1024});
const hash = (bytes: NonSharedBuffer|BinaryLike) => createHash('sha256').update(bytes).digest('hex');
const safe = (code: string|string[]) => (error: {code:string;message:string}) => error.code === code && !error.message.includes('synthetic-private') && !Object.hasOwn(error, 'cause');
async function sandbox(t: test.TestContext) { const root = await mkdtemp(path.join(tmpdir(), 'mioon-sample-peak-')); t.after(() => rm(root, {recursive: true, force: true})); return root; }
function floatWave(seconds: number, sample: (arg0: number,arg1: number) => number, rate = 48000, channels = 2) {
  const frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28); bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    bytes.writeFloatLE(sample(frame / rate, channel), 44 + (frame * channels + channel) * 4);
  return bytes;
}
async function finalFile(root: string, name: string, seconds: number, sample: (time: number, channel: number) => number, {rate = 48000, channels = 2, audioFirst = false} = {}) {
  const wav = path.join(root, `${name}.wav`), file = path.join(root, `${name}.mp4`);
  await writeFile(wav, floatWave(seconds, sample, rate, channels));
  await encode(['-f', 'lavfi', '-i', `color=c=black:s=16x16:r=30:d=${seconds}`, '-f', 'wav', '-i', wav,
    '-map', audioFirst ? '1:a:0' : '0:v:0', '-map', audioFirst ? '0:v:0' : '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '192k', '-threads', '1', file]);
  return file;
}

/** Independent short-file reference: complete raw decode followed by DataView
 * indexing over all returned bytes, without the production accumulator/parser. */
async function reference(file: string) {
  const chunks: Buffer[] = [];
  const result = await runStreaming('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
  {timeout: 30000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 64 * 1024, onStdout(chunk) { chunks.push(Buffer.from(chunk)); }});
  const bytes = Buffer.concat(chunks, result.stdoutBytes), samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.ok(bytes.length > 0); assert.equal(bytes.length % 8, 0);
  const peaks = [0, 0];
  for (let index = 0; index < bytes.length / 4; index++) {
    const sample = samples.getFloat32(index * 4, true); assert.ok(Number.isFinite(sample));
    if (Math.abs(sample) > peaks[index % 2]) peaks[index % 2] = Math.abs(sample);
  }
  return {sampleFrames: bytes.length / 8, peaks, peakLinear: Math.max(...peaks)};
}
async function files(root: string) {
  return await Promise.all((await readdir(root)).sort().map(async name => {
    const info = await stat(path.join(root, name));
    return {name, size: info.size, mode: info.mode, sha256: hash(await readFile(path.join(root, name)))};
  }));
}

test('real final AAC peaks match independent PCM for silence, quiet, antiphase, asymmetric and overdrive/fades', {timeout: 120000}, async t => {
  const root = await sandbox(t), seconds = 0.4;
  const signals: [string, (time: number, channel: number) => number][] = [
    ['silence', () => 0],
    ['quiet', (time: number) => 0.08 * Math.sin(2 * Math.PI * 1000 * time)],
    ['antiphase', (time: number, channel: unknown) => (channel ? -0.65 : 0.65) * Math.sin(2 * Math.PI * 997 * time)],
    ['asymmetric', (time: number, channel: unknown) => (channel ? 0.7 : 0.17) * Math.sin(2 * Math.PI * 701 * time)],
    ['overdrive-fades', (time: number, channel: unknown) => Math.min(1, time / 0.04, (seconds - time) / 0.04) *
      ((channel ? 1.25 : 1.6) * Math.sin(2 * Math.PI * 697 * time) + 0.4 * Math.sin(2 * Math.PI * 1301 * time))],
  ];
  for (const [name, sample] of signals) {
    const file = await finalFile(root, name, seconds, sample, {audioFirst: name === 'asymmetric'});
    const expected = await reference(file), before = await files(root), events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => events.push(event));
    let measured;
    try { measured = await decode(file, seconds, options()); } finally { off(); }
    assert.deepEqual(measured.channelPeaks.map(channel => channel.peakLinear), expected.peaks);
    assert.equal(measured.peakLinear, expected.peakLinear); assert.equal(measured.sampleFrames, expected.sampleFrames);
    assert.equal(measured.peakDbfs, expected.peakLinear ? 20 * Math.log10(expected.peakLinear) : null);
    assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.kind), ['ffprobe', 'ffmpeg']);
    assert.equal(events.filter(event => event.type === 'exited').length, 2);
    assert.deepEqual(await files(root), before, 'analysis creates no file and changes no media bytes or modes');
    if (name === 'silence') assert.equal(measured.silent, true);
    if (name === 'asymmetric') assert.ok(measured.channelPeaks[1].peakLinear > measured.channelPeaks[0].peakLinear * 2);
    if (name === 'overdrive-fades') assert.equal(measured.overFullScale, true);
    t.diagnostic(JSON.stringify({fixture: name, sampleFrames: measured.sampleFrames, peakLinear: measured.peakLinear, channelPeaks: expected.peaks}));
  }
});

test('real AAC one-frame export retains its complete codec tail instead of trimming', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = await finalFile(root, 'one-frame', 1 / 30, (time: number) => 0.3 * Math.sin(2 * Math.PI * 440 * time));
  const expected = await reference(file), measured = await decode(file, 1 / 30, options());
  assert.equal(measured.sampleFrames, expected.sampleFrames); assert.equal(measured.peakLinear, expected.peakLinear);
  assert.ok(Math.abs(measured.sampleFrames - 1600) <= 4800);
  t.diagnostic(JSON.stringify({nominalFrames: 1600, decodedFrames: measured.sampleFrames}));
});

test('real AAC near and exact 600 second boundaries use natural EOF and the unchanged hard cap', {timeout: 120000}, async t => {
  const root = await sandbox(t);
  for (const seconds of [599.9, 600]) {
    const file = path.join(root, `silence-${seconds}.mp4`);
    await encode(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(seconds), '-c:a', 'aac', '-b:a', '128k', '-threads', '1', file]);
    // framecrc reports every decoded frame's full byte count at natural EOF,
    // so it can independently observe an AAC tail beyond the PCM byte cap.
    const crc = await run('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-i', file, '-map', '0:a:0',
      '-c:a', 'pcm_f32le', '-f', 'framecrc', 'pipe:1'], {timeout: 120000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 64 * 1024});
    let referenceBytes = 0;
    for (const line of crc.split('\n').filter(line => line && !line.startsWith('#'))) {
      const columns = line.split(',').map(value => value.trim());
      assert.ok(columns.length >= 6); const count = Number(columns[4]); assert.ok(Number.isSafeInteger(count) && count > 0); referenceBytes += count;
    }
    assert.equal(referenceBytes % 8, 0); assert.ok(Math.abs(referenceBytes / 8 - seconds * 48000) <= 4800);
    if (referenceBytes > 230400000) await assert.rejects(decode(file, seconds, options()), {code: 'MEDIA_OUTPUT_LIMIT'});
    else { const measured = await decode(file, seconds, options()); assert.equal(measured.sampleFrames, referenceBytes / 8); assert.equal(measured.peakLinear, 0); }
    t.diagnostic(JSON.stringify({seconds, referenceBytes, expected: referenceBytes > 230400000 ? 'incomplete-resource-limit' : 'ready'}));
  }
});

test('real probe rejects non-native audio, absent audio and multiple audio without decoding', {timeout: 60000}, async t => {
  const root = await sandbox(t), seconds = 0.2;
  const mono = await finalFile(root, 'mono', seconds, () => 0.2, {channels: 1});
  const rate = await finalFile(root, '44100', seconds, () => 0.2, {rate: 44100});
  const multiple = path.join(root, 'multiple.mp4'), silentVideo = path.join(root, 'no-audio.mp4');
  await encode(['-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`, '-map', '0:a:0', '-map', '0:a:0', '-c:a', 'aac', '-threads', '1', multiple]);
  await encode(['-f', 'lavfi', '-i', `color=s=16x16:r=30:d=${seconds}`, '-c:v', 'libx264', '-threads', '1', silentVideo]);
  for (const file of [mono, rate, multiple, silentVideo]) {
    const events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => events.push(event));
    try { await assert.rejects(decode(file, seconds, options()), {code: 'SAMPLE_PEAK_UNSUPPORTED_FORMAT'}); }
    finally { off(); }
    assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.kind), ['ffprobe']);
  }
});

test('real demux/protocol guard rejects disguised local-reference and network playlists', {timeout: 30000}, async t => {
  const root = await sandbox(t), audio = await finalFile(root, 'referenced', 0.2, () => 0.25);
  const concat = path.join(root, 'synthetic-private-concat.mp4'), hls = path.join(root, 'synthetic-private-hls.mp4');
  await writeFile(concat, `ffconcat version 1.0\nfile '${path.basename(audio)}'\n`);
  let requests = 0; const server = createServer((_, response) => { requests++; response.writeHead(404); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeFile(hls, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${(server.address()! as import('node:net').AddressInfo).port}/segment.ts\n#EXT-X-ENDLIST\n`);
  for (const file of [concat, hls]) await assert.rejects(decode(file, 0.2, options()), safe('MEDIA_EXIT_FAILED'));
  assert.equal(requests, 0);
});

test('real changing-channel AAC in MP4 fails rather than silently downmixing or rebuilding filters', {timeout: 30000}, async t => {
  const root = await sandbox(t), stereo = path.join(root, 'first-stereo.aac'), mono = path.join(root, 'last-mono.aac');
  const combined = path.join(root, 'changing.aac'), file = path.join(root, 'changing.mp4');
  await encode(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '9', '-c:a', 'aac', '-f', 'adts', stereo]);
  // An in-band program config element survives MP4 remuxing. Merely changing
  // the second ADTS header loses that change when the muxer strips headers.
  await encode(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.2', '-c:a', 'aac', '-aac_pce', '1', '-f', 'adts', mono]);
  await writeFile(combined, Buffer.concat([await readFile(stereo), await readFile(mono)]));
  await encode(['-i', combined, '-c:a', 'copy', file]);
  const frames = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_frames',
    '-show_entries', 'frame=channels,channel_layout:format=duration', '-of', 'json', file],
  {timeout: 30000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024}));
  const actualChannels = [...new Set(frames.frames.map((frame: { channels: unknown; }) => frame.channels))];
  assert.deepEqual(actualChannels, [2, 1], 'fixture must independently prove a channel change inside its final MP4');
  // The ordinary reinitializing decode accepts this file. The stricter
  // production command must reject the same change at its fixed input graph.
  assert.ok((await reference(file)).sampleFrames > 0);
  const duration = Number(frames.format.duration), events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => events.push(event));
  try { await assert.rejects(decode(file, duration, options()), {code: 'MEDIA_EXIT_FAILED'}); }
  finally { off(); }
  assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.kind), ['ffprobe', 'ffmpeg']);
  t.diagnostic(JSON.stringify({formatChangeChannels: actualChannels, duration, processes: events.filter(event => event.type === 'started').map(event => event.kind)}));
});

test('global probe queue performs the ownership fence after acquisition and before actual spawn', {timeout: 30000}, async () => {
  const releases: ((value?: unknown) => void)[] = [], entered: (true)[] = [];
  const blockers = Array.from({length: MEDIA_PROBE_LIMITS.concurrent}, () => withProbePermit(undefined, async () => {
    entered.push(true); await new Promise(resolve => releases.push(resolve));
  }));
  while (entered.length < MEDIA_PROBE_LIMITS.concurrent) await new Promise(resolve => setImmediate(resolve));
  let revoked = false; const events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => events.push(event));
  const failure = Object.assign(Error('Owned artifact changed'), {code: 'SAMPLE_PEAK_SCOPE'});
  const pending = assert.rejects(decode('/synthetic-private/nonexistent.mp4', 0.2, options({beforeEffect() { if (revoked) throw failure; }})), error => error === failure);
  try { revoked = true; releases.forEach(release => release()); await Promise.all([...blockers, pending]); assert.deepEqual((events as unknown), []); }
  finally { releases.forEach(release => release()); off(); }
});

test('real streaming callback ownership failure preserves the exact error and reaps its child', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = await finalFile(root, 'ownership', 0.2, () => 0.25), controller = new AbortController();
  let decoding = false; const events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => { events.push(event); if (event.type === 'started' && event.kind === 'ffmpeg') decoding = true; });
  const denied = Object.assign(Error('Owned artifact changed'), {code: 'SAMPLE_PEAK_SCOPE'});
  try { await assert.rejects(decode(file, 0.2, options({signal: controller.signal, beforeEffect() { if (decoding) throw denied; }})), error => error === denied); }
  finally { off(); }
  assert.deepEqual(events.map(event => event.type), ['started', 'exited', 'started', 'exited']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.throws(() => process.kill(events.at(-1)!.pid!, 0), {code: 'ESRCH'});
});

test('real decoder cancellation and deadline only reap the advisory analysis child', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = await finalFile(root, 'cancellation', 0.2, () => 0.25);
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(), events: (MediaProcessEvent)[] = [], off = onMediaProcess(event => {
      events.push(event); if (mode === 'abort' && event.kind === process.execPath && event.type === 'started') controller.abort();
    });
    const adapter = createExportSamplePeakDecoder({...runtime, runStreaming(command, args, options) {
      return runStreaming(process.execPath, [fixture, 'wait'], {...options, timeout: mode === 'timeout' ? 50 : 10000});
    }});
    try { await assert.rejects(adapter(file, 0.2, options({signal: controller.signal})), safe(mode === 'abort' ? 'MEDIA_CANCELLED' : 'MEDIA_TIMEOUT')); }
    finally { off(); controller.abort(); }
    assert.equal(events.filter(event => event.type === 'started').length, 2);
    assert.equal(events.filter(event => event.type === 'exited').length, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('real streaming nonzero close, stderr cap and nonfinite PCM never return a measurement', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = await finalFile(root, 'failure', 0.2, () => 0.25);
  for (const [args, code] of [[[fixture, 'fail'], 'MEDIA_EXIT_FAILED'], [[fixture, 'flood', 'stderr', '131072'], 'MEDIA_OUTPUT_LIMIT'],
    [['-e', 'const b=Buffer.alloc(8); b.writeFloatLE(NaN); process.stdout.write(b);'], 'SAMPLE_PEAK_INVALID_PCM']] as const) {
    const adapter = createExportSamplePeakDecoder({...runtime, runStreaming(command, original, options) { return runStreaming(process.execPath, args, options); }});
    await assert.rejects(adapter(file, 0.2, options()), safe(code));
  }
  assert.deepEqual((await terminateMediaProcesses() as unknown), []);
});

test('real callback poison preserves terminationUnconfirmed until the exact child closes', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = await finalFile(root, 'unconfirmed', 0.2, () => 0.25);
  const originalEmit = ChildProcess.prototype.emit as (this: ChildProcess, event: string, ...values: unknown[]) => boolean, originalKill = ChildProcess.prototype.kill;
  let owned!: ChildProcess, deferredClose: unknown[] | undefined, intercept: {mock:{restore():void}} | undefined;
  const adapter = createExportSamplePeakDecoder({...runtime, runStreaming(command, args, options) {
    intercept = t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string, ...values: unknown[]) {
      if (event === 'close') { owned = this; deferredClose = values; return true; }
      return originalEmit.call(this, event, ...values);
    });
    return runStreaming(process.execPath, ['-e', 'const b=Buffer.alloc(8); b.writeFloatLE(NaN); process.stdout.write(b);'], options);
  }});
  try {
    await assert.rejects(adapter(file, 0.2, options()), {code: 'SAMPLE_PEAK_INVALID_PCM', terminationUnconfirmed: true});
    assert.ok(deferredClose); assert.equal(hasUnconfirmedMediaProcesses(), true);
    intercept!.mock.restore(); originalEmit.call(owned, 'close', ...deferredClose); deferredClose = undefined;
    assert.equal(hasUnconfirmedMediaProcesses(), false);
  } finally {
    intercept?.mock.restore();
    if (deferredClose) originalEmit.call(owned, 'close', ...deferredClose);
    if (owned?.exitCode === null && owned?.signalCode === null) { const closed = once(owned, 'close'); originalKill.call(owned, 'SIGKILL'); await closed; }
  }
});
