import React, {useSyncExternalStore} from 'react';
import type {TimelinePlaybackClock} from './timeline-playback-clock.ts';

const noFrame = () => null;
const noSubscription = () => () => {};

export function useTimelinePlaybackFrame(clock: TimelinePlaybackClock | undefined, fallback: number): number {
  return useSyncExternalStore(clock?.subscribe ?? noSubscription, clock?.getSnapshot ?? noFrame, noFrame) ?? fallback;
}

export function TimelineTrackPlayhead({clock, playhead, pixelsPerFrame}: {
  clock?: TimelinePlaybackClock;
  playhead: number;
  pixelsPerFrame: number;
}) {
  const frame = useTimelinePlaybackFrame(clock, playhead);
  return <div className="track-playhead" style={{left: frame * pixelsPerFrame}} />;
}
