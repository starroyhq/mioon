import {AppError} from '../../contracts/src/app-error.ts';
import {SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES} from '../../contracts/src/timeline-speed-export.ts';
import {timeMapAudioInverse, type CompiledTimeMap, type TimeMapCurvePoint, type TimeMapSpeedRate} from '../../contracts/src/timeline-time-map.ts';

export const speedAudioSamplesPerFrame = 1_600;
const minimumBlockSize = 64;
const maximumBlockSize = 8_192;
const phaseToleranceSamples = 0.01;
const fourthDerivativeDivisor = 24 * speedAudioSamplesPerFrame ** 3;

export const invalidSpeedAudio = (reason: string): AppError =>
  new AppError(SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_MAPPING_INVALID], 409, {audioReason: reason});

interface SourceAnchor {readonly sample: number; readonly error: number}
function invert(plan: CompiledTimeMap, sampleNumerator: number, sampleDenominator = 1): SourceAnchor {
  const result = timeMapAudioInverse(plan, {numerator: String(sampleNumerator),
    denominator: String(sampleDenominator * speedAudioSamplesPerFrame)}, phaseToleranceSamples / (2 * speedAudioSamplesPerFrame));
  if (!result.ok) throw invalidSpeedAudio(result.code);
  if (result.value.tail) throw invalidSpeedAudio('SAMPLE_IN_MOTION_TAIL');
  const {position} = result.value;
  const value = position.kind === 'exact' ? Number(position.numerator) / Number(position.denominator) : position.value;
  const sample = value * speedAudioSamplesPerFrame;
  const error = (position.kind === 'exact' ? 0 : position.errorBound * speedAudioSamplesPerFrame) +
    4 * Number.EPSILON * (Math.abs(sample) + 1);
  if (!Number.isFinite(sample) || !Number.isFinite(error) || error > phaseToleranceSamples) {
    throw invalidSpeedAudio('SAMPLE_PHASE_UNRESOLVED');
  }
  return {sample, error};
}

function curveDerivativeBounds(points: readonly TimeMapCurvePoint[]) {
  return points.slice(0, -1).map((left, index) => {
    const right = points[index + 1]!;
    const first = left.rate.numerator / left.rate.denominator;
    const last = right.rate.numerator / right.rate.denominator;
    // Shape-preserving log-PCHIP bounds its rate by the endpoint rates. The
    // three Bernstein coefficients of q' have magnitude at most three
    // times the secant, where q = log(rate).
    const logFirst = Math.log(first), logLast = Math.log(last);
    const rounding = 64 * Number.EPSILON;
    const maximumRate = Math.max(first, last) * (1 + rounding);
    const span = right.sourceFrame - left.sourceFrame;
    const slope = 3 * (Math.abs(logLast - logFirst) + rounding * Math.max(1, Math.abs(logFirst), Math.abs(logLast))) / span;
    // Differences of those coefficients bound q'' and q''' on this interval.
    // The inverse derivatives are u'' = r² q' and u'''' = r⁴ (6 q'³ + 7 q'q'' + q''').
    const second = 4 * slope / span;
    const third = 8 * slope / span ** 2;
    return {from: left.sourceFrame * speedAudioSamplesPerFrame, to: right.sourceFrame * speedAudioSamplesPerFrame,
      curvature: maximumRate ** 2 * slope, fourth: maximumRate ** 4 * (6 * slope ** 3 + 7 * slope * second + third)};
  });
}

/** Shared inverse anchors with a bounded phase approximation between anchors.
 * Cut windows use the identical absolute block grid and local subdivisions. */
export function createSpeedAudioSourceClock(plan: CompiledTimeMap, motionSamples: number, rate: TimeMapSpeedRate | undefined,
  curvePoints: readonly TimeMapCurvePoint[]): (viewSample: number) => number {
  if (rate) {
    const origin = invert(plan, 0).sample;
    const step = (plan.direction === 'forward' ? 1 : -1) * rate.numerator / rate.denominator;
    return viewSample => origin + viewSample * step;
  }

  const limits = curveDerivativeBounds(curvePoints);
  const maximumFourth = Math.max(...limits.map(segment => segment.fourth));
  const targetWidth = (phaseToleranceSamples * fourthDerivativeDivisor / (4 * maximumFourth)) ** 0.25;
  const blockSize = Math.max(minimumBlockSize, Math.min(maximumBlockSize, 2 ** Math.floor(Math.log2(targetWidth))));
  const positions = new Float64Array(blockSize);
  let blockFrom = -1;
  const fillCubic = (from: number, to: number, first: SourceAnchor, last: SourceAnchor,
    fourth: number, roundoff: number): boolean => {
    const width = to - from;
    // The cubic remainder is bounded by max|u''''| * width^4 / 24.
    // The absolute cardinal weights on this grid sum to less than nine.
    const remainder = fourth * width ** 4 / fourthDerivativeDivisor;
    if (9 * Math.max(first.error, last.error) + remainder + roundoff > phaseToleranceSamples) return false;
    const left = invert(plan, 3 * from + width, 3);
    const right = invert(plan, 3 * from + 2 * width, 3);
    if (9 * Math.max(left.error, right.error) + remainder + roundoff > phaseToleranceSamples) return false;
    for (let sample = from + 1; sample < to; sample++) {
      const x = (sample - from) / width;
      const a = x - 1 / 3, b = x - 2 / 3, c = x - 1;
      positions[sample - blockFrom] = -4.5 * a * b * c * first.sample + 13.5 * x * b * c * left.sample -
        13.5 * x * a * c * right.sample + 4.5 * x * a * b * last.sample;
    }
    return true;
  };

  const fill = (from: number, to: number, first: SourceAnchor, last: SourceAnchor): void => {
    positions[from - blockFrom] = first.sample;
    positions[to - blockFrom] = last.sample;
    if (to - from <= 1) return;
    const lo = Math.min(first.sample - first.error, last.sample - last.error);
    const hi = Math.max(first.sample + first.error, last.sample + last.error);
    let maximumCurvature = 0;
    let localFourth: number | undefined;
    for (const segment of limits) {
      if (segment.from <= hi && segment.to >= lo) maximumCurvature = Math.max(segment.curvature, maximumCurvature);
      if (segment.from <= lo && segment.to >= hi) localFourth = segment.fourth;
    }
    // The chord error is bounded by max|u''| * width^2 / 8 in source time.
    // Divide by the sample clock powers to express both errors in samples.
    const roundoff = 8 * Number.EPSILON * (Math.max(Math.abs(lo), Math.abs(hi)) + 1);
    const chordError = (maximumCurvature + 8 * Number.EPSILON) * (to - from) ** 2 / (8 * speedAudioSamplesPerFrame);
    if (Math.max(first.error, last.error) + chordError + roundoff <= phaseToleranceSamples) {
      for (let sample = from + 1; sample < to; sample++) {
        positions[sample - blockFrom] = first.sample + (last.sample - first.sample) * (sample - from) / (to - from);
      }
      return;
    }
    if (to - from >= minimumBlockSize && localFourth !== undefined &&
        fillCubic(from, to, first, last, localFourth, 8 * roundoff)) return;
    const middle = Math.floor((from + to) / 2);
    const anchor = invert(plan, middle);
    fill(from, middle, first, anchor);
    fill(middle, to, anchor, last);
  };

  return viewSample => {
    const from = viewSample - viewSample % blockSize;
    if (from !== blockFrom) {
      blockFrom = from;
      const to = Math.min(from + blockSize - 1, motionSamples - 1);
      const start = invert(plan, from);
      fill(from, to, start, to === from ? start : invert(plan, to));
    }
    return positions[viewSample - blockFrom]!;
  };
}
