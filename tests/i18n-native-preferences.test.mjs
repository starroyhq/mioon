import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat, writeFile, symlink, chmod } from 'node:fs/promises';
import { readAppLanguagePreference, writeAppLanguagePreference, validateDesktopStorage, storageFailureDialog,
  writeConnection, removeConnection, removeConnectionOnShutdown } from '../apps/desktop/src/config.ts';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { setNativeLanguageReader, nativeText } from '../apps/desktop/src/app-language-text.ts';
import { configureTimelineDeliveryDownload } from '../apps/desktop/src/timeline-delivery-download.ts';

const local = async action => { const root = await mkdtemp(path.join(os.tmpdir(), 'mioon-language-')); try { await action({ userData: root, dataDir: path.join(root, 'workspace'), configFile: path.join(root, 'desktop-config.json') }); } finally { await rm(root, { recursive: true, force: true }); } };
test('real private preference file survives restart independently of tools and projects', () => local(async paths => {
  await writeFile(paths.configFile, JSON.stringify({ ffmpeg: '/owned/ffmpeg', ffprobe: '/owned/ffprobe' }), { mode: 0o600 });
  const before = await readFile(paths.configFile); const options = { systemLanguages: () => ['en'], isTrusted: () => true, broadcast() {}, storage: { read: () => readAppLanguagePreference(paths), write: text => writeAppLanguagePreference(paths, text) } };
  const host = createAppLanguageHost(options); host.dispatch({}, { action: 'set', preference: 'zh-Hant' });
  const file = path.join(paths.userData, 'app-preferences.json'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, preference: 'zh-Hant' }); assert.equal(createAppLanguageHost(options).snapshot().locale, 'zh-Hant');
  assert.deepEqual(await readFile(paths.configFile), before); await assert.rejects(stat(paths.dataDir), { code: 'ENOENT' });
}));
test('all manual languages and system preference survive real connection cleanup, quit and restart', () => local(async paths => {
  const file = path.join(paths.userData, 'app-preferences.json');
  const options = { systemLanguages: () => ['ja-JP'], isTrusted: () => true, broadcast() {}, storage: {
    read: () => readAppLanguagePreference(paths), write: text => writeAppLanguagePreference(paths, text),
  } };
  for (const preference of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'system']) {
    const host = createAppLanguageHost(options);
    assert.equal(host.dispatch({}, { action: 'set', preference }).persistence, 'saved');
    const before = await readFile(file);
    for (const cleanup of [removeConnection, removeConnectionOnShutdown]) {
      await writeConnection(paths, { url: 'http://127.0.0.1:12345', token: 'synthetic-test-token', pid: 12345 });
      await cleanup(paths);
      for (const name of ['mcp-token', 'mcp-connection.json']) await assert.rejects(stat(path.join(paths.userData, name)), { code: 'ENOENT' });
      assert.deepEqual(await readFile(file), before, 'cleanup preserves the exact persistent preference bytes');
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const restarted = createAppLanguageHost(options).snapshot();
      assert.equal(restarted.preference, preference);
      assert.equal(restarted.locale, preference === 'system' ? 'ja' : preference);
      assert.equal(restarted.persistence, 'saved');
    }
  }
  await assert.rejects(stat(paths.dataDir), { code: 'ENOENT' });
}));
test('failed preference reads remain visible and never overwrite the persisted document', () => local(async paths => {
  const file = path.join(paths.userData, 'app-preferences.json');
  const options = { systemLanguages: () => ['en'], isTrusted: () => true, broadcast() {}, storage: {
    read: () => readAppLanguagePreference(paths), write: text => writeAppLanguagePreference(paths, text),
  } };
  await writeFile(file, '{broken synthetic preference', { mode: 0o600 });
  const before = await readFile(file);
  const host = createAppLanguageHost(options);
  assert.equal(host.snapshot().persistence, 'read-failed');
  assert.equal(host.dispatch({}, { action: 'read' }).persistence, 'read-failed');
  await removeConnectionOnShutdown(paths);
  assert.deepEqual(await readFile(file), before);
  assert.equal(createAppLanguageHost(options).snapshot().persistence, 'read-failed');
}));
test('unsafe preference permissions are preserved and session-only writes are explicit', { skip: process.platform === 'win32' }, () => local(async paths => {
  const file = path.join(paths.userData, 'app-preferences.json');
  writeAppLanguagePreference(paths, '{"version":1,"preference":"zh-Hant"}\n');
  const before = await readFile(file); await chmod(file, 0o644);
  const options = { systemLanguages: () => ['en'], isTrusted: () => true, broadcast() {}, storage: {
    read: () => readAppLanguagePreference(paths), write: text => writeAppLanguagePreference(paths, text),
  } };
  const host = createAppLanguageHost(options);
  assert.equal(host.snapshot().persistence, 'read-failed');
  assert.equal(host.dispatch({}, { action: 'set', preference: 'ja' }).persistence, 'session');
  assert.equal(host.snapshot().locale, 'ja');
  await removeConnectionOnShutdown(paths);
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.equal(createAppLanguageHost(options).snapshot().persistence, 'read-failed');
}));
test('linked or public preference file is rejected without repairing it', () => local(async paths => {
  const file = path.join(paths.userData, 'app-preferences.json'), target = path.join(paths.userData, 'untouched.json');
  await writeFile(target, 'untouched', { mode: 0o600 }); await symlink(target, file);
  assert.throws(() => validateDesktopStorage(paths)); assert.throws(() => writeAppLanguagePreference(paths, '{"version":1,"preference":"en"}'));
  assert.equal(await readFile(target, 'utf8'), 'untouched'); await rm(file); await writeFile(file, '{"version":1,"preference":"en"}', { mode: 0o600 }); await chmod(file, 0o644);
  assert.throws(() => validateDesktopStorage(paths)); assert.equal((await stat(file)).mode & 0o777, 0o644);
}));
test('native warnings change language while keeping cancellation defaults and privacy meaning', () => {
  try {
    for (const [locale, title] of [['zh-Hans', '无法安全启动 Mioon'], ['zh-Hant', '無法安全啟動 Mioon'], ['en', 'Cannot start Mioon safely'], ['ja', 'Mioon を安全に起動できません']]) {
      setNativeLanguageReader(() => locale); const dialog = storageFailureDialog({ code: 'STORAGE_PRIVACY_UNAVAILABLE' });
      assert.equal(dialog.title, title); assert.equal(dialog.defaultId, 0); assert.equal(dialog.cancelId, 0); assert.match(dialog.detail, /ACL/u); assert.match(dialog.detail, /0600\/0700/u);
      assert.equal(typeof nativeText('native.unknownDetail'), 'string'); assert.equal(dialog.buttons.length, 1);
    }
  } finally { setNativeLanguageReader(() => 'zh-Hans'); }
});
test('native Save As localizes app-owned labels without changing output filenames or overwrite confirmation', () => {
  const origin = 'http://127.0.0.1:49152', url = `${origin}/media/11111111-1111-4111-8111-111111111111`;
  const webContents = { getURL: () => origin }, window = { isDestroyed: () => false, webContents };
  try {
    for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
      setNativeLanguageReader(() => locale); let options;
      const item = { getInitiatorOrigin: () => origin, getMimeType: () => 'video/mp4', getURL: () => url,
        getURLChain: () => [url], getContentDisposition: () => '', setSaveDialogOptions: value => { options = value; } };
      configureTimelineDeliveryDownload({ preventDefault: () => assert.fail('synthetic trusted download must remain available') },
        item, webContents, window, origin, { downloadsPath: '/tmp/用户作品.mp4' }, value => value === origin);
      assert.equal(options.title, nativeText('native.saveVideo')); assert.equal(options.buttonLabel, nativeText('native.saveVideo'));
      assert.equal(options.filters[0].name, nativeText('native.mp4Video')); assert.deepEqual(options.filters[0].extensions, ['mp4']);
      assert.equal(options.defaultPath, '/tmp/用户作品.mp4'); assert.deepEqual(options.properties, ['showOverwriteConfirmation']);
    }
  } finally { setNativeLanguageReader(() => 'zh-Hans'); }
});
