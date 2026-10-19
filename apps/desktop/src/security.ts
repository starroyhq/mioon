import {configureOwnedTimelineDeliveryDownload, timelineDownloadIdentity} from './timeline-delivery-download.ts';
import type {TimelineDownloadDirectory} from './timeline-delivery-download.ts';
import {installAssignedProjectNavigation} from './project-window-navigation.ts';
import type {AssignedProjectNavigation} from './project-window-navigation.ts';
import type {BrowserWindow, CookiesSetDetails, DownloadItem, Event, Session, WebContents} from 'electron';

export const COOKIE_NAME = 'mioon_session';

interface NavigationContents {
  readonly mainFrame: {readonly url: string};
  getURL(): string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function trustedOrigin(value: unknown): string {
  const url = new URL(value as string | URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Backend must use an ephemeral IPv4 loopback origin');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid backend port');
  return url.origin;
}

export function isSameOrigin(value: string, origin: string): boolean {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

export function isAllowedNavigation(value: string, origin: string): boolean {
  if (!isSameOrigin(value, origin)) return false;
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  return url.pathname === '/' && !url.hash && (keys.length === 0 ||
    (keys.length === 1 && keys[0] === 'project' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('project') ?? '')));
}

export function isAllowedRequest(value: string, origin: string): boolean {
  if (isSameOrigin(value, origin)) return true;
  // Blob URLs are origin-bound and used only for in-memory media previews.
  try { const url = new URL(value); return url.protocol === 'blob:' && url.origin === origin; }
  catch { return false; }
}

export function isAllowedDownload(value: string, origin: string): boolean {
  return timelineDownloadIdentity(value, origin) !== null;
}

export function secureWebPreferences(session: Session): Electron.WebPreferences {
  return {
    session,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: false
    // Main may add its fixed window-only preload; business services remain same-origin HTTP.
  };
}

export function sessionCookie(origin: string, token: string): CookiesSetDetails {
  trustedOrigin(origin);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session token');
  return { url: origin, name: COOKIE_NAME, value: token, path: '/', secure: true,
    httpOnly: true, sameSite: 'strict' };
}

export function installSessionPolicy(session: Session, origin: string, getWindow: (contents: WebContents | undefined) => BrowserWindow | null | undefined,
  downloads: TimelineDownloadDirectory): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.on('will-download', (event, item, webContents) => {
    // The actual Electron WebContents is always a full WebContents; the
    // resolver's narrowed pick only describes what download handling reads.
    const resolver = (contents: Pick<WebContents, 'getURL'> | undefined): BrowserWindow | null | undefined =>
      contents === undefined ? undefined : getWindow(contents as WebContents);
    configureOwnedTimelineDeliveryDownload(event, item, webContents, resolver, origin, downloads, isAllowedNavigation);
  });
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === 'subFrame' || !isAllowedRequest(details.url, origin) }));
}

export function installWindowPolicy(win: BrowserWindow, origin: string, assignedNavigation?: AssignedProjectNavigation): (() => void) | undefined {
  const contents = win.webContents;
  const blockNavigation = (event: Event & {readonly url?: string}, target: string) => { if (!isAllowedNavigation(event.url || target, origin)) event.preventDefault(); };
  contents.on('will-navigate', blockNavigation);
  contents.on('will-redirect', blockNavigation);
  contents.on('will-frame-navigate', event => {
    // Subframes are never needed, including same-origin frames.
    if (!event.isMainFrame || !isAllowedNavigation(event.url, origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (assignedNavigation) return installAssignedProjectNavigation(contents, assignedNavigation);
  return undefined;
}
