import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
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
