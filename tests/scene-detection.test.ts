import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFile, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {run} from '../packages/business/src/media-runtime.ts';
import {hasUnconfirmedMediaProcesses, onMediaProcess} from '../packages/business/src/media-processes.ts';
import {validateManagedSource} from '../packages/business/src/managed-media.ts';
import {frameDecodePlan} from '../packages/business/src/frame-decoder.ts';
import {createSceneDetector, sceneDetectionOptions, sceneMinShotFrames, sceneSegments, sceneThreshold,
  SCENE_DETECTION_DEFAULTS, SCENE_DETECTION_PROFILE_ID, type SceneDetectionOptions, type SceneDetectionResult} from '../packages/business/src/scene-detection.ts';
import {detectManagedScenes, sceneDecodePlan, SCENE_DECODE_LIMITS, type SceneDecodeProgress} from '../packages/business/src/scene-detection-decoder.ts';

// Synthetic frames: each seed is a distinct smooth texture; dx pans it and
// noise adds deterministic per-frame grain, so motion and noise stay inside a shot.
const W = 64, H = 36;
const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
function texture(seed: number, {dx = 0, noise = 3, brightness = 0, frame = 0}: {dx?: number; noise?: number; brightness?: number; frame?: number} = {}): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  let state = (seed * 2654435761 + frame * 40503 + 1) >>> 0;
  const random = (): number => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const X = x + dx, value = 128 + 60 * Math.sin(X * (0.21 + 0.05 * (seed % 5)) + c * 1.3 + seed) +
      45 * Math.cos(y * (0.17 + 0.04 * (seed % 3)) + X * 0.05 * (c + 1) + seed * 1.7);
    out[(y * W + x) * 3 + c] = clamp(value + brightness + (random() - 0.5) * 2 * noise);
  }
  return out;
}
const solid = (value: number): Uint8Array => new Uint8Array(W * H * 3).fill(value);
const blend = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((value, index) => (value + b[index]) >> 1);
// One shot: `length` frames of a seed panning `speed` pixels per frame.
const shot = (seed: number, length: number, speed = 0.3, offset = 0): Uint8Array[] =>
  Array.from({length}, (_, index) => texture(seed, {dx: (offset + index) * speed, frame: offset + index}));
function detect(frames: readonly Uint8Array[], options: Partial<SceneDetectionOptions> = {}, chunk?: number): SceneDetectionResult {
  const detector = createSceneDetector({width: W, height: H, options: sceneDetectionOptions(options)});
  if (chunk === undefined) for (const frame of frames) detector.write(frame);
  else {
    const all = Buffer.concat(frames);
    for (let offset = 0; offset < all.length; offset += chunk) detector.write(all.subarray(offset, offset + chunk));
  }
  return detector.finish();
}
const cutFrames = (result: SceneDetectionResult): number[] => result.cuts.map(cut => cut.frame);
const code = (expected: string) => (error: unknown): boolean => (error as {code?: string}).code === expected;

test('options default to adaptive, sensitivity 60 and 0.6 s, and reject anything else', () => {
  assert.deepEqual(sceneDetectionOptions(), SCENE_DETECTION_DEFAULTS);
  assert.deepEqual(SCENE_DETECTION_DEFAULTS, {mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6});
  assert.deepEqual(sceneDetectionOptions({mode: 'fixed', sensitivity: 0, minShotSeconds: 10}), {mode: 'fixed', sensitivity: 0, minShotSeconds: 10});
  assert.ok(Object.isFrozen(sceneDetectionOptions({sensitivity: 100})));
  for (const value of [null, [], 'adaptive', {mode: 'smart'}, {sensitivity: 60.5}, {sensitivity: -1}, {sensitivity: 101}, {sensitivity: '60'},
    {minShotSeconds: 0.05}, {minShotSeconds: 10.5}, {minShotSeconds: Number.NaN}, {minShotSeconds: '0.6'}, {threshold: 0.1}])
    assert.throws(() => sceneDetectionOptions(value), code('SCENE_DETECTION_INVALID'), JSON.stringify(value));
  // Every 20 points halves the threshold.
  assert.ok(Math.abs(sceneThreshold({mode: 'adaptive', sensitivity: 60}) - 0.08) < 1e-12);
  assert.ok(Math.abs(sceneThreshold({mode: 'adaptive', sensitivity: 80}) - 0.04) < 1e-12);
  assert.ok(Math.abs(sceneThreshold({mode: 'fixed', sensitivity: 60}) - 0.1) < 1e-12);
  for (let sensitivity = 1; sensitivity <= 100; sensitivity++)
    assert.ok(sceneThreshold({mode: 'adaptive', sensitivity}) < sceneThreshold({mode: 'adaptive', sensitivity: sensitivity - 1}));
  assert.equal(sceneMinShotFrames({minShotSeconds: 0.6}), 18);
  assert.equal(sceneMinShotFrames({minShotSeconds: 0.1}), 3);
  assert.deepEqual(sceneSegments([40, 80], 120), [{startFrame: 0, endFrame: 40}, {startFrame: 40, endFrame: 80}, {startFrame: 80, endFrame: 120}]);
});

test('hard cuts are found at the first frame of each new shot in both modes', () => {
  const frames = [...shot(1, 40), ...shot(2, 40), ...shot(3, 40)];
  for (const mode of ['adaptive', 'fixed'] as const) {
    const result = detect(frames, {mode});
    assert.equal(result.profileId, SCENE_DETECTION_PROFILE_ID);
    assert.equal(result.fps, 30);
    assert.equal(result.frameCount, 120);
    assert.deepEqual(cutFrames(result), [40, 80], mode);
    assert.deepEqual(result.segments, [{startFrame: 0, endFrame: 40}, {startFrame: 40, endFrame: 80}, {startFrame: 80, endFrame: 120}]);
    assert.ok(result.cuts.every(cut => cut.score > sceneThreshold({mode, sensitivity: 60}) && cut.score <= 1));
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.cuts) && Object.isFrozen(result.cuts[0]) && Object.isFrozen(result.segments));
  }
});

test('results do not depend on how the byte stream is chunked', () => {
  const frames = [...shot(4, 30), ...shot(5, 25), ...shot(6, 35)];
  const whole = detect(frames);
  assert.deepEqual(cutFrames(whole), [30, 55]);
  for (const chunk of [1, 7, 4096, W * H * 3 + 5, 1 << 20]) assert.deepEqual(detect(frames, {}, chunk), whole, `chunk ${chunk}`);
});

test('a single shot without cuts, with slow motion or slow brightening, yields one segment', () => {
  const still = Array.from({length: 150}, (_, frame) => texture(7, {frame}));
  const slowPan = shot(8, 150, 0.15);
  const brightening = Array.from({length: 150}, (_, frame) => texture(9, {dx: frame * 0.1, brightness: frame * 0.3 - 20, frame}));
  for (const [name, frames] of [['still', still], ['slow pan', slowPan], ['brightening', brightening]] as const) {
    for (const mode of ['adaptive', 'fixed'] as const) {
      const result = detect(frames, {mode});
      assert.deepEqual(result.cuts, [], `${name} ${mode}`);
      assert.deepEqual(result.segments, [{startFrame: 0, endFrame: 150}]);
    }
  }
});

test('flashes that return to the same picture are not cuts', () => {
  for (const length of [1, 2, 6]) {
    const frames = shot(10, 120);
    for (let index = 60; index < 60 + length; index++) frames[index] = solid(250);
    assert.deepEqual(detect(frames).cuts, [], `white flash of ${length} frames`);
  }
  // Lightning: a bright strike, then a decaying afterglow, inside one shot.
  const lightning = shot(11, 120);
  for (const [index, lift] of [[60, 120], [61, 120], [62, 60], [63, 45], [64, 30], [65, 15]] as const)
    lightning[index] = texture(11, {dx: index * 0.3, brightness: lift, frame: index});
  assert.deepEqual(detect(lightning).cuts, []);
  // A flash longer than 0.2 s is no longer a flash.
  const long = shot(12, 120);
  for (let index = 60; index < 90; index++) long[index] = solid(250);
  assert.deepEqual(cutFrames(detect(long)), [60, 90]);
});

test('a flash leading into a different shot is one cut inside the flash span', () => {
  const frames = [...shot(13, 60), ...shot(14, 60)];
  frames[59] = solid(250); frames[60] = solid(250);
  const cuts = cutFrames(detect(frames));
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0] >= 59 && cuts[0] <= 61, String(cuts));
});

test('the minimum shot drops cuts near the start, near the end and next to a stronger cut', () => {
  // Shots of 10 frames each: with 0.6 s (18 frames) only cuts 18 apart survive.
  const rapid = [3, 4, 5, 6, 7, 8, 9, 10].flatMap(seed => shot(seed * 7, 10));
  const result = detect(rapid);
  const cuts = cutFrames(result);
  assert.ok(cuts.length >= 2, String(cuts));
  assert.ok(cuts.every((frame, index) => frame >= 18 && frame <= 80 - 18 && (index === 0 || frame - cuts[index - 1] >= 18)), String(cuts));
  assert.ok(cuts.every(frame => frame % 10 === 0), 'every kept cut is a real shot boundary');
  assert.deepEqual(cutFrames(detect(rapid, {minShotSeconds: 0.3})), [10, 20, 30, 40, 50, 60, 70]);
  // Head and tail: a 10-frame first shot and a 10-frame last shot merge.
  const edges = [...shot(20, 10), ...shot(21, 60), ...shot(22, 10)];
  assert.deepEqual(cutFrames(detect(edges)), []);
  assert.deepEqual(cutFrames(detect(edges, {minShotSeconds: 0.3})), [10, 70]);
  const tail = detect([...shot(23, 60), ...shot(24, 10)]);
  assert.deepEqual(tail.segments, [{startFrame: 0, endFrame: 70}]);
});

test('a two-frame transition keeps only the peak frame', () => {
  const a = shot(25, 60), b = shot(26, 60, 0.3, 61);
  const frames = [...a, blend(a[59], b[0]), ...b];
  const cuts = cutFrames(detect(frames));
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0] === 60 || cuts[0] === 61, String(cuts));
});

test('adaptive mode follows sustained motion while fixed mode does not', () => {
  // Fast pans keep every frame-to-frame difference high, with no real cut.
  const fast = Array.from({length: 150}, (_, frame) => texture(27, {dx: frame * 4.5, frame, noise: 6}));
  assert.deepEqual(detect(fast, {mode: 'adaptive'}).cuts, []);
  assert.ok(detect(fast, {mode: 'fixed', sensitivity: 100}).cuts.length > 0, 'a low fixed threshold fires on motion');
});

test('sensitivity trades missed low-contrast cuts against false ones', () => {
  // Two dim, similar textures: a low-contrast cut.
  const dim = (seed: number, offset: number): Uint8Array[] => Array.from({length: 60}, (_, index) =>
    texture(seed, {dx: (offset + index) * 0.3, brightness: -95, frame: offset + index, noise: 2}).map(value => value >> 1));
  const frames = [...dim(28, 0), ...dim(29, 60)];
  assert.deepEqual(cutFrames(detect(frames, {sensitivity: 100})), [60]);
  assert.deepEqual(cutFrames(detect(frames, {sensitivity: 0})), []);
});

test('progress reports provisional cuts once a minimum shot follows them', () => {
  const frames = [...shot(30, 40), ...shot(31, 40), ...shot(32, 40)];
  const detector = createSceneDetector({width: W, height: H});
  const seen: number[][] = [];
  for (const [index, frame] of frames.entries()) {
    detector.write(frame);
    assert.equal(detector.frames, index + 1);
    seen.push([...detector.progress().cuts]);
  }
  // seen[k] follows frame k; the cut at 40 needs 18 frames after it.
  assert.deepEqual(seen[56], []);
  assert.deepEqual(seen[57], [40]);
  assert.deepEqual(seen.at(-1), [40, 80]);
  assert.deepEqual(cutFrames(detector.finish()), [40, 80]);
});

test('finish with the editing frame count ends the last segment there', () => {
  const frames = [...shot(33, 40), ...shot(34, 40)];
  const detector = createSceneDetector({width: W, height: H});
  for (const frame of frames) detector.write(frame);
  const result = detector.finish(82);
  assert.equal(result.frameCount, 82);
  assert.deepEqual(result.segments, [{startFrame: 0, endFrame: 40}, {startFrame: 40, endFrame: 82}]);
  assert.equal(detector.finish(), result, 'finish is idempotent');
  assert.throws(() => detector.write(frames[0]), code('SCENE_FRAMES_INVALID'));
  const short = createSceneDetector({width: W, height: H});
  for (const frame of frames) short.write(frame);
  assert.deepEqual(cutFrames(short.finish(50)), [], 'a cut inside the final minimum shot merges');
});

test('invalid frames and limits fail, and a failed detector stays failed', () => {
  for (const [width, height] of [[0, 10], [257, 10], [10, 1.5]])
    assert.throws(() => createSceneDetector({width, height}), code('SCENE_DETECTION_INVALID'));
  assert.throws(() => createSceneDetector({width: W, height: H, maxFrames: 0}), code('SCENE_DETECTION_INVALID'));
  assert.throws(() => createSceneDetector({width: W, height: H, maxFrames: 601 * 30 + 1}), code('SCENE_DETECTION_INVALID'));
  assert.throws(() => createSceneDetector({width: W, height: H, options: {mode: 'fixed', sensitivity: 200, minShotSeconds: 1}}), code('SCENE_DETECTION_INVALID'));
  assert.throws(() => createSceneDetector({width: W, height: H}).finish(), code('SCENE_FRAMES_INVALID'));
  const partial = createSceneDetector({width: W, height: H});
  partial.write(texture(1).subarray(0, 100));
  assert.throws(() => partial.finish(), code('SCENE_FRAMES_INVALID'));
  assert.throws(() => createSceneDetector({width: W, height: H}).write('frame' as never), code('SCENE_FRAMES_INVALID'));
  const limited = createSceneDetector({width: W, height: H, maxFrames: 5});
  for (let index = 0; index < 5; index++) limited.write(texture(1, {frame: index}));
  let failure: unknown;
  assert.throws(() => limited.write(texture(1, {frame: 5})), error => {failure = error; return code('SCENE_FRAME_LIMIT')(error);});
  assert.throws(() => limited.write(texture(1)), error => error === failure);
  assert.throws(() => limited.progress(), error => error === failure);
  assert.throws(() => limited.finish(), error => error === failure);
});

// ---- Decoder: probe profile ----

const probeVideo = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
  pix_fmt: 'yuv420p', field_order: 'progressive', sample_aspect_ratio: '1:1', time_base: '1/15360', start_time: '0.000000', duration: '10.000000', ...patch});
const probeOf = ({video = {}, format = {}, streams}: {video?: Record<string, unknown>; format?: Record<string, unknown>; streams?: unknown[]} = {}) =>
  ({probe: {streams: streams ?? [probeVideo(video)], format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0.000000', duration: '10.000000', ...format}}}) as never;
const accepted = (operation: () => unknown): boolean => {
  try {operation(); return true;} catch (error) {
    assert.ok(['SCENE_PROFILE_UNSUPPORTED', 'FRAME_PROFILE_UNSUPPORTED'].includes((error as {code?: string}).code ?? ''), String(error));
    return false;
  }
};

test('the decode plan scales to a 256 pixel edge on the editing grid without upscaling', () => {
  const landscape = sceneDecodePlan(probeOf(), {mimeType: 'video/mp4'});
  assert.deepEqual(landscape, {width: 256, height: 144, streamIndex: 0, duration: 10, frameCount: 300,
    filter: 'fps=30:round=down,scale=256:144:flags=area,format=rgb24'});
  assert.deepEqual([sceneDecodePlan(probeOf({video: {width: 1080, height: 1920}}), {mimeType: 'video/mp4'})].map(plan => [plan.width, plan.height]), [[144, 256]]);
  assert.deepEqual([sceneDecodePlan(probeOf({video: {width: 200, height: 100}}), {mimeType: 'video/mp4'})].map(plan => [plan.width, plan.height]), [[200, 100]]);
  // Frame capture's 600 s limit applies; the shorter of container and stream counts.
  const long = sceneDecodePlan(probeOf({video: {duration: '600.000000'}, format: {duration: '600.000000'}}), {mimeType: 'video/mp4'});
  assert.equal(long.frameCount, 18000);
  assert.equal(sceneDecodePlan(probeOf({video: {duration: '7.5'}}), {mimeType: 'video/mp4'}).frameCount, 225);
  assert.equal(sceneDecodePlan(probeOf({video: {duration: 'N/A'}, format: {duration: '7.5'}}), {mimeType: 'video/mp4'}).frameCount, 225);
  assert.equal(accepted(() => sceneDecodePlan(probeOf({video: {duration: '600.5'}, format: {duration: '600.5'}}), {mimeType: 'video/mp4'})), false);
  assert.throws(() => sceneDecodePlan(probeOf({video: {codec_name: 'hevc'}}), {mimeType: 'video/mp4'}), code('SCENE_PROFILE_UNSUPPORTED'));
});

test('the scene profile accepts exactly what frame capture accepts', () => {
  const variants: Array<[string, Parameters<typeof probeOf>[0], string?]> = [
    ['plain', {}], ['vp9 webm', {video: {codec_name: 'vp9', field_order: undefined}, format: {format_name: 'matroska,webm'}}, 'video/webm'],
    ['600 s', {video: {duration: '600'}, format: {duration: '600'}}], ['over 600 s', {video: {duration: '600.5'}, format: {duration: '600.5'}}],
    ['20 minutes', {video: {duration: '1200'}, format: {duration: '1200'}}], ['no duration', {video: {duration: 'N/A'}, format: {duration: 'N/A'}}],
    ['webm mime on mov', {}, 'video/webm'], ['hevc', {video: {codec_name: 'hevc'}}], ['yuv444p', {video: {pix_fmt: 'yuv444p'}}],
    ['interlaced', {video: {field_order: 'tt'}}], ['10-bit', {video: {bits_per_raw_sample: '10'}}], ['8-bit', {video: {bits_per_raw_sample: '8'}}],
    ['non-square pixels', {video: {sample_aspect_ratio: '4:3'}}], ['rotate tag', {video: {tags: {rotate: '90'}}}],
    ['display matrix', {video: {side_data_list: [{side_data_type: 'Display Matrix', rotation: -90}]}}],
    ['late start', {video: {start_time: '0.040000'}}], ['late container start', {format: {start_time: '0.5'}}],
    ['odd time base', {video: {time_base: '1001/30000'}}], ['oversized', {video: {width: 5000}}], ['too many pixels', {video: {width: 4096, height: 4096}}],
    ['two videos', {streams: [probeVideo(), probeVideo({index: 1})]}],
    ['cover art', {streams: [probeVideo(), probeVideo({index: 1, codec_name: 'mjpeg', disposition: {attached_pic: 1}})]}],
    ['audio and video', {streams: [probeVideo(), {index: 1, codec_type: 'audio', codec_name: 'aac'}]}],
    ['duplicate index', {streams: [probeVideo(), {index: 0, codec_type: 'audio', codec_name: 'aac'}]}],
  ];
  for (const [name, variant, mimeType = 'video/mp4'] of variants) {
    const probe = probeOf(variant);
    assert.equal(accepted(() => sceneDecodePlan(probe, {mimeType})), accepted(() => frameDecodePlan(probe, {mimeType, requestedFrame: 0})), name);
  }
  assert.equal(accepted(() => sceneDecodePlan(probeOf({video: {codec_name: 'hevc'}}), {mimeType: 'video/mp4'})), false);
});

// ---- Decoder: real FFmpeg on managed sources ----

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ffmpeg = (args: string[]): Promise<string> => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {timeout: 60000});
const small = 's=320x180';
const perlin = (seed: number, rate: number, extra = ''): string =>
  `perlin=${small}:r=${rate}:octaves=4:persistence=0.6:tscale=0.3:random_mode=seed:seed=${seed},format=gbrp,colorchannelmixer=rr=1:gg=0.75:bb=0.45${extra}`;
async function managed(t: TestContext, graph: string, encode: string[] = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-scene-detection-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'media'), {mode: 0o700});
  const relativePath = 'media/source.mp4', file = path.join(root, relativePath);
  await ffmpeg(['-filter_complex', `${graph},setsar=1[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-bf', '2',
    '-pix_fmt', 'yuv420p', ...encode, '-movflags', '+faststart', file]);
  const bytes = await readFile(file);
  const asset = {relativePath, sha256: sha(bytes), mimeType: 'video/mp4', sizeBytes: bytes.length};
  return {root, file, asset, info: validateManagedSource(root, asset).info as unknown as Record<string, unknown>};
}
// Three distinct shots with cuts at native frames k1 and k2. Full-frame overlays
// switch on the main stream's frame number, so the cuts do not depend on how an
// FFmpeg version times concatenated segments (FFmpeg 7.1 shifted a concat of a
// mandelbrot segment by one frame).
const threeShots = (rate: number, k1: number, k2: number, total: number): string =>
  `testsrc2=${small}:r=${rate},trim=end_frame=${total}[a];${perlin(3, rate)}[b];` +
  `smptehdbars=${small}:r=${rate},noise=alls=12:allf=t+u[c];` +
  `[a][b]overlay=shortest=1:enable='between(n,${k1},${k2 - 1})'[ab];[ab][c]overlay=shortest=1:enable='gte(n,${k2})'`;
function watchMedia(t: TestContext): string[] {
  const events: string[] = [];
  const stop = onMediaProcess(event => events.push(`${event.type}:${event.kind}`));
  t.after(() => {stop();});
  return events;
}

test('real cuts land on floor(30 x native cut frame / rate), the frame capture rule', async t => {
  for (const [rate, k1, k2, total] of [[30, 45, 100, 150], [24, 37, 77, 112], [25, 40, 81, 120], [60, 76, 160, 230]] as const) {
    const source = await managed(t, threeShots(rate, k1, k2, total));
    const result = await detectManagedScenes(source);
    const expected = [k1, k2].map(k => Math.floor(30 * k / rate));
    assert.deepEqual(cutFrames(result), expected, `${rate} fps`);
    // The first source frame at or after N/30 is the first frame of the new shot.
    for (const [index, k] of [k1, k2].entries())
      assert.ok((k - 1) / rate < expected[index] / 30 && expected[index] / 30 <= k / rate + 1e-9, `${rate} fps cut ${k}`);
    // sourceFrameCount of the probed duration, as the editor counts the source.
    // ffprobe prints 6 decimals, so 3.833333 s at 60 fps floors to 114 frames.
    assert.ok(Math.abs(result.frameCount - 30 * total / rate) <= 1, String(result.frameCount));
    assert.deepEqual(result.segments.at(-1), {startFrame: expected[1], endFrame: result.frameCount});
    assert.equal(result.sourceHash, source.asset.sha256);
    assert.deepEqual(result.analysis, {width: 256, height: 144, decodedFrames: result.analysis.decodedFrames});
    assert.ok(Math.abs(result.analysis.decodedFrames - result.frameCount) <= SCENE_DECODE_LIMITS.frameTolerance);
  }
});

test('real flash frames, slow motion and a cutless source produce no cuts', async t => {
  const sources = {
    'one-frame flash': `${perlin(4, 30)},trim=duration=4,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,60)'`,
    'three-frame flash': `${perlin(5, 30)},trim=duration=4,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(n,60,62)'`,
    'slow pan': `perlin=s=960x540:r=30:octaves=5:persistence=0.6:tscale=0:random_mode=seed:seed=6,format=gbrp,colorchannelmixer=rr=1:gg=0.75:bb=0.45,crop=320:180:x='100+t*20':y=200,trim=duration=4`,
    'static noise': `color=c=0x506070:${small}:r=30:d=4,noise=alls=10:allf=t+u`,
  };
  for (const [name, graph] of Object.entries(sources)) {
    const result = await detectManagedScenes({...await managed(t, graph), options: {mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6}});
    assert.deepEqual(result.cuts, [], name);
    assert.deepEqual(result.segments, [{startFrame: 0, endFrame: 120}], name);
  }
});

test('progress is reported about once per source second with the editing length', async t => {
  const source = await managed(t, threeShots(30, 45, 100, 150));
  const progress: SceneDecodeProgress[] = [];
  const result = await detectManagedScenes({...source, onProgress: value => {progress.push(value);}});
  assert.ok(progress.length >= 4 && progress.length <= 5, String(progress.length));
  assert.ok(progress.every((value, index) => value.frameCount === 150 && value.frames >= (index + 1) * 30 && (index === 0 || value.frames > progress[index - 1].frames)));
  assert.ok(progress.every(value => value.cuts.every(frame => cutFrames(result).includes(frame))));
  assert.deepEqual(progress.at(-1)?.cuts, [45, 100]);
  // A throwing progress callback stops the attempt with its own error.
  const sentinel = Object.assign(new Error('stop'), {code: 'PROGRESS_SINK_FAILED'});
  await assert.rejects(detectManagedScenes({...source, onProgress: () => {throw sentinel;}}), error => error === sentinel);
  assert.equal(hasUnconfirmedMediaProcesses(), false);
});

test('cancelling during decode stops FFmpeg and reports cancellation', async t => {
  const source = await managed(t, `${perlin(7, 30)},trim=duration=8`);
  const events = watchMedia(t), controller = new AbortController();
  await assert.rejects(detectManagedScenes({...source, signal: controller.signal, onProgress: () => controller.abort()}), code('MEDIA_CANCELLED'));
  assert.deepEqual(events, ['started:ffprobe', 'exited:ffprobe', 'started:ffmpeg', 'exited:ffmpeg']);
  assert.equal(hasUnconfirmedMediaProcesses(), false);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(detectManagedScenes({...source, signal: aborted.signal}), code('MEDIA_CANCELLED'));
});

test('changed, unsupported or misdescribed sources fail before decoding', async t => {
  const changed = await managed(t, `${perlin(8, 30)},trim=duration=2`);
  const plain = await managed(t, `${perlin(9, 30)},trim=duration=2`);
  const yuv444 = await managed(t, `${perlin(10, 30)},trim=duration=2`, ['-pix_fmt', 'yuv444p']);
  const events = watchMedia(t);
  await appendFile(changed.file, Buffer.from([0]));
  await assert.rejects(detectManagedScenes(changed), code('MANAGED_SOURCE_CHANGED'));
  await assert.rejects(detectManagedScenes({...plain, asset: {...plain.asset, sha256: 'f'.repeat(64)}}), code('MANAGED_SOURCE_CHANGED'));
  await assert.rejects(detectManagedScenes({...plain, asset: {...plain.asset, mimeType: 'video/quicktime'}}), code('SCENE_PROFILE_UNSUPPORTED'));
  await assert.rejects(detectManagedScenes({...plain, options: {sensitivity: 101}}), code('SCENE_DETECTION_INVALID'));
  await assert.rejects(detectManagedScenes({...plain, root: 'relative'}), code('MEDIA_INVALID_CONFIGURATION'));
  await assert.rejects(detectManagedScenes({...plain, beforeSpawn: async () => {}}), code('MEDIA_INVALID_CONFIGURATION'));
  assert.deepEqual(events, [], 'none of these starts a media child');
  await assert.rejects(detectManagedScenes(yuv444), code('SCENE_PROFILE_UNSUPPORTED'));
  assert.deepEqual(events, ['started:ffprobe', 'exited:ffprobe'], 'an unsupported profile never starts the decoder');
});
