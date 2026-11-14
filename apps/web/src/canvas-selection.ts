import type {CanvasEditBase, CanvasTarget} from '../../../packages/contracts/src/canvas-editing.ts';
import {nativeMenuTextFocus} from './desktop-menu-client.ts';

export function supportsCanvasEditing(version: number | undefined, base: CanvasEditBase | undefined): boolean {
  return version === 4 && Boolean(base);
}

export function toggleCanvasSelection(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function canvasSelectionTargets(
  base: CanvasEditBase | undefined, ids: ReadonlySet<string>, edgeId: string | null,
): CanvasTarget[] {
  return (base?.targets ?? []).flatMap(({kind, id}) =>
    (kind === 'edge' ? id === edgeId : ids.has(id)) ? [{kind, id}] : []);
}

type CanvasShortcut = 'all' | 'clear' | 'archive' | 'tidy' | 'undo' | 'redo';

export function canvasShortcut(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'repeat' | 'isComposing' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  {blocked, composing, textFocus, nativeHistory}: {blocked: boolean; composing: boolean; textFocus: boolean; nativeHistory: boolean},
): CanvasShortcut | undefined {
  if (blocked || composing || textFocus || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.repeat || event.altKey || event.ctrlKey && event.metaKey) return;
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'a' && !event.shiftKey) return 'all';
    if (key === 'l' && event.shiftKey) return 'tidy';
    if (key === 'z' && !nativeHistory) return event.shiftKey ? 'redo' : 'undo';
    return;
  }
  if (event.shiftKey) return;
  if (event.key === 'Escape') return 'clear';
  if (event.key === 'Delete' || event.key === 'Backspace') return 'archive';
}

export function canvasShortcutInText(event: KeyboardEvent, activeElement: Element | null): boolean {
  return nativeMenuTextFocus(activeElement) || event.composedPath().some(target => target instanceof Element && nativeMenuTextFocus(target));
}
