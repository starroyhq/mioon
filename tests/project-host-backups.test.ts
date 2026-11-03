import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectBackups} from '../apps/server/src/project-host/backups.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createMemoryProjectRegistry, createProjectHostManager, projectLocation, serverAppDirectories, statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createProjectBackup} from '../packages/business/src/project-file/backup.ts';
import type {ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';
import type {ProjectBackupsOptions} from '../apps/server/src/project-host/backups.ts';

async function setup(t: TestContext, options: Partial<Pick<ProjectBackupsOptions, 'backup' | 'slowMs'>> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'project-backups-'));
  const directories = serverAppDirectories(root), registry = createMemoryProjectRegistry();
  const warnings: string[] = [];
  const backups = createProjectBackups({directories, registry, identity: statProjectFileIdentity,
    assertProjectFile: createApplicationFileGuard(directories), onWarning: (_, code) => warnings.push(code), ...options});
  const log: string[] = [];
  const manager = createProjectHostManager({directories, registry, hooks: [backups.hooks],
    factory: async (): Promise<ProjectHostRuntime> => ({handle: async () => false, isBusy: () => false,
      interrupt: () => {log.push('interrupt');}, drain: async () => {log.push('drain');}, dispose: () => {log.push('dispose');}})});
  t.after(async () => {await manager.closeAll(); rmSync(root, {recursive: true, force: true});});
  const project = await manager.create({name: 'Backup test'});
  const store = openProjectStore({projectFile: project.projectFile, locate: id => projectLocation(directories, id)});
  try {ensureProjectRow(store, {name: 'Backup test'});} finally {store.close();}
  return {root, directories, registry, backups, manager, project, warnings, log};
}

test('real host backs up on open/after drain on close; unchanged reopen loops retain all three sequences', async t => {
  const calls: string[] = [];
  const f = await setup(t, {backup: async (store, target) => {calls.push('backup'); return createProjectBackup(store, target);}});
  const id = f.project.projectId;
  for (let round = 0; round < 4; round++) {
    const lease = await f.manager.acquire(id, 'window');
    const record = lease.host.store.get('projects', id) as {id: string; name: string};
    lease.host.store.tx(() => lease.host.store.put('projects', {...record, name: `Version ${round}`}));
    lease.release();
    await f.manager.close(id);
  }
  const list = await f.backups.list({projectId: id});
  assert.equal(list.backups.length, 3);
  assert.equal(new Set(list.backups.map(row => row.contentSequence)).size, 3);
  assert.ok(list.backups.every(row => row.reason === 'close'));
  assert.equal(calls.length, 5);
  assert.deepEqual(f.log.slice(-3), ['interrupt', 'drain', 'dispose']);
  const before = JSON.stringify(list);
  for (let round = 0; round < 4; round++) {
    const lease = await f.manager.acquire(id, 'window'); lease.release(); await f.manager.close(id);
  }
  assert.equal(JSON.stringify(await f.backups.list({projectId: id})), before);
  assert.equal(calls.length, 5);
  assert.equal(readdirSync(path.join(projectLocation(f.directories, id).localDir, 'backups')).filter(name => /^[0-9a-f-]{36}$/u.test(name)).length, 3);
  const inspection = await f.backups.inspect({projectId: id, backupId: list.backups[0]!.backupId});
  assert.equal(inspection.projectName, 'Version 3');
  assert.equal(inspection.tableCounts.projects, 1);
  assert.equal(inspection.sourceProjectDir, path.dirname(f.project.projectFile));
  const status = await f.backups.status({projectId: id});
  assert.equal(status.state, 'idle'); assert.equal(status.lastError, null); assert.ok(status.lastCompletedAt);
});

test('backup failure records exact code, keeps prior backups, and never blocks open or close', async t => {
  let fail = false;
  const f = await setup(t, {backup: async (store, target) => {
    if (fail) throw Object.assign(new Error('synthetic path must not leak'), {code: 'ENOSPC'});
    return createProjectBackup(store, target);
  }});
  const id = f.project.projectId, lease = await f.manager.acquire(id, 'window');
  const before = await f.backups.list({projectId: id});
  const record = lease.host.store.get('projects', id) as {id: string};
  lease.host.store.put('projects', {...record, name: 'Changed'});
  fail = true; lease.release(); await f.manager.close(id);
  assert.equal(f.manager.status(id), null);
  assert.deepEqual(await f.backups.list({projectId: id}), before);
  const status = await f.backups.status({projectId: id});
  assert.equal(status.state, 'failed'); assert.equal(status.lastError?.code, 'ENOSPC');
  assert.ok(!status.lastError?.message.includes('synthetic path')); assert.ok(f.warnings.includes('ENOSPC'));
  const again = await f.manager.acquire(id, 'window');
  assert.equal(again.host.store.get('projects', id) && f.manager.status(id)?.state, 'open');
  again.release(); await f.manager.close(id);
  assert.deepEqual(await f.backups.list({projectId: id}), before);
});

test('slow native copy remains running and keeps source connection held until completion', async t => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const f = await setup(t, {slowMs: 1, backup: async (store, target) => {entered.resolve(); await gate.promise; return createProjectBackup(store, target);}});
  const id = f.project.projectId, opening = f.manager.acquire(id, 'window');
  await entered.promise;
  assert.equal((await f.backups.status({projectId: id})).state, 'running');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.backups.status({projectId: id})).state, 'slow');
  gate.resolve(); const lease = await opening;
  assert.equal((await f.backups.status({projectId: id})).state, 'idle');
  assert.equal(lease.host.store.db.isOpen, true);
  lease.release(); await f.manager.close(id);
});

test('backup restores with a new ID and empty local records; request replay survives service restart and rotation', async t => {
  const f = await setup(t), id = f.project.projectId;
  const lease = await f.manager.acquire(id, 'window'); lease.release(); await f.manager.close(id);
  const backupId = (await f.backups.list({projectId: id})).backups[0]!.backupId;
  const target = path.join(f.directories.projectsDir, 'restored.mioon'), input = {projectId: id, backupId, requestId: randomUUID(), projectFile: target};
  const restored = await f.backups.restore(input);
  assert.notEqual(restored.project.projectId, id); assert.equal(restored.project.projectFile, target);
  assert.equal(f.registry.get(restored.project.projectId)?.lastOpenedAt, null);
  const local = projectLocation(f.directories, restored.project.projectId).localDir;
  assert.equal(existsSync(path.join(local, 'history.db')), false);
  const copy = openProjectStore({projectFile: target, locate: projectId => projectLocation(f.directories, projectId)});
  try {
    assert.equal(copy.projectId, restored.project.projectId);
    assert.equal((copy.get('projects', copy.projectId) as {name: string}).name, 'Backup test');
    assert.equal(Number(copy.db.prepare('SELECT count(*) n FROM main.mio_runs').get()?.n), 0);
  } finally {copy.close();}
  const restarted = createProjectBackups({directories: f.directories, registry: f.registry, identity: statProjectFileIdentity,
    assertProjectFile: createApplicationFileGuard(f.directories)});
  assert.deepEqual(await restarted.restore(input), restored);
  const opened = await f.manager.acquire(restored.project.projectId, 'window');
  assert.deepEqual(await restarted.restore(input), restored, 'replay does not open the new host database and preserves its original response');
  opened.release(); await f.manager.close(restored.project.projectId);
  await assert.rejects(restarted.restore({...input, projectFile: target + '.mioon'}), {code: 'REQUEST_ID_REUSED'});
  await assert.rejects(restarted.restore({...input, requestId: randomUUID()}), {code: 'PROJECT_FILE_EXISTS'});
  const recordRoot = path.join(projectLocation(f.directories, id).localDir, 'backups');
  // A receipt remains useful even after the source backup has rotated away.
  writeFileSync(path.join(recordRoot, 'index.json'), JSON.stringify({version: 1, projectId: id, backups: []}), {mode: 0o600});
  assert.deepEqual(await restarted.restore(input), restored);
  assert.equal(f.registry.list().length, 2);
});

test('a damaged latest backup cannot suppress a replacement at the same sequence; abandoned copies are cleaned on an unchanged open', async t => {
  const f = await setup(t), projectId = f.project.projectId;
  const lease = await f.manager.acquire(projectId, 'window'); lease.release(); await f.manager.close(projectId);
  const root = path.join(projectLocation(f.directories, projectId).localDir, 'backups');
  const first = (await f.backups.list({projectId})).backups[0]!;
  const original = path.join(root, first.backupId, 'project.mioon');
  writeFileSync(original, 'damaged', {mode: 0o600});
  assert.equal((await f.backups.list({projectId})).backups.length, 0);
  const again = await f.manager.acquire(projectId, 'window'); again.release(); await f.manager.close(projectId);
  const replacement = (await f.backups.list({projectId})).backups[0]!;
  assert.equal(replacement.contentSequence, first.contentSequence);
  assert.notEqual(replacement.backupId, first.backupId); assert.equal(existsSync(original), false);
  const orphan = path.join(root, randomUUID()); mkdirSync(orphan, {mode: 0o700});
  copyFileSync(path.join(root, replacement.backupId, 'project.mioon'), path.join(orphan, 'project.mioon'));
  const last = await f.manager.acquire(projectId, 'window'); last.release(); await f.manager.close(projectId);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual((await f.backups.list({projectId})).backups, [replacement]);
});

test('publication before receipt/registry completion reconciles without reopening an already acquired target', async t => {
  const f = await setup(t), projectId = f.project.projectId;
  const lease = await f.manager.acquire(projectId, 'window'); lease.release(); await f.manager.close(projectId);
  const backupId = (await f.backups.list({projectId})).backups[0]!.backupId;
  const input = {projectId, backupId, requestId: randomUUID(), projectFile: path.join(f.directories.projectsDir, 'reconciled.mioon')};
  const restored = await f.backups.restore(input);
  const receipt = path.join(projectLocation(f.directories, projectId).localDir, 'backups', 'restore-requests', `${input.requestId}.json`);
  const prior = JSON.parse(readFileSync(receipt, 'utf8'));
  writeFileSync(receipt, JSON.stringify({...prior, phase: 'prepared', fileIdentity: null, project: null}), {mode: 0o600});
  const opened = await f.manager.acquire(restored.project.projectId, 'window');
  const replayed = await f.backups.restore(input);
  assert.equal(replayed.project.projectId, restored.project.projectId);
  assert.equal(replayed.project.projectFile, restored.project.projectFile);
  assert.equal(opened.host.store.db.isOpen, true);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).phase, 'registered');
  opened.release(); await f.manager.close(restored.project.projectId);
});

test('malformed index and wrong owner backup refuse disclosure/restore and do not alter original', async t => {
  const f = await setup(t), id = f.project.projectId;
  const lease = await f.manager.acquire(id, 'window'); lease.release(); await f.manager.close(id);
  const list = await f.backups.list({projectId: id});
  await assert.rejects(f.backups.inspect({projectId: randomUUID(), backupId: list.backups[0]!.backupId}), {code: 'PROJECT_BACKUP_NOT_FOUND'});
  const file = path.join(projectLocation(f.directories, id).localDir, 'backups', 'index.json');
  writeFileSync(file, '{}', {mode: 0o600});
  await assert.rejects(f.backups.list({projectId: id}), {code: 'PROJECT_BACKUP_INDEX_INVALID'});
  assert.equal(f.registry.list().length, 1); assert.equal(existsSync(f.project.projectFile), true);
});
