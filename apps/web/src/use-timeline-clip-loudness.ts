import { useLayoutEffect, useRef, useState } from 'react';
import { createTimelineClipLoudnessController, timelineClipLoudnessViewState } from './timeline-clip-loudness-state.ts';
import type { TimelineClipLoudnessContext, TimelineClipLoudnessController, TimelineClipLoudnessControllerOptions, TimelineClipLoudnessState, TimelineClipLoudnessView } from './timeline-clip-loudness-state.ts';

export function timelineClipLoudnessPageContext(context: TimelineClipLoudnessContext): TimelineClipLoudnessContext {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden' ? context : { ...context, visible: false };
}
export function useTimelineClipLoudness(options: TimelineClipLoudnessControllerOptions & { context: TimelineClipLoudnessContext }): TimelineClipLoudnessView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<TimelineClipLoudnessState | null>(null);
  const controller = useRef<TimelineClipLoudnessController | null>(null);
  if (!controller.current) controller.current = createTimelineClipLoudnessController({
    read: (input, invocation) => callbacks.current.read(input, invocation),
    getContext: () => timelineClipLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context),
    getInvocation: () => callbacks.current.getInvocation?.() ?? {}, onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
    ...(options.onMatchGain ? { onMatchGain: (gain: number) => callbacks.current.onMatchGain?.(gain) === true } : {}),
  });
  const owned = controller.current;
  useLayoutEffect(() => {
    owned.attach(timelineClipLoudnessPageContext(callbacks.current.context));
    const visibility = (): void => owned.setContext(timelineClipLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context));
    const pagehide = (): void => owned.revoke();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); owned.dispose(); };
  }, [owned]);
  useLayoutEffect(() => { owned.setContext(timelineClipLoudnessPageContext(options.context)); });
  // Opening, reconnecting and returning from history never start measurement.
  return { state: timelineClipLoudnessViewState(state ?? owned.getState(), timelineClipLoudnessPageContext(options.context)), controller: owned };
}
