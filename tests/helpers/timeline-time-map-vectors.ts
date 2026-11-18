/** Shared cross-runtime vectors for the SP-M time mapping.
 *
 * The same helper feeds the committed fixture, the Node test and the headless
 * Chromium check: the integer tables and the stable hash must be byte-identical
 * in both runtimes. Only deterministic arithmetic is used by the module (no
 * libm), so any difference here is a real regression.
 */
import {
  TIMELINE_TIME_MAP_PROFILE, compileFreezeTimeMap, compileTimeMap, initialTimeMap, instantiateSpeedPreset,
  projectSourceBoundaryToQ64, projectTimeMapToCurrentClipFields, reverseTimeMap, splitTimeMap, timeMapPlanFrames,
  timeMapRootInfo, timeMapStableHash, timeMapTailInverse, timeMapVfrFrame, trimTimeMap, verifyCurrentClipTiming,
} from '../../packages/contracts/src/timeline-time-map.ts';
import type {
  ContinuousSourcePosition, TimeMapBasis, TimeMapCurvePoint, TimeMapResult, TimeMapSpeed,
} from '../../packages/contracts/src/timeline-time-map.ts';

export const CROSS_RUNTIME_FIXTURE_VERSION = 1;

export interface CrossRuntimePayload {
  readonly version: number;
  readonly profile: string;
  readonly cases: readonly CrossRuntimeCase[];
}
interface CrossRuntimeCase {
  readonly id: string;
  readonly durationFrames: number;
  readonly forward?: readonly number[];
  readonly reverse?: readonly number[];
  readonly detail?: unknown;
}

const rational = (numerator: number, denominator = 1): {kind: 'rational'; numerator: string; denominator: string} =>
  ({kind: 'rational', numerator: String(numerator), denominator: String(denominator)});

export function timeMapBasisFor(sourceRange: {start: {kind: 'rational'; numerator: string; denominator: string} | {kind: 'q64'; ticks: string};
  end: {kind: 'rational'; numerator: string; denominator: string} | {kind: 'q64'; ticks: string}},
sourceFps: number, outputFps: number, speed: TimeMapSpeed): TimeMapBasis {
  return {profile: 'timeline-speed-v1', sourceFps: {fpsNumerator: sourceFps, fpsDenominator: 1},
    outputFps: {fpsNumerator: outputFps, fpsDenominator: 1}, sourceRange, speed};
}

const unwrap = <T>(value: TimeMapResult<T>, label: string): T => {
  if (!value.ok) throw new Error(`${label}: ${value.code}`);
  return value.value;
};
const frames = (plan: Parameters<typeof timeMapPlanFrames>[0]): readonly number[] =>
  [...unwrap(timeMapPlanFrames(plan), 'plan frames')];

function pushConstant(cases: CrossRuntimeCase[], rate: {numerator: number; denominator: number},
  sourceFps: number, outputFps: number, startFrame: number, spanFrames: number): void {
  const basis = timeMapBasisFor({start: rational(startFrame), end: rational(startFrame + spanFrames)}, sourceFps, outputFps,
    {kind: 'constant', rate: {...rate}});
  const root = unwrap(compileTimeMap(basis), `constant ${rate.numerator}/${rate.denominator} ${sourceFps}->${outputFps}`);
  const forwardPlan = initialTimeMap(root);
  cases.push({id: `constant:${rate.numerator}/${rate.denominator}:${sourceFps}->${outputFps}:${startFrame}+${spanFrames}`,
    durationFrames: root.durationFrames, forward: frames(forwardPlan),
    reverse: frames(reverseTimeMap(forwardPlan)),
    detail: {mapHash: timeMapRootInfo(root).mapHash, rootLength: timeMapRootInfo(root).rootLength}});
}
function pushCurve(cases: CrossRuntimeCase[], id: string, points: readonly TimeMapCurvePoint[], sourceFps = 30, outputFps = 30): void {
  const basis = timeMapBasisFor({start: rational(points[0]!.sourceFrame), end: rational(points[points.length - 1]!.sourceFrame)},
    sourceFps, outputFps, {kind: 'curve', interpolation: 'log-pchip-v1', presetId: id, points});
  const root = unwrap(compileTimeMap(basis), id);
  const plan = initialTimeMap(root);
  // A split and a trim exercise window arithmetic without rerounding the basis.
  const split = unwrap(splitTimeMap(plan, Math.max(1, Math.floor(root.durationFrames / 2))), `${id} split`);
  const trim = unwrap(trimTimeMap(plan, Math.min(5, root.durationFrames - 1), Math.min(root.durationFrames, 10)), `${id} trim`);
  const visible = unwrap(timeMapVisibleSourceRangeFor(plan), `${id} visible`);
  cases.push({id, durationFrames: root.durationFrames, forward: frames(plan), reverse: frames(reverseTimeMap(plan)),
    detail: {mapHash: timeMapRootInfo(root).mapHash, rootLength: timeMapRootInfo(root).rootLength,
      splitLeft: frames(split.left), splitRight: frames(split.right), trim: frames(trim), sourceWindow: visible.sourceWindow}});
}
// Small local adapter: the module keeps the visible-range helper separate from the
// frame-vector one, so this file imports both through the public surface.
import {timeMapVisibleSourceRange as visibleSourceRange} from '../../packages/contracts/src/timeline-time-map.ts';
const timeMapVisibleSourceRangeFor = (plan: Parameters<typeof timeMapPlanFrames>[0]) => visibleSourceRange(plan);

export function buildCrossRuntimePayload(): CrossRuntimePayload {
  const cases: CrossRuntimeCase[] = [];
  const rates = [[1, 10], [1, 4], [1, 2], [1, 1], [11, 10], [3, 2], [2, 1], [10, 1]] as const;
  for (const [numerator, denominator] of rates) pushConstant(cases, {numerator, denominator}, 30, 30, 0, 30);
  for (const fps of [24, 25, 30, 60]) pushConstant(cases, {numerator: 11, denominator: 10}, fps, fps, 0, 30);
  pushConstant(cases, {numerator: 1, denominator: 1}, 30, 24, 0, 150);
  pushConstant(cases, {numerator: 1, denominator: 1}, 24, 30, 0, 150);
  pushCurve(cases, 'curve:reference', [
    {sourceFrame: 0, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 75, rate: {numerator: 4, denominator: 1}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}]);
  pushCurve(cases, 'curve:reference:fps25', [
    {sourceFrame: 0, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 75, rate: {numerator: 4, denominator: 1}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}], 25, 25);
  for (const preset of ['custom', 'fastToSlow', 'slowToFast', 'slowMiddle', 'fastMiddle', 'flashIn', 'flashOut']) {
    const speed = unwrap(instantiateSpeedPreset(preset, 0, 300), `preset ${preset}`);
    if (speed.kind !== 'curve') throw new Error(`preset ${preset} should be a curve`);
    pushCurve(cases, `curve:preset:${preset}`, speed.points);
  }
  const freeze = unwrap(compileFreezeTimeMap({sourceFrame: 42, durationFrames: 60}), 'freeze');
  cases.push({id: 'freeze:42+60', durationFrames: freeze.durationFrames, forward: frames(initialTimeMap(freeze)),
    reverse: frames(reverseTimeMap(initialTimeMap(freeze)))});
  // Tail generalized inverse on the reference curve root.
  const referenceRoot = unwrap(compileTimeMap(timeMapBasisFor({start: rational(0), end: rational(150)}, 30, 30,
    {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'tail', points: [
      {sourceFrame: 0, rate: {numerator: 1, denominator: 4}}, {sourceFrame: 75, rate: {numerator: 4, denominator: 1}},
      {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}]})), 'tail root');
  const referencePlan = initialTimeMap(referenceRoot);
  cases.push({id: 'tail:reference', durationFrames: referenceRoot.durationFrames,
    detail: [{numerator: '115', denominator: '1'}, {numerator: '1159', denominator: '10'}, {numerator: '116', denominator: '1'}]
      .map(position => ({position,
        earliest: unwrap(timeMapTailInverse(referencePlan, position, {tailInverse: 'earliest'}), 'tail earliest'),
        latest: unwrap(timeMapTailInverse(referencePlan, position, {tailInverse: 'latest'}), 'tail latest')}))});
  // Q64 projection on exact and error-bounded positions.
  const q64Inputs: ContinuousSourcePosition[] = [
    {kind: 'exact', numerator: '3', denominator: '2'}, {kind: 'exact', numerator: '1', denominator: '3'},
    {kind: 'exact', numerator: '-1', denominator: '2'}, {kind: 'numeric', value: 1.5, errorBound: 1e-12},
  ];
  cases.push({id: 'q64:projections', durationFrames: 0, detail: q64Inputs.map(value => unwrap(projectSourceBoundaryToQ64(value), 'q64'))});
  // VFR PTS adaptation.
  cases.push({id: 'vfr:ntsc', durationFrames: 0, detail: [{numerator: '1', denominator: '1'}, {numerator: '2', denominator: '1'},
    {numerator: '7', denominator: '2'}].map(position =>
    unwrap(timeMapVfrFrame([0, 0.03336666666666667, 0.0668, 0.10015, 0.1335, 0.16685], 30, {kind: 'exact', ...position}), 'vfr'))});
  // Current clip seams.
  const seamBasis = unwrap(timeMapBasisFromCurrentClipFor(), 'seam');
  const seamRoot = unwrap(compileTimeMap(seamBasis), 'seam root');
  const seamPlan = initialTimeMap(seamRoot);
  cases.push({id: 'seam:current-clip', durationFrames: seamRoot.durationFrames, forward: frames(seamPlan),
    detail: unwrap(projectTimeMapToCurrentClipFields({id: 'clip', startFrame: 0, durationFrames: 90, sourceInFrame: 6}, seamPlan), 'seam projection')});
  cases.push({id: 'seam:verify', durationFrames: 0,
    detail: unwrap(verifyCurrentClipTiming({id: 'clip', startFrame: 0, durationFrames: 90, sourceInFrame: 6}, seamPlan), 'seam verify')});
  return {version: CROSS_RUNTIME_FIXTURE_VERSION, profile: TIMELINE_TIME_MAP_PROFILE, cases};
}
import {timeMapBasisFromCurrentClip} from '../../packages/contracts/src/timeline-time-map.ts';
const timeMapBasisFromCurrentClipFor = () => timeMapBasisFromCurrentClip(
  {id: 'clip', startFrame: 0, durationFrames: 90, sourceInFrame: 6}, {fps: 30});
export function crossRuntimeHash(payload: unknown = buildCrossRuntimePayload()): string {
  return timeMapStableHash(payload);
}
