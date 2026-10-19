/** The ruler edits integer-frame position, independently of source playback. */
const arrowSteps: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 30, PageDown: -30 };
export function rulerFrameForKey(key: string, frame: number, maxFrame = 18000): number | null {
  const current = Number.isFinite(Number(frame)) ? Math.round(Number(frame)) : 0;
  const next = key === 'Home' ? 0 : key === 'End' ? maxFrame : Object.hasOwn(arrowSteps, key) ? current + arrowSteps[key] : null;
  return next === null ? null : Math.max(0, Math.min(maxFrame, next));
}

const nativeEditingTargets = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="spinbutton"], [role="combobox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/** Native editing and modal controls, including shadow-DOM targets. */
interface ShortcutEvent {
  defaultPrevented: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode: number;
  key: string | undefined;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  composedPath?: () => EventTarget[];
}
interface ShortcutTarget {
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
  parentElement?: {closest?: (selector: string) => Element | null} | null;
  ownerDocument?: {activeElement?: ShortcutTarget | null} | null;
}
function shortcutBlocked(event: ShortcutEvent, modalOpen: boolean): boolean {
  if (modalOpen || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.altKey || Boolean(event.ctrlKey) === Boolean(event.metaKey)) return true;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : (event.target ? [event.target] : []);
  const selected = event.target as ShortcutTarget | null;
  const targets: (ShortcutTarget | null | undefined)[] = [selected, ...path as ShortcutTarget[], selected?.ownerDocument?.activeElement];
  return targets.some(target => target?.isContentEditable || (target?.closest ? target : target?.parentElement)?.closest?.(nativeEditingTargets));
}

export function timelineHistoryActionForKey(event: ShortcutEvent, { modalOpen = false }: {modalOpen?: boolean} = {}): 'undo' | 'redo' | null {
  if (shortcutBlocked(event, modalOpen)) return null;
  const key = event.key?.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}

export function timelineSplitActionForKey(event: ShortcutEvent, { modalOpen = false }: {modalOpen?: boolean} = {}): 'split' | null {
  return !shortcutBlocked(event, modalOpen) && !event.shiftKey && event.key?.toLowerCase() === 'b' ? 'split' : null;
}
