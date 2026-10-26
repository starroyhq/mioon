import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {LUT_RESOURCE_LIMITS} from '@mioon/contracts/lut-resources';
import {importLutFile, LutImportFileError} from '../apps/cli/src/lut-import-file.ts';

const posix = {skip: process.platform === 'win32' || typeof process.getuid !== 'function'};
const input = Object.freeze({projectId: '6d7a9d82-6970-4690-b781-1460db2d86cd', requestId: 'lut-file-request'});

function fixture(t: test.TestContext, bytes: Buffer = Buffer.from('LUT_3D_SIZE 2\r\n# exact bytes\r\n')) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-lut-intake-'));
  const directory = path.join(root, 'Downloads');
  fs.mkdirSync(directory, {mode: 0o755});
  fs.chmodSync(directory, 0o755);
  const file = path.join(directory, 'look.CUBE');
  fs.writeFileSync(file, bytes, {mode: 0o644});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, directory, file, bytes};
}

function rejected(action: () => unknown, code: string, pattern?: RegExp|undefined) {
  assert.throws(action, error => error instanceof LutImportFileError && error.code === code
    && (!pattern || pattern.test(error.message)) && !error.message.includes('mioon-lut-intake-'));
}

interface FsReplacements {
 lstatSync(file: fs.PathLike,options: {bigint: true}): fs.BigIntStats;
 fstatSync(fd: number,options: {bigint: true}): fs.BigIntStats;
 openSync(file: fs.PathLike,flags: number,mode?: fs.Mode): number;
 readSync(fd: number,buffer: NodeJS.ArrayBufferView,offset: number,length: number,position: fs.ReadPosition | null): number;
}
function withMocks<T>(t: test.TestContext, replacements: Partial<FsReplacements>, run: () => T): T {
  for (const [name, replacement] of Object.entries(replacements)) (t.mock.method as (object: unknown,name: string,replacement: unknown) => unknown)(fs, name, replacement);
  syncBuiltinESMExports();
  try { return run(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

test('LUT file intake preserves exact bytes, accepts .CUBE and safe 0755 Downloads, and sends no local path or MIME', posix, t => {
  const {file, bytes} = fixture(t, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('TITLE "Look"\r\n'), Buffer.from([0xff, 0x00, 0x0a])]));
  const result = importLutFile(input, file);
  assert.deepEqual(Buffer.from(result.dataBase64, 'base64'), bytes);
  assert.deepEqual(Object.keys(result).sort(), ['dataBase64', 'name', 'projectId', 'requestId']);
  assert.equal(result.name, 'look.CUBE');
  assert.equal(JSON.stringify(result).includes(path.dirname(file)), false);
  assert.deepEqual(input, {projectId: '6d7a9d82-6970-4690-b781-1460db2d86cd', requestId: 'lut-file-request'});
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
});

test('LUT file intake preserves an explicit name without normalizing input or mutating it', posix, t => {
  const {file} = fixture(t);
  for (const name of ['My display name', '', null]) {
    const supplied = Object.freeze({...input, name});
    const result = importLutFile(supplied, file);
    assert.equal(result.name, name);
    assert.equal((supplied as typeof supplied & {dataBase64?: unknown}).dataBase64, undefined);
  }
});

test('LUT --file never overwrites supplied dataBase64, including explicitly undefined', () => {
  for (const dataBase64 of ['YQ==', '', null, undefined]) {
    rejected(() => importLutFile({...input, dataBase64}, '/never-read.cube'), 'VALIDATION_ERROR', /not both/);
  }
});

test('LUT source rejects non-Cube extensions, invalid paths and parent traversal before file access', () => {
  for (const file of ['', '\0.cube', 'look.3dl', 'look.cube.txt', '/source/../look.cube', '../look.cube']) {
    rejected(() => importLutFile(input, file), 'VALIDATION_ERROR');
  }
});

test('LUT source rejects symbolic-link leaves and ancestors without modifying targets', posix, t => {
  const {root, file, directory, bytes} = fixture(t);
  const alias = path.join(root, 'alias.cube'), linkedDirectory = path.join(root, 'alias');
  fs.symlinkSync(file, alias);
  fs.symlinkSync(directory, linkedDirectory);
  rejected(() => importLutFile(input, alias), 'FILE_READ_ERROR', /symbolic link/);
  rejected(() => importLutFile(input, path.join(linkedDirectory, path.basename(file))), 'FILE_READ_ERROR', /symbolic link/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('LUT source rejects nonregular files, multiple links and other-account writable files', posix, t => {
  const {root, file, bytes} = fixture(t);
  const directory = path.join(root, 'directory.cube');
  fs.mkdirSync(directory);
  rejected(() => importLutFile(input, directory), 'FILE_READ_ERROR', /regular local/);
  const linked = path.join(root, 'hardlink.cube');
  fs.linkSync(file, linked);
  rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /one filesystem link/);
  fs.unlinkSync(linked);
  fs.chmodSync(file, 0o664);
  rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /not be writable/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o664);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('LUT ancestor policy rejects writable directories but allows trusted sticky directories', posix, t => {
  const {directory, file} = fixture(t);
  fs.chmodSync(directory, 0o777);
  rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /ancestor is writable/);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o777);
  fs.chmodSync(directory, 0o1777);
  assert.equal(importLutFile(input, file).name, 'look.CUBE');
});

test('LUT source and ancestors reject foreign owners, including foreign sticky ancestors', posix, t => {
  const {directory, file} = fixture(t), original = fs.lstatSync;
  for (const target of [directory, file]) {
    withMocks(t, {lstatSync: (candidate, ...args) => {
      const info = original(candidate, ...args);
      if (candidate === target) { info.uid = BigInt((process.getuid)!()) + 1n; info.mode |= 0o1000n; }
      return info;
    }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /owned/));
  }
});

test('LUT source cap is shared, inclusive, and enforced before opening or reading an oversized file', posix, t => {
  const {file} = fixture(t);
  assert.equal(LUT_RESOURCE_LIMITS.sourceBytes, 7340032);
  fs.truncateSync(file, LUT_RESOURCE_LIMITS.sourceBytes + 1);
  withMocks(t, {
    openSync: () => { assert.fail('An oversized source must be rejected before open.'); },
    readSync: () => { assert.fail('An oversized source must be rejected before buffering.'); },
  }, () => rejected(() => importLutFile(input, file), 'FILE_TOO_LARGE', /7 MiB \(7340032 bytes\)/));
  fs.truncateSync(file, LUT_RESOURCE_LIMITS.sourceBytes);
  const result = importLutFile(input, file);
  assert.equal(Buffer.from(result.dataBase64, 'base64').length, LUT_RESOURCE_LIMITS.sourceBytes);
});

test('LUT source handles partial reads and uses read-only, no-follow, nonblocking open flags', posix, t => {
  const {file, bytes} = fixture(t), read = fs.readSync, open = fs.openSync;
  let calls = 0, descriptor!: number;
  withMocks(t, {
    openSync: (target, flags, ...args) => {
      assert.equal(target, file);
      assert.ok(flags & fs.constants.O_NOFOLLOW);
      assert.ok(flags & fs.constants.O_NONBLOCK);
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
      descriptor = open(target, flags, ...args); return descriptor;
    },
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView<ArrayBufferLike>, offset: number, length: number, position: fs.ReadPosition|null) => { calls++; return read(fd, buffer, offset, Math.min(length, 2), position); },
  }, () => assert.deepEqual(Buffer.from(importLutFile(input, file).dataBase64, 'base64'), bytes));
  assert.ok(calls > 2);
  assert.throws(() => fs.fstatSync(descriptor), {code: 'EBADF'});
});

test('LUT source rejects a replaced or changed opened inode and closes its descriptor', posix, t => {
  const {file} = fixture(t), original = fs.fstatSync;
  for (const field of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'nlink'] as const) {
    let descriptor!: number;
    withMocks(t, {fstatSync: (fd, ...args) => {
      descriptor = fd; const info = original(fd, ...args); info[field] += 1n; return info;
    }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR'));
    assert.throws(() => original(descriptor), {code: 'EBADF'});
  }
});

test('LUT source rejects same-size timestamp changes while reading', posix, t => {
  const {file} = fixture(t), original = fs.fstatSync;
  for (const field of ['mtimeNs', 'ctimeNs'] as const) {
    let calls = 0;
    withMocks(t, {fstatSync: (fd, ...args) => {
      const info = original(fd, ...args); if (++calls === 2) info[field] += 1n; return info;
    }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /changed while reading/));
  }
});

test('LUT source rejects growth, reads at most the observed size plus one, and never grows its buffer', posix, t => {
  for (const newSize of [16, LUT_RESOURCE_LIMITS.sourceBytes + 1]) {
    const {file} = fixture(t, Buffer.from('tiny')), original = fs.readSync;
    let maximum = 0, modified = false;
    withMocks(t, {readSync: (fd, buffer, offset, length, position) => {
      maximum = Math.max(maximum, (buffer as Buffer).length);
      if (!modified) { modified = true; fs.truncateSync(file, newSize); }
      return original(fd, buffer, offset, length, position);
    }}, () => rejected(() => importLutFile(input, file), newSize > LUT_RESOURCE_LIMITS.sourceBytes ? 'FILE_TOO_LARGE' : 'FILE_READ_ERROR'));
    assert.equal(maximum, 5);
  }
});

test('LUT source rejects shrinking files and premature EOF', posix, t => {
  const {file} = fixture(t), original = fs.readSync;
  let shrunk = false;
  withMocks(t, {readSync: (fd: number, buffer: NodeJS.ArrayBufferView<ArrayBufferLike>, offset: number, length: number, position: fs.ReadPosition|null) => {
    if (!shrunk) { shrunk = true; fs.truncateSync(file, 1); }
    return original(fd, buffer, offset, length, position);
  }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /changed while reading/));
  withMocks(t, {readSync: () => 0}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /changed while reading/));
});

test('LUT source rejects leaf replacement after reading even when the opened file remains unchanged', posix, t => {
  const {file, bytes} = fixture(t), original = fs.readSync;
  let replaced = false;
  withMocks(t, {readSync: (...args) => {
    const count = original(...args);
    if (!replaced) { replaced = true; fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, bytes, {mode: 0o644}); }
    return count;
  }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /changed while reading/));
});

test('LUT source rejects ancestor replacement after reading', posix, t => {
  const {directory, file, bytes} = fixture(t), original = fs.readSync;
  let replaced = false;
  withMocks(t, {readSync: (...args) => {
    const count = original(...args);
    if (!replaced) {
      replaced = true; fs.renameSync(directory, `${directory}.old`); fs.mkdirSync(directory, {mode: 0o755});
      fs.writeFileSync(file, bytes, {mode: 0o644});
    }
    return count;
  }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /changed while reading/));
});

test('LUT source rejects unsafe permissions observed after opening', posix, t => {
  const {file} = fixture(t), original = fs.fstatSync;
  let calls = 0;
  withMocks(t, {fstatSync: (fd, ...args) => {
    const info = original(fd, ...args); if (++calls === 2) info.mode |= 0o002n; return info;
  }}, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /not be writable/));
});

test('LUT source sanitizes filesystem failures and closes failed reads', posix, t => {
  const {file} = fixture(t), original = fs.fstatSync;
  let descriptor!: number;
  withMocks(t, {
    fstatSync: (fd, ...args) => { descriptor = fd; return original(fd, ...args); },
    readSync: () => { throw new Error(`private path ${file}`); },
  }, () => rejected(() => importLutFile(input, file), 'FILE_READ_ERROR', /exists and is readable/));
  assert.throws(() => original(descriptor), {code: 'EBADF'});
  rejected(() => importLutFile(input, `${file}.missing.cube`), 'FILE_READ_ERROR', /exists and is readable/);
});

test('LUT source fails closed for an unsupported platform, without claiming native ACL coverage', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {...descriptor, value: 'win32'});
  try { rejected(() => importLutFile(input, '/never-read.cube'), 'FILE_READ_ERROR', /Windows ACL intake is not implemented/); }
  finally { Object.defineProperty(process, 'platform', descriptor!); }
});
