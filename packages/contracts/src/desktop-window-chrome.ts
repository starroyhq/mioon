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
