import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync, type SQLOutputValue} from 'node:sqlite';
import {syncBuiltinESMExports} from 'node:module';
import {initializeWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {validateWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createOpacityCandidateWorkspaceBackup as create, verifyOpacityCandidateWorkspaceBackup as verify,
  restoreOpacityCandidateWorkspaceBackup as restore, inspectOpacityCandidateRestorePublication as status} from '../packages/business/src/opacity-candidate-backup.ts';
import {OPACITY_CANDIDATE_BACKUP_PROFILE as profile} from '../packages/business/src/opacity-candidate-backup-profile.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup, withVerifiedWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {inspectDatabase, buildWorkspaceInventory} from '../packages/business/src/workspace-backup-inventory.ts';
import {restoreWorkspaceBackup, inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.ts';
import {acquireWorkspaceLock} from '../packages/business/src/workspace-lock.ts';
import type { BinaryLike } from 'crypto';

// These bytes are deliberately not decoded: admission, copying and hashing are
// tested offline without a media executable, listener, service or provider.
const mediaBytes = Buffer.from('synthetic opacity archive boundary bytes');
const hash = (bytes: Buffer<ArrayBuffer>|BinaryLike) => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-10-16T00:00:00.000Z';
const backupInvalid = {code: 'WORKSPACE_BACKUP_DATABASE_INVALID'};
function fixture(t: test.TestContext, version = 42) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-backup-boundary-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const source = path.join(base, 'source'), backup = path.join(base, 'backup'), destination = path.join(base, 'restored');
  fs.mkdirSync(source, {mode: 0o700}); fs.mkdirSync(path.join(source, 'media'), {mode: 0o700});
  const database = path.join(source, 'workbench.sqlite'), db = new DatabaseSync(database);
  const projectId = randomUUID(), assetId = randomUUID(), relativePath = `media/${assetId}.png`;
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    if (version === 42) initializeWorkspaceSchema42(db); else initializeOpacityLegacyThrough40(db);
    const project = {id: projectId, name: 'Synthetic boundary project', revision: 1, createdAt: stamp, updatedAt: stamp};
    const asset = {id: assetId, projectId, name: 'Synthetic bytes', mimeType: 'image/png', width: 1, height: 1,
      hasVideo: false, hasAudio: false, sha256: hash(mediaBytes), sizeBytes: mediaBytes.length, relativePath, createdAt: stamp};
    db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId, JSON.stringify(project));
    db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId, projectId, JSON.stringify(asset));
  } finally {db.close();}
  fs.chmodSync(database, 0o600); fs.writeFileSync(path.join(source, relativePath), mediaBytes, {mode: 0o600});
  return {base, source, backup, destination, database, relativePath,
    capture: () => (create({source, destination: backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), restore: () => (restore({directory: backup, destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>)};
}
function tree(root: fs.PathLike): import('./helpers/strict-opacity-fixture-types.ts').BackupTreeEntry[]|null {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).sort().flatMap<import('./helpers/strict-opacity-fixture-types.ts').BackupTreeEntry>(name => {
    const target = path.join((root as unknown as Parameters<typeof path.join>[0]), name), info = fs.lstatSync(target);
    const record = {name, mode: info.mode, ino: info.ino, bytes: info.size};
    if (info.isSymbolicLink()) return [{...record, link: fs.readlinkSync(target)}];
    if (info.isDirectory()) return [{...record, children: tree(target)}];
    return [{...record, sha256: hash(fs.readFileSync(target))}];
  });
}
function refreshManifest(f: Awaited<ReturnType<typeof fixture>>, edit:(manifest:ReturnType<typeof import('../packages/contracts/src/workspace-backup.ts').workspaceBackupManifestSchema.parse>)=>unknown = () => {}) {
  const manifestPath = path.join(f.backup, 'manifest.json'), markerPath = path.join(f.backup, 'COMPLETE.json');
  const manifest = JSON.parse((fs.readFileSync(manifestPath) as unknown as string)) as ReturnType<typeof import('../packages/contracts/src/workspace-backup.ts').workspaceBackupManifestSchema.parse>, marker = JSON.parse((fs.readFileSync(markerPath) as unknown as string));
  edit(manifest);
  const raw = Buffer.from(JSON.stringify(manifest));
  marker.manifestSha256 = hash(raw); marker.fileCount = manifest.entries.length;
  marker.payloadBytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  fs.writeFileSync(manifestPath, raw); fs.writeFileSync(markerPath, JSON.stringify(marker));
}
function noPublication(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), false, 'no launchable database is published');
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false, 'only this operation lock is released');
}
function mainPath(db: import('node:sqlite').DatabaseSync) {return db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;}
const candidatePath = (f: Awaited<ReturnType<typeof fixture>>, file?: SQLOutputValue|undefined) => typeof file === 'string' && path.dirname(file) === f.destination && /^\.restore-.+\.sqlite$/u.test(path.basename(file));

test('candidate cold capture refuses an active owner lease without changing its identity or source', async t => {
  const f = fixture(t), lease = acquireWorkspaceLock(f.source), before = tree(f.source);
  try {
    await assert.rejects(f.capture(), {code: 'WORKSPACE_BACKUP_LOCKED'});
    assert.equal(lease.isOwned(), true); assert.deepEqual(tree(f.source), before); assert.equal(fs.existsSync(f.backup), false);
  } finally {assert.equal(lease.release(), true);}
});
for (const suffix of ['-wal', '-journal'] as const) test(`candidate capture refuses nonempty ${suffix} and never repairs it`, async t => {
  const f = fixture(t); fs.writeFileSync(f.database + suffix, 'unclean synthetic sidecar', {mode: 0o600});
  const before = tree(f.source);
  await assert.rejects(f.capture(), {code: 'WORKSPACE_BACKUP_NOT_COLD'});
  assert.deepEqual(tree(f.source), before); assert.equal(fs.existsSync(f.backup), false);
});

for (const kind of ['empty', 'nonempty'] as const) test(`candidate backup and restore never reuse an existing ${kind} target`, async t => {
  const f = fixture(t); await f.capture();
  fs.mkdirSync(f.destination, {mode: 0o700}); if (kind === 'nonempty') fs.writeFileSync(path.join(f.destination, 'sentinel'), 'preserved', {mode: 0o600});
  const before = tree(f.destination), archiveBefore = tree(f.backup);
  await assert.rejects(f.restore(), {code: 'WORKSPACE_RESTORE_DESTINATION_EXISTS'});
  await assert.rejects((create({source: f.source, destination: f.destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_DESTINATION_EXISTS'});
  assert.deepEqual(tree(f.destination), before); assert.deepEqual(tree(f.backup), archiveBefore);
});
for (const marker of ['workbench.sqlite', 'server.lock'] as const) test(`candidate restore refuses an existing workspace ancestor ${marker}`, async t => {
  const f = fixture(t); await f.capture(); const ancestor = path.join(f.base, 'existing-workspace');
  fs.mkdirSync(ancestor, {mode: 0o700}); fs.writeFileSync(path.join(ancestor, marker), 'existing unrelated marker', {mode: 0o600});
  const before = tree(ancestor), destination = path.join(ancestor, 'nested');
  await assert.rejects((restore({directory: f.backup, destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>), {code: 'WORKSPACE_RESTORE_DESTINATION_WORKSPACE_ANCESTOR'});
  assert.deepEqual(tree(ancestor), before); assert.equal(fs.existsSync(destination), false);
});

for (const kind of ['source-root', 'source-database', 'source-media', 'source-media-directory'] as const) test(`candidate capture refuses ${kind} symlinks without following or changing their targets`, async t => {
  const f = fixture(t), sentinel = path.join(f.base, 'outside'); fs.writeFileSync(sentinel, 'outside unchanged', {mode: 0o600});
  let source = f.source;
  if (kind === 'source-root') {source = path.join(f.base, 'source-alias'); fs.symlinkSync(f.source, source);}
  if (kind === 'source-database') {fs.renameSync(f.database, sentinel + '.sqlite'); fs.symlinkSync(sentinel + '.sqlite', f.database);}
  if (kind === 'source-media') {fs.unlinkSync(path.join(f.source, f.relativePath)); fs.symlinkSync(sentinel, path.join(f.source, f.relativePath));}
  if (kind === 'source-media-directory') {fs.renameSync(path.join(f.source, 'media'), path.join(f.base, 'outside-media')); fs.symlinkSync(path.join(f.base, 'outside-media'), path.join(f.source, 'media'));}
  const before = tree(f.base);
  await assert.rejects((create({source, destination: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'STORAGE_PRIVATE_REQUIRED'});
  assert.equal(fs.existsSync(path.join(f.backup, 'COMPLETE.json')), false); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside unchanged');
  assert.deepEqual(tree(f.source), before!.find((entry) => entry.name === 'source')!.children);
});
for (const kind of ['archive-root', 'archive-database', 'archive-media', 'target-root', 'target-parent'] as const) test(`candidate restore refuses ${kind} symlinks and preserves source/archive bytes`, async t => {
  const f = fixture(t); await f.capture(); let directory = f.backup, destination = f.destination;
  if (kind === 'archive-root') {directory = path.join(f.base, 'archive-alias'); fs.symlinkSync(f.backup, directory);}
  if (kind === 'archive-database' || kind === 'archive-media') {
    const payload = path.join(f.backup, 'payload', kind === 'archive-database' ? 'workbench.sqlite' : f.relativePath);
    const outside = path.join(f.base, 'outside-payload'); fs.renameSync(payload, outside); fs.symlinkSync(outside, payload);
  }
  if (kind === 'target-root') fs.symlinkSync(f.source, destination);
  if (kind === 'target-parent') {const alias = path.join(f.base, 'parent-alias'); fs.symlinkSync(f.base, alias); destination = path.join(alias, 'new-restored');}
  const sourceBefore = tree(f.source), backupBefore = tree(f.backup);
  await assert.rejects((restore({directory, destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>), {code: 'STORAGE_PRIVATE_REQUIRED'});
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  if (kind !== 'target-root') assert.equal(fs.existsSync(destination), false);
});
test('canonical path checks reject traversal and overlapping offline operations', async t => {
  const f = fixture(t); await f.capture(); const before = tree(f.source), archiveBefore = tree(f.backup);
  await assert.rejects((create({source: `${f.source}/../source`, destination: path.join(f.base, 'new-backup')}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_INVALID_PATH'});
  await assert.rejects((create({source: f.source, destination: path.join(f.source, 'nested')}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_INVALID_PATH'});
  await assert.rejects((restore({directory: `${f.backup}/../backup`, destination: f.destination}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>), {code: 'WORKSPACE_RESTORE_INVALID_PATH'});
  await assert.rejects((restore({directory: f.backup, destination: path.join(f.backup, 'nested')}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreResult>), {code: 'WORKSPACE_RESTORE_INVALID_PATH'});
  assert.deepEqual(tree(f.source), before); assert.deepEqual(tree(f.backup), archiveBefore); noPublication(f);
});
for (const payloadPath of ['payload/../outside', 'payload/media/../../outside', '/payload/workbench.sqlite', 'payload\\workbench.sqlite'] as const) test(`candidate archive rejects rehashed path traversal ${JSON.stringify(payloadPath)}`, async t => {
  const f = fixture(t); await f.capture(); refreshManifest(f, (((manifest: ReturnType<typeof import('../packages/contracts/src/workspace-backup.ts').workspaceBackupManifestSchema.parse>) => {manifest.entries.find((entry) => entry.role === 'asset')!.path = payloadPath;}) as unknown as Parameters<typeof refreshManifest>[1]));
  const before = tree(f.backup);
  await assert.rejects((verify({directory: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_CORRUPT'});
  await assert.rejects(f.restore(), {code: 'WORKSPACE_BACKUP_CORRUPT'});
  assert.deepEqual(tree(f.backup), before); noPublication(f);
});

for (const kind of ['database', 'media', 'manifest', 'complete', 'missing-complete', 'extra-file'] as const) test(`candidate verification and restore refuse damaged ${kind} without publication`, async t => {
  const f = fixture(t); await f.capture();
  if (kind === 'database') fs.appendFileSync(path.join(f.backup, 'payload/workbench.sqlite'), 'tampered');
  if (kind === 'media') fs.appendFileSync(path.join(f.backup, 'payload', f.relativePath), 'tampered');
  if (kind === 'manifest') fs.appendFileSync(path.join(f.backup, 'manifest.json'), ' ');
  if (kind === 'complete') fs.writeFileSync(path.join(f.backup, 'COMPLETE.json'), '{}');
  if (kind === 'missing-complete') fs.unlinkSync(path.join(f.backup, 'COMPLETE.json'));
  if (kind === 'extra-file') fs.writeFileSync(path.join(f.backup, 'unexpected'), 'unknown bytes', {mode: 0o600});
  const before = tree(f.backup), code = kind === 'missing-complete' ? 'WORKSPACE_BACKUP_INCOMPLETE' : 'WORKSPACE_BACKUP_CORRUPT';
  await assert.rejects((verify({directory: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code}); await assert.rejects(f.restore(), {code});
  assert.deepEqual(tree(f.backup), before); noPublication(f);
});
for (const draftPolicy of [undefined, 'included', 'restored'] as const) test(`candidate metadata requires the explicit excluded draft policy (${String(draftPolicy)})`, async t => {
  const f = fixture(t); await f.capture(); refreshManifest(f, (((manifest: { draftPolicy: string; }) => {if (draftPolicy === undefined) delete (manifest as unknown as Record<PropertyKey,unknown>).draftPolicy; else manifest.draftPolicy = draftPolicy;}) as unknown as Parameters<typeof refreshManifest>[1]));
  await assert.rejects((verify({directory: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_CORRUPT'});
  await assert.rejects(f.restore(), {code: 'WORKSPACE_BACKUP_CORRUPT'}); noPublication(f);
});
test('metadata42 cannot authorize a schema40 database even with recomputed payload, manifest and COMPLETE hashes', async t => {
  const f = fixture(t); await f.capture(); const old = fixture(t, 40), payload = path.join(f.backup, 'payload/workbench.sqlite');
  fs.copyFileSync(old.database, payload); refreshManifest(f, (((manifest: ReturnType<typeof import('../packages/contracts/src/workspace-backup.ts').workspaceBackupManifestSchema.parse>) => {const entry = manifest.entries.find((value) => value.role === 'database'); const bytes = fs.readFileSync(payload); entry!.sha256 = hash(bytes); entry!.bytes = bytes.length;}) as unknown as Parameters<typeof refreshManifest>[1]));
  const before = tree(f.backup), oldBefore = tree(old.source);
  await assert.rejects((verify({directory: f.backup}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityBackupResult>), {code: 'WORKSPACE_BACKUP_IO'});
  await assert.rejects(f.restore(), {code: 'WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED'});
  assert.deepEqual(tree(f.backup), before); assert.deepEqual(tree(old.source), oldBefore); noPublication(f);
});
test('candidate42 stays excluded from default backup/verify and old40 stays excluded from candidate capture', async t => {
  const f = fixture(t), before = tree(f.source);
  await assert.rejects((createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>));
  assert.deepEqual(tree(f.source), before); assert.equal(fs.existsSync(f.backup), false);
  await f.capture(); const backupBefore = tree(f.backup);
  await assert.rejects((verifyWorkspaceBackup({directory: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>), {code: 'WORKSPACE_BACKUP_CORRUPT'});
  assert.deepEqual(tree(f.backup), backupBefore);
  const old = fixture(t, 40), oldBefore = tree(old.source);
  await assert.rejects(old.capture()); assert.equal(fs.existsSync(old.backup), false); assert.deepEqual(tree(old.source), oldBefore);
});
test('copied, inherited, null and callback profiles are rejected before any path or database action', async () => {
  let callbacks = 0; const callback = () => {callbacks++; throw new Error('untrusted callback executed');};
  for (const fake of [null, {}, {...profile}, Object.create(profile), {readSchemaVersion: callback, requireSource: callback}, callback] as const) {
    await assert.rejects((createWorkspaceBackup({}, fake) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>), backupInvalid);
    await assert.rejects((verifyWorkspaceBackup({}, fake) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>), backupInvalid);
    await assert.rejects(withVerifiedWorkspaceBackup({}, undefined, fake), backupInvalid);
    assert.throws(() => inspectDatabase((null as unknown as Parameters<typeof inspectDatabase>[0]), fake), backupInvalid);
    await assert.rejects(buildWorkspaceInventory((({db: null}) as unknown as Parameters<typeof buildWorkspaceInventory>[0]), fake), backupInvalid);
    await assert.rejects((restoreWorkspaceBackup({}, fake) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>), {code: 'WORKSPACE_RESTORE_DATABASE_INVALID'});
    await assert.rejects((inspectWorkspaceRestorePublication({}, fake) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreStatus>), {code: 'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
  }
  assert.equal(callbacks, 0);
});

for (const point of ['copy', 'ddl', 'validation'] as const) test(`candidate restore ${point} failure retains only an unpublished candidate and leaves originals unchanged`, async t => {
  const f = fixture(t); await f.capture(); const sourceBefore = tree(f.source), backupBefore = tree(f.backup); let fired = 0;
  const nativePrepare = DatabaseSync.prototype.prepare, nativeExec = DatabaseSync.prototype.exec;
  if (point === 'copy') {
    const nativeOpen = fs.openSync, nativeWrite = fs.writeSync, nativeClose = fs.closeSync, descriptors = new Map();
    t.mock.method(fs, 'openSync', (function(this:typeof fs,file: Parameters<typeof fs.openSync>[0], ...args: Parameters<typeof fs.openSync> extends [unknown,...infer Tail]?Tail:never) {const fd = nativeOpen(file, ...args); descriptors.set(fd, String(file)); return fd;} as unknown as typeof fs.openSync));
    t.mock.method(fs, 'closeSync', (function(this:typeof fs,fd: Parameters<typeof fs.closeSync>[0]) {descriptors.delete(fd); return nativeClose(fd);} as unknown as typeof fs.closeSync));
    t.mock.method(fs, 'writeSync', (function(this:typeof fs,fd: Parameters<typeof fs.writeSync>[0], ...args: Parameters<typeof fs.writeSync> extends [unknown,...infer Tail]?Tail:never) {if (!fired && candidatePath(f, descriptors.get(fd))) {fired++; throw Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), {code: 'EIO'});} return nativeWrite(fd, ...args);} as unknown as typeof fs.writeSync));
    syncBuiltinESMExports();
  } else if (point === 'ddl') {
    t.mock.method(DatabaseSync.prototype, 'exec', (function(this:typeof DatabaseSync.prototype,sql: Parameters<typeof DatabaseSync.prototype.exec>[0], ...args: Parameters<typeof DatabaseSync.prototype.exec> extends [unknown,...infer Tail]?Tail:never) {
      const file = Reflect.apply(nativePrepare, this, ['PRAGMA database_list']).all().find(row => row.name === 'main')?.file;
      if (!fired && candidatePath(f, file) && sql.includes('CREATE TABLE workspace_restoration')) {fired++; throw new Error('SYNTHETIC_PRIVATE_ERROR');}
      return Reflect.apply(nativeExec, this, [sql, ...args]);
    } as unknown as typeof DatabaseSync.prototype.exec));
  } else {
    const nativeClose = DatabaseSync.prototype.close;
    t.mock.method(DatabaseSync.prototype, 'close', (function(this:typeof DatabaseSync.prototype,...args: Parameters<typeof DatabaseSync.prototype.close> extends [...infer Tail]?Tail:never) {
      const file = mainPath((this as unknown as Parameters<typeof mainPath>[0]));
      if (!fired && candidatePath(f, file) && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='workspace_restoration'").get()) {
        fired++; Reflect.apply(nativeExec, this, ['CREATE TABLE synthetic_invalid_candidate(value TEXT)']);
      }
      return Reflect.apply(nativeClose, this, args);
    } as unknown as typeof DatabaseSync.prototype.close));
  }
  try {await assert.rejects(f.restore(), error => /^WORKSPACE_RESTORE_(IO|SOURCE_SCHEMA_UNSUPPORTED|DATABASE_INVALID)$/u.test((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code) && !(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).message.includes('SYNTHETIC_PRIVATE_ERROR'));}
  finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.equal(fired, 1); noPublication(f); assert.equal(fs.existsSync(f.destination), true);
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
});
for (const point of ['directory-sync', 'link-ack'] as const) test(`candidate ${point} failure reports uncertain publication without rollback or automatic repair`, async t => {
  const f = fixture(t); await f.capture(); const sourceBefore = tree(f.source), backupBefore = tree(f.backup);
  const nativeLink = fs.linkSync, nativeSync = fs.fsyncSync; let linked = false, fired = 0, outcome;
  t.mock.method(fs, 'linkSync', (function(this:typeof fs,from: Parameters<typeof fs.linkSync>[0], to: Parameters<typeof fs.linkSync>[1], ...args: Parameters<typeof fs.linkSync> extends [unknown,unknown,...infer Tail]?Tail:never) {
    const result = nativeLink(from, to, ...args);
    if (to === path.join(f.destination, 'workbench.sqlite')) {linked = true; if (point === 'link-ack') {fired++; throw Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), {code: 'EIO'});}}
    return result;
  } as unknown as typeof fs.linkSync));
  t.mock.method(fs, 'fsyncSync', (function(this:typeof fs,fd: Parameters<typeof fs.fsyncSync>[0]) {
    if (point === 'directory-sync' && linked && !fired) {
      const info = fs.fstatSync(fd), directory = fs.statSync(f.destination);
      if (info.isDirectory() && info.dev === directory.dev && info.ino === directory.ino) {fired++; throw Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), {code: 'EIO'});}
    }
    return nativeSync(fd);
  } as unknown as typeof fs.fsyncSync)); syncBuiltinESMExports();
  try {await assert.rejects(f.restore(), error => {outcome = error; return (error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code === 'WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED' && (error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication?.state === 'unconfirmed' && !(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).message.includes('SYNTHETIC_PRIVATE_ERROR');});}
  finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.equal(fired, 1); const final = path.join(f.destination, 'workbench.sqlite'); assert.equal(fs.existsSync(final), true);
  assert.equal(fs.statSync(final).nlink, point === 'link-ack' ? 2 : 1);
  const targetBefore = tree(f.destination), {state: ignored, ...binding} = outcome!.publication;
  if (point === 'directory-sync') {const observed = await (status({destination: f.destination, ...binding}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreStatus>); assert.equal(observed.publication, 'observed_guarded'); assert.equal(observed.durability, 'not_reconfirmed');}
  else await assert.rejects((status({destination: f.destination, ...binding}) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityRestoreStatus>), {code: 'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
  assert.deepEqual(tree(f.destination), targetBefore, 'status does not repair an uncertain destination');
  // A separate task-owned single-link proof leaves the uncertain target intact.
  const proof = path.join(f.base, 'guarded-proof.sqlite'); fs.copyFileSync(final, proof);
  const db = new DatabaseSync(proof, {readOnly: true}); try {assert.equal(validateWorkspaceRestoreSchemaV43(db).schemaVersion, 43);} finally {db.close();}
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
});
