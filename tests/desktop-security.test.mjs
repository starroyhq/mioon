import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { trustedOrigin, isAllowedNavigation, isAllowedRequest, isAllowedDownload, secureWebPreferences,
  sessionCookie, installSessionPolicy, installWindowPolicy } from '../apps/desktop/src/security.mjs';

const origin = 'http://127.0.0.1:41923';
const id = '12345678-1234-4234-8234-123456789abc';

test('desktop accepts only an explicit IPv4 loopback HTTP backend', () => {
  assert.equal(trustedOrigin(origin), origin);
  for (const url of ['http://localhost:41923', 'https://127.0.0.1:41923', 'http://evil.example:41923',
    'http://127.0.0.1', `${origin}/api`, `${origin}?token=x`, `http://user@127.0.0.1:41923`]) assert.throws(() => trustedOrigin(url));
});

test('desktop navigation supports only root and shared-UI project deep link', () => {
  assert.equal(isAllowedNavigation(`${origin}/`, origin), true);
  assert.equal(isAllowedNavigation(`${origin}/?project=${id}`, origin), true);
  for (const url of [`${origin}/media/${id}`, `${origin}/?token=secret`, `${origin}/?project=${id}&x=y`,
    `${origin}/?project=${id}&project=${id}`, `${origin}/?project=bad`, `${origin}/#x`, 'javascript:alert(1)',
    'file:///etc/passwd', 'https://example.com', 'http://127.0.0.1:41924/']) assert.equal(isAllowedNavigation(url, origin), false, url);
});

test('desktop request policy prevents credential leakage to any other origin', () => {
  assert.equal(isAllowedRequest(`${origin}/api/rpc`, origin), true);
  assert.equal(isAllowedRequest(`blob:${origin}/${id}`, origin), true);
  for (const url of ['https://example.com', 'file:///tmp/test', 'http://localhost:41923/api', 'http://127.0.0.1:41924/',
    'blob:https://example.com/id', 'data:text/html,hello']) assert.equal(isAllowedRequest(url, origin), false);
});

test('downloads are only UUID managed media on the current backend', () => {
  assert.equal(isAllowedDownload(`${origin}/media/${id}`, origin), true);
  assert.equal(isAllowedDownload(`${origin}/media/${id}?download`, origin), true);
  for (const url of [`${origin}/media/../../secret`, `${origin}/media/${id}?path=/tmp`, `${origin}/media/${id}#x`,
    `${origin}/assets/app.js`, `https://example.com/media/${id}`, `file:///media/${id}`]) assert.equal(isAllowedDownload(url, origin), false);
});

test('renderer preferences expose neither Node nor an IPC preload', () => {
  const session = {}, prefs = secureWebPreferences(session);
  assert.equal(prefs.session, session);
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(prefs[key], true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag',
    'allowRunningInsecureContent', 'experimentalFeatures', 'devTools']) assert.equal(prefs[key], false);
  assert.equal('preload' in prefs, false);
});

test('cookie is Secure HttpOnly SameSite Strict without disk expiration', () => {
  const cookie = sessionCookie(origin, 'a'.repeat(64));
  assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict'); assert.equal(cookie.path, '/');
  assert.equal('expirationDate' in cookie, false); assert.equal('domain' in cookie, false);
  assert.throws(() => sessionCookie(origin, 'short'));
});

function fakeSession() {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = handler => { session.permission = handler; };
  session.setPermissionCheckHandler = handler => { session.permissionCheck = handler; };
  session.setDevicePermissionHandler = handler => { session.device = handler; };
  session.setDisplayMediaRequestHandler = handler => { session.display = handler; };
  session.webRequest = { onBeforeRequest: handler => { session.beforeRequest = handler; } };
  return session;
}

test('session rejects permissions, subframes, and external requests', () => {
  const session = fakeSession();
  installSessionPolicy(session, origin, () => null, { downloadsPath: '/tmp/video.mp4' });
  session.permission({}, 'camera', allowed => assert.equal(allowed, false));
  assert.equal(session.permissionCheck(), false); assert.equal(session.device(), false);
  session.display({}, result => assert.deepEqual(result, {}));
  session.beforeRequest({ url: `${origin}/`, resourceType: 'subFrame' }, result => assert.equal(result.cancel, true));
  session.beforeRequest({ url: `${origin}/api/rpc`, resourceType: 'xhr' }, result => assert.equal(result.cancel, false));
});

test('native export permits project query but never assigns an automatic save path', () => {
  const session = fakeSession(), contents = { getURL: () => `${origin}/?project=${id}` };
  const win = { isDestroyed: () => false, webContents: contents };
  installSessionPolicy(session, origin, () => win, { downloadsPath: '/tmp/video.mp4' });
  let options, cancelled = false;
  const item = { getURLChain: () => [`${origin}/media/${id}`], getURL: () => `${origin}/media/${id}`, getMimeType: () => 'video/mp4',
    setSaveDialogOptions: value => { options = value; }, setSavePath: () => assert.fail('Must show native Save As') };
  session.emit('will-download', { preventDefault: () => { cancelled = true; } }, item, contents);
  assert.equal(cancelled, false); assert.equal(options.defaultPath, '/tmp/video.mp4');
  item.getURLChain = () => ['https://example.com/file', `${origin}/media/${id}`];
  session.emit('will-download', { preventDefault: () => { cancelled = true; } }, item, contents);
  assert.equal(cancelled, true);
});

test('window blocks webviews, popups, subframes and navigations', () => {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = handler => { contents.open = handler; };
  installWindowPolicy({ webContents: contents }, origin);
  assert.deepEqual(contents.open({ url: 'https://example.com' }), { action: 'deny' });
  let blocked = 0;
  contents.emit('will-navigate', { url: 'https://example.com', preventDefault: () => blocked++ });
  contents.emit('will-frame-navigate', { url: `${origin}/`, isMainFrame: false, preventDefault: () => blocked++ });
  contents.emit('will-attach-webview', { preventDefault: () => blocked++ });
  contents.emit('will-frame-navigate', { url: `${origin}/?project=${id}`, isMainFrame: true, preventDefault: () => assert.fail('valid main navigation blocked') });
  assert.equal(blocked, 3);
});

test('package configuration disables runtime injection and cannot publish by default', async () => {
  const require = createRequire(import.meta.url), config = require('../apps/desktop/electron-builder.cjs');
  assert.equal(config.asar, true); assert.equal(config.publish, null);
  assert.ok(config.files.includes('!node_modules/**/*'));
  assert.equal(config.electronFuses.runAsNode, false);
  assert.equal(config.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(config.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(config.electronFuses.grantFileProtocolExtraPrivileges, false);
  const main = await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  assert.ok(main.includes('app.enableSandbox()'));
  assert.ok(!main.includes('no-sandbox'));
  assert.ok(!main.includes('shell.openExternal'));
  assert.ok(!main.includes('ipcMain'));
});
