import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {initializeLegacyWorkspaceSchema} from '../packages/business/src/workspace-fixed-schema.ts';
import {classifyWorkspaceSchema,installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema,getWorkspaceRestoreContext,isRestoredRecordHeld} from '../packages/business/src/workspace-restore-schema.ts';
const info=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-12T00:00:00.000Z'});
const objects=db=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function snapshot(db){return {objects:objects(db),tables:Object.fromEntries(objects(db).filter(row=>row.type==='table').map(({name})=>[name,db.prepare(`SELECT rowid AS capturedRowid,* FROM ${quote(name)} ORDER BY rowid`).all()]))};}
function fresh(t){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF');initializeLegacyWorkspaceSchema(db);t.after(()=>db.close());return db;}
function seed(db){
 const projectId=randomUUID(),jobId=randomUUID(),exportId=randomUUID(),requestId=randomUUID();
 const raw=value=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,raw({id:projectId,name:'界'}));
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId,projectId,raw({id:jobId,projectId,status:'unknown-future-state',requestId}));
 db.prepare('INSERT INTO exports VALUES(?,?,?)').run(exportId,projectId,raw({id:exportId,projectId,status:'running',requestId,mode:'storyboard'}));
 db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('export',requestId,'a'.repeat(64),exportId);
 db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(jobId,Buffer.from([0,255,13,10]),'at');
 db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'hash',Buffer.from([0,255,13,10]));
 db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.track.add','at',raw({name:'界',n:1}),raw({name:'界',n:2}));
 db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,2,'timeline.track.add','at',raw({name:'界',n:2}),raw({name:'界',n:3}));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,1)').run(projectId);
 const taskId=randomUUID(),taskRequest=randomUUID(),input=raw({projectId,requestId:taskRequest,expectedRevision:1});
 db.prepare("INSERT INTO edit_tasks(position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes) VALUES(17,?,?,'timeline.undo',?,?,?,'timeline:mutation','new','prepared',1,0,NULL,NULL,NULL,NULL,'at','at',16384)").run(taskId,projectId,input,taskRequest,'d'.repeat(64));
 db.exec("UPDATE sqlite_sequence SET seq=7001 WHERE name='edit_tasks'");return {projectId,jobId,exportId,taskId,taskRequest};
}
// Current admission requires TEXT JSON receipts; the legacy BLOB fixture above
// remains unchanged for historical retention and refusal tests.
function seedOrdinary(db,receipt){
 const projectId=randomUUID(),jobId=randomUUID(),exportId=randomUUID(),requestId=randomUUID();
 const raw=value=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,raw({id:projectId,name:'界'}));
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId,projectId,raw({id:jobId,projectId,status:'unknown-future-state',requestId}));
 db.prepare('INSERT INTO exports VALUES(?,?,?)').run(exportId,projectId,raw({id:exportId,projectId,status:'running',requestId,mode:'storyboard'}));
 db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('export',requestId,'a'.repeat(64),exportId);
 db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(jobId,Buffer.from([0,255,13,10]),'at');
 db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(randomUUID(),'hash',receipt);
 db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,1,'timeline.track.add','at',raw({name:'界',n:1}),raw({name:'界',n:2}));
 db.prepare('INSERT INTO timeline_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(),projectId,2,'timeline.track.add','at',raw({name:'界',n:2}),raw({name:'界',n:3}));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,1)').run(projectId);
 const taskId=randomUUID(),taskRequest=randomUUID(),input=raw({projectId,requestId:taskRequest,expectedRevision:1});
 db.prepare("INSERT INTO edit_tasks(position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes) VALUES(17,?,?,'timeline.undo',?,?,?,'timeline:mutation','new','prepared',1,0,NULL,NULL,NULL,NULL,'at','at',16384)").run(taskId,projectId,input,taskRequest,'d'.repeat(64));
 db.exec("UPDATE sqlite_sequence SET seq=7001 WHERE name='edit_tasks'");return {projectId,jobId,exportId,taskId,taskRequest};
}
function assertOld(db,before){for(const [table,rows] of Object.entries(before.tables)){
 const fields=rows[0]?Object.keys(rows[0]).filter(name=>name!=='capturedRowid'):db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row=>row.name).filter(name=>name!=='executionEpoch');
 const result=db.prepare(`SELECT rowid AS capturedRowid,${fields.map(quote).join(',')} FROM ${quote(table)}${table==='schema_version'?' WHERE version<=24':''} ORDER BY rowid`).all();assert.deepEqual(result,rows,table);
}}
test('schema25 adds durable quarantine, retains every raw old column/SQL type/rowid/sequence, and archives redo-tail evidence',t=>{
 const db=fresh(t),ids=seed(db),before=snapshot(db),metadata=info();const restored=installWorkspaceRestoreSchema(db,metadata);
 assert.equal(restored.workspaceOrigin,metadata.workspaceOrigin);assertOld(db,before);
 assert.equal(db.prepare('PRAGMA trusted_schema').get().trusted_schema,0);
 assert.equal(db.prepare('SELECT executionEpoch FROM edit_tasks').get().executionEpoch,'captured');
 const archived=db.prepare('SELECT * FROM workspace_restore_timeline_history ORDER BY capturedRowid').all();assert.equal(archived.length,2);
 db.prepare('DELETE FROM timeline_history WHERE projectId=? AND position>1').run(ids.projectId);
 assert.deepEqual(db.prepare('SELECT * FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),archived);
 assert.equal(validateWorkspaceRestoreSchema(db).workspaceOrigin,metadata.workspaceOrigin);
});
test('current-epoch pending lane coexists without releasing captured task, request identity, sequence or immutable epoch',t=>{
 const db=fresh(t),ids=seed(db),metadata=info();installWorkspaceRestoreSchema(db,metadata);
 const insert=(origin,requestId=randomUUID())=>db.prepare("INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes,executionEpoch) VALUES(?,?,'timeline.undo',?,?,?,'timeline:mutation','new','prepared',1,0,'now','now',16384,?)").run(randomUUID(),ids.projectId,JSON.stringify({projectId:ids.projectId,requestId}),requestId,'a'.repeat(64),origin);
 assert.throws(()=>insert('captured'),/RESTORE_ORIGIN_REQUIRED|RESTORED_RECORD_HELD/);assert.throws(()=>insert(randomUUID()),/RESTORE_ORIGIN_REQUIRED/);
 insert(metadata.workspaceOrigin);assert.equal(db.prepare('SELECT max(position) AS n FROM edit_tasks').get().n,7002);
 assert.throws(()=>insert(metadata.workspaceOrigin),/UNIQUE/);
 assert.throws(()=>db.prepare('UPDATE edit_tasks SET executionEpoch=?').run(metadata.workspaceOrigin),/RESTORE_|RESTORED_RECORD_HELD/);
 assert.throws(()=>insert(metadata.workspaceOrigin,ids.taskRequest),/immutable|HELD/);
});
for(const recursive of [0,1])test(`main-database marker and captured-row guards reject INSERT/IGNORE/REPLACE/UPSERT/update/delete with recursive_triggers=${recursive}`,t=>{
 const db=fresh(t),ids=seed(db);installWorkspaceRestoreSchema(db,info());const before=snapshot(db);db.exec(`PRAGMA recursive_triggers=${recursive}`);
 for(const sql of ['INSERT INTO schema_version VALUES(1)','INSERT OR IGNORE INTO schema_version VALUES(1)','INSERT OR REPLACE INTO schema_version VALUES(1)','INSERT INTO schema_version VALUES(1) ON CONFLICT(version) DO NOTHING'])assert.throws(()=>db.exec(sql),/RESTORE_LEGACY_RUNTIME_BLOCKED/);
 for(const sql of ['UPDATE schema_version SET version=26 WHERE version=25','DELETE FROM schema_version WHERE version=1','DELETE FROM schema_version WHERE version=25','INSERT INTO schema_version VALUES(26)'])assert.throws(()=>db.exec(sql),/RESTORE_SCHEMA_MARKERS_IMMUTABLE/);
 for(const sql of ["UPDATE jobs SET data='{}'",'DELETE FROM exports','INSERT OR REPLACE INTO jobs SELECT * FROM jobs','INSERT OR REPLACE INTO timeline_requests SELECT * FROM timeline_requests','INSERT OR REPLACE INTO workspace_restoration SELECT * FROM workspace_restoration','DELETE FROM workspace_restore_holds','UPDATE workspace_restore_timeline_history SET afterSnapshot=beforeSnapshot'])assert.throws(()=>db.exec(sql),/RESTOR/);
 // A different primary key colliding with captured export receipt scope/key
 // must not bypass a delete guard while recursive triggers are disabled.
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO idempotency VALUES(?,?,?,?)').run('export',db.prepare('SELECT requestId FROM idempotency').get().requestId,'b'.repeat(64),randomUUID()),/HELD/);
 assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);assert.equal(ids.jobId.length,36);
});
test('offline source24 rejects unknown imported triggers before any construction statement',t=>{
 const db=fresh(t),projectId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'original'}));
 db.exec("CREATE TRIGGER hostile BEFORE INSERT ON schema_version BEGIN UPDATE projects SET data='{}'; END;");
 const before=snapshot(db);assert.throws(()=>installWorkspaceRestoreSchema(db,info()),error=>error.code==='RESTORE_SCHEMA_UNSUPPORTED');
 assert.deepEqual(snapshot(db),before);assert.match(db.prepare('SELECT data FROM projects').get().data,/original/);
});
test('every construction DDL boundary rolls back schema/rows/guards/sequence in a single transaction',t=>{
 for(const pattern of [/CREATE TABLE workspace_restoration/,/INSERT INTO workspace_restore_timeline_history/,/CREATE TRIGGER restore_legacy_schema_gate/,/^COMMIT$/]){
  const db=fresh(t);seed(db);const before=snapshot(db);let fired=false;
  const wrapped={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql){if(pattern.test(sql)&&/^COMMIT$/.test(sql)){fired=true;throw Error('injected restore crash');}const result=db.exec(sql);if(!fired&&pattern.test(sql)){fired=true;throw Error('injected restore crash');}return result;}};
  assert.throws(()=>installWorkspaceRestoreSchema(wrapped,info()),/injected restore crash/);assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
  installWorkspaceRestoreSchema(db,info());assert.equal(classifyWorkspaceSchema(db).schemaVersion,25);
 }
});
test('partial metadata/profile/marker/guard/epoch structures refuse with no ordinary fallback',t=>{
 for(const sql of ["DROP TRIGGER restore_workspace_restoration_delete;DELETE FROM workspace_restoration",'DROP TRIGGER restore_legacy_schema_gate','DROP TRIGGER restore_schema_marker_delete;DELETE FROM schema_version WHERE version=25',"DROP TRIGGER restore_workspace_restoration_update;UPDATE workspace_restoration SET profile='other'",'DROP TABLE workspace_restore_timeline_history']){
  const db=fresh(t);seed(db);installWorkspaceRestoreSchema(db,info());
  try{db.exec(sql);}catch{ // The table CHECK itself may reject a malformed profile.
   continue;
  }
  assert.throws(()=>validateWorkspaceRestoreSchema(db),/RESTORE_/);assert.equal(db.isTransaction,false);
 }
});
test('unregistered/copied/mutated/closed stores cannot manufacture a verified restoration or ordinary context',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'restore-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let store=openStore(root);assert.equal(getWorkspaceRestoreContext(store),null);
 assert.equal(getWorkspaceRestoreContext({...store}),null);installCurrentWorkspaceRestoreSchema(store.db,info());store.close();store=openStore(root);
 const ctx=getWorkspaceRestoreContext(store);assert.throws(()=>getWorkspaceRestoreContext({...store}),/not verified/);const originalPrepare=store.db.prepare;store.db.prepare=()=>({iterate:()=>[],get:()=>undefined});assert.throws(()=>getWorkspaceRestoreContext({...store}),/not verified/);store.db.prepare=originalPrepare;assert.equal(Object.isFrozen(ctx),true);assert.equal(Object.isFrozen(ctx.heldCounts),true);assert.equal(isRestoredRecordHeld(store,'agent_chat_quota','1'),true);
 const rootValue=store.root;store.root+='-fake';assert.throws(()=>getWorkspaceRestoreContext(store),/not verified/);store.root=rootValue;
 store.close();assert.throws(()=>getWorkspaceRestoreContext(store),/not verified/);
});
test('metadata UUID/hash validation rejects trailing newline and construction leaves source24 unchanged',t=>{
 const db=fresh(t),before=snapshot(db);for(const key of ['restorationId','workspaceOrigin','sourceBackupId','manifestHash','sourceDbHash']){const value=info();value[key]+='\n';assert.throws(()=>installWorkspaceRestoreSchema(db,value),/RESTORE_METADATA_INVALID/);assert.deepEqual(snapshot(db),before);}
});
test('ordinary current-schema reopen keeps raw schema/rows/receipts and source profile classification intact',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'restore-ordinary-'));t.after(()=>rmSync(root,{recursive:true,force:true}));let store=openStore(root);
 try{
  const receipt=' \n'+JSON.stringify({name:'界',retained:true},null,'\t')+'\n ';
  seedOrdinary(store.db,receipt);
  const before=snapshot(store.db),profile=readCurrentWorkspaceRole(store.db);assert.equal(profile,'ordinary-50');
  store.close();store=openStore(root);
  assert.deepEqual(snapshot(store.db),before);assert.deepEqual(readCurrentWorkspaceRole(store.db),profile);
  assert.deepEqual({...store.db.prepare('SELECT typeof(response) AS type,response FROM timeline_requests').get()},{type:'text',response:receipt});
  assert.equal(getWorkspaceRestoreContext(store),null);
 }finally{if(store.db.isOpen)store.close();}
});
test('ordinary current-schema reopen rejects legacy BLOB receipt without changing schema or retained rows',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'restore-ordinary-blob-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const store=openStore(root);
 seed(store.db);const before=snapshot(store.db);assert.equal(store.db.prepare('SELECT typeof(response) AS type FROM timeline_requests').get().type,'blob');store.close();
 assert.throws(()=>openStore(root),error=>error.code==='WORKSPACE_VOLUME_ENVELOPE_INVALID');
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
 try{assert.deepEqual(snapshot(db),before);}finally{db.close();}
});
test('quoted keyword lookalikes are not equivalent fixed schema objects',t=>{
 const db=fresh(t);db.exec('DROP TABLE workspace_preferences;CREATE TABLE workspace_preferences(projectId TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER "NOT" "NULL" CHECK(revision>0 AND revision<=9007199254740991),state TEXT NOT NULL CHECK(json_valid(state) AND length(CAST(state AS BLOB))<=16384))');
 assert.throws(()=>installWorkspaceRestoreSchema(db,info()),error=>error.code==='RESTORE_SCHEMA_UNSUPPORTED');
});
test('history and cursor positions are bounded real integers before archival, not coercible affinity values',t=>{
 for(const table of ['timeline_history','timeline_history_cursors']){
  const db=fresh(t);seed(db);db.exec(table==='timeline_history'?'DROP TRIGGER immutable_timeline_history':'SELECT 1');
  // Keep source fixed SQL intact after constructing a malformed legacy row.
  const restore=db.prepare("SELECT sql FROM sqlite_schema WHERE name='immutable_timeline_history'").get()?.sql;
  if(table==='timeline_history'){
   db.prepare('UPDATE timeline_history SET position=? WHERE position=2').run('invalid-position');
   db.exec("CREATE TRIGGER immutable_timeline_history BEFORE UPDATE ON timeline_history BEGIN SELECT RAISE(ABORT,'timeline history entries are immutable');END");
  }else db.prepare('UPDATE timeline_history_cursors SET position=?').run('invalid-position');
  assert.throws(()=>installWorkspaceRestoreSchema(db,info()),error=>error.code==='RESTORE_HISTORY_IDENTITY_INVALID');
 }
});
test('source sequence identity rejects corrupt type, duplicate name and regressed high-water without changing anything',t=>{
 for(const sql of ["UPDATE sqlite_sequence SET seq='not-an-integer' WHERE name='edit_tasks'","UPDATE sqlite_sequence SET seq=16 WHERE name='edit_tasks'","INSERT INTO sqlite_sequence(name,seq) SELECT name,seq FROM sqlite_sequence WHERE name='edit_tasks'"]){
  const db=fresh(t);seed(db);db.exec(sql);const before=snapshot(db);assert.throws(()=>installWorkspaceRestoreSchema(db,info()),error=>error.code==='RESTORE_SEQUENCE_INVALID');assert.deepEqual(snapshot(db),before);
 }
});
test('strict restore source classification supports independently frozen historical schemas after their ordinary upgrade to24',t=>{
 for(const name of ['images-legacy-schema15.sql','images-legacy-schema17.sql','images-legacy-schema18.sql']){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA trusted_schema=OFF');db.exec(readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8'));initializeLegacyWorkspaceSchema(db);
  assert.equal(classifyWorkspaceSchema(db).schemaVersion,24);assert.equal(installWorkspaceRestoreSchema(db,info()).schemaVersion,25);
 }
});
test('synthetic legacy export projection without JSON requestId binds its unique original receipt without rewriting JSON',t=>{
 for(const namespace of ['export','timeline']){
  const db=fresh(t),ids=seed(db);db.prepare('DELETE FROM exports WHERE id=?').run(ids.exportId);
  const requestId=db.prepare("SELECT requestId FROM idempotency WHERE scope='export'").get().requestId;
  // Reinsert exact legacy export projection; no runtime-origin field appears.
  const original=JSON.stringify({id:ids.exportId,projectId:ids.projectId,status:'running',snapshot:[]});db.prepare('INSERT INTO exports VALUES(?,?,?)').run(ids.exportId,ids.projectId,original);
  if(namespace==='timeline'){db.exec('DELETE FROM idempotency');db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,'a'.repeat(64),JSON.stringify({id:ids.exportId,projectId:ids.projectId,status:'queued'}));}
  installWorkspaceRestoreSchema(db,info());const held=db.prepare("SELECT namespace,requestId,operation FROM workspace_restore_holds WHERE kind='exports'").get();
  assert.equal(held.namespace,namespace);assert.equal(held.requestId,requestId);assert.equal(held.operation,namespace==='timeline'?'timeline.render':'export.create');assert.equal(db.prepare('SELECT data FROM exports').get().data,original);validateWorkspaceRestoreSchema(db);
 }
});
test('restart archive byte limits run before hashing and include cursor values',t=>{
 const db=fresh(t);seed(db);installWorkspaceRestoreSchema(db,info());const name='restore_workspace_restore_timeline_cursors_update',sql=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql;
 db.exec(`DROP TRIGGER ${name};UPDATE workspace_restore_timeline_cursors SET position=zeroblob(67108865);${sql}`);
 assert.throws(()=>validateWorkspaceRestoreSchema(db),error=>error.code==='RESTORE_ARCHIVE_LIMIT');
});
test('restart captured-record limits run before hash scan without counting new live receipts',t=>{
 const db=fresh(t);seed(db);const metadata=info();installWorkspaceRestoreSchema(db,metadata);
 const insert=db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)');db.exec('BEGIN');for(let i=0;i<20010;i++)insert.run(`new-live-${i}`,'hash','{}');db.exec('COMMIT');
 assert.equal(validateWorkspaceRestoreSchema(db).workspaceOrigin,metadata.workspaceOrigin);
 const name='restore_workspace_restore_holds_insert',sql=db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql;db.exec(`DROP TRIGGER ${name}`);
 db.exec("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<20001) INSERT INTO workspace_restore_holds(kind,id,capturedRowid,rowHash) SELECT 'timeline_requests','fake-'||n,n+10000,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' FROM numbers");db.exec(sql);
 assert.throws(()=>validateWorkspaceRestoreSchema(db),error=>error.code==='RESTORE_RECORD_LIMIT');
});
test('captured export request IDs must be JSON text or absent, never objects/arrays/numbers even with a receipt',t=>{
 for(const requestId of [[],{},42,true]){
  const db=fresh(t),ids=seed(db);db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({id:ids.exportId,projectId:ids.projectId,status:'running',requestId}),ids.exportId);
  assert.throws(()=>installWorkspaceRestoreSchema(db,info()),error=>error.code==='RESTORE_EXPORT_IDENTITY_UNSUPPORTED');
 }
});
