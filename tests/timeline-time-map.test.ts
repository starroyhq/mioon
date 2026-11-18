import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  TIMELINE_SPEED_PRESETS, TIMELINE_TIME_MAP_ERROR_CODES, compileFreezeTimeMap, compileTimeMap, initialTimeMap,
  instantiateSpeedPreset, projectSourceBoundaryToQ64, projectTimeMapToCurrentClipFields, reverseTimeMap, splitTimeMap,
  timeMapOutputAtSourceFrame, timeMapPlanFrames, timeMapPlanInfo, timeMapRootFrames, timeMapRootInfo,
  timeMapSettingEquals, timeMapSourceAtOutputFrame, timeMapSourceWindowForOutput, timeMapStableHash,
  timeMapTailInverse, timeMapVfrFrame, timeMapVisibleSourceRange, trimTimeMap, verifyCurrentClipTiming,
} from '../packages/contracts/src/timeline-time-map.ts';
import type {TimeMapBasis, TimeMapResult, TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';

const rational = (numerator: number, denominator = 1) => ({kind: 'rational' as const, numerator: String(numerator), denominator: String(denominator)});
const speed = (numerator: number, denominator: number): TimeMapSpeed => ({kind: 'constant', rate: {numerator, denominator}});
function basis(startFrame: number, endFrame: number, value: TimeMapSpeed, sourceFps = 30, outputFps = 30): TimeMapBasis {
  return {profile: 'timeline-speed-v1', sourceFps: {fpsNumerator: sourceFps, fpsDenominator: 1},
    outputFps: {fpsNumerator: outputFps, fpsDenominator: 1},
    sourceRange: {start: rational(startFrame), end: rational(endFrame)}, speed: value};
}
function unwrap<T>(result: TimeMapResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} ${result.detail}`);
  return result.value;
}
const framesOf = (plan: Parameters<typeof timeMapPlanFrames>[0]): number[] => [...unwrap(timeMapPlanFrames(plan), 'frames')];
const curve = (points: readonly {sourceFrame: number; rate: {numerator: number; denominator: number}}[]): TimeMapSpeed =>
  ({kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'test', points});
const labeledCurve = (presetId: string): TimeMapSpeed =>
  ({kind: 'curve', interpolation: 'log-pchip-v1', presetId, points: REFERENCE_POINTS});
const REFERENCE_POINTS = [
  {sourceFrame: 0, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 75, rate: {numerator: 4, denominator: 1}},
  {sourceFrame: 150, rate: {numerator: 1, denominator: 2}},
] as const;
const reference = JSON.parse(readFileSync(new URL('./fixtures/timeline-time-map/reference-v1.json', import.meta.url), 'utf8')) as
  {durationFrames: number; continuousFrames: string; forward: number[]; reverse: number[]};
const referenceRoot = () => unwrap(compileTimeMap(basis(0, 150, curve(REFERENCE_POINTS))), 'reference compile');

test('constant speed: eight rates keep exact rational lengths and the documented frame vectors', () => {
  const expected = [
    [{numerator: 1, denominator: 10}, 1500], [{numerator: 1, denominator: 4}, 600], [{numerator: 1, denominator: 2}, 300],
    [{numerator: 1, denominator: 1}, 150], [{numerator: 11, denominator: 10}, 137], [{numerator: 3, denominator: 2}, 100],
    [{numerator: 2, denominator: 1}, 75], [{numerator: 10, denominator: 1}, 15],
  ] as const;
  for (const [rate, duration] of expected) {
    const root = unwrap(compileTimeMap(basis(0, 150, speed(rate.numerator, rate.denominator))), `${rate.numerator}/${rate.denominator}`);
    assert.equal(root.durationFrames, duration);
    assert.equal(timeMapRootInfo(root).rootLength.kind, 'exact');
    const forward = framesOf(initialTimeMap(root));
    assert.equal(forward.length, duration);
    assert.ok(forward.every((frame, index) => index === 0 || frame >= forward[index - 1]!), 'forward sampling is monotone');
    assert.ok(forward.every(frame => frame >= 0 && frame < 150));
    const reverse = framesOf(initialTimeMap(root, 'reverse'));
    assert.ok(reverse.every((frame, index) => index === 0 || frame <= reverse[index - 1]!), 'reverse sampling is monotone');
  }
  assert.deepEqual(framesOf(initialTimeMap(unwrap(compileTimeMap(basis(0, 6, speed(3, 2))), '1.5x'))), [0, 1, 3, 4]);
  assert.deepEqual(framesOf(initialTimeMap(unwrap(compileTimeMap(basis(0, 6, speed(3, 2))), '1.5x'), 'reverse')), [5, 4, 2, 1]);
  assert.deepEqual(framesOf(initialTimeMap(unwrap(compileTimeMap(basis(0, 6, speed(1, 2))), '0.5x'))), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
})

test('rational timebases convert the output clock exactly (24/25/30/60)', () => {
  for (const [sourceFps, outputFps, duration] of [[24, 24, 150], [25, 25, 150], [30, 30, 150], [60, 60, 150], [30, 24, 120], [24, 30, 188]] as const) {
    const root = unwrap(compileTimeMap(basis(0, 150, speed(1, 1), sourceFps, outputFps)), `${sourceFps}->${outputFps}`);
    assert.equal(root.durationFrames, duration, `${sourceFps}->${outputFps}`);
    assert.deepEqual(framesOf(initialTimeMap(root)).slice(0, 4), [0, 1, 2, 3].map(frame => Math.floor(frame * sourceFps / outputFps)));
  }
})

test('splitting every cut point rebuilds the identity and two direction flips restore the plan', () => {
  for (const [numerator, denominator] of [[11, 10], [3, 2], [1, 2], [10, 1]] as const) {
    for (const span of [6, 17, 150]) {
      const root = unwrap(compileTimeMap(basis(0, span, speed(numerator, denominator))), `${numerator}/${denominator}:${span}`);
      for (const direction of ['forward', 'reverse'] as const) {
        const original = direction === 'forward' ? initialTimeMap(root) : initialTimeMap(root, 'reverse');
        const expected = framesOf(original);
        for (let cut = 1; cut < original.durationFrames; cut++) {
          const split = unwrap(splitTimeMap(original, cut), 'split');
          assert.deepEqual([...framesOf(split.left), ...framesOf(split.right)], expected, `cut ${cut} ${direction} ${span}`);
        }
        assert.deepEqual(framesOf(reverseTimeMap(reverseTimeMap(original))), expected, 'double reverse');
        if (direction === 'forward') assert.deepEqual(framesOf(reverseTimeMap(original)), framesOf(initialTimeMap(root, 'reverse')));
      }
    }
  }
})

test('the PCHIP reference vector and the SP0 continuous boundary agree frame by frame', () => {
  const root = referenceRoot();
  assert.equal(root.durationFrames, reference.durationFrames);
  assert.equal(timeMapRootInfo(root).rootLength.kind, 'numeric');
  const plan = initialTimeMap(root);
  assert.deepEqual(framesOf(plan), reference.forward, 'forward samples match the Decimal60-checked prototype');
  assert.deepEqual(framesOf(initialTimeMap(root, 'reverse')), reference.reverse, 'reverse samples match');
  // The continuous boundary is inside the reported error bound.
  const info = timeMapRootInfo(root);
  assert.equal(info.rootLength.kind, 'numeric');
  if (info.rootLength.kind === 'numeric') {
    const referenceBoundary = 115.777885606391382715525284109620541952450689955943482885107;
    assert.ok(Math.abs(info.rootLength.value - referenceBoundary) <= Math.max(info.rootLength.errorBound, 1e-12));
  }
  // Root frame vectors are the same objects the plan slices.
  assert.deepEqual([...unwrap(timeMapRootFrames(root, 'forward'), 'root frames')], reference.forward);
  assert.deepEqual([...unwrap(timeMapRootFrames(root, 'reverse'), 'root frames reverse')], reference.reverse);
})

test('curve windows split without refitting and the visible envelope is the strict frame projection', () => {
  const root = referenceRoot();
  const plan = initialTimeMap(root);
  const expected = framesOf(plan);
  for (const cut of [1, 57, 58, 100, 115]) {
    const split = unwrap(splitTimeMap(plan, cut), 'split');
    assert.deepEqual([...framesOf(split.left), ...framesOf(split.right)], expected, `curve cut ${cut}`);
  }
  const trimmed = unwrap(trimTimeMap(plan, 10, 60), 'trim');
  assert.deepEqual(framesOf(trimmed), expected.slice(10, 60));
  const visible = unwrap(timeMapVisibleSourceRange(plan), 'visible');
  assert.equal(visible.sourceWindow.startFrame, 0);
  assert.equal(visible.sourceWindow.endFrame, 150);
  const window = unwrap(timeMapSourceWindowForOutput(plan, {contextFrames: 3}), 'source window');
  assert.deepEqual([window.startFrame, window.endFrame, window.frameCount], [0, 150, 150]);
  const planInfo = unwrap(timeMapPlanInfo(trimmed), 'plan info');
  assert.equal(planInfo.durationFrames, 50);
  assert.equal(planInfo.direction, 'forward');
})

test('the Q32 endpoint trap would add a frame; the window algebra keeps one', () => {
  const root = unwrap(compileTimeMap(basis(0, 60, speed(11, 10))), '1.1x');
  const oneFrame = unwrap(trimTimeMap(initialTimeMap(root), 1, 2), 'window [1,2)');
  assert.deepEqual(framesOf(oneFrame), [1]);
  // Reproduce the rejected numerical shortcut: floor each exact endpoint to Q32,
  // subtract, divide by 2^32 and by the rate, then ceil.
  const q32 = 2n ** 32n;
  const start = (BigInt(1) * q32 * 11n) / 10n;
  const end = (BigInt(2) * q32 * 11n) / 10n;
  const naiveFrames = Math.ceil(Number(end - start) / Number(q32) / 1.1);
  assert.equal(naiveFrames, 2, 'the Q32 shortcut is expected to add a frame');
  assert.equal(oneFrame.durationFrames, 1);
})

test('the eight presets instantiate to the committed point sets and compile to stable durations', () => {
  const expectedPoints: Record<string, number[]> = {
    custom: [0, 300], fastToSlow: [0, 150, 300], slowToFast: [0, 150, 300], slowMiddle: [0, 150, 300],
    fastMiddle: [0, 150, 300], flashIn: [0, 75, 300], flashOut: [0, 225, 300],
  };
  const expectedDuration: Record<string, number> = {
    custom: 300, fastToSlow: 246, slowToFast: 246, slowMiddle: 707, fastMiddle: 186, flashIn: 273, flashOut: 273,
  };
  assert.equal(TIMELINE_SPEED_PRESETS.length, 8);
  assert.equal(unwrap(instantiateSpeedPreset('none', 0, 300), 'none').kind, 'constant');
  for (const [preset, points] of Object.entries(expectedPoints)) {
    const value = unwrap(instantiateSpeedPreset(preset, 0, 300), preset);
    assert.equal(value.kind, 'curve');
    if (value.kind === 'curve') assert.deepEqual(value.points.map(point => point.sourceFrame), points, preset);
    const root = unwrap(compileTimeMap(basis(0, 300, value)), `${preset} compile`);
    assert.equal(root.durationFrames, expectedDuration[preset], preset);
  }
  assert.equal(instantiateSpeedPreset('nope', 0, 300).ok, false);
  assert.equal(instantiateSpeedPreset('custom', 0, 1).ok, false);
})

test('a same-value setting is a strict no-op; the point set is authoritative over its label', () => {
  const first = basis(0, 150, speed(3, 2));
  assert.equal(timeMapSettingEquals(first, basis(0, 150, speed(3, 2))), true);
  assert.equal(timeMapSettingEquals(first, basis(0, 150, speed(2, 1))), false);
  assert.equal(timeMapSettingEquals(first, basis(0, 149, speed(3, 2))), false);
  const left = basis(0, 150, labeledCurve('fastToSlow'));
  const right = basis(0, 150, labeledCurve('custom'));
  assert.equal(timeMapSettingEquals(left, right), true, 'the point set, not the preset label, defines the map');
  assert.equal(timeMapRootInfo(unwrap(compileTimeMap(left), 'left')).mapHash, timeMapRootInfo(unwrap(compileTimeMap(right), 'right')).mapHash);
})

test('the tail holds use an explicit earliest/latest generalized inverse', () => {
  const root = referenceRoot();
  const plan = initialTimeMap(root);
  const inside = unwrap(timeMapTailInverse(plan, {numerator: '115', denominator: '1'}, {tailInverse: 'latest'}), 'inside');
  assert.equal(inside.tail, false);
  assert.ok(inside.frame >= 145 && inside.frame <= 150);
  const earliest = unwrap(timeMapTailInverse(plan, {numerator: '116', denominator: '1'}, {tailInverse: 'earliest'}), 'tail earliest');
  const latest = unwrap(timeMapTailInverse(plan, {numerator: '116', denominator: '1'}, {tailInverse: 'latest'}), 'tail latest');
  assert.equal(earliest.tail, true);
  assert.equal(latest.tail, true);
  assert.deepEqual([earliest.frame, latest.frame], [0, 149]);
  assert.deepEqual([earliest.position.kind === 'numeric' ? earliest.position.value : -1,
    latest.position.kind === 'numeric' ? latest.position.value : -1], [0, 150]);
  // Constant roots use exact rationals.
  const constant = initialTimeMap(unwrap(compileTimeMap(basis(0, 6, speed(3, 2))), '1.5x'));
  assert.equal(unwrap(timeMapTailInverse(constant, {numerator: '5', denominator: '1'}, {tailInverse: 'earliest'}), 'constant tail').tail, true);
  assert.equal(unwrap(timeMapTailInverse(constant, {numerator: '5', denominator: '1'}, {tailInverse: 'latest'}), 'constant tail').frame, 4);
})

test('samples, source windows and reverse lookup agree with the frame vector', () => {
  const root = unwrap(compileTimeMap(basis(0, 6, speed(3, 2))), '1.5x');
  const plan = initialTimeMap(root);
  const sample = unwrap(timeMapSourceAtOutputFrame(plan, 2), 'sample');
  assert.equal(sample.source.kind, 'exact');
  assert.equal(sample.sourceFrame, 3);
  assert.equal(sample.nextSourceFrame, 4);
  assert.equal(unwrap(timeMapOutputAtSourceFrame(plan, 3), 'output at source').firstOutputFrame, 2);
  assert.equal(unwrap(timeMapOutputAtSourceFrame(plan, 2), 'output at source').firstOutputFrame, null);
  const missing = unwrap(timeMapOutputAtSourceFrame(plan, 2), 'output at source');
  assert.equal(missing.status, 'inside');
  const before = unwrap(timeMapOutputAtSourceFrame(plan, 0), 'output at source');
  assert.equal(before.status, 'inside');
  // The visible envelope of the full 1x root is the complete source range.
  const identity = initialTimeMap(unwrap(compileTimeMap(basis(0, 90, speed(1, 1))), '1x'));
  assert.deepEqual(unwrap(timeMapVisibleSourceRange(identity), 'identity visible').sourceWindow, {startFrame: 0, endFrame: 90});
})

test('freeze holds one exact frame for the whole duration', () => {
  const root = unwrap(compileFreezeTimeMap({sourceFrame: 42, durationFrames: 60}), 'freeze');
  assert.equal(root.interpolation, 'freeze');
  assert.equal(root.durationFrames, 60);
  assert.deepEqual([...new Set(framesOf(initialTimeMap(root)))], [42]);
  assert.deepEqual([...new Set(framesOf(initialTimeMap(root, 'reverse')))], [42]);
  assert.equal(unwrap(timeMapPlanInfo(initialTimeMap(root)), 'freeze info').sourceWindow.startFrame, 42);
  assert.equal(compileFreezeTimeMap({sourceFrame: 42, durationFrames: 0}).ok, false);
})

test('Q64 projection rounds ties to even, keeps exact values exact and fails undecidable bounds', () => {
  assert.deepEqual(unwrap(projectSourceBoundaryToQ64({kind: 'exact', numerator: '3', denominator: '2'}), '3/2'),
    {boundary: {kind: 'q64', ticks: '27670116110564327424'}, rounded: 'exact'});
  assert.deepEqual(unwrap(projectSourceBoundaryToQ64({kind: 'exact', numerator: '-1', denominator: '2'}), '-1/2'),
    {boundary: {kind: 'q64', ticks: '-9223372036854775808'}, rounded: 'exact'});
  // 2^-65 is exactly halfway between 0 and 2^-64; ties-to-even picks 0.
  const scale = 2n ** 65n;
  assert.deepEqual(unwrap(projectSourceBoundaryToQ64({kind: 'exact', numerator: '1', denominator: String(scale)}), 'tie'), {boundary: {kind: 'q64', ticks: '0'}, rounded: 'exact'});
  // 3*2^-65 is halfway between 2^-64 and 2*2^-64; ties-to-even picks 2^-64.
  assert.deepEqual(unwrap(projectSourceBoundaryToQ64({kind: 'exact', numerator: '3', denominator: String(scale)}), 'tie2'), {boundary: {kind: 'q64', ticks: '2'}, rounded: 'exact'});
  assert.deepEqual(unwrap(projectSourceBoundaryToQ64({kind: 'numeric', value: 1.5, errorBound: 1e-12}), 'numeric'),
    {boundary: {kind: 'q64', ticks: '27670116110564327424'}, rounded: 'nearest'});
  const ambiguous = projectSourceBoundaryToQ64({kind: 'numeric', value: 1.5000000001, errorBound: 1e-6});
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, 'NUMERIC_BUDGET_EXCEEDED');
})

test('VFR PTS adaptation picks ordinals by presentation time and reports the phase', () => {
  const pts = [0, 0.03336666666666667, 0.0668, 0.10015, 0.1335, 0.16685];
  const second = unwrap(timeMapVfrFrame(pts, 30, {kind: 'exact', numerator: '2', denominator: '1'}), 'vfr second');
  assert.equal(second.frame, 1);
  assert.equal(second.nextFrame, 2);
  assert.ok(second.phase > 0.9);
  const first = unwrap(timeMapVfrFrame(pts, 30, {kind: 'exact', numerator: '0', denominator: '1'}), 'vfr first');
  assert.equal(first.frame, 0);
  assert.equal(first.phase, 0);
  assert.equal(timeMapVfrFrame([1, 0], 30, {kind: 'exact', numerator: '0', denominator: '1'}).ok, false);
})

test('current clip seam reads identity timing and verifies the integer projection', () => {
  const clip = {id: 'clip', startFrame: 0, durationFrames: 90, sourceInFrame: 6};
  const source = unwrap(timeMapBasisFromCurrentClipHelper(clip), 'clip basis');
  const root = unwrap(compileTimeMap(source), 'clip root');
  const plan = initialTimeMap(root);
  assert.equal(root.durationFrames, 90);
  assert.deepEqual(framesOf(plan).slice(0, 3), [6, 7, 8]);
  assert.deepEqual(unwrap(projectTimeMapToCurrentClipFields(clip, plan), 'projection'),
    {startFrame: 0, durationFrames: 90, sourceInFrame: 6, sourceSpanFrames: 90});
  assert.equal(unwrap(verifyCurrentClipTiming(clip, plan), 'verify').matches, true);
  assert.equal(unwrap(verifyCurrentClipTiming({...clip, durationFrames: 89}, plan), 'verify mismatch').matches, false);
  assert.equal(timeMapBasisFromCurrentClipHelper({...clip, durationFrames: 0}).ok, false);
})

test('invalid inputs fail with named error codes instead of being normalised', () => {
  const errors = new Set<string>(TIMELINE_TIME_MAP_ERROR_CODES);
  const codes: string[] = [];
  const record = (result: TimeMapResult<unknown>): void => { if (!result.ok) codes.push(result.code); };
  record(compileTimeMap({...basis(0, 150, speed(1, 1)), profile: 'other' as never}));
  record(compileTimeMap(basis(0, 150, speed(1, 20))));
  record(compileTimeMap(basis(0, 150, speed(20, 1))));
  record(compileTimeMap(basis(0, 150, speed(2, 2))));
  record(compileTimeMap(basis(0, 150, curve([{sourceFrame: 0, rate: {numerator: 1, denominator: 1}}]))));
  record(compileTimeMap(basis(0, 150, curve([...REFERENCE_POINTS, {sourceFrame: 151, rate: {numerator: 1, denominator: 1}}]))));
  record(compileTimeMap(basis(0, 20, curve([{sourceFrame: 0, rate: {numerator: 1, denominator: 1}}, {sourceFrame: 10, rate: {numerator: 2, denominator: 1}}]))));
  record(compileTimeMap(basis(0, 150, curve(
    Array.from({length: 33}, (_, index) => ({sourceFrame: index * 5, rate: {numerator: 1, denominator: 1}}))))));
  record(compileTimeMap(basis(0, 150, speed(1, 1), 0, 30)));
  record(compileTimeMap(basis(-1, 150, speed(1, 1))));
  record(compileTimeMap(basis(0, 3_000_001, speed(1, 1))));
  record(compileTimeMap(basis(0, 30_001, speed(1, 10))));
  const plan = initialTimeMap(unwrap(compileTimeMap(basis(0, 17, speed(3, 2))), 'plan'));
  record(splitTimeMap(plan, 0));
  record(splitTimeMap(plan, plan.durationFrames));
  record(trimTimeMap(plan, 2, 2));
  record(trimTimeMap(plan, 3, 2));
  record(trimTimeMap(plan, 0, plan.durationFrames + 1));
  for (const code of codes) assert.ok(errors.has(code), code);
  assert.ok(codes.includes('UNSUPPORTED_PROFILE'));
  assert.ok(codes.includes('INVALID_RATE'));
  assert.ok(codes.includes('INVALID_TIMEBASE'));
  assert.ok(codes.includes('INVALID_SOURCE_RANGE'));
  assert.ok(codes.includes('INVALID_CURVE_POINTS'));
  assert.ok(codes.includes('POINT_LIMIT'));
  assert.ok(codes.includes('SOURCE_FRAME_LIMIT'));
  assert.ok(codes.includes('OUTPUT_FRAME_LIMIT'));
  assert.ok(codes.includes('INVALID_WINDOW'));
})

test('curve compilation refuses to exceed its cell budget and refuses an undecidable integer boundary', () => {
  const budget = compileTimeMap(basis(0, 150, curve([
    {sourceFrame: 0, rate: {numerator: 1, denominator: 2}}, {sourceFrame: 75, rate: {numerator: 2, denominator: 1}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}])), {maxCurveCells: 8});
  assert.equal(budget.ok, false);
  if (!budget.ok) assert.equal(budget.code, 'NUMERIC_BUDGET_EXCEEDED');
  // A Q64 sub-range whose log-PCHIP integral is the integer 100 to within 3e-20:
  // the refinement ladder must not "fix" this with an epsilon.
  const boundaryEnd = {kind: 'q64' as const, ticks: '1237663630474958638547'};
  const undecidable: TimeMapBasis = {profile: 'timeline-speed-v1', sourceFps: {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: {fpsNumerator: 30, fpsDenominator: 1}, sourceRange: {start: rational(0), end: boundaryEnd},
    speed: curve([{sourceFrame: 0, rate: {numerator: 1, denominator: 2}}, {sourceFrame: 150, rate: {numerator: 2, denominator: 1}}])};
  const result = compileTimeMap(undecidable);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'UNRESOLVED_BOUNDARY');
})

test('the contract barrel exports the SP-M module for downstream SP-D consumers', async () => {
  const contracts = await import('../packages/contracts/src/index.ts');
  assert.equal(typeof contracts.compileTimeMap, 'function');
  assert.equal(typeof contracts.timeMapPlanFrames, 'function');
  assert.equal(contracts.TIMELINE_TIME_MAP_PROFILE, 'timeline-time-map-v1');
})

test('the cross-runtime stable hash is order-insensitive for object keys and sensitive to values', () => {
  assert.equal(timeMapStableHash({a: 1, b: [2, 3]}), timeMapStableHash({b: [2, 3], a: 1}));
  assert.notEqual(timeMapStableHash({a: 1}), timeMapStableHash({a: 2}));
})

// Local helper indirection keeps the import list explicit for the type checker.
import {timeMapBasisFromCurrentClip} from '../packages/contracts/src/timeline-time-map.ts';
function timeMapBasisFromCurrentClipHelper(clip: {id: string; startFrame: number; durationFrames: number; sourceInFrame: number}) {
  return timeMapBasisFromCurrentClip(clip, {fps: 30});
}
