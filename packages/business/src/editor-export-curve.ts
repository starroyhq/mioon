import {timeMapCurveReference, type CompiledTimeMap} from '../../contracts/src/timeline-time-map.ts';

const ticksPerFrame = 1_000_000;
const curveTolerance = 0.05;
const tailRamp = 1 / 128;

interface CurveOptions {
  readonly sourceUnitsPerProjectFrame: number;
  readonly subframeKeys: boolean;
  readonly sourceCap: number;
  readonly displayAligned: (from: number, to: number, leftTick: number, rightTick: number) => boolean;
}
interface CurvePoint {readonly outputFrame: number; readonly sourceFrame: number}

export function compileEditorExportCurve(plan: CompiledTimeMap, displayTicks: readonly number[], options: CurveOptions):
  {points: readonly CurvePoint[]; maxErrorFrames: number} | null {
  const result = timeMapCurveReference(plan);
  if (!result.ok) return null;
  const motion = result.value;
  const {sourceUnitsPerProjectFrame: units, subframeKeys, sourceCap, displayAligned} = options;
  const duration = plan.durationFrames;
  const last = duration - 1, lastTick = displayTicks[last]!;
  const points: CurvePoint[] = [];
  const toTick = (source: number): number => Math.max(0, Math.min(Math.floor(sourceCap * ticksPerFrame), Math.round(source * units * ticksPerFrame)));
  const error = (from: number, to: number, left: number, right: number): number => {
    const measured = motion.maxLinearError(from, to, left / ticksPerFrame / units, right / ticksPerFrame / units);
    return measured.ok ? measured.value : Infinity;
  };
  let maxError = 0;

  function append(from: number, left: number, distance: number): boolean {
    if (!Number.isFinite(distance)) return false;
    maxError = Math.max(maxError, distance);
    points.push({outputFrame: from, sourceFrame: left / ticksPerFrame});
    return true;
  }

  function span(from: number, to: number, left: number, right: number, displaySpan: boolean): boolean {
    if (to <= from) return true;
    const distance = error(from, to, left, right);
    if (displaySpan && to - from > 1 && (distance > curveTolerance || !displayAligned(from, to, left, right))) {
      const middle = from + Math.floor((to - from) / 2), tick = displayTicks[middle]!;
      return span(from, middle, left, tick, true) && span(middle, to, tick, right, true);
    }
    if (subframeKeys && distance > curveTolerance && to - from > 2 / ticksPerFrame) {
      const middle = Math.round((from + to) / 2 * ticksPerFrame) / ticksPerFrame;
      const sampled = motion.sampleMotion(middle);
      if (!sampled.ok) return false;
      const tick = toTick(sampled.value.value);
      return span(from, middle, left, tick, false) && span(middle, to, tick, right, false);
    }
    return append(from, left, distance);
  }

  if (!span(0, last, displayTicks[0]!, lastTick, true)) return null;

  const tail = motion.motionEnd < duration;
  let endTick: number;
  if (!tail) {
    const end = motion.sampleMotion(duration);
    if (!end.ok) return null;
    endTick = toTick(end.value.value);
    if (!span(last, duration, lastTick, endTick, false)) return null;
  } else if (subframeKeys) {
    const cutoff = Math.max(last * ticksPerFrame + 1,
      Math.min(duration * ticksPerFrame - 1, Math.round(motion.motionEnd * ticksPerFrame))) / ticksPerFrame;
    endTick = toTick(motion.heldSource);
    // The held picture can jump from the motion endpoint to the last selected
    // frame. Keep the approximation local to that discontinuity, and use its
    // midpoint to minimize the greatest one-sided error of a continuous graph.
    const cutoffTick = toTick((motion.terminalSource + motion.heldSource) / 2);
    const ramp = Math.min(tailRamp, (cutoff - last) / 2, (duration - cutoff) / 2);
    const before = Math.max(last, Math.floor((cutoff - ramp) * ticksPerFrame) / ticksPerFrame);
    const after = Math.min(duration, Math.ceil((cutoff + ramp) * ticksPerFrame) / ticksPerFrame);
    const sample = motion.sampleMotion(before);
    if (!sample.ok) return null;
    const beforeTick = before === last ? lastTick : toTick(sample.value.value);
    if (!span(last, before, lastTick, beforeTick, false)) return null;
    if (!append(before, beforeTick, error(before, cutoff, beforeTick, cutoffTick))) return null;
    if (!append(cutoff, cutoffTick, error(cutoff, after, cutoffTick, endTick))) return null;
    if (after < duration && !append(after, endTick, error(after, duration, endTick, endTick))) return null;
  } else {
    // XMEML keyframe times are integers. Choose the best rounded endpoint over
    // the entire last interval. The peak error is convex in that endpoint.
    const terminal = toTick(motion.terminalSource), held = toTick(motion.heldSource);
    const least = Math.min(terminal, held, lastTick), most = Math.max(terminal, held, lastTick);
    let lower = Math.max(0, least - (most - least)), upper = Math.min(Math.floor(sourceCap * ticksPerFrame), most + (most - least));
    while (upper - lower > 4) {
      const step = Math.floor((upper - lower) / 3);
      const a = lower + step, b = upper - step;
      if (error(last, duration, lastTick, a) <= error(last, duration, lastTick, b)) upper = b - 1;
      else lower = a + 1;
    }
    endTick = lower;
    let distance = error(last, duration, lastTick, endTick);
    for (let tick = lower + 1; tick <= upper; tick++) {
      const measured = error(last, duration, lastTick, tick);
      if (measured < distance) {
        endTick = tick;
        distance = measured;
      }
    }
    if (!append(last, lastTick, distance)) return null;
  }

  points.push({outputFrame: duration, sourceFrame: endTick / ticksPerFrame});
  return {points, maxErrorFrames: Math.ceil(maxError * ticksPerFrame) / ticksPerFrame};
}
