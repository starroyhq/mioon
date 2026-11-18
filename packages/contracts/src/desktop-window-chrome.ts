const topbarHeight = 44;
const controlGroupWidth = 62;
const controlHeight = 16;
const controlOutset = 1;
const gap = 12;

export function isDesktopChromeScale(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.9 && value <= 1.25;
}

/** Native controls retain their measured screen-point size as the page scales. */
export function macWindowChrome(scale = 1) {
  if (!isDesktopChromeScale(scale)) throw new RangeError('Desktop chrome scale is outside the supported range');
  const controlInset = Math.round((topbarHeight * scale - controlHeight) / 2);
  return Object.freeze({
    topbarHeight,
    controlGroupWidth,
    controlHeight,
    controlOutset,
    gap,
    // AX hit bounds extend beyond Electron's positioning anchor.
    position: Object.freeze({x: controlInset + controlOutset, y: controlInset + controlOutset}),
    leadingInset: (controlInset + controlGroupWidth) / scale + gap,
  });
}

export const MAC_WINDOW_CHROME = macWindowChrome();

export const DESKTOP_FULLSCREEN_EVENT = 'mioon:window-chrome:fullscreen:v1';
export const DESKTOP_CHROME_SCALE_EVENT = 'mioon:window-chrome:scale:v1';

/** Windows reuses the measured top bar height for the native overlay band. The
 * window button width is not a local constant: the renderer reserves whatever
 * the OS overlay reports at runtime. */
export const WINDOWS_WINDOW_CHROME = Object.freeze({topbarHeight});

/** Mirrors the web tokens `--wb-panel`/`--wb-text` so the system-painted window
 * buttons sit on the same background as the custom top bar. */
const windowsTitleBarPalette = Object.freeze({
  dark: Object.freeze({color: '#141518', symbolColor: '#ECEDEF'}),
  light: Object.freeze({color: '#FFFFFF', symbolColor: '#191C1F'}),
});
export type WindowsTitleBarAppearance = keyof typeof windowsTitleBarPalette;

export function windowsTitleBarOverlay(appearance: WindowsTitleBarAppearance) {
  const palette = windowsTitleBarPalette[appearance];
  return Object.freeze({color: palette.color, symbolColor: palette.symbolColor, height: WINDOWS_WINDOW_CHROME.topbarHeight});
}
