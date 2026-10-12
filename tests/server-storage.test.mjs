import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {startServer} from '@mioon/server';
import {openStore} from '@mioon/business';
import {validateWorkspaceStorage} from '@mioon/business/db';

const posix = {skip: process.platform === 'win32'};
const token = 'synthetic-server-storage-token';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-server-storage-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside');
  fs.mkdirSync(root, {mode: 0o700}); fs.mkdirSync(outside, {mode: 0o700});
  fs.writeFileSync(path.join(outside, 'sentinel'), 'synthetic-outside-preserved', {mode: 0o600});
  return {base, root, outside};
}
function snapshot(root) {
  const values = {};
  const visit = (file, key) => {
    const info = fs.lstatSync(file);
    values[key] = {mode: info.mode, uid: info.uid, ino: info.ino, nlink: info.nlink,
      content: info.isFile() ? fs.readFileSync(file).toString('hex') : info.isSymbolicLink() ? fs.readlinkSync(file) : null};
    if (info.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), key + '/' + name);
  };
  visit(root, 'root'); return values;
}
const storageFailure = error => error.code === 'STORAGE_PRIVATE_REQUIRED' && Boolean(error.reason) && Boolean(error.recovery) && !error.message.includes('mioon-server-storage-') && !error.message.includes(token);

for (const mode of [0o755, 0o777]) test(`unsafe existing root${mode.toString(8)} fails before any initialization or permission repair`, posix, async t => {
  const f = fixture(t); fs.chmodSync(f.root, mode); const before = snapshot(f.base);
  await assert.rejects(startServer({dataDir: f.root, port: 0}), storageFailure);
  assert.deepEqual(snapshot(f.base), before);
});

for (const entry of ['media', 'workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm', 'workbench.sqlite-journal', 'server.lock', 'access-token', 'agent-settings']) {
  test(`unsafe symbolic-link ${entry} is refused before lock, token, database or external writes`, posix, async t => {
    const f = fixture(t), target = ['media', 'agent-settings'].includes(entry) ? f.outside : path.join(f.outside, 'sentinel');
    fs.symlinkSync(target, path.join(f.root, entry)); const before = snapshot(f.base);
    await assert.rejects(startServer({dataDir: f.root, port: 0, token}), storageFailure);
    assert.throws(() => openStore(f.root, {lock: false}), storageFailure);
    assert.deepEqual(snapshot(f.base), before);
  });
}

for (const entry of ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm', 'server.lock', 'access-token']) {
  test(`hardlinked ${entry} is never opened, removed or rewritten`, posix, async t => {
    const f = fixture(t); fs.linkSync(path.join(f.outside, 'sentinel'), path.join(f.root, entry)); const before = snapshot(f.base);
    await assert.rejects(startServer({dataDir: f.root, port: 0, token}), storageFailure);
    assert.deepEqual(snapshot(f.base), before);
  });
}

for (const entry of ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm', 'server.lock', 'access-token']) {
  test(`nonregular ${entry} is refused without partial initialization`, posix, async t => {
    const f = fixture(t); fs.mkdirSync(path.join(f.root, entry), {mode: 0o700}); const before = snapshot(f.base);
    await assert.rejects(startServer({dataDir: f.root, port: 0, token}), storageFailure);
    assert.deepEqual(snapshot(f.base), before);
  });
}

test('token permissions and bounded size remain mandatory even when a valid token is supplied', posix, async t => {
  for (const [mode, contents] of [[0o644, token], [0o600, 'x'.repeat(4099)]]) {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'access-token'), contents, {mode});
    const before = snapshot(f.base); await assert.rejects(startServer({dataDir: f.root, port: 0, token}), storageFailure);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test('consumed malformed token fails before DB/media creation or removal of a safe stale lock', posix, async t => {
  for (const content of ['bad', token + '\nembedded-line', token + '\0']) {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'access-token'), content, {mode: 0o600});
    fs.writeFileSync(path.join(f.root, 'server.lock'), 'not-a-pid', {mode: 0o644});
    const before = snapshot(f.base); await assert.rejects(startServer({dataDir: f.root, port: 0}), /20 characters/);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test('valid supplied token overrides unused malformed contents without ever reading or rewriting them', posix, async t => {
  const f = fixture(t), file = path.join(f.root, 'access-token'); fs.writeFileSync(file, 'bad', {mode: 0o600});
  const original = fs.openSync; let reads = 0;
  t.mock.method(fs, 'openSync', function (candidate, flags, ...args) { if (candidate === file) { reads++; throw Error('stored-token-must-not-be-opened'); } return original(candidate, flags, ...args); });
  syncBuiltinESMExports();
  let service;
  try { service = await startServer({dataDir: f.root, port: 0, token}); assert.equal(service.token, token); assert.equal(reads, 0); }
  finally { await service?.close(); t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), 'bad'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('invalid supplied tokens fail without creating even a missing root', posix, async t => {
  const f = fixture(t), missing = path.join(f.base, 'not-created');
  for (const value of ['short', 'x'.repeat(4097), token + '\n', token + '\0']) {
    await assert.rejects(startServer({dataDir: missing, port: 0, token: value}), /20 characters/);
    assert.equal(fs.existsSync(missing), false);
  }
});

test('legacy media0755 and SQLite0644 survive restart with exact project values and stored token normalization', posix, async t => {
  const f = fixture(t); let store = openStore(f.root);
  const project = {id: 'synthetic-project', name: 'Legacy workspace', revision: 7}; store.put('projects', project); store.close();
  fs.chmodSync(path.join(f.root, 'media'), 0o755); fs.chmodSync(path.join(f.root, 'workbench.sqlite'), 0o644);
  fs.writeFileSync(path.join(f.root, 'access-token'), `  ${token}  \n`, {mode: 0o600});
  const service = await startServer({dataDir: f.root, port: 0});
  try { assert.equal(service.token, token); assert.equal((await fetch(service.url + '/health')).status, 200); }
  finally { await service.close(); }
  store = openStore(f.root); try { assert.deepEqual(store.get('projects', project.id), project); assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 24); } finally { store.close(); }
  assert.equal(fs.statSync(path.join(f.root, 'media')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(f.root, 'workbench.sqlite')).mode & 0o777, 0o644);
});

test('token file accepts bounded maximum plus CRLF, and fresh token is private and durable', posix, async t => {
  const f = fixture(t), file = path.join(f.root, 'access-token'); fs.writeFileSync(file, 'x'.repeat(4096) + '\r\n', {mode: 0o600});
  let service = await startServer({dataDir: f.root, port: 0}); assert.equal(service.token.length, 4096); await service.close();
  const other = fixture(t); service = await startServer({dataDir: other.root, port: 0});
  const generated = service.token; assert.equal(fs.statSync(service.tokenFile).mode & 0o777, 0o600); await service.close();
  service = await startServer({dataDir: other.root, port: 0}); assert.equal(service.token, generated); await service.close();
});

test('lock ownership and failed SQLite initialization cleanup preserve unrelated entries', posix, async t => {
  const f = fixture(t), file = path.join(f.root, 'workbench.sqlite'), lock = path.join(f.root, 'server.lock');
  fs.writeFileSync(file, 'synthetic-not-a-database', {mode: 0o600});
  assert.throws(() => openStore(f.root)); assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-not-a-database');
  fs.unlinkSync(file); const store = openStore(f.root);
  assert.throws(() => openStore(f.root), /running backend/);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  store.close(); store.close(); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, 'not-a-pid', {mode: 0o644});
  const restarted = openStore(f.root); restarted.close(); assert.equal(fs.existsSync(lock), false);
});

test('existing writable media/database and unsafe settings metadata fail read-only preflight before stale-lock cleanup', posix, async t => {
  for (const entry of ['media', 'workbench.sqlite', 'agent-settings', 'agent-settings/settings.json']) {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'server.lock'), 'not-a-pid', {mode: 0o600});
    if (entry === 'media' || entry === 'agent-settings') fs.mkdirSync(path.join(f.root, entry), {mode: 0o777});
    else {
      if (entry.includes('/')) fs.mkdirSync(path.join(f.root, 'agent-settings'), {mode: 0o700});
      fs.writeFileSync(path.join(f.root, entry), 'synthetic', {mode: 0o666});
    }
    fs.chmodSync(path.join(f.root, entry), entry.includes('settings') ? 0o755 : 0o777);
    const before = snapshot(f.base); assert.throws(() => validateWorkspaceStorage(f.root), storageFailure);
    await assert.rejects(startServer({dataDir: f.root, port: 0, token}), storageFailure);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test('FIFO token is rejected promptly without blocking or creating startup files', posix, async t => {
  if (spawnSync('which', ['mkfifo']).status !== 0) return t.skip('mkfifo is not available');
  const f = fixture(t); assert.equal(spawnSync('mkfifo', [path.join(f.root, 'access-token')]).status, 0);
  const before = snapshot(f.base); await assert.rejects(startServer({dataDir: f.root, port: 0}), storageFailure);
  assert.deepEqual(snapshot(f.base), before);
});

test('symlink ancestor with nonexistent workspace creates nothing outside managed storage', posix, async t => {
  const f = fixture(t), alias = path.join(f.base, 'alias'); fs.symlinkSync(f.outside, alias);
  const before = snapshot(f.base); await assert.rejects(startServer({dataDir: path.join(alias, 'new', 'workspace'), port: 0, token}), storageFailure);
  assert.deepEqual(snapshot(f.base), before);
});
