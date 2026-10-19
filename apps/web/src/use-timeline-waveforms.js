import { useLayoutEffect, useRef, useState } from 'react';
import {TIMELINE_TRACK_HEADER_PX, TIMELINE_RULER_PX} from './timeline-view-geometry.ts';
import { rpc } from './api.js';
import { createWaveformController, visibleWaveformWindows } from './waveform-state.js';

export function useTimelineWaveforms({ timeline, assets, viewport, pixelsPerFrame, active, readOnly = false, workspaceOrigin = null }) {
  const [state, setState] = useState({ enabled: false, entries: new Map(), retryable: false });
  const [windows, setWindows] = useState([]);
  const controller = useRef(null), latest = useRef(null), measureRef = useRef(null);
  if (!controller.current) controller.current = createWaveformController({ api: rpc });
  latest.current = { timeline, assets, pixelsPerFrame, active, readOnly, workspaceOrigin };
  useLayoutEffect(() => {
    const manager = controller.current;
    manager.connect(setState);
    const element = viewport.current;
    function measure() {
      const current = latest.current;
      const shown = current.active && document.visibilityState !== 'hidden';
      const bounds = element?.getBoundingClientRect();
      const visibleTrackIds = new Set();
      if (shown && element && element.clientWidth > TIMELINE_TRACK_HEADER_PX && element.clientHeight > TIMELINE_RULER_PX) {
        for (const track of element.querySelectorAll('[data-waveform-track]')) {
          const rect = track.getBoundingClientRect();
          if (rect.bottom > bounds.top + TIMELINE_RULER_PX && rect.top < bounds.top + element.clientHeight) visibleTrackIds.add(track.dataset.waveformTrack);
        }
      }
      const next = shown && element ? visibleWaveformWindows({ ...current, visibleTrackIds, leftFrame: element.scrollLeft / current.pixelsPerFrame, rightFrame: (element.scrollLeft + Math.max(0, element.clientWidth - TIMELINE_TRACK_HEADER_PX)) / current.pixelsPerFrame }) : [];
      setWindows(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      manager.setView({ projectId: current.timeline?.projectId || null, active: shown, windows: next, readOnly: current.readOnly, workspaceOrigin: current.workspaceOrigin });
    }
    measureRef.current = measure;
    const observer = new ResizeObserver(measure);
    if (element) { observer.observe(element); element.addEventListener('scroll', measure, { passive: true }); }
    document.addEventListener('visibilitychange', measure);
    measure();
    return () => { manager.disconnect(); observer.disconnect(); element?.removeEventListener('scroll', measure); document.removeEventListener('visibilitychange', measure); measureRef.current = null; };
  }, [viewport]);
  useLayoutEffect(() => { measureRef.current?.(); }, [timeline, assets, pixelsPerFrame, active, readOnly, workspaceOrigin]);
  // Project check also makes the first render after navigation fail closed.
  return { ...state, enabled: state.projectId === timeline?.projectId && state.enabled, windows, setEnabled: value => controller.current.setEnabled(value), retry: () => controller.current.retryVisible() };
}
