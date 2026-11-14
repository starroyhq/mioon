import {canvasClipboardHandle} from '../../../packages/contracts/src/canvas-clipboard.ts';

export const CANVAS_CLIPBOARD_CHANNEL = 'mioon:canvas-clipboard:read-handle:v1';
export interface CanvasClipboardBridge {
  readHandle(): Promise<string | null>;
}

const pasteTarget = '[data-canvas-clipboard-action="paste"]';
export function installCanvasClipboardBridge(
  view: Window,
  invoke: () => Promise<unknown>,
): CanvasClipboardBridge {
  let gesture: Event | null = null;
  const capture = (event: Event) => {
    if (!event.isTrusted || event.defaultPrevented || !view.document.hasFocus() ||
        !event.composedPath().some(target => target instanceof Element && target.matches(pasteTarget))) return;
    if (event.type === 'click') {
      if (!(event instanceof MouseEvent) || event.button !== 0) return;
    } else {
      if (!(event instanceof KeyboardEvent) || event.repeat || event.isComposing || event.keyCode === 229 ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          (event.key !== 'Enter' && event.key !== ' ')) return;
    }
    gesture = event;
    // A microtask can run between isolated-world capture and page listeners.
    // Retire after the current event task so the page can consume this once.
    setTimeout(() => { if (gesture === event) gesture = null; }, 0);
  };
  view.addEventListener('click', capture, true);
  view.addEventListener('keydown', capture, true);
  return Object.freeze({
    async readHandle() {
      if (!gesture || !view.document.hasFocus() || !view.navigator.userActivation?.isActive) return null;
      gesture = null;
      try { return canvasClipboardHandle(await invoke()); }
      catch { return null; }
    },
  });
}
