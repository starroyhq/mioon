import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {compileClipTimeMap} from '../../contracts/src/timeline-clip-timing.ts';
import {canRenderTimelineClipAtIdentity} from '../../contracts/src/timeline-speed-render.ts';
import {timeMapPlanFrames, timeMapTailInverse, type ContinuousSourcePosition} from '../../contracts/src/timeline-time-map.ts';

export interface EditorSourceClock {readonly fps: number; readonly fpsDenominator?: number; readonly frameCount: number}
export interface EditorExportSpeed {
  readonly kind: 'constant' | 'curve' | 'freeze';
  readonly direction: 'forward' | 'reverse';
  readonly points: readonly {outputFrame: number; sourceFrame: number}[];
  readonly interpolation: 'off' | 'blend' | 'optical';
  readonly pitchShift: boolean;
  readonly sourceEndFrame: number;
  readonly maxErrorFrames: number;
}

const precision = 1_000_000;
const curveTolerance = 0.05;

export function hasEditorExportSpeed(clip: Format5Clip, fps: number): boolean {
  return !canRenderTimelineClipAtIdentity(clip, fps);
}

export function premiereSpeedAudioUnavailable(speed: EditorExportSpeed): boolean {
  return speed.kind === 'curve' || speed.kind === 'constant' && speed.points.length > 2;
}

function nativeFrame(source: ContinuousSourcePosition, frame: number, clock: EditorSourceClock, fps: number, reverse: boolean): number | null {
  const clockDenominator = BigInt(fps) * BigInt(clock.fpsDenominator ?? 1);
  if (source.kind === 'exact') {
    const numerator = BigInt(source.numerator) * BigInt(clock.fps);
    const denominator = BigInt(source.denominator) * clockDenominator;
    return Math.max(0, Number((reverse && numerator > 0n ? numerator - 1n : numerator) / denominator));
  }
  const ratio = clock.fps / Number(clockDenominator);
  const center = source.value * ratio;
  const bound = source.errorBound * ratio + 8 * Number.EPSILON * (Math.abs(center) + 1);
  const midpointBoundary = Math.round(center);
  if (Math.abs(center - midpointBoundary) > bound) return Math.floor(center);
  // When the native clock has the same presentation boundary, the shared
  // selected frame already decides the tie. Do not guess at other boundaries.
  const numerator = BigInt(midpointBoundary) * clockDenominator;
  const denominator = BigInt(clock.fps);
  if (numerator % denominator === 0n && bound < 0.5) return frame >= Number(numerator / denominator) ? midpointBoundary : midpointBoundary - 1;
  return null;
}

function pointTick(value: number, selected: number, frameRatioDenominator: number, nativeFps: number, reverse: boolean): number {
  const clock = BigInt(nativeFps), ticksPerSecond = BigInt(frameRatioDenominator) * BigInt(precision);
  const boundary = (frame: number): number => Number((BigInt(frame) * ticksPerSecond + clock - 1n) / clock);
  const min = boundary(selected), max = boundary(selected + 1) - 1;
  return Math.max(min, Math.min(max, Math.round(value * precision) - Number(reverse)));
}

export function compileEditorExportSpeed(clip: Format5Clip, timeline: Format5Timeline, clock?: EditorSourceClock): EditorExportSpeed | null {
  const timing = clip.timing;
  if (!timing || !hasEditorExportSpeed(clip, timeline.fps)) return null;
  const clockDenominator = clock?.fpsDenominator ?? 1;
  if (!Number.isSafeInteger(clockDenominator) || clockDenominator < 1 ||
      clock && (!Number.isSafeInteger(clock.fps) || clock.fps < 1 || !Number.isSafeInteger(clock.frameCount) || clock.frameCount < 1)) return null;
  const result = compileClipTimeMap(clip, timeline);
  if (!result.ok || result.value.durationFrames !== clip.durationFrames) return null;
  const plan = result.value;
  const frames = timeMapPlanFrames(plan);
  if (!frames.ok) return null;
  const kind = timing.profile === 'timeline-freeze-v1' ? 'freeze' : timing.basis.speed.kind;
  const nativeFps = clock?.fps ?? timeline.fps;
  const frameRatioDenominator = timeline.fps * clockDenominator;
  const ratio = nativeFps / frameRatioDenominator;
  if (ratio > precision) return null;
  const reverse = plan.direction === 'reverse';
  const duration = plan.durationFrames;
  const values: number[] = [], bounds: number[] = [], ticks: number[] = [], expected: number[] = [];
  const cap = clock ? clock.frameCount / ratio : Infinity;
  const tailInverse = reverse ? 'earliest' : 'latest';
  for (let frame = 0; frame <= duration; frame++) {
    const offset = plan.outputWindow.fromFrame + frame;
    const sampled = timeMapTailInverse(plan, {numerator: String(offset), denominator: '1'}, {tailInverse});
    if (!sampled.ok) return null;
    const {position} = sampled.value;
    const value = position.kind === 'exact' ? Number(position.numerator) / Number(position.denominator) : position.value;
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
    bounds.push(position.kind === 'numeric' ? position.errorBound : 0);
    if (frame === duration && kind !== 'freeze') {
      ticks.push(Math.max(0, Math.min(Math.floor(cap * precision), Math.round(value * precision) - Number(reverse))));
      break;
    }
    const selected = nativeFps === frameRatioDenominator ? frames.value[Math.min(frame, duration - 1)]!
      : nativeFrame(position, frames.value[Math.min(frame, duration - 1)]!, clock!, timeline.fps, reverse);
    if (selected === null || selected < 0 || (clock && selected >= clock.frameCount)) return null;
    expected.push(selected);
    ticks.push(pointTick(value, selected, frameRatioDenominator, nativeFps, reverse));
  }

  // Split only where a line would pick the wrong frame, or drift farther
  // from the shared continuous curve. This also keeps fractional trims
  // and the rounded final output frame on their original phase.
  const points: EditorExportSpeed['points'][number][] = [];
  let maxError = 0;
  function span(from: number, to: number): void {
    const left = ticks[from]!, right = ticks[to]!, length = to - from;
    const denominator = BigInt(length) * BigInt(precision) * BigInt(frameRatioDenominator);
    let error = Math.abs(left / precision - values[from]!) + bounds[from]!;
    for (let n = from + 1; n < to; n++) {
      const offset = n - from;
      const relative = BigInt(left) * BigInt(length - offset) + BigInt(right) * BigInt(offset);
      const physical = Number(relative * BigInt(nativeFps) / denominator);
      const predicted = Number(relative) / (length * precision);
      const distance = Math.abs(predicted - values[n]!) + bounds[n]!;
      if (physical !== expected[n] || distance > (kind === 'curve' ? curveTolerance : 2 / precision)) {
        const middle = from + Math.floor(length / 2);
        span(from, middle);
        span(middle, to);
        return;
      }
      error = Math.max(error, distance);
    }
    maxError = Math.max(maxError, error);
    points.push({outputFrame: from, sourceFrame: left / precision});
  }
  span(0, duration);
  points.push({outputFrame: duration, sourceFrame: ticks[duration]! / precision});
  const speed = timing.profile === 'timeline-speed-v1' ? timing.basis.speed : null;
  const constant = speed?.kind === 'constant' ? speed.rate.numerator / speed.rate.denominator : 0;
  return {kind, direction: plan.direction, points,
    interpolation: timing.profile === 'timeline-speed-v1' ? timing.interpolation : 'off',
    pitchShift: timing.profile === 'timeline-speed-v1' && (timing.pitchShift || constant < 2 || constant > 4),
    sourceEndFrame: Math.ceil((expected.reduce((maximum, frame) => Math.max(maximum, frame), 0) + 1) / ratio),
    maxErrorFrames: Math.ceil(maxError * precision) / precision};
}
