/** Phase math for the SP-I0 prototype. No product code, no formats. */
import {compileTimeMap, initialTimeMap, timeMapSourceAtOutputFrame, trimTimeMap}
  from '../../packages/contracts/src/timeline-time-map.ts';

export const FPS = 30;
export const CURVE_POINTS = Object.freeze([
  {sourceFrame: 0, rate: {numerator: 1, denominator: 6}},
  {sourceFrame: 75, rate: {numerator: 1, denominator: 4}},
  {sourceFrame: 150, rate: {numerator: 1, denominator: 2}},
]);
const rational = (n) => ({kind: 'rational', numerator: String(n), denominator: '1'});
export function basisFor(points, sourceEnd = 150) {
  return {profile: 'timeline-speed-v1', sourceFps: {fpsNumerator: FPS, fpsDenominator: 1},
    outputFps: {fpsNumerator: FPS, fpsDenominator: 1},
    sourceRange: {start: rational(0), end: rational(sourceEnd)},
    speed: {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'sp-i0-reference', points}};
}
export function compiledCurve(points = CURVE_POINTS, sourceEnd = 150, outputFrames = 600) {
  const root = compileTimeMap(basisFor(points, sourceEnd));
  if (!root.ok) throw new Error(`compile failed: ${root.code} ${root.detail}`);
  let plan = initialTimeMap(root.value);
  if (plan.durationFrames > outputFrames) {
    const trimmed = trimTimeMap(plan, 0, outputFrames);
    if (!trimmed.ok) throw new Error(`trim failed: ${trimmed.code}`);
    plan = trimmed.value;
  }
  const samples = [];
  for (let outputFrame = 0; outputFrame < plan.durationFrames; outputFrame++) {
    const result = timeMapSourceAtOutputFrame(plan, outputFrame);
    if (!result.ok) throw new Error(`sample failed: ${result.code}`);
    const source = result.value.source;
    const position = source.kind === 'exact' ? Number(source.numerator) / Number(source.denominator) : source.value;
    samples.push({outputFrame, position, phase: result.value.phase,
      sourceFrame: result.value.sourceFrame, errorBound: source.kind === 'exact' ? 0 : source.errorBound});
  }
  return {plan, root: root.value, samples, outputFrames: plan.durationFrames};
}

/** PTS of each source frame in the output clock: the inverse of the shared map
 * at integer source positions (linear between adjacent output samples). */
export function inverseSourceTimes(samples, sourceEnd = 150) {
  const times = new Array(sourceEnd);
  times[0] = 0;
  let j = 0;
  for (let n = 1; n < sourceEnd; n++) {
    while (j + 1 < samples.length && samples[j + 1].position < n) j++;
    const left = samples[j], right = samples[Math.min(j + 1, samples.length - 1)];
    const span = right.position - left.position;
    const fraction = span > 0 ? (n - left.position) / span : 0;
    times[n] = (j + Math.max(0, Math.min(1, fraction))) / FPS;
  }
  return times;
}

/** What minterpolate computes from those timestamps: piecewise-linear source
 * coordinate between consecutive input PTS, then alpha quantized to 1/1024. */
export function timestampRemap(samples, sourceTimes) {
  const rows = [];
  let n = 0;
  for (const sample of samples) {
    const t = sample.outputFrame / FPS;
    while (n + 1 < sourceTimes.length - 1 && t >= sourceTimes[n + 1]) n++;
    const span = sourceTimes[n + 1] - sourceTimes[n];
    const raw = span > 0 ? (t - sourceTimes[n]) / span : 0;
    const alpha = Math.max(0, Math.min(1024, Math.trunc(raw * 1024)));
    const remapped = n + alpha / 1024;
    rows.push({...sample, time: t, pair: n, alpha, continuous: n + Math.max(0, Math.min(1, raw)),
      error: remapped - sample.position, continuousError: n + Math.max(0, Math.min(1, raw)) - sample.position});
  }
  return rows;
}
export function errorStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const abs = sorted.map(value => Math.abs(value));
  abs.sort((a, b) => a - b);
  return {maxAbs: abs.at(-1) ?? 0, meanAbs: abs.reduce((sum, value) => sum + value, 0) / Math.max(1, abs.length),
    p95Abs: abs[Math.min(abs.length - 1, Math.floor(abs.length * .95))] ?? 0,
    maxNegative: sorted[0] ?? 0, maxPositive: sorted.at(-1) ?? 0};
}
/** Optimistic lower bound: fit each source interval's phase line independently
 * to the desired continuous samples (endpoints are not tied together). */
export function independentLinearFit(samples) {
  const buckets = new Map();
  for (const sample of samples) {
    const n = Math.floor(sample.position);
    const list = buckets.get(n) ?? [];
    list.push({t: sample.outputFrame / FPS, s: sample.position});
    buckets.set(n, list);
  }
  const residuals = [];
  for (const points of buckets.values()) {
    if (points.length < 3) continue;
    const meanT = points.reduce((sum, p) => sum + p.t, 0) / points.length;
    const meanS = points.reduce((sum, p) => sum + p.s, 0) / points.length;
    let numerator = 0, denominator = 0;
    for (const p of points) {numerator += (p.t - meanT) * (p.s - meanS); denominator += (p.t - meanT) ** 2;}
    const slope = denominator > 0 ? numerator / denominator : 0;
    for (const p of points) residuals.push(meanS + slope * (p.t - meanT) - p.s);
  }
  return {residual: errorStats(residuals), samples: residuals.length};
}

/** Compile one curve and keep only the phase rows where optical interpolation is
 * actually active (local source speed < 1x), excluding source-range tail. */
export function phaseRowsForCurve(points, sourceEnd = 150, outputFrames = 600) {
  const curve = compiledCurve(points, sourceEnd, outputFrames);
  const all = timestampRemap(curve.samples, inverseSourceTimes(curve.samples, sourceEnd));
  const rows = all.filter((row, index) => index > 0 && index < all.length - 1
    && row.position < sourceEnd - 1 && row.position - all[index - 1].position < 1);
  return {curve, rows, outputFrames: curve.outputFrames, mapHash: curve.root.mapHash};
}

export const PHASE_CURVES = Object.freeze({
  reference: [{sourceFrame: 0, rate: {numerator: 1, denominator: 6}},
    {sourceFrame: 75, rate: {numerator: 1, denominator: 4}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}],
  symmetricSlow: [{sourceFrame: 0, rate: {numerator: 1, denominator: 4}},
    {sourceFrame: 75, rate: {numerator: 1, denominator: 10}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 4}}],
  nearOne: [{sourceFrame: 0, rate: {numerator: 1, denominator: 2}},
    {sourceFrame: 75, rate: {numerator: 9, denominator: 10}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 2}}],
  sharp: [{sourceFrame: 0, rate: {numerator: 1, denominator: 10}},
    {sourceFrame: 75, rate: {numerator: 1, denominator: 2}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 10}}],
  slowFastSlow: [{sourceFrame: 0, rate: {numerator: 1, denominator: 8}},
    {sourceFrame: 75, rate: {numerator: 1, denominator: 2}},
    {sourceFrame: 150, rate: {numerator: 1, denominator: 8}}],
});

export function curvePhaseSweep(sourceEnd = 150) {
  const rows = {};
  for (const [name, points] of Object.entries(PHASE_CURVES)) {
    const analysis = phaseRowsForCurve(points, sourceEnd, 1e9);
    rows[name] = {outputFrames: analysis.outputFrames, activeRows: analysis.rows.length,
      phaseErrorFrames: errorStats(analysis.rows.map(row => row.error)), mapHash: analysis.mapHash};
  }
  return rows;
}
