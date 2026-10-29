import { useLayoutEffect, useRef, useState } from 'react';
import { createDialogueLoudnessController, dialogueLoudnessViewState } from './dialogue-loudness-state.ts';
import type { DialogueLoudnessContext, DialogueLoudnessController, DialogueLoudnessControllerOptions, DialogueLoudnessState, DialogueLoudnessView } from './dialogue-loudness-state.ts';

export function dialogueLoudnessPageContext(context: DialogueLoudnessContext): DialogueLoudnessContext {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden' ? context : { ...context, visible: false };
}
export function useDialogueLoudness(options: DialogueLoudnessControllerOptions & { context: DialogueLoudnessContext }): DialogueLoudnessView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<DialogueLoudnessState | null>(null);
  const controller = useRef<DialogueLoudnessController | null>(null);
  if (!controller.current) controller.current = createDialogueLoudnessController({
    read: (input, invocation) => callbacks.current.read(input, invocation),
    apply: (gains, expectedRevision) => callbacks.current.apply(gains, expectedRevision),
    getContext: () => dialogueLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context),
    getInvocation: () => callbacks.current.getInvocation?.() ?? {}, onUnauthorized: () => callbacks.current.onUnauthorized?.(),
    locale: () => callbacks.current.locale?.() ?? 'zh-Hans', onChange: setState,
  });
  const owned = controller.current;
  useLayoutEffect(() => {
    owned.attach(dialogueLoudnessPageContext(callbacks.current.context));
    const visibility = (): void => owned.setContext(dialogueLoudnessPageContext(callbacks.current.getContext?.() ?? callbacks.current.context));
    const pagehide = (): void => owned.revoke();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); owned.dispose(); };
  }, [owned]);
  useLayoutEffect(() => { owned.setContext(dialogueLoudnessPageContext(options.context)); });
  // Opening, reconnecting and returning from history never start measurement.
  return { state: dialogueLoudnessViewState(state ?? owned.getState(), dialogueLoudnessPageContext(options.context)), controller: owned };
}
