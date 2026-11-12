import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {inspectClosedProjectForTrash, hasBlockingMioRun} from '../packages/business/src/project-file/closed-copy.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION,HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';

function fixture(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-trash-inspection-')),projectDir=path.join(root,'project');
 mkdirSync(projectDir,{mode:0o700});
 const projectFile=path.join(projectDir,'film.mioon'),projectId=createProjectFile(projectFile);
 const location={localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')};
 const open=()=>openProjectStore({projectFile,locate:()=>location});
 const store=open();store.put('projects',{id:projectId,name:'Retained project',revision:7});store.close();
 const history=path.join(location.localDir,'history.db');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {root,projectDir,projectFile,projectId,location,history,open,options:{projectFile,historyFile:()=>history}};
}
function evidence(root:string):unknown {
 return readdirSync(root).sort().map(name=>{
  const file=path.join(root,name),info=lstatSync(file,{bigint:true});
  return info.isDirectory()?{name,children:evidence(file)}:{name,dev:info.dev,ino:info.ino,size:info.size,mtimeNs:info.mtimeNs,ctimeNs:info.ctimeNs,birthtimeNs:info.birthtimeNs,hash:createHash('sha256').update(readFileSync(file)).digest('hex')};
 });
}
function seedRun(f:ReturnType<typeof fixture>,status:string){
 const store=f.open();
 try{
  const journal=createMioJournal(store,{policy:()=>structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  const run=journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Retained work',configuration:{protocol:'chat_completions',model:'synthetic'}}).run;
  store.db.prepare('UPDATE mio_runs SET status=? WHERE id=?').run(status,run.id);
  return run.id;
 }finally{store.close();}
}

test('closed trash inspection returns the current complete identity, revision and file generation without writes',t=>{
 const f=fixture(t),before=evidence(f.root),stat=lstatSync(f.projectFile,{bigint:true});
 const result=inspectClosedProjectForTrash(f.options);
 assert.equal(result.projectFile,f.projectFile);assert.equal(result.identity.projectId,f.projectId);assert.equal(result.identity.name,'Retained project');assert.equal(result.revision,7);
 assert.deepEqual(result.generation,{dev:String(stat.dev),ino:String(stat.ino),size:Number(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),birthtimeNs:String(stat.birthtimeNs)});
 assert.equal(result.history?.formatVersion,HISTORY_SCHEMA_VERSION);assert.equal(result.history?.hasBlockingMio,false);
 assert.equal(result.history?.seenContentSequence,result.identity.contentSequence);assert.equal(result.history?.seenContentToken,result.identity.contentToken);
 assert.deepEqual(evidence(f.root),before);
 const reopened=f.open();assert.equal(reopened.projectId,f.projectId);reopened.close();
});

test('closed inspection with no history creates no records, cache or temporary files',t=>{
 const f=fixture(t);rmSync(f.location.localDir,{recursive:true});rmSync(f.location.cacheDir,{recursive:true});rmSync(f.location.tempDir,{recursive:true});
 const before=evidence(f.root),result=inspectClosedProjectForTrash(f.options);
 assert.equal(result.history,null);assert.equal(result.revision,7);assert.deepEqual(evidence(f.root),before);
 assert.equal(lstatSync(f.location.localDir,{throwIfNoEntry:false}),undefined);assert.equal(lstatSync(f.location.tempDir,{throwIfNoEntry:false}),undefined);
});

for(const status of ['accepted','running','paused','awaiting_approval','awaiting_answer','interrupted'])test(`closed inspection preserves and detects a real persisted ${status} Mio run`,t=>{
 const f=fixture(t);seedRun(f,status);const before=evidence(f.root);
 assert.equal(inspectClosedProjectForTrash(f.options).history?.hasBlockingMio,true);assert.deepEqual(evidence(f.root),before);
 const store=f.open();assert.equal(hasBlockingMioRun(store.db,f.projectId),true);assert.equal(hasBlockingMioRun(store.db,randomUUID()),false);store.close();
});

test('Mio admission checks waiting runs beyond the journal last-100 display page and ignores completed work',t=>{
 const f=fixture(t),waiting=seedRun(f,'completed'),store=f.open();
 try{
  const journal=createMioJournal(store,{policy:()=>structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  for(let n=0;n<101;n++){
   const run=journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Completed later work',configuration:{protocol:'chat_completions',model:'synthetic'}}).run;
   journal.transition(run.id,run.revision,'completed');
  }
  store.db.prepare("UPDATE mio_runs SET status='awaiting_answer' WHERE id=?").run(waiting);
  assert.equal(journal.list(f.projectId).length,100);assert.equal(journal.list(f.projectId).some(run=>run.id===waiting),false);
  assert.equal(hasBlockingMioRun(store.db,f.projectId),true);
 }finally{store.close();}
 const before=evidence(f.root);assert.equal(inspectClosedProjectForTrash(f.options).history?.hasBlockingMio,true);assert.deepEqual(evidence(f.root),before);
 const completed=f.open();completed.db.prepare("UPDATE mio_runs SET status='completed' WHERE id=?").run(waiting);completed.close();
 assert.equal(inspectClosedProjectForTrash(f.options).history?.hasBlockingMio,false);
});

test('frozen history v2 retains its real legacy waiting run without migration or cleanup',t=>{
 const f=fixture(t);rmSync(f.history);
 const db=new DatabaseSync(f.history);
 try{
  db.exec('BEGIN');buildPreviousHistoryDatabase(db,2);db.prepare('INSERT INTO history_state VALUES(1,?,0)').run(f.projectId);
  db.prepare('INSERT INTO agent_task_runs_v2 VALUES(?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,randomUUID(),'a'.repeat(64),'awaiting_answer',1,JSON.stringify({conversationId:randomUUID(),notes:[],skippedTargets:[]}));
  db.exec('COMMIT');
 }finally{db.close();}
 const before=evidence(f.root),result=inspectClosedProjectForTrash(f.options);
 assert.equal(result.history?.formatVersion,2);assert.equal(result.history?.hasBlockingMio,true);assert.equal(result.history?.seenContentToken,null);assert.deepEqual(evidence(f.root),before);
 const reader=new DatabaseSync(f.history,{readOnly:true});
 try{assert.equal(reader.prepare('SELECT status FROM agent_task_runs_v2').get()?.status,'awaiting_answer');assert.equal(reader.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='mio_runs'").get()?.n,0);}finally{reader.close();}
 const unknown=new DatabaseSync(f.history);unknown.exec("UPDATE agent_task_runs_v2 SET status='unknown_legacy_state'");unknown.close();
 const unknownBefore=evidence(f.root);assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_INVALID'});assert.deepEqual(evidence(f.root),unknownBefore);
});

for(const version of [3,4,5,6,7,8,9] as const)test(`frozen history v${version} is inspected without upgrading its complete profile`,t=>{
 const f=fixture(t);rmSync(f.history);
 const db=new DatabaseSync(f.history);
 try{
  db.exec('BEGIN');buildPreviousHistoryDatabase(db,version);
  if(version>=8)db.prepare('INSERT INTO history_state VALUES(1,?,0,?)').run(f.projectId,'f'.repeat(32));
  else db.prepare('INSERT INTO history_state VALUES(1,?,0)').run(f.projectId);
  db.exec('COMMIT');
 }finally{db.close();}
 const before=evidence(f.root),result=inspectClosedProjectForTrash(f.options);
 assert.equal(result.history?.formatVersion,version);assert.equal(result.history?.hasBlockingMio,false);
 assert.equal(result.history?.seenContentSequence,0);assert.equal(result.history?.seenContentToken,version>=8?'f'.repeat(32):null);
 assert.deepEqual(evidence(f.root),before);
});

test('held project and history aliases are rejected before opening another descriptor',t=>{
 const f=fixture(t),store=f.open();
 try{
  assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_LOCKED'});
  assert.equal(store.db.isOpen,true);
  const project=store.get('projects',f.projectId);assert.ok(project!==null&&typeof project==='object'&&'revision' in project);assert.equal(project.revision,7);
  const alias=path.join(f.projectDir,'alias.mioon');linkSync(f.projectFile,alias);
  assert.throws(()=>inspectClosedProjectForTrash({...f.options,projectFile:alias}),{code:'PROJECT_INVALID'});
  rmSync(alias);
 }finally{store.close();}
 const other=fixture(t),heldHistory=other.open();
 try{
  assert.throws(()=>inspectClosedProjectForTrash({...f.options,historyFile:()=>other.history}),{code:'PROJECT_LOCKED'});
  assert.equal(heldHistory.db.isOpen,true);
  const project=heldHistory.get('projects',other.projectId);assert.ok(project!==null&&typeof project==='object'&&'revision' in project);assert.equal(project.revision,7);
 }finally{heldHistory.close();}
 const before=evidence(f.root);assert.equal(inspectClosedProjectForTrash(f.options).revision,7);assert.deepEqual(evidence(f.root),before);
});

test('a forged super-journal cannot open a listed held SQLite inode as a journal',t=>{
 const f=fixture(t),other=fixture(t),held=other.open();
 const master=path.join(f.location.localDir,'history.db-mjABCDEF901');
 writeFileSync(master,other.projectFile+'\u0000');
 try{
  assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_LOCKED'});
  assert.equal(held.db.isOpen,true);
  const project=held.get('projects',other.projectId);assert.ok(project!==null&&typeof project==='object'&&'revision' in project);assert.equal(project.revision,7);
 }finally{held.close();}
 rmSync(master);
 assert.equal(inspectClosedProjectForTrash(f.options).revision,7);
});

for(const sidecar of ['project-wal','history-wal','orphan-history-journal','history-switch'])test(`uncertain ${sidecar} evidence is refused without cleanup or source writes`,t=>{
 const f=fixture(t);
 if(sidecar==='project-wal')writeFileSync(f.projectFile+'-wal','uncertain');
 if(sidecar==='history-wal')writeFileSync(f.history+'-wal','uncertain');
 if(sidecar==='orphan-history-journal'){rmSync(f.history);writeFileSync(f.history+'-journal','orphan');}
 if(sidecar==='history-switch')writeFileSync(path.join(f.location.localDir,'history-switch-active.json'),'{}');
 const before=evidence(f.root);
 assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:sidecar==='history-switch'?'PROJECT_HISTORY_SWITCH_PENDING':'PROJECT_INVALID'});
 assert.deepEqual(evidence(f.root),before);
});

test('unknown and newer history profiles are refused instead of treating a failed Mio query as empty',t=>{
 const f=fixture(t),db=new DatabaseSync(f.history);
 db.exec('CREATE INDEX foreign_profile ON mio_runs(projectId)');db.close();
 let before=evidence(f.root);assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_INVALID'});assert.deepEqual(evidence(f.root),before);
 const forged=new DatabaseSync(f.history);forged.exec('DROP INDEX foreign_profile');forged.prepare('UPDATE schema_version SET version=?').run(FORMAT4_HISTORY_SCHEMA_VERSION);forged.close();
 before=evidence(f.root);assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_INVALID'});assert.deepEqual(evidence(f.root),before);
 const newer=new DatabaseSync(f.history);newer.prepare('UPDATE schema_version SET version=?').run(FORMAT4_HISTORY_SCHEMA_VERSION+1);newer.close();
 before=evidence(f.root);assert.throws(()=>inspectClosedProjectForTrash(f.options),{code:'PROJECT_FORMAT_NEWER'});assert.deepEqual(evidence(f.root),before);
 const empty=new DatabaseSync(':memory:');try{assert.throws(()=>hasBlockingMioRun(empty,f.projectId),{code:'PROJECT_INVALID'});}finally{empty.close();}
});

test('symlinks and different history ownership cannot establish trash admission',t=>{
 const f=fixture(t),alias=path.join(f.projectDir,'alias.mioon');symlinkSync(f.projectFile,alias);
 assert.throws(()=>inspectClosedProjectForTrash({...f.options,projectFile:alias}),{code:'PROJECT_INVALID'});rmSync(alias);
 const other=fixture(t),before=evidence(f.root),otherBefore=evidence(other.root);
 assert.throws(()=>inspectClosedProjectForTrash({...f.options,historyFile:()=>other.history}),{code:'PROJECT_INVALID'});
 assert.deepEqual(evidence(f.root),before);assert.deepEqual(evidence(other.root),otherBefore);
});

test('file birthtime generation changes during inspection are refused and all read handles are released',t=>{
 const f=fixture(t),original=fs.lstatSync;let changed=false,calls=0;
 t.mock.method(fs,'lstatSync',((file:fs.PathLike,options:unknown)=>{
  const info=original(file,options as {bigint:true});
  return changed&&String(file)===f.projectFile?Object.assign(Object.create(Object.getPrototypeOf(info)),info,{birthtimeNs:info.birthtimeNs+1n}):info;
 }) as typeof fs.lstatSync);syncBuiltinESMExports();
 try{
  assert.throws(()=>inspectClosedProjectForTrash({...f.options,assertMutationAllowed:()=>{if(++calls===2)changed=true;}}),{code:'PROJECT_INVALID'});
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const store=f.open();assert.equal(store.projectId,f.projectId);store.close();
});

test('an owner fence failing after reads refuses inspection without creating or mutating anything',t=>{
 const f=fixture(t),before=evidence(f.root),failure=new Error('owner retired');let calls=0;
 assert.throws(()=>inspectClosedProjectForTrash({...f.options,assertMutationAllowed:()=>{if(++calls===2)throw failure;}}),error=>error===failure);
 assert.deepEqual(evidence(f.root),before);
 const store=f.open();assert.equal(store.db.isOpen,true);store.close();
});
