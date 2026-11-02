import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectBackups} from '../apps/server/src/project-host/backups.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createMemoryProjectRegistry, createProjectHostManager, projectLocation, serverAppDirectories, statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';
import type {ProjectRegistryPort} from '../apps/server/src/project-host/ports.ts';

const ioError = (message: string) => Object.assign(new Error(message), {code: 'EIO'});
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fixture(t: TestContext, registry: ProjectRegistryPort = createMemoryProjectRegistry()) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'project-backup-fault-'));
  const directories = serverAppDirectories(root);
  const options = {directories, registry, identity: statProjectFileIdentity, assertProjectFile: createApplicationFileGuard(directories), onWarning: () => {}};
  const backups = createProjectBackups(options);
  const manager = createProjectHostManager({directories, registry, hooks: [backups.hooks], factory: async (): Promise<ProjectHostRuntime> => ({
    handle: async () => false, isBusy: () => false, interrupt: () => {}, drain: async () => {}, dispose: () => {},
  })});
  t.after(async () => {await manager.closeAll(); fs.rmSync(root, {recursive: true, force: true});});
  const project = await manager.create({name: 'Fault windows'});
  const store = openProjectStore({projectFile: project.projectFile, locate: id => projectLocation(directories, id)});
  try {ensureProjectRow(store, {name: 'Fault windows'});} finally {store.close();}
  const projectId = project.projectId, backupRoot = path.join(projectLocation(directories, projectId).localDir, 'backups');
  const change = async (name: string) => {
    const lease = await manager.acquire(projectId, 'window');
    const row = lease.host.store.get('projects', projectId) as {id: string; name: string};
    lease.host.store.tx(() => lease.host.store.put('projects', {...row, name}));
    lease.release();
  };
  const unchanged = async () => {const lease = await manager.acquire(projectId, 'window'); lease.release(); await manager.close(projectId);};
  const seed = async () => {
    for (let round = 0; round < 3; round++) {await change(`Version ${round}`); await manager.close(projectId);}
    const saved = await backups.list({projectId});
    assert.equal(saved.backups.length, 3);
    assert.equal(new Set(saved.backups.map(backup => backup.contentSequence)).size, 3);
    return saved;
  };
  const copyFile = (backupId: string) => path.join(backupRoot, backupId, 'project.mioon');
  const ownedDirectories = () => fs.readdirSync(backupRoot).filter(name => /^[0-9a-f-]{36}$/u.test(name)).sort();
  return {root, directories, registry, options, backups, manager, projectId, project, backupRoot, change, unchanged, seed, copyFile, ownedDirectories};
}

test('failed index rename preserves the committed three backups byte-for-byte and does not block close', async t => {
  const f = await fixture(t), before = await f.seed();
  const indexFile = path.join(f.backupRoot, 'index.json'), indexBytes = fs.readFileSync(indexFile);
  const originals = before.backups.map(backup => ({backupId: backup.backupId, hash: hash(f.copyFile(backup.backupId))}));
  await f.change('Unpublished new content');
  const rename = fs.renameSync; let injected = 0;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === indexFile) {injected++; throw ioError('index rename failed');}
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {await f.manager.close(f.projectId);} finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.equal(injected, 1);
  assert.equal(f.manager.status(f.projectId), null);
  assert.deepEqual(fs.readFileSync(indexFile), indexBytes);
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), before);
  for (const original of originals) assert.equal(hash(f.copyFile(original.backupId)), original.hash);
  assert.deepEqual(f.ownedDirectories(), originals.map(row => row.backupId).sort());
  const status = await f.backups.status({projectId: f.projectId});
  assert.equal(status.state, 'failed');
  assert.equal(status.lastError?.code, 'STORAGE_PRIVATE_REQUIRED');
});

test('cleanup failure after index publication keeps the new three readable and an unchanged capture removes the orphan', async t => {
  const f = await fixture(t), before = await f.seed();
  const oldest = before.backups.at(-1)!.backupId;
  await f.change('Committed before cleanup');
  const rmdir = fs.rmdirSync; let injected = 0;
  t.mock.method(fs, 'rmdirSync', (directory: fs.PathLike, options?: fs.RmDirOptions) => {
    if (String(directory) === path.join(f.backupRoot, oldest)) {injected++; throw ioError('old copy directory cleanup failed');}
    return rmdir(directory, options);
  });
  syncBuiltinESMExports();
  try {await f.manager.close(f.projectId);} finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.equal(injected, 1);
  assert.equal(f.manager.status(f.projectId), null);
  const committed = await f.backups.list({projectId: f.projectId});
  assert.equal(committed.backups.length, 3);
  assert.notEqual(committed.backups[0]!.backupId, before.backups[0]!.backupId);
  assert.deepEqual(committed.backups.slice(1), before.backups.slice(0, 2));
  assert.equal(fs.existsSync(path.join(f.backupRoot, oldest)), true);
  for (const backup of committed.backups) assert.equal((await f.backups.inspect({projectId: f.projectId, backupId: backup.backupId})).contentSequence, backup.contentSequence);
  const failed = await f.backups.status({projectId: f.projectId});
  assert.equal(failed.state, 'failed'); assert.equal(failed.lastError?.code, 'EIO');
  assert.equal(failed.lastCompletedAt, committed.backups[0]!.createdAt);
  await f.unchanged();
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), committed);
  assert.equal(fs.existsSync(path.join(f.backupRoot, oldest)), false);
  assert.deepEqual(f.ownedDirectories(), committed.backups.map(row => row.backupId).sort());
  assert.equal((await f.backups.status({projectId: f.projectId})).state, 'idle');
});

test('strict backup-directory sync failure after index publication prevents deleting any previous copy', async t => {
  const f = await fixture(t), before = await f.seed();
  const originals = before.backups.map(backup => ({backupId: backup.backupId, hash: hash(f.copyFile(backup.backupId))}));
  await f.change('Needs durable directory entry');
  const sync = fs.fsyncSync, rootIdentity = fs.statSync(f.backupRoot, {bigint: true}); let injected = 0;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const current = fs.fstatSync(fd, {bigint: true});
    if (current.isDirectory() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino) {injected++; throw ioError('backup directory sync failed');}
    return sync(fd);
  });
  syncBuiltinESMExports();
  try {await f.manager.close(f.projectId);} finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.ok(injected >= 2, 'the generic atomic writer swallows directory sync errors; the backup-specific strict sync must still fail');
  assert.equal(f.manager.status(f.projectId), null);
  const committed = await f.backups.list({projectId: f.projectId});
  assert.equal(committed.backups.length, 3);
  assert.notEqual(committed.backups[0]!.backupId, before.backups[0]!.backupId);
  for (const original of originals) assert.equal(hash(f.copyFile(original.backupId)), original.hash);
  assert.equal(f.ownedDirectories().length, 4, 'the old unindexed copy remains until the new index is durably synced');
  for (const backup of committed.backups) assert.equal((await f.backups.inspect({projectId: f.projectId, backupId: backup.backupId})).contentSequence, backup.contentSequence);
  const status = await f.backups.status({projectId: f.projectId});
  assert.equal(status.state, 'failed'); assert.equal(status.lastError?.code, 'EIO');
  await f.unchanged();
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), committed);
  assert.deepEqual(f.ownedDirectories(), committed.backups.map(row => row.backupId).sort());
});

test('registration failure leaves a published restore intent whose retry registers the same inode without copying again', async t => {
  const base = createMemoryProjectRegistry(); let failNext = false, injected = 0;
  const registry: ProjectRegistryPort = {...base, upsert: entry => {
    if (failNext) {failNext = false; injected++; throw ioError('registry temporarily unavailable');}
    base.upsert(entry);
  }};
  const f = await fixture(t, registry);
  await f.unchanged();
  const backupId = (await f.backups.list({projectId: f.projectId})).backups[0]!.backupId;
  const input = {projectId: f.projectId, backupId, requestId: randomUUID(), projectFile: path.join(f.directories.projectsDir, 'recover-once.mioon')};
  const link = fs.linkSync; let publications = 0;
  t.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === input.projectFile) {publications++; assert.equal(publications, 1, 'retry must not publish another file');}
    return link(source, destination);
  });
  syncBuiltinESMExports();
  try {
    failNext = true;
    await assert.rejects(f.backups.restore(input), {code: 'EIO'});
    assert.equal(injected, 1); assert.equal(publications, 1);
    assert.equal(registry.list().length, 1);
    const intentFile = path.join(f.backupRoot, 'restore-requests', `${input.requestId}.json`);
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8')) as {phase: string; projectId: string};
    assert.equal(intent.phase, 'published');
    const publishedIdentity = statProjectFileIdentity(input.projectFile), publishedHash = hash(input.projectFile);
    assert.ok(publishedIdentity);
    const restarted = createProjectBackups(f.options);
    const result = await restarted.restore(input);
    assert.equal(result.project.projectId, intent.projectId);
    assert.deepEqual(result.project.fileIdentity, publishedIdentity);
    assert.deepEqual(statProjectFileIdentity(input.projectFile), publishedIdentity);
    assert.equal(hash(input.projectFile), publishedHash);
    assert.equal(publications, 1); assert.equal(registry.list().length, 2);
    assert.equal(JSON.parse(fs.readFileSync(intentFile, 'utf8')).phase, 'registered');
    assert.deepEqual(await restarted.restore(input), result);
    assert.equal(publications, 1);
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});
