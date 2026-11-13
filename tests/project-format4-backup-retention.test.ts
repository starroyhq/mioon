import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  FORMAT_UPGRADE_BACKUP_DIRECTORY, FORMAT_UPGRADE_BACKUP_LIMIT, readFormat4BackupManifest, verifyFormat4Backup,
} from '../packages/business/src/project-file/format4-backup.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-format4-retention-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectFile = path.join(root, 'project.mioon');
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')};
  const backups = path.join(location.localDir, FORMAT_UPGRADE_BACKUP_DIRECTORY);
  const options = {projectFile, locate: () => location};
  createProjectStore(options).close();
  const stop = new Error('injected upgrade rollback');
  const failAfterBackup = () => assert.throws(() => openProjectStore({...options, format4: {
    approveUpgrade: () => true,
    onUpgradeBoundary: () => {throw stop;},
  }}), error => error instanceof Error && error.cause === stop);
  return {root, location, options, backups, failAfterBackup};
}

test('repeated approved attempts retain the newest backups and preserve unrecognized directories', t => {
  const f = fixture(t);
  f.failAfterBackup();
  const original = readdirSync(f.backups)[0]!;
  const originalDirectory = path.join(f.backups, original);
  const originalManifest = readFormat4BackupManifest(f.backups, original);
  verifyFormat4Backup(originalDirectory, originalManifest);
  const older = new Date('2026-01-01T00:00:00.000Z');
  utimesSync(originalDirectory, older, older);
  const oldIds = [original];
  for (let index = 1; index < FORMAT_UPGRADE_BACKUP_LIMIT; index++) {
    const id = randomUUID(), directory = path.join(f.backups, id);
    cpSync(originalDirectory, directory, {recursive: true});
    chmodSync(directory, 0o700);
    const date = new Date(older.valueOf() + index * 1000);
    utimesSync(directory, date, date);
    oldIds.push(id);
  }
  const unknown = randomUUID();
  mkdirSync(path.join(f.backups, unknown), {mode: 0o700});
  writeFileSync(path.join(f.backups, unknown, 'unrecognized.bin'), 'keep', {mode: 0o600});
  const foreign = randomUUID(), foreignDirectory = path.join(f.backups, foreign);
  cpSync(originalDirectory, foreignDirectory, {recursive: true});
  chmodSync(foreignDirectory, 0o700);
  writeFileSync(path.join(foreignDirectory, 'manifest.json'), JSON.stringify({...originalManifest, projectId: randomUUID()}));

  const store = openProjectStore({...f.options, format4: {approveUpgrade: () => true}});
  try {
    assert.equal(store.db.prepare('SELECT version FROM project.schema_version').get()?.version, FORMAT4_PROJECT_SCHEMA_VERSION);
    assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
  } finally {store.close();}
  const managed = readdirSync(f.backups).filter(id => id !== unknown && id !== foreign);
  assert.equal(managed.length, FORMAT_UPGRADE_BACKUP_LIMIT);
  assert.ok(!managed.includes(original));
  assert.ok(oldIds.slice(1).every(id => managed.includes(id)));
  for (const id of managed) verifyFormat4Backup(path.join(f.backups, id), readFormat4BackupManifest(f.backups, id));
  assert.equal(readFileSync(path.join(f.backups, unknown, 'unrecognized.bin'), 'utf8'), 'keep');
  assert.ok(existsSync(foreignDirectory));
});

test('candidate cleanup under the upgrade lock removes owned remnants and preserves links and foreign files', t => {
  const f = fixture(t);
  mkdirSync(f.backups, {mode: 0o700});
  const pending = path.join(f.backups, '.pending-old001');
  const retired = path.join(f.backups, '.pending-prune-' + randomUUID());
  const unknown = path.join(f.backups, '.pending-old002');
  const hardlinked = path.join(f.backups, '.pending-old003');
  const symlinked = path.join(f.backups, '.pending-old004');
  for (const directory of [pending, retired, unknown, hardlinked, symlinked]) mkdirSync(directory, {mode: 0o700});
  for (const directory of [pending, retired, unknown]) writeFileSync(path.join(directory, 'project.mioon'), 'partial', {mode: 0o600});
  writeFileSync(path.join(unknown, 'manual.bin'), 'keep', {mode: 0o600});
  const unrelated = path.join(f.root, 'unrelated.bin');
  writeFileSync(unrelated, 'safe', {mode: 0o600});
  linkSync(unrelated, path.join(hardlinked, 'history.db'));
  symlinkSync(unrelated, path.join(symlinked, 'manifest.json'));

  openProjectStore(f.options).close();
  assert.ok(existsSync(pending), 'the default host never enters candidate maintenance');
  assert.throws(() => openProjectStore({...f.options, format4: {}}), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
  assert.ok(existsSync(pending), 'maintenance requires approved candidate upgrade');
  f.failAfterBackup();
  assert.ok(!existsSync(pending));
  assert.ok(!existsSync(retired));
  assert.equal(readFileSync(path.join(unknown, 'project.mioon'), 'utf8'), 'partial');
  assert.equal(readFileSync(path.join(hardlinked, 'history.db'), 'utf8'), 'safe');
  assert.equal(readFileSync(path.join(symlinked, 'manifest.json'), 'utf8'), 'safe');
  assert.equal(readFileSync(unrelated, 'utf8'), 'safe');
});

test('v1 backup verification rejects malformed manifests, hash mismatch and sidecars', t => {
  const f = fixture(t);
  f.failAfterBackup();
  const id = readdirSync(f.backups)[0]!, directory = path.join(f.backups, id);
  const manifest = readFormat4BackupManifest(f.backups, id);
  assert.throws(() => readFormat4BackupManifest(f.backups, '..'), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
  verifyFormat4Backup(directory, manifest);
  const staged = path.join(f.root, 'staged');
  mkdirSync(staged, {mode: 0o700});
  for (const file of manifest.files) cpSync(path.join(directory, file.name), path.join(staged, file.name));
  verifyFormat4Backup(staged, manifest);
  assert.throws(() => verifyFormat4Backup(directory, {...manifest, files: [
    {...manifest.files[0]!, sha256: 'a'.repeat(64)}, ...manifest.files.slice(1),
  ]}), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
  writeFileSync(path.join(directory, 'project.mioon-journal'), '', {mode: 0o600});
  assert.throws(() => verifyFormat4Backup(directory, manifest), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
  const manifestFile = path.join(directory, 'manifest.json');
  writeFileSync(manifestFile, '{"partial":');
  assert.throws(() => readFormat4BackupManifest(f.backups, id), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
  writeFileSync(manifestFile, JSON.stringify({...manifest, historyVersion: FORMAT4_HISTORY_SCHEMA_VERSION}));
  assert.throws(() => readFormat4BackupManifest(f.backups, id), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
});
