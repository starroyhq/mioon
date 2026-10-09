export const COOKIE_NAME = 'wb_session';

export function trustedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Backend must use an ephemeral IPv4 loopback origin');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid backend port');
  return url.origin;
}

export function isSameOrigin(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

export function isAllowedNavigation(value, origin) {
  if (!isSameOrigin(value, origin)) return false;
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  return url.pathname === '/' && !url.hash && (keys.length === 0 ||
    (keys.length === 1 && keys[0] === 'project' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('project'))));
}

export function isAllowedRequest(value, origin) {
  if (isSameOrigin(value, origin)) return true;
  // Blob URLs are origin-bound and used only for in-memory media previews.
  try { const url = new URL(value); return url.protocol === 'blob:' && url.origin === origin; }
  catch { return false; }
}

export function isAllowedDownload(value, origin) {
  if (!isSameOrigin(value, origin)) return false;
  const url = new URL(value);
  return /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname) &&
    [...url.searchParams.keys()].every(key => key === 'download') && !url.hash;
}

export function secureWebPreferences(session) {
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
    // No preload and no renderer IPC bridge: the shared UI uses only same-origin HTTP.
  };
}

export function sessionCookie(origin, token) {
  trustedOrigin(origin);
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid session token');
  return { url: origin, name: COOKIE_NAME, value: token, path: '/', secure: true,
    httpOnly: true, sameSite: 'strict' };
}

export function installSessionPolicy(session, origin, getWindow, { downloadsPath }) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.on('will-download', (event, item, webContents) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || webContents !== win.webContents ||
        !isAllowedNavigation(webContents.getURL(), origin) ||
        !item.getURLChain().every(url => isAllowedDownload(url, origin)) ||
        !isAllowedDownload(item.getURL(), origin) || item.getMimeType() !== 'video/mp4') {
      event.preventDefault();
      return;
    }
    // No automatic path writes: Chromium shows its native Save As / overwrite dialog.
    item.setSaveDialogOptions({ title: '保存视频', defaultPath: downloadsPath,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }], properties: ['showOverwriteConfirmation'] });
  });
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === 'subFrame' || !isAllowedRequest(details.url, origin) }));
}

export function installWindowPolicy(win, origin) {
  const contents = win.webContents;
  const blockNavigation = (event, target) => { if (!isAllowedNavigation(event.url || target, origin)) event.preventDefault(); };
  contents.on('will-navigate', blockNavigation);
  contents.on('will-redirect', blockNavigation);
  contents.on('will-frame-navigate', event => {
    // Subframes are never needed, including same-origin frames.
    if (!event.isMainFrame || !isAllowedNavigation(event.url, origin)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
