import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {createWorkspaceRestoreProfileV27} from '../packages/business/src/workspace-restore-schema-v27.ts';
import {classifyWorkspaceSchema as classifyHistorical,detectWorkspaceRestoreEvidence as detectHistorical,installWorkspaceRestoreSchema as installHistorical} from '../packages/business/src/workspace-restore-schema.ts';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup,inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.ts';
import {inspectWorkspaceBackup} from '../packages/business/src/backup-readiness.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {createServices} from '../packages/business/src/services.ts';
import {workspaceRestoreOfflineResultSchema,workspaceRestorePublicationStatusSchema} from '../packages/contracts/src/workspace-restore-offline.ts';
import {workspaceRestoreInspectionSchema} from '../packages/contracts/src/workspace-restore.ts';
import {workspaceBackupManifestSchema,workspaceBackupResultSchema,workspaceBackupInspectionSchema} from '../packages/contracts/src/workspace-backup.ts';
import {workspaceRestorationPairSchema,workspaceBackupSourceSchemaVersion} from '../packages/contracts/src/workspace-schema-profiles.ts';

// The fixture source remains byte-exact. Only its three fixed import edges
// are resolved to the installed contracts dependency and pinned sibling source.
const oldFixtureRoot=new URL('./fixtures/workspace-restore-v27/',import.meta.url);
const oldManifest=JSON.parse(fs.readFileSync(new URL('manifest.json',oldFixtureRoot),'utf8'));
const zodURL=pathToFileURL(createRequire(new URL('../packages/contracts/package.json',import.meta.url)).resolve('zod')).href;
function oldSource(currentName,backupURL){
 // The fixture keeps the pre-migration `.mjs` copies; current callers use the
 // renamed `.ts` names, so resolve back to the frozen legacy file.
 const name=oldManifest.files[currentName]?currentName:currentName.replace(/\.ts$/,'.mjs');
 assert.ok(oldManifest.files[name],`${currentName}: documented legacy fixture mapping`);
 const source=fs.readFileSync(new URL(`legacy-contracts/${name}`,oldFixtureRoot),'utf8');
 assert.equal(createHash('sha256').update(source).digest('hex'),oldManifest.files[name]);
 const expected=name==='workspace-restore-offline.mjs'?['zod','./workspace-backup.mjs']:['zod'];
 const imports=[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match=>match[1]);assert.deepEqual(imports,expected);
 return 'data:text/javascript;base64,'+Buffer.from(source.replace("from 'zod'",`from '${zodURL}'`).replace("from './workspace-backup.mjs'",`from '${backupURL}'`)).toString('base64');
}
const oldBackupURL=oldSource('workspace-backup.ts');
const {workspaceBackupManifestSchema:oldManifestSchema,workspaceBackupResultSchema:oldResultSchema}=await import(oldBackupURL);
const {workspaceRestoreOfflineResultSchema:oldRestoreResultSchema}=await import(oldSource('workspace-restore-offline.mjs',oldBackupURL));
const {workspaceRestoreInspectionSchema:oldRestoreInspectionSchema}=await import(oldSource('workspace-restore.mjs'));

const profile=createWorkspaceRestoreProfileV27(initializeWorkspaceSchemaThrough24);
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-14T00:00:00.000Z'});
const q=name=>'"'+name.replaceAll('"','""')+'"';
const raw=value=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
const hash=value=>createHash('sha256').update(value).digest('hex');
const all=(db,sql)=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all();};
function snapshot(db){
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
 return {objects,tables:Object.fromEntries(objects.filter(row=>row.type==='table').map(({name})=>{
  const fields=db.prepare(`PRAGMA main.table_info(${q(name)})`).all().map(row=>row.name);
  return [name,{fields,rows:all(db,`SELECT rowid AS capturedRowid,${fields.map(q).join(',')} FROM main.${q(name)} ORDER BY rowid`)}];
 }))};
}
function assertPreserved(db,before,sourceVersion=26){
 for(const [table,{fields,rows}] of Object.entries(before.tables)){
  const where=table==='schema_version'?`WHERE version<=24${sourceVersion===26?' OR version=26':''}`:'';
  assert.deepEqual(all(db,`SELECT rowid AS capturedRowid,${fields.map(q).join(',')} FROM main.${q(table)} ${where} ORDER BY rowid`),rows,`${table}: typed raw values, rowids, receipts and sequence`);
 }
}
function fresh(t,{version=26,mock=false,file=':memory:'}={}){
 const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
 initializeWorkspaceSchemaThrough24(db);if(version===26)initializeWorkspaceSchema26(db);
 if(mock){
  createMockProvider({db,root:'/synthetic-unused-root'});
  const mockTaskInsert=db.prepare('INSERT INTO mock_provider_tasks(rowid,provider_job_id,request_id,snapshot_json,snapshot_hash,scenario,created_at_ms,ready_at_ms,poll_count,download_attempts,cancelled) VALUES(?,?,?,?,?,?,?,?,?,?,?)');mockTaskInsert.setReadBigInts(true);mockTaskInsert.run(9007199254740993n,'mock-id','mock-request',Buffer.from([0,255,13,10]),'a'.repeat(64),'unknown',9007199254740993n,123.25,7,2,0);
  db.prepare('INSERT INTO mock_provider_submissions(id,request_id,job_id,provider_job_id,created_at_ms,outcome) VALUES(?,?,?,?,?,?)').run(17,'mock-request',null,'mock-id',9007199254740993n,Buffer.from([0,254,13,10]));
  db.exec("UPDATE sqlite_sequence SET seq=9007199254740995 WHERE name='mock_provider_submissions'");
 }
 t.after(()=>{if(db.isOpen)db.close();});return db;
}
function seedApplyStates(db){
 const tasks=[];
 for(const [index,status] of ['prepared','dispatching','unknown','applied','not_applied'].entries()){
  const projectId=randomUUID(),id=randomUUID(),requestId=randomUUID();
  db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,raw({id:projectId,name:'界'}));
  const input=raw({projectId,requestId,expectedRevision:1}),claim=status==='dispatching'?randomUUID():null;
  db.prepare("INSERT INTO edit_tasks(position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes) VALUES(?,?,?,'timeline.loudness.apply',?,?,?,'timeline:mutation','new',?,1,0,?,?,?,?,'at','at',16384)")
   .run(index+17,id,projectId,input,requestId,'d'.repeat(64),status,claim,claim?randomUUID():null,status==='applied'?'e'.repeat(64):null,status==='not_applied'?'TIMELINE_LOUDNESS_APPLY_STALE':null);
  tasks.push({id,projectId,requestId,status});
 }
 const projectId=tasks[0].projectId;
 // Opaque old receipts must remain byte-for-byte; restoration is not repair.
 const timelineRequestInsert=db.prepare('INSERT INTO timeline_requests(rowid,requestId,requestHash,response) VALUES(?,?,?,?)');timelineRequestInsert.setReadBigInts(true);timelineRequestInsert.run(9007199254740993n,randomUUID(),'a'.repeat(64),Buffer.from([0,255,13,10]));
 const historyInsert=db.prepare('INSERT INTO timeline_history(rowid,id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?,?)');
 historyInsert.setReadBigInts(true);
 historyInsert.run(9007199254740995n,randomUUID(),projectId,1,'timeline.loudness.apply','at',raw({gain:0.25}),raw({gain:0.5}));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,1)').run(projectId);
 db.exec("UPDATE sqlite_sequence SET seq=9007199254740997 WHERE name='edit_tasks'");
 return tasks;
}
function tree(root){
 const visit=relative=>{
  const file=path.join(root,relative),info=fs.lstatSync(file);
  if(info.isDirectory())return [[relative,{mode:info.mode}],...fs.readdirSync(file).sort().flatMap(name=>visit(path.join(relative,name)))];
  return [[relative,{mode:info.mode,size:info.size,sha256:hash(fs.readFileSync(file))}]];
 };return visit('');
}
function temporary(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'restore-v27-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

for(const mock of [false,true])test(`source26→restored27 holds every durable apply state with raw preservation, mock=${mock}`,t=>{
 const db=fresh(t,{mock}),tasks=seedApplyStates(db),before=snapshot(db),info=metadata();
 assert.deepEqual(profile.classifyWorkspaceSchemaV26V27(db),{schemaVersion:26,profile:'ordinary'});
 for(const old of [classifyHistorical,detectHistorical])assert.throws(()=>old(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const result=profile.installWorkspaceRestoreSchemaV27(db,info);
 assert.equal(result.schemaVersion,27);assert.equal(result.sourceSchema,26);assert.equal(result.profile,'restored-local-v2');assert.equal(result.heldCounts.edit_tasks,5);
 assertPreserved(db,before);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,i)=>i+1),26,27]);
 for(const item of tasks){
  assert.equal(db.prepare('SELECT executionEpoch FROM edit_tasks WHERE id=?').get(item.id).executionEpoch,'captured');
  assert.equal(db.prepare("SELECT operation FROM workspace_restore_holds WHERE kind='edit_tasks' AND id=?").get(item.id).operation,'timeline.loudness.apply');
  assert.throws(()=>db.prepare('UPDATE edit_tasks SET revision=revision+1 WHERE id=?').run(item.id),/HELD|immutable|transition/);
 }
 assert.deepEqual(profile.validateWorkspaceRestoreSchemaV27(db),result);
 assert.throws(()=>classifyHistorical(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.throws(()=>installHistorical(db,metadata()),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const requestId=randomUUID();
 const local=(operation,origin)=>{const statement=db.prepare("INSERT INTO edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes,executionEpoch) VALUES(?,?,?,?,?,?,'timeline:mutation','new','prepared',1,0,'now','now',16384,?)");statement.setReadBigInts(true);return statement.run(randomUUID(),tasks[0].projectId,operation,raw({projectId:tasks[0].projectId,requestId}),requestId,'f'.repeat(64),origin);};
 assert.throws(()=>local('timeline.loudness.apply',info.workspaceOrigin),/RESTORE_OPERATION_UNAVAILABLE/);
 assert.throws(()=>local('timeline.undo','captured'),/RESTORED_RECORD_HELD/);
 assert.throws(()=>local('timeline.undo',randomUUID()),/RESTORE_ORIGIN_REQUIRED/);
 local('timeline.undo',info.workspaceOrigin);
 assert.deepEqual(profile.validateWorkspaceRestoreSchemaV27(db),result);
});

for(const sql of ['INSERT INTO schema_version VALUES(25)','DELETE FROM schema_version WHERE version=26','INSERT INTO schema_version VALUES(28)',
 "CREATE TABLE workspace_restoration_partial(x)","CREATE TEMP TABLE edit_tasks(x)","CREATE TRIGGER unexpected BEFORE INSERT ON projects BEGIN SELECT 1;END;"])
 test(`new source fixed catalog refuses ${sql}`,t=>{
  const db=fresh(t);db.exec(sql);const before=snapshot(db);
  assert.throws(()=>profile.installWorkspaceRestoreSchemaV27(db,metadata()),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(snapshot(db),before);
 });

for(const fragment of ['CREATE TABLE workspace_restoration','INSERT INTO workspace_restore_timeline_history','CREATE TRIGGER restore_legacy_schema_gate','COMMIT'])
 test(`restored27 construction rolls back all logical bytes at ${fragment}`,t=>{
  const db=fresh(t);seedApplyStates(db);const before=snapshot(db);let fired=false;
  const wrapped={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql){
   if(!fired&&fragment==='COMMIT'&&sql==='COMMIT'){fired=true;throw Error('injected v27 restore failure');}
   const result=db.exec(sql);if(!fired&&sql.includes(fragment)){fired=true;throw Error('injected v27 restore failure');}return result;
  }};
  assert.throws(()=>profile.installWorkspaceRestoreSchemaV27(wrapped,metadata()),/injected v27/);assert.equal(fired,true);assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
  assert.equal(profile.installWorkspaceRestoreSchemaV27(db,metadata()).schemaVersion,27);
 });

for(const sourceVersion of [24,26])test(`offline create→verify→restore→status→reopen fixed pair source${sourceVersion}`,async t=>{
 const base=temporary(t),source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');
 fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(path.join(source,'media'),{mode:0o700});
 const db=fresh(t,{version:sourceVersion,file:path.join(source,'workbench.sqlite')});fs.chmodSync(path.join(source,'workbench.sqlite'),0o600);
 if(sourceVersion===26)seedApplyStates(db);
 const before=snapshot(db);db.close();const sourceBefore=tree(source);
 const created=await createWorkspaceBackup({source,destination:backup});assert.equal(created.databaseSchemaVersion,sourceVersion);assert.equal(workspaceBackupResultSchema.safeParse(created).success,true);assert.equal(oldResultSchema.safeParse(created).success,sourceVersion===24);
 assert.equal(created.integrity,'verified');assert.equal(created.restoration,'not_tested');
 assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);const backupBefore=tree(backup);
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));assert.equal(workspaceBackupManifestSchema.safeParse(manifest).success,true);assert.equal(oldManifestSchema.safeParse(manifest).success,sourceVersion===24);
 assert.deepEqual(Object.keys(manifest).sort(),['applicationVersion','backupId','createdAt','databaseSchemaVersion','entries','format','formatVersion','inventory','scope']);
 const result=await restoreWorkspaceBackup({directory:backup,destination});
 assert.equal(workspaceRestoreOfflineResultSchema.safeParse(result).success,true);assert.equal(result.databaseSchemaVersion,sourceVersion===24?25:27);assert.equal(result.sourceSchema,sourceVersion);assert.equal(oldRestoreResultSchema.safeParse(result).success,sourceVersion===24);
 assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
 const candidate=new DatabaseSync(path.join(destination,'workbench.sqlite'),{readOnly:true});try{assertPreserved(candidate,before,sourceVersion);}finally{candidate.close();}
 const status=await inspectWorkspaceRestorePublication({destination,...result});assert.equal(workspaceRestorePublicationStatusSchema.safeParse(status).success,true);assert.equal(status.databaseSchemaVersion,result.databaseSchemaVersion);
 const discovered=await inspectWorkspaceRestorePublication({destination,directory:backup});assert.deepEqual(discovered,status);
 const store=openStore(destination);const services=createServices(store,new Map());
 try{
  const context=getWorkspaceRestoreContext(store);assert.equal(context.schemaVersion,result.databaseSchemaVersion);assert.equal(context.workspaceOrigin,result.workspaceOrigin);
  const disclosure=await services.call('workspace.restore.inspect',{});assert.equal(workspaceRestoreInspectionSchema.safeParse(disclosure).success,true);assert.equal(disclosure.schemaVersion,result.databaseSchemaVersion);assert.equal(disclosure.source.schemaVersion,sourceVersion);assert.equal(oldRestoreInspectionSchema.safeParse(disclosure).success,sourceVersion===24);
  assert.deepEqual(disclosure.operationPolicy.find(item=>item.operation==='timeline.loudness.apply'),{operation:'timeline.loudness.apply',available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'});
 }finally{await services.drain();store.close();}
 await assert.rejects(createWorkspaceBackup({source:destination,destination:path.join(base,'recursive-backup')}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
 assert.equal(fs.existsSync(path.join(base,'recursive-backup')),false);assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);
 const reopened=openStore(destination);try{assert.equal(getWorkspaceRestoreContext(reopened).schemaVersion,result.databaseSchemaVersion);}finally{reopened.close();}
});

test('current ordinary52 live backup inspection is read-only and current contract pairs never accept a cross-product',t=>{
 const base=temporary(t),store=openStore(path.join(base,'ordinary'));t.after(()=>store.close());
 const before=snapshot(store.db),inspection=inspectWorkspaceBackup(store);
 assert.equal(inspection.databaseSchemaVersion,52);assert.equal(inspection.inspectionComplete,true);assert.equal(workspaceBackupInspectionSchema.safeParse(inspection).success,true);assert.deepEqual(snapshot(store.db),before);
 for(const version of [1,23,24,26,28,30,32,34,36,38,40,44,48,50,52])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success,true);
 for(const version of [0,25,27,29,31,33,35,37,39,41,45,49,51,26.5])assert.equal(workspaceBackupSourceSchemaVersion.safeParse(version).success,false);
 const pairs=[['restored-local-v1',24,25],['restored-local-v2',26,27],['restored-local-v3',28,29],['restored-local-v4',30,31],['restored-local-v5',32,33],['restored-local-v6',34,35],['restored-local-v7',36,37],['restored-local-v8',38,39],['restored-local-v9',40,41],['restored-local-v11',44,45],['restored-local-v13',48,49],['restored-local-v14',50,51],['restored-local-v15',52,53]];
 for(const [profile,sourceSchema,databaseSchemaVersion]of pairs)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema,databaseSchemaVersion}).success,true);
 for(const [profile,sourceSchema,databaseSchemaVersion]of pairs)assert.equal(workspaceRestorationPairSchema.safeParse({profile,sourceSchema:sourceSchema+1,databaseSchemaVersion}).success,false);
});

// The legacy expected source is committed once, not synthesized by the new
// constructors during testing. A source edit must not silently bless itself.
test('historical wire validator sources are byte-pinned to the accepted baseline',()=>{
 const fixture=new URL('./fixtures/workspace-restore-v27/',import.meta.url);
 const manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',fixture),'utf8'));
 assert.equal(manifest.sourceCommit,'f8b91713af0c8ed3994e32fa57447827a0ab3883');
 for(const [name,expected] of Object.entries(manifest.files))assert.equal(hash(fs.readFileSync(new URL(`legacy-contracts/${name}`,fixture))),expected,name);
});
