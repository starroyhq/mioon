import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {hasUnconfirmedMediaProcesses, onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import {PREVIEW_PROXY_PROFILE, preparePreviewProxy, renderPreviewProxy} from '../packages/business/src/timeline-processing/preview.ts';
import type {PreviewProxyInput} from '../packages/business/src/timeline-processing/preview.ts';
import {compileTimeMap, initialTimeMap, instantiateSpeedPreset, timeMapPlanFrames, timeMapSourceAtOutputFrame} from '../packages/contracts/src/timeline-time-map.ts';
import type {TimeMapResult, TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import {speedProcessingItemSchema} from '../packages/contracts/src/timeline-processing.ts';
import {processingProxyResultSchema} from '../packages/contracts/src/timeline-processing-storage.ts';

const clock = {fpsNumerator: 30, fpsDenominator: 1};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const rate = (numerator: number, denominator: number): TimeMapSpeed => ({kind: 'constant', rate: {numerator, denominator}});
const edge = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const authority = (signal = new AbortController().signal) => ({signal, beforeEffect() {}});
function unwrap<T>(result: TimeMapResult<T>): T {assert.ok(result.ok, JSON.stringify(result)); return result.value;}

async function fixture(t: test.TestContext, {frames = 24, width = 24, height = 16, vfr = false} = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-preview-proxy-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source.mov');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-n', '-filter_threads', '1', '-f', 'lavfi', '-i',
    `nullsrc=size=${width}x${height}:rate=30,format=gray,geq=lum='24+mod(N,24)*8'`,
    ...(vfr ? ['-vf', `settb=1/300,setpts='N*10+if(eq(N,${frames - 1}),0,if(eq(mod(N,3),1),-2,3*eq(mod(N,3),2)))'`,
      '-fps_mode', 'passthrough', '-enc_time_base', '1/300', '-video_track_timescale', '300'] : []),
    '-frames:v', String(frames), '-c:v', 'png', '-threads:v', '1', source]);
  const sourceSha256 = sha(await readFile(source));
  const projectId = randomUUID();
  const cache = createProcessingCache(root);
  const makeInput = (speed: TimeMapSpeed, direction: 'forward' | 'reverse', interpolation: PreviewProxyInput['interpolation'],
    end = frames, start = 0): PreviewProxyInput => ({
    source: {path: source}, sourceSha256, interpolation,
    plan: initialTimeMap(unwrap(compileTimeMap({profile: 'timeline-speed-v1', speed, sourceFps: clock, outputFps: clock,
      sourceRange: {start: edge(start), end: edge(end)}})), direction),
  });
  async function render(input: PreviewProxyInput) {
    const options = authority();
    const prepared = await preparePreviewProxy(input, options);
    const stage = cache.stage(projectId, sha(Buffer.from(randomUUID())), prepared.reservationBytes, options.beforeEffect);
    const result = await renderPreviewProxy(input, prepared, {...options, stagingDirectory: stage.directory});
    assert.equal(result.profileId, PREVIEW_PROXY_PROFILE);
    assert.equal(result.frameCount, input.plan.durationFrames);
    assert.equal(result.sampleCount, 0);
    assert.equal(processingProxyResultSchema.safeParse(result).success, false, 'preview cannot be certified as a lossless export proxy');
    assert.deepEqual((await readdir(stage.directory)).sort(), ['clock.json', 'preview.mp4']);
    for (const file of result.files) {
      const bytes = await readFile(path.join(stage.directory, file.fileName));
      assert.equal(bytes.length, file.bytes);
      assert.equal(sha(bytes), file.sha256);
    }
    return {prepared, stage, result, file: path.join(stage.directory, 'preview.mp4')};
  }
  return {cache, makeInput, projectId, render, root};
}

async function readLevels(file: string, width: number, height: number, frames: number): Promise<number[]> {
  const chunks: Buffer[] = [];
  const frameBytes = width * height;
  await runStreaming('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-c:v', 'rawvideo',
    '-threads:v', '1', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
  {maxStdoutBytes: frameBytes * frames, onStdout(chunk) {chunks.push(chunk);}});
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, frameBytes * frames);
  return Array.from({length: frames}, (_, frame) => bytes[frame * frameBytes]!);
}

function nearLevels(decoded: number[], expected: number[]) {
  assert.equal(decoded.length, expected.length);
  for (let i = 0; i < decoded.length; i++) assert.ok(Math.abs(decoded[i]! - expected[i]!) <= 3, `frame ${i}: ${decoded[i]} vs ${expected[i]}`);
}

test('H.264 preview curves and reverse playback use the shared CFR ordinal table', async t => {
  const {makeInput, render} = await fixture(t);
  const curve = unwrap(instantiateSpeedPreset('slowMiddle', 0, 24));
  for (const direction of ['forward', 'reverse'] as const) {
    const input = makeInput(curve, direction, 'off');
    const {prepared, stage, file} = await render(input);
    const {width, height} = prepared.profile;
    nearLevels(await readLevels(file, width, height, input.plan.durationFrames), Array.from(unwrap(timeMapPlanFrames(input.plan)), frame => 24 + frame * 8));
    stage.discard();
  }
});

test('VFR preview follows native pts in both directions at precise boundaries', async t => {
  const {makeInput, render} = await fixture(t, {vfr: true});
  const pts = Array.from({length: 24}, (_, n) => n * 10 + (n === 23 ? 0 : n % 3 === 1 ? -2 : n % 3 === 2 ? 3 : 0));
  for (const direction of ['forward', 'reverse'] as const) {
    const input = makeInput(rate(3, 2), direction, 'off', 23);
    const {prepared, file, stage} = await render(input);
    const {width, height} = prepared.profile;
    const expected = Array.from({length: input.plan.durationFrames}, (_, frame) => {
      const {source} = unwrap(timeMapSourceAtOutputFrame(input.plan, frame));
      assert.equal(source.kind, 'exact');
      const at = BigInt(source.numerator) * 10n, unit = BigInt(source.denominator);
      const ordinal = pts.findLastIndex(pts => direction === 'reverse' ? BigInt(pts) * unit < at : BigInt(pts) * unit <= at);
      return 24 + Math.max(0, ordinal) * 8;
    });
    nearLevels(await readLevels(file, width, height, input.plan.durationFrames), expected);
    stage.discard();
  }
});

test('a steep curve selects the correct physical VFR frame before the next presentation boundary', async t => {
  const {makeInput, render} = await fixture(t, {frames: 154, vfr: true});
  const input = makeInput({kind: 'curve', presetId: 'test', interpolation: 'log-pchip-v1', points: [
    {sourceFrame: 3, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 78, rate: {numerator: 4, denominator: 1}},
    {sourceFrame: 153, rate: {numerator: 1, denominator: 2}},
  ]}, 'forward', 'off', 153, 3);
  const {prepared, file, stage} = await render(input);
  assert.equal(unwrap(timeMapPlanFrames(input.plan))[17], 8);
  const {width, height} = prepared.profile;
  const preview = await readLevels(file, width, height, input.plan.durationFrames);
  // The inverse is 8.0173… on the project clock, before native ordinal 8
  // starts at 8.3. The ordinal 7 patch has a level of 24 + 7*8.
  nearLevels([preview[17]!], [80]);
  stage.discard();
});

test('preview scales to 960 and optical waiting uses the exact off-mode frames', async t => {
  const {makeInput, render} = await fixture(t, {frames: 4, width: 1200, height: 800});
  for (const interpolation of ['off', 'optical'] as const) {
    const input = makeInput(rate(1, 2), 'forward', interpolation);
    const {prepared, stage, file} = await render(input);
    const {width, height, effectiveInterpolation} = prepared.profile;
    assert.equal(width, 960);
    assert.equal(height, 640);
    assert.equal(effectiveInterpolation, 'off');
    const expected = Array.from(unwrap(timeMapPlanFrames(input.plan)), frame => 24 + 8 * frame);
    nearLevels(await readLevels(file, width, height, input.plan.durationFrames), expected);
    stage.discard();
  }
});

test('blend without the shared phase processor is rejected before any preview staging', async t => {
  const {cache, makeInput, projectId, render, root} = await fixture(t, {frames: 4});
  let started = 0;
  const unobserve = onMediaProcess(event => {if (event.type === 'started') started++;});
  try {
    for (const direction of ['forward', 'reverse'] as const) {
      await assert.rejects(render(makeInput(rate(1, 2), direction, 'blend')), {code: 'UNSUPPORTED_FORMAT'});
    }
  } finally {unobserve();}
  assert.equal(started, 0);
  assert.equal(cache.stats(projectId).usedBytes, 0);
  assert.deepEqual(await readdir(root), ['source.mov']);
});

test('an aborted preview attempt stops its child before the SP-P staging owner discards files', async t => {
  const {cache, makeInput, projectId} = await fixture(t);
  const controller = new AbortController(), options = authority(controller.signal);
  const input = makeInput(rate(1, 2), 'reverse', 'off');
  const prepared = await preparePreviewProxy(input, options);
  const stage = cache.stage(projectId, sha(Buffer.from('preview attempt')), prepared.reservationBytes, options.beforeEffect);
  let spawned = 0;
  const unobserve = onMediaProcess(event => {if (event.type === 'started') spawned++;});
  try {
    await assert.rejects(renderPreviewProxy(input, prepared, {...options, stagingDirectory: stage.directory, onProgress(value) {
      if (value > 45) controller.abort();
    }}), {code: 'MEDIA_CANCELLED'});
  } finally {unobserve();}
  assert.ok(spawned >= 2);
  assert.equal(hasUnconfirmedMediaProcesses({signal: options.signal}), false);
  stage.discard();
  await assert.rejects(readdir(stage.directory), {code: 'ENOENT'});
  assert.equal(cache.stats(projectId).usedBytes, 0);
});

test('processing summaries accept preview tasks with the specified public shape', () => {
  const item = {taskId: randomUUID(), clipId: randomUUID(), kind: 'preview', status: 'running', progress: 25};
  assert.deepEqual(speedProcessingItemSchema.parse(item), item);
  assert.equal(speedProcessingItemSchema.safeParse({...item, path: 'private'}).success, false);
});
