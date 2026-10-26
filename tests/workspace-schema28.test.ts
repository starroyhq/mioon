import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26,validateWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28,validateWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {createWorkspaceRestoreProfileV27} from '../packages/business/src/workspace-restore-schema-v27.ts';
import {createWorkspaceRestoreProfileV29} from '../packages/business/src/workspace-restore-schema-v29.ts';
import {classifyWorkspaceSchema as classifyHistorical,installWorkspaceRestoreSchema as installHistorical,validateWorkspaceRestoreSchema as validateHistorical} from '../packages/business/src/workspace-restore-schema.ts';
import {readCurrentWorkspaceRole,createWorkspaceSchemaDispatch} from '../packages/business/src/workspace-schema-dispatch.ts';
import {readWorkspaceBackupSchemaVersion} from '../packages/business/src/workspace-backup-schema-versions.ts';
import {workspaceBackupSourceSchemaVersion,workspaceRestorationPairSchema} from '../packages/contracts/src/workspace-schema-profiles.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutHash,lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {open,fixture,snapshot,facade} from './workspace-schema26-fixtures.mjs';
import type { DatabaseSync } from 'node:sqlite';

const through24=Array.from({length:24},(_,index)=>index+1);
const old27=createWorkspaceRestoreProfileV27(initializeWorkspaceSchemaThrough24);
const current29=createWorkspaceRestoreProfileV29(initializeWorkspaceSchemaThrough24);
const unsupported={code:'RESTORE_SCHEMA_UNSUPPORTED'};
const source=Buffer.from('# retained lexical bytes\r\nTITLE "Original"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1');
const info=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-14T00:00:00.000Z'});
function database(t: test.TestContext,{version=26,profile=null}={}){
 const db=open(':memory:');t.after(()=>db.close());
 if(profile)fixture(db,profile);else initializeWorkspaceSchemaThrough24(db);
 if(version>=26)initializeWorkspaceSchema26(db);
 if(version===28)initializeWorkspaceSchema28(db);
 return db;
}
function preserved(db: DatabaseSync,before: import('./helpers/strict-workspace-boundary-types.ts').SchemaSnapshot,addedMarkers=[28]){
 const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const object of before.objects)assert.deepEqual(after.objects.find((value)=>value.name===object.name),object,object.name+' catalog unchanged');
 for(const [name,value]of Object.entries(before.tables)){
  const actual=name==='schema_version'?{...after.tables[name],rows:after.tables[name].rows.filter((row)=>!addedMarkers.includes(Number(row[0])))}:after.tables[name];
  assert.deepEqual(actual,value,name+' raw values and rowids unchanged');
 }
 assert.equal(db.prepare('PRAGMA quick_check(1)').get()!.quick_check,'ok');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
}
function seed(db: DatabaseSync){
 const id=randomUUID(),projectId=randomUUID(),requestId=randomUUID(),name='Original.cube',sha256=lutHash(source),metadata=parseCube3D(source.toString()).metadata;
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'LUT owner'}));
 const resource={id,projectId,name,sha256,sizeBytes:source.length,profile:'mioon-cube3d-normalized-tetrahedral-v1',metadata:JSON.stringify(metadata),content:source,createdAt:'2026-10-14T00:00:00.000Z'};
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(resource));
  db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(requestId,projectId,lutInputHash({projectId,requestId,name},sha256,source.length),id);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {resource,requestId};
}
function mutateWithExactGuards(db: DatabaseSync,table: string,sql: string,values=[]){
 const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
 for(const guard of guards)db.exec('DROP TRIGGER "'+guard.name+'"');
 db.prepare(sql).run(...values);
 for(const guard of guards)db.exec((guard.sql as string));
}
function dispatch(){return createWorkspaceSchemaDispatch({initializeThrough24:initializeWorkspaceSchemaThrough24,detectRestoreEvidence:()=>false,classify:classifyHistorical,install:installHistorical,validate:validateHistorical});}

for(const profile of ['ordinary-24','ordinary-24-seeded','ordinary-24-mock','ordinary-24-mock-seeded'] as const)test(`26 to28 is additive and preserves independent ${profile} records and catalog`,t=>{
 const db=database(t,(({profile}) as unknown as Parameters<typeof database>[1])),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema28(db);preserved(db,before);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...through24,26,28]);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-28');assert.equal(readWorkspaceBackupSchemaVersion(db),28);
 const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema28(db);validateWorkspaceSchema28(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),after);
 assert.throws(()=>initializeWorkspaceSchema26(db),unsupported);assert.throws(()=>validateWorkspaceSchema26(db),unsupported);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),after,'old26 entry refuses rather than downgrades');
});

test('26 to28 preserves unrelated custom SQL and bytes, while fixed restore refuses its unknown catalog',t=>{
 const db=database(t);db.exec("CREATE TABLE personal_notes(id INTEGER PRIMARY KEY,value); INSERT INTO personal_notes VALUES(7,x'00ff'); CREATE INDEX personal_note_value ON personal_notes(value); CREATE TRIGGER personal_note_watch AFTER UPDATE ON personal_notes BEGIN SELECT 1;END");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema28(db);preserved(db,before);assert.equal(readWorkspaceBackupSchemaVersion(db),28);
 assert.throws(()=>current29.classifyWorkspaceSchemaV28V29(db),unsupported);
});

for(const point of ['after tables','after marker','before commit'] as const)test(`26 to28 rolls back every logical effect on injected failure ${point}`,t=>{
 const db=database(t),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let hit=false;
 const target=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{
  const match=point==='after tables'?event.phase==='after'&&event.sql.includes('CREATE TABLE project_lut_resources'):
   point==='after marker'?event.phase==='after'&&event.sql==='INSERT INTO main.schema_version(version) VALUES(28)':event.phase==='before'&&event.sql==='COMMIT';
  if(match){hit=true;throw Object.assign(Error('injected schema28 interruption'),{code:'INJECTED_SCHEMA28'});}
 }) as unknown as import("node:sqlite").DatabaseSync);
 assert.throws(()=>initializeWorkspaceSchema28((target as unknown as Parameters<typeof initializeWorkspaceSchema28>[0])),{code:'INJECTED_SCHEMA28'});assert.equal(hit,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 initializeWorkspaceSchema28(db);preserved(db,before);
});

for(const sql of [
 'CREATE TABLE project_lut_resources(value)',
 'CREATE TABLE immutable_lut_import_requests(value)',
 'CREATE TEMP TABLE project_lut_resources(value)',
 "CREATE TRIGGER imported_marker BEFORE INSERT ON schema_version BEGIN UPDATE projects SET data='changed';END",
] as const)test(`schema28 rejects collisions and imported execution before writes: ${sql}`,t=>{
 const db=database(t);db.exec(sql);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore=(snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.throws(()=>initializeWorkspaceSchema28(db),unsupported);assert.equal(db.isTransaction,false);
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.deepEqual((snapshot(db,'temp') as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),tempBefore);
});

test('dispatcher never commits old receipt repair before rejecting an ordinary26 LUT-name collision',t=>{
 const db=database(t);db.exec('DROP TRIGGER retain_mutation_requests; CREATE TABLE immutable_lut_import_requests(value)');
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>dispatch().initialize(db),unsupported);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const sql of ['DELETE FROM schema_version WHERE version=28','DELETE FROM schema_version WHERE version=26','DELETE FROM schema_version','DROP TABLE schema_version'] as const)test(`LUT evidence cannot enter historical missing-marker repair: ${sql}`,t=>{
 const db=database(t,{version:28});db.exec(sql);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.throws(()=>readCurrentWorkspaceRole(db),unsupported);assert.throws(()=>dispatch().initialize(db),unsupported);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

test('ordinary reopen uses metadata and receipts only, while explicit and backup gates remain byte-strict',t=>{
 const db=database(t,{version:28});seed(db);let contentReads=0;
 const checked={get isTransaction(){return db.isTransaction;},exec:(sql: string)=>db.exec(sql),prepare(sql: string){if(/\bcontent\b/i.test(sql)){contentReads++;throw Error('ordinary startup must not read retained content');}return db.prepare(sql);}};
 initializeWorkspaceSchema28((checked as unknown as Parameters<typeof initializeWorkspaceSchema28>[0]));assert.equal(contentReads,0);
 const changed=Buffer.from(source);changed[changed.indexOf('Original')]='X'.charCodeAt(0);
 mutateWithExactGuards(db,'project_lut_resources','UPDATE project_lut_resources SET content=?',(([changed]) as unknown as Parameters<typeof mutateWithExactGuards>[3]));
 assert.doesNotThrow(()=>initializeWorkspaceSchema28(db));
 assert.throws(()=>validateWorkspaceSchema28(db),{code:'LUT_RESOURCE_INVALID'});
 assert.throws(()=>readWorkspaceBackupSchemaVersion(db),{code:'WORKSPACE_BACKUP_DATABASE_INVALID'});
 assert.throws(()=>current29.installWorkspaceRestoreSchemaV29(db,info()),{code:'LUT_RESOURCE_INVALID'});
 assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()!.version,28);
});

for(const kind of ['receipt mismatch','invalid semantic metadata'] as const)test(`metadata-only startup still fails closed on ${kind}`,t=>{
 const db=database(t,{version:28});seed(db);
 if(kind==='receipt mismatch')mutateWithExactGuards(db,'lut_import_requests','UPDATE lut_import_requests SET inputHash=?',((['f'.repeat(64)]) as unknown as Parameters<typeof mutateWithExactGuards>[3]));
 else mutateWithExactGuards(db,'project_lut_resources',"UPDATE project_lut_resources SET metadata='{}'");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>initializeWorkspaceSchema28(db),{code:'LUT_RESOURCE_INVALID'});assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

test('new pair contracts accept only the exact registered source/restoration pairs',()=>{
 for(const version of [1,24,26,28,30,32,34,36,38,40,44,48] as const)assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success,true);
 for(const version of [0,25,27,29,31,33,35,37,39,41,45,49,28.5] as const)assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success,false);
 const pairs=[['restored-local-v1',24,25],['restored-local-v2',26,27],['restored-local-v3',28,29],['restored-local-v4',30,31],['restored-local-v5',32,33],['restored-local-v6',34,35],['restored-local-v7',36,37],['restored-local-v8',38,39],['restored-local-v9',40,41],['restored-local-v11',44,45],['restored-local-v13',48,49]];
 for(const [profile,sourceSchema,databaseSchemaVersion]of pairs)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion}).success,true);
 for(const profile of ['restored-local-v10','restored-local-v12','restored-local-v14'] as const)for(const sourceSchema of [24,26,28,30,32,34,36,38,40,44,48] as const)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion:sourceSchema+1}).success,false);
 for(const [index,[,sourceSchema,databaseSchemaVersion]]of pairs.entries())for(const shift of [-1,1] as const)assert.equal(workspaceRestorationPairSchema.safeParse({profile:pairs[index][0],sourceSchema:(sourceSchema as number)+shift,databaseSchemaVersion}).success,false);
});

test('restore29 holds exact LUT bytes, raw metadata, receipt and rowids; new imports stay unavailable',t=>{
 const db=database(t,{version:28}),{resource,requestId}=seed(db),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 const installed=current29.installWorkspaceRestoreSchemaV29(db,info());
 assert.equal(installed.schemaVersion,29);assert.equal(installed.sourceSchema,28);assert.equal(installed.profile,'restored-local-v3');
 assert.equal(installed.heldCounts.project_lut_resources,1);assert.equal(installed.heldCounts.lut_import_requests,1);
 for(const name of ['project_lut_resources','lut_import_requests'] as const)assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).tables[name],before.tables[name]);
 assert.deepEqual(current29.validateWorkspaceRestoreSchemaV29(db),installed);assert.equal(readCurrentWorkspaceRole(db),'restored-29-evidence');
 assert.equal(dispatch().initialize(db)!.workspaceOrigin,installed.workspaceOrigin);
 assert.throws(()=>db.prepare('DELETE FROM project_lut_resources WHERE id=?').run(resource.id),/HELD|IMMUTABLE/);
 assert.throws(()=>db.prepare('DELETE FROM lut_import_requests WHERE requestId=?').run(requestId),/HELD|IMMUTABLE/);
 db.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO project_lut_resources SELECT * FROM project_lut_resources').run(),/HELD|UNAVAILABLE|IMMUTABLE/);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO lut_import_requests SELECT * FROM lut_import_requests').run(),/HELD|UNAVAILABLE|IMMUTABLE/);
 assert.throws(()=>db.prepare('INSERT INTO project_lut_resources SELECT ?,projectId,name,sha256,sizeBytes,profile,metadata,content,createdAt FROM project_lut_resources').run(randomUUID()),/UNAVAILABLE/);
 assert.throws(()=>initializeWorkspaceSchema28(db),unsupported);
 assert.throws(()=>old27.classifyWorkspaceSchemaV26V27(db),unsupported);assert.throws(()=>classifyHistorical(db),unsupported);
});

test('frozen source24/restore25 and source26/restore27 classifiers refuse28 without writes',t=>{
 const db=database(t,{version:28});seed(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const attempt of [()=>classifyHistorical(db),()=>old27.classifyWorkspaceSchemaV26V27(db),()=>old27.installWorkspaceRestoreSchemaV27(db,info())] as const){
  assert.throws(attempt,unsupported);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 }
});

test('restore29 revalidation does not trust exact schema alone after captured bytes change',t=>{
 const db=database(t,{version:28});seed(db);current29.installWorkspaceRestoreSchemaV29(db,info());
 const changed=Buffer.from(source);changed[changed.indexOf('Original')]='X'.charCodeAt(0);
 mutateWithExactGuards(db,'project_lut_resources','UPDATE project_lut_resources SET content=?',(([changed]) as unknown as Parameters<typeof mutateWithExactGuards>[3]));
 assert.throws(()=>current29.validateWorkspaceRestoreSchemaV29(db),{code:'LUT_RESOURCE_INVALID'});
});

for(const profile of ['ordinary-24-seeded','ordinary-24-mock-seeded'] as const)test(`restore29 preserves all independent inherited raw rows as well as LUTs: ${profile}`,t=>{
 const db=database(t,(({version:28,profile}) as unknown as Parameters<typeof database>[1]));seed(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 current29.installWorkspaceRestoreSchemaV29(db,info());const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const [name,value]of Object.entries(before.tables)){
  let actual=after.tables[name];
  if(name==='schema_version')actual={...actual,rows:actual.rows.filter((row)=>row[0]!=='29')};
  if(name==='edit_tasks')actual={fields:actual.fields.slice(0,-1),rows:actual.rows.map((row)=>row.slice(0,-2))};
  assert.deepEqual(actual,value,name+' original typed raw values and rowids retained');
 }
});

for(const point of ['after metadata','before commit'] as const)test(`restore29 rolls back source and LUT evidence on interruption ${point}`,t=>{
 const db=database(t,{version:28});seed(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let hit=false;
 const checked=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(event)=>{
  const match=point==='after metadata'?event.phase==='after'&&event.sql.includes('CREATE TABLE workspace_restoration'):event.phase==='before'&&event.sql==='COMMIT';
  if(match){hit=true;throw Object.assign(Error('injected restored29 interruption'),{code:'INJECTED_RESTORE29'});}
 }) as unknown as import("node:sqlite").DatabaseSync);
 assert.throws(()=>current29.installWorkspaceRestoreSchemaV29((checked as unknown as Parameters<typeof current29.installWorkspaceRestoreSchemaV29>[0]),info()),{code:'INJECTED_RESTORE29'});
 assert.equal(hit,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(current29.installWorkspaceRestoreSchemaV29(db,info()).schemaVersion,29);
});

for(const version of [24,26] as const)test(`new29 profile cannot reinterpret historical source${version}`,t=>{
 const db=database(t,{version}),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>current29.installWorkspaceRestoreSchemaV29(db,info()),unsupported);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const version of [24,26] as const)test(`current dispatcher preserves historical restored${version+1} without adding LUT schema`,t=>{
 const db=database(t,{version}),installed=version===24?installHistorical(db,info()):old27.installWorkspaceRestoreSchemaV27(db,info()),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.equal(dispatch().initialize(db)!.workspaceOrigin,installed.workspaceOrigin);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('project_lut_resources','lut_import_requests')").get()!.n,0);
});
