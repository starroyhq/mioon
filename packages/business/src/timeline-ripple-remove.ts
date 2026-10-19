import {AppError} from '../../contracts/src/app-error.ts';

interface RippleClip {id: string; trackId: string; startFrame: number; durationFrames: number}

/** Keep gaps and source clocks intact; only the removed interval closes on its
 * own track. The caller validates the whole aggregate before writing/history. */
export function removeTimelineClipWithRipple<T extends RippleClip>(timeline: {clips: T[]}, clipId: string): void {
  const removed = timeline.clips.find(clip => clip.id === clipId);
  if (!removed) throw new AppError('CLIP_NOT_FOUND', '片段不属于此时间线', 404, {clipId});
  const end = removed.startFrame + removed.durationFrames;
  timeline.clips = timeline.clips.filter(clip => clip.id !== clipId).map(clip =>
    clip.trackId === removed.trackId && clip.startFrame >= end
      ? {...clip, startFrame: clip.startFrame - removed.durationFrames}
      : clip);
}
