import {macWindowChrome} from '../../../packages/contracts/src/desktop-window-chrome.ts';

export function desktopFrame(userAgent: string = ''): 'mac-inset' | null {
  return /\bElectron\//.test(userAgent) && /\bMacintosh\b/.test(userAgent) ? 'mac-inset' : null;
}

export function applyDesktopFrame(root: Pick<HTMLElement, 'dataset' | 'style'>, userAgent: string, scale = 1): void {
  const frame = desktopFrame(userAgent);
  if (!frame) return;
  const chrome = macWindowChrome(scale);
  root.dataset.desktopFrame = frame;
  root.style.setProperty('--wb-topbar', `${chrome.topbarHeight}px`);
  root.style.setProperty('--mac-titlebar-inset', `${chrome.leadingInset}px`);
  root.style.setProperty('--mac-titlebar-gap', `${chrome.gap}px`);
}
