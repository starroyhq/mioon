import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {initializeLegacyWorkspaceSchema} from '../packages/business/src/workspace-fixed-schema.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {classifyWorkspaceSchema,installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {tree} from './helpers/workspace-restore-offline-fixture.mjs';

const info=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-12T05:00:00.000Z'});
const mockNames=['mock_provider_submissions','mock_provider_submissions_request','mock_provider_tasks','sqlite_autoindex_mock_provider_tasks_1','sqlite_autoindex_mock_provider_tasks_2'];
const objects=db=>db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
const bigRows=(db,sql)=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all();};
const q=name=>'"'+name.replaceAll('"','""')+'"';
function snapshot(db){return {objects:objects(db),tables:Object.fromEntries(objects(db).filter(row=>row.type==='table').map(({name})=>[name,{fields:db.prepare(`PRAGMA table_info(${q(name)})`).all().map(row=>row.name),rows:bigRows(db,`SELECT rowid AS capturedRowid,* FROM ${q(name)} ORDER BY rowid`)}]))};}
function assertOriginal(db,before){for(const [table,{fields,rows}] of Object.entries(before.tables))assert.deepEqual(bigRows(db,`SELECT rowid AS capturedRowid,${fields.map(q).join(',')} FROM ${q(table)} ${table==='schema_version'?'WHERE version<=24':''} ORDER BY rowid`),rows,table);}
function fresh(t,{mock=true}={}){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');initializeLegacyWorkspaceSchema(db);
 // This is the real ordinary constructor, so production SQL drift makes these
 // compatibility tests fail. No submit/poll/download/provider execution occurs.
 if(mock)createMockProvider({db,root:'/synthetic-unused-root'});
 t.after(()=>db.close());return db;
}
function seedRaw(db){
 const id='mock-raw-task',request='request-界-🙂',projectId=randomUUID();
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'Mock preserved ledger'}));
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(randomUUID(),projectId,JSON.stringify({id:'replace',projectId,status:'submission_unknown'}));
 // Make the application identity valid, independently from provider identities.
 const job=db.prepare('SELECT id FROM jobs LIMIT 1').get().id;db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({id:job,projectId,status:'submission_unknown'}),job);
 db.prepare('INSERT INTO mock_provider_tasks(rowid,provider_job_id,request_id,snapshot_json,snapshot_hash,scenario,created_at_ms,ready_at_ms,poll_count,download_attempts,cancelled) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(9007199254740993n,id,request,Buffer.from([0,255,13,10]),'f'.repeat(64),'opaque_original_outcome',9007199254740993n,123.25,7,2,0);
 db.prepare('INSERT INTO mock_provider_submissions(id,request_id,job_id,provider_job_id,created_at_ms,outcome) VALUES(?,?,?,?,?,?)').run(17,request,null,id,9007199254740993n,Buffer.from([0,254,13,10]));
 db.prepare('INSERT INTO mock_provider_submissions(id,request_id,job_id,provider_job_id,created_at_ms,outcome) VALUES(?,?,?,?,?,?)').run(99,'ambiguous-request',job,null,1,'  unknown\n');
 db.prepare("UPDATE sqlite_sequence SET seq=7001 WHERE name='mock_provider_submissions'").run();
 return {id,projectId,job};
}

test('actual ordinary Mock constructor schema is accepted exactly and all raw ledgers/types/rowids/sequences survive',t=>{
 const db=fresh(t),ids=seedRaw(db),before=snapshot(db),metadata=info();
 assert.deepEqual(before.objects.filter(row=>row.tbl_name.startsWith('mock_provider_')).map(row=>row.name),mockNames);
 assert.equal(classifyWorkspaceSchema(db).schemaVersion,24);const result=installWorkspaceRestoreSchema(db,metadata);assertOriginal(db,before);
 assert.equal(result.workspaceOrigin,metadata.workspaceOrigin);assert.equal(validateWorkspaceRestoreSchema(db).workspaceOrigin,metadata.workspaceOrigin);
 assert.deepEqual(objects(db).filter(row=>mockNames.includes(row.name)),before.objects.filter(row=>mockNames.includes(row.name)),'provider table/index SQL is not rewritten');
 assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_restore_mock_evidence').get().n,3);
 assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='mock_provider_submissions'").get().seq,7001);
 assert.ok(!Object.hasOwn(result.heldCounts,'mock_provider_tasks'),'provider ledger counts do not silently change application task counts');
 assert.throws(()=>db.exec('INSERT OR IGNORE INTO schema_version VALUES(1)'),/RESTORE_LEGACY_RUNTIME_BLOCKED/);
 assert.equal(ids.id,'mock-raw-task');
});

test('empty actual Mock ledgers preserve absent submission sequence row; no-Mock schema25 remains unchanged',t=>{
 const db=fresh(t);assert.equal(db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='mock_provider_submissions'").get(),undefined);
 const before=snapshot(db);installWorkspaceRestoreSchema(db,info());assertOriginal(db,before);
 assert.equal(db.prepare("SELECT records FROM workspace_restore_mock_evidence WHERE name='sqlite_sequence_mock_provider_submissions'").get().records,0);
 assert.equal(db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='mock_provider_submissions'").get(),undefined);validateWorkspaceRestoreSchema(db);
 const ordinary=fresh(t,{mock:false});installWorkspaceRestoreSchema(ordinary,info());assert.equal(objects(ordinary).some(row=>row.name.includes('mock')),false);validateWorkspaceRestoreSchema(ordinary);
});

for(const recursive of [0,1])test(`optional Mock ledger/evidence barriers reject INSERT/UPDATE/DELETE/REPLACE with recursive_triggers=${recursive}`,t=>{
 const db=fresh(t);seedRaw(db);installWorkspaceRestoreSchema(db,info());const before=snapshot(db);db.exec(`PRAGMA recursive_triggers=${recursive}`);
 for(const table of ['mock_provider_tasks','mock_provider_submissions','workspace_restore_mock_evidence']){
  for(const sql of [`DELETE FROM ${table}`,`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`,`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table}`])assert.throws(()=>db.exec(sql),/RESTORED_RECORD_HELD|RESTORE_METADATA_IMMUTABLE/);
 }
 assert.throws(()=>db.exec('UPDATE mock_provider_tasks SET poll_count=poll_count+1'),/RESTORED_RECORD_HELD/);
 assert.throws(()=>db.exec("UPDATE mock_provider_submissions SET outcome='replayed'"),/RESTORED_RECORD_HELD/);
 assert.throws(()=>db.exec("UPDATE workspace_restore_mock_evidence SET digest=printf('%064d',0)"),/RESTORE_METADATA_IMMUTABLE/);
 assert.throws(()=>db.prepare('INSERT INTO mock_provider_submissions(request_id,created_at_ms,outcome) VALUES(?,?,?)').run('new-attempt',0,'attempted'),/RESTORED_RECORD_HELD/);
 assert.deepEqual(snapshot(db),before);validateWorkspaceRestoreSchema(db);
});

for(const variant of ['missing-tasks','missing-submissions','missing-request-index','altered-index','altered-table','extra-index','extra-trigger'])test(`optional Mock source profile refuses ${variant} before imported SQL effects`,t=>{
 const db=fresh(t);seedRaw(db);
 const sql={
  'missing-tasks':'DROP TABLE mock_provider_tasks',
  'missing-submissions':'DROP TABLE mock_provider_submissions',
  'missing-request-index':'DROP INDEX mock_provider_submissions_request',
  'altered-index':'DROP INDEX mock_provider_submissions_request;CREATE INDEX mock_provider_submissions_request ON mock_provider_submissions(request_id DESC)',
  'altered-table':'ALTER TABLE mock_provider_tasks ADD COLUMN unreviewed TEXT',
  'extra-index':'CREATE INDEX unknown_mock_extension ON mock_provider_tasks(scenario)',
  'extra-trigger':"CREATE TRIGGER unknown_mock_trigger BEFORE INSERT ON schema_version BEGIN UPDATE projects SET data='{}';END",
 }[variant];db.exec(sql);const before=snapshot(db);
 assert.throws(()=>installWorkspaceRestoreSchema(db,info()),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(snapshot(db),before);
});

for(const variant of ['guard-missing','evidence-missing','ledger-mutated','sequence-mutated','sequence-duplicated'])test(`restored optional Mock profile refuses ${variant} with exact fixed schema and evidence`,t=>{
 const db=fresh(t);seedRaw(db);installWorkspaceRestoreSchema(db,info());
 if(variant==='guard-missing')db.exec('DROP TRIGGER restore_hold_mock_provider_tasks_update');
 if(variant==='evidence-missing')db.exec('DROP TABLE workspace_restore_mock_evidence');
 if(variant==='ledger-mutated'){
  const guard=db.prepare("SELECT sql FROM sqlite_schema WHERE name='restore_hold_mock_provider_tasks_update'").get().sql;
  db.exec('DROP TRIGGER restore_hold_mock_provider_tasks_update;UPDATE mock_provider_tasks SET poll_count=poll_count+1');db.exec(guard);
 }
 if(variant==='sequence-mutated')db.exec("UPDATE sqlite_sequence SET seq=7002 WHERE name='mock_provider_submissions'");
 if(variant==='sequence-duplicated')db.exec("INSERT INTO sqlite_sequence SELECT name,seq FROM sqlite_sequence WHERE name='mock_provider_submissions'");
 assert.throws(()=>validateWorkspaceRestoreSchema(db),error=>['RESTORE_SCHEMA_INVALID','RESTORE_CAPTURE_CHANGED','RESTORE_SEQUENCE_INVALID'].includes(error.code));
});

test('Mock evidence excludes legitimate new edit sequence advancement but keeps exact original Mock sequence',t=>{
 const db=fresh(t),{projectId}=seedRaw(db),metadata=info();installWorkspaceRestoreSchema(db,metadata);
 const requestId=randomUUID();db.prepare("INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes,executionEpoch) VALUES(?,?,'timeline.undo',?,?,?,'timeline:mutation','new','prepared',1,0,'now','now',16384,?)").run(randomUUID(),projectId,JSON.stringify({projectId,requestId}),requestId,'a'.repeat(64),metadata.workspaceOrigin);
 assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='edit_tasks'").get().seq,1);assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='mock_provider_submissions'").get().seq,7001);validateWorkspaceRestoreSchema(db);
});

test('optional Mock evidence installation failure rolls back every original object, byte/type/rowid and sequence',t=>{
 const db=fresh(t);seedRaw(db);const before=snapshot(db);let fired=false;
 const wrapper={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql){const result=db.exec(sql);if(sql.includes('CREATE TABLE workspace_restore_mock_evidence')){fired=true;throw Error('synthetic optional DDL failure');}return result;}};
 assert.throws(()=>installWorkspaceRestoreSchema(wrapper,info()),/synthetic optional DDL failure/);assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
});

for(const restored of [false,true])test(`combined Mock record cap runs before ${restored?'reopen evidence':'initial preservation'} hashing`,t=>{
 const db=fresh(t);if(restored)installWorkspaceRestoreSchema(db,info());let guard;
 if(restored){guard=db.prepare("SELECT sql FROM sqlite_schema WHERE name='restore_hold_mock_provider_tasks_insert'").get().sql;db.exec('DROP TRIGGER restore_hold_mock_provider_tasks_insert');}
 db.exec("WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<20001) INSERT INTO mock_provider_tasks(provider_job_id,request_id,snapshot_json,snapshot_hash,scenario,created_at_ms,ready_at_ms) SELECT 'mock-'||n,'request-'||n,'{}','hash','unknown',0,0 FROM x");if(guard)db.exec(guard);
 let hashed=0;const wrapper={get isTransaction(){return db.isTransaction;},exec:db.exec.bind(db),prepare(sql){if(sql.startsWith('SELECT rowid AS id FROM'))hashed++;return db.prepare(sql);}};
 assert.throws(()=>restored?validateWorkspaceRestoreSchema(wrapper):installWorkspaceRestoreSchema(wrapper,info()),{code:'RESTORE_RECORD_LIMIT'});assert.equal(hashed,0);
});

for(const populated of [false,true])test(`real offline restore of ordinary ${populated?'populated':'empty'} Mock workspace reopens without inherited provider work`,async t=>{
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'restore-mock-profile-')),source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o700});
 const db=new DatabaseSync(path.join(source,'workbench.sqlite'));db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeLegacyWorkspaceSchema(db);
 createMockProvider({db,root:source});if(populated)seedRaw(db);const before=snapshot(db);db.close();const sourceBefore=tree(source);
 await createWorkspaceBackup({source,destination:backup});const backupBefore=tree(backup),result=await restoreWorkspaceBackup({directory:backup,destination});
 const store=openStore(destination);let services,worker;
 try{
  assertOriginal(store.db,before);const frozen=snapshot(store.db),changes=store.db.prepare('SELECT total_changes() AS n').get().n;
  const bomb=()=>{throw Error('Unexpected inherited provider access');};services=createServices(store,new Proxy(new Map(),{get:bomb}));worker=startWorker(store,new Proxy({},{get:bomb}),new Proxy({},{get:bomb}));await worker.tick();await worker.stop();worker=undefined;await services.drain();services=undefined;
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);assert.deepEqual(snapshot(store.db),frozen);assert.equal(validateWorkspaceRestoreSchema(store.db).workspaceOrigin,result.workspaceOrigin);
 }finally{await worker?.stop();await services?.drain();store.close();}
 assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
});


for(const variant of ['text','blob','negative'])test(`Mock sequence ${variant} corruption is rejected before any evidence digest`,t=>{
 const db=fresh(t);seedRaw(db);installWorkspaceRestoreSchema(db,info());
 const value=variant==='text'?'x'.repeat(2*1024*1024):variant==='blob'?Buffer.alloc(2*1024*1024,255):-1;
 db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='mock_provider_submissions'").run(value);
 let hashed=0;const wrapper={get isTransaction(){return db.isTransaction;},exec:db.exec.bind(db),prepare(sql){if(sql.startsWith('SELECT rowid AS id FROM'))hashed++;return db.prepare(sql);}};
 assert.throws(()=>validateWorkspaceRestoreSchema(wrapper),{code:'RESTORE_SEQUENCE_INVALID'});assert.equal(hashed,0);
});
