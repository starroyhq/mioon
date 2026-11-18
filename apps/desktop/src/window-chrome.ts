import { DESKTOP_CHROME_SCALE_EVENT, DESKTOP_FULLSCREEN_EVENT, isDesktopChromeScale, macWindowChrome, MAC_WINDOW_CHROME,
  windowsTitleBarOverlay } from '../../../packages/contracts/src/desktop-window-chrome.ts';
import type { WindowsTitleBarAppearance } from '../../../packages/contracts/src/desktop-window-chrome.ts';
import type { EventEmitter } from 'node:events';
import { WINDOW_BACKGROUNDS } from './window-appearance.ts';

export const MAC_TRAFFIC_LIGHT_POSITION = MAC_WINDOW_CHROME.position;

export type WindowTitleBarOverlay = ReturnType<typeof windowsTitleBarOverlay>;
export type WindowChromeOptions = {
  titleBarStyle?: 'hidden';
  trafficLightPosition?: {x: number; y: number};
  titleBarOverlay?: WindowTitleBarOverlay;
};

/** The desktop appearance module owns the two native fill colors; anything that
 * is not the dark fill follows the light palette. */
export function windowsTitleBarAppearance(background: string): WindowsTitleBarAppearance {
  return background.trim().toLowerCase() === WINDOW_BACKGROUNDS.dark.toLowerCase() ? 'dark' : 'light';
}

export function windowChromeOptions(platform: NodeJS.Platform = process.platform, background?: string): WindowChromeOptions {
  if (platform === 'darwin') return {titleBarStyle: 'hidden', trafficLightPosition: {...MAC_TRAFFIC_LIGHT_POSITION}};
  if (platform === 'win32' && typeof background === 'string' && background) {
    return {titleBarStyle: 'hidden', titleBarOverlay: windowsTitleBarOverlay(windowsTitleBarAppearance(background))};
  }
  return {};
}

interface OverlayWindow {isDestroyed(): boolean; setTitleBarOverlay?(options: WindowTitleBarOverlay): void}

/** Native System caption buttons follow the application appearance changes that
 * the window appearance module applies to the window fill. */
export function applyWindowsTitleBarOverlay(window: OverlayWindow, background: string): void {
  if (window.isDestroyed() || typeof window.setTitleBarOverlay !== 'function') return;
  try {window.setTitleBarOverlay(windowsTitleBarOverlay(windowsTitleBarAppearance(background)));} catch { /* A disappearing native window keeps its last painted overlay. */ }
}

type ChromeEvents = Pick<EventEmitter, 'on' | 'once' | 'removeListener'>;

interface ChromeWindow extends ChromeEvents {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setWindowButtonVisibility(visible: boolean): void;
  setWindowButtonPosition(position: {x: number; y: number}): void;
  webContents: ChromeEvents & {
    readonly mainFrame: object;
    isDestroyed(): boolean;
    send(channel: string, fullscreen: boolean): void;
  };
}

/** AppKit can replace the initial inset when the native window is shown. */
export function installWindowChrome(window: ChromeWindow, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'darwin') return () => {};
  const contents = window.webContents;
  let disposed = false;
  let hiddenForFullscreen = false;
  let scale = 1;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const refresh = () => {
    if (disposed || window.isDestroyed()) return;
    const fullscreen = window.isFullScreen();
    if (fullscreen !== hiddenForFullscreen) {
      window.setWindowButtonVisibility(!fullscreen);
      hiddenForFullscreen = fullscreen;
    }
    if (!fullscreen) window.setWindowButtonPosition({...macWindowChrome(scale).position});
    if (!contents.isDestroyed()) contents.send(DESKTOP_FULLSCREEN_EVENT, fullscreen);
  };
  const afterTransition = () => {
    refresh();
    if (pending) clearImmediate(pending);
    pending = setImmediate(() => { pending = undefined; refresh(); });
    pending.unref();
  };
  const events = ['ready-to-show', 'show', 'enter-full-screen', 'leave-full-screen'];
  for (const event of events) window.on(event, afterTransition);
  contents.on('dom-ready', refresh);
  const receiveScale = (event: {senderFrame: object | null}, channel: string, ...args: unknown[]) => {
    if (disposed || window.isDestroyed() || contents.isDestroyed() || channel !== DESKTOP_CHROME_SCALE_EVENT ||
        event.senderFrame !== contents.mainFrame || args.length !== 1 || !isDesktopChromeScale(args[0]) || args[0] === scale) return;
    scale = args[0];
    refresh();
  };
  contents.on('ipc-message', receiveScale);
  const dispose = () => {
    disposed = true;
    if (pending) clearImmediate(pending);
    for (const event of events) window.removeListener(event, afterTransition);
    window.removeListener('closed', dispose);
    contents.removeListener('dom-ready', refresh);
    contents.removeListener('ipc-message', receiveScale);
  };
  window.once('closed', dispose);
  refresh();
  return dispose;
}
