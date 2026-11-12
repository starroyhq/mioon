import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectBackups} from '../apps/server/src/project-host/backups.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {createMemoryProjectRegistry, createProjectHostManager, projectLocation, serverAppDirectories, statProjectFileIdentity} from '../apps/server/src/project-host/index.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createProjectBackup,inspectProjectBackup,inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {ProjectHostRuntime} from '../apps/server/src/project-host/host.ts';
import type {ProjectBackupsOptions} from '../apps/server/src/project-host/backups.ts';

async function setup(t: TestContext, options: Partial<Pick<ProjectBackupsOptions, 'backup' | 'slowMs' | 'outsidePaths' | 'targetFormat'>> = {}) {
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
  const pairBefore=opened.host.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get()!;
  opened.host.store.put('projects',{id:restored.project.projectId,name:'Edited after restore'});
  const pairAfter=opened.host.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get()!;
  assert.ok(Number(pairAfter.contentSequence)>Number(pairBefore.contentSequence));assert.notEqual(pairAfter.contentToken,pairBefore.contentToken);
  assert.deepEqual(await restarted.restore(input), restored, 'replay does not open the new host database and preserves its original response');
  assert.equal((opened.host.store.get('projects',restored.project.projectId) as {name:string}).name,'Edited after restore');
  assert.deepEqual(opened.host.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get(),pairAfter);
  opened.release(); await f.manager.close(restored.project.projectId);
  await assert.rejects(restarted.restore({...input, projectFile: target + '.mioon'}), {code: 'REQUEST_ID_REUSED'});
  await assert.rejects(restarted.restore({...input, requestId: randomUUID()}), {code: 'PROJECT_FILE_EXISTS'});
  const recordRoot = path.join(projectLocation(f.directories, id).localDir, 'backups');
  // A receipt remains useful even after the source backup has rotated away.
  writeFileSync(path.join(recordRoot, 'index.json'), JSON.stringify({version: 1, projectId: id, backups: []}), {mode: 0o600});
  assert.deepEqual(await restarted.restore(input), restored);
  assert.equal(f.registry.list().length, 2);
});

test('trusted backup restore publishes a format 4 target without changing its format 3 backup', async t => {
  const f = await setup(t, {targetFormat: FORMAT4_PROJECT_SCHEMA_VERSION}), projectId = f.project.projectId;
  const lease = await f.manager.acquire(projectId, 'window'); lease.release(); await f.manager.close(projectId);
  const backupId = (await f.backups.list({projectId})).backups[0]!.backupId;
  const backupFile = path.join(projectLocation(f.directories, projectId).localDir, 'backups', backupId, 'project.mioon');
  const before = readFileSync(backupFile);
  assert.equal(inspectProjectBackup(backupFile).formatVersion, PROJECT_FILE_SCHEMA_VERSION);
  const projectFile = path.join(f.directories.projectsDir, 'format4-restored.mioon');
  const input = {projectId, backupId, requestId: randomUUID(), projectFile}, restored = await f.backups.restore(input);
  assert.equal(inspectCopiedProjectFile(projectFile).formatVersion, FORMAT4_PROJECT_SCHEMA_VERSION);
  assert.notEqual(restored.project.projectId, projectId);
  assert.equal(existsSync(projectLocation(f.directories, restored.project.projectId).localDir), false);
  const store = openProjectStore({projectFile, locate: id => projectLocation(f.directories, id), format4: {}});
  try {
    assert.equal(store.historyState, 'fresh');
    assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT4_HISTORY_SCHEMA_VERSION);
    assert.deepEqual(await f.backups.restore(input), restored);
  } finally {store.close();}
  assert.deepEqual(readFileSync(backupFile), before);
});

test('a validated same-sequence fork with a different token cannot suppress the current file backup',async t=>{
 const f=await setup(t),projectId=f.project.projectId,lease=await f.manager.acquire(projectId,'window');
 const initial=(await f.backups.list({projectId})).backups[0]!;
 lease.host.store.put('projects',{id:projectId,name:'Current branch'});lease.release();await f.manager.close(projectId);
 const current=(await f.backups.list({projectId})).backups[0]!,root=path.join(projectLocation(f.directories,projectId).localDir,'backups');
 const oldFile=path.join(root,initial.backupId,'project.mioon'),currentFile=path.join(root,current.backupId,'project.mioon');
 copyFileSync(oldFile,currentFile);
 const fork=new DatabaseSync(currentFile);try{fork.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({id:projectId,name:'Other branch'}),projectId);}finally{fork.close();}
 const actual=inspectProjectBackup(currentFile);assert.equal(actual.contentSequence,current.contentSequence);assert.notEqual(actual.contentToken,current.contentToken);
 const indexFile=path.join(root,'index.json'),index=JSON.parse(readFileSync(indexFile,'utf8'));
 index.backups[0].contentToken=actual.contentToken;index.backups[0].sizeBytes=actual.sizeBytes;writeFileSync(indexFile,JSON.stringify(index),{mode:0o600});
 assert.equal((await f.backups.list({projectId})).backups[0]!.contentToken,actual.contentToken,'the alternative branch is a real valid copy');
 const reopened=await f.manager.acquire(projectId,'window');reopened.release();await f.manager.close(projectId);
 const listed=(await f.backups.list({projectId})).backups;
 assert.equal(listed.length,3);assert.equal(listed[0]!.contentSequence,listed[1]!.contentSequence);assert.equal(listed[0]!.contentToken,current.contentToken);
 assert.equal(listed[1]!.contentToken,actual.contentToken);assert.notEqual(listed[0]!.backupId,current.backupId);
 assert.equal((await f.backups.inspect({projectId,backupId:listed[0]!.backupId})).projectName,'Current branch');
 assert.equal((await f.backups.inspect({projectId,backupId:listed[1]!.backupId})).projectName,'Other branch');
});

test('the index records the actual completed copy pair when content advances during native capture',async t=>{
 let before:{contentSequence:unknown;contentToken:unknown}|undefined;
 const f=await setup(t,{backup:async(store,file)=>{
   if(!before){before=store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get() as typeof before;store.put('projects',{id:store.projectId,name:'Changed while copying'});}
   return createProjectBackup(store,file);
 }}),projectId=f.project.projectId,lease=await f.manager.acquire(projectId,'window');
 const actual=lease.host.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get()!,entry=(await f.backups.list({projectId})).backups[0]!;
 assert.ok(before);assert.ok(Number(entry.contentSequence)>Number(before.contentSequence));assert.notEqual(entry.contentToken,before.contentToken);
 assert.equal(entry.contentSequence,actual.contentSequence);assert.equal(entry.contentToken,actual.contentToken);
 const copied=inspectProjectBackup(path.join(projectLocation(f.directories,projectId).localDir,'backups',entry.backupId,'project.mioon'));
 assert.equal(entry.contentSequence,copied.contentSequence);assert.equal(entry.contentToken,copied.contentToken);
 lease.release();await f.manager.close(projectId);assert.deepEqual((await f.backups.list({projectId})).backups,[entry]);
});

test('legacy indexes cannot deduplicate and only complete legacy restore receipts may replay',async t=>{
 const f=await setup(t),projectId=f.project.projectId,lease=await f.manager.acquire(projectId,'window');lease.release();await f.manager.close(projectId);
 const root=path.join(projectLocation(f.directories,projectId).localDir,'backups'),indexFile=path.join(root,'index.json'),first=(await f.backups.list({projectId})).backups[0]!;
 const input={projectId,backupId:first.backupId,requestId:randomUUID(),projectFile:path.join(f.directories.projectsDir,'legacy-replay.mioon')},restored=await f.backups.restore(input);
 const receipt=path.join(root,'restore-requests',`${input.requestId}.json`),modern=JSON.parse(readFileSync(receipt,'utf8'));
 const{sourceContentSequence:_sequence,sourceContentToken:_source,targetContentToken:_target,...legacy}=modern;legacy.version=1;writeFileSync(receipt,JSON.stringify(legacy),{mode:0o600});
 const opened=await f.manager.acquire(restored.project.projectId,'window');opened.host.store.put('projects',{id:restored.project.projectId,name:'New branch'});
 assert.deepEqual(await f.backups.restore(input),restored);assert.equal((opened.host.store.get('projects',restored.project.projectId) as {name:string}).name,'New branch');
 opened.release();await f.manager.close(restored.project.projectId);
 for(const phase of ['prepared','published']){
   writeFileSync(receipt,JSON.stringify({...legacy,phase}),{mode:0o600});const bytes=readFileSync(input.projectFile);
   await assert.rejects(f.backups.restore(input),{code:'PROJECT_BACKUP_INDEX_INVALID'});assert.deepEqual(readFileSync(input.projectFile),bytes);
 }
 const index=JSON.parse(readFileSync(indexFile,'utf8'));index.version=1;index.backups=index.backups.map(({contentToken:_token,...row}:Record<string,unknown>)=>row);
 writeFileSync(indexFile,JSON.stringify(index),{mode:0o600});const oldCopy=path.join(root,first.backupId,'project.mioon'),bytes=readFileSync(oldCopy);
 assert.deepEqual((await f.backups.list({projectId})).backups,[]);assert.deepEqual(readFileSync(oldCopy),bytes);
 const again=await f.manager.acquire(projectId,'window');again.release();await f.manager.close(projectId);
 const replacement=(await f.backups.list({projectId})).backups[0]!;assert.notEqual(replacement.backupId,first.backupId);assert.equal(replacement.contentToken,first.contentToken);
 assert.equal(JSON.parse(readFileSync(indexFile,'utf8')).version,2);assert.equal(existsSync(oldCopy),false);
 assert.equal(inspectCopiedProjectFile(input.projectFile).projectId,restored.project.projectId);
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


test('restored new project inherits only exact existing directory consent; replay does not regrant revocations',async t=>{
 const granted=new Map<string,{projectId:string;directory:string;confirmedAt:string}>();
 const outsidePaths={list:(id:string)=>[...granted.values()].filter(row=>row.projectId===id),confirm:(row:{projectId:string;directory:string;confirmedAt:string})=>{granted.set(row.projectId+'|'+row.directory,row);}};
 const f=await setup(t,{outsidePaths}),lease=await f.manager.acquire(f.project.projectId,'window');
 const sourceDir=lease.host.store.projectDir,external=mkdtempSync(path.join(tmpdir(),'old-consent-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
 outsidePaths.confirm({projectId:f.project.projectId,directory:external,confirmedAt:new Date().toISOString()});
 lease.release();await f.manager.close(f.project.projectId);
 const backup=(await f.backups.list({projectId:f.project.projectId})).backups[0]!;
 const targetDir=mkdtempSync(path.join(tmpdir(),'restored-consent-'));t.after(()=>rmSync(targetDir,{recursive:true,force:true}));
 const input={projectId:f.project.projectId,backupId:backup.backupId,requestId:randomUUID(),projectFile:path.join(targetDir,'project.mioon')};
 const restored=await f.backups.restore(input),id=restored.project.projectId;
 assert.deepEqual(outsidePaths.list(id).map(row=>row.directory).sort(),[sourceDir,external].sort());
 assert.equal(outsidePaths.list(id).some(row=>row.directory===path.join(sourceDir,'nested')),false);
 for(const row of outsidePaths.list(id))granted.delete(id+'|'+row.directory);
 const replay=await f.backups.restore(input);assert.equal(replay.project.projectId,id);assert.deepEqual(outsidePaths.list(id),[]);
});


test('a crash during one-shot consent transfer may omit grants but cannot regrant on retry',async t=>{
 const grants=new Map<string,{projectId:string;directory:string;confirmedAt:string}>();let source='',attempts=0;
 const outsidePaths={list:(id:string)=>[...grants.values()].filter(row=>row.projectId===id),confirm:(row:{projectId:string;directory:string;confirmedAt:string})=>{if(row.projectId!==source){attempts++;throw Error('simulated app interruption');}grants.set(row.projectId+'|'+row.directory,row);}};
 const f=await setup(t,{outsidePaths});source=f.project.projectId;
 const lease=await f.manager.acquire(source,'window');lease.release();await f.manager.close(source);
 const saved=(await f.backups.list({projectId:source})).backups[0]!;
 const target=mkdtempSync(path.join(tmpdir(),'restore-consent-crash-'));t.after(()=>rmSync(target,{recursive:true,force:true}));
 const input={projectId:source,backupId:saved.backupId,requestId:randomUUID(),projectFile:path.join(target,'project.mioon')};
 await assert.rejects(f.backups.restore(input),/simulated app interruption/);assert.equal(attempts,1);
 const restored=await f.backups.restore(input);assert.notEqual(restored.project.projectId,source);
 assert.equal(attempts,1);assert.deepEqual(outsidePaths.list(restored.project.projectId),[]);
});
