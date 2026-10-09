/** The ruler edits integer-frame position, independently of source playback. */
export function rulerFrameForKey(key, frame, maxFrame = 18000) {
  const current = Number.isFinite(Number(frame)) ? Math.round(Number(frame)) : 0;
  const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 30, PageDown: -30 };
  const next = key === 'Home' ? 0 : key === 'End' ? maxFrame : Object.hasOwn(steps, key) ? current + steps[key] : null;
  return next === null ? null : Math.max(0, Math.min(maxFrame, next));
}

const nativeEditingTargets = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="combobox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/** Preserve native text undo and modal controls, including shadow-DOM targets. */
export function timelineHistoryActionForKey(event, { modalOpen = false } = {}) {
  if (modalOpen || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.altKey || Boolean(event.ctrlKey) === Boolean(event.metaKey)) return null;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  const targets = [event.target, ...path, event.target?.ownerDocument?.activeElement];
  if (targets.some(target => target?.isContentEditable || (target?.closest ? target : target?.parentElement)?.closest?.(nativeEditingTargets))) return null;
  const key = event.key?.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}
