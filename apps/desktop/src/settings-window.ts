interface SettingsParent {
  isDestroyed(): boolean;
  getContentBounds(): {x: number; y: number; width: number; height: number};
}

/** Size the settings panel inside its actual opener, including small displays.
 * Electron's native modal relation owns input restriction and macOS sheets. */
export function settingsWindowOptions<W extends SettingsParent>(parent: W | undefined) {
  if (!parent || parent.isDestroyed()) throw new Error('Settings require a live parent window');
  const bounds = parent.getContentBounds();
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Settings parent bounds are unavailable');
  }
  const width = Math.max(1, Math.min(1000, Math.floor(bounds.width - 64)));
  const height = Math.max(1, Math.min(720, Math.floor(bounds.height - 64)));
  return {
    parent, modal: true, show: false, width, height,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    minWidth: Math.min(760, width), minHeight: Math.min(520, height),
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true,
  };
}
