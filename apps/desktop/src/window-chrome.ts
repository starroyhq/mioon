import { DESKTOP_CHROME_SCALE_EVENT, DESKTOP_FULLSCREEN_EVENT, DESKTOP_TITLEBAR_COLOR_EVENT, isDesktopChromeScale,
  isDesktopTitleBarColor, macWindowChrome, MAC_WINDOW_CHROME, WINDOWS_WINDOW_CHROME } from '../../../packages/contracts/src/desktop-window-chrome.ts';
import type { EventEmitter } from 'node:events';

export const MAC_TRAFFIC_LIGHT_POSITION = MAC_WINDOW_CHROME.position;

export type WindowTitleBarOverlay = {color: string; symbolColor: string; height: number};
export type WindowChromeOptions = {
  titleBarStyle?: 'hidden';
  trafficLightPosition?: {x: number; y: number};
  titleBarOverlay?: WindowTitleBarOverlay;
};

const isTitleBarBackgroundColor = isDesktopTitleBarColor;

interface Rgba {r: number; g: number; b: number; a: number}
function parseColor(value: string): Rgba | null {
  if (/^#[0-9a-fA-F]{3}$/u.test(value)) {
    return {r: parseInt(value[1]! + value[1]!, 16), g: parseInt(value[2]! + value[2]!, 16), b: parseInt(value[3]! + value[3]!, 16), a: 1};
  }
  if (/^#[0-9a-fA-F]{4}$/u.test(value)) {
    return {r: parseInt(value[1]! + value[1]!, 16), g: parseInt(value[2]! + value[2]!, 16), b: parseInt(value[3]! + value[3]!, 16),
      a: parseInt(value[4]! + value[4]!, 16) / 255};
  }
  if (/^#[0-9a-fA-F]{6}$/u.test(value) || /^#[0-9a-fA-F]{8}$/u.test(value)) {
    const alpha = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
    return {r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16), a: alpha};
  }
  const match = /^rgba?\(([^)]*)\)$/u.exec(value);
  if (!match) return null;
  const parts = match[1]!.split(/[,/\s]+/u).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const numeric = parts.map(part => /%$/u.test(part) ? parseFloat(part) / 100 : parseFloat(part));
  if (numeric.slice(0, 3).some(part => !Number.isFinite(part))) return null;
  const alpha = numeric[3];
  return {r: Math.min(255, Math.max(0, Math.round(numeric[0]!))), g: Math.min(255, Math.max(0, Math.round(numeric[1]!))),
    b: Math.min(255, Math.max(0, Math.round(numeric[2]!))), a: alpha === undefined ? 1 : Math.min(1, Math.max(0, alpha))};
}
/** The system symbols stay readable on whatever color the page reports: this is
 * derived from the real pixel color, not mirrored from a web token. */
export function windowsTitleBarSymbolColor(background: string): string {
  const rgba = parseColor(background);
  if (!rgba) throw new RangeError('Unsupported title bar background color');
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(rgba.r) + 0.7152 * linear(rgba.g) + 0.0722 * linear(rgba.b);
  return luminance > 0.42 ? '#191C1F' : '#ECEDEF';
}
export function windowsTitleBarOverlay(background: string): WindowTitleBarOverlay {
  if (!isTitleBarBackgroundColor(background)) throw new RangeError('Unsupported title bar background color');
  return Object.freeze({color: background, symbolColor: windowsTitleBarSymbolColor(background), height: WINDOWS_WINDOW_CHROME.topbarHeight});
}
export function windowChromeOptions(platform: NodeJS.Platform = process.platform, background?: string): WindowChromeOptions {
  if (platform === 'darwin') return {titleBarStyle: 'hidden', trafficLightPosition: {...MAC_TRAFFIC_LIGHT_POSITION}};
  if (platform === 'win32' && typeof background === 'string' && isTitleBarBackgroundColor(background)) {
    return {titleBarStyle: 'hidden', titleBarOverlay: windowsTitleBarOverlay(background)};
  }
  return {};
}

type ChromeEvents = Pick<EventEmitter, 'on' | 'once' | 'removeListener'>;

interface ChromeWindow extends ChromeEvents {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setWindowButtonVisibility(visible: boolean): void;
  setWindowButtonPosition(position: {x: number; y: number}): void;
  setTitleBarOverlay?(options: WindowTitleBarOverlay): void;
  webContents: ChromeEvents & {
    readonly mainFrame: object;
    isDestroyed(): boolean;
    send(channel: string, fullscreen: boolean): void;
  };
}

/** AppKit can replace the initial inset when the native window is shown. */
export function installWindowChrome(window: ChromeWindow, platform: NodeJS.Platform = process.platform): () => void {
  if (platform === 'win32') return installWindowsWindowChrome(window);
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

/** Bounded diagnostics for the screenshot smoke: how many page colors reached
 * the native band and which one was painted last. */
const windowsChromeDiagnostics = new WeakMap<object, {received: number; lastReceived: string | undefined; applied: string | undefined; error: string | undefined}>();
export function windowsTitleBarDiagnostics(window: object): {received: number; lastReceived: string | undefined; applied: string | undefined; error: string | undefined} | undefined {
  return windowsChromeDiagnostics.get(window);
}

/** The page reports the rendered color behind the system caption band; only the
 * focused window's main frame may repaint its own native band. */
function installWindowsWindowChrome(window: ChromeWindow): () => void {
  const contents = window.webContents;
  let disposed = false;
  let lastColor: string | undefined;
  const diagnostics = {received: 0, lastReceived: undefined as string | undefined,
    applied: undefined as string | undefined, error: undefined as string | undefined};
  windowsChromeDiagnostics.set(window, diagnostics);
  const paint = (): void => {
    if (disposed || window.isDestroyed() || contents.isDestroyed() || typeof window.setTitleBarOverlay !== 'function') return;
    try {window.setTitleBarOverlay(windowsTitleBarOverlay(lastColor!)); diagnostics.applied = lastColor;}
    catch (error) {diagnostics.error = String((error as Error)?.message ?? error).slice(0, 80);}
  };
  const receiveColor = (event: {senderFrame: object | null}, channel: string, ...args: unknown[]): void => {
    if (disposed || window.isDestroyed() || contents.isDestroyed() || channel !== DESKTOP_TITLEBAR_COLOR_EVENT ||
        event.senderFrame !== contents.mainFrame || args.length !== 1 || !isTitleBarBackgroundColor(args[0]) ||
        typeof window.setTitleBarOverlay !== 'function' || args[0] === lastColor) return;
    lastColor = args[0];
    diagnostics.received += 1;
    diagnostics.lastReceived = lastColor;
    paint();
  };
  contents.on('ipc-message', receiveColor);
  // Windows can apply the stored overlay without repainting if the first update
  // lands before the window is visibly active; repaint on activation.
  const repaint = (): void => {if (lastColor !== undefined) paint();};
  window.on('focus', repaint);
  window.on('show', repaint);
  const dispose = () => {
    disposed = true;
    contents.removeListener('ipc-message', receiveColor);
    window.removeListener('focus', repaint);
    window.removeListener('show', repaint);
    window.removeListener('closed', dispose);
  };
  window.once('closed', dispose);
  return dispose;
}
