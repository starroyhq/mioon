import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {createProjectFile, openProjectStore} from '../packages/business/src/project-file/index.ts';

const denied = {code: 'PROJECT_LOCATION_INVALID', status: 400};
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-app-guard-'));
  const directories = serverAppDirectories(path.join(root, 'app')), outside = path.join(root, 'outside');
  mkdirSync(directories.dataDir); mkdirSync(outside);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, directories, outside};
}

test('one synchronous recovery snapshot refreshes directories once and only lstats each candidate', t => {
  const f = fixture(t), local = path.join(f.directories.dataDir, 'records', 'synthetic');
  mkdirSync(local, {recursive: true});
  const privateFile = path.join(local, 'history.db'), candidate = path.join(f.outside, 'project.mioon');
  writeFileSync(privateFile, 'synthetic private bytes'); writeFileSync(candidate, 'candidate');
  const reads = new Map<string, number>();
  const guard = createApplicationFileGuard(f.directories, {metadata(file) {
    reads.set(file, (reads.get(file) ?? 0) + 1);
    return lstatSync(file, {bigint: true, throwIfNoEntry: false});
  }});
  reads.clear();
  assert.equal(guard.withSnapshot(() => {
    for (let n = 0; n < 100; n++) guard(candidate);
    guard.withSnapshot(() => guard(candidate));
    return 'complete';
  }), 'complete');
  assert.equal(reads.get(f.directories.dataDir), 1, 'a sweep does not refresh once per project');
  assert.equal(reads.get(local), 1, 'each known private directory is checked once');
  assert.equal(reads.get(privateFile), undefined, 'unchanged private files are not restatted');
  assert.equal(reads.get(candidate), 101, 'every candidate still receives its own fresh lstat');
});

test('nested additions invalidate immediately even when directory mtime is unchanged', t => {
  const f = fixture(t), local = path.join(f.directories.dataDir, 'records', 'nested');
  mkdirSync(local, {recursive: true});
  const guard = createApplicationFileGuard(f.directories, {metadata(file) {
    const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
    if (!info) return undefined;
    return {dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs,
      mtimeNs: 1n, ctimeNs: info.ctimeNs,
      isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink()};
  }});
  const privateFile = path.join(local, 'new-draft.json'), linked = path.join(f.outside, 'linked.mioon');
  writeFileSync(privateFile, 'new private bytes'); linkSync(privateFile, linked);
  assert.throws(() => guard(linked), denied, 'ctime invalidates the directory without any TTL or watcher delay');
  const moved = path.join(f.outside, 'moved.mioon'); renameSync(privateFile, moved);
  assert.throws(() => guard(moved), denied, 'the observed identity is retained after its private path disappears');
  assert.throws(() => guard(linked), denied);
});

test('missing or zero directory times never cache a negative identity lookup', t => {
  for (const time of [undefined, 0n]) {
    const f = fixture(t), local = path.join(f.directories.dataDir, 'records');
    mkdirSync(local);
    const privateFile = path.join(local, 'late.json'), candidate = path.join(f.outside, 'linked.mioon');
    let fileReads = 0;
    const guard = createApplicationFileGuard(f.directories, {metadata(file) {
      const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
      if (!info) return undefined;
      if (file === privateFile) fileReads++;
      return {dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs, mtimeNs: time, ctimeNs: time,
        isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink()};
    }});
    writeFileSync(privateFile, 'private'); linkSync(privateFile, candidate);
    assert.throws(() => guard(candidate), denied);
    assert.throws(() => guard(candidate), denied);
    assert.equal(fileReads, 2, 'every refresh falls back to scanning actual file metadata');
  }
});

test('async, thenable and throwing callbacks cannot retain a recovery snapshot', t => {
  const f = fixture(t), guard = createApplicationFileGuard(f.directories);
  let invoked = false;
  assert.throws(() => guard.withSnapshot(async () => {invoked = true;}), TypeError);
  assert.equal(invoked, false, 'async callbacks are rejected before execution');
  assert.throws(() => guard.withSnapshot(() => Promise.resolve('not synchronous')), TypeError);
  const failure = new Error('synthetic recovery failure');
  assert.throws(() => guard.withSnapshot(() => {throw failure;}), error => error === failure);
  const privateFile = path.join(f.directories.dataDir, 'after-scope.json'), candidate = path.join(f.outside, 'linked.mioon');
  writeFileSync(privateFile, 'private'); linkSync(privateFile, candidate);
  assert.throws(() => guard(candidate), denied, 'failed scopes still restore normal fresh-directory checking');
});

test('more than 100000 private entries do not disable ordinary projects or omit late private identities', t => {
  const f = fixture(t), local = path.join(f.directories.dataDir, 'records');
  mkdirSync(local);
  for (let n = 0; n < 100_001; n++) writeFileSync(path.join(local, `${n}.json`), '');
  const guard = createApplicationFileGuard(f.directories), candidate = path.join(f.outside, 'ordinary.mioon');
  createProjectFile(candidate);
  assert.doesNotThrow(() => guard(candidate));
  const store = openProjectStore({projectFile: candidate, locate: id => projectLocation(f.directories, id)});
  try {assert.equal(store.projectFile, candidate); assert.equal(store.db.isOpen, true);}
  finally {store.close();}
  const linked = path.join(f.outside, 'last-private.mioon'); linkSync(path.join(local, '100000.json'), linked);
  assert.throws(() => guard(linked), denied, 'the end of the oversized directory is still protected');
});

test('deep private trees are scanned iteratively without an unprotected depth cutoff', t => {
  const f = fixture(t), deep = path.join(f.directories.dataDir, ...Array.from({length: 40}, () => 'nested'));
  mkdirSync(deep, {recursive: true});
  const privateFile = path.join(deep, 'deep.json'), candidate = path.join(f.outside, 'deep-private.mioon');
  writeFileSync(privateFile, 'private'); linkSync(privateFile, candidate);
  const guard = createApplicationFileGuard(f.directories);
  assert.throws(() => guard(candidate), denied);
});

test('external cache and temporary roots discover new private identities on the next check', t => {
  const f = fixture(t), directories = {...f.directories,
    cacheDir: path.join(f.root, 'system-cache'), tempDir: path.join(f.root, 'system-temp')};
  mkdirSync(directories.cacheDir); mkdirSync(directories.tempDir);
  const guard = createApplicationFileGuard(directories);
  for (const [index, root] of [directories.cacheDir, directories.tempDir].entries()) {
    const local = path.join(root, 'projects', 'synthetic'); mkdirSync(local, {recursive: true});
    const privateFile = path.join(local, 'late-private.json'), candidate = path.join(f.outside, `linked-${index}.mioon`);
    writeFileSync(privateFile, 'private'); linkSync(privateFile, candidate);
    assert.throws(() => guard(candidate), denied);
    const moved = path.join(f.outside, `moved-${index}.mioon`); renameSync(privateFile, moved);
    assert.throws(() => guard(moved), denied);
  }
});
