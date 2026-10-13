import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorWindowBinding } from './editor-native-window.ts';
import type { ProjectWindowSettingsSlot } from './desktop-window-client.ts';
/** Focus changes and explicit settings entry invalidate local interaction,
 * never the draft or accepted operation. React visibility alone can lag IPC. */
export function createEditorSettingsScope(open: (slot: ProjectWindowSettingsSlot) => Promise<boolean>) {
  let active = true, mounted = true, version = 0, focused = true, observationPaused = false;
  const observers = new Set<(active: boolean) => void>();
  const publish = (next: boolean) => { active = next; version++; for (const notify of observers) notify(active); };
  return {
    get active() { return mounted && active; },
    get version() { return version; },
    subscribe(notify: (active: boolean) => void) { observers.add(notify); notify(mounted && active); return () => { observers.delete(notify); }; },
    focus() { focused = true; if (mounted && !observationPaused) publish(true); },
    blur() { focused = false; if (mounted && !observationPaused) publish(false); },
    activate(value = true) { mounted = true; focused = value; observationPaused = false; publish(focused); },
    pauseObservation(value: boolean) {
      if (!mounted || observationPaused === value) return;
      observationPaused = value;
      // Clear old consent before native inspection captures registry state.
      // Native-dialog blur/focus then records focus without starting a read.
      publish(value ? false : focused);
    },
    dispose() { mounted = false; publish(false); },
    async open(slot: ProjectWindowSettingsSlot): Promise<boolean> {
      if (!mounted) return false;
      focused = false; publish(false); const captured = version;
      let accepted = false;
      try { accepted = await open(slot); } catch { /* Remain a read-only navigation failure. */ }
      if (!accepted && mounted && version === captured) { focused = true; if (!observationPaused) publish(true); }
      return accepted;
    },
  };
}
export type EditorSettingsScope = ReturnType<typeof createEditorSettingsScope>;
export function useEditorSettingsScope(binding: EditorWindowBinding | null): EditorSettingsScope | undefined {
  const scope = useMemo(() => binding ? createEditorSettingsScope(slot => binding.bridge.showSettings(slot)) : undefined,
    [binding?.bridge, binding?.context.contextId]);
  useEffect(() => {
    if (!scope) return;
    scope.activate(document.hasFocus());
    const focus = () => scope.focus(), blur = () => scope.blur();
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); scope.dispose(); };
  }, [scope]);
  return scope;
}
/** Caller uses the boolean alongside its existing pane/document fences. The
 * synchronous callback reaches the session before IPC or React rendering. */
export function useNativeSettingsActivity(scope: EditorSettingsScope | undefined, apply: (active: boolean) => void): boolean {
  const callback = useRef(apply); callback.current = apply;
  const [state, setState] = useState(scope?.active ?? true);
  useLayoutEffect(() => scope?.subscribe(active => { callback.current(active); setState(active); }), [scope]);
  return scope ? state && scope.active : true;
}
