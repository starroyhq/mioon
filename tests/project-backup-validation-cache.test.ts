import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectBackups} from '../apps/server/src/project-host/backups.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createMemoryProjectRegistry, createProjectHostManager, projectLocation, serverAppDirectories, statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import {openProjectBackup} from '../packages/business/src/project-file/backup.ts';
import type {ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'project-backup-cache-'));
  const directories = serverAppDirectories(root), registry = createMemoryProjectRegistry();
  const validations: string[] = [];
  const options = {directories, registry, identity: statProjectFileIdentity, assertProjectFile: createApplicationFileGuard(directories), onWarning: () => {},
    openBackup: (file: string) => {validations.push(file); return openProjectBackup(file);}};
  let backups = createProjectBackups(options);
  const manager = createProjectHostManager({directories, registry, hooks: [{afterOpen: host => backups.hooks.afterOpen?.(host), beforeClose: host => backups.hooks.beforeClose?.(host)}],
    factory: async (): Promise<ProjectHostRuntime> => ({handle: async () => false, isBusy: () => false, interrupt: () => {}, drain: async () => {}, dispose: () => {}})});
  t.after(async () => {await manager.closeAll(); fs.rmSync(root, {recursive: true, force: true});});
  const project = await manager.create({name: 'Validation cache'}), projectId = project.projectId;
  const store = openProjectStore({projectFile: project.projectFile, locate: id => projectLocation(directories, id)});
  try {ensureProjectRow(store, {name: 'Validation cache'});} finally {store.close();}
  const reopen = async () => {const lease = await manager.acquire(projectId, 'window'); lease.release(); await manager.close(projectId);};
  for (let round = 0; round < 3; round++) {
    const lease = await manager.acquire(projectId, 'window');
    const row = lease.host.store.get('projects', projectId) as {id: string; name: string};
    lease.host.store.put('projects', {...row, name: `Revision ${round}`});
    lease.release(); await manager.close(projectId);
  }
  const saved = await backups.list({projectId});
  assert.equal(saved.backups.length, 3);
  const fileFor = (backupId: string) => path.join(projectLocation(directories, projectId).localDir, 'backups', backupId, 'project.mioon');
  return {root, directories, projectId, saved, fileFor, validations, reopen,
    get backups() {return backups;}, cold: () => {backups = createProjectBackups(options); validations.length = 0;}};
}

test('unchanged cold open validates only the latest copy, warm opens reuse identity results, and list still confirms all copies', async t => {
  const f = await fixture(t);
  assert.equal(f.validations.length, 0, 'native creation has already validated each published copy');
  f.cold(); await f.reopen();
  assert.deepEqual(f.validations, [f.fileFor(f.saved.backups[0]!.backupId)]);
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), f.saved);
  assert.equal(f.validations.length, 3, 'list verifies the two older copies which the open did not use');
  await f.reopen(); await f.reopen();
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), f.saved);
  assert.equal(f.validations.length, 3, 'unchanged metadata requires no further complete validation');
  const inspected = await f.backups.inspect({projectId: f.projectId, backupId: f.saved.backups[0]!.backupId});
  assert.equal(inspected.projectName, 'Revision 2');
  assert.equal(f.validations.length, 4, 'explicit inspection still opens a verified read-only reader');
});

test('latest-only dedup does not report an unchecked damaged older file as valid; failures are never cached', async t => {
  const f = await fixture(t), latest = f.saved.backups[0]!, older = f.saved.backups[1]!;
  fs.writeFileSync(f.fileFor(older.backupId), 'damaged', {mode: 0o600});
  f.cold(); await f.reopen();
  assert.deepEqual(f.validations, [f.fileFor(latest.backupId)], 'unchanged opening never opens an older unused copy');
  const listed = await f.backups.list({projectId: f.projectId});
  assert.deepEqual(listed.backups, f.saved.backups.filter(entry => entry.backupId !== older.backupId));
  assert.equal(f.validations.filter(file => file === f.fileFor(older.backupId)).length, 1);
  assert.deepEqual(await f.backups.list({projectId: f.projectId}), listed);
  assert.equal(f.validations.filter(file => file === f.fileFor(older.backupId)).length, 2, 'a bad result is retried rather than remembered as valid');
  fs.writeFileSync(f.fileFor(latest.backupId), 'damaged too', {mode: 0o600});
  await f.reopen();
  const replacement = (await f.backups.list({projectId: f.projectId})).backups[0]!;
  assert.notEqual(replacement.backupId, latest.backupId);
  assert.equal(replacement.contentSequence, latest.contentSequence, 'a broken cached latest copy cannot suppress a replacement');
  assert.equal(fs.existsSync(f.fileFor(latest.backupId)), false);
});

test('mtime, inode replacement and index identity changes invalidate a success cache', async t => {
  const f = await fixture(t), latest = f.saved.backups[0]!, file = f.fileFor(latest.backupId);
  f.cold(); await f.reopen();
  const first = fs.lstatSync(file), initialCalls = f.validations.length;
  fs.utimesSync(file, first.atime, new Date(first.mtimeMs + 2000));
  await f.reopen(); assert.equal(f.validations.length, initialCalls + 1);
  const bytes = fs.readFileSync(file), oldInode = fs.lstatSync(file).ino;
  const replacement = path.join(path.dirname(file), 'replacement');
  fs.writeFileSync(replacement, bytes, {mode: 0o600});
  fs.renameSync(replacement, file);
  assert.notEqual(fs.lstatSync(file).ino, oldInode);
  await f.reopen(); assert.equal(f.validations.length, initialCalls + 2);
  const indexFile = path.join(path.dirname(path.dirname(file)), 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.backups[0].contentSequence++;
  fs.writeFileSync(indexFile, JSON.stringify(index), {mode: 0o600});
  const listed = await f.backups.list({projectId: f.projectId});
  assert.ok(!listed.backups.some(entry => entry.backupId === latest.backupId), 'an index entry cannot borrow a different sequence from an already validated file');
  assert.equal(f.validations.length, initialCalls + 5, 'changed index context revalidates latest; list also checks both older copies');
});

test('cache hits still reject permission changes and hard links before opening SQLite', async t => {
  const f = await fixture(t), latest = f.saved.backups[0]!, file = f.fileFor(latest.backupId);
  f.cold(); await f.backups.list({projectId: f.projectId}); const calls = f.validations.length;
  fs.chmodSync(file, 0o644);
  assert.equal((await f.backups.list({projectId: f.projectId})).backups.length, 2);
  assert.equal(f.validations.length, calls, 'the private guard rejects unsafe mode before the opener');
  fs.chmodSync(file, 0o600);
  assert.equal((await f.backups.list({projectId: f.projectId})).backups.length, 3);
  assert.equal(f.validations.length, calls + 1);
  const alias = path.join(f.root, randomUUID()); fs.linkSync(file, alias);
  assert.equal((await f.backups.list({projectId: f.projectId})).backups.length, 2);
  assert.equal(f.validations.length, calls + 1, 'the private guard rejects nlink=2 before the opener');
  fs.unlinkSync(alias);
  assert.equal((await f.backups.list({projectId: f.projectId})).backups.length, 3);
  assert.equal(f.validations.length, calls + 2);
});

test('an index token cannot borrow a warm validation result and malformed tokens never reach the reader',async t=>{
 const f=await fixture(t),latest=f.saved.backups[0]!,indexFile=path.join(path.dirname(path.dirname(f.fileFor(latest.backupId))),'index.json');
 f.cold();await f.backups.list({projectId:f.projectId});const calls=f.validations.length;
 const index=JSON.parse(fs.readFileSync(indexFile,'utf8'));assert.equal(index.version,2);
 index.backups[0].contentToken=latest.contentToken==='0'.repeat(32)?'1'.repeat(32):'0'.repeat(32);
 fs.writeFileSync(indexFile,JSON.stringify(index),{mode:0o600});
 const listed=await f.backups.list({projectId:f.projectId});
 assert.deepEqual(listed.backups,f.saved.backups.slice(1));assert.equal(f.validations.length,calls+1);
 await assert.rejects(f.backups.inspect({projectId:f.projectId,backupId:latest.backupId}),{code:'PROJECT_BACKUP_CHANGED'});
 const beforeInvalid=f.validations.length;index.backups[0].contentToken='A'.repeat(32);fs.writeFileSync(indexFile,JSON.stringify(index),{mode:0o600});
 await assert.rejects(f.backups.list({projectId:f.projectId}),{code:'PROJECT_BACKUP_INDEX_INVALID'});assert.equal(f.validations.length,beforeInvalid);
});

test('a newly appearing journal cannot borrow an unchanged file validation cache',async t=>{
 const f=await fixture(t),latest=f.saved.backups[0]!,file=f.fileFor(latest.backupId),journal=file+'-journal';
 f.cold();await f.backups.list({projectId:f.projectId});const calls=f.validations.length;
 fs.writeFileSync(journal,'unconfirmed journal',{mode:0o600});const before=fs.readFileSync(journal);
 assert.deepEqual((await f.backups.list({projectId:f.projectId})).backups,f.saved.backups.slice(1));assert.equal(f.validations.length,calls);
 await assert.rejects(f.backups.inspect({projectId:f.projectId,backupId:latest.backupId}),{code:'PROJECT_BACKUP_CHANGED'});assert.deepEqual(fs.readFileSync(journal),before);
 fs.unlinkSync(journal);assert.deepEqual(await f.backups.list({projectId:f.projectId}),f.saved);assert.equal(f.validations.length,calls+1);
});

test('a new inode generation cannot inherit validation even when dev/ino/size/mtime are reused', async t => {
  const f = await fixture(t), file = f.fileFor(f.saved.backups[0]!.backupId);
  const lstat = fs.lstatSync; let generation = 1n;
  t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const info = Reflect.apply(lstat, fs, args);
    const stack=new Error().stack?.replaceAll('\\','/')??'';
    // Simulate the cache's observed generation, leaving the independent
    // descriptor-versus-path checks of the full reader on real fs metadata.
    if (String(args[0]) !== file || !args[1]?.bigint || !stack.includes('/project-host/backups.ts') || stack.includes('/project-file/backup.ts')) return info;
    if (!info) return info;
    return new Proxy(info, {get: (target, property, receiver) => property === 'ctimeNs' || property === 'birthtimeNs'
      ? Reflect.get(target, property, receiver) + generation : Reflect.get(target, property, receiver)});
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  f.cold(); await f.reopen(); assert.equal(f.validations.length, 1);
  await f.reopen(); assert.equal(f.validations.length, 1);
  generation++;
  await f.reopen(); assert.equal(f.validations.length, 2, 'new birth/ctime forces an actual complete validation despite the reused four-field identity');
});
