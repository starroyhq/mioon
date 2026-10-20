import { TIMELINE_RULER_PX } from './timeline-view-geometry.ts';

export const COMPACT_TRACK_PX = 28;

/** Keep the ruler and native horizontal scrollbar while exposing whole lanes.
 * The unused remainder belongs outside the scroller, so no next lane peeks out. */
export function compactTimelineViewportHeight(availableHeight: number, scrollbarHeight = 0): number {
  const available = Math.max(0, Number.isFinite(availableHeight) ? availableHeight : 0);
  const scrollbar = Math.max(0, Number.isFinite(scrollbarHeight) ? scrollbarHeight : 0);
  const rows = Math.max(0, Math.floor((available - TIMELINE_RULER_PX - scrollbar) / COMPACT_TRACK_PX));
  return Math.min(available, TIMELINE_RULER_PX + rows * COMPACT_TRACK_PX + scrollbar);
}

export function compactTimelineScrollTop(scrollTop: number): number {
  return Math.max(0, Math.round((Number.isFinite(scrollTop) ? scrollTop : 0) / COMPACT_TRACK_PX) * COMPACT_TRACK_PX);
}
