import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {open,fixture as ordinaryFixture,snapshot} from './workspace-schema26-fixtures.mjs';
import {readCurrentWorkspaceRole,createWorkspaceSchemaDispatch} from '../packages/business/src/workspace-schema-dispatch.ts';
const unsupported=error=>error.code==='RESTORE_SCHEMA_UNSUPPORTED';
function fixture(t,versions,{metadata=false,marker=true,ddl='CREATE TABLE schema_version(version INTEGER PRIMARY KEY)'}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 if(marker){db.exec(ddl);for(const version of versions)db.prepare('INSERT INTO schema_version VALUES(?)').run(version);}
 if(metadata)db.exec('CREATE TABLE workspace_restoration(id INTEGER PRIMARY KEY)');
 return db;
}
const old=Array.from({length:24},(_,i)=>i+1);
for(const versions of [[],[1],[1,3,19],old])test(`known historical marker repair eligibility remains ${JSON.stringify(versions)}`,t=>{
 assert.equal(readCurrentWorkspaceRole(fixture(t,versions)),'ordinary-through-24');
});
test('missing marker table still preserves ordinary bootstrap eligibility',t=>{
 assert.equal(readCurrentWorkspaceRole(fixture(t,[],{marker:false})),'ordinary-through-24');
});
for(const [versions,role]of [[old.concat(25),'restored-25-evidence'],[old.concat(26),'ordinary-26'],[old.concat(26,27),'restored-27-evidence']])test(`explicit marker role ${role} never follows maximum-number inference`,t=>{
 assert.equal(readCurrentWorkspaceRole(fixture(t,versions)),role);
});
for(const versions of [[26],[27],old.concat(27),old.concat(25,26),old.concat(25,27),old.concat(26,27,28),old.concat(28),old.concat(0),old.concat(-1),old.concat(9007199254740993n)])test(`unsupported marker combination is refused ${versions.map(String).join(',')}`,t=>{
 assert.throws(()=>readCurrentWorkspaceRole(fixture(t,versions)),unsupported);
});
test('partial restoration evidence never gives an ordinary26 fallback',t=>{
 assert.throws(()=>readCurrentWorkspaceRole(fixture(t,old.concat(26),{metadata:true})),unsupported);
 assert.equal(readCurrentWorkspaceRole(fixture(t,[],{metadata:true,marker:false})),'restored-25-evidence');
 const epoch=fixture(t,old.concat(26));epoch.exec('CREATE TABLE edit_tasks(executionEpoch TEXT)');
 assert.throws(()=>readCurrentWorkspaceRole(epoch),unsupported);
});
test('marker declaration is validated before query and TEMP rows cannot spoof main',t=>{
 assert.throws(()=>readCurrentWorkspaceRole(fixture(t,old.concat(26),{ddl:'CREATE TABLE schema_version(version TEXT PRIMARY KEY)'})),unsupported);
 const db=fixture(t,old.concat(28));db.exec('CREATE TEMP TABLE schema_version(version INTEGER PRIMARY KEY)');
 for(const value of old.concat(26))db.prepare('INSERT INTO temp.schema_version VALUES(?)').run(value);
 assert.throws(()=>readCurrentWorkspaceRole(db),unsupported);
});
test('bounded role query preserves harmless marker whitespace and comments',t=>{
 const db=fixture(t,old.concat(26),{ddl:'CREATE TABLE IF NOT EXISTS schema_version ( version INTEGER /* known marker */ PRIMARY KEY )'});
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-26');
});
test('restored25 dispatch only validates the original fixed profile and never bootstraps or upgrades it',t=>{
 // Current dispatch now validates held-row binding after the fixed validator.
 // Use a genuine historical fixture, not marker-only fake validation success.
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);
 const expected=Object.freeze(installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-16T00:00:00.000Z'})),calls=[];
 const dispatch=createWorkspaceSchemaDispatch({initializeThrough24(){calls.push('bootstrap');throw Error('forbidden');},detectRestoreEvidence(){calls.push('detect25');return true;},classify(){calls.push('classify25');return {schemaVersion:25,profile:'restored-local-v1'};},install(){calls.push('install');throw Error('forbidden');},validate(value){assert.equal(value,db);calls.push('validate25');assert.deepEqual(validateWorkspaceRestoreSchema(value),expected);return expected;}});
 assert.equal(dispatch.initialize(db),expected);assert.deepEqual(calls,['validate25']);
 assert.equal(dispatch.detect(db),true);assert.deepEqual(calls,['validate25','detect25']);
 assert.deepEqual(dispatch.classify(db),{schemaVersion:25,profile:'restored-local-v1'});
});
test('failed restored25 validation cannot fall back to ordinary initializer',t=>{
 const db=fixture(t,old.concat(25));let initialized=0;
 const dispatch=createWorkspaceSchemaDispatch({initializeThrough24(){initialized++;},detectRestoreEvidence(){return true;},classify(){throw Error('unused');},install(){throw Error('unused');},validate(){throw Object.assign(Error('fixed old metadata rejected'),{code:'RESTORE_METADATA_INVALID'});}});
 assert.throws(()=>dispatch.initialize(db),{code:'RESTORE_METADATA_INVALID'});assert.equal(initialized,0);
});

function ordinaryDispatch(onLegacy=()=>{}) {
 const unused=()=>{throw Error('unexpected restored profile path');};
 return createWorkspaceSchemaDispatch({initializeThrough24(db){onLegacy();initializeWorkspaceSchemaThrough24(db);},detectRestoreEvidence:()=>false,classify:unused,install:unused,validate:unused});
}
function ordinaryDatabase(t,profile='ordinary-24'){
 const db=open(':memory:');t.after(()=>db.close());if(profile)ordinaryFixture(db,profile);return db;
}
function preservedCurrent(db,before) {
 const after=snapshot(db),expected=structuredClone(before),lutTables=new Set(['project_lut_resources','lut_import_requests']);
 const additions=after.objects.filter(object=>lutTables.has(object.tbl_name));
 assert.equal(additions.length,15);
 assert.equal(createHash('sha256').update(JSON.stringify(additions)).digest('hex'),'a60ce5a71e48f9afaa52635f9737a035e3256986dcef31bda83c60739ac93d00');
 after.objects=after.objects.filter(object=>!lutTables.has(object.tbl_name));
 for(const table of lutTables){assert.deepEqual(after.tables[table].rows,[]);delete after.tables[table];}
 const annotations=after.objects.filter(object=>/annotation/.test(object.name));
 assert.equal(annotations.length,20);
 assert.equal(createHash('sha256').update(JSON.stringify(annotations)).digest('hex'),'36eab4635ff3ef13ae1fd9fd11e0467ac6890cb5bb9175342ff02748d5bf5ede');
 after.objects=after.objects.filter(object=>!/annotation/.test(object.name));
 for(const table of ['asset_annotations','asset_annotation_requests']){assert.deepEqual(after.tables[table].rows,[]);delete after.tables[table];}
 const tasks=expected.objects.find(object=>object.name==='edit_tasks');
 tasks.sql=tasks.sql.replace("'timeline.subtitle.remove'))","'timeline.subtitle.remove','timeline.loudness.apply'))");
 expected.tables.schema_version.rows.push(['26','integer','3236'],['28','integer','3238'],['30','integer','3330'],['32','integer','3332'],['34','integer','3334'],['36','integer','3336'],['38','integer','3338'],['40','integer','3430']);
 assert.deepEqual(after,expected,'exact legacy catalog/raw rows plus the reviewed26 CHECK,28 resources and36 annotations');
 assert.equal(db.prepare('PRAGMA quick_check(1)').get().quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
test('completed24 enters explicit26,28,30,32,34,36,38 and40 migrations without legacy bootstrap writes',t=>{
 const db=ordinaryDatabase(t),before=snapshot(db);let calls=0;
 assert.equal(ordinaryDispatch(()=>calls++).initialize(db),null);
 assert.equal(calls,0);preservedCurrent(db,before);
});
test('completed24 rejects imported marker trigger before its real audit side effect can execute',t=>{
 const db=ordinaryDatabase(t);let calls=0;
 db.exec("CREATE TABLE migration_audit(event TEXT); CREATE TRIGGER custom_marker BEFORE INSERT ON schema_version BEGIN INSERT INTO migration_audit VALUES('trigger ran before rejection');END");
 const before=snapshot(db);
 assert.throws(()=>ordinaryDispatch(()=>calls++).initialize(db),unsupported);
 assert.equal(db.prepare('SELECT count(*) AS count FROM migration_audit').get().count,0);
 assert.equal(calls,0);assert.deepEqual(snapshot(db),before);
});
test('completed24 missing known protection is refused instead of silently repaired before26',t=>{
 const db=ordinaryDatabase(t);let calls=0;db.exec('DROP TRIGGER retain_edit_tasks');const before=snapshot(db);
 assert.throws(()=>ordinaryDispatch(()=>calls++).initialize(db),unsupported);
 assert.equal(calls,0);assert.deepEqual(snapshot(db),before);
});
test('genuinely missing known markers keep the old ordinary repair path before26',t=>{
 const db=ordinaryDatabase(t);db.exec('DELETE FROM schema_version WHERE version IN(12,22)');const before=snapshot(db);let calls=0;
 assert.equal(ordinaryDispatch(()=>calls++).initialize(db),null);assert.equal(calls,1);
 const after=snapshot(db);
 for(const [name,table]of Object.entries(before.tables))if(name!=='schema_version')assert.deepEqual(after.tables[name],table,`${name}: legacy gap repair preserves raw records`);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...old,26,28,30,32,34,36,38,40]);
});
for(const profile of [null,'ordinary-1','ordinary-14','ordinary-21','ordinary-23'])test(`real ${profile??'missing marker table'} retains historical bootstrap/upgrade qualification`,t=>{
 const db=ordinaryDatabase(t,profile);let calls=0;
 assert.equal(ordinaryDispatch(()=>calls++).initialize(db),null);assert.equal(calls,1);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...old,26,28,30,32,34,36,38,40]);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-40');
});

for(const [name,sql]of [
 ['marker26 removed','DELETE FROM schema_version WHERE version=26'],
 ['known marker removed','DELETE FROM schema_version WHERE version=1'],
 ['marker26 and known marker removed','DELETE FROM schema_version WHERE version IN(1,26)'],
 ['all marker rows removed','DELETE FROM schema_version'],
 ['marker table removed','DROP TABLE schema_version'],
])test(`actual current schema ${name} is refused unchanged before historical repair`,t=>{
 const db=ordinaryDatabase(t);let legacyCalls=0;const dispatch=ordinaryDispatch(()=>legacyCalls++);
 dispatch.initialize(db);assert.equal(legacyCalls,0);db.exec(sql);const before=snapshot(db);
 assert.throws(()=>readCurrentWorkspaceRole(db),unsupported);
 assert.throws(()=>dispatch.initialize(db),unsupported);
 assert.equal(legacyCalls,0);assert.deepEqual(snapshot(db),before);
});
test('new operation evidence in a commented/quoted operation CHECK is fail-closed and never authorizes a profile',t=>{
 const db=fixture(t,old);
 db.exec(`CREATE TABLE edit_tasks(operation TEXT CHECK /* boundary */( "operation" /* retained */ IN ('timeline.undo',/* new */'timeline.loudness.apply'))) `);
 assert.throws(()=>readCurrentWorkspaceRole(db),unsupported);
 db.exec('INSERT INTO schema_version VALUES(25)');assert.throws(()=>readCurrentWorkspaceRole(db),unsupported);
});
for(const declaration of [
 "CREATE TABLE edit_tasks(operation TEXT CHECK(operation IN ('timeline.undo','timeline.loudness.apply.more')))",
 "CREATE TABLE edit_tasks(operation TEXT CHECK(operation IN ('timeline.undo')) /* CHECK(operation IN ('timeline.loudness.apply')) */)",
 "CREATE TABLE edit_tasks(operation TEXT CHECK(operation IN ('timeline.undo')),note TEXT DEFAULT 'timeline.loudness.apply')",
])test(`old operation CHECK evidence stays eligible: ${declaration}`,t=>{
 const db=fixture(t,[1,3,19]);db.exec(declaration);assert.equal(readCurrentWorkspaceRole(db),'ordinary-through-24');
});

test('non-TEXT retained golden cells refuse current envelope migration before writes',t=>{
 const db=ordinaryDatabase(t,'ordinary-24-seeded'),before=snapshot(db);let calls=0;
 assert.throws(()=>ordinaryDispatch(()=>calls++).initialize(db),unsupported);
 assert.equal(calls,0);assert.deepEqual(snapshot(db),before);
});
