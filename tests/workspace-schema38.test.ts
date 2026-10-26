import type {WorkspaceServices as FixtureServices} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {isWorkspaceRestoreInspection} from '../packages/contracts/src/workspace-restore.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {randomUUID} from 'node:crypto';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38,validateWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {validateWorkspaceAudioRoleRows} from '../packages/business/src/workspace-audio-role-validation.ts';
import {readCurrentWorkspaceRole,assertTimelineAudioRoleWorkspace} from '../packages/business/src/workspace-schema-dispatch.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema,validateCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {open,snapshot} from './workspace-schema26-fixtures.mjs';
import {copyFrozenUpgradeFixtureDatabase} from './helpers/opacity-upgrade-fixture.ts';
import type { DatabaseSync } from 'node:sqlite';
const old=(db: DatabaseSync)=>{initializeWorkspaceSchemaThrough24(db);for(const init of [initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36] as const)init(db);};
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});

test('36 to38 is marker-only, preserves raw rows and is idempotent',t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);const before=snapshot(db);initializeWorkspaceSchema38(db);const after=snapshot(db);
 assert.deepEqual(after.objects,before.objects);
 for(const [name,value]of Object.entries(before.tables))if(name!=='schema_version')assert.deepEqual(after.tables[name],value,name);
 assert.equal(readCurrentWorkspaceRole(db),'ordinary-38');assert.deepEqual(classifyCurrentWorkspaceSchema(db),{schemaVersion:38,profile:'ordinary'});
 initializeWorkspaceSchema38(db);assert.deepEqual(snapshot(db),after);validateWorkspaceSchema38(db);
});

test('38 restores into fixed39 and does not widen old restored37',t=>{
 for(const current of [false,true] as const){const db=open(':memory:');t.after(()=>db.close());old(db);if(current)initializeWorkspaceSchema38(db);
 const result=installCurrentWorkspaceRestoreSchema(db,metadata());assert.equal(result.schemaVersion,current?39:37);assert.equal(result.profile,current?'restored-local-v8':'restored-local-v7');
 assert.equal(validateCurrentWorkspaceRestoreSchema(db).schemaVersion,current?39:37);
 if(current)assert.doesNotThrow(()=>assertTimelineAudioRoleWorkspace(db,{audioRole:null}));else assert.throws(()=>assertTimelineAudioRoleWorkspace(db,{audioRole:null}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 }
});

for(const [name,raw] of [['null','{"audioRole":null}'],['escaped','{"audio\\u0052ole":"human"}'],['duplicate','{"audioRole":"human","audioRole":null}'],['profile','{"audioRoleProfile":"mioon-clip-audio-role-v1"}'],['malformed','{"audioRole":']] as const){
 for(const [table,field]of [['timelines','data'],['timeline_history','beforeSnapshot'],['timeline_requests','response'],['edit_tasks','input'],['exports','data'],['workspace_restore_timeline_history','afterSnapshot'],['agent_edit_proposals','definition']] as const)test(`old profile rejects ${name} evidence in ${table}`,t=>{
  const db=open(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE ${table}(${field} TEXT)`);db.prepare(`INSERT INTO ${table} VALUES(?)`).run(raw);
  assert.throws(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:false}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 });
}

test('new profile rejects duplicate role keys and bounded malformed/oversize cells',t=>{
 const db=open(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE edit_tasks(input TEXT)');
 for(const value of ['{"audioRole":null,"audioRole":"music"}','{"audioRole":','x'.repeat(4*1024*1024+1)] as const){
  db.exec('DELETE FROM edit_tasks');db.prepare('INSERT INTO edit_tasks VALUES(?)').run(value);assert.throws(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true}),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});
 }
});

test('new profile admits silent video and audio classifications but rejects image explicit clear',t=>{
 const db=open(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);CREATE TABLE timelines(projectId TEXT,data TEXT)');
 const projectId=randomUUID(),assetId=randomUUID();
 for(const mimeType of ['video/mp4','audio/wav','image/png'] as const){
  db.exec('DELETE FROM assets;DELETE FROM timelines');db.prepare('INSERT INTO assets VALUES(?,?,?)').run(assetId,projectId,JSON.stringify({id:assetId,projectId,mimeType,hasAudio:false}));
  db.prepare('INSERT INTO timelines VALUES(?,?)').run(projectId,JSON.stringify({clips:[{assetId,audioRole:null}]}));
  if(mimeType==='image/png')assert.throws(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true}),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});else assert.doesNotThrow(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true}));
 }
});

test('role-bearing exports require exact declaration and role-free exports forbid one',t=>{
 const db=open(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);CREATE TABLE exports(projectId TEXT,data TEXT)');
 const projectId=randomUUID(),asset={id:randomUUID(),projectId,mimeType:'video/mp4'},clip={assetId:asset.id,audioRole:'human'};
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset.id,projectId,JSON.stringify(asset));
 for(const [roles,profile,valid]of [[true,undefined,false],[true,'wrong',false],[true,'mioon-clip-audio-role-v1',true],[false,'mioon-clip-audio-role-v1',false]] as const){
  const value={timeline:{clips:roles?[clip]:[]},assets:[asset],...(profile?{audioRoleProfile:profile}:{})};db.exec('DELETE FROM exports');db.prepare('INSERT INTO exports VALUES(?,?)').run(projectId,JSON.stringify(value));
  if(valid)assert.doesNotThrow(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true}));else assert.throws(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true}),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});
 }
});

test('malformed unrelated legacy payloads are left to historical readers',t=>{
 const db=open(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE timeline_requests(response TEXT)');
 for(const value of ['{','',null,'{"unrelated":'] as const){db.prepare('INSERT INTO timeline_requests VALUES(?)').run(value);}
 assert.doesNotThrow(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:false}));
});

test('old profiles reject role error proof even when task input has no role',t=>{
 const db=open(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE edit_tasks(input TEXT,errorCode TEXT)');
 for(const code of ['INVALID_AUDIO_ROLE','AUDIO_ROLE_CLIP_UNSUPPORTED'] as const){
  db.exec('DELETE FROM edit_tasks');db.prepare('INSERT INTO edit_tasks VALUES(?,?)').run('{}',code);
  assert.throws(()=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:false}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 }
});

test('36 to38 rejects smuggled role evidence before marker writes',t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);const projectId=randomUUID();
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId}));
 db.prepare('INSERT INTO timelines(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),projectId,JSON.stringify({projectId,clips:[{audioRole:null}]}));
 const before=snapshot(db);assert.throws(()=>initializeWorkspaceSchema38(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});assert.deepEqual(snapshot(db),before);
});

for(const guard of ['immutable_timeline_responses','immutable_timeline_history','immutable_timeline_render_snapshot','agent_chat_one_active'] as const)test(`marker-only38 refuses missing ${guard} without repairs or marker writes`,t=>{
 const db=open(':memory:');t.after(()=>db.close());old(db);
 db.exec(`DROP ${guard==='agent_chat_one_active'?'INDEX':'TRIGGER'} ${guard}`);const before=snapshot(db);
 assert.throws(()=>initializeWorkspaceSchema38(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
});

test('restored37 refuses role-bearing edit-task preparation without reserving an intent',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'role-restored37-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const db=open(path.join(root,'workbench.sqlite'));old(db);const projectId=randomUUID();
 db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'old restored',revision:1}));
 const restoration=installCurrentWorkspaceRestoreSchema(db,metadata());db.close();
 const store=(openStore(root) as unknown as FixtureStore),services=(createServices(store,new Map()) as unknown as FixtureServices),tasks=(createEditTasks({store,services}) as unknown as import("./helpers/strict-opacity-fixture-types.ts").OpacityTasks);
 try{
  const before=snapshot(store.db);
  const ordinaryShape=await services.call('workspace.restore.inspect',{}),capability=await services.call('workspace.restore.inspect',{includeAudioRoleCapability:true});
  assert.equal(Object.hasOwn(ordinaryShape,'audioRoleCapability'),false);
  assert.deepEqual(capability,{...ordinaryShape,audioRoleCapability:{profileId:'mioon-clip-audio-role-v1',editable:false}});
  assert.equal(isWorkspaceRestoreInspection(capability),true);
  await assert.rejects(services.call('timeline.clip.update',{projectId,expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),patch:{audioRole:null}},{expectedWorkspaceOrigin:restoration.workspaceOrigin}),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.throws(()=>tasks.prepare({projectId,origin:'new',operation:'timeline.clip.update',input:{projectId,expectedRevision:1,requestId:randomUUID(),clipId:randomUUID(),patch:{audioRole:null}}},{expectedWorkspaceOrigin:restoration.workspaceOrigin}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.deepEqual(snapshot(store.db),before);
 }finally{await services.drain();store.close();}
});

test('actual backup38 restores role timelines, history and set/clear receipts exactly into editable39',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'role-backup38-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),backup=path.join(root,'backup'),destination=path.join(root,'restored');
 // Produce genuine role-edit receipts in the current owned runtime, then
 // project them into a separately constructed fixed38 source for old restore.
 let store=(openStore(path.join(root,'seed-runtime')) as unknown as FixtureStore);
 let services=(createServices(store,new Map()) as unknown as FixtureServices);
 const project=await services.call('project.create',{name:'role capture'}),projectId=project.id;
 // Metadata only: editorial role edits never probe or require a media file.
 const asset=store.put('assets',{id:randomUUID(),projectId,name:'silent synthetic video',mimeType:'video/mp4',duration:600,width:720,height:1280,hasVideo:true,hasAudio:false});
 let timeline=await services.call('timeline.get',{projectId});
 const request=(value: {revision:number},extra={})=>({projectId,expectedRevision:value.revision,requestId:randomUUID(),...extra});
 timeline=await services.call('timeline.clip.add',request(timeline,{trackId:timeline.tracks.find((track)=>track.kind==='video')!.id,assetId:asset.id,startFrame:0,durationFrames:60}));
 const clipId=timeline.clips[0].id,set=request(timeline,{clipId,patch:{audioRole:'human'}});
 const setResponse=timeline=await services.call('timeline.clip.update',set);
 const clear=request(timeline,{clipId,patch:{audioRole:null}});
 const clearResponse=timeline=await services.call('timeline.clip.update',clear);
 assert.equal(Object.hasOwn(timeline.clips[0],'audioRole'),true);assert.equal(timeline.clips[0].audioRole,null);
 for(const [input,response]of [[set,setResponse],[clear,clearResponse]] as const)assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId)!.response,JSON.stringify(response));
 await services.drain();store.close();
 copyFrozenUpgradeFixtureDatabase(source,store,{version:38});
 const frozen=open(path.join(source,'workbench.sqlite'));let before,history;
 try{validateWorkspaceSchema38(frozen);assert.deepEqual(classifyCurrentWorkspaceSchema(frozen),{schemaVersion:38,profile:'ordinary'});before=snapshot(frozen);history=frozen.prepare('SELECT rowid AS capturedRowid,* FROM timeline_history ORDER BY rowid').all();}finally{frozen.close();}
 const captured=await (createWorkspaceBackup({source,destination:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);assert.equal(captured.databaseSchemaVersion,38);assert.deepEqual(await (verifyWorkspaceBackup({directory:backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>),captured);
 const restored=await (restoreWorkspaceBackup({directory:backup,destination}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceRestoreResult>);assert.equal(restored.sourceSchema,38);assert.equal(restored.databaseSchemaVersion,39);assert.equal(restored.profile,'restored-local-v8');
 store=(openStore(destination) as unknown as FixtureStore);services=(createServices(store,new Map()) as unknown as FixtureServices);
 try{
  const after=snapshot(store.db);
  for(const table of ['timelines','timeline_history','timeline_history_cursors','timeline_requests','assets'] as const)assert.deepEqual(after.tables[table],before.tables[table],`${table}: exact captured storage classes, bytes and rowids`);
  assert.deepEqual(store.db.prepare('SELECT * FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),history);
  const legacy=await services.call('workspace.restore.inspect',{}),optIn=await services.call('workspace.restore.inspect',{includeAudioRoleCapability:true});
  assert.equal(Object.hasOwn(legacy,'audioRoleCapability'),false);assert.deepEqual(optIn,{...legacy,audioRoleCapability:{profileId:'mioon-clip-audio-role-v1',editable:true}});assert.equal(isWorkspaceRestoreInspection(optIn),true);
  const context={expectedWorkspaceOrigin:restored.workspaceOrigin},unchanged=snapshot(store.db);
  // Existing restored behavior permits read-only exact receipt replay without
  // an origin, but the captured receipt itself remains immutable and held.
  for(const [input,response]of [[set,setResponse],[clear,clearResponse]] as const){
   assert.deepEqual(await services.call('timeline.clip.update',input),response);
   assert.throws(()=>store.db.prepare('UPDATE timeline_requests SET response=response WHERE requestId=?').run(input.requestId),/RESTORED_RECORD_HELD/);
  }
  const next=request(timeline,{clipId,patch:{audioRole:'sfx'}});
  await assert.rejects(services.call('timeline.clip.update',next),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(services.call('timeline.clip.update',next,{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  assert.deepEqual(snapshot(store.db),unchanged);
  timeline=await services.call('timeline.clip.update',next,context);assert.equal(timeline.clips[0].audioRole,'sfx');
  timeline=await services.call('timeline.undo',request(timeline),context);assert.equal(timeline.clips[0].audioRole,null);assert.equal(Object.hasOwn(timeline.clips[0],'audioRole'),true);
  timeline=await services.call('timeline.redo',request(timeline),context);assert.equal(timeline.clips[0].audioRole,'sfx');
  assert.deepEqual(store.db.prepare('SELECT * FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(),history);
  for(const [input,response]of [[set,setResponse],[clear,clearResponse]] as const)assert.equal(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId)!.response,JSON.stringify(response));
  await services.drain();store.close();store=(openStore(destination) as unknown as FixtureStore);services=(createServices(store,new Map()) as unknown as FixtureServices);
  assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion,39);
  assert.equal((await services.call('timeline.get',{projectId})).clips[0].audioRole,'sfx');
 }finally{await services.drain();store.close();}
});
