import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {prepareOpticalProxy, renderOpticalProxy} from '../packages/business/src/timeline-processing/optical.ts';
import type {OpticalProxyInput} from '../packages/business/src/timeline-processing/optical.ts';
import {OPTICAL_FLOW_FILTER, OPTICAL_PROXY_PROFILE} from '../packages/business/src/timeline-processing/optical-proxy-port.ts';
import {compileInterpolationPhase} from '../packages/contracts/src/timeline-interpolation.ts';
import {compileTimeMap, initialTimeMap, timeMapPlanInfo, type TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';

const fps = {fpsNumerator: 30, fpsDenominator: 1};
const width = 64, height = 64, frameBytes = width * height * 3 / 2;
const rawVideo = ['-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-threads:v', '1', '-pix_fmt', '+yuv420p',
  '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
const coordinate = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const authority = (signal = new AbortController().signal) => ({signal, beforeEffect() {}});
const tools = ['-v', 'error', '-xerror', '-nostdin', '-noauto_conversion_filters', '-filter_threads', '1'];
async function workspace(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-optical-fixture-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const stagingDirectory = path.join(root, 'stage');
  await mkdir(stagingDirectory, {mode: 0o700});
  return {root, stagingDirectory};
}

function input(sourcePath: string, sourceFrames: number, from: number, to: number, direction: 'forward' | 'reverse',
  handles = 0, speed: TimeMapSpeed = {kind: 'constant', rate: {numerator: 1, denominator: 4}}): OpticalProxyInput {
  const basis = {profile: 'timeline-speed-v1' as const, sourceFps: fps, outputFps: fps,
    sourceRange: {start: coordinate(from), end: coordinate(to)}, speed};
  const root = compileTimeMap(basis);
  assert.ok(root.ok);
  const plan = timeMapPlanInfo(initialTimeMap(root.value, direction));
  assert.ok(plan.ok);
  const {mapHash, loTime, hiTime, outputWindow} = plan.value;
  const timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}> = {
    profile: 'timeline-speed-v1', basis, view: {loTime, hiTime, direction}, outputWindow, pitchShift: false, interpolation: 'optical',
  };
  return {sourcePath, mapHash, window: {timing, sourceFrames, beforeFrames: handles, afterFrames: handles}};
}

async function decode(file: string, frames: number, filters?: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await runStreaming('ffmpeg', [...tools, '-threads', '1', '-i', file, ...(filters ? ['-vf', filters] : []), ...rawVideo],
    {maxStdoutBytes: frames * frameBytes, onStdout: bytes => {chunks.push(bytes);}});
  return Buffer.concat(chunks);
}

test('optical output owns exact 30 fps ordinals across two-second blocks and matches a contiguous graph', {timeout: 60_000}, async t => {
  const {root, stagingDirectory} = await workspace(t);
  const sourcePath = path.join(root, 'fixture.mkv');
  const sourceFrames = 75, frameCount = 300;
  await run('ffmpeg', [...tools, '-f', 'lavfi', '-i',
    "nullsrc=s=64x64:r=30,format=yuv420p,geq=lum='60+90*lt(abs(X-8-mod(N,40)),6)*lt(abs(Y-32),10)':cb=128:cr=128",
    '-frames:v', String(sourceFrames), '-c:v', 'ffv1', '-threads:v', '1', '-f', 'nut', sourcePath]);
  const request = {...input(sourcePath, sourceFrames, 0, sourceFrames, 'forward'), sceneCuts: () => []};
  const options = authority();
  const prepared = await prepareOpticalProxy(request, options);
  const result = await renderOpticalProxy(request, prepared, {...options, stagingDirectory});
  assert.equal(result.profileId, OPTICAL_PROXY_PROFILE);
  assert.equal(result.frameCount, frameCount);
  assert.equal(result.firstOutputFrame, 0);
  assert.deepEqual((await readdir(stagingDirectory)).sort(), ['clock.json', 'proxy.mkv']);
  const actual = await decode(path.join(stagingDirectory, 'proxy.mkv'), frameCount);
  const direct = await decode(sourcePath, frameCount,
    `tpad=start=2:start_mode=clone:stop=2:stop_mode=clone,settb=1/90000,setpts=N*12000,${OPTICAL_FLOW_FILTER},trim=start_pts=8:end_pts=308`);
  const original = await decode(sourcePath, sourceFrames);
  assert.equal(actual.length, frameCount * frameBytes);
  assert.equal(direct.length, actual.length);
  const view = (bytes: Buffer, frame: number) => bytes.subarray(frame * frameBytes, (frame + 1) * frameBytes);
  for (let native = 0; native < sourceFrames; native++) {
    assert.deepEqual(view(actual, native * 4), view(original, native), `proxy output frame ${native * 4}`);
    assert.deepEqual(view(actual, native * 4), view(direct, native * 4), `direct output frame ${native * 4}`);
  }
  for (const index of [235, 237, 238, 239, 241, 242, 243, 245]) {
    assert.deepEqual(view(actual, index), view(direct, index), `interpolated seam frame ${index}`);
  }
});

for (const direction of ['forward', 'reverse'] as const) {
  test(`optical ${direction} uses the detected cut and includes transition handles`, {timeout: 60_000}, async t => {
    const {root, stagingDirectory} = await workspace(t);
    const sourcePath = path.join(root, 'cut.mp4');
    await run('ffmpeg', [...tools, '-f', 'lavfi', '-i',
      "nullsrc=s=64x64:r=30,format=yuv420p,geq=lum='if(lt(N,42),40,200)':cb=128:cr=128",
      '-frames:v', '84', '-c:v', 'libx264', '-threads:v', '1', '-pix_fmt', '+yuv420p', '-crf', '0', sourcePath]);
    const request = input(sourcePath, 84, 1, 83, direction, 4);
    const options = authority();
    const prepared = await prepareOpticalProxy(request, options);
    const evidence = await renderOpticalProxy(request, prepared, {...options, stagingDirectory});
    assert.equal(evidence.firstOutputFrame, -4);
    assert.equal(evidence.frameCount, 336);
    const actual = await decode(path.join(stagingDirectory, 'proxy.mkv'), 336);
    const before = direction === 'forward' ? 40 : 200;
    const after = direction === 'forward' ? 200 : 40;
    // A hard cut occupies the midpoint. Each side's off frame survives the
    // cut guard and no partly dissolved luma appears.
    for (let frame = 0; frame < 336; frame++) {
      assert.equal(actual[frame * frameBytes], frame < 168 ? before : after, `output frame ${frame}`);
    }
  });
}

test('optical rejects non-planar and high-bit-depth source formats before staging', {timeout: 60_000}, async t => {
  const {root, stagingDirectory} = await workspace(t);
  for (const format of ['yuv420p10le', 'gbrp', 'yuvj420p']) {
    const sourcePath = path.join(root, format + '.nut');
    const encoder = format === 'gbrp' ? 'rawvideo' : format === 'yuvj420p' ? 'mjpeg' : 'ffv1';
    await run('ffmpeg', [...tools, '-f', 'lavfi', '-i', `nullsrc=s=64x64:r=30,format=${format}`,
      '-frames:v', '5', '-c:v', encoder, '-threads:v', '1', '-pix_fmt', '+' + format, sourcePath]);
    await assert.rejects(prepareOpticalProxy(input(sourcePath, 5, 0, 5, 'forward'), authority()), {code: 'UNSUPPORTED_FORMAT'});
  }
  assert.deepEqual(await readdir(stagingDirectory), []);
});

test('mixed-rate optical preserves off selection in fast intervals and rejects a steep curve', {timeout: 60_000}, async t => {
  const {root, stagingDirectory} = await workspace(t);
  const sourcePath = path.join(root, 'curve.nut');
  const sourceFrames = 300;
  const speed = (end: number): TimeMapSpeed => ({kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'mixed',
    points: [{sourceFrame: 0, rate: {numerator: 1, denominator: 10}},
      {sourceFrame: end / 2, rate: {numerator: 2, denominator: 1}},
      {sourceFrame: end, rate: {numerator: 1, denominator: 10}}]});
  await run('ffmpeg', [...tools, '-f', 'lavfi', '-i',
    "nullsrc=s=64x64:r=30,format=yuv420p,geq=lum='32+mod(X+N,190)':cb=128:cr=128",
    '-frames:v', String(sourceFrames), '-c:v', 'ffv1', '-threads:v', '1', '-f', 'nut', sourcePath]);
  const request = {...input(sourcePath, sourceFrames, 0, sourceFrames, 'forward', 0, speed(sourceFrames)), sceneCuts: () => []};
  const options = authority();
  const rejected = input(sourcePath, sourceFrames, 0, sourceFrames / 2, 'forward', 0, speed(sourceFrames / 2));
  await assert.rejects(prepareOpticalProxy(rejected, options), {code: 'INTERPOLATION_UNAVAILABLE'});
  const prepared = await prepareOpticalProxy(request, options);
  const result = await renderOpticalProxy(request, prepared, {...options, stagingDirectory});
  const original = await decode(sourcePath, sourceFrames);
  const actual = await decode(path.join(stagingDirectory, 'proxy.mkv'), result.frameCount);
  const compiled = compileTimeMap(request.window.timing.basis);
  assert.ok(compiled.ok);
  const phase = compileInterpolationPhase(initialTimeMap(compiled.value));
  assert.ok(phase.ok && phase.value.available);
  assert.equal(actual.length / frameBytes, phase.value.frames.length);
  const view = (bytes: Buffer, frame: number) => bytes.subarray(frame * frameBytes, (frame + 1) * frameBytes);
  let unchanged = 0;
  for (const [index, frame] of phase.value.frames.entries()) {
    if (frame.active) continue;
    assert.deepEqual(view(actual, index), view(original, frame.offFrame), `output frame ${index}`);
    unchanged++;
  }
  assert.ok(unchanged > 20 && unchanged < result.frameCount);
});
