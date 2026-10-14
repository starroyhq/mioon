import { useLayoutEffect, useRef, useState } from 'react';
import { createTimelineMixLoudnessController, timelineMixLoudnessViewState } from './timeline-mix-loudness-state.ts';
import type { TimelineMixLoudnessContext, TimelineMixLoudnessController, TimelineMixLoudnessControllerOptions, TimelineMixLoudnessState, TimelineMixLoudnessView } from './timeline-mix-loudness-state.ts';

export function timelineMixLoudnessPageContext(context: TimelineMixLoudnessContext): TimelineMixLoudnessContext {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden' ? context : { ...context, visible: false };
}
export function useTimelineMixLoudness(options: TimelineMixLoudnessControllerOptions & { context: TimelineMixLoudnessContext }): TimelineMixLoudnessView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<TimelineMixLoudnessState | null>(null);
  const controller = useRef<TimelineMixLoudnessController | null>(null);
  if (!controller.current) controller.current = createTimelineMixLoudnessController({
    read: (input, invocation) => callbacks.current.read(input, invocation),
    getContext: () => timelineMixLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context),
    getInvocation: () => callbacks.current.getInvocation?.() ?? {}, onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
  });
  const owned = controller.current;
  useLayoutEffect(() => {
    owned.attach(timelineMixLoudnessPageContext(callbacks.current.context));
    const visibility = (): void => owned.setContext(timelineMixLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context));
    const pagehide = (): void => owned.revoke();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); owned.dispose(); };
  }, [owned]);
  useLayoutEffect(() => { owned.setContext(timelineMixLoudnessPageContext(options.context)); });
  // Opening, reconnecting and returning from history never start measurement.
  return { state: timelineMixLoudnessViewState(state ?? owned.getState(), timelineMixLoudnessPageContext(options.context)), controller: owned };
}
