import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {compileTimeMap, initialTimeMap, timeMapSourceWindowForOutput, TIMELINE_TIME_MAP_BASIS_PROFILE} from '../packages/contracts/src/timeline-time-map.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {prepareReverseProxy, renderReverseProxy, REVERSE_PROXY_PROFILE} from '../packages/business/src/timeline-processing/reverse.ts';
import type {ReverseProxyInput} from '../packages/business/src/timeline-processing/reverse.ts';

const rate = 48_000;
const fps = {fpsNumerator: 30, fpsDenominator: 1};
const rawVideo = ['-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', '+yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo'];
const rawAudio = ['-c:a', 'pcm_f32le', '-f', 'f32le'];
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const coordinate = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const authority = (signal = new AbortController().signal) => ({signal, beforeEffect: () => {}});
const clip = (start: number, end: number) => {
  const map = compileTimeMap({profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: fps, outputFps: fps, sourceRange: {start: coordinate(start), end: coordinate(end)},
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}}});
  assert.ok(map.ok);
  const window = timeMapSourceWindowForOutput(initialTimeMap(map.value, 'reverse'));
  assert.ok(window.ok);
  return {sourceWindow: window.value, mapHash: map.value.mapHash, sourceFps: fps};
};
const runMedia = (args: string[]) => run('ffmpeg',
  ['-v', 'error', '-nostdin', '-filter_threads', '1', '-threads', '1', '-n', ...args], {timeout: 45_000});

async function outputBytes(source: string, args: string[], cap: number): Promise<Buffer> {
  const bytes: Buffer[] = [];
  await runStreaming('ffmpeg', ['-v', 'error', '-nostdin', '-xerror', '-noauto_conversion_filters', '-i', source,
    ...args, 'pipe:1'], {maxStdoutBytes: cap, onStdout: value => {bytes.push(value);}});
  return Buffer.concat(bytes);
}

async function workspace(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-reverse-proxy-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const staging = path.join(root, 'stage');
  await mkdir(staging, {mode: 0o700});
  return {root, staging};
}

async function fixture(t: test.TestContext, variable = false) {
  const {root, staging} = await workspace(t);
  const movie = path.join(root, 'synthetic.mp4');
  const pcm = path.join(root, 'source.f32le');
  const audio = Buffer.alloc(5 * rate * 8);
  for (let frame = 0; frame < 5 * rate; frame++) {
    audio.writeFloatLE(frame / (8 * rate), frame * 8);
    audio.writeFloatLE((-frame - 1) / (8 * rate), frame * 8 + 4);
  }
  await writeFile(pcm, audio, {mode: 0o600});
  await runMedia(['-f', 'lavfi', '-i', "nullsrc=s=48x32:r=30:d=5,format=yuv420p,geq=lum='mod(X+N*3,220)+16':cb='mod(N*7,200)+24':cr='mod(Y+N*11,200)+24'",
    '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', pcm, '-map', '0:v:0', '-map', '1:a:0',
    ...(variable ? ['-vf', "select='not(eq(mod(n,5),4))'", '-fps_mode', 'vfr'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', variable ? '17' : '0', '-g', '30', '-bf', variable ? '2' : '0', '-threads:v', '1',
    '-video_track_timescale', '30000', '-c:a', 'pcm_f32le', '-f', 'mov', movie]);
  return {staging, movie, audio};
}

function reverseRecords(input: Buffer, width: number, start: number, end: number): Buffer {
  const output = Buffer.alloc((end - start) * width);
  for (let source = end - 1, ordinal = 0; source >= start; source--, ordinal++) {
    input.copy(output, ordinal * width, source * width, (source + 1) * width);
  }
  return output;
}

for (const variable of [false, true]) {
  test(`real reverse proxy preserves ${variable ? 'VFR' : 'CFR'} bytes, native PTS and stereo samples across two-second chunks`, {timeout: 90_000}, async t => {
    const {staging, movie, audio} = await fixture(t, variable);
    const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(17, 147), media: 'video'};
    const options = authority();
    const prepared = await prepareReverseProxy(input, options);
    const events: number[] = [];
    const receipt = await renderReverseProxy(input, prepared, {...options, stagingDirectory: staging, onProgress: value => events.push(value)});
    assert.equal(receipt.profileId, REVERSE_PROXY_PROFILE);
    assert.equal(receipt.sampleCount, (147 - 17) * 1600);
    assert.equal(events.at(-1), 100);
    assert.ok(events.some(value => value >= 21 && value < 85));
    assert.deepEqual((await readdir(staging)).sort(), ['clock.json', 'frames.jsonl', 'proxy.mkv']);

    const proxy = path.join(staging, 'proxy.mkv');
    const nativeBytes = 48 * 32 * 3 / 2;
    const native = await outputBytes(movie, ['-map', '0:v:0', '-an', ...rawVideo], nativeBytes * 150);
    const ptsText = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp', '-of', 'csv=p=0', movie]);
    const pts = ptsText.split('\n').filter(Boolean).map(line => Number(line.split(',')[0]));
    const high = pts.findIndex(value => value >= 147_000);
    const low = pts.findLastIndex(value => value <= 17_000);
    assert.ok(high > low && low >= 0);
    assert.equal(receipt.frameCount, high - low);
    const expectedVideo = reverseRecords(native, nativeBytes, low, high);
    assert.equal(sha(await outputBytes(proxy, ['-map', '0:v:0', '-an', ...rawVideo], expectedVideo.length)), sha(expectedVideo));
    const expectedPcm = reverseRecords(audio, 8, 17 * 1600, 147 * 1600);
    assert.equal(sha(await outputBytes(proxy, ['-map', '0:a:0', '-vn', ...rawAudio], expectedPcm.length)), sha(expectedPcm));

    const frames = (await readFile(path.join(staging, 'frames.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(frames, Array.from({length: high - low}, (_, ordinal) => {
      const sourceOrdinal = high - 1 - ordinal;
      return {ordinal, sourceOrdinal, sourcePts: String(pts[sourceOrdinal]), proxyPts: String(ordinal)};
    }));
    for (const item of receipt.files) {
      const file = path.join(staging, item.fileName), info = await stat(file);
      assert.equal(sha(await readFile(file)), item.sha256);
      assert.equal(info.size, item.bytes);
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
    }
    const clock = JSON.parse(await readFile(path.join(staging, 'clock.json'), 'utf8'));
    assert.equal(clock.mapHash, input.mapHash);
    assert.equal(clock.audio.decodedSha256, sha(expectedPcm));
    assert.equal(clock.video.decodedSha256, sha(expectedVideo));
  });
}

test('four-slice FFV1 preserves the 16-bit alpha plane and colour interpretation', {timeout: 90_000}, async t => {
  const {root, staging} = await workspace(t);
  const movie = path.join(root, 'alpha.mkv');
  const color = ['-color_range', 'pc', '-colorspace', 'rgb', '-color_trc', 'bt709', '-color_primaries', 'bt709'];
  await runMedia(['-f', 'lavfi', '-i',
    "nullsrc=s=32x32:r=30:d=3,format=gbrap16le,geq=r='X+N':g='Y+71':b='X*4+Y*11':a='N*601+51'",
    '-c:v', 'ffv1', '-pix_fmt', '+gbrap16le', '-threads:v', '4', '-slices', '4', ...color, movie]);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(0, 90), media: 'video'};
  const opts = authority();
  const prepared = await prepareReverseProxy(input, opts);
  assert.equal(prepared.profile.video?.threads, 4);
  assert.equal(prepared.profile.video?.colour.color_range, 'pc');
  assert.equal(prepared.profile.video?.colour.color_space, 'gbr');
  const result = await renderReverseProxy(input, prepared, {...opts, stagingDirectory: staging});
  assert.equal(result.frameCount, 90);
  const args = ['-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', '+gbrap16le', '-f', 'rawvideo'];
  const frameBytes = 32 * 32 * 8;
  const native = await outputBytes(movie, args, frameBytes * 90);
  const reversed = await outputBytes(path.join(staging, 'proxy.mkv'), args, frameBytes * 90);
  assert.equal(sha(reversed), sha(reverseRecords(native, frameBytes, 0, 90)));
});

test('audio-only reverse keeps an exact 44.1 kHz window and channel order', {timeout: 60_000}, async t => {
  const {root, staging} = await workspace(t);
  const pcm = path.join(root, 'source.f32le'), movie = path.join(root, 'audio.wav');
  const sampleRate = 44_100, samplesPerFrame = sampleRate / 30;
  const samples = Buffer.alloc(3 * sampleRate * 8);
  for (let frame = 0; frame < samples.length / 8; frame++) {
    samples.writeFloatLE((frame % 12) / 16, frame * 8);
    samples.writeFloatLE(-(frame % 7) / 16, frame * 8 + 4);
  }
  await writeFile(pcm, samples);
  await runMedia(['-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', pcm, '-c:a', 'pcm_f32le', movie]);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(7, 81), media: 'audio'};
  const opts = authority();
  const prepared = await prepareReverseProxy(input, opts);
  const receipt = await renderReverseProxy(input, prepared, {...opts, stagingDirectory: staging});
  assert.equal(receipt.frameCount, 0);
  assert.equal(receipt.sampleCount, (81 - 7) * samplesPerFrame);
  assert.deepEqual((await readdir(staging)).sort(), ['clock.json', 'proxy.mkv']);
  const expected = reverseRecords(samples, 8, 7 * samplesPerFrame, 81 * samplesPerFrame);
  const output = await outputBytes(path.join(staging, 'proxy.mkv'), ['-map', '0:a:0', '-vn', ...rawAudio], expected.length);
  assert.equal(sha(output), sha(expected));
});

test('the lossless encoder refuses a source whose packet allocation cannot fit the process budget', {timeout: 60_000}, async t => {
  const {root, staging} = await workspace(t);
  const movie = path.join(root, 'oversize-encoder-input.mp4');
  await runMedia(['-f', 'lavfi', '-i', 'color=black:s=3840x2160:r=30', '-frames:v', '1', '-an',
    '-c:v', 'libx264', '-threads:v', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', movie]);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(0, 1), media: 'video'};
  await assert.rejects(prepareReverseProxy(input, authority()), {code: 'UNSUPPORTED_FORMAT'});
  assert.deepEqual(await readdir(staging), []);
});

test('reverse attempt retains the frozen input and reaps owned children after cancellation', {timeout: 60_000}, async t => {
  const {staging, movie} = await fixture(t);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(1, 147), media: 'video'};
  const prepared = await prepareReverseProxy(input, authority());
  await assert.rejects(renderReverseProxy({...input, sourceSha256: '0'.repeat(64)}, prepared, {...authority(), stagingDirectory: staging}),
    {code: 'SOURCE_UNAVAILABLE'});
  const controller = new AbortController(), live = new Set<number>();
  const removeObserver = onMediaProcess(event => {
    if (!event.pid) return;
    if (event.type === 'started') live.add(event.pid);
    else live.delete(event.pid);
  });
  t.after(() => {removeObserver();});
  await assert.rejects(renderReverseProxy(input, prepared, {...authority(controller.signal), stagingDirectory: staging,
    onProgress(percent) {if (percent > 20) controller.abort();}}), {code: 'MEDIA_CANCELLED'});
  assert.deepEqual([...live], []);
  assert.ok(!(await readdir(staging)).includes('clock.json'));
});

test('a killed helper leaves no completion evidence or running child', {timeout: 60_000}, async t => {
  const {staging, movie} = await fixture(t);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(9, 132), media: 'video'};
  const options = authority(), prepared = await prepareReverseProxy(input, options);
  const live = new Set<number>();
  let killed = false;
  const removeObserver = onMediaProcess(event => {
    if (!event.pid) return;
    if (event.type === 'exited') {live.delete(event.pid); return;}
    live.add(event.pid);
    if (!killed) {
      process.kill(event.pid, 'SIGKILL');
      killed = true;
    }
  });
  t.after(() => {removeObserver();});
  await assert.rejects(renderReverseProxy(input, prepared, {...options, stagingDirectory: staging}), {code: 'PROCESSING_FAILED'});
  assert.equal(killed, true);
  assert.deepEqual([...live], []);
  assert.ok(!(await readdir(staging)).includes('clock.json'));
});
