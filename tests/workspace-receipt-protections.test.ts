// Fixed26 historical receipt repair over independent golden24/26 and25/27
// evidence. Raw malformed JSON/BLOB preservation fixtures are intentionally
// outside today's volume40 admission. Two separately named tests below retain
// actual current-dispatch coverage; no historical data is normalized for it.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {createWorkspaceSchemaDispatch,readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';
import {createWorkspaceRestoreProfileV27} from '../packages/business/src/workspace-restore-schema-v27.ts';
import {classifyWorkspaceSchema,detectWorkspaceRestoreEvidence,installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {open,fixture,snapshot,golden,facade} from './workspace-schema26-fixtures.mjs';
import type { WorkspaceSchemaReader } from '@mioon/business/workspace-schema-profile';
import type { DatabaseSync } from 'node:sqlite';

const test=(name: string,run?: nodeTest.TestFn|undefined)=>nodeTest(`fixed26 historical receipt repair: ${name}`,run);

const names=['immutable_timeline_responses','immutable_reference_responses','reject_reference_request_replacement','retain_reference_requests'];
const tables=['timeline_requests','reference_requests'];
const fixed=Object.values((golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).definitions).filter(object=>names.includes(object.name));
// Current ordinary48 retention guards are lifecycle-aware; the reviewed current
// delta fixture pins their exact SQL independently of the implementation.
const currentDelta=JSON.parse((readFileSync(new URL('./fixtures/workspace-schema-profiles/current-ordinary-48-delta.json',import.meta.url),'utf8') as string));
const currentFixed=fixed.map(object=>({...object,sql:currentDelta.objectSql[object.name]??object.sql}));
const unsupported=(error: { code: string; })=>(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code==='RESTORE_SCHEMA_UNSUPPORTED';
const markers=[...Array.from({length:24},(_,index)=>index+1),26];
function dispatch(onLegacy:(db:DatabaseSync)=>unknown=()=>{}){
 const restored27=createWorkspaceRestoreProfileV27(initializeWorkspaceSchemaThrough24);
 // This file's independent golden24/26 data deliberately includes raw BLOB,
 // malformed JSON and large rowids. Exercise its fixed historical repair,
 // rather than asking today's default40 feature admission to migrate it.
 return {initialize(db: DatabaseSync){
  const role=readCurrentWorkspaceRole(db);
  if(role==='restored-25-evidence')return (validateWorkspaceRestoreSchema((db as unknown as Parameters<typeof validateWorkspaceRestoreSchema>[0])) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata);
  if(role==='restored-27-evidence')return restored27.validateWorkspaceRestoreSchemaV27((db as unknown as Parameters<typeof restored27.validateWorkspaceRestoreSchemaV27>[0]));
  assert.ok(role==='ordinary-through-24'||role==='ordinary-26','this historical fixture has an exact24/26 or25/27 role');
  const marker=db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='schema_version' COLLATE NOCASE").get();
  const complete24=marker&&db.prepare('SELECT COUNT(*) AS count FROM main.schema_version').get()?.count===24;
  if(role==='ordinary-through-24'&&!complete24){onLegacy(db);initializeWorkspaceSchemaThrough24((db as unknown as Parameters<typeof initializeWorkspaceSchemaThrough24>[0]));}
  initializeWorkspaceSchema26((db as unknown as Parameters<typeof initializeWorkspaceSchema26>[0]));return null;
 }};
}
function currentDispatch(onLegacy:(db:DatabaseSync)=>unknown=()=>{}){
 return createWorkspaceSchemaDispatch({initializeThrough24(db){onLegacy(db);initializeWorkspaceSchemaThrough24(db);},
  classify:classifyWorkspaceSchema,detectRestoreEvidence:detectWorkspaceRestoreEvidence,install:installWorkspaceRestoreSchema,validate:validateWorkspaceRestoreSchema});
}
function fresh(t: nodeTest.TestContext,version=26,file=':memory:'){
 const db=open(file);t.after(()=>{if(db.isOpen)db.close();});fixture(db);
 if(version===26)initializeWorkspaceSchema26(db);
 return db;
}
function drop(db: DatabaseSync,selected=names){for(const name of selected)db.exec(`DROP TRIGGER ${name}`);}
function protections(db: DatabaseSync){return db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all().filter((object)=>names.includes((object.name as string))).map((object)=>({...object}));}
function seedRaw(db: DatabaseSync){
 for(const table of tables){
  const put=db.prepare(`INSERT INTO ${table}(rowid,requestId,requestHash,response) VALUES(?,?,?,?)`);
  put.setReadBigInts(true);
  for(const [index,response]of [' \n{"escaped":"\\u754c","n":2.00}\n ','null','false','0','[]','invalid JSON',Buffer.from([0,255,13,10]),' '.repeat(70000)].entries())
   put.run(9007199254740993n+BigInt(index),`${table}-${index}`,index%2?Buffer.from([0,254,10]):'hash',response);
 }
}
function assertFixed(db: DatabaseSync){assert.deepEqual(protections(db),fixed.toSorted((a,b)=>a.name.localeCompare(b.name)));}
function assertRecords(db: DatabaseSync,before: import('./helpers/strict-workspace-boundary-types.ts').SchemaSnapshot,{migrated=false}={}){
 const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const [name,value]of Object.entries(before.tables)){
  const current=migrated&&name==='schema_version'?{...after.tables[name],rows:after.tables[name].rows.filter((row)=>row[0]!=='26')}:after.tables[name];
  assert.deepEqual(current,value,`${name}: exact raw SQLite types, bytes, rowids and sequence`);
 }
}

test('fresh real through24 constructor still boots ordinary26 with all fixed receipt protections',(t: { after: (arg0: () => void) => void; })=>{
 const db=open(':memory:');t.after(()=>db.close());let legacyCalls=0,realCalls=0;
 // Reference profile construction runs the closure on disposable in-memory
 // databases; only the real database call is a bootstrap write.
 assert.equal(dispatch((((target: DatabaseSync)=>{legacyCalls++;if(target===db)realCalls++;}) as unknown as Parameters<typeof dispatch>[0])).initialize(db),null);assert.equal(realCalls,1);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-26');assertFixed(db);
 assert.ok(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='timeline_requests_project'").get());
});

nodeTest('current default dispatcher independently boots ordinary58 with the same receipt protections',t=>{
 const db=open(':memory:');t.after(()=>db.close());let legacyCalls=0,realCalls=0;
 assert.equal(currentDispatch((((target: DatabaseSync)=>{legacyCalls++;if(target===db)realCalls++;}) as unknown as Parameters<typeof currentDispatch>[0])).initialize(db),null);assert.equal(realCalls,1);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-60');assert.deepEqual(protections(db),currentFixed.toSorted((a,b)=>a.name.localeCompare(b.name)));
});

nodeTest('current feature admission refuses the intentionally raw historical receipt fixture without changing it',t=>{
 const db=fresh(t);seedRaw(db);drop(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];let legacyCalls=0;
 assert.throws(()=>currentDispatch(()=>legacyCalls++).initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.equal(legacyCalls,0);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.equal(db.isTransaction,false);
 assert.deepEqual(effects,[],'current volume admission refuses before historical receipt repair or migration writes');
});

for(const version of [24,26] as const)for(const missing of [names,...names.map(name=>[name])] as const)test(`ordinary${version} startup restores only missing trusted receipts: ${missing.join(',')}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRaw(db);drop(db,missing);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: string[]=[];let legacyCalls=0;
 const checked=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{if(event.phase==='before')effects.push(((event.sql) as unknown as Parameters<typeof effects.push>[0]));}) as unknown as import("node:sqlite").DatabaseSync);
 assert.equal(dispatch(()=>legacyCalls++).initialize(checked),null);assert.equal(legacyCalls,0);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-26');assertFixed(db);assertRecords(db,before,{migrated:version===24});
 const receiptDdl=effects.filter(sql=>/^CREATE TRIGGER main\.(?:immutable_(?:timeline|reference)_responses|reject_reference_request_replacement|retain_reference_requests)\b/.test((sql as string)));
 assert.equal(receiptDdl.length,missing.length);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),markers);
 const repaired=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),changes=db.prepare('SELECT total_changes() AS value').get()!.value;
 effects.length=0;dispatch().initialize(checked);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),repaired);assert.equal(db.prepare('SELECT total_changes() AS value').get()!.value,changes);
 assert.equal(effects.some(sql=>/^CREATE|^INSERT|^UPDATE|^DELETE|^DROP/.test((sql as string))),false,'idempotent reopen has no DDL or record writes');
});

test('actual26 file reopen restores all four protections with raw receipts unchanged',(t: { after: (arg0: { (): void; (): void; }) => void; })=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mioon-receipt-protections-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'workspace.sqlite'),first=fresh((t as unknown as Parameters<typeof fresh>[0]),26,file);seedRaw(first);drop(first);const before=(snapshot(first) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);first.close();
 const db=open(file);t.after(()=>db.close());dispatch().initialize(db);assertFixed(db);assertRecords(db,before);
 for(const recursive of [0,1] as const){
  db.exec(`PRAGMA recursive_triggers=${recursive}`);
  for(const table of tables)assert.throws(()=>db.exec(`UPDATE ${table} SET response='rewritten'`),/responses are immutable/);
  assert.throws(()=>db.exec('DELETE FROM reference_requests'),/must be retained/);
  assert.throws(()=>db.exec('INSERT OR REPLACE INTO reference_requests SELECT * FROM reference_requests'),/responses are immutable/);
  assert.throws(()=>db.exec('INSERT OR IGNORE INTO reference_requests SELECT * FROM reference_requests'),/responses are immutable/);
 }
 assertRecords(db,before);
});

const invalidCases=[
 ['changed known trigger SQL',(db: { exec: (arg0: string) => void; })=>{db.exec("CREATE TRIGGER immutable_reference_responses BEFORE UPDATE ON reference_requests BEGIN SELECT RAISE(ABORT,'different error');END");}],
 ['known trigger on another table',(db: { exec: (arg0: string) => void; })=>{db.exec("CREATE TRIGGER immutable_reference_responses BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT,'unexpected');END");}],
 ['case-only trigger name collision',(db: { exec: (arg0: string) => void; })=>{db.exec("CREATE TRIGGER IMMUTABLE_REFERENCE_RESPONSES BEFORE UPDATE ON reference_requests BEGIN SELECT RAISE(ABORT,'reference request responses are immutable');END");}],
 ['table collides with trigger name',(db: { exec: (arg0: string) => void; })=>{db.exec('CREATE TABLE immutable_reference_responses(value TEXT)');}],
 ['view collides with trigger name',(db: { exec: (arg0: string) => void; })=>{db.exec('CREATE VIEW immutable_reference_responses AS SELECT 1 AS value');}],
 ['index collides with trigger name',(db: { exec: (arg0: string) => void; })=>{db.exec('CREATE INDEX immutable_reference_responses ON projects(id)');}],
 ['changed receipt table',(db: { exec: (arg0: string) => void; })=>{db.exec('ALTER TABLE reference_requests ADD COLUMN extra TEXT');}],
 ['missing receipt table',(db: { exec: (arg0: string) => void; })=>{db.exec('DROP TABLE reference_requests');}],
 ['view replaces receipt table',(db: { exec: (arg0: string) => void; })=>{db.exec('DROP TABLE reference_requests;CREATE VIEW reference_requests AS SELECT id AS requestId,data AS requestHash,data AS response FROM projects');}],
 ['temporary receipt table shadow',(db: { exec: (arg0: string) => void; })=>{db.exec('CREATE TEMP TABLE reference_requests(requestId TEXT,requestHash TEXT,response TEXT)');}],
 ['temporary known-name trigger collision',(db: { exec: (arg0: string) => void; })=>{db.exec("CREATE TEMP TRIGGER immutable_reference_responses BEFORE UPDATE ON main.projects BEGIN SELECT RAISE(ABORT,'unexpected');END");}],
] as const;
for(const version of [24,26] as const)for(const [name,change]of invalidCases)test(`ordinary${version} refuses ${name} before any receipt or migration DDL`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRaw(db);drop(db);change(db);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore=(snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];let legacyCalls=0;
 assert.throws(()=>dispatch(()=>legacyCalls++).initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.equal(legacyCalls,0);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.deepEqual((snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore);
 assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'),'no mutation before rejecting imported receipt schema');
 assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()!.version,version);
});

test('ordinary26 edit-task schema gate rejects before receipt reconstruction',(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]));drop(db);db.exec('DROP TRIGGER retain_edit_tasks');const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];
 assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'));
});

test('complete24 marker trigger cannot execute via historical bootstrap or repair',(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),24);drop(db);db.exec("CREATE TABLE receipt_audit(value TEXT);CREATE TRIGGER custom_marker BEFORE INSERT ON schema_version BEGIN INSERT INTO receipt_audit VALUES('ran');END");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let legacyCalls=0;
 assert.throws(()=>dispatch(()=>legacyCalls++).initialize(db),unsupported);assert.equal(legacyCalls,0);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM receipt_audit').get()!.count,0);
});

test('receipt-only repair preserves unrelated custom objects and never invokes their triggers',(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]));drop(db);seedRaw(db);
 db.exec("CREATE TABLE unrelated_audit(value TEXT);CREATE TRIGGER unrelated_project_audit BEFORE UPDATE ON projects BEGIN INSERT INTO unrelated_audit VALUES('ran');END");
 db.exec("CREATE TRIGGER custom_reference_receipt BEFORE INSERT ON reference_requests BEGIN INSERT INTO unrelated_audit VALUES('receipt trigger ran');END;CREATE INDEX custom_reference_index ON reference_requests(response)");
 db.exec("CREATE TEMP TRIGGER custom_reference_receipt_temp BEFORE INSERT ON main.reference_requests BEGIN SELECT RAISE(ABORT,'temporary receipt trigger ran');END");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore=(snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);dispatch().initialize(db);assertRecords(db,before);assertFixed(db);
 assert.deepEqual((snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore);
 for(const object of before.objects)assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).objects.find((current)=>current.name===object.name&&current.type===object.type),object);
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM unrelated_audit').get()!.count,0);
});

for(const version of [24,26] as const)for(const boundary of names.concat('COMMIT'))for(const phase of boundary==='COMMIT'?['before']:['before','after'])test(`ordinary${version} migration/receipt repair rolls back every missing guard at ${phase} ${boundary}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRaw(db);drop(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let fired=false;
 const checked=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{
  const matches=boundary==='COMMIT'?event.sql==='COMMIT':event.sql.startsWith(`CREATE TRIGGER main.${boundary} `);
  if(!fired&&matches&&event.phase===phase){fired=true;throw Error('injected receipt repair failure');}
 }) as unknown as import("node:sqlite").DatabaseSync);
 assert.throws(()=>dispatch().initialize(checked),/injected receipt repair failure/);assert.equal(fired,true);
 assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 dispatch().initialize(db);assertFixed(db);assertRecords(db,before,{migrated:version===24});
});

const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-14T00:00:00.000Z'});
for(const version of [25,27] as const)for(const missing of [[],names] as const)test(`restored${version} ${missing.length?'missing guards are refused':'valid reopen stays unchanged'} without ordinary receipt repair`,(t: { after: (arg0: () => void) => void; })=>{
 const db=open(':memory:');t.after(()=>db.close());
 if(version===25)fixture(db,'restored-25-seeded');
 else{
  fixture(db);initializeWorkspaceSchema26(db);
  createWorkspaceRestoreProfileV27(initializeWorkspaceSchemaThrough24).installWorkspaceRestoreSchemaV27(db,metadata());
 }
 drop(db,(missing as unknown as Parameters<typeof drop>[1]));const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];
 const current=dispatch((((value: unknown)=>assert.notEqual(value,db,'restored imported database must not enter the ordinary constructor')) as unknown as Parameters<typeof dispatch>[0]));
 if(missing.length)assert.throws(()=>current.initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),{code:version===25?'RESTORE_SCHEMA_INVALID':'RESTORE_SCHEMA_UNSUPPORTED'});
 else assert.equal(current.initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync))!.schemaVersion,version);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.ok(effects.every(event=>!/^BEGIN|^CREATE|^INSERT|^UPDATE|^DELETE|^DROP/.test(event.sql)),'restored startup remains read-only');
 assert.equal(protections(db).length,missing.length?0:4);
});

const mutationGuards=['reject_mutation_request_replacement','immutable_mutation_requests','retain_mutation_requests'];
function seedMutationReceipt(db: DatabaseSync){
 const projectId=db.prepare('SELECT id FROM projects LIMIT 1').get()!.id;
 const mutationInsert=db.prepare('INSERT INTO mutation_requests(rowid,requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?,?)');
 mutationInsert.setReadBigInts(true);
 mutationInsert.run(9007199254741111n,'retained-mutation-repair','shot.create',projectId,' \n{"raw":"\\u754c","n":2.00}\n ',' \n{"retained":true,"n":2.00}\n ');
}
for(const version of [24,26] as const)for(const missing of [mutationGuards,...mutationGuards.map(name=>[name])] as const)test(`ordinary${version} restores missing historical mutation receipt guards: ${missing.join(',')}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRaw(db);seedMutationReceipt(db);drop(db,missing);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 let legacyCalls=0;dispatch(()=>legacyCalls++).initialize(db);assert.equal(legacyCalls,0);
 for(const name of mutationGuards){
  assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).objects.find((object)=>object.name===name),Object.values((golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).definitions).find(object=>object.name===name));
 }
 assertRecords(db,before,{migrated:version===24});
 for(const recursive of [0,1] as const){
  db.exec(`PRAGMA recursive_triggers=${recursive}`);
  assert.throws(()=>db.exec("UPDATE mutation_requests SET response='{}' WHERE requestId='retained-mutation-repair'"),/responses are immutable/);
  assert.throws(()=>db.exec("DELETE FROM mutation_requests WHERE requestId='retained-mutation-repair'"),/must be retained/);
  assert.throws(()=>db.exec("INSERT OR REPLACE INTO mutation_requests SELECT * FROM mutation_requests WHERE requestId='retained-mutation-repair'"),/responses are immutable/);
  assert.throws(()=>db.exec("INSERT OR IGNORE INTO mutation_requests SELECT * FROM mutation_requests WHERE requestId='retained-mutation-repair'"),/responses are immutable/);
 }
 assertRecords(db,before,{migrated:version===24});
 const repaired=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);dispatch().initialize(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),repaired);
});

// Independent inventory from the immutable constructor, not the new repair's
// implementation. Conditional15–24 migrations and the separately strict task
// protections are intentionally outside this additive-startup repair.
const additiveSource=readFileSync(new URL('../packages/business/src/workspace-fixed-schema.ts',import.meta.url),'utf8').split('bootstrapEditTaskSchema(db);')[0];
const additiveTriggerNames=[...additiveSource.matchAll(/CREATE TRIGGER IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>match[1]);
const additiveTableNames=[...additiveSource.matchAll(/CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>match[1]);
const ordinaryObjects=(golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).profiles['ordinary-24'].schema.map((id)=>(golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).definitions[id]);
const additiveNames=[...additiveTriggerNames,'agent_chat_one_active'];
const additiveObjects=additiveNames.map(name=>ordinaryObjects.find((object)=>object.name===name));
function dropAdditive(db: DatabaseSync,selected=additiveObjects){for(const object of selected)db.exec(`DROP ${object!.type.toUpperCase()} ${object!.name}`);}
function assertAdditive(db: DatabaseSync){
 const objects=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).objects;
 for(const expected of additiveObjects)assert.deepEqual(objects.find((object)=>object.name===expected!.name),expected,expected!.name);
}
function seedRetainedState(db: DatabaseSync){
 seedRaw(db);seedMutationReceipt(db);
 const projectId=randomUUID(),timelineId=randomUUID();
 db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,' \n{"name":"raw preservation"}\n ');
 const timelineInsert=db.prepare('INSERT INTO timelines(rowid,id,projectId,data) VALUES(?,?,?,?)');
 timelineInsert.setReadBigInts(true);
 timelineInsert.run(9007199254742001n,timelineId,projectId,' \n{"id":"'+timelineId+'","clips":[{"gain":0.2500}],"revision":4}\n ');
 const historyInsert=db.prepare('INSERT INTO timeline_history(rowid,id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?,?)');
 historyInsert.setReadBigInts(true);
 historyInsert.run(9007199254742002n,randomUUID(),projectId,1,'timeline.clip.update','raw-time',' {"gain":0.5000} ',' {"gain":0.2500} ');
 db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,?)').run(projectId,1);
 db.exec("DELETE FROM sqlite_sequence WHERE name='edit_tasks'");
 const sequenceInsert=db.prepare("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)");sequenceInsert.setReadBigInts(true);sequenceInsert.run(9007199254742003n,9007199254740991);
}

test('independent historical repair inventory is exactly36 non-task triggers plus active-chat uniqueness',()=>{
 assert.equal(additiveTriggerNames.length,36);assert.equal(additiveTableNames.length,30);assert.equal(additiveObjects.length,37);
 assert.ok(additiveObjects.every(Boolean));assert.equal(additiveObjects.filter(object=>object!.type==='index').length,1);
});
for(const version of [24,26] as const)for(const expected of additiveObjects)test(`ordinary${version} repairs additive protection ${expected!.name} with exact frozen SQL`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);dropAdditive(db,[expected]);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let legacyCalls=0;
 dispatch(()=>legacyCalls++).initialize(db);assert.equal(legacyCalls,0);assertAdditive(db);assertRecords(db,before,{migrated:version===24});
 const repaired=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);dispatch().initialize(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),repaired);
});
for(const version of [24,26] as const)test(`ordinary${version} repairs all additive guards together while preserving raw receipts, gains, history and REAL sequence`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRetainedState(db);dropAdditive(db);
 db.exec("CREATE TABLE additive_audit(value);CREATE TRIGGER custom_mutation_receipt BEFORE UPDATE ON mutation_requests BEGIN INSERT INTO additive_audit VALUES('ran');END;CREATE INDEX custom_mutation_receipt_index ON mutation_requests(response)");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);dispatch().initialize(db);assertAdditive(db);assertRecords(db,before,{migrated:version===24});
 for(const object of before.objects)if(version!==24||object.name!=='edit_tasks')assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).objects.find((current)=>current.type===object.type&&current.name===object.name),object);
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM additive_audit').get()!.count,0);
 const repaired=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);dispatch().initialize(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),repaired);
});
for(const version of [24,26] as const)for(const expected of additiveObjects)test(`ordinary${version} refuses conflicting additive protection ${expected!.name} without mutation`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);dropAdditive(db,[expected]);
 if(expected!.type==='trigger')db.exec(`CREATE TRIGGER ${expected!.name} BEFORE UPDATE ON projects BEGIN SELECT 1;END`);
 else db.exec(`CREATE INDEX ${expected!.name} ON agent_chat_runs(projectId)`);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];
 assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.equal(db.isTransaction,false);assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'));
});
for(const version of [24,26] as const)for(const table of ['mutation_requests','agent_chat_runs','agent_chat_quota','asset_range_requests','asset_disposition_requests','timeline_history','versions','agent_edit_proposals'] as const)test(`ordinary${version} refuses missing additive dependency ${table}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);db.exec(`PRAGMA foreign_keys=OFF;DROP TABLE ${table};PRAGMA foreign_keys=ON`);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'));
});
for(const version of [24,26] as const)for(const table of ['mutation_requests','agent_chat_runs','asset_range_requests','agent_chat_quota'] as const)test(`ordinary${version} refuses changed additive dependency ${table}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);db.exec(`ALTER TABLE ${table} ADD COLUMN unrecognized TEXT`);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>dispatch().initialize(db),unsupported);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});
for(const version of [24,26] as const)test(`ordinary${version} refuses missing quota rather than recreating state`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);db.exec('DELETE FROM agent_chat_quota');const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];
 assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'));
});
for(const version of [24,26] as const)test(`ordinary${version} refuses duplicate active-chat state before attempting additive repair`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);dropAdditive(db);const projectId=randomUUID(),threadId=randomUUID();
 db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,'{}');
 db.prepare('INSERT INTO agent_chat_threads(id,projectId,revision,nextPosition) VALUES(?,?,0,3)').run(threadId,projectId);
 for(let index=1;index<=2;index++){
  const requestId=randomUUID(),runId=randomUUID();
  db.prepare('INSERT INTO agent_chat_requests(requestId,projectId,threadId,runId,fingerprint,acceptance,bytes) VALUES(?,?,?,?,?,?,0)').run(requestId,projectId,threadId,runId,'hash','{}');
  db.prepare('INSERT INTO agent_chat_runs(id,projectId,threadId,requestId,position,status,data,bytes) VALUES(?,?,?,?,?,?,?,0)').run(runId,projectId,threadId,requestId,index,'running','{}');
 }
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[];assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>effects.push(event)) as unknown as import("node:sqlite").DatabaseSync)),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.ok(effects.every(event=>event.sql==='BEGIN IMMEDIATE'));
});
for(const version of [24,26] as const)for(const expected of additiveObjects)for(const phase of ['before','after'] as const)test(`ordinary${version} rolls back all additive guards ${phase} ${expected!.name}`,(t: unknown)=>{
 const db=fresh((t as unknown as Parameters<typeof fresh>[0]),version);seedRetainedState(db);dropAdditive(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let fired=false;
 assert.throws(()=>dispatch().initialize(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{
  if(!fired&&event.phase===phase&&event.sql.startsWith(expected!.sql!.replace(/^(CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) )/,'$1main.'))){fired=true;throw Error('injected additive guard failure');}
 }) as unknown as import("node:sqlite").DatabaseSync)),/injected additive guard failure/);
 assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 dispatch().initialize(db);assertAdditive(db);assertRecords(db,before,{migrated:version===24});
});
