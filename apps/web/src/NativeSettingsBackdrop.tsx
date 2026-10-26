import React, { useLayoutEffect, useRef } from 'react';
import type { FocusEvent, ReactNode } from 'react';

/** Native modality owns the window controls. This surface only dims and makes
 * the retained parent document inert; it never pauses or unmounts its work. */
export default function NativeSettingsBackdrop({ blocked, children }: { blocked: boolean; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const currentBlocked = useRef(blocked), wasBlocked = useRef(false);
  currentBlocked.current = blocked;
  const rememberFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!currentBlocked.current && event.target instanceof HTMLElement) previousFocus.current = event.target;
  };
  useLayoutEffect(() => {
    const root = surface.current;
    if (!root) return;
    const document = root.ownerDocument, view = document.defaultView;
    if (blocked) {
      wasBlocked.current = true;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement && document.body.contains(active)) {
        previousFocus.current = active;
        active.blur();
      }
      // Existing dialogs and menus may be portaled outside this surface.
      // The native settings sheet owns a separate document, so making the
      // parent body inert also excludes those retained portals from focus/AT.
      const bodyWasInert = document.body.inert;
      document.body.inert = true;
      // Some editor shortcuts listen on document/window rather than a focused
      // control. Inert alone does not stop those listeners during sheet setup.
      const stopShortcut = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('keydown', stopShortcut, true);
      return () => { document.body.inert = bodyWasInert; document.removeEventListener('keydown', stopShortcut, true); };
    }
    if (!wasBlocked.current) return;
    wasBlocked.current = false;
    let current = true;
    const target = previousFocus.current;
    const restore = () => {
      if (!current || currentBlocked.current || !document.hasFocus()) return;
      view?.removeEventListener('focus', restore);
      const active = document.activeElement;
      // Do not move focus out of another window or over a newer user choice.
      if (active && active !== document.body && active !== document.documentElement && active !== target) return;
      if (root.isConnected && target?.isConnected && target.ownerDocument === document && document.body.contains(target) &&
          !target.closest('[inert], [hidden], [aria-hidden="true"]') && !target.matches(':disabled')) target.focus({ preventScroll: true });
    };
    if (document.hasFocus()) restore();
    else view?.addEventListener('focus', restore);
    return () => { current = false; view?.removeEventListener('focus', restore); };
  }, [blocked]);
  return <>
    <div ref={surface} className="native-settings-parent-surface" data-testid="native-settings-parent-surface" inert={blocked} aria-hidden={blocked || undefined} onFocusCapture={rememberFocus}>{children}</div>
    {blocked && <div className="native-settings-modal-backdrop" data-testid="native-settings-modal-backdrop" aria-hidden="true" />}
  </>;
}
