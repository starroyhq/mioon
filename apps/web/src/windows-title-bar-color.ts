type ColorBridge = {setTitleBarColor?(color: unknown): void};
interface TitleBarOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): {readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly right: number};
  addEventListener?(type: 'geometrychange', listener: () => void): void;
}
declare global {
  interface Window {__mioonWindowChrome?: ColorBridge}
}

interface Rgba {r: number; g: number; b: number; a: number}

function bridge(): ColorBridge | undefined {
  const value = window.__mioonWindowChrome;
  return value && typeof value.setTitleBarColor === 'function' ? value : undefined;
}
function overlayOf(): TitleBarOverlayLike | undefined {
  const overlay = (navigator as Navigator & {windowControlsOverlay?: TitleBarOverlayLike}).windowControlsOverlay;
  return overlay && typeof overlay.getTitlebarAreaRect === 'function' ? overlay : undefined;
}
/** Parses the computed background forms Chromium can return, including the
 * wide-gamut `color(srgb ...)` serialization used for translucent colors. */
function parseCssColor(color: string): Rgba | null {
  if (!color || color === 'transparent') return {r: 0, g: 0, b: 0, a: 0};
  if (/^#[0-9a-fA-F]{3,8}$/u.test(color)) {
    const expand = (hex: string): number => Number.parseInt(hex.length === 1 ? hex + hex : hex, 16);
    if (color.length <= 5) return {r: expand(color[1]!), g: expand(color[2]!), b: expand(color[3]!), a: color.length === 5 ? expand(color[4]!) / 255 : 1};
    return {r: expand(color.slice(1, 3)), g: expand(color.slice(3, 5)), b: expand(color.slice(5, 7)), a: color.length === 9 ? expand(color.slice(7, 9)) / 255 : 1};
  }
  const legacy = /^rgba?\(([^)]*)\)$/u.exec(color);
  if (legacy) {
    const parts = legacy[1]!.split(/[,\s/]+/u).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string): number => /%$/u.test(part) ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part);
    const values = parts.slice(0, 3).map(channel);
    if (values.some(value => !Number.isFinite(value))) return null;
    const alpha = parts[3] === undefined ? 1 : (/[%]$/u.test(parts[3]!) ? Number.parseFloat(parts[3]!) / 100 : Number.parseFloat(parts[3]!));
    return {r: Math.min(255, Math.max(0, Math.round(values[0]!))), g: Math.min(255, Math.max(0, Math.round(values[1]!))),
      b: Math.min(255, Math.max(0, Math.round(values[2]!))), a: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1};
  }
  const srgb = /^color\(srgb\s+([^)]*)\)$/u.exec(color);
  if (srgb) {
    const parts = srgb[1]!.split(/[,\s/]+/u).filter(Boolean);
    if (parts.length < 3) return null;
    const values = parts.slice(0, 3).map(part => Number.parseFloat(part) * 255);
    if (values.some(value => !Number.isFinite(value))) return null;
    const alpha = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]!);
    return {r: Math.min(255, Math.max(0, Math.round(values[0]!))), g: Math.min(255, Math.max(0, Math.round(values[1]!))),
      b: Math.min(255, Math.max(0, Math.round(values[2]!))), a: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1};
  }
  return null;
}
const composite = (top: Rgba, bottom: Rgba): Rgba => {
  const alpha = top.a + bottom.a * (1 - top.a);
  if (alpha <= 0) return {r: 0, g: 0, b: 0, a: 0};
  const mix = (upper: number, lower: number): number => Math.round((upper * top.a + lower * bottom.a * (1 - top.a)) / alpha);
  return {r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: alpha};
};
const cssColor = (color: Rgba): string => `rgb(${color.r}, ${color.g}, ${color.b})`;

/** The opaque color actually rendered behind the system caption band. Walking up
 * and compositing from the element under the band means the page's own tokens
 * are the single source: no web color is mirrored into the desktop shell. */
export function windowsTitleBarBackgroundColor(viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth,
  viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight): string | null {
  if (typeof document === 'undefined' || document.documentElement.dataset.desktopFrame !== 'win-overlay') return null;
  const overlay = overlayOf();
  if (!overlay || overlay.visible !== true) return null;
  const rect = overlay.getTitlebarAreaRect();
  const bandWidth = viewportWidth - rect.right;
  if (!(rect.right > 0) || !(bandWidth > 0) || !(rect.height > 0)) return null;
  const x = Math.min(viewportWidth - 2, Math.round(rect.right + bandWidth / 2));
  const y = Math.max(1, Math.min(viewportHeight - 1, Math.round(rect.y + rect.height / 2)));
  let accumulated: Rgba | null = null;
  let node: Element | null = document.elementFromPoint(x, y);
  while (node) {
    const layer = parseCssColor(getComputedStyle(node).backgroundColor);
    if (layer && layer.a > 0) {
      accumulated = accumulated === null ? layer : composite(accumulated, layer);
      if (accumulated.a >= 0.999) return cssColor(accumulated);
    }
    node = node.parentElement;
  }
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const layer = parseCssColor(getComputedStyle(element).backgroundColor);
    if (layer && layer.a > 0) {
      accumulated = accumulated === null ? layer : composite(accumulated, layer);
      if (accumulated.a >= 0.999) return cssColor(accumulated);
    }
  }
  return accumulated === null ? null : cssColor({...accumulated, a: 1});
}

let last: string | null = null;
/** Sends the currently rendered band color. Called whenever the page appearance,
 * scale or window geometry changes; repeated colors are not repainted. */
export function reportWindowsTitleBarColor(): void {
  try {
    const target = bridge();
    if (!target?.setTitleBarColor) return;
    const color = windowsTitleBarBackgroundColor();
    if (!color || color === last) return;
    last = color;
    target.setTitleBarColor!(color);
  } catch { /* The native band keeps its last painted color. */ }
}

let installed = false;
/** Installs the cheap triggers once per document: the app's own appearance
 * effect repaints through applyDesktopFrame, while system appearance, resize,
 * focus and caption geometry changes report directly. */
export function installWindowsTitleBarColor(): void {
  if (typeof document === 'undefined' || installed || document.documentElement.dataset.desktopFrame !== 'win-overlay') return;
  installed = true;
  const report = reportWindowsTitleBarColor;
  window.addEventListener('resize', report);
  window.addEventListener('focus', report);
  window.addEventListener('pageshow', report);
  document.addEventListener('visibilitychange', report);
  overlayOf()?.addEventListener?.('geometrychange', report);
  if (typeof window.matchMedia === 'function') window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', report);
  // The control overlay can report its geometry a frame or two after the first
  // paint; retry a bounded number of times instead of waiting for a user event.
  const attempt = (remaining: number): void => {
    report();
    if (last === null && remaining > 0) setTimeout(() => attempt(remaining - 1), 250);
  };
  attempt(8);
}
