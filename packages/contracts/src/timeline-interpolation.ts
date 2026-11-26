import {
  TIMELINE_TIME_MAP_LIMITS, timeMapInterpolationClock, timeMapPlanFrames, timeMapRootInfo,
  type CompiledTimeMap, type ContinuousSourcePosition, type TimeMapResult, type TimeMapSourceBoundary,
} from './timeline-time-map.ts';

export const INTERPOLATION_PHASE_PROFILE = 'interp-phase-pts-v1' as const;
export const INTERPOLATION_PHASE_EPSILON = 0.01;
export const INTERPOLATION_PHASE_TICKS_PER_SECOND = 90_000;
export const INTERPOLATION_SOURCE_CONTEXT_FRAMES = 2;
export const INTERPOLATION_PIXEL_FORMATS = Object.freeze([
  'yuv410p', 'yuv411p', 'yuv420p', 'yuv422p', 'yuv440p', 'yuv444p', 'yuva420p', 'yuva422p', 'yuva444p',
] as const);
export type InterpolationPixelFormat = typeof INTERPOLATION_PIXEL_FORMATS[number];
const pixelFormats = new Set<string>(INTERPOLATION_PIXEL_FORMATS);
export function isInterpolationPixelFormat(value: unknown): value is InterpolationPixelFormat {
  return typeof value === 'string' && pixelFormats.has(value);
}

/** Physical-frame PTS expressed in the project's continuous source clock.
 * If absent, source indices and positions are the shared integer frame grid. */
export interface InterpolationSourceClock {
  readonly positions: readonly number[];
  readonly end: number;
}
export interface InterpolationFrame {
  readonly active: boolean;
  readonly source: ContinuousSourcePosition;
  readonly offFrame: number;
  readonly fromFrame: number;
  readonly toFrame: number;
  /** Weight of toFrame in traversal order. Feed this directly to the blender. */
  readonly weight: number;
}
export interface InterpolationInputFrame {
  readonly sourceFrame: number;
  /** Signed ticks on the 1/90000 input clock relative to the first output frame. */
  readonly pts: number;
}
export interface InterpolationPhasePlan {
  readonly profile: typeof INTERPOLATION_PHASE_PROFILE;
  readonly maxPhaseErrorFrames: number;
  readonly available: boolean;
  readonly frames: readonly InterpolationFrame[];
  /** Inputs in traversal order. Each active pair has two physical source
   * frames of context where the root's media range permits. Gaps between
   * runs contain no active output frames. */
  readonly input: readonly InterpolationInputFrame[];
}

type FrameClock = {
  readonly first: number;
  readonly last: number;
  point(frame: number): number;
  ordinal(source: ContinuousSourcePosition, offFrame: number): number | null;
};
type Range = {start: number; end: number};
const alphaScale = 1024;
const maxInputFrames = TIMELINE_TIME_MAP_LIMITS.maxOutputFrames + INTERPOLATION_SOURCE_CONTEXT_FRAMES * 2;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const sourceValue = (source: ContinuousSourcePosition): number =>
  source.kind === 'exact' ? Number(source.numerator) / Number(source.denominator) : source.value;
const boundaryValue = (value: TimeMapSourceBoundary): number =>
  value.kind === 'q64' ? Number(value.ticks) / 2 ** 64 : Number(value.numerator) / Number(value.denominator);
const invalidClock = {ok: false, code: 'INVALID_SOURCE_RANGE', detail: 'physical input does not cover the interpolation window'} as const;
const insufficientPhase = {ok: false, code: 'UNRESOLVED_BOUNDARY', detail: 'cannot bound the quantized interpolation clock'} as const;

function lastBefore(values: readonly number[], accepts: (value: number) => boolean | null): number | null {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const middle = lo + Math.floor((hi - lo) / 2);
    const accepted = accepts(values[middle]!);
    if (accepted === null) return null;
    if (accepted) lo = middle + 1;
    else hi = middle;
  }
  return lo - 1;
}

function frameClock(plan: CompiledTimeMap, source: InterpolationSourceClock | undefined): FrameClock | null {
  const reverse = plan.direction === 'reverse';
  const {frameRange, sourceRange} = timeMapRootInfo(plan.root);
  if (!source) return {first: frameRange.start, last: frameRange.end,
    point: frame => reverse ? frame + 1 : frame, ordinal: (_position, selected) => selected};
  const {positions, end} = source;
  if (!positions.length || !Number.isFinite(end) || end < positions.at(-1)! ||
      positions.some((value, index) => !Number.isFinite(value) || index > 0 && value <= positions[index - 1]!)) return null;
  const lo = boundaryValue(sourceRange.start), hi = boundaryValue(sourceRange.end);
  const first = Math.max(0, lastBefore(positions, value => value <= lo)!);
  const last = lastBefore(positions, value => value < hi);
  if (last === null || last < first) return null;
  return {first, last,
    point: frame => reverse ? positions[frame + 1] ?? end : positions[frame]!,
    ordinal(position, selected) {
      const center = sourceValue(position);
      const rounding = 8 * Number.EPSILON * Math.max(1, Math.abs(center));
      if (center < positions[0]! - rounding || center > end + rounding) return null;
      const ordinal = lastBefore(positions, boundary => {
        if (position.kind === 'exact') return reverse ? boundary < center : boundary <= center;
        // At an integer native timestamp use the already proved off-mode grid
        // tie. At a genuine VFR boundary require a decisive continuous sample.
        if (Number.isSafeInteger(boundary)) return boundary <= selected;
        const uncertainty = position.errorBound + rounding;
        if (boundary < center - uncertainty) return true;
        if (boundary > center + uncertainty) return false;
        return null;
      });
      return ordinal === null ? null : clamp(ordinal, first, last);
    }};
}

function includeRange(ranges: Range[], span: Range): void {
  const previous = ranges.at(-1);
  if (previous && span.start <= previous.end + 1 && span.end >= previous.start - 1) {
    previous.start = Math.min(previous.start, span.start);
    previous.end = Math.max(previous.end, span.end);
  } else ranges.push(span);
}

/** Compile the common admission proof and the distinct render inputs. Blend
 * uses the exact shared position, while the optical filter consumes integer
 * input PTS and truncates its adjacent-frame weight to 1/1024. */
export function compileInterpolationPhase(plan: CompiledTimeMap, source?: InterpolationSourceClock): TimeMapResult<InterpolationPhasePlan> {
  const {fpsNumerator, fpsDenominator} = plan.root.outputFps;
  const ticksPerFrame = INTERPOLATION_PHASE_TICKS_PER_SECOND * fpsDenominator / fpsNumerator;
  if (!Number.isSafeInteger(ticksPerFrame) || ticksPerFrame < 1) {
    return {ok: false, code: 'INVALID_TIMEBASE', detail: 'output clock must lie on the interpolation timebase'};
  }
  const clock = frameClock(plan, source);
  if (!clock) return invalidClock;
  const shared = timeMapInterpolationClock(plan);
  const off = timeMapPlanFrames(plan);
  if (!off.ok) return off;
  const direction = plan.direction === 'reverse' ? -1 : 1;
  const frames: InterpolationFrame[] = [];
  const ranges: Range[] = [];
  for (let outputFrame = 0; outputFrame < plan.durationFrames; outputFrame++) {
    const sample = shared.sample(outputFrame);
    if (!sample.ok) return sample;
    const {source: position, slow} = sample.value;
    const fromFrame = clock.ordinal(position, off.value[outputFrame]!);
    if (fromFrame === null) return invalidClock;
    const toFrame = slow ? clamp(fromFrame + direction, clock.first, clock.last) : fromFrame;
    const active = fromFrame !== toFrame;
    const weight = active
      ? clamp((sourceValue(position) - clock.point(fromFrame)) / (clock.point(toFrame) - clock.point(fromFrame)), 0, 1) : 0;
    frames.push({active, source: position, offFrame: fromFrame, fromFrame, toFrame, weight});
    if (active) includeRange(ranges, {
      start: Math.max(clock.first, Math.min(fromFrame, toFrame) - INTERPOLATION_SOURCE_CONTEXT_FRAMES),
      end: Math.min(clock.last, Math.max(fromFrame, toFrame) + INTERPOLATION_SOURCE_CONTEXT_FRAMES),
    });
  }
  if (ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0) > maxInputFrames) {
    return {ok: false, code: 'SOURCE_FRAME_LIMIT', detail: 'interpolation context exceeds the input frame budget'};
  }
  const input: InterpolationInputFrame[] = [];
  const shift = plan.outputWindow.fromFrame * ticksPerFrame;
  for (const {start, end} of ranges) {
    for (let sourceFrame = direction > 0 ? start : end; sourceFrame >= start && sourceFrame <= end; sourceFrame += direction) {
      const mapped = shared.outputAtSource(clock.point(sourceFrame));
      if (!mapped.ok) return mapped;
      const pts = Math.round(mapped.value * ticksPerFrame) - shift;
      if (!Number.isSafeInteger(pts * alphaScale) || input.length && pts <= input.at(-1)!.pts) return insufficientPhase;
      input.push({sourceFrame, pts});
    }
  }

  let maxPhaseErrorFrames = 0;
  let pair = 0;
  for (const [outputFrame, frame] of frames.entries()) {
    if (!frame.active) continue;
    const target = outputFrame * ticksPerFrame;
    while (pair + 2 < input.length && target >= input[pair + 1]!.pts) pair++;
    const left = input[pair], right = input[pair + 1];
    if (!left || !right || target < left.pts || target > right.pts) return insufficientPhase;
    // At a knot either adjacent interpolator produces exactly the knot.
    if (target !== left.pts && target !== right.pts && right.sourceFrame !== left.sourceFrame + direction) return insufficientPhase;
    const alpha = Math.floor((target - left.pts) * alphaScale / (right.pts - left.pts));
    const start = clock.point(left.sourceFrame), end = clock.point(right.sourceFrame);
    const remapped = start + (end - start) * alpha / alphaScale;
    const desired = sourceValue(frame.source);
    const sharedError = frame.source.kind === 'numeric' ? frame.source.errorBound : 0;
    const rounding = 16 * Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end), Math.abs(desired));
    maxPhaseErrorFrames = Math.max(maxPhaseErrorFrames, Math.abs(remapped - desired) + sharedError + rounding);
  }
  return {ok: true, value: {profile: INTERPOLATION_PHASE_PROFILE, maxPhaseErrorFrames,
    available: maxPhaseErrorFrames <= INTERPOLATION_PHASE_EPSILON, frames, input}};
}
