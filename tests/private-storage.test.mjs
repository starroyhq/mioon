import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {ensurePrivateDirectory, validatePrivateDirectory, createPrivateTemporaryDirectory, validateManagedDirectory,
  validateManagedFile, readPrivateFile, writePrivateFileAtomic, removePrivateFile,
  createPrivateStoragePolicy, getStoragePrivacyCapability} from '@mioon/contracts/private-storage';

const posix = {skip: process.platform === 'win32'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-private-policy-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
const rejects = (fn, reason) => assert.throws(fn, error => error.code === 'STORAGE_PRIVATE_REQUIRED' && error.reason === reason && Boolean(error.recovery) && !error.message.includes('mioon-private-policy-'));
function mockBuiltin(t, name, replacement, check) {
  t.mock.method(fs, name, replacement); syncBuiltinESMExports();
  try { check(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

test('private policy is an explicit Node-only subpath and capability metadata cannot enable Windows', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../packages/contracts/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./private-storage'], './src/private-storage.mjs');
  assert.ok(!fs.readFileSync(new URL('../packages/contracts/src/index.mjs', import.meta.url), 'utf8').includes('private-storage'));
  assert.deepEqual(getStoragePrivacyCapability('win32'), {available: false, backend: 'unavailable', code: 'STORAGE_PRIVACY_UNAVAILABLE', reason: 'WINDOWS_ACL_UNIMPLEMENTED'});
  assert.equal(getStoragePrivacyCapability('unknown').available, false);
  // Synthetic platform process proves even a positive code-injected verifier
  // cannot enable the unimplemented Windows backend. This is not native ACL QA.
  const module = new URL('../packages/contracts/src/private-storage.mjs', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process,'platform',{value:'win32'}); const {createPrivateStoragePolicy}=await import(${JSON.stringify(module)}); let called=false; const policy=createPrivateStoragePolicy({windowsAclVerifier:()=>{called=true;return true;}}); try { policy.ensurePrivateDirectory('/synthetic-never-created',{create:true}); process.exitCode=1; } catch(error) { if(error.code!=='STORAGE_PRIVACY_UNAVAILABLE'||!called)process.exitCode=2; }`], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr);
});

test('new recursively missing components are private; broad existing roots are unchanged on refusal', posix, t => {
  const root = fixture(t), nested = path.join(root, 'one', 'two');
  ensurePrivateDirectory(nested, {create: true});
  for (const directory of [path.join(root, 'one'), nested]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const mode of [0o755, 0o777]) {
    fs.chmodSync(nested, mode);
    rejects(() => ensurePrivateDirectory(nested, {create: true}), 'DIRECTORY_PERMISSIONS');
    assert.equal(fs.statSync(nested).mode & 0o777, mode);
  }
});

test('no mkdir occurs through symlink roots or ancestors, and diagnostic temporary creation uses the same gate', posix, t => {
  const root = fixture(t), outside = path.join(root, 'outside'), alias = path.join(root, 'alias');
  fs.mkdirSync(outside, {mode: 0o700}); fs.symlinkSync(outside, alias);
  rejects(() => ensurePrivateDirectory(path.join(alias, 'new', 'nested'), {create: true}), 'SYMBOLIC_LINK');
  rejects(() => ensurePrivateDirectory(alias, {create: true}), 'SYMBOLIC_LINK');
  rejects(() => createPrivateTemporaryDirectory(alias), 'SYMBOLIC_LINK');
  assert.deepEqual(fs.readdirSync(outside), []);
  const temporary = createPrivateTemporaryDirectory(root, 'diagnostic-');
  assert.equal(fs.statSync(temporary).mode & 0o777, 0o700);
});

test('unsafe writable and foreign-owner ancestors are refused; trusted sticky temporary parents are allowed', posix, t => {
  const root = fixture(t), parent = path.join(root, 'parent'), leaf = path.join(parent, 'private');
  fs.mkdirSync(parent, {mode: 0o700}); fs.mkdirSync(leaf, {mode: 0o700}); fs.chmodSync(parent, 0o777);
  rejects(() => validatePrivateDirectory(leaf), 'UNSAFE_ANCESTOR');
  fs.chmodSync(parent, 0o1777); assert.ok(validatePrivateDirectory(leaf));
  fs.chmodSync(parent, 0o755);
  const original = fs.lstatSync;
  mockBuiltin(t, 'lstatSync', function (file, ...args) {
    const info = original(file, ...args);
    if (file === parent) info.uid = process.getuid() + 1;
    return info;
  }, () => rejects(() => validatePrivateDirectory(leaf), 'FOREIGN_ANCESTOR'));
  assert.equal(fs.statSync(parent).mode & 0o7777, 0o755);
});

test('legacy media0755 and database0644 are allowed only under an owned700 root without other-account writes', posix, t => {
  const root = fixture(t), media = path.join(root, 'media'), file = path.join(media, 'legacy.sqlite');
  fs.mkdirSync(media, {mode: 0o755}); fs.writeFileSync(file, 'legacy', {mode: 0o644});
  assert.ok(validateManagedDirectory(media, {root})); assert.ok(validateManagedFile(file, {root}));
  rejects(() => readPrivateFile(file, {root}), 'FILE_PERMISSIONS');
  fs.chmodSync(file, 0o664); rejects(() => validateManagedFile(file, {root}), 'FILE_PERMISSIONS');
  fs.chmodSync(file, 0o644); fs.chmodSync(media, 0o775); rejects(() => validateManagedFile(file, {root}), 'DIRECTORY_PERMISSIONS');
});

test('private files reject symlinks, hardlinks, directories, FIFOs and oversized values without replacement', posix, t => {
  const root = fixture(t), file = path.join(root, 'credential'), target = path.join(root, 'sentinel');
  fs.writeFileSync(target, 'synthetic-preserved', {mode: 0o600});
  const checks = [
    ['SYMBOLIC_LINK', () => fs.symlinkSync(target, file)],
    ['HARD_LINK', () => fs.linkSync(target, file)],
    ['FILE_TYPE', () => fs.mkdirSync(file, {mode: 0o700})],
    ['SIZE_LIMIT', () => fs.writeFileSync(file, 'x'.repeat(4097), {mode: 0o600})],
  ];
  const fifo = spawnSync('which', ['mkfifo'], {encoding: 'utf8'}).status === 0;
  if (fifo) checks.push(['FILE_TYPE', () => assert.equal(spawnSync('mkfifo', [file]).status, 0)]);
  for (const [reason, setup] of checks) {
    setup(); rejects(() => readPrivateFile(file), reason);
    rejects(() => writePrivateFileAtomic(file, 'new'), reason);
    rejects(() => removePrivateFile(file), reason);
    assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic-preserved');
    fs.rmSync(file, {recursive: true, force: true});
  }
});

test('missing reads are side-effect free, and writers require an already validated parent', posix, t => {
  const root = fixture(t), absent = path.join(root, 'missing'), file = path.join(absent, 'value');
  assert.equal(readPrivateFile(file, {allowMissing: true}), null);
  rejects(() => writePrivateFileAtomic(file, 'new'), 'MISSING');
  assert.deepEqual(fs.readdirSync(root), []);
  rejects(() => validateManagedFile(path.join(root, '..', 'outside'), {root, allowMissing: true}), 'OUTSIDE_ROOT');
});

test('private file reads validate opened inode and owner, use NOFOLLOW, and close rejected descriptors', posix, t => {
  const root = fixture(t), file = path.join(root, 'credential'); fs.writeFileSync(file, 'synthetic-private-token', {mode: 0o600});
  const original = fs.fstatSync;
  for (const [reason, alter] of [['FILE_CHANGED', info => info.ino++], ['FOREIGN_OWNER', info => info.uid++], ['HARD_LINK', info => info.nlink++], ['FILE_PERMISSIONS', info => info.mode |= 0o044]]) {
    let descriptor;
    mockBuiltin(t, 'fstatSync', function (fd, ...args) { descriptor = fd; const info = original(fd, ...args); alter(info); return info; }, () => {
      rejects(() => readPrivateFile(file), reason);
      assert.throws(() => original(descriptor), {code: 'EBADF'});
    });
  }
  const open = fs.openSync;
  mockBuiltin(t, 'openSync', function (file, flags, ...args) { assert.ok(flags & fs.constants.O_NOFOLLOW); return open(file, flags, ...args); }, () => assert.equal(readPrivateFile(file, {encoding: 'utf8'}), 'synthetic-private-token'));
});

test('a growing private file is bounded to limit plus one byte, and partial reads are handled', posix, t => {
  const root = fixture(t), file = path.join(root, 'credential'); fs.writeFileSync(file, 'short', {mode: 0o600});
  let bytes = 0, calls = 0;
  mockBuiltin(t, 'readSync', (fd, buffer, offset, length) => { calls++; bytes += length; buffer.fill(120, offset, offset + length); return length; }, () => rejects(() => readPrivateFile(file, {maxBytes: 32}), 'SIZE_LIMIT'));
  assert.equal(bytes, 33); assert.equal(calls, 1);
  const read = fs.readSync;
  mockBuiltin(t, 'readSync', (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(2, length), position), () => assert.equal(readPrivateFile(file, {encoding: 'utf8'}), 'short'));
});

test('atomic writes are private, preserve failed destinations, use unique exclusive temporaries and support no-clobber', posix, t => {
  const root = fixture(t), file = path.join(root, 'credential');
  writePrivateFileAtomic(file, 'old', {replace: false});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  rejects(() => writePrivateFileAtomic(file, 'blocked', {replace: false}), 'ALREADY_EXISTS');
  writePrivateFileAtomic(file, Buffer.from('new')); assert.equal(readPrivateFile(file, {encoding: 'utf8'}), 'new');
  const open = fs.openSync; let collision;
  mockBuiltin(t, 'openSync', function (target, flags, ...args) {
    if (String(target).endsWith('.tmp')) {
      assert.ok(flags & fs.constants.O_EXCL); assert.ok(flags & fs.constants.O_NOFOLLOW);
      collision = target;
      const descriptor = open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(descriptor, 'synthetic-collision-preserved'); } finally { fs.closeSync(descriptor); }
    }
    return open(target, flags, ...args);
  }, () => rejects(() => writePrivateFileAtomic(file, 'blocked'), 'ALREADY_EXISTS'));
  assert.equal(fs.readFileSync(collision, 'utf8'), 'synthetic-collision-preserved');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  fs.unlinkSync(collision);
  mockBuiltin(t, 'renameSync', () => { throw Object.assign(new Error('raw-private-path-must-not-leak'), {code: 'EIO'}); }, () => rejects(() => writePrivateFileAtomic(file, 'blocked'), 'IO_ERROR'));
  assert.deepEqual(fs.readdirSync(root), ['credential']); assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  removePrivateFile(file); removePrivateFile(file); assert.deepEqual(fs.readdirSync(root), []);
});
