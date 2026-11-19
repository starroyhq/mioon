import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWindowsProjectVolumeReader} from '../packages/node-host/src/windows-project-volume.ts';
import type {WindowsStorageNative} from '../packages/node-host/src/windows-private-storage.ts';

const windowsOnly = process.platform === 'win32';
function native(): WindowsStorageNative {
  const require = createRequire(import.meta.url);
  return require('../packages/node-host/build/Release/mioon_private_storage.node') as WindowsStorageNative;
}
async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-windows-volume-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
test('the native helper reports NTFS fixed-volume facts for a real temporary directory', async t => {
  if (!windowsOnly) return;
  const directory = await root(t), read = createWindowsProjectVolumeReader(native());
  const facts = await read(directory);
  assert.equal(facts.fileSystem.toLowerCase(), 'ntfs');
  assert.equal(facts.isLocal, true);
  assert.equal(facts.volumeReadOnly, false);
  assert.equal(facts.permissionBits, true);
  assert.equal(facts.placeholder, false);
});
test('spaces, Unicode and not-yet-existing leaves probe the existing parent volume', async t => {
  if (!windowsOnly) return;
  const directory = await root(t), read = createWindowsProjectVolumeReader(native());
  const leaf = path.join(directory, '项目 Film', 'Not Created', 'Film.mioon');
  const facts = await read(leaf);
  assert.equal(facts.fileSystem.toLowerCase(), 'ntfs');
  assert.equal(facts.isLocal, true);
});
test('extended-length prefixes are accepted and device paths fail closed', async t => {
  if (!windowsOnly) return;
  const directory = await root(t), read = createWindowsProjectVolumeReader(native());
  const long = '\\\\?\\' + directory + '\\' + 'd'.repeat(120) + '\\' + 'd'.repeat(120) + '\\Film.mioon';
  assert.equal((await read(long)).fileSystem.toLowerCase(), 'ntfs');
  await assert.rejects(async () => read('\\\\.\\pipe\\mioon'), error => (error as {code?: unknown}).code === 'PROJECT_LOCATION_INVALID');
  await assert.rejects(async () => read('relative\\Film.mioon'), error => (error as {code?: unknown}).code === 'PROJECT_LOCATION_INVALID');
});
test('a helper without the reviewed entry fails closed instead of guessing', async () => {
  assert.throws(() => createWindowsProjectVolumeReader({apiVersion: 1} as WindowsStorageNative));
  if (!windowsOnly) return;
  assert.throws(() => createWindowsProjectVolumeReader({...native(), projectVolumeFacts: undefined}));
});
