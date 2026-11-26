import assert from 'node:assert/strict';
import test from 'node:test';
import {timelineClipSourceAtFrame} from '../packages/contracts/src/timeline-clip-timing.ts';
import {
  compileTimeMap, initialTimeMap, timeMapPlanFrames, timeMapPlanInfo, timeMapTailInverse, trimTimeMap,
  type CompiledTimeMap, type TimeMapBasis, type TimeMapResult, type TimeMapSpeed,
} from '../packages/contracts/src/timeline-time-map.ts';
import {projectTimelineWaveformPeaks} from '../packages/business/src/timeline-preview-waveform.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';

const fps = 30, timeline = {fps};
const clip = {id: 'clip', startFrame: 90, durationFrames: 30, sourceInFrame: 3};
const clock = {fpsNumerator: fps, fpsDenominator: 1};
const sourceBoundary = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const constant = (numerator: number, denominator = 1): TimeMapSpeed => ({kind: 'constant', rate: {numerator, denominator}});
const variable: TimeMapSpeed = {kind: 'curve', presetId: 'test', interpolation: 'log-pchip-v1', points: [
  {sourceFrame: 3, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 78, rate: {numerator: 4, denominator: 1}},
  {sourceFrame: 153, rate: {numerator: 1, denominator: 2}},
]};
function unwrap<T>(result: TimeMapResult<T>): T {
  if (!result.ok) assert.fail(`${result.code}: ${result.detail}`);
  return result.value;
}
function compiled(speed: TimeMapSpeed, end: number, direction: 'forward' | 'reverse' = 'forward',
  slice?: {from: number; to: number}): {plan: CompiledTimeMap; basis: TimeMapBasis} {
  const basis: TimeMapBasis = {profile: 'timeline-speed-v1', speed, sourceFps: clock, outputFps: clock,
    sourceRange: {start: sourceBoundary(clip.sourceInFrame), end: sourceBoundary(end)}};
  const plan = initialTimeMap(unwrap(compileTimeMap(basis)), direction);
  return {basis, plan: slice ? unwrap(trimTimeMap(plan, slice.from, slice.to)) : plan};
}
function timed({plan, basis}: ReturnType<typeof compiled>) {
  const {loTime, hiTime} = unwrap(timeMapPlanInfo(plan));
  const timing: ClipTiming = {profile: 'timeline-speed-v1', basis,
    view: {loTime, hiTime, direction: plan.direction}, outputWindow: plan.outputWindow,
    pitchShift: false, interpolation: 'off'};
  return {...clip, durationFrames: plan.durationFrames, timing};
}
const sourceFixture = {sampleFrames: 288_000, peaks: Array.from({length: 600}, (_, index) => index * 100)};
const normalized = (index: number) => index * 100 / 65535;

test('thumbnail sampling uses the shared frame table for both directions and clipped curve phase', () => {
  for (const direction of ['forward', 'reverse'] as const) {
    const maps: ReturnType<typeof compiled>[] = [compiled(constant(3, 2), 33, direction), compiled(variable, 153, direction)];
    for (const map of maps) {
      const plan: CompiledTimeMap = map.plan;
      const trimmed: CompiledTimeMap = unwrap(trimTimeMap(plan, 4, plan.durationFrames - 3));
      const projected = timed({plan: trimmed, basis: map.basis});
      const expected: Int32Array = unwrap(timeMapPlanFrames(trimmed));
      const marks = [0, 1, Math.floor(expected.length / 2), expected.length - 1];
      for (const mark of marks) {
        assert.equal(unwrap(timelineClipSourceAtFrame(projected, timeline, clip.startFrame + mark)).sourceFrame, expected[mark]);
      }
      assert.equal(timelineClipSourceAtFrame(projected, timeline, clip.startFrame + expected.length).ok, false);
    }
  }
  assert.equal(unwrap(timelineClipSourceAtFrame(clip, timeline, clip.startFrame + 2)).sourceFrame, 5);
  assert.equal(timelineClipSourceAtFrame(clip, timeline, clip.startFrame - 1).ok, false);
});

test('continuous curve inverse stays within its segment for steep first and last slopes', () => {
  for (const direction of ['forward', 'reverse'] as const) {
    const map = compiled(variable, 153, direction), {plan} = map;
    const expected = unwrap(timeMapPlanFrames(plan));
    const projectedClip = timed(map);
    for (const mark of [17, 30, 75, 90, 100]) {
      const value = unwrap(timeMapTailInverse(plan, {numerator: String(mark), denominator: '1'}, {tailInverse: 'latest'}));
      assert.equal(value.tail, false);
      assert.equal(value.frame, expected[mark], `${direction} output frame ${mark}`);
      const projected = unwrap(timelineClipSourceAtFrame(projectedClip, timeline, clip.startFrame + mark));
      assert.equal(projected.sourceFrame, expected[mark]);
      assert.equal(projected.source.kind, 'numeric');
      assert.equal(value.position.kind, 'numeric');
      assert.ok(Math.abs(projected.source.value - value.position.value) <= projected.source.errorBound + value.position.errorBound);
    }
  }
});

test('waveforms aggregate source peaks in output order and retain phase after trimming', () => {
  const forward = timed(compiled(constant(2), 33));
  const reverse = timed(compiled(constant(2), 33, 'reverse'));
  const full = {outputStartFrame: 90, outputEndFrame: 105, points: 5};
  const expected = [29, 49, 69, 89, 109].map(normalized);
  assert.deepEqual(projectTimelineWaveformPeaks(forward, fps, full, sourceFixture), expected);
  assert.deepEqual(projectTimelineWaveformPeaks(reverse, fps, full, sourceFixture), [...expected].reverse());
  const trim = timed(compiled(constant(2), 33, 'forward', {from: 3, to: 12}));
  assert.deepEqual(projectTimelineWaveformPeaks(trim, fps, {...full, outputEndFrame: 99, points: 3}, sourceFixture), expected.slice(1, 4));
  assert.throws(() => projectTimelineWaveformPeaks(trim, fps, full, sourceFixture), {code: 'SOURCE_BOUNDS'});
});

test('a curve waveform mirrors its source intervals when traversed in reverse', () => {
  const mapping = compiled(variable, 153);
  const window = {outputStartFrame: 90, outputEndFrame: 90 + mapping.plan.durationFrames, points: 7};
  const forward = projectTimelineWaveformPeaks(timed(mapping), fps, window, sourceFixture);
  // Speed changes the size of the source-clock group for each output group.
  assert.ok(forward.slice(1).every((peak, index) => peak! > forward[index]!), JSON.stringify(forward));
  assert.notEqual(forward[1]! - forward[0]!, forward[2]! - forward[1]!);
  const reverse = projectTimelineWaveformPeaks(timed(compiled(variable, 153, 'reverse')), fps, window, sourceFixture);
  // The fractional last output frame holds video and is silent in audio. A
  // full-window bin can straddle that tail, so the two loudest extrema agree.
  assert.equal(forward.at(-1), normalized(509));
  assert.equal(reverse[0], normalized(509));
  assert.ok(reverse.slice(1).every((peak, index) => peak! < reverse[index]!));
});

test('freeze is silent and exact, and a fractional motion tail differs from missing decoded input', () => {
  const freeze = {...clip, timing: {profile: 'timeline-freeze-v1', sourceFrame: 7, sourceVersionId: null,
    sourceSha256: 'a'.repeat(64)} satisfies ClipTiming};
  assert.equal(unwrap(timelineClipSourceAtFrame(freeze, timeline, 117)).sourceFrame, 7);
  const frozen = {outputStartFrame: 90, outputEndFrame: 120, points: 4};
  assert.deepEqual(projectTimelineWaveformPeaks(freeze, fps, frozen, {sampleFrames: 0, peaks: []}), [0, 0, 0, 0]);
  const tail = timed(compiled(constant(10), 14));
  const lastFrame = {outputStartFrame: 91, outputEndFrame: 92, points: 4};
  assert.deepEqual(projectTimelineWaveformPeaks(tail, fps, lastFrame, sourceFixture), [normalized(46), 0, 0, 0]);
  assert.deepEqual(projectTimelineWaveformPeaks(tail, fps, lastFrame, {sampleFrames: 20_000, peaks: sourceFixture.peaks}), [null, 0, 0, 0]);
});
