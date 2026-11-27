import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, splitTimeMap, timeMapPlanFrames, trimTimeMap,
  type TimeMapBasis, type TimeMapResult, type TimeMapSpeed,
} from '../packages/contracts/src/timeline-time-map.ts';
import {
  compileInterpolationPhase, INTERPOLATION_PHASE_EPSILON, INTERPOLATION_PHASE_PROFILE,
  INTERPOLATION_PIXEL_FORMATS, isInterpolationPixelFormat,
} from '../packages/contracts/src/timeline-interpolation.ts';

const timebase = {fpsNumerator: 30, fpsDenominator: 1};
const constant = (numerator: number, denominator: number): TimeMapSpeed => ({kind: 'constant', rate: {numerator, denominator}});
const boundary = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const basis = (end: number, speed: TimeMapSpeed, start = 0): TimeMapBasis =>
  ({profile: 'timeline-speed-v1', sourceFps: timebase, outputFps: timebase,
    sourceRange: {start: boundary(start), end: boundary(end)}, speed});
const curve = (end: number): TimeMapSpeed => ({
  kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'shape-with-fast-region',
  points: [{sourceFrame: 0, rate: {numerator: 1, denominator: 10}},
    {sourceFrame: Math.floor(end / 2), rate: {numerator: 2, denominator: 1}},
    {sourceFrame: end, rate: {numerator: 1, denominator: 10}}],
});
function unwrap<T>(result: TimeMapResult<T>): T {
  if (!result.ok) assert.fail(`${result.code}: ${result.detail}`);
  return result.value;
}

test('quarter speed uses the shared coordinates and reversed direction weights for 600 output frames', () => {
  const root = unwrap(compileTimeMap(basis(150, constant(1, 4))));
  for (const direction of ['forward', 'reverse'] as const) {
    const plan = initialTimeMap(root, direction);
    const phase = unwrap(compileInterpolationPhase(plan));
    const forward = direction === 'forward';
    assert.equal(phase.profile, INTERPOLATION_PHASE_PROFILE);
    assert.ok(phase.available);
    assert.ok(phase.maxPhaseErrorFrames < 1e-10);
    assert.equal(phase.frames.length, 600);
    assert.deepEqual(phase.frames.map(frame => frame.offFrame), Array.from(unwrap(timeMapPlanFrames(plan))));
    assert.deepEqual(phase.frames.slice(0, 5).map(({fromFrame, toFrame, weight}) => [fromFrame, toFrame, weight]),
      (forward ? [[0, 1], [1, 2]] : [[149, 148], [148, 147]]).flatMap(([from, to], index) =>
        (index === 0 ? [0, .25, .5, .75] : [0]).map(weight => [from, to, weight])));
    assert.deepEqual(phase.input.slice(0, 3), (forward ? [0, 1, 2] : [149, 148, 147])
      .map((sourceFrame, index) => ({sourceFrame, pts: index * 12_000})));
    assert.ok(phase.frames.slice(-4).every(frame => !frame.active && frame.fromFrame === frame.toFrame));
  }
});

test('fast and frozen windows have no interpolation inputs', () => {
  const fast = initialTimeMap(unwrap(compileTimeMap(basis(150, constant(11, 10)))));
  const freeze = initialTimeMap(unwrap(compileFreezeTimeMap({sourceFrame: 14, durationFrames: 35, sourceFps: timebase, outputFps: timebase})));
  for (const plan of [fast, freeze]) {
    const phase = unwrap(compileInterpolationPhase(plan));
    assert.ok(phase.available);
    assert.equal(phase.maxPhaseErrorFrames, 0);
    assert.deepEqual(phase.input, []);
    assert.ok(phase.frames.every(frame => !frame.active && frame.weight === 0));
    assert.deepEqual(phase.frames.map(frame => frame.offFrame), Array.from(unwrap(timeMapPlanFrames(plan))));
  }
});

test('the shared phase bound rejects a steep curve and accepts its longer version in both directions', () => {
  for (const direction of ['forward', 'reverse'] as const) {
    const bad = unwrap(compileInterpolationPhase(initialTimeMap(unwrap(compileTimeMap(basis(150, curve(150)))), direction)));
    const good = unwrap(compileInterpolationPhase(initialTimeMap(unwrap(compileTimeMap(basis(300, curve(300)))), direction)));
    assert.equal(bad.available, false);
    assert.ok(bad.maxPhaseErrorFrames > INTERPOLATION_PHASE_EPSILON);
    assert.equal(good.available, true);
    assert.ok(good.maxPhaseErrorFrames > 0 && good.maxPhaseErrorFrames < INTERPOLATION_PHASE_EPSILON);
    // The middle of this curve runs faster than one. The slower ends still
    // blend from genuine continuous coordinates, without jumping to an endpoint.
    assert.equal(good.frames[Math.floor(good.frames.length / 2)]!.active, false);
    const coordinates = good.frames.map(({source}) =>
      source.kind === 'numeric' ? source.value : Number(source.numerator) / Number(source.denominator));
    assert.ok(coordinates.slice(1).every((position, index) =>
      direction === 'forward' ? position > coordinates[index]! : position < coordinates[index]!));
  }
});

test('trims and splits preserve one curve clock and quantize only once under the original view', () => {
  const root = unwrap(compileTimeMap(basis(150, curve(150))));
  for (const direction of ['forward', 'reverse'] as const) {
    const plan = initialTimeMap(root, direction);
    const whole = unwrap(compileInterpolationPhase(plan));
    const split = unwrap(splitTimeMap(plan, 27));
    const read = [split.left, split.right, unwrap(trimTimeMap(plan, 16, 49))]
      .map(view => ({view, phase: unwrap(compileInterpolationPhase(view))}));
    assert.deepEqual([...read[0]!.phase.frames, ...read[1]!.phase.frames], whole.frames);
    const pts = new Map(whole.input.map(frame => [frame.sourceFrame, frame.pts]));
    for (const {view, phase} of read) {
      const {fromFrame, toFrame} = view.outputWindow;
      assert.deepEqual(phase.frames, whole.frames.slice(fromFrame, toFrame));
      assert.ok(phase.input.every(frame => frame.pts + fromFrame * 3000 === pts.get(frame.sourceFrame)));
    }
  }
});

test('native VFR PTS set directional frame pairs and exact half-open ties', () => {
  const root = unwrap(compileTimeMap(basis(5, constant(1, 4))));
  const physical = {positions: [0, 1.5, 2, 4], end: 5};
  const forward = unwrap(compileInterpolationPhase(initialTimeMap(root), physical));
  const reverse = unwrap(compileInterpolationPhase(initialTimeMap(root, 'reverse'), physical));
  const key = ({offFrame, fromFrame, toFrame, weight}: (typeof forward.frames)[number]) => [offFrame, fromFrame, toFrame, weight];
  assert.deepEqual(key(forward.frames[3]!), [0, 0, 1, .5]);
  assert.deepEqual(key(forward.frames[6]!), [1, 1, 2, 0]);
  assert.deepEqual(key(reverse.frames[1]!), [3, 3, 2, .25]);
  assert.deepEqual(key(reverse.frames[4]!), [2, 2, 1, 0]);
  assert.ok(forward.available && reverse.available);
  assert.deepEqual(reverse.input.map(frame => frame.sourceFrame), [3, 2, 1, 0]);
  assert.equal(compileInterpolationPhase(initialTimeMap(root), {positions: [0, 1, 1, 2], end: 5}).ok, false);
});

test('the long constant path compiles without materializing a source prefix and admits only 8-bit planar YUV', () => {
  const from = 150_000;
  const root = unwrap(compileTimeMap(basis(from + 3600, constant(1, 4), from)));
  const phase = unwrap(compileInterpolationPhase(initialTimeMap(root)));
  assert.equal(phase.frames.length, 14_400);
  assert.equal(phase.input.length, 3600);
  assert.equal(phase.input[0]!.sourceFrame, from);
  assert.ok(phase.available);
  assert.ok(INTERPOLATION_PIXEL_FORMATS.every(isInterpolationPixelFormat));
  for (const format of ['yuv420p10le', 'yuvj420p', 'rgb24', 'gbrpf32le', 'nv12', 'gray', null]) {
    assert.equal(isInterpolationPixelFormat(format), false);
  }
});
