import {macWindowChrome, WINDOWS_WINDOW_CHROME} from '../../../packages/contracts/src/desktop-window-chrome.ts';

export type DesktopFrame = 'mac-inset' | 'win-overlay';

/** The subset of the Window Controls Overlay API the desktop shell consumes. */
export interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): { readonly right: number };
  addEventListener?(type: 'geometrychange', listener: () => void): void;
}

type FrameRoot = Pick<HTMLElement, 'dataset' | 'style'>;

function overlayApi(): WindowControlsOverlayLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const overlay = (navigator as Navigator & {windowControlsOverlay?: WindowControlsOverlayLike}).windowControlsOverlay;
  return overlay && typeof overlay.getTitlebarAreaRect === 'function' ? overlay : undefined;
}

export function desktopFrame(userAgent: string = '', overlay: WindowControlsOverlayLike | undefined = overlayApi()): DesktopFrame | null {
  if (!/\bElectron\//.test(userAgent)) return null;
  if (/\bMacintosh\b/.test(userAgent)) return 'mac-inset';
  // Windows always uses the hidden title bar with the native overlay; the
  // overlay API only supplies the current button width at runtime.
  if (/\bWindows\b/.test(userAgent)) return 'win-overlay';
  return null;
}

/** Space the OS paints its window buttons in, derived from the live titlebar
 * area rect. This is deliberately not a local constant. */
export function windowsTitleBarTrailingInset(overlay: WindowControlsOverlayLike, viewportWidth: number, uiScale = 1): number {
  if (overlay.visible !== true) return 0;
  try {
    const inset = viewportWidth - overlay.getTitlebarAreaRect().right;
    if (!Number.isFinite(inset) || !Number.isFinite(uiScale) || uiScale <= 0) return 0;
    // `--win-titlebar-trailing` is consumed inside the zoomed shell, so keep the
    // reserved width in layout pixels for the current UI scale.
    return Math.max(0, inset) / uiScale;
  } catch {
    return 0;
  }
}

export function applyDesktopFrame(root: FrameRoot, userAgent: string = '', scale = 1,
  overlay: WindowControlsOverlayLike | undefined = overlayApi(), viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth): void {
  const frame = desktopFrame(userAgent, overlay);
  if (!frame) return;
  const uiScale = isDesktopUiScale(scale) ? scale : 1;
  root.dataset.desktopFrame = frame;
  if (frame === 'mac-inset') {
    const chrome = macWindowChrome(uiScale);
    root.style.setProperty('--wb-topbar', `${chrome.topbarHeight}px`);
    root.style.setProperty('--mac-titlebar-inset', `${chrome.leadingInset}px`);
    root.style.setProperty('--mac-titlebar-gap', `${chrome.gap}px`);
    return;
  }
  root.style.setProperty('--wb-topbar', `${WINDOWS_WINDOW_CHROME.topbarHeight}px`);
  const apply = () => {
    const width = typeof window === 'undefined' || typeof window.innerWidth !== 'number' ? viewportWidth : window.innerWidth;
    const trailing = overlay ? windowsTitleBarTrailingInset(overlay, width, uiScale) : 0;
    root.style.setProperty('--win-titlebar-trailing', `${trailing}px`);
  };
  apply();
  overlay?.addEventListener?.('geometrychange', apply);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', apply);
}

function isDesktopUiScale(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.9 && value <= 1.25;
}
