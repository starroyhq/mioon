import type {ClipTiming} from '../../../contracts/src/timeline-speed.ts';
import {restoreTimeMap, timeMapSourceRangeForEdit, timeMapSourceWindowForOutput} from '../../../contracts/src/timeline-time-map.ts';
import type {CompiledTimeMap, TimeMapSourceBoundary, TimeMapSourceWindow, TimeMapSpeedRate} from '../../../contracts/src/timeline-time-map.ts';

function shiftedBoundary(boundary: TimeMapSourceBoundary, frames: number, rate: TimeMapSpeedRate,
  sourceFrames: number, roundUp: boolean): number | null {
  const numerator = BigInt(boundary.kind === 'q64' ? boundary.ticks : boundary.numerator);
  const denominator = boundary.kind === 'q64' ? 1n << 64n : BigInt(boundary.denominator);
  const q = BigInt(rate.denominator);
  const value = numerator * q + BigInt(frames) * BigInt(rate.numerator) * denominator;
  const divider = denominator * q;
  if (value < 0n || value > BigInt(sourceFrames) * divider) return null;
  return Number((value + (roundUp ? divider - 1n : 0n)) / divider);
}

/** Include the source frames for saved, admitted picture transitions. The
 * visible window remains the task's identity and the preview's output basis. */
export function reversePictureCoverage(plan: CompiledTimeMap, timing: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>,
  visible: TimeMapSourceWindow, sourceFrames: number, before: number, after: number): TimeMapSourceWindow | undefined {
  if (plan.direction !== 'reverse' || !before && !after) return undefined;
  let start = visible.startFrame, end = visible.endFrame;
  if (plan.root.interpolation === 'constant') {
    const speed = timing.basis.speed;
    const rate = speed.kind === 'constant' ? speed.rate : speed.points[0]?.rate;
    const range = timeMapSourceRangeForEdit(plan);
    if (!rate || !range.ok) return undefined;
    // A lead-in in output time is above the visible source range in reverse.
    const lower = after ? shiftedBoundary(range.value.start, -after, rate, sourceFrames, false) : start;
    const upper = before ? shiftedBoundary(range.value.end, before, rate, sourceFrames, true) : end;
    if (lower === null || upper === null) return undefined;
    start = Math.min(start, lower);
    end = Math.max(end, upper);
  } else {
    const {fromFrame, toFrame} = plan.outputWindow;
    const extended = restoreTimeMap(plan.root, {...timing.view, outputWindow: {fromFrame: fromFrame - before, toFrame: toFrame + after}});
    if (!extended.ok) return undefined;
    const window = timeMapSourceWindowForOutput(extended.value);
    if (!window.ok || window.value.endFrame > sourceFrames) return undefined;
    start = Math.min(start, window.value.startFrame);
    end = Math.max(end, window.value.endFrame);
  }
  return start === visible.startFrame && end === visible.endFrame ? undefined
    : {...visible, startFrame: start, endFrame: end, frameCount: end - start};
}
