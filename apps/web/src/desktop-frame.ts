// The desktop host on macOS hides the native title bar and insets the window
// controls into the top bar (apps/desktop/src/window-chrome.ts). The renderer
// keeps this presentation-only shell detection in its user agent; ordinary
// browsers and the other desktop platforms keep their default frame.
export function desktopFrame(userAgent: string = ''): 'mac-inset' | null {
  return /\bElectron\//.test(userAgent) && /\bMacintosh\b/.test(userAgent) ? 'mac-inset' : null;
}
