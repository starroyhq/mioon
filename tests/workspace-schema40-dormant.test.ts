import '../packages/business/src/db.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38,validateWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40,validateWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV39} from '../packages/business/src/workspace-restore-schema-v39.ts';
import {createWorkspaceRestoreProfileV41,WORKSPACE_RESTORE_PROFILE_V41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {open,snapshot,insert,facade} from './workspace-schema26-fixtures.mjs';
import type { DatabaseSync } from 'node:sqlite';

// No workspace, media, provider or service is opened. All database fixtures are
// deterministic in-memory SQLite instances built by the frozen constructors.
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const stamp = '2026-10-15T00:00:00.000Z';
const sourceMarkers = [...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34,36,38];
const initializers = [initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38];
const profile = createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24);
const oldProfile = createWorkspaceRestoreProfileV39(initializeWorkspaceSchemaThrough24);
const metadata = () => ({restorationId:id(901),workspaceOrigin:id(902),sourceBackupId:id(903),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:stamp});
const envelope = () => ({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:0},{frame:20,multiplier:1}]});
function database(t: test.TestContext, version=38) {
 const db=open(':memory:'); t.after(()=>db.close()); initializeWorkspaceSchemaThrough24(db);
 for (const [index,initialize] of initializers.entries()) if (26+index*2<=version) initialize(db);
 if (version===40) initializeWorkspaceSchema40(db);
 return db;
}
function project(db: DatabaseSync, projectId=id(1)) {
 insert(db,'projects',{id:projectId,data:JSON.stringify({id:projectId,name:'Deterministic project',revision:1})});
 return projectId;
}
function timeline(fields={}) {
 return {id:id(2),projectId:id(1),revision:1,fps:30,width:720,height:1280,
  tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:id(4),trackId:id(3),assetId:id(5),name:'Clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...fields}],
  durationFrames:20,createdAt:stamp,updatedAt:stamp};
}
const editable = (value: { id?: string; projectId?: string; revision?: number; fps?: number; width?: number; height?: number; tracks: unknown; clips: unknown; durationFrames: unknown; createdAt?: string; updatedAt?: string; }) => ({tracks:value.tracks,clips:value.clips,durationFrames:value.durationFrames});
function seedTimeline(db: DatabaseSync, fields={}) {
 project(db);
 const asset={id:id(5),projectId:id(1),name:'Synthetic metadata only',mimeType:'video/mp4',duration:10,hasAudio:true,hasVideo:true,width:720,height:1280};
 insert(db,'assets',{id:asset.id,projectId:asset.projectId,data:JSON.stringify(asset)});
 const value=timeline(fields);
 insert(db,'timelines',{id:value.id,projectId:value.projectId,data:JSON.stringify(value)});
 return value;
}
function taskRow(number=1, fields={}) {
 const projectId=id(1),requestId=id(100+number);
 return {position:number,id:id(200+number),projectId,operation:'timeline.clip.update',
  input:JSON.stringify({projectId,requestId,expectedRevision:1,clipId:id(4),patch:{name:'Retained'}}),
  requestId,digest:'a'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,
  claim:null,claimInstance:null,receiptDigest:null,errorCode:null,createdAt:stamp,updatedAt:stamp,bytes:16384,...fields};
}
function unchangedFailure(db:DatabaseSync, action:()=>unknown, expected={code:'RESTORE_SCHEMA_UNSUPPORTED'}) {
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot); assert.throws(action,expected); assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before); assert.equal(db.isTransaction,false);
}

for (const sequence of ['integer','real','wide integer'] as const) test(`dormant38 to40 is marker-only and preserves ${sequence} task sequence storage`,t=>{
 const db=database(t); project(db);
 insert(db,'edit_tasks',taskRow(1,{digest:Buffer.alloc(64,0x61),createdAt:Buffer.from('retained bytes')}));
 if(sequence==='real') db.exec("UPDATE sqlite_sequence SET rowid=57,seq=11.0 WHERE name='edit_tasks'");
 if(sequence==='wide integer') db.exec("UPDATE sqlite_sequence SET rowid=9007199254741099,seq=9007199254741999 WHERE name='edit_tasks'");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot); initializeWorkspaceSchema40(db); const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.deepEqual(after.objects,before.objects);
 for(const [name,value] of Object.entries(before.tables)) if(name!=='schema_version') assert.deepEqual(after.tables[name],value,name);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...sourceMarkers,40]);
 assert.deepEqual(profile.classifyWorkspaceSchemaV40V41(db),{schemaVersion:40,profile:'ordinary'});
 initializeWorkspaceSchema40(db); validateWorkspaceSchema40(db); assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),after);
 assert.throws(()=>validateWorkspaceSchema38(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

for(const sql of ['DELETE FROM schema_version WHERE version=38','DELETE FROM schema_version WHERE version=13','INSERT INTO schema_version VALUES(39)','INSERT INTO schema_version VALUES(41)','INSERT INTO schema_version VALUES(999)'] as const) test(`ordinary40 rejects a non-exact source marker chain: ${sql}`,t=>{
 const db=database(t); db.exec(sql); unchangedFailure(db,()=>initializeWorkspaceSchema40(db));
});
for(const guard of ['immutable_timeline_responses','immutable_timeline_history','immutable_timeline_render_snapshot','agent_chat_one_active'] as const) test(`ordinary40 refuses missing inherited ${guard} without repairs`,t=>{
 const db=database(t); db.exec(`DROP ${guard==='agent_chat_one_active'?'INDEX':'TRIGGER'} ${guard}`);
 unchangedFailure(db,()=>initializeWorkspaceSchema40(db));
});
for(const raw of ['{"volumeEnvelope":null}','{"volume\\u0045nvelope":null}','{"volumeEnvelope":null,"volumeEnvelope":0}','{"volumeEnvelope":'] as const) test(`ordinary38 positive envelope evidence is rejected before marker writes: ${raw}`,t=>{
 const db=database(t); project(db); insert(db,'timeline_requests',{requestId:id(70),requestHash:'a'.repeat(64),response:raw});
 const effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[],before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot); assert.throws(()=>initializeWorkspaceSchema40(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(item)=>effects.push(item)) as unknown as Parameters<typeof initializeWorkspaceSchema40>[0])),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before); assert.ok(effects.every(item=>item.sql==='BEGIN IMMEDIATE')); assert.equal(db.isTransaction,false);
});
test('ordinary40 interruption after marker insertion rolls back without touching prior bytes',t=>{
 const db=database(t); seedTimeline(db); const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot); let injected=false;
 const wrapped=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(item)=>{if(item.phase==='after'&&item.sql==='INSERT INTO main.schema_version(version) VALUES(40)'){injected=true;throw Error('injected interruption');}}) as unknown as import("node:sqlite").DatabaseSync);
 assert.throws(()=>initializeWorkspaceSchema40((wrapped as unknown as Parameters<typeof initializeWorkspaceSchema40>[0])),/injected interruption/); assert.equal(injected,true); assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before); assert.equal(db.isTransaction,false);
 initializeWorkspaceSchema40(db); validateWorkspaceSchema40(db);
});
for(const kind of ['blob','text'] as const) test(`ordinary40 rejects bounded ${kind} task sequence projection`,t=>{
 const db=database(t); project(db); insert(db,'edit_tasks',taskRow());
 db.exec(`UPDATE sqlite_sequence SET seq=${kind==='blob'?'zeroblob(8388608)':'CAST(zeroblob(8388608) AS TEXT)'} WHERE name='edit_tasks'`);
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),projected: {kind:import('node:sqlite').SQLOutputValue;seq:import('node:sqlite').SQLOutputValue}[]=[]; const wrapped=((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,()=>{}) as unknown as import("node:sqlite").DatabaseSync),prepare=wrapped.prepare;
 wrapped.prepare=sql=>{const statement=prepare(sql);if(!/^SELECT rowid,CASE WHEN typeof\(seq\)/.test(sql))return statement;
  return new Proxy(statement,{get(target,key){if(key==='all')return()=>{const rows=target.all();projected.push(...rows.map((row)=>({kind:row.kind,seq:row.seq})));return rows;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 assert.throws(()=>initializeWorkspaceSchema40((wrapped as unknown as Parameters<typeof initializeWorkspaceSchema40>[0])),{code:'RESTORE_SCHEMA_UNSUPPORTED'}); assert.deepEqual(projected,[{kind,seq:null}]); assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});

for(const fields of [{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const) test(`ordinary40 and exact restored41 preserve ${Object.hasOwn(fields,'volumeEnvelope')?fields.volumeEnvelope===null?'null':'non-null':'absent'} timeline/history/receipt shapes`,t=>{
 const db=database(t,40),value=seedTimeline(db,fields),saved=editable(value);
 insert(db,'timeline_history',{id:id(20),projectId:id(1),position:1,operation:'timeline.clip.update',createdAt:stamp,beforeSnapshot:JSON.stringify(saved,null,2),afterSnapshot:JSON.stringify(saved)});
 insert(db,'timeline_history_cursors',{projectId:id(1),position:1});
 insert(db,'timeline_requests',{requestId:id(21),requestHash:'a'.repeat(64),response:JSON.stringify(value,null,2)});
 const historicalInput={projectId:id(1),requestId:id(101),expectedRevision:1,clipId:id(444),patch:Object.hasOwn(fields,'volumeEnvelope')?fields:{name:'Historical deleted clip'}};
 insert(db,'edit_tasks',taskRow(1,{input:JSON.stringify(historicalInput,null,1),digest:Buffer.alloc(64,0x61),createdAt:Buffer.from('retained timestamp')}));
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot); validateWorkspaceSchema40(db); const info=profile.installWorkspaceRestoreSchemaV41(db,metadata());
 assert.equal(info.schemaVersion,41); assert.equal(info.sourceSchema,40); assert.equal(info.profile,WORKSPACE_RESTORE_PROFILE_V41); assert.equal(info.heldCounts.edit_tasks,1);
 const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 for(const [name,prior] of Object.entries(before.tables)){
  if(name==='schema_version')continue;
  if(name==='edit_tasks'){assert.deepEqual(after.tables[name].fields,[...prior.fields,'executionEpoch']);assert.deepEqual(after.tables[name].rows.map((row)=>row.slice(0,-2)),prior.rows);}
  else assert.deepEqual(after.tables[name],prior,name);
 }
 const history=db.prepare('SELECT rowid AS capturedRowid,* FROM timeline_history ORDER BY rowid').all();
 assert.deepEqual(db.prepare('SELECT * FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),history);
 assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...sourceMarkers,40,41]);
 const fresh=createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24); assert.deepEqual(fresh.validateWorkspaceRestoreSchemaV41(db),info); assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),after);
 unchangedFailure(db,()=>initializeWorkspaceSchema40(db));
});

test('restored41 held tasks, receipt vacancy and execution epochs remain isolated',t=>{
 const db=database(t,40); project(db); const held=taskRow(); insert(db,'edit_tasks',held);
 insert(db,'timeline_requests',{requestId:id(60),requestHash:'a'.repeat(64),response:'{"retained":"raw"}'});
 const info=profile.installWorkspaceRestoreSchemaV41(db,metadata()),before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.equal(db.prepare('SELECT executionEpoch FROM edit_tasks').get()!.executionEpoch,'captured');
 for(const action of [
  ()=>db.exec('UPDATE edit_tasks SET status=\'dispatching\',revision=revision+1,claim=\'00000000-0000-4000-8000-000000000999\',claimInstance=\'00000000-0000-4000-8000-000000000998\''),
  ()=>db.exec('DELETE FROM edit_tasks'),
  ()=>insert(db,'edit_tasks',taskRow(2,{requestId:held.requestId,input:held.input,executionEpoch:info.workspaceOrigin})),
  ()=>db.prepare('UPDATE timeline_requests SET response=response WHERE requestId=?').run(id(60)),
  ()=>db.prepare('INSERT OR REPLACE INTO timeline_requests VALUES(?,?,?)').run(id(60),'b'.repeat(64),'{}'),
 ] as const){assert.throws(action,/RESTORED_RECORD_HELD/);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);}
 assert.throws(()=>insert(db,'edit_tasks',taskRow(2,{executionEpoch:'captured'})),/RESTORED_RECORD_HELD/);
 assert.throws(()=>insert(db,'edit_tasks',taskRow(2,{executionEpoch:id(999)})),/RESTORE_ORIGIN_REQUIRED/);
 insert(db,'edit_tasks',taskRow(2,{executionEpoch:info.workspaceOrigin}));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM edit_tasks WHERE acknowledged=0').get()!.n,2);
 assert.throws(()=>db.prepare('UPDATE edit_tasks SET executionEpoch=? WHERE id=?').run(id(999),id(202)),/RESTORE_EPOCH_IMMUTABLE/);
 assert.throws(()=>insert(db,'edit_tasks',taskRow(3,{executionEpoch:info.workspaceOrigin})),/UNIQUE constraint failed/);
 assert.equal(profile.validateWorkspaceRestoreSchemaV41(db).heldCounts.edit_tasks,1);
});

test('restored41 source40 pair is exact and historical restored39 is never upgraded or reinterpreted',t=>{
 const old=database(t); unchangedFailure(old,()=>profile.installWorkspaceRestoreSchemaV41(old,metadata()));
 const restored=oldProfile.installWorkspaceRestoreSchemaV39(old,metadata()); assert.equal(restored.schemaVersion,39);
 for(const action of [()=>initializeWorkspaceSchema40(old),()=>profile.classifyWorkspaceSchemaV40V41(old),()=>profile.installWorkspaceRestoreSchemaV41(old,metadata())] as const) unchangedFailure(old,action);
 assert.equal(oldProfile.validateWorkspaceRestoreSchemaV39(old).schemaVersion,39);
 const current=database(t,40); unchangedFailure(current,()=>oldProfile.classifyWorkspaceSchemaV38V39(current));
 profile.installWorkspaceRestoreSchemaV41(current,metadata()); unchangedFailure(current,()=>profile.installWorkspaceRestoreSchemaV41(current,metadata()),{code:'RESTORE_SOURCE_SCHEMA_UNSUPPORTED'});
});
for(const change of ["sourceSchema=38","profile='restored-local-v8'"] as const) test(`restored41 rejects forged metadata pair ${change}`,t=>{
 const db=database(t,40); profile.installWorkspaceRestoreSchemaV41(db,metadata());
 const guard=db.prepare("SELECT sql FROM sqlite_schema WHERE name='restore_workspace_restoration_update'").get()!.sql;
 db.exec(`DROP TRIGGER restore_workspace_restoration_update;PRAGMA ignore_check_constraints=ON;UPDATE workspace_restoration SET ${change};PRAGMA ignore_check_constraints=OFF;${guard}`);
 unchangedFailure(db,()=>profile.validateWorkspaceRestoreSchemaV41(db),{code:'RESTORE_METADATA_INVALID'});
});

test('ordinary40 and restored41 retain inherited roles, annotation and image/colour admission',t=>{
 const db=database(t,40),value=seedTimeline(db,{audioRole:'human',colour:null,volumeEnvelope:null});
 for(const [index,mimeType,profileId] of [[0,'image/png','mioon-srgb-image-clip-v1'],[1,'image/jpeg','mioon-jfif-image-clip-v1']] as const){
  const assetId=id(10+index);insert(db,'assets',{id:assetId,projectId:id(1),data:JSON.stringify({id:assetId,projectId:id(1),mimeType})});
  const image={...timeline().clips[0],id:id(30+index),assetId,startFrame:20+20*index,colour:{profileId,source:null,look:null}};value.clips.push(image);
 }
 value.durationFrames=60;db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(value),value.id);
 insert(db,'asset_annotations',{assetId:id(5),projectId:id(1),revision:1,tags:'["retained"]',note:'Exact annotation'});
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);validateWorkspaceSchema40(db);profile.installWorkspaceRestoreSchemaV41(db,metadata());
 assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).tables.asset_annotations,before.tables.asset_annotations);
 assert.throws(()=>db.exec("UPDATE asset_annotations SET revision=revision+1,note='changed'"),/RESTORED_RECORD_HELD/);
 assert.equal(profile.validateWorkspaceRestoreSchemaV41(db).heldCounts.asset_annotations,1);
});
for(const mutation of [
( db: { exec: (arg0: string) => unknown; })=>db.exec("UPDATE timelines SET data=json_set(data,'$.clips[0].audioRole','unknown')"),
( db: { exec: (arg0: string) => unknown; })=>db.exec("UPDATE timelines SET data=json_set(data,'$.clips[0].colour.profileId','unknown')"),
( db: unknown)=>{insert(db,'asset_annotations',{assetId:id(5),projectId:id(1),revision:1,tags:'[1]',note:'Invalid tags'});},
] as const) test('ordinary40 invalid inherited feature data fails without repair',t=>{
 const db=database(t,40);seedTimeline(db);mutation(db);const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>validateWorkspaceSchema40(db));assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);
});


test('ordinary40 and restored41 preserve every historical task state and raw non-input storage class',t=>{
 const db=database(t);
 const states=[['prepared',0,'new'],['dispatching',0,'new'],['unknown',0,'new'],['unknown',0,'legacy_session'],['applied',0,'new'],['applied',1,'legacy_session'],['not_applied',0,'new'],['not_applied',1,'new']];
 for(const [index,[status,acknowledged,origin]] of states.entries()){
  const number=index+1,projectId=id(1000+number);project(db,projectId);
  const claimed=status!=='prepared'&&origin==='new';
  insert(db,'edit_tasks',taskRow(number,{projectId,input:JSON.stringify({projectId,requestId:id(100+number),expectedRevision:1,clipId:id(4),patch:{name:'Retained'}}),
   status,acknowledged,origin,revision:status==='prepared'?1:status==='dispatching'?2:acknowledged?4:3,claim:claimed?id(300+number):null,claimInstance:claimed?id(400+number):null,
   receiptDigest:status==='applied'?'b'.repeat(64):null,errorCode:status==='not_applied'?'RETAINED_ERROR':null,digest:Buffer.alloc(64,0x61),createdAt:Buffer.from('raw retained timestamp')}));
 }
 db.exec("UPDATE sqlite_sequence SET rowid=9007199254741099,seq=9007199254741999 WHERE name='edit_tasks'");
 const before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);initializeWorkspaceSchema40(db);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot).tables.edit_tasks,before.tables.edit_tasks);
 profile.installWorkspaceRestoreSchemaV41(db,metadata());const after=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);
 assert.deepEqual(after.tables.edit_tasks.rows.map((row)=>row.slice(0,-2)),before.tables.edit_tasks.rows);assert.deepEqual(after.tables.sqlite_sequence,before.tables.sqlite_sequence);
 assert.equal(profile.validateWorkspaceRestoreSchemaV41(db).heldCounts.edit_tasks,states.length);
});

test('supported40 malformed positive evidence rejects restoration before any DDL or capture',t=>{
 const db=database(t,40);seedTimeline(db,{volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:21,multiplier:1}]}});
 const effects: import('./helpers/strict-workspace-boundary-types.ts').SchemaEvent[]=[],before=(snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot);assert.throws(()=>profile.installWorkspaceRestoreSchemaV41(((facade as unknown as import('./helpers/strict-workspace-boundary-types.ts').SchemaFacade)(db,(item)=>effects.push(item)) as unknown as Parameters<typeof profile.installWorkspaceRestoreSchemaV41>[0]),metadata()),{code:'WORKSPACE_VOLUME_ENVELOPE_INVALID'});
 assert.deepEqual(effects,[]);assert.deepEqual((snapshot(db) as unknown as import("./helpers/strict-workspace-boundary-types.ts").SchemaSnapshot),before);assert.equal(db.isTransaction,false);
});
