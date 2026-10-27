import {CURRENT_ORDINARY_SCHEMA,CURRENT_RESTORED_SCHEMA,CURRENT_RESTORE_PROFILE} from './helpers/workspace-schema-current.ts';
import type {WorkspaceServices as FixtureServices} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';import {initializeWorkspaceSchema36,validateWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';import {createServices} from '../packages/business/src/services.ts';
import {readCurrentWorkspaceRole} from '../packages/business/src/workspace-schema-dispatch.ts';import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';import {open,snapshot,createHistoricalDatabase} from './workspace-schema26-fixtures.mjs';
import type { DatabaseSync } from 'node:sqlite';
const initializers=[initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34];
function old(db: DatabaseSync,version=34){initializeWorkspaceSchemaThrough24(db);for(const [i,init] of initializers.entries())if(version>=26+i*2)init(db);}
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});
function base(t: test.TestContext){const dir=mkdtempSync(path.join(tmpdir(),'annotation-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('34 to36 preserves every prior schema object/raw row and is idempotent; fresh parity',t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema36(db);const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const object of before.objects)assert.deepEqual(after.objects.find((x)=>x.name===object.name),object);
 for(const [name,value] of Object.entries(before.tables))if(name!=='schema_version')assert.deepEqual(after.tables[name],value,name);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-36');assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:36,profile:'ordinary'});initializeWorkspaceSchema36(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),after);
 const fresh=createHistoricalDatabase(path.join(base(t),'fresh'),36);try{assert.deepEqual((snapshot(fresh) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).objects,after.objects);}finally{fresh.close();}
});

for(const hostile of ['reserved','temp','marker','unknown dependency'] as const)test(`migration refuses ${hostile} before any DDL`,t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);
 db.exec({reserved:'CREATE TABLE asset_annotations(untrusted TEXT)',temp:'CREATE TEMP TABLE asset_annotations(untrusted TEXT)',marker:"CREATE TRIGGER marker_side_effect BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT,'untrusted');END;",'unknown dependency':'CREATE VIEW misleading AS SELECT * FROM asset_annotations'}[hostile]);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>initializeWorkspaceSchema36(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.equal(db.isTransaction,false);
});

test('orphan annotation evidence and extra schema markers fail closed',t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);initializeWorkspaceSchema36(db);db.exec('DELETE FROM schema_version WHERE version=36');assert.throws(()=>readCurrentWorkspaceRole(db));
 db.exec('INSERT INTO schema_version VALUES(36),(37),(999)');assert.throws(()=>readCurrentWorkspaceRole(db));
});

test('current backup restore retains exact annotation rows and receipts and denies new writes',async t=>{
 const dir=base(t),source=path.join(dir,'source'),backup=path.join(dir,'backup'),destination=path.join(dir,'restored');let store=(openStore(source) as unknown as FixtureStore),services=(createServices(store,new Map()) as unknown as FixtureServices);
 const project=await services.call('project.create',{name:'annotation backup'}),asset=store.put('assets',{id:randomUUID(),projectId:project.id,name:'no file source',mimeType:'image/png'}),input={projectId:project.id,assetId:asset.id,expectedRevision:0,requestId:randomUUID(),tags:['保留'],note:'exact\nbytes'};
 const saved=await services.call('asset.annotation.set',input);const before=(snapshot(store.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);await services.drain();store.close();
 const created=await (createWorkspaceBackup({source,destination:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);assert.equal(created.databaseSchemaVersion,CURRENT_ORDINARY_SCHEMA);assert.deepEqual(await (verifyWorkspaceBackup({directory:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>),created);
 const restored=await (restoreWorkspaceBackup({directory:backup,destination}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>);assert.equal(restored.sourceSchema,CURRENT_ORDINARY_SCHEMA);assert.equal(restored.databaseSchemaVersion,CURRENT_RESTORED_SCHEMA);assert.equal(restored.profile,CURRENT_RESTORE_PROFILE);
 store=(openStore(destination) as unknown as FixtureStore);services=(createServices(store,new Map()) as unknown as FixtureServices);try{
  assert.equal((getWorkspaceRestoreContext(store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null)!.schemaVersion,CURRENT_RESTORED_SCHEMA);
  for(const table of ['asset_annotations','asset_annotation_requests'] as const)assert.deepEqual((snapshot(store.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).tables[table],before.tables[table]);
  assert.deepEqual((await services.call('asset.annotation.list',{projectId:project.id,assetIds:[asset.id]})).items,[saved]);
  for(const candidate of [input,{...input,requestId:randomUUID(),expectedRevision:1,note:'new'}] as const)await assert.rejects(services.call('asset.annotation.set',candidate,{expectedWorkspaceOrigin:restored.workspaceOrigin}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  assert.throws(()=>store.db.prepare('INSERT INTO asset_annotations VALUES(?,?,?,?,?)').run(randomUUID(),project.id,1,'[]','new'),/RESTORE_OPERATION_UNAVAILABLE/);
  assert.throws(()=>store.db.exec("UPDATE asset_annotations SET note='changed',revision=2"),/RESTORED_RECORD_HELD/);
  assert.deepEqual(await services.call('lut.list',{projectId:project.id}),{projectId:project.id,items:[],nextAfter:null});
 }finally{await services.drain();store.close();}
 store=(openStore(destination) as unknown as FixtureStore);assert.equal((getWorkspaceRestoreContext(store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null)!.schemaVersion,CURRENT_RESTORED_SCHEMA);store.close();
});

for(const sourceVersion of [24,26,28,30,32,34] as const)test(`historical restored${sourceVersion+1} remains frozen and confirms empty only for owned assets`,async t=>{
 const root=path.join(base(t),'historical');mkdirSync(root,{mode:0o700});const db=open(path.join(root,'workbench.sqlite'));old(db,sourceVersion);
 const projectId=randomUUID(),assetId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'historical',revision:1}));db.prepare('INSERT INTO assets VALUES(?,?,?)').run(assetId,projectId,JSON.stringify({id:assetId,projectId,name:'asset',mimeType:'image/png'}));installCurrentWorkspaceRestoreSchema(db,metadata());const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);db.close();
 const store=(openStore(root) as unknown as FixtureStore),s=(createServices(store,new Map()) as unknown as FixtureServices);try{
  const result=await s.call('asset.annotation.list',{projectId,assetIds:[assetId]});assert.equal(result.items[0].revision,0);assert.deepEqual(result.items[0].tags,[]);
  await assert.rejects(s.call('asset.annotation.list',{projectId,assetIds:[randomUUID()]}),{code:'NOT_FOUND'});
  await assert.rejects(s.call('asset.annotation.set',{projectId,assetId,expectedRevision:0,requestId:randomUUID(),tags:[],note:''}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  assert.deepEqual((snapshot(store.db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
 }finally{await s.drain();store.close();}
});

for(const variant of ['reverse guard','view dependency','TEMP dependency'] as const)test(`older startup refuses annotation ${variant} without committing intermediate migrations`,t=>{
 const root=path.join(base(t),'older');mkdirSync(root,{mode:0o700});let db=open(path.join(root,'workbench.sqlite'));old(db,32);
 if(variant==='reverse guard')db.exec('CREATE TRIGGER reject_mutation_requests_cross_annotation BEFORE INSERT ON mutation_requests BEGIN SELECT 1;END;');
 else if(variant==='view dependency')db.exec('CREATE VIEW annotation_shadow AS SELECT * FROM asset_annotations');
 else {db.exec('CREATE TEMP VIEW annotation_shadow AS SELECT * FROM asset_annotations');const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>initializeWorkspaceSchema36(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);db.close();return;}
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);db.close();assert.throws(()=>(openStore(root) as unknown as FixtureStore));db=open(path.join(root,'workbench.sqlite'));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);db.close();
});

test('migration interruption after annotation DDL rolls back all tables and marker',t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);let injected=false;
 const wrapper=new Proxy(db,{get(target,key){if(key==='exec')return (sql: string|string[])=>{const result=target.exec((sql as unknown as Parameters<typeof target.exec>[0]));if(sql.includes('INSERT INTO main.schema_version(version) VALUES(36)')){injected=true;throw Error('migration interruption');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 assert.throws(()=>initializeWorkspaceSchema36(wrapper),/migration interruption/);assert.equal(injected,true);assert.equal(db.isTransaction,false);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);initializeWorkspaceSchema36(db);validateWorkspaceSchema36(db);
});
