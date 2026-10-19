export type ClipRemovalMode = 'remove' | 'ripple';
export interface RemovalKeyEvent {
  key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
  repeat?: boolean; defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number;
}

/** Deletion is deliberately independent from the editing Ctrl/Cmd shortcuts. */
export function clipRemovalKey(event: RemovalKeyEvent, blocked: boolean): ClipRemovalMode | null {
  if (blocked || event.key !== 'Backspace' || event.altKey || event.ctrlKey || event.metaKey ||
      event.repeat || event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  return event.shiftKey ? 'ripple' : 'remove';
}

export function clipRemovalTargetIsEditing(path: readonly EventTarget[]): boolean {
  return path.some(target => target instanceof Element && (target.matches('input, textarea, select, [role="textbox"], [role="combobox"], [role="spinbutton"]') ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null));
}

export function displayTimelineFrame(frame: number, fps = 30, format: 'timecode' | 'seconds' = 'timecode'): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(frame) ? frame : 0));
  if (format === 'seconds') return `${(safe / fps).toFixed(2)}s`;
  return [Math.floor(safe / fps / 3600), Math.floor(safe / fps / 60) % 60, Math.floor(safe / fps) % 60, safe % fps]
    .map(part => String(part).padStart(2, '0')).join(':');
}
