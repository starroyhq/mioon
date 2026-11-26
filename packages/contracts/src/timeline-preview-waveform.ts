import {AppError} from './app-error.ts';
import {compileClipTimeMap} from './timeline-clip-timing.ts';
import type {ClipTiming} from './timeline-speed.ts';
import {
  timeMapSourceRangeForEdit, timeMapTailInverse,
  type ContinuousSourcePosition, type CurrentTimelineClipLike, type TimeMapResult, type TimeMapSourceBoundary,
} from './timeline-time-map.ts';
import {SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES} from './timeline-speed-export.ts';
import {
  WAVEFORM_BINS_PER_SECOND, WAVEFORM_DEFAULT_POINTS, WAVEFORM_FPS, WAVEFORM_MAX_POINTS, WAVEFORM_SAMPLE_RATE,
  isWaveformResponse, type WaveformResponse,
} from './waveforms.ts';

const samplesPerFrame = WAVEFORM_SAMPLE_RATE / WAVEFORM_FPS;

export interface TimelineWaveformWindow {
  readonly outputStartFrame: number;
  readonly outputEndFrame: number;
  readonly points?: number;
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

function timelineWaveformPointCount(clip: WaveformClip, window: TimelineWaveformWindow): number {
  const {outputStartFrame, outputEndFrame, points = WAVEFORM_DEFAULT_POINTS} = window;
  if (![outputStartFrame, outputEndFrame, points].every(Number.isSafeInteger) || outputStartFrame < clip.startFrame ||
      outputEndFrame <= outputStartFrame || outputEndFrame > clip.startFrame + clip.durationFrames ||
      points < 1 || points > WAVEFORM_MAX_POINTS) {
    throw new AppError('SOURCE_BOUNDS', 'Waveform range is outside the timeline clip.', 400);
  }
  return Math.min(points, Math.ceil((outputEndFrame - outputStartFrame) * WAVEFORM_BINS_PER_SECOND / WAVEFORM_FPS));
}

/** Project normalized asset.waveform.get peaks into equal-width groups on
 * the output clock. Maxima retain the resolution of the fetched source
 * window. Missing source coverage stays null; holds and the tail are silent. */
export function projectTimelineWaveformPeaks(clip: WaveformClip, fps: number,
  window: TimelineWaveformWindow, source?: WaveformResponse | null): (number | null)[] | null {
  const count = timelineWaveformPointCount(clip, window);
  if (fps !== WAVEFORM_FPS) return invalid('INVALID_TIMEBASE');
  const plan = unwrap(compileClipTimeMap(clip, {fps}));
  if (plan.durationFrames !== clip.durationFrames) return invalid('INVALID_WINDOW');
  if (clip.timing?.profile === 'timeline-freeze-v1') return Array<number>(count).fill(0);
  if (source?.status !== 'ready' || source.peaks === undefined) return null;
  const {peaks: sourcePeaks, sourceStartFrame, sourceEndFrame, decodedSampleFrames} = source;
  if (sourceStartFrame === undefined || sourceEndFrame === undefined || decodedSampleFrames === undefined ||
      !isWaveformResponse(source)) throw new AppError('WAVEFORM_PROTOCOL', 'Invalid source waveform.');
  const sourceBegin = sourceStartFrame * samplesPerFrame;
  const sourceEnd = sourceEndFrame * samplesPerFrame;
  const coverageEnd = Math.min(sourceEnd, decodedSampleFrames);
  const groupsPerSample = sourcePeaks.length / (sourceEnd - sourceBegin);
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
    const coveredBegin = Math.max(begin, sourceBegin), coveredEnd = Math.min(end, coverageEnd);
    if (coveredEnd <= coveredBegin) {peaks.push(null); continue;}
    const first = Math.floor((coveredBegin - sourceBegin) * groupsPerSample);
    const last = Math.min(sourcePeaks.length, Math.ceil((coveredEnd - sourceBegin) * groupsPerSample));
    let peak: number | null = null;
    for (let bin = first; bin < last; bin++) {
      const sample = sourcePeaks[bin]!;
      if (sample !== null) peak = Math.max(peak ?? 0, sample);
    }
    peaks.push(peak);
  }
  return peaks;
}
