import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {linkSync, lstatSync, mkdirSync, mkdtempSync, promises as fs, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';

const denied = {code: 'PROJECT_LOCATION_INVALID', status: 400};
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-app-file-generation-')), directories = serverAppDirectories(path.join(root, 'app'));
  mkdirSync(directories.dataDir, {mode: 0o700});
  const outside = path.join(root, 'outside'); mkdirSync(outside, {mode: 0o700});
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, directories, outside};
}

test('private paths, renamed private files and hard links remain refused after ordinary metadata changes', t => {
  const f = fixture(t), privateFile = path.join(f.directories.dataDir, 'settings.json');
  writeFileSync(privateFile, '{"synthetic":true}', {mode: 0o600});
  const guard = createApplicationFileGuard(f.directories);
  assert.throws(() => guard(privateFile), denied);
  const linked = path.join(f.outside, 'linked.mioon'); linkSync(privateFile, linked);
  assert.throws(() => guard(linked), denied);
  unlinkSync(privateFile);
  assert.throws(() => guard(linked), denied, 'retaining only the external hard link does not grant project permission');
  const moved = path.join(f.outside, 'renamed.mioon'); renameSync(linked, moved);
  assert.throws(() => guard(moved), denied);
  writeFileSync(moved, '{"synthetic":"changed"}');
  assert.throws(() => guard(moved), denied, 'ctime/content changes cannot discard the private identity');
  assert.throws(() => guard(path.join(f.directories.dataDir, 'not-created.mioon')), denied);
});

test('new real projects under the default projects subtree and outside app storage remain usable', t => {
  const f = fixture(t), guard = createApplicationFileGuard(f.directories);
  for (const directory of [f.directories.projectsDir, f.outside]) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const file = path.join(directory, 'actual-project.mioon'); createProjectFile(file);
    assert.doesNotThrow(() => guard(file));
    const store = openProjectStore({projectFile: file, locate: id => projectLocation(f.directories, id)});
    try {assert.equal(store.projectFile, file); assert.equal(store.db.isOpen, true);}
    finally {store.close();}
  }
});

test('a deleted private inode reused with a different positive birth generation does not reject a new real project', t => {
  const f = fixture(t), privateFile = path.join(f.directories.dataDir, 'retired.json'), projectFile = path.join(f.outside, 'new-project.mioon');
  writeFileSync(privateFile, '{}', {mode: 0o600});
  const retired = lstatSync(privateFile, {bigint: true}), oldBirth = retired.birthtimeNs > 0n ? retired.birthtimeNs : 100n;
  let candidateBirth = oldBirth;
  const guard = createApplicationFileGuard(f.directories, {metadata(file) {
    const info = lstatSync(file, {bigint: true, throwIfNoEntry: false}); if (!info) return undefined;
    const simulated = file === privateFile || file === projectFile;
    return {dev: simulated ? retired.dev : info.dev, ino: simulated ? retired.ino : info.ino,
      birthtimeNs: file === privateFile ? oldBirth : file === projectFile ? candidateBirth : info.birthtimeNs,
      isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink()};
  }});
  unlinkSync(privateFile); createProjectFile(projectFile);
  assert.throws(() => guard(projectFile), denied, 'the same dev/ino and birth generation must still be denied');
  candidateBirth = oldBirth + 1n;
  assert.doesNotThrow(() => guard(projectFile), 'only an observed positive new generation distinguishes inode reuse');
  const store = openProjectStore({projectFile, locate: id => projectLocation(f.directories, id)});
  try {assert.equal(store.db.isOpen, true);}
  finally {store.close();}
});

test('zero or missing birth generation remains conservative for a reused private inode', t => {
  for (const oldBirth of [0n, undefined, 100n]) for (const newBirth of [0n, undefined, 100n]) {
    const f = fixture(t), privateFile = path.join(f.directories.dataDir, 'retired.json'), candidate = path.join(f.outside, 'candidate.mioon');
    writeFileSync(privateFile, '{}', {mode: 0o600});
    const retired = lstatSync(privateFile, {bigint: true});
    const guard = createApplicationFileGuard(f.directories, {metadata(file) {
      const info = lstatSync(file, {bigint: true, throwIfNoEntry: false}); if (!info) return undefined;
      const simulated = file === privateFile || file === candidate;
      return {dev: simulated ? retired.dev : info.dev, ino: simulated ? retired.ino : info.ino,
        birthtimeNs: file === privateFile ? oldBirth : file === candidate ? newBirth : info.birthtimeNs,
        isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink()};
    }});
    unlinkSync(privateFile); createProjectFile(candidate);
    assert.throws(() => guard(candidate), denied);
  }
});

test('an older catalog scan cannot discard a newer private-file generation', async t => {
  const f = fixture(t), privateFile = path.join(f.directories.dataDir, 'private.json');
  writeFileSync(privateFile, '{}', {mode: 0o600});
  const physical = lstatSync(privateFile, {bigint: true});
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let birthtimeNs = 10n;
  const guard = createApplicationFileGuard(f.directories, {
    metadata(file) {
      return file === privateFile ? {...physical, birthtimeNs, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false}
        : lstatSync(file, {bigint: true, throwIfNoEntry: false});
    },
    async catalogMetadata(file) {
      if (file !== privateFile) return lstatSync(file, {bigint: true, throwIfNoEntry: false});
      entered.resolve();
      await resume.promise;
      return {...physical, birthtimeNs: 10n, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false};
    },
  });
  const snapshot = guard.catalogSnapshot(new AbortController().signal);
  await entered.promise;
  birthtimeNs = 20n;
  const moved = path.join(f.outside, 'private.mioon');
  assert.throws(() => guard(privateFile), denied);
  renameSync(privateFile, moved);
  resume.resolve();
  const check = await snapshot;
  const relocated = {...physical, birthtimeNs, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false};
  assert.throws(() => check(moved, relocated), denied);
  assert.doesNotThrow(() => check(moved, {...relocated, birthtimeNs: 30n}));
});

for (const code of ['ENOENT', 'ENOTDIR'] as const) {
  test(`catalog scan continues after a temporary directory changes before readdir (${code})`, async t => {
    const f = fixture(t), temporary = path.join(f.directories.dataDir, 'temporary');
    const privateFile = path.join(f.directories.dataDir, 'settings.json'), alias = path.join(f.outside, 'alias.mioon');
    const guard = createApplicationFileGuard(f.directories, {async catalogMetadata(file) {
      const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
      if (file === temporary && info?.isDirectory()) {
        rmSync(temporary, {recursive: true});
        if (code === 'ENOTDIR') writeFileSync(temporary, '');
      }
      return info;
    }});
    mkdirSync(temporary);
    writeFileSync(privateFile, '{}', {mode: 0o600});
    linkSync(privateFile, alias);
    const check = await guard.catalogSnapshot(new AbortController().signal);
    assert.throws(() => lstatSync(path.join(temporary, 'child')), {code});
    assert.throws(() => check(alias, lstatSync(alias, {bigint: true})), denied);
  });
}

test('catalog scan still reports other directory read failures', async t => {
  const f = fixture(t), unreadable = path.join(f.directories.dataDir, 'unreadable');
  mkdirSync(unreadable);
  const guard = createApplicationFileGuard(f.directories);
  const failure = Object.assign(new Error('Unreadable private directory'), {code: 'EACCES'});
  const readdir = fs.readdir;
  const mock = t.mock.method(fs, 'readdir', (file: Parameters<typeof readdir>[0], options: Parameters<typeof readdir>[1]) => {
    if (file === unreadable) return Promise.reject(failure);
    return readdir(file, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(guard.catalogSnapshot(new AbortController().signal), error => error === failure);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an aborted catalog scan stops before starting another directory read', async t => {
  const f = fixture(t), temporary = path.join(f.directories.dataDir, 'temporary');
  mkdirSync(temporary);
  const abort = new AbortController(), reason = new Error('Catalog scan cancelled');
  const guard = createApplicationFileGuard(f.directories, {async catalogMetadata(file) {
    const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
    if (file === temporary) abort.abort(reason);
    return info;
  }});
  const readdir = fs.readdir;
  let visited = false;
  const mock = t.mock.method(fs, 'readdir', (file: Parameters<typeof readdir>[0], options: Parameters<typeof readdir>[1]) => {
    if (file === temporary) visited = true;
    return readdir(file, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(guard.catalogSnapshot(abort.signal), error => error === reason);
    assert.equal(visited, false);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
