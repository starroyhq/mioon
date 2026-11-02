import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {PrivateStorageError} from '../packages/contracts/src/private-storage.ts';
import {desktopAppDirectories, projectLocation, serverAppDirectories, systemCacheDirectory} from '../apps/server/src/project-host/index.ts';

const POSIX_ONLY = {skip: process.platform === 'win32'};
function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0-host-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
const mode = (directory: string): number => statSync(directory).mode & 0o777;

test('serverAppDirectories keeps projects, records, cache and tmp in the data directory', POSIX_ONLY, () => {
  assert.deepEqual(serverAppDirectories('/srv/mioon'), {
    dataDir: '/srv/mioon', cacheDir: '/srv/mioon/cache', tempDir: '/srv/mioon/tmp', projectsDir: '/srv/mioon/projects',
  });
  assert.deepEqual(serverAppDirectories('/srv/mioon', {cacheDir: '/c', projectsDir: '/p'}), {
    dataDir: '/srv/mioon', cacheDir: '/c', tempDir: '/srv/mioon/tmp', projectsDir: '/p',
  });
  assert.equal(serverAppDirectories('/srv/mioon/').dataDir, '/srv/mioon');
  assert.throws(() => serverAppDirectories('data'), TypeError);
  assert.throws(() => serverAppDirectories('/srv/mioon', {cacheDir: 'cache'}), TypeError);
});

test('systemCacheDirectory follows each platform and ignores relative variables', () => {
  assert.equal(systemCacheDirectory({platform: 'darwin', home: '/Users/u', env: {}}), '/Users/u/Library/Caches');
  assert.equal(systemCacheDirectory({platform: 'linux', home: '/home/u', env: {XDG_CACHE_HOME: '/x/cache'}}), '/x/cache');
  assert.equal(systemCacheDirectory({platform: 'linux', home: '/home/u', env: {XDG_CACHE_HOME: 'rel'}}), '/home/u/.cache');
  assert.equal(systemCacheDirectory({platform: 'linux', home: '/home/u', env: {}}), '/home/u/.cache');
  assert.equal(systemCacheDirectory({platform: 'win32', home: 'C:\\Users\\u', env: {LOCALAPPDATA: 'D:\\Local'}}), 'D:\\Local');
  assert.equal(systemCacheDirectory({platform: 'win32', home: 'C:\\Users\\u', env: {}}), 'C:\\Users\\u\\AppData\\Local');
  assert.equal(systemCacheDirectory({platform: 'win32', home: 'C:\\Users\\u', env: {LOCALAPPDATA: 'Local'}}), 'C:\\Users\\u\\AppData\\Local');
  assert.throws(() => systemCacheDirectory({platform: 'darwin', home: 'Users/u', env: {}}), TypeError);
});

test('desktopAppDirectories puts the cache in the system cache and new projects in Videos/Mioon', () => {
  const dataDir = '/Users/u/Library/Application Support/app.starroy.mioon/data';
  const mac = {platform: 'darwin', home: '/Users/u', env: {}, appId: 'app.starroy.mioon', dataDir, videosDir: '/Users/u/Movies', userDataOverridden: false};
  assert.deepEqual(desktopAppDirectories(mac), {
    dataDir, cacheDir: '/Users/u/Library/Caches/app.starroy.mioon', tempDir: `${dataDir}/tmp`, projectsDir: '/Users/u/Movies/Mioon',
  });
  assert.deepEqual(desktopAppDirectories({...mac, userDataOverridden: true}), {
    dataDir, cacheDir: `${dataDir}/cache`, tempDir: `${dataDir}/tmp`, projectsDir: `${dataDir}/projects`,
  });
  const windowsData = 'C:\\Users\\u\\AppData\\Roaming\\app.starroy.mioon\\data';
  assert.deepEqual(desktopAppDirectories({
    platform: 'win32', home: 'C:\\Users\\u', env: {}, appId: 'app.starroy.mioon', dataDir: windowsData, videosDir: 'C:\\Users\\u\\Videos', userDataOverridden: false,
  }), {
    dataDir: windowsData, cacheDir: 'C:\\Users\\u\\AppData\\Local\\app.starroy.mioon', tempDir: `${windowsData}\\tmp`, projectsDir: 'C:\\Users\\u\\Videos\\Mioon',
  });
  for (const appId of ['app/mioon', 'app\\mioon', '', '..', '.']) assert.throws(() => desktopAppDirectories({...mac, appId}), TypeError, appId);
  assert.throws(() => desktopAppDirectories({...mac, videosDir: 'Movies'}), TypeError);
});

test('projectLocation gives the kernel records/<ID>, cache/projects/<ID> and tmp/projects/<ID>', POSIX_ONLY, () => {
  const projectId = randomUUID();
  assert.deepEqual(projectLocation(serverAppDirectories('/srv/mioon'), projectId), {
    localDir: `/srv/mioon/records/${projectId}`, cacheDir: `/srv/mioon/cache/projects/${projectId}`, tempDir: `/srv/mioon/tmp/projects/${projectId}`,
  });
  assert.throws(() => projectLocation(serverAppDirectories('/srv/mioon'), projectId.toUpperCase()), TypeError);
});

test('the kernel creates the three local directories as private storage under the server layout', t => {
  const dataDir = scratch(t);
  const directories = serverAppDirectories(dataDir);
  mkdirSync(path.join(dataDir, 'projects', 'A'), {recursive: true});
  const projectFile = path.join(dataDir, 'projects', 'A', 'A.mioon');
  const projectId = createProjectFile(projectFile);
  const locate = (id: string) => projectLocation(directories, id);
  const location = locate(projectId);
  const store = openProjectStore({projectFile, locate});
  try {
    assert.deepEqual({localDir: store.localDir, cacheDir: store.cacheDir, tempDir: store.tempDir}, location);
    for (const directory of [path.join(dataDir, 'records'), location.localDir, location.cacheDir, location.tempDir]) assert.equal(mode(directory), 0o700, directory);
    assert.ok(existsSync(path.join(location.localDir, 'history.db')));
    assert.ok(existsSync(path.join(location.cacheDir, 'cache.db')));
  } finally {
    store.close();
  }
  const reopened = openProjectStore({projectFile, locate});
  assert.equal(reopened.historyState, 'current');
  reopened.close();
});

test('a symbolic link in the app directories is refused, so the macOS system temp directory cannot be used', POSIX_ONLY, t => {
  const root = scratch(t);
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  mkdirSync(path.join(real, 'projects', 'A'), {recursive: true});
  symlinkSync(real, link);
  const projectFile = path.join(real, 'projects', 'A', 'A.mioon');
  createProjectFile(projectFile);
  assert.throws(() => openProjectStore({projectFile, locate: id => projectLocation(serverAppDirectories(link), id)}),
    (error: unknown) => error instanceof PrivateStorageError && error.reason === 'SYMBOLIC_LINK');
  // Nothing stayed locked.
  const store = openProjectStore({projectFile, locate: id => projectLocation(serverAppDirectories(real), id)});
  assert.equal(store.historyState, 'fresh');
  store.close();
});
