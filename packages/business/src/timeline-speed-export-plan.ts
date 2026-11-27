import {AppError} from '../../contracts/src/app-error.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {compileClipTimeMap} from '../../contracts/src/timeline-clip-timing.ts';
import {INTERPOLATION_UNAVAILABLE, TIMELINE_SPEED_EXPORT_MESSAGES} from '../../contracts/src/timeline-speed-export.ts';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, restoreTimeMap, timeMapSourceRangeForEdit,
  timeMapHasSlowMotion, timeMapSourceWindowForOutput, trimTimeMap,
  type CompiledTimeMap, type TimeMapResult, type TimeMapSourceBoundary, type TimeMapSpeedRate,
} from '../../contracts/src/timeline-time-map.ts';

interface TimedClip {
  readonly id: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly timing: ClipTiming;
}

export interface SpeedPictureWindow {
  readonly beginFrame: number;
  readonly endFrame: number;
  readonly plan: CompiledTimeMap;
  /** The uncropped window owns source phase across every export range. */
  readonly fullPlan: CompiledTimeMap;
}

export function speedInterpolationUnavailable(clipId: string): AppError {
  return new AppError(INTERPOLATION_UNAVAILABLE, TIMELINE_SPEED_EXPORT_MESSAGES[INTERPOLATION_UNAVAILABLE], 409, {clipId});
}

export function speedInterpolationWindows(clipId: string, windows: readonly SpeedPictureWindow[]): readonly SpeedPictureWindow[] {
  return windows.filter(window => {
    const slow = timeMapHasSlowMotion(window.plan);
    if (!slow.ok) throw speedInterpolationUnavailable(clipId);
    return slow.value;
  });
}

export function speedExportMappingError(clipId: string | undefined, reason: string): AppError {
  return new AppError('SPEED_MAPPING_INVALID', '无法验证变速片段的取样区间。', 409,
    {reason, ...(clipId === undefined ? {} : {clipId})});
}

function mapped<T>(clipId: string, result: TimeMapResult<T>): T {
  if (!result.ok) throw speedExportMappingError(clipId, result.code);
  return result.value;
}

export function speedExportClipPlan(clip: TimedClip, fps: number): CompiledTimeMap {
  const plan = mapped(clip.id, compileClipTimeMap({...clip}, {fps}));
  if (plan.durationFrames !== clip.durationFrames) throw speedExportMappingError(clip.id, 'DURATION_MISMATCH');
  return plan;
}

function fraction(boundary: TimeMapSourceBoundary): [bigint, bigint] {
  return boundary.kind === 'q64' ? [BigInt(boundary.ticks), 1n << 64n]
    : [BigInt(boundary.numerator), BigInt(boundary.denominator)];
}

function shifted(boundary: TimeMapSourceBoundary, frames: number, rate: TimeMapSpeedRate): TimeMapSourceBoundary {
  const [numerator, denominator] = fraction(boundary);
  const p = BigInt(rate.numerator), q = BigInt(rate.denominator);
  const n = numerator * q + BigInt(frames) * p * denominator;
  const d = denominator * q;
  let left = n < 0n ? -n : n, right = d;
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  return {kind: 'rational', numerator: String(n / left), denominator: String(d / left)};
}

function inside(boundary: TimeMapSourceBoundary, sourceFrames: number): boolean {
  const [numerator, denominator] = fraction(boundary);
  return numerator >= 0n && numerator <= BigInt(sourceFrames) * denominator;
}

/** Match SP-D's admitted handles. Constants extend from the exact motion
 * boundary, curves retain their original clock inside the compiled view, and
 * a frozen picture repeats its pinned source frame. */
export function speedTransitionHandle(clip: TimedClip, plan: CompiledTimeMap, side: 'before' | 'after',
  count: number, sourceFrames: number): CompiledTimeMap {
  const {id, timing} = clip;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(sourceFrames) || sourceFrames < 1) {
    throw speedExportMappingError(id, 'INVALID_HANDLE');
  }
  let handle: CompiledTimeMap;
  if (timing.profile === 'timeline-freeze-v1') {
    handle = initialTimeMap(mapped(id, compileFreezeTimeMap({sourceFrame: timing.sourceFrame, durationFrames: count,
      sourceFps: plan.root.sourceFps, outputFps: plan.root.outputFps})));
  } else if (plan.root.interpolation === 'constant') {
    const speed = timing.basis.speed;
    const rate = speed.kind === 'constant' ? speed.rate : speed.points[0]?.rate;
    if (!rate) throw speedExportMappingError(id, 'INVALID_HANDLE');
    const {start, end} = mapped(id, timeMapSourceRangeForEdit(plan));
    const lower = plan.direction === 'forward' ? side === 'before' : side === 'after';
    const sourceRange = lower ? {start: shifted(start, -count, rate), end: start}
      : {start: end, end: shifted(end, count, rate)};
    if (!inside(sourceRange.start, sourceFrames) || !inside(sourceRange.end, sourceFrames)) {
      throw speedExportMappingError(id, 'HANDLE_OUTSIDE_SOURCE');
    }
    handle = initialTimeMap(mapped(id, compileTimeMap({...timing.basis, speed: {kind: 'constant', rate}, sourceRange})), plan.direction);
  } else {
    const {fromFrame, toFrame} = plan.outputWindow;
    handle = mapped(id, restoreTimeMap(plan.root, {...timing.view,
      outputWindow: side === 'before' ? {fromFrame: fromFrame - count, toFrame: fromFrame}
        : {fromFrame: toFrame, toFrame: toFrame + count}}));
  }
  const window = mapped(id, timeMapSourceWindowForOutput(handle));
  if (handle.durationFrames !== count || window.startFrame < 0 || window.endFrame > sourceFrames) {
    throw speedExportMappingError(id, 'HANDLE_OUTSIDE_SOURCE');
  }
  return handle;
}

/** Composition segments split at both clip edges, so any one encoder input
 * comes from exactly one of the lead-in, visible clip, and tail intervals. */
export function speedPictureWindows(clip: TimedClip, plan: CompiledTimeMap,
  picture: {start: number; end: number}, used: {start: number; end: number},
  sourceFrames: number): readonly SpeedPictureWindow[] {
  const windows: SpeedPictureWindow[] = [];
  const endFrame = clip.startFrame + clip.durationFrames;
  const append = (start: number, end: number, source: () => CompiledTimeMap): void => {
    const beginFrame = Math.max(start, used.start), last = Math.min(end, used.end);
    if (beginFrame >= last) return;
    const full = source();
    const plan = beginFrame === start && last === end ? full
      : mapped(clip.id, trimTimeMap(full, beginFrame - start, last - start));
    windows.push({beginFrame, endFrame: last, plan, fullPlan: full});
  };
  append(picture.start, clip.startFrame, () => speedTransitionHandle(clip, plan, 'before', clip.startFrame - picture.start, sourceFrames));
  append(clip.startFrame, endFrame, () => plan);
  append(endFrame, picture.end, () => speedTransitionHandle(clip, plan, 'after', picture.end - endFrame, sourceFrames));
  return windows;
}
