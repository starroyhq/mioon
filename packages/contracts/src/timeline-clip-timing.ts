import type {ClipTiming} from './timeline-speed.ts';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, restoreTimeMap, timeMapBasisFromCurrentClip, timeMapRootInfo,
  timeMapSourceAtOutputFrame, TIMELINE_TIME_MAP_LIMITS,
  type CompiledTimeMap, type CurrentTimelineClipLike, type CurrentTimelineLike, type TimeMapResult, type TimeMapSourceSample,
} from './timeline-time-map.ts';

/** An interval with fractional endpoints can cover one extra whole frame. */
export const MAX_CLIP_SOURCE_SPAN_FRAMES = TIMELINE_TIME_MAP_LIMITS.maxSourceFrames + 1;
const maxSampleFrame = 2 ** 31 - 1;
const sourceLimit = {ok: false, code: 'SOURCE_FRAME_LIMIT', detail: 'source frame exceeds the shared sample index range'} as const;

export function compileClipTimeMap(clip: CurrentTimelineClipLike & {timing?: ClipTiming},
  timeline: CurrentTimelineLike): TimeMapResult<CompiledTimeMap> {
  const {timing} = clip;
  if (timing?.profile === 'timeline-freeze-v1') {
    if (timing.sourceFrame > maxSampleFrame) return sourceLimit;
    const timebase = {fpsNumerator: timeline.fps, fpsDenominator: 1};
    const root = compileFreezeTimeMap({sourceFrame: timing.sourceFrame, durationFrames: clip.durationFrames,
      sourceFps: timebase, outputFps: timebase});
    return root.ok ? {ok: true, value: initialTimeMap(root.value)} : root;
  }
  const basis = timing ? {ok: true as const, value: timing.basis} : timeMapBasisFromCurrentClip(clip, timeline);
  if (!basis.ok) return basis;
  if ([basis.value.sourceFps, basis.value.outputFps].some(clock => clock.fpsNumerator !== timeline.fps || clock.fpsDenominator !== 1)) {
    return {ok: false, code: 'INVALID_TIMEBASE', detail: 'clip timing must use the project frame clock'};
  }
  const root = compileTimeMap(basis.value);
  if (!root.ok) return root;
  if (timeMapRootInfo(root.value).frameRange.end > maxSampleFrame) return sourceLimit;
  if (!timing) return {ok: true, value: initialTimeMap(root.value)};
  return restoreTimeMap(root.value, {...timing.view, outputWindow: timing.outputWindow});
}

/** Sample a clip at an absolute timeline frame. The result carries both the
 * selected project-clock source frame and its continuous source position. */
export function timelineClipSourceAtFrame(clip: CurrentTimelineClipLike & {timing?: ClipTiming},
  timeline: CurrentTimelineLike, timelineFrame: number): TimeMapResult<Pick<TimeMapSourceSample, 'sourceFrame' | 'source'>> {
  const outputFrame = timelineFrame - clip.startFrame;
  if (!Number.isSafeInteger(timelineFrame) || !Number.isSafeInteger(outputFrame) ||
      outputFrame < 0 || outputFrame >= clip.durationFrames) {
    return {ok: false, code: 'INVALID_WINDOW', detail: 'timeline frame outside the clip'};
  }
  if (!clip.timing) {
    const sourceFrame = clip.sourceInFrame + outputFrame;
    if (!Number.isSafeInteger(sourceFrame) || sourceFrame < 0) return sourceLimit;
    return {ok: true, value: {sourceFrame, source: {kind: 'exact', numerator: String(sourceFrame), denominator: '1'}}};
  }
  const plan = compileClipTimeMap(clip, timeline);
  if (!plan.ok) return plan;
  if (plan.value.durationFrames !== clip.durationFrames) {
    return {ok: false, code: 'INVALID_WINDOW', detail: 'compiled duration differs from the clip'};
  }
  const sample = timeMapSourceAtOutputFrame(plan.value, outputFrame);
  if (!sample.ok) return sample;
  const {sourceFrame, source} = sample.value;
  return {ok: true, value: {sourceFrame, source}};
}

export function clipSourceEndFrame(clip: {sourceInFrame: number; durationFrames: number; sourceSpanFrames?: number}): number {
  return clip.sourceInFrame + (clip.sourceSpanFrames ?? clip.durationFrames);
}
