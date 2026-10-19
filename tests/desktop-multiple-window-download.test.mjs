import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installSessionPolicy} from '../apps/desktop/src/security.ts';

const origin = 'http://127.0.0.1:41923';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
function fixture(resolve) {
  const session = new EventEmitter();
  for (const name of ['setPermissionRequestHandler', 'setPermissionCheckHandler', 'setDevicePermissionHandler', 'setDisplayMediaRequestHandler']) session[name] = () => {};
  session.webRequest = {onBeforeRequest() {}};
  installSessionPolicy(session, origin, resolve, {downloadsDirectory: '/tmp'});
  return session;
}
function item() {
  const value = {options: null, getInitiatorOrigin: () => origin, getURLChain: () => [`${origin}/media/${a}`],
    getURL: () => `${origin}/media/${a}`, getMimeType: () => 'video/mp4',
    setSaveDialogOptions: options => {value.options = options;}, setSavePath: () => assert.fail('Native Save As must remain explicit')};
  return value;
}

test('actual session download resolves the initiating second editor, never the first or focused editor', () => {
  const first = {webContents: {getURL: () => `${origin}/?project=${a}`}, isDestroyed: () => false};
  const second = {webContents: {getURL: () => `${origin}/?project=${b}`}, isDestroyed: () => false};
  const seen = [], session = fixture(contents => {seen.push(contents); return contents === second.webContents ? second : first;});
  const download = item(); let denied = 0;
  session.emit('will-download', {preventDefault: () => denied++}, download, second.webContents);
  assert.deepEqual(seen, [second.webContents]);
  assert.equal(denied, 0);
  assert.equal(download.options.defaultPath, '/tmp/mioon.mp4');
  assert.deepEqual(download.options.properties, ['showOverwriteConfirmation']);
});

test('unknown and replaced download owners fail closed without falling back to another editor', () => {
  const contents = {getURL: () => `${origin}/?project=${b}`};
  for (const resolve of [() => null, () => ({webContents: {}, isDestroyed: () => false}),
    () => ({webContents: contents, isDestroyed: () => true}), () => {throw new Error('stale registry');}]) {
    const session = fixture(resolve), download = item(); let denied = 0;
    assert.doesNotThrow(() => session.emit('will-download', {preventDefault: () => denied++}, download, contents));
    assert.equal(denied, 1); assert.equal(download.options, null);
  }
});
