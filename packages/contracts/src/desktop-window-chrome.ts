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
 * the OS overlay reports at runtime. The band background is not a token either:
 * the page reports the rendered color behind the band. */
export const WINDOWS_WINDOW_CHROME = Object.freeze({topbarHeight});

/** The page reports the rendered band background; the desktop shell repaints the
 * system caption band with it. */
export const DESKTOP_TITLEBAR_COLOR_EVENT = 'mioon:window-chrome:titlebar-color:v1';
const TITLEBAR_COLOR_MAX_LENGTH = 64;
const CSS_COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?(?:\s*[,\s]\s*[\d.]+%?){0,3}(?:\s*\/\s*[\d.]+%?)?\s*\)|hsla?\(\s*[\d.]+(?:deg|rad|turn)?(?:\s*[,\s]\s*[\d.]+%?){0,3}(?:\s*\/\s*[\d.]+%?)?\s*\))$/u;

/** Only a fixed, bounded CSS color may cross from the renderer into the native
 * caption band. Shared by the preload bridge, the desktop shell and tests. */
export function isDesktopTitleBarColor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TITLEBAR_COLOR_MAX_LENGTH && CSS_COLOR_PATTERN.test(value);
}

/** Fixed capture tolerance between the painted caption band and the page
 * background beside it (per color channel, 0-255). */
export const WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE = 8;
