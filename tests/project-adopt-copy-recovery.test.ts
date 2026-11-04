import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {serverAppDirectories,projectLocation} from '../apps/server/src/project-host/directories.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createProjectCopies} from '../apps/server/src/project-host/copies.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {storeManualVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {HISTORY_SCHEMA_VERSION,PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {ProjectAdoptCopyInput} from '../packages/contracts/src/project-copies.ts';

type Boundary=Parameters<typeof createProjectCopies>[0]['onActionBoundary'];
const runtime=async()=>({handle:async()=>false,isBusy:()=>false,interrupt(){},drain:async()=>{},dispose(){}});
function owner(root:string,onActionBoundary?:Boundary){
 const directories=serverAppDirectories(root),signal=new AbortController();
 let manager:ReturnType<typeof createProjectHostManager>;
 const library=openAppLibrary({dataDir:root,isProjectOpen:id=>manager?.status(id)!==null&&manager?.status(id)!==undefined});
 manager=createProjectHostManager({directories,registry:library.registry,identity:library.projectFileIdentity,factory:runtime});
 const copies=createProjectCopies({manager,library,directories,signal:signal.signal,assertProjectFile:createApplicationFileGuard(directories),onActionBoundary});
 return {directories,library,manager,copies,async close(){await copies.drain();await manager.closeAll();library.close();}};
}
function tree(directory:string):unknown {
 if(!existsSync(directory))return null;
 return readdirSync(directory).sort().map(name=>{
  const file=path.join(directory,name),info=lstatSync(file,{bigint:true});
  assert.equal(info.isSymbolicLink(),false);
  return {name,dev:String(info.dev),ino:String(info.ino),bytes:info.isFile()?readFileSync(file).toString('base64'):null,children:info.isDirectory()?tree(file):null};
 });
}
async function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-adopt-recovery-'));let app=owner(root);
 t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
 const source=await app.manager.create({name:'Registered original'}),local=projectLocation(app.directories,source.projectId);
 const store=openProjectStore({projectFile:source.projectFile,locate:()=>local});
 try{
  ensureProjectRow(store,{name:'Registered original'});
  store.tx(()=>storeManualVersionInside(store.db,source.projectId,'Original-only checkpoint',readProjectContentStamp(store.db).contentSequence,encodeProjectDocument(captureProjectDocumentInside(store))));
  const conversationId=randomUUID(),createdAt='2026-11-04T00:00:00.000Z';
  store.db.prepare('INSERT INTO main.mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)').run(conversationId,source.projectId,createdAt,createdAt);
  store.db.prepare("INSERT INTO main.idempotency VALUES('original-only','request','digest','retained')").run();
 }finally{store.close();}
 const selected=path.join(path.dirname(source.projectFile),'Selected copy.mioon');copyFileSync(source.projectFile,selected);
 const info=lstatSync(selected,{bigint:true}),identity=inspectCopiedProjectFile(selected);
 const input:ProjectAdoptCopyInput={sourceProjectId:source.projectId,sourceFile:selected,sourceIdentity:{dev:String(info.dev),ino:String(info.ino)},sourceStamp:{contentSequence:identity.contentSequence,contentToken:identity.contentToken},requestId:randomUUID()};
 const original={project:readFileSync(source.projectFile),records:tree(local.localDir),registration:app.library.registry.get(source.projectId)},selectedBefore=readFileSync(selected);
 const intentFile=path.join(root,'project-copy-actions',`project.adopt-copy-${input.requestId}.json`);
 return {root,source,selected,input,local,selectedBefore,intentFile,get app(){return app;},
  readIntent:()=>JSON.parse(readFileSync(intentFile,'utf8')),
  async restart(boundary?:Boundary){await app.close();app=owner(root,boundary);},
  unchanged(registration=original.registration){assert.deepEqual(readFileSync(source.projectFile),original.project);assert.deepEqual(tree(local.localDir),original.records);assert.deepEqual(app.library.registry.get(source.projectId),registration);},
 };
}

test('adoption carries no original versions, Mio or receipts and replays a fixed result after target edits',async t=>{
 const f=await fixture(t),result=await f.app.copies.adoptCopy(f.input);
 assert.equal(result.sourceProjectId,f.source.projectId);assert.notEqual(result.project.projectId,f.source.projectId);
 assert.notEqual(result.contentToken,f.input.sourceStamp.contentToken);assert.equal(result.project.projectFile,f.selected);assert.equal(result.versions,0);
 assert.equal(inspectCopiedProjectFile(f.selected).formatVersion,PROJECT_FILE_SCHEMA_VERSION);
 const store=openProjectStore({projectFile:f.selected,locate:id=>projectLocation(f.app.directories,id)});
 try{
  assert.equal(store.projectId,result.project.projectId);assert.equal(store.historyState,'current');
  assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version,HISTORY_SCHEMA_VERSION);
  for(const table of ['project_versions','mio_conversations','mio_runs','idempotency','local_draft_states'])assert.equal(store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n,0,table);
  store.put('projects',{...store.get('projects',result.project.projectId) as object,id:result.project.projectId,name:'Edited adopted copy'});
  assert.deepEqual(await f.app.copies.adoptCopy(f.input),result);
  assert.equal((store.get('projects',result.project.projectId) as {name:string}).name,'Edited adopted copy');
 }finally{store.close();}
 await f.restart();await f.app.copies.recover();assert.deepEqual(await f.app.copies.adoptCopy(f.input),result);
 assert.equal(f.readIntent().phase,'completed');f.unchanged();
});

test('an open registered original does not block adopting a different closed physical copy',async t=>{
 const f=await fixture(t),lease=await f.app.manager.acquire(f.source.projectId,'window'),openedRegistration=f.app.library.registry.get(f.source.projectId);
 try{
  const before=lease.host.store.db.prepare('SELECT * FROM main.mio_conversations').all(),result=await f.app.copies.adoptCopy(f.input);
  assert.notEqual(result.project.projectId,f.source.projectId);assert.equal(result.versions,0);
  assert.equal(lease.host.store.db.isOpen,true);assert.deepEqual(lease.host.store.db.prepare('SELECT * FROM main.mio_conversations').all(),before);
  assert.equal(f.app.manager.status(f.source.projectId)?.leases.window,1);
 }finally{lease.release();await f.app.manager.close(f.source.projectId);}
 f.unchanged(openedRegistration);
});

for(const point of ['ready','records-prepared','records-published','project-published','registered'] as const)test(`restart after ${point} resumes the same replacement, ID, token and receipt`,async t=>{
 const f=await fixture(t);let hit=false;
 await f.restart(phase=>{if(phase===point){hit=true;throw Error('adopt boundary failure');}});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/adopt boundary failure/u);assert.equal(hit,true);f.unchanged();
 const saved=f.readIntent();assert.notEqual(saved.projectId,f.source.projectId);
 await f.restart();await f.app.copies.recover();const result=await f.app.copies.adoptCopy(f.input);
 assert.equal(result.project.projectId,saved.projectId);assert.equal(result.contentToken,saved.contentToken);assert.equal(result.versions,0);
 assert.deepEqual(await f.app.copies.adoptCopy(f.input),result);assert.equal(f.readIntent().phase,'completed');
 assert.equal(inspectCopiedProjectFile(f.selected).projectId,saved.projectId);
 for(const suffix of ['-journal','-wal','-shm'])assert.equal(existsSync(f.selected+suffix),false);
 f.unchanged();
});

for(const point of ['ready','project-published'] as const)test(`real SIGKILL at ${point} recovers the fixed adoption without inherited sidecars`,{timeout:60_000},async t=>{
 const f=await fixture(t);await f.app.close();
 const worker=new URL('./fixtures/project-copy-action-worker.ts',import.meta.url);
 const killed=spawnSync(process.execPath,[worker.pathname,JSON.stringify({root:f.root,input:f.input,point})],{encoding:'utf8',timeout:40_000});
 assert.equal(killed.error,undefined);assert.equal(killed.signal,'SIGKILL',killed.stderr);
 const saved=f.readIntent();assert.equal(saved.phase,point);assert.notEqual(saved.projectId,f.source.projectId);
 if(point==='ready')assert.deepEqual(readFileSync(f.selected),f.selectedBefore);
 else assert.equal(inspectCopiedProjectFile(f.selected).projectId,saved.projectId);
 for(const suffix of ['-journal','-wal','-shm'])assert.equal(existsSync(f.selected+suffix),false,'crash leaves no old sidecar');
 await f.restart();await f.app.copies.recover();const result=await f.app.copies.adoptCopy(f.input);
 assert.equal(result.project.projectId,saved.projectId);assert.equal(result.contentToken,saved.contentToken);assert.equal(result.project.projectFile,f.selected);assert.equal(result.versions,0);
 assert.deepEqual(await f.app.copies.adoptCopy(f.input),result);assert.equal(f.readIntent().phase,'completed');
 assert.equal(inspectCopiedProjectFile(f.selected).projectId,saved.projectId);
 for(const suffix of ['-journal','-wal','-shm'])assert.equal(existsSync(f.selected+suffix),false,'recovery leaves no inherited sidecar');
 f.unchanged();
});

for(const point of ['prepared','captured','staging'] as const)test(`restart invalidates ${point} without rewriting the selected file`,async t=>{
 const f=await fixture(t);let hit=false;
 await f.restart(phase=>{if(phase===point){hit=true;throw Error('stop before ready');}});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/stop before ready/u);assert.equal(hit,true);
 const saved=f.readIntent();assert.ok(['prepared','captured'].includes(saved.phase));
 await f.restart();await f.app.copies.recover();
 assert.equal(f.readIntent().phase,'abandoned');assert.deepEqual(readFileSync(f.selected),f.selectedBefore);
 if(saved.stageDirectory)assert.equal(existsSync(saved.stageDirectory),false);
 await assert.rejects(f.app.copies.adoptCopy(f.input),{code:'PROJECT_COPY_INTERRUPTED'});
 assert.equal(f.app.library.registry.get(saved.projectId),null);f.unchanged();
});

test('early recovery preserves a foreign directory substituted at the hidden-stage path',async t=>{
 const f=await fixture(t);await f.restart(phase=>{if(phase==='staging')throw Error('capture stopped');});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/capture stopped/u);
 const saved=f.readIntent(),held=saved.stageDirectory+'-held';renameSync(saved.stageDirectory,held);mkdirSync(saved.stageDirectory);writeFileSync(path.join(saved.stageDirectory,'foreign.txt'),'keep foreign stage');
 await f.restart();await f.app.copies.recover();
 assert.equal(f.readIntent().phase,'abandoned');assert.equal(readFileSync(path.join(saved.stageDirectory,'foreign.txt'),'utf8'),'keep foreign stage');
 assert.equal(existsSync(held),true);assert.deepEqual(readFileSync(f.selected),f.selectedBefore);f.unchanged();
});

test('ready recovery refuses a foreign hidden stage and leaves the original selected file untouched',async t=>{
 const f=await fixture(t);await f.restart(phase=>{if(phase==='ready')throw Error('ready stopped');});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/ready stopped/u);
 const saved=f.readIntent(),held=saved.stageDirectory+'-held';renameSync(saved.stageDirectory,held);mkdirSync(saved.stageDirectory);writeFileSync(path.join(saved.stageDirectory,'foreign.txt'),'keep ready stage');
 await f.restart();await f.app.copies.recover();await assert.rejects(f.app.copies.adoptCopy(f.input),{code:'PROJECT_COPY_TARGET_CHANGED'});
 assert.equal(readFileSync(path.join(saved.stageDirectory,'foreign.txt'),'utf8'),'keep ready stage');assert.equal(existsSync(held),true);
 assert.equal(f.readIntent().phase,'ready');assert.deepEqual(readFileSync(f.selected),f.selectedBefore);f.unchanged();
});

test('ready recovery never replaces a later file at the selected path',async t=>{
 const f=await fixture(t);await f.restart(phase=>{if(phase==='ready')throw Error('ready stopped');});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/ready stopped/u);
 const saved=f.readIntent(),held=f.selected+'.held';renameSync(f.selected,held);const foreignId=createProjectFile(f.selected),foreign=readFileSync(f.selected);
 await f.restart();await f.app.copies.recover();await assert.rejects(f.app.copies.adoptCopy(f.input),{code:'PROJECT_COPY_SOURCE_CHANGED'});
 assert.deepEqual(readFileSync(f.selected),foreign);assert.equal(inspectCopiedProjectFile(f.selected).projectId,foreignId);
 assert.deepEqual(readFileSync(held),f.selectedBefore);assert.equal(f.app.library.registry.get(saved.projectId),null);f.unchanged();
});

test('both unfinished intents and committed receipts reject a reused request with a different digest',async t=>{
 const f=await fixture(t);await f.restart(phase=>{if(phase==='ready')throw Error('ready stopped');});
 await assert.rejects(f.app.copies.adoptCopy(f.input),/ready stopped/u);
 const changed={...f.input,sourceStamp:{...f.input.sourceStamp,contentSequence:f.input.sourceStamp.contentSequence+1}};
 await assert.rejects(f.app.copies.adoptCopy(changed),{code:'REQUEST_ID_REUSED'});
 await f.restart();await f.app.copies.recover();const result=await f.app.copies.adoptCopy(f.input);
 await assert.rejects(f.app.copies.adoptCopy(changed),{code:'REQUEST_ID_REUSED'});
 assert.equal(inspectCopiedProjectFile(f.selected).projectId,result.project.projectId);f.unchanged();
});
