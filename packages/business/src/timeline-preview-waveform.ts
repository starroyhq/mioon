import {AppError} from '../../contracts/src/app-error.ts';
import {compileClipTimeMap} from '../../contracts/src/timeline-clip-timing.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {
  timeMapSourceRangeForEdit, timeMapTailInverse,
  type ContinuousSourcePosition, type CurrentTimelineClipLike, type TimeMapResult, type TimeMapSourceBoundary,
} from '../../contracts/src/timeline-time-map.ts';
import {SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES} from '../../contracts/src/timeline-speed-export.ts';
import {
  WAVEFORM_BINS_PER_SECOND, WAVEFORM_DEFAULT_POINTS, WAVEFORM_FPS, WAVEFORM_MAX_POINTS, WAVEFORM_SAMPLE_RATE,
} from '../../contracts/src/waveforms.ts';

const samplesPerFrame = WAVEFORM_SAMPLE_RATE / WAVEFORM_FPS;
const samplesPerPeak = WAVEFORM_SAMPLE_RATE / WAVEFORM_BINS_PER_SECOND;

export interface TimelineWaveformWindow {
  readonly outputStartFrame: number;
  readonly outputEndFrame: number;
  readonly points?: number;
}

interface WaveformSourcePeaks {
  readonly sampleFrames: number;
  readonly peaks: readonly number[];
}

type WaveformClip = CurrentTimelineClipLike & {readonly timing?: ClipTiming};
const invalid = (reason: string): never => {
  throw new AppError(SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_MAPPING_INVALID], 409, {reason});
};
function unwrap<T>(result: TimeMapResult<T>): T {
  return result.ok ? result.value : invalid(result.code);
}

function sourceSample(position: TimeMapSourceBoundary | ContinuousSourcePosition): number {
  if (position.kind === 'numeric') return position.value * samplesPerFrame;
  const numerator = BigInt(position.kind === 'q64' ? position.ticks : position.numerator);
  const denominator = position.kind === 'q64' ? 1n << 64n : BigInt(position.denominator);
  return Number(numerator * BigInt(samplesPerFrame)) / Number(denominator);
}

export function timelineWaveformPointCount(clip: WaveformClip, window: TimelineWaveformWindow): number {
  const {outputStartFrame, outputEndFrame, points = WAVEFORM_DEFAULT_POINTS} = window;
  if (![outputStartFrame, outputEndFrame, points].every(Number.isSafeInteger) || outputStartFrame < clip.startFrame ||
      outputEndFrame <= outputStartFrame || outputEndFrame > clip.startFrame + clip.durationFrames ||
      points < 1 || points > WAVEFORM_MAX_POINTS) {
    throw new AppError('SOURCE_BOUNDS', 'Waveform range is outside the timeline clip.', 400);
  }
  return Math.min(points, Math.ceil((outputEndFrame - outputStartFrame) * WAVEFORM_BINS_PER_SECOND / WAVEFORM_FPS));
}

/** Project existing source maxima into equal-width output-clock groups. Each
 * group covers only the cached bins intersecting its half-open source interval.
 * The waveform stays pre-mix; freezes and the timing tail contribute silence. */
export function projectTimelineWaveformPeaks(clip: WaveformClip, fps: number,
  window: TimelineWaveformWindow, source: WaveformSourcePeaks): (number | null)[] {
  const count = timelineWaveformPointCount(clip, window);
  if (fps !== WAVEFORM_FPS) return invalid('INVALID_TIMEBASE');
  const plan = unwrap(compileClipTimeMap(clip, {fps}));
  if (plan.durationFrames !== clip.durationFrames) return invalid('INVALID_WINDOW');
  if (clip.timing?.profile === 'timeline-freeze-v1') return Array<number>(count).fill(0);
  const range = unwrap(timeMapSourceRangeForEdit(plan));
  const low = sourceSample(range.start), high = sourceSample(range.end);
  const reverse = plan.direction === 'reverse';
  const entry = reverse ? high : low, exit = reverse ? low : high;
  const from = window.outputStartFrame - clip.startFrame;
  const span = window.outputEndFrame - window.outputStartFrame;

  function at(index: number): number {
    const local = from * count + index * span;
    if (local === 0) return entry;
    if (local === clip.durationFrames * count) return exit;
    const position = unwrap(timeMapTailInverse(plan, {
      numerator: String(plan.outputWindow.fromFrame * count + local), denominator: String(count),
    }, {tailInverse: reverse ? 'earliest' : 'latest'}));
    return position.tail ? exit : Math.max(low, Math.min(high, sourceSample(position.position)));
  }

  const peaks: (number | null)[] = [];
  let previous = at(0);
  for (let index = 1; index <= count; index++) {
    const current = at(index);
    const begin = Math.min(previous, current), end = Math.max(previous, current);
    previous = current;
    if (end <= begin) {peaks.push(0); continue;}
    if (begin >= source.sampleFrames) {peaks.push(null); continue;}
    const first = Math.floor(begin / samplesPerPeak);
    const last = Math.ceil(Math.min(end, source.sampleFrames) / samplesPerPeak);
    let peak = 0;
    for (let bin = first; bin < last; bin++) peak = Math.max(peak, source.peaks[bin]!);
    peaks.push(peak / 65535);
  }
  return peaks;
}
