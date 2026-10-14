import { useLayoutEffect, useRef, useState } from 'react';
import { createTimelineLoudnessApplyController } from './timeline-loudness-apply-state.ts';
import type { TimelineLoudnessApplyController, TimelineLoudnessApplyControllerOptions, TimelineLoudnessApplyState, TimelineLoudnessApplyView } from './timeline-loudness-apply-state.ts';
import type { TimelineMixLoudnessState } from './timeline-mix-loudness-state.ts';
import type { NativeCloseRegistry } from './native-close-state.ts';
export interface TimelineLoudnessApplyHookOptions extends TimelineLoudnessApplyControllerOptions { readonly nativeCloseRegistry?: NativeCloseRegistry }
export function timelineLoudnessApplyPageObservation(observation: TimelineMixLoudnessState): TimelineMixLoudnessState {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden' ? observation : { ...observation, visible: false };
}
export function useTimelineLoudnessApply(options: TimelineLoudnessApplyHookOptions): TimelineLoudnessApplyView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<TimelineLoudnessApplyState | null>(null);
  const controller = useRef<TimelineLoudnessApplyController | null>(null);
  const closeOwner = useRef<ReturnType<NativeCloseRegistry['register']> | null>(null);
  const observation = (): TimelineMixLoudnessState => timelineLoudnessApplyPageObservation(callbacks.current.getObservation());
  if (!controller.current) controller.current = createTimelineLoudnessApplyController({ getObservation: observation,
    getRecoveryScope: () => callbacks.current.getRecoveryScope ? callbacks.current.getRecoveryScope() : observation().scope,
    confirm: message => callbacks.current.confirm(message), createRequestId: () => callbacks.current.createRequestId(),
    submit: (intent, canExecute) => callbacks.current.submit(intent, canExecute), onChange: setState,
    onCloseChange: value => closeOwner.current?.update(value) });
  const owned = controller.current;
  useLayoutEffect(() => {
    const registration = options.nativeCloseRegistry?.register('timeline-loudness-apply');
    closeOwner.current = registration ?? null;
    owned.attach();
    registration?.update(owned.getCloseState());
    const visibility = (): void => owned.setObservation(observation());
    const revoke = (): void => owned.revoke();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', revoke); window.addEventListener('blur', revoke);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', revoke); window.removeEventListener('blur', revoke);
      if (closeOwner.current === registration) closeOwner.current = null;
      registration?.release(); owned.dispose(); };
  }, [owned, options.nativeCloseRegistry]);
  useLayoutEffect(() => { owned.setObservation(observation()); });
  const current = state ?? owned.getState(), live = observation();
  return { state: current.scope !== null && (current.scope !== live.scope || current.projectId !== live.projectId) ? { ...current, phase: 'idle', requestId: null, error: '' } : current, controller: owned };
}
