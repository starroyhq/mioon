import assert from 'node:assert/strict';
import test from 'node:test';
import {compileTimeMap, initialTimeMap, timeMapPlanFrames, timeMapRootInfo} from '../packages/contracts/src/timeline-time-map.ts';

/** 300k-frame curve compile benchmark. The card asks for the compile time of the
 * longest supported window with a 32-point curve; CI reports the same numbers
 * from this test's stdout. */
function curveBasis(points: readonly {sourceFrame: number; rate: {numerator: number; denominator: number}}[]) {
  return {profile: 'timeline-speed-v1' as const, sourceFps: {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: {fpsNumerator: 30, fpsDenominator: 1},
    sourceRange: {start: {kind: 'rational' as const, numerator: '0', denominator: '1'},
      end: {kind: 'rational' as const, numerator: String(points[points.length - 1]!.sourceFrame), denominator: '1'}},
    speed: {kind: 'curve' as const, interpolation: 'log-pchip-v1' as const, presetId: 'perf', points}};
}
function thirtyTwoPointsOver(span: number) {
  return Array.from({length: 32}, (_, index) => ({
    sourceFrame: Math.round(index * span / 31),
    rate: index % 2 === 0 ? {numerator: 4, denominator: 5} : {numerator: 5, denominator: 4},
  }));
}

test('the longest supported 32-point curve compiles and materialises its frame vector within budget', () => {
  const span = 296_000;
  const basis = curveBasis(thirtyTwoPointsOver(span));
  const compileStart = performance.now();
  const root = compileTimeMap(basis);
  const compileMs = performance.now() - compileStart;
  assert.equal(root.ok, true);
  if (!root.ok) return;
  assert.ok(root.value.durationFrames > 295_000 && root.value.durationFrames <= 300_000, String(root.value.durationFrames));
  const info = timeMapRootInfo(root.value);
  assert.equal(info.rootLength.kind, 'numeric');
  const plan = initialTimeMap(root.value);
  const framesStart = performance.now();
  const frames = timeMapPlanFrames(plan);
  const framesMs = performance.now() - framesStart;
  assert.equal(frames.ok, true);
  if (!frames.ok) return;
  assert.equal(frames.value.length, root.value.durationFrames);
  assert.ok(frames.value[frames.value.length - 1]! >= 0);
  assert.ok(compileMs < 10_000, `compile took ${compileMs.toFixed(1)}ms`);
  assert.ok(framesMs < 60_000, `frame vector took ${framesMs.toFixed(1)}ms`);
  // Reported in CI logs and copied into the SP-M report; no silent threshold.
  console.log(JSON.stringify({benchmark: 'timeline-time-map', outputFrames: root.value.durationFrames,
    curvePoints: basis.speed.points.length, compileMs: Number(compileMs.toFixed(1)), frameVectorMs: Number(framesMs.toFixed(1)),
    rootLength: info.rootLength}));
})
