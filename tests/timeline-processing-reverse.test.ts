import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {compileTimeMap, initialTimeMap, restoreTimeMap, timeMapSourceWindowForOutput, TIMELINE_TIME_MAP_BASIS_PROFILE} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {prepareReverseProxy, renderReverseProxy, reverseAudioCoverage, REVERSE_PROXY_COVERAGE_VERSION, REVERSE_PROXY_PROFILE} from '../packages/business/src/timeline-processing/reverse.ts';
import type {ReverseProxyInput} from '../packages/business/src/timeline-processing/reverse.ts';
import {reverseProxyDiskBudget} from '../packages/business/src/timeline-processing/reverse-profile.ts';
import {reverseError, runReverseTool} from '../packages/business/src/timeline-processing/reverse-io.ts';

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

async function fixture(t: test.TestContext, variable = false, pictureStartSeconds = 0) {
  const {root, staging} = await workspace(t);
  const movie = path.join(root, 'synthetic.mp4');
  const pcm = path.join(root, 'source.f32le');
  const audio = Buffer.alloc(5 * rate * 8);
  for (let frame = 0; frame < 5 * rate; frame++) {
    audio.writeFloatLE(frame / (8 * rate), frame * 8);
    audio.writeFloatLE((-frame - 1) / (8 * rate), frame * 8 + 4);
  }
  await writeFile(pcm, audio, {mode: 0o600});
  await runMedia([...(pictureStartSeconds ? ['-copyts', '-itsoffset', String(pictureStartSeconds)] : []),
    '-f', 'lavfi', '-i', "nullsrc=s=48x32:r=30:d=5,format=yuv420p,geq=lum='mod(X+N*3,220)+16':cb='mod(N*7,200)+24':cr='mod(Y+N*11,200)+24'",
    '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', pcm, '-map', '0:v:0', '-map', '1:a:0',
    ...(variable ? ['-vf', "select='not(eq(mod(n,5),4))'", '-fps_mode', 'vfr'] : []),
    ...(pictureStartSeconds && !variable ? ['-fps_mode', 'passthrough'] : []),
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

test('reverse 2× preserve-pitch proxy keeps the additional 48 kHz history with unchanged video ordinals', {timeout: 90_000}, async t => {
  const {staging, movie, audio} = await fixture(t);
  const timing: ClipTiming = {profile: 'timeline-speed-v1',
    basis: {profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: fps, outputFps: fps,
      sourceRange: {start: coordinate(7), end: coordinate(71)}, speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}}},
    view: {direction: 'reverse', loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
    outputWindow: {fromFrame: 0, toFrame: 32}, pitchShift: false, interpolation: 'off'};
  const root = compileTimeMap(timing.basis);
  assert.ok(root.ok);
  const plan = restoreTimeMap(root.value, {...timing.view, outputWindow: timing.outputWindow});
  assert.ok(plan.ok);
  const window = timeMapSourceWindowForOutput(plan.value);
  assert.ok(window.ok);
  assert.deepEqual([window.value.startFrame, window.value.endFrame], [8, 71]);
  const coverage = reverseAudioCoverage(plan.value, timing);
  assert.deepEqual(coverage, {fromSample: 11_200, toSample: 113_600});
  assert.deepEqual(reverseAudioCoverage(plan.value, {...timing, pitchShift: true}), coverage);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), sourceWindow: window.value,
    sourceFps: fps, mapHash: root.value.mapHash, media: 'video', audioWindow: coverage};
  const options = authority();
  const prepared = await prepareReverseProxy(input, options);
  const result = await renderReverseProxy(input, prepared, {...options, stagingDirectory: staging});
  assert.equal(result.frameCount, 63);
  assert.equal(result.sampleCount, 102_400);
  const pcm = await outputBytes(path.join(staging, 'proxy.mkv'), ['-map', '0:a:0', '-vn', ...rawAudio], result.sampleCount * 8);
  assert.deepEqual(pcm, reverseRecords(audio, 8, 11_200, 113_600));
  assert.deepEqual(pcm.subarray(0, 8), audio.subarray(113_599 * 8, 113_600 * 8));
  assert.deepEqual(pcm.subarray(-8), audio.subarray(11_200 * 8, 11_201 * 8));
  const clock = JSON.parse(await readFile(path.join(staging, 'clock.json'), 'utf8'));
  assert.deepEqual(clock.sourceWindow, window.value);
  assert.equal(clock.profile.coverageVersion, REVERSE_PROXY_COVERAGE_VERSION);
  assert.deepEqual(clock.audio.sourceCoverage, coverage);
  assert.deepEqual(clock.audio.sourceZero, {streamIndex: 0, pts: '0', timeBase: {numerator: 1, denominator: 30_000}});
  const index = (await readFile(path.join(staging, 'frames.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(index.map(row => row.sourceOrdinal), Array.from({length: 63}, (_, ordinal) => 70 - ordinal));
});

test('reverse audio coverage rounds fractional tempo tails and bounds cubic history to the source', () => {
  const rational = (numerator: number, denominator: number) => ({kind: 'rational' as const, numerator: String(numerator), denominator: String(denominator)});
  const timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}> = {profile: 'timeline-speed-v1',
    basis: {profile: TIMELINE_TIME_MAP_BASIS_PROFILE, sourceFps: fps, outputFps: fps,
      sourceRange: {start: rational(22, 3), end: rational(499, 7)}, speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}}},
    view: {direction: 'reverse', loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
    outputWindow: {fromFrame: 3, toFrame: 25}, pitchShift: false, interpolation: 'off'};
  const root = compileTimeMap(timing.basis);
  assert.ok(root.ok);
  const plan = restoreTimeMap(root.value, {...timing.view, outputWindow: timing.outputWindow});
  assert.ok(plan.ok);
  assert.deepEqual(reverseAudioCoverage(plan.value, timing), {fromSample: 11_734, toSample: 114_058});
  const shifted = reverseAudioCoverage(plan.value, {...timing, pitchShift: true});
  assert.deepEqual(shifted, {fromSample: 34_054, toSample: 104_460});

  const odd = {...timing, basis: {...timing.basis, sourceRange: {start: coordinate(7), end: coordinate(72)}},
    outputWindow: {fromFrame: 0, toFrame: 33}};
  const oddRoot = compileTimeMap(odd.basis);
  assert.ok(oddRoot.ok);
  const oddPlan = restoreTimeMap(oddRoot.value, {...odd.view, outputWindow: odd.outputWindow});
  assert.ok(oddPlan.ok);
  assert.equal(reverseAudioCoverage(oddPlan.value, odd), undefined);
});

test('an approved transition picture window extends proxy ordinals without changing the visible demand or PCM', {timeout: 90_000}, async t => {
  const {staging, movie, audio} = await fixture(t);
  const visible = clip(12, 70), picture = clip(8, 74);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...visible,
    media: 'video', pictureWindow: picture.sourceWindow};
  const options = authority();
  await assert.rejects(prepareReverseProxy({...input, pictureWindow: clip(13, 70).sourceWindow}, options), {code: 'UNSUPPORTED_FORMAT'});
  const prepared = await prepareReverseProxy(input, options);
  const result = await renderReverseProxy(input, prepared, {...options, stagingDirectory: staging});
  assert.equal(result.frameCount, 66);
  assert.equal(result.sampleCount, (70 - 12) * 1600);
  const clock = JSON.parse(await readFile(path.join(staging, 'clock.json'), 'utf8'));
  assert.deepEqual(clock.sourceWindow, visible.sourceWindow);
  assert.deepEqual(clock.video.sourceCoverage, {startFrame: 8, endFrame: 74});
  assert.equal(clock.video.firstSourceOrdinal, 8);
  assert.equal(clock.video.endSourcePts, '74000');
  assert.deepEqual(clock.audio.sourceCoverage, {fromSample: 12 * 1600, toSample: 70 * 1600});
  const index = (await readFile(path.join(staging, 'frames.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(index.map(row => row.sourceOrdinal), Array.from({length: 66}, (_, ordinal) => 73 - ordinal));
  const pcm = await outputBytes(path.join(staging, 'proxy.mkv'), ['-map', '0:a:0', '-vn', ...rawAudio], result.sampleCount * 8);
  assert.deepEqual(pcm, reverseRecords(audio, 8, 12 * 1600, 70 * 1600));
});

test('the source clock starts at the first decoded picture when audio begins earlier', {timeout: 90_000}, async t => {
  const {staging, movie, audio} = await fixture(t, false, 0.1);
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(0, 4), media: 'video'};
  const options = authority();
  const prepared = await prepareReverseProxy(input, options);
  const result = await renderReverseProxy(input, prepared, {...options, stagingDirectory: staging});
  assert.equal(result.frameCount, 4);
  assert.equal(result.sampleCount, 6_400);
  const clock = JSON.parse(await readFile(path.join(staging, 'clock.json'), 'utf8'));
  assert.equal(clock.originUs, 0);
  assert.equal(clock.video.sourceZeroPts, '3000');
  assert.deepEqual(clock.audio.sourceZero, {streamIndex: 0, pts: '3000', timeBase: {numerator: 1, denominator: 30_000}});
  const pcm = await outputBytes(path.join(staging, 'proxy.mkv'), ['-map', '0:a:0', '-vn', ...rawAudio], result.sampleCount * 8);
  assert.deepEqual(pcm, reverseRecords(audio, 8, 4_800, 11_200));
});

test('audio-only reverse aligns added 48 kHz history to native 44.1 kHz without changing channel order', {timeout: 60_000}, async t => {
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
  const input: ReverseProxyInput = {sourcePath: movie, sourceSha256: sha(await readFile(movie)), ...clip(7, 81), media: 'audio',
    audioWindow: {fromSample: 7 * 1600 - 1, toSample: 81 * 1600 + 1}};
  const opts = authority();
  const prepared = await prepareReverseProxy(input, opts);
  const receipt = await renderReverseProxy(input, prepared, {...opts, stagingDirectory: staging});
  assert.equal(receipt.frameCount, 0);
  const nativeStart = 7 * samplesPerFrame - 147, nativeEnd = 81 * samplesPerFrame + 147;
  assert.equal(receipt.sampleCount, nativeEnd - nativeStart);
  assert.deepEqual((await readdir(staging)).sort(), ['clock.json', 'proxy.mkv']);
  const expected = reverseRecords(samples, 8, nativeStart, nativeEnd);
  const output = await outputBytes(path.join(staging, 'proxy.mkv'), ['-map', '0:a:0', '-vn', ...rawAudio], expected.length);
  assert.equal(sha(output), sha(expected));
  const clock = JSON.parse(await readFile(path.join(staging, 'clock.json'), 'utf8'));
  assert.equal(clock.sourceSampleStart, nativeStart);
  assert.deepEqual(clock.audio.sourceCoverage, {fromSample: 7 * 1600 - 160, toSample: 81 * 1600 + 160});
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

test('the 120-second portrait FFV1 reservation uses bounded scratch and grows with encoded bytes', () => {
  const frameBytes = 1080 * 1920 * 3 / 2, frameCount = 3600;
  const audioBytes = 120 * 48_000 * 2 * 4;
  const budgets = reverseProxyDiskBudget('matroska', frameCount * frameBytes, audioBytes, 60 * frameBytes, frameCount);
  assert.equal(budgets.scratchBytes, 233_230_336);
  assert.equal(budgets.reservationBytes, 300_339_200);
  assert.equal(budgets.outputBytesLimit, 8 * 1024 ** 3);
  assert.ok(budgets.scratchBytes + budgets.outputBytesLimit <= 10 * 1024 ** 3);
  assert.throws(() => reverseProxyDiskBudget('raw', frameCount * frameBytes, audioBytes, 60 * frameBytes, frameCount),
    {code: 'CACHE_LIMIT'});
});

test('a media stdout chunk outside the encoder quota cannot write to staging', {timeout: 30_000}, async () => {
  let written = 0;
  await assert.rejects(runReverseTool('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '0.05', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], authority(),
  {stdoutLimit: 8, stdoutOverflow: () => reverseError('CACHE_LIMIT'), stdout(chunk) {written += chunk.length;}}),
  {code: 'CACHE_LIMIT'});
  assert.equal(written, 0);
});

test('direct media output keeps stage writer ownership until its child is closed', {timeout: 30_000}, async t => {
  const {staging} = await workspace(t);
  const output = await open(path.join(staging, 'writer-test.wav'), 'wx+', 0o600);
  const events: string[] = [];
  let childPid: number | undefined;
  const off = onMediaProcess(event => {
    if (event.type === 'exited' && event.pid === childPid) events.push('child closed');
  });
  try {
    await runReverseTool('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '0.025', '-f', 'wav', 'fd:'], {...authority(), writer: {begin() {
        events.push('pending');
        return {started(pid) {childPid = pid; events.push('pid recorded');}, exited() {events.push('marker cleared');}};
      }}}, {outputFd: output.fd});
    assert.ok((await output.stat()).size > 44);
  } finally {
    off();
    await output.close();
  }
  assert.ok(childPid && childPid > 0);
  assert.deepEqual(events, ['pending', 'pid recorded', 'child closed', 'marker cleared']);
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
