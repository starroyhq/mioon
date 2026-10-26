import path from 'node:path';

export type TrayAction = 'show' | 'hide' | 'new-project' | 'open-project' | 'settings' | 'quit';
export interface TrayMenuItem {
  readonly label?: string;
  readonly type?: 'separator';
  readonly enabled?: boolean;
  readonly click?: () => void;
}
interface TrayImage { isEmpty(): boolean; setTemplateImage(value: boolean): void }
interface NativeTray<Menu> {
  isDestroyed(): boolean;
  destroy(): void;
  setToolTip(value: string): void;
  setContextMenu(menu: Menu): void;
  on(event: 'click', listener: () => void): unknown;
  removeListener(event: 'click', listener: () => void): unknown;
}
interface TrayLabels {
  readonly show: string; readonly hide: string; readonly newProject: string;
  readonly openProject: string; readonly settings: string; readonly quit: string;
}
interface TrayOptions<Image extends TrayImage, Menu> {
  readonly platform: NodeJS.Platform;
  readonly iconDirectory: string;
  readonly productName: string;
  loadImage(file: string): Image;
  createTray(image: Image): NativeTray<Menu>;
  createMenu(items: TrayMenuItem[]): Menu;
  labels(): TrayLabels;
  canInteract(action: TrayAction): boolean;
  canHide(): boolean;
  onAction(action: TrayAction): unknown | Promise<unknown>;
  /** If a usable tray is lost, restore the retained UI before allowing hide. */
  onUnavailable?(): void;
}

/** Application-owned, independent of any backend/window epoch. Menu callbacks
 * read live guards; a menu opened before Quit cannot revive an old window. */
export function createDesktopTray<Image extends TrayImage, Menu>(options: TrayOptions<Image, Menu>) {
  let tray: NativeTray<Menu> | null = null, disposed = false;
  const available = () => !disposed && tray !== null && !tray.isDestroyed();
  const interactive = (action: TrayAction) => { try { return options.canInteract(action) === true; } catch { return false; } };
  const canHide = () => { try { return options.canHide() === true; } catch { return false; } };
  const allowed = (action: TrayAction) => available() && (action === 'quit' ||
    interactive(action) && (action !== 'hide' || canHide()));
  const invoke = (action: TrayAction) => {
    if (!allowed(action)) return;
    try { void Promise.resolve(options.onAction(action)).catch(() => {}); }
    catch { /* The existing owner handles action failures; never retry. */ }
  };
  const click = () => invoke('show');
  function dispose() {
    if (disposed) return;
    disposed = true;
    const current = tray; tray = null;
    if (!current) return;
    try { current.removeListener('click', click); } catch { /* Disposal must not interrupt the actual app exit. */ }
    try { if (!current.isDestroyed()) current.destroy(); } catch { /* No future action retains this tray. */ }
  }
  function unavailable() {
    dispose();
    try { options.onUnavailable?.(); } catch { /* No tray is not permission to hide the app. */ }
  }
  function refresh() {
    if (disposed) return;
    if (!available()) { unavailable(); return; }
    try {
      const labels = options.labels();
      const item = (action: TrayAction, label: string): TrayMenuItem => ({ label,
        enabled: action === 'quit' || interactive(action) && (action !== 'hide' || canHide()), click: () => invoke(action) });
      tray!.setToolTip(options.productName);
      tray!.setContextMenu(options.createMenu([
        item('show', labels.show), item('hide', labels.hide), {type: 'separator'},
        item('new-project', labels.newProject), item('open-project', labels.openProject), item('settings', labels.settings),
        {type: 'separator'}, item('quit', labels.quit),
      ]));
    } catch { unavailable(); }
  }
  try {
    const filename = options.platform === 'darwin' ? 'trayTemplate.png' : options.platform === 'win32' ? 'tray.ico' : 'tray-color.png';
    const image = options.loadImage(path.join(options.iconDirectory, filename));
    if (image.isEmpty()) throw new Error('Tray image is unavailable');
    if (options.platform === 'darwin') image.setTemplateImage(true);
    tray = options.createTray(image);
    // macOS presents the attached native menu itself. Windows left-click
    // restores the UI; its right-click menu is provided by setContextMenu.
    if (options.platform !== 'darwin') tray.on('click', click);
    refresh();
  } catch { unavailable(); }
  return Object.freeze({ get available() { return available(); }, refresh, dispose });
}
