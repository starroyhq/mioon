import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectLocationHelp} from '../apps/desktop/src/project-location-help.ts';

test('the macOS permission help opens only Files and Folders without a caller-controlled URL', async () => {
  const opened: string[] = [];
  const help = createProjectLocationHelp({platform: 'darwin', openExternal: async url => {opened.push(url);}, showItemInFolder: () => assert.fail()});
  await help.openPrivacySettings();
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders']);
});

test('a failed permission pane falls back once to the fixed System Settings home', async () => {
  const opened: string[] = [];
  const help = createProjectLocationHelp({platform: 'darwin', openExternal: async url => {opened.push(url); if (opened.length === 1) throw new Error('Native handler failed');}, showItemInFolder: () => assert.fail()});
  await help.openPrivacySettings();
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders', 'x-apple.systempreferences:']);
});

test('unavailable system help returns a fixed error without exposing native paths or errors', async () => {
  let calls = 0;
  const help = createProjectLocationHelp({platform: 'darwin', openExternal: async () => {calls++; throw new Error('/private/native/user-data');}, showItemInFolder: () => assert.fail()});
  await assert.rejects(help.openPrivacySettings(), {code: 'PROJECT_LOCATION_HELP_UNAVAILABLE', message: 'Project location help is unavailable.'});
  assert.equal(calls, 2);
});

test('non-macOS help cannot route to another scheme or request broader disk permission', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const help = createProjectLocationHelp({platform, openExternal: async () => assert.fail(), showItemInFolder: () => assert.fail()});
    await assert.rejects(help.openPrivacySettings(), {code: 'PROJECT_LOCATION_HELP_UNAVAILABLE'});
  }
});

test('reveal passes a verified absolute path to the native API without interpreting spaces or shell metacharacters', () => {
  const revealed: string[] = [], file = '/synthetic/已登记项目/片段 $(literal).mioon';
  const help = createProjectLocationHelp({openExternal: async () => assert.fail(), showItemInFolder: value => {revealed.push(value);}});
  help.revealVerifiedPath(file); assert.deepEqual(revealed, [file]);
});

test('reveal rejects noncanonical paths and sanitizes native failures', () => {
  let calls = 0;
  const help = createProjectLocationHelp({openExternal: async () => assert.fail(), showItemInFolder: () => {calls++; throw new Error('/private/native/user-data');}});
  for (const file of ['', 'relative.mioon', '/synthetic/../private.mioon', '/synthetic//project.mioon', '/synthetic/project\0.mioon', '/synthetic/project\n.mioon', '/'+ 'x'.repeat(4096)]) {
    assert.throws(() => help.revealVerifiedPath(file), {code: 'PROJECT_LOCATION_HELP_UNAVAILABLE'});
  }
  assert.equal(calls, 0);
  assert.throws(() => help.revealVerifiedPath('/synthetic/project.mioon'), {code: 'PROJECT_LOCATION_HELP_UNAVAILABLE', message: 'Project location help is unavailable.'});
  assert.equal(calls, 1);
});
