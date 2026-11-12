import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {captureClosedProjectSnapshot} from '../packages/business/src/project-file/closed-copy.ts';
import {createProjectFile,inspectProjectFileReadOnly} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {openProjectBackup,inspectCopiedProjectFile,publishProjectCopyFile} from '../packages/business/src/project-file/backup.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {initializeProjectCopyHistory} from '../packages/business/src/project-file/copy-history.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {V5_HISTORY_V8_MANIFEST} from '../packages/business/src/project-file/schema/history-v8-manifest.ts';
import {S8_HISTORY_V9_MANIFEST} from '../packages/business/src/project-file/schema/history-v9-manifest.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {createLocalDraftRepository,localDraftDigest} from '../packages/business/src/local-draft-repository.ts';
import {clipDraftDiskSchema} from '../packages/contracts/src/local-drafts.ts';
import type {ClipDraftDisk} from '../packages/contracts/src/local-drafts.ts';
import {DRAFT_TABLES} from '../packages/business/src/project-file/schema/domains/drafts.ts';

const code=(expected:string)=>(error:unknown):boolean=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code===expected);
function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-s5-closed-')),projectDir=path.join(root,'project');mkdirSync(projectDir,{mode:0o700});
 const projectFile=path.join(projectDir,'film.mioon'),projectId=createProjectFile(projectFile),location={localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')};
 const store=openProjectStore({projectFile,locate:()=>location});store.put('projects',{id:projectId,name:'source',revision:1,note:projectId});store.close();
 const history=path.join(location.localDir,'history.db'),directory=path.join(root,'snapshot');
 t.after(()=>{chmodSync(projectDir,0o700);chmodSync(projectFile,0o600);rmSync(root,{recursive:true,force:true});});
 const options={projectFile,historyFile:()=>history,directory};
 return{root,projectDir,projectFile,projectId,location,history,directory,options,open:()=>openProjectStore({projectFile,locate:()=>location})};
}
const evidence=(file:string)=>({bytes:readFileSync(file),stat:fs.statSync(file,{bigint:true})});
const unchanged=(file:string,before:ReturnType<typeof evidence>)=>{
 assert.deepEqual(readFileSync(file),before.bytes);const current=fs.statSync(file,{bigint:true});
 for(const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const)assert.equal(current[key],before.stat[key],key);
};

test('a read-only closed project and mismatched history are snapshotted together without source writes',async t=>{
 const f=fixture(t),history=new DatabaseSync(f.history);history.exec("UPDATE history_state SET seenContentSequence=seenContentSequence+9,seenContentToken='ffffffffffffffffffffffffffffffff'");history.close();
 chmodSync(f.projectFile,0o444);chmodSync(f.projectDir,0o555);
 const projectBefore=evidence(f.projectFile),historyBefore=evidence(f.history),entries=readdirSync(f.projectDir);
 const captured=await captureClosedProjectSnapshot(f.options);
 assert.equal(captured.identity.projectId,f.projectId);assert.equal(captured.identity.name,'source');assert.equal(captured.historyFile,path.join(f.directory,'history.source.sqlite'));
 const reader=openProjectBackup(captured.projectFile);assert.deepEqual(reader.identity,captured.identity);reader.close();
 const old=new DatabaseSync(captured.historyFile!,{readOnly:true});
 try{assert.equal(old.prepare('SELECT seenContentToken FROM history_state').get()!.seenContentToken,'f'.repeat(32));assert.equal(old.prepare('SELECT version FROM schema_version').get()!.version,HISTORY_SCHEMA_VERSION);}
 finally{old.close();}
 unchanged(f.projectFile,projectBefore);unchanged(f.history,historyBefore);assert.deepEqual(readdirSync(f.projectDir),entries);assert.equal(existsSync(f.projectFile+'-journal'),false);
});

test('no history means no source records or shadow cache are created',async t=>{
 const f=fixture(t);rmSync(f.location.localDir,{recursive:true});rmSync(f.location.cacheDir,{recursive:true});
 const before=evidence(f.projectFile),captured=await captureClosedProjectSnapshot(f.options);
 assert.equal(captured.historyFile,null);assert.equal(existsSync(f.location.localDir),false);assert.equal(existsSync(f.location.cacheDir),false);
 unchanged(f.projectFile,before);assert.deepEqual(readdirSync(f.directory),['project.source.sqlite']);
});

for(const version of [2,3,4,5,6,7,8,9] as const)test(`exact old history ${version} is copied without migration or requiring matching seen`,async t=>{
 const f=fixture(t),store=f.open();
 const document=store.tx(()=>captureProjectDocumentInside(store)),blob=encodeProjectDocument(document);store.close();
 const sourceIdentity=inspectProjectFileReadOnly(f.projectFile),seenToken=sourceIdentity.contentToken==='f'.repeat(32)?'e'.repeat(32):'f'.repeat(32);
 rmSync(f.history);const db=new DatabaseSync(f.history);
 let retainedVersions:unknown,retainedBlobs:unknown;
 try{
  db.exec('BEGIN');buildPreviousHistoryDatabase(db,version);
  if(version===8||version===9){
   db.prepare('INSERT INTO history_state VALUES(1,?,91,?)').run(f.projectId,seenToken);
   db.prepare('INSERT INTO project_version_blobs VALUES(?,?,?,?,?,?)').run(blob.hash,blob.profile,blob.codec,blob.rawBytes,blob.compressedBytes,blob.payload);
   db.prepare("INSERT INTO project_versions VALUES(?,?,'manual','保留版本',NULL,?,?,?,0)").run(randomUUID(),f.projectId,document.evidence.contentSequence,'2026-11-04T00:00:00.000Z',blob.hash);
   assert.deepEqual(readSchemaManifest(db,'main'),version===8?V5_HISTORY_V8_MANIFEST.entries:S8_HISTORY_V9_MANIFEST.entries);
   retainedVersions=db.prepare('SELECT * FROM project_versions ORDER BY id').all();retainedBlobs=db.prepare('SELECT * FROM project_version_blobs ORDER BY hash').all();
  }else db.prepare('INSERT INTO history_state VALUES(1,?,91)').run(f.projectId);
  db.prepare("INSERT INTO idempotency VALUES('kept','request','digest','resource')").run();db.exec('COMMIT');
 }finally{db.close();}
 const before=evidence(f.history),source=evidence(f.projectFile),captured=await captureClosedProjectSnapshot(f.options);
 const copied=new DatabaseSync(captured.historyFile!,{readOnly:true});
 try{
  assert.equal(copied.prepare('SELECT version FROM schema_version').get()!.version,version);assert.equal(copied.prepare('SELECT seenContentSequence FROM history_state').get()!.seenContentSequence,91);assert.equal(copied.prepare("SELECT resourceId FROM idempotency WHERE scope='kept'").get()!.resourceId,'resource');
  if(version===8||version===9){
   assert.deepEqual(readSchemaManifest(copied,'main'),version===8?V5_HISTORY_V8_MANIFEST.entries:S8_HISTORY_V9_MANIFEST.entries);
   assert.equal(copied.prepare('SELECT seenContentToken FROM history_state').get()!.seenContentToken,seenToken);assert.notEqual(seenToken,captured.identity.contentToken);
   assert.deepEqual(copied.prepare('SELECT * FROM project_versions ORDER BY id').all(),retainedVersions);
   assert.deepEqual(copied.prepare('SELECT * FROM project_version_blobs ORDER BY hash').all(),retainedBlobs);
   assert.equal(copied.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='local_clip_drafts'").get()!.n,version===8?0:1,'capturing frozen history keeps that version’s draft-table profile');
  }
 }
 finally{copied.close();}
 unchanged(f.history,before);unchanged(f.projectFile,source);
});

test('current history with real S8 repository rows is captured read-only without dropping or rewriting drafts',async t=>{
 const f=fixture(t),store=f.open();
 let drafts:unknown;
 try{
  assert.equal(SCHEMA_MANIFEST.history.version,HISTORY_SCHEMA_VERSION);assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version,HISTORY_SCHEMA_VERSION);
  const repository=createLocalDraftRepository<ClipDraftDisk>({store,kind:'clip',ownsLock:()=>store.db.isOpen,validate:value=>clipDraftDiskSchema.parse(value)});
  const initial=repository.read(),saved={...initial,entries:[{projectId:f.projectId,timelineId:randomUUID(),clipId:randomUUID(),revision:1,draft:null}]};
  repository.save(saved,localDraftDigest(initial));assert.deepEqual(repository.read(),saved);
  drafts=Object.fromEntries(DRAFT_TABLES.map(table=>[table,store.db.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all()]));
 }finally{store.close();}
 const before=evidence(f.history),source=evidence(f.projectFile),captured=await captureClosedProjectSnapshot(f.options);
 const copied=new DatabaseSync(captured.historyFile!,{readOnly:true});
 try{
  assert.equal(copied.prepare('SELECT version FROM schema_version').get()!.version,HISTORY_SCHEMA_VERSION);
  assert.deepEqual(readSchemaManifest(copied,'main'),SCHEMA_MANIFEST.history.entries);
  assert.equal(copied.prepare('SELECT count(*) n FROM local_clip_drafts').get()!.n,1);
  assert.deepEqual(Object.fromEntries(DRAFT_TABLES.map(table=>[table,copied.prepare(`SELECT rowid,* FROM main.${table} ORDER BY rowid`).all()])),drafts);
  assert.deepEqual(copied.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{copied.close();}
 unchanged(f.history,before);unchanged(f.projectFile,source);
});

for(const damage of ['unknown-object','wrong-project','future','forged-candidate','old-unknown','malformed','switch-pending'] as const)test(`unreadable history ${damage} refuses the entire capture without staging`,async t=>{
 const f=fixture(t),db=new DatabaseSync(f.history);
 try{
  if(damage==='unknown-object')db.exec('CREATE TABLE unreviewed_extra(value)');
  if(damage==='wrong-project'){db.exec('DROP TRIGGER history_state_guard_identity');db.prepare('UPDATE history_state SET projectId=?').run(randomUUID());}
  if(damage==='future'||damage==='forged-candidate'||damage==='old-unknown')db.prepare('UPDATE schema_version SET version=?')
   .run(damage==='future'?FORMAT4_HISTORY_SCHEMA_VERSION+1:damage==='forged-candidate'?FORMAT4_HISTORY_SCHEMA_VERSION:1);
 }finally{db.close();}
 if(damage==='malformed')writeFileSync(f.history,'not sqlite');
 if(damage==='switch-pending')writeFileSync(path.join(f.location.localDir,'history-switch-active.json'),'{}');
 const before=evidence(f.history),source=evidence(f.projectFile);
 await assert.rejects(captureClosedProjectSnapshot(f.options),code(damage==='future'?'PROJECT_FORMAT_NEWER':damage==='switch-pending'?'PROJECT_HISTORY_SWITCH_PENDING':'PROJECT_INVALID'));
 unchanged(f.history,before);unchanged(f.projectFile,source);assert.equal(existsSync(f.directory),false);
});

test('closed capture reads both project and history pairs and leaves their formats and bytes unchanged', async t => {
 const f=fixture(t), legacyFiles=[evidence(f.projectFile),evidence(f.history)] as const;
 const legacy=await captureClosedProjectSnapshot(f.options);
 assert.equal(legacy.identity.formatVersion,PROJECT_FILE_SCHEMA_VERSION);
 const reader=openProjectBackup(legacy.projectFile),projectFile=path.join(f.root,'candidate.mioon'),historyFile=path.join(f.root,'candidate.history.db');
 try {
  const copy=await copyProjectToNewFile(reader,{projectFile,sourceProjectDir:f.projectDir,targetFormat:FORMAT4_PROJECT_SCHEMA_VERSION});
  initializeProjectCopyHistory(historyFile,copy.projectId,copy);
 } finally {reader.close();}
 const candidateFiles=[evidence(projectFile),evidence(historyFile)] as const;
 const candidate=await captureClosedProjectSnapshot({projectFile,historyFile:()=>historyFile,directory:path.join(f.root,'candidate-snapshot')});
 assert.equal(candidate.identity.formatVersion,FORMAT4_PROJECT_SCHEMA_VERSION);
 const history=new DatabaseSync(candidate.historyFile!,{readOnly:true});
 try {
  assert.equal(history.prepare('SELECT version FROM schema_version').get()?.version,FORMAT4_HISTORY_SCHEMA_VERSION);
  const state=history.prepare('SELECT * FROM history_state').get();
  assert.equal(state?.projectId,candidate.identity.projectId);
  assert.equal(state?.seenContentSequence,candidate.identity.contentSequence);
  assert.equal(state?.seenContentToken,candidate.identity.contentToken);
 } finally {history.close();}
 unchanged(f.projectFile,legacyFiles[0]);unchanged(f.history,legacyFiles[1]);
 unchanged(projectFile,candidateFiles[0]);unchanged(historyFile,candidateFiles[1]);
});

test('held project or history is refused before opening fs descriptors',async t=>{
 const f=fixture(t),store=f.open(),open=fs.openSync;let attempts=0;
 t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if([f.projectFile,f.history].includes(String(args[0])))attempts++;return open(...args);});syncBuiltinESMExports();
 try{await assert.rejects(captureClosedProjectSnapshot(f.options),code('PROJECT_LOCKED'));assert.equal(attempts,0);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();store.close();}
 assert.equal(existsSync(f.directory),false);
});

test('backup awaits retain held-file admission and real cross-process read locks; exceptional cleanup releases them',async t=>{
 const f=fixture(t),before=evidence(f.projectFile),historyBefore=evidence(f.history),open=fs.openSync,alias=path.join(f.root,'alias.mioon'),sentinel=Error('stop after lock proof');
 let hit=false,attempts=0;
 const onBoundary=async(phase:string)=>{
  if(phase!=='project-copied')return;
  hit=true;linkSync(f.projectFile,alias);
  t.mock.method(fs,'openSync',(...params:Parameters<typeof fs.openSync>)=>{if([f.projectFile,f.history,alias].includes(String(params[0])))attempts++;return open(...params);});syncBuiltinESMExports();
  assert.throws(()=>f.open(),code('PROJECT_LOCKED'));assert.throws(()=>inspectProjectFileReadOnly(alias),code('PROJECT_LOCKED'));
  assert.throws(()=>inspectCopiedProjectFile(alias),code('PROJECT_BACKUP_INVALID'));assert.equal(attempts,0);
  for(const file of [f.projectFile,f.history]){
   const program=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)},{timeout:0});try{db.exec('BEGIN EXCLUSIVE');throw Error('lock lost');}catch(e){if(e.errcode!==5)throw e;}finally{db.close();}`;
   execFileSync(process.execPath,['--input-type=module','-e',program],{stdio:'pipe'});
  }
  t.mock.restoreAll();syncBuiltinESMExports();rmSync(alias);await Promise.resolve();throw sentinel;
 };
 try{await assert.rejects(captureClosedProjectSnapshot({...f.options,onBoundary}),error=>error===sentinel);assert.equal(hit,true);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();rmSync(alias,{force:true});}
 assert.deepEqual(readFileSync(f.projectFile),before.bytes);unchanged(f.history,historyBefore);assert.deepEqual(readdirSync(f.directory),[]);
 const reopened=f.open();assert.equal(reopened.projectId,f.projectId);reopened.close();
});

test('a real hot project journal is refused without recovering source or companion bytes',async t=>{
 const f=fixture(t),program=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(f.projectFile)});db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=ON;BEGIN IMMEDIATE');db.prepare("UPDATE projects SET data=json_set(data,'$.note',?)").run('x'.repeat(2097152));process.kill(process.pid,'SIGKILL');`;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',program],{stdio:'ignore'}),error=>Boolean(error&&typeof error==='object'&&'signal' in error&&error.signal==='SIGKILL'));
 const journal=f.projectFile+'-journal';assert.equal(readFileSync(journal).subarray(0,8).toString('hex'),'d9d505f920a163d7');
 const project=evidence(f.projectFile),hot=evidence(journal),history=evidence(f.history);
 await assert.rejects(captureClosedProjectSnapshot(f.options),code('PROJECT_INVALID'));unchanged(f.projectFile,project);unchanged(journal,hot);unchanged(f.history,history);assert.equal(existsSync(f.directory),false);
});

test('S5 target identity, final reference directory, name and process cleanup do not alter the source or V2 defaults',async t=>{
 const f=fixture(t),store=f.open(),assetId=randomUUID(),sha256='a'.repeat(64);
 store.put('assets',{id:assetId,projectId:f.projectId,reference:{pathForm:'relative',path:'missing.png',volume:null,sizeBytes:1,mtimeMs:0,sampledSha256:sha256,fullSha256:sha256},referenceRevision:1,sha256,sizeBytes:1});
 store.db.prepare("INSERT INTO project.agent_task_target_revisions_v2 VALUES(?,'job',?,9)").run(f.projectId,randomUUID());store.close();
 const before=evidence(f.projectFile),captured=await captureClosedProjectSnapshot(f.options),reader=openProjectBackup(captured.projectFile),stage=path.join(f.root,'out');mkdirSync(stage,{mode:0o755});
 const projectId=randomUUID(),token='b'.repeat(32),finalDir=path.join(f.root,'final');mkdirSync(finalDir,{mode:0o755});
 const result=await copyProjectToNewFile(reader,{projectFile:path.join(stage,'staged.mioon'),sourceProjectDir:f.projectDir,targetProjectDir:finalDir,projectId,contentToken:token,projectName:'new name',clearProcessRevisions:true,publish:publishProjectCopyFile});reader.close();
 assert.equal(result.contentToken,token);assert.equal(result.contentSequence,captured.identity.contentSequence+1);
 const db=new DatabaseSync(result.projectFile,{readOnly:true});try{
  const project=JSON.parse(String(db.prepare('SELECT data FROM projects').get()!.data));assert.equal(project.name,'new name');assert.equal(project.note,f.projectId);assert.equal(project.revision,1);
  assert.equal(db.prepare("SELECT count(*) n FROM agent_task_target_revisions_v2 WHERE kind='job'").get()!.n,0);
  const data=JSON.parse(String(db.prepare('SELECT data FROM assets').get()!.data));assert.equal(data.projectId,projectId);assert.equal(path.resolve(finalDir,data.reference.path),path.join(f.projectDir,'missing.png'));
 }finally{db.close();}
 unchanged(f.projectFile,before);
});

test('SIGKILL during the read transaction leaves source unchanged and releases both locks',async t=>{
 const f=fixture(t),source=evidence(f.projectFile),history=evidence(f.history),marker=path.join(f.root,'locked');
 const module=new URL('../packages/business/src/project-file/closed-copy.ts',import.meta.url).href;
 const program=`import{writeFileSync}from'node:fs';const{captureClosedProjectSnapshot}=await import(${JSON.stringify(module)});await captureClosedProjectSnapshot({projectFile:${JSON.stringify(f.projectFile)},historyFile:()=>${JSON.stringify(f.history)},directory:${JSON.stringify(f.directory)},onBoundary:phase=>{if(phase==='project-copied'){writeFileSync(${JSON.stringify(marker)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','ignore','inherit']}),closed=once(child,'close');t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const deadline=Date.now()+15000;while(!existsSync(marker)){assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
 child.kill('SIGKILL');const [status,signal]=await closed;assert.equal(status,null);assert.equal(signal,'SIGKILL');unchanged(f.projectFile,source);unchanged(f.history,history);
 const reopened=f.open();assert.equal(reopened.projectId,f.projectId);reopened.close();
});
