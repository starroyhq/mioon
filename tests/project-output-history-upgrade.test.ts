import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProjectFile,openProjectConnection} from '../packages/business/src/project-file/connection.ts';
import {V1_HISTORY_V6_MANIFEST} from '../packages/business/src/project-file/schema/history-v6-manifest.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-s2-history-')),projectFile=path.join(root,'movie.mioon'),projectId=createProjectFile(projectFile);
 const localDir=path.join(root,'records'),cacheDir=path.join(root,'cache'),tempDir=path.join(root,'tmp');for(const dir of[localDir,cacheDir,tempDir])mkdirSync(dir,{mode:0o700});
 const history=path.join(localDir,'history.db'),db=new DatabaseSync(history);t.after(()=>rmSync(root,{recursive:true,force:true}));
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; BEGIN');buildPreviousHistoryDatabase(db,6);db.prepare('INSERT INTO history_state VALUES(1,?,0)').run(projectId);
  db.exec('INSERT INTO mio_storage_counters VALUES(1,0,1)');
  for(const state of ['pending','approved','rejected'] as const){
   const id=randomUUID(),requestId=randomUUID(),time='2026-11-03T00:00:00.000Z';
   const input={projectId,requestId,name:'Retained image',providerId:'openai',model:'gpt-image-2.5-flare-2026-09-08',prompt:'retained private request',options:{size:'1024x1024',quality:'low',outputFormat:'png',background:'opaque',n:1}};
   const canonicalInput=JSON.stringify(input),canonicalIntent=JSON.stringify({schemaVersion:1,reviewId:id,input,settingsRevision:1,destination:'https://api.openai.com/v1/images/generations',policy:{maxPostAttempts:1,automaticRetry:false,price:'usage-based-unknown',promptStorage:'local-plaintext'}});
   db.prepare(`INSERT INTO image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
    VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`).run(id,projectId,requestId,hash(canonicalInput),canonicalInput,hash(canonicalIntent),canonicalIntent,time,time);
   if(state==='approved'){
    const taskId=randomUUID(),groupId=randomUUID(),snapshot=JSON.stringify({schemaVersion:1,projectId,groupId,taskId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options});
    db.prepare(`INSERT INTO image_tasks(id,projectId,groupId,requestId,inputHash,input,snapshot,state,revision,dispatched,stagedReceipt,versionId,errorCode,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'queued',1,0,NULL,NULL,NULL,?,?)`).run(taskId,projectId,groupId,requestId,hash(canonicalInput),canonicalInput,snapshot,time,time);
    db.prepare("UPDATE image_reviews SET state='approved',revision=2,taskId=?,approvedAt=? WHERE id=?").run(taskId,time,id);
   }else if(state==='rejected')db.prepare("UPDATE image_reviews SET state='rejected',revision=2,rejectedAt=? WHERE id=?").run(time,id);
  }
  db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('s2-retained','request-kept','opaque-request-hash','resource-kept');
  db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),projectId,'{"status":"running","private":"retained exact bytes"}');
  db.exec('COMMIT');assert.deepEqual(readSchemaManifest(db,'main'),V1_HISTORY_V6_MANIFEST.entries);
 }finally{db.close();}
 const inspect=()=>{const current=new DatabaseSync(history);try{return{manifest:readSchemaManifest(current,'main'),version:current.prepare('SELECT version FROM schema_version').get()!.version,
  reviews:current.prepare('SELECT rowid,* FROM image_reviews ORDER BY rowid').all(),tasks:current.prepare('SELECT rowid,* FROM image_tasks ORDER BY rowid').all(),jobs:current.prepare('SELECT rowid,* FROM jobs ORDER BY rowid').all(),requests:current.prepare('SELECT rowid,* FROM idempotency ORDER BY rowid').all(),state:current.prepare('SELECT * FROM history_state').all()};}finally{current.close();}};
 const open=()=>openProjectConnection({projectFile,locate:()=>({localDir,cacheDir,tempDir})});return{root,projectFile,localDir,cacheDir,tempDir,history,projectId,inspect,open};
}
test('history6 is frozen independently of current declarations',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('BEGIN');buildPreviousHistoryDatabase(db,6);db.exec('COMMIT');assert.deepEqual(readSchemaManifest(db,'main'),V1_HISTORY_V6_MANIFEST.entries);assert.equal(db.prepare('PRAGMA application_id').get()!.application_id,0x4d696f48);}finally{db.close();}
});
test('the exact history6 upgrade preserves every retained review byte, rowid and state with foreign keys enabled',t=>{
 const f=fixture(t),before=f.inspect(),projectBytes=readFileSync(f.projectFile),connection=f.open();
 try{
  assert.equal(connection.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);assert.deepEqual(connection.db.prepare('PRAGMA main.foreign_key_check').all(),[]);
  assert.equal(connection.db.prepare('SELECT version FROM main.schema_version').get()!.version,HISTORY_SCHEMA_VERSION);
  assert.deepEqual(readSchemaManifest(connection.db,'main'),SCHEMA_MANIFEST.history.entries);
  assert.equal(connection.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence,0);
  assert.equal(connection.historyState,'diverged');assert.equal(connection.historyAdmission.reason,'legacy-token-missing');
  assert.deepEqual(connection.historyAdmission.seen,{contentSequence:0,contentToken:null});
  assert.equal(connection.db.prepare('PRAGMA query_only').get()!.query_only,1);
 }finally{connection.close();}
 const after=f.inspect();for(const key of ['reviews','tasks','jobs','requests'] as const)assert.deepEqual(after[key],before[key]);
 assert.deepEqual(after.state.map(row=>({...row})),before.state.map(row=>({...row,seenContentToken:null})));
 assert.deepEqual(readFileSync(f.projectFile),projectBytes);
 const reopened=f.open();try{assert.deepEqual(reopened.db.prepare('SELECT rowid,* FROM main.image_reviews ORDER BY rowid').all(),before.reviews);assert.equal(reopened.historyState,'diverged');assert.equal(reopened.historyAdmission.seen.contentToken,null);}finally{reopened.close();}
});
for(const point of ['after-drop','after-create','after-copy','before-version','after-version'] as const)test(`history6 image review upgrade rolls all objects and rows back at ${point}`,t=>{
 const f=fixture(t),before=f.inspect(),exec=DatabaseSync.prototype.exec;let hit=false;
 const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{
  if(point==='before-version'&&sql===`UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`){hit=true;throw Error('S2 upgrade failure');}
  exec.call(this,sql);
  if(point==='after-drop'&&sql==='DROP TABLE main.image_reviews'||point==='after-create'&&sql.startsWith('CREATE TABLE main."image_reviews"(')||point==='after-copy'&&sql.startsWith('INSERT INTO main.image_reviews(rowid,')||point==='after-version'&&sql===`UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`){hit=true;throw Error('S2 upgrade failure');}
 });
 try{assert.throws(()=>f.open());assert.equal(hit,true);}finally{mock.mock.restore();}
 assert.deepEqual(f.inspect(),before);const connection=f.open();connection.close();assert.equal(f.inspect().version,HISTORY_SCHEMA_VERSION);
});
for(const damage of ['unexpected-object','changed-trigger'] as const)test(`history6 refuses ${damage} rather than broadening its upgrade whitelist`,t=>{
 const f=fixture(t),db=new DatabaseSync(f.history);
 try{if(damage==='unexpected-object')db.exec('CREATE TABLE unreviewed_storage(value TEXT)');else db.exec('DROP TRIGGER retain_image_reviews;CREATE TRIGGER retain_image_reviews BEFORE DELETE ON image_reviews BEGIN SELECT 1;END');}finally{db.close();}
 const before=f.inspect();assert.throws(()=>f.open());assert.deepEqual(f.inspect(),before);
});
for(const point of ['after-drop','after-copy','after-commit'])test(`a real SIGKILL at ${point} leaves either the exact old profile or the complete committed upgrade`,t=>{
 const f=fixture(t),before=f.inspect(),worker=fileURLToPath(new URL('./fixtures/project-output-history-upgrade-worker.ts',import.meta.url));
 const result=spawnSync(process.execPath,[worker,JSON.stringify({projectFile:f.projectFile,localDir:f.localDir,cacheDir:f.cacheDir,tempDir:f.tempDir,point})],{stdio:'ignore',timeout:30000});
 assert.equal(result.error,undefined);assert.equal(result.signal,'SIGKILL');
 const recovered=f.inspect();if(recovered.version===6)assert.deepEqual(recovered,before);else{assert.equal(recovered.version,HISTORY_SCHEMA_VERSION);assert.deepEqual(recovered.manifest,SCHEMA_MANIFEST.history.entries);for(const key of ['reviews','tasks','jobs','requests']as const)assert.deepEqual(recovered[key],before[key]);assert.deepEqual(recovered.state.map(row=>({...row})),before.state.map(row=>({...row,seenContentToken:null})));}
 const connection=f.open();try{assert.equal(connection.historyState,'diverged');assert.equal(connection.historyAdmission.reason,'legacy-token-missing');assert.equal(connection.historyAdmission.seen.contentToken,null);}finally{connection.close();}assert.equal(f.inspect().version,HISTORY_SCHEMA_VERSION);
});
