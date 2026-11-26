import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTimeMap, initialTimeMap, instantiateSpeedPreset, timeMapPlanFrames, trimTimeMap,
  type TimeMapBasis, type TimeMapResult, type TimeMapSourceBoundary,
} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {
  speedExportClipPlan, speedPictureWindows, speedTransitionHandle,
} from '../packages/business/src/timeline-speed-export-plan.ts';

const rational = (value: number): TimeMapSourceBoundary => ({kind: 'rational', numerator: String(value), denominator: '1'});
const clock = {fpsNumerator: 30, fpsDenominator: 1};
function result<T>(value: TimeMapResult<T>): T {
  assert.ok(value.ok, JSON.stringify(value));
  return value.value;
}
function timing(basis: TimeMapBasis, fromFrame: number, toFrame: number, direction: 'forward' | 'reverse' = 'forward'): ClipTiming {
  return {profile: 'timeline-speed-v1', basis, pitchShift: false, interpolation: 'off',
    view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction},
    outputWindow: {fromFrame, toFrame}};
}
const vector = (plan: Parameters<typeof timeMapPlanFrames>[0]): number[] => Array.from(result(timeMapPlanFrames(plan)));

test('speed export constant transition handles use exact motion boundaries and preserve output phase', () => {
  const basis: TimeMapBasis = {profile: 'timeline-speed-v1', speed: {kind: 'constant', rate: {numerator: 3, denominator: 2}},
    sourceFps: clock, outputFps: clock, sourceRange: {start: rational(12), end: rational(24)}};
  const clip = {id: 'constant', startFrame: 20, durationFrames: 8, sourceInFrame: 12, timing: timing(basis, 0, 8)};
  const plan = speedExportClipPlan(clip, 30);
  const windows = speedPictureWindows(clip, plan, {start: 17, end: 31}, {start: 19, end: 30}, 30);
  assert.deepEqual(windows.map(window => [window.beginFrame, window.endFrame, vector(window.plan)]),
    [[19, 20, [10]], [20, 28, [12, 13, 15, 16, 18, 19, 21, 22]], [28, 30, [24, 25]]]);
  assert.throws(() => speedTransitionHandle(clip, plan, 'after', 5, 30), {code: 'SPEED_MAPPING_INVALID'});
});

for (const direction of ['forward', 'reverse'] as const) {
  test(`speed export ${direction} curve handles and selected pieces retain the same integral`, () => {
    const basis: TimeMapBasis = {profile: 'timeline-speed-v1', speed: result(instantiateSpeedPreset('fastToSlow', 0, 150)),
      sourceFps: clock, outputFps: clock, sourceRange: {start: rational(0), end: rational(150)}};
    const root = result(compileTimeMap(basis));
    const reference = initialTimeMap(root, direction);
    const full = vector(reference), selected = result(trimTimeMap(reference, 7, 15));
    const clip = {id: 'curve', startFrame: 20, durationFrames: 8, sourceInFrame: Math.min(...vector(selected)),
      timing: timing(basis, 7, 15, direction)};
    const plan = speedExportClipPlan(clip, 30);
    const windows = speedPictureWindows(clip, plan, {start: 17, end: 30}, {start: 18, end: 29}, 150);
    assert.deepEqual(windows.flatMap(window => vector(window.plan)), full.slice(5, 16));
    assert.ok(windows.every(window => window.plan.root.mapHash === root.mapHash));
    assert.throws(() => speedTransitionHandle(clip, plan, 'before', 8, 150), {code: 'SPEED_MAPPING_INVALID'});
  });
}

test('speed export freeze transition handles repeat the exact locked source frame', () => {
  const clip = {id: 'freeze', startFrame: 6, durationFrames: 4, sourceInFrame: 42,
    timing: {profile: 'timeline-freeze-v1', sourceFrame: 42, sourceVersionId: null, sourceSha256: 'f'.repeat(64)} as const};
  const plan = speedExportClipPlan(clip, 30);
  const windows = speedPictureWindows(clip, plan, {start: 3, end: 12}, {start: 4, end: 12}, 43);
  assert.deepEqual(windows.flatMap(window => vector(window.plan)), Array(8).fill(42));
  assert.throws(() => speedTransitionHandle(clip, plan, 'after', 2, 42), {code: 'SPEED_MAPPING_INVALID'});
});
