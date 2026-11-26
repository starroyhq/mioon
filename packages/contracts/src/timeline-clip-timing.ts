import type {ClipTiming} from './timeline-speed.ts';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, restoreTimeMap, timeMapBasisFromCurrentClip,
  type CompiledTimeMap, type CurrentTimelineClipLike, type CurrentTimelineLike, type TimeMapResult,
} from './timeline-time-map.ts';

export function compileClipTimeMap(clip: CurrentTimelineClipLike & {timing?: ClipTiming},
  timeline: CurrentTimelineLike): TimeMapResult<CompiledTimeMap> {
  const {timing} = clip;
  if (timing?.profile === 'timeline-freeze-v1') {
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
  if (!timing) return {ok: true, value: initialTimeMap(root.value)};
  return restoreTimeMap(root.value, {...timing.view, outputWindow: timing.outputWindow});
}

export function clipSourceEndFrame(clip: {sourceInFrame: number; durationFrames: number; sourceSpanFrames?: number}): number {
  return clip.sourceInFrame + (clip.sourceSpanFrames ?? clip.durationFrames);
}
