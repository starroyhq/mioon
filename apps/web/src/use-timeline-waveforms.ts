import { useLayoutEffect, useRef, useState } from 'react';
import {TIMELINE_TRACK_HEADER_PX, TIMELINE_RULER_PX} from './timeline-view-geometry.ts';
import { rpc } from './api.ts';
import { createWaveformController, visibleWaveformWindows } from './waveform-state.ts';
import type { WaveformAsset, WaveformClip, WaveformEntry, WaveformSnapshot, WaveformTimeline, WaveformWindow } from './waveform-state.ts';

export type WaveformController=ReturnType<typeof createWaveformController>;
export interface WaveformViewportRef {readonly current: HTMLElement|null}
export interface UseTimelineWaveformsOptions {
  timeline: WaveformTimeline|null|undefined;
  assets: readonly WaveformAsset[];
  viewport: WaveformViewportRef;
  pixelsPerFrame: number;
  active: boolean;
  readOnly?: boolean;
  workspaceOrigin?: unknown;
}
export interface TimelineWaveformState {enabled: boolean; entries: Map<string, WaveformEntry>; retryable: boolean; projectId: string|null; windows: WaveformWindow[]; setEnabled(value: boolean): void; retry(): void}
interface LatestWaveformConfiguration {
  timeline: WaveformTimeline|null|undefined;
  assets: readonly WaveformAsset[];
  pixelsPerFrame: number;
  active: boolean;
  readOnly: boolean;
  workspaceOrigin: unknown;
}

export function useTimelineWaveforms({ timeline, assets, viewport, pixelsPerFrame, active, readOnly = false, workspaceOrigin = null }: UseTimelineWaveformsOptions): TimelineWaveformState {
  const [state, setState] = useState<WaveformSnapshot|null>(null);
  const [windows, setWindows] = useState<WaveformWindow[]>([]);
  const controller = useRef<WaveformController|null>(null), latest = useRef<LatestWaveformConfiguration|null>(null), measureRef = useRef<(()=>void)|null>(null);
  if (!controller.current) controller.current = createWaveformController({ api: rpc });
  latest.current = { timeline, assets, pixelsPerFrame, active, readOnly, workspaceOrigin };
  useLayoutEffect(() => {
    const manager = controller.current as WaveformController;
    manager.connect(setState);
    const element = viewport.current;
    function measure(): void {
      const current = latest.current; if(!current)return;
      const shown = current.active && document.visibilityState !== 'hidden';
      const bounds = element?.getBoundingClientRect();
      const visibleTrackIds = new Set<string>();
      if (shown && element && element.clientWidth > TIMELINE_TRACK_HEADER_PX && element.clientHeight > TIMELINE_RULER_PX && bounds) {
        for (const track of element.querySelectorAll<HTMLElement>('[data-waveform-track]')) {
          const rect = track.getBoundingClientRect();
          if (rect.bottom > bounds.top + TIMELINE_RULER_PX && rect.top < bounds.top + element.clientHeight) { const id=track.dataset.waveformTrack; if(id!==undefined)visibleTrackIds.add(id); }
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
  return { ...(state ?? { projectId: null, enabled: false, readOnly: false, active: false, entries: new Map<string,WaveformEntry>(), pending: 0, inFlight: false, autoLimitReached: false, retryable: false }), enabled: state?.projectId === timeline?.projectId && Boolean(state?.enabled), windows, setEnabled: value => controller.current?.setEnabled(value), retry: () => controller.current?.retryVisible() };
}
