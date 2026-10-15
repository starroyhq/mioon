import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {openStore,installCurrentWorkspaceRestoreSchema,classifyCurrentWorkspaceSchema,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices,hash} from '../packages/business/src/services.mjs';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {VOLUME_ENVELOPE_PROFILE,createVolumeEnvelopeEvaluator} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {hasRequestNotAppliedProof} from '../packages/contracts/src/index.mjs';
import {validateWorkspaceSchema40} from '../packages/business/src/workspace-schema-v40.ts';
import {snapshot} from './workspace-schema26-fixtures.mjs';

// Genuine owned startup only: no restore-policy mock, facade, manual ordinary
// migration, private ownership token, media file, provider or transport.
const envelope=()=>({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:1},{frame:10,multiplier:.2},{frame:60,multiplier:.8}]});
const code=value=>error=>error?.code===value;
async function fixture(t){
 const root=mkdtempSync(new URL('../.tmp-envelope-owned-',import.meta.url).pathname);
 let store,services,tasks,fault=()=>{};
 const start=()=>{store=openStore(root);services=createServices(store,new Map());tasks=createEditTasks({store,services,fault:label=>fault(label)});};start();
 const close=async()=>{await tasks.drain();await services.drain();store.close();};
 t.after(async()=>{if(store.db.isOpen)await close();rmSync(root,{recursive:true,force:true});});
 assert.deepEqual(classifyCurrentWorkspaceSchema(store.db),{schemaVersion:40,profile:'ordinary'});
 const project=await services.call('project.create',{name:'Owned envelope fixture'});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 const f={root,project,get store(){return store;},get services(){return services;},get tasks(){return tasks;},get timeline(){return timeline;},
  asset(fields={}){return store.put('assets',{id:randomUUID(),projectId:project.id,name:'Metadata-only source',mimeType:'video/mp4',duration:20,width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:'media/not-created.mp4',createdAt:'2026-10-15T00:00:00.000Z',...fields});},
  input(fields={}){return {projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields};},
  async call(operation,fields={},context){const input=f.input(fields),result=await services.call(operation,input,context);timeline=result.timeline??result;return {input,result};},
  prepare(operation,input,context){return tasks.prepare({projectId:input.projectId,operation,input,origin:'new'},context);},
  request(saved){return {projectId:saved.task.projectId,taskId:saved.task.id,digest:saved.task.digest};},
  execute(saved,context){return tasks.execute({...f.request(saved),instanceId:saved.instanceId},context);},
  ack(saved,context){return tasks.acknowledge({...f.request(saved),expectedRevision:saved.task.revision,status:saved.task.status},context);},
  setFault(value){fault=value;},
  async reopen(install){await close();if(install){const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{install(db);}finally{db.close();}}start();timeline=await services.call('timeline.get',{projectId:project.id});},
  state(){return snapshot(store.db);},
 };
 return f;
}
const addInput=(f,asset=f.asset(),fields={})=>f.input({assetId:asset.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:60,volumeEnvelope:envelope(),...fields});

test('owned ordinary40 starts, durably prepares/applies, replays after Undo and reopens exact envelope receipts',async t=>{
 const f=await fixture(t),input=addInput(f),operation='timeline.clip.add',before=f.state();
 const saved=f.prepare(operation,input);assert.equal(saved.task.digest,hash({operation,input}));assert.deepEqual(saved.task.input,input);
 const after=f.state();for(const name of ['timelines','timeline_history','timeline_history_cursors','timeline_requests'])assert.deepEqual(after.tables[name],before.tables[name]);
 assert.deepEqual(f.prepare(operation,input),saved);
 const done=await f.execute(saved);assert.equal(done.task.status,'applied');assert.deepEqual(done.result.clips[0].volumeEnvelope,envelope());f.ack(done);
 const raw=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;
 await f.call('timeline.undo',{expectedRevision:done.result.revision});assert.equal(f.timeline.clips.length,0);
 assert.deepEqual(await f.services.call(operation,input),done.result);
 await f.reopen();assert.equal(f.timeline.clips.length,0);assert.deepEqual(await f.services.call(operation,input),done.result);
 assert.equal(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response,raw);
 const retained=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(retained.task.acknowledged,true);assert.deepEqual((await f.execute(retained)).result,done.result);
 await f.call('timeline.redo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
});

test('owned ordinary40 source replacement, atomic shrink/clear, split and history preserve exact anchors',async t=>{
 const f=await fixture(t),a=f.asset(),b=f.asset(),bad=f.asset({hasAudio:false});
 await f.call('timeline.clip.add',addInput(f,a));const clipId=f.timeline.clips[0].id;
 await f.call('timeline.clip.replaceSource',{clipId,assetId:b.id});assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 for(const [operation,fields,expected]of [
  ['timeline.clip.replaceSource',{clipId,assetId:bad.id},'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED'],
  ['timeline.clip.update',{clipId,patch:{durationFrames:30}},'TIMELINE_VOLUME_ENVELOPE_INVALID'],
 ]){const before=f.state();await assert.rejects(f.call(operation,fields),code(expected));assert.deepEqual(f.state(),before);}
 const smaller={profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:4,multiplier:.2},{frame:30,multiplier:.6}]};
 await f.call('timeline.clip.update',{clipId,patch:{durationFrames:30,volumeEnvelope:smaller}});assert.deepEqual(f.timeline.clips[0].volumeEnvelope,smaller);
 await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 const original=structuredClone(f.timeline.clips[0]),evaluate=createVolumeEnvelopeEvaluator(original);
 await f.call('timeline.clip.split',{clipId,atFrame:23});const [left,right]=f.timeline.clips;
 assert.equal(createVolumeEnvelopeEvaluator(left).limitAtSample(23*1600),evaluate.limitAtSample(23*1600));
 assert.equal(createVolumeEnvelopeEvaluator(right).limitAtSample(0),evaluate.limitAtSample(23*1600));
 await f.reopen();assert.deepEqual(f.timeline.clips,[left,right]);await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
 await f.call('timeline.clip.update',{clipId,patch:{durationFrames:30,volumeEnvelope:null}});assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 await f.reopen();assert.equal(f.timeline.clips[0].volumeEnvelope,null);await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
});

test('owned ordinary40 durable invalid source is terminal not_applied with no domain writes',async t=>{
 const f=await fixture(t),input=addInput(f,f.asset({hasAudio:false})),saved=f.prepare('timeline.clip.add',input),before=f.state();
 const done=await f.execute(saved);assert.equal(done.task.status,'not_applied');assert.equal(done.task.errorCode,'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');
 const after=f.state();for(const name of ['timelines','timeline_history','timeline_history_cursors','timeline_requests'])assert.deepEqual(after.tables[name],before.tables[name]);
 await f.reopen();const retained=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(retained.task.status,'not_applied');assert.equal(retained.task.digest,saved.task.digest);
});

for(const phase of ['afterClaim','afterBusinessCommit'])test(`owned ordinary40 ${phase} interruption recovers without dispatch and rejects stale instance`,async t=>{
 const f=await fixture(t),input=addInput(f),saved=f.prepare('timeline.clip.add',input);
 f.setFault(label=>{if(label===phase)throw Error('Synthetic coordinator interruption');});
 await assert.rejects(f.execute(saved),code('EDIT_TASK_STORAGE_UNAVAILABLE'));f.setFault(()=>{});await f.reopen();
 const before=f.state();await assert.rejects(f.execute(saved),code('EDIT_TASK_STALE_INSTANCE'));assert.deepEqual(f.state(),before);
 const recovery=f.tasks.reconcileStartup();assert.equal(recovery.unavailable,0);
 const current=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(current.task.digest,saved.task.digest);assert.deepEqual(current.task.input,input);
 assert.notEqual(current.instanceId,saved.instanceId);assert.equal(current.task.status,phase==='afterClaim'?'unknown':'applied');
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,phase==='afterClaim'?0:1);
 const done=await f.execute(current);assert.equal(done.task.status,'applied');assert.deepEqual(done.result.clips[0].volumeEnvelope,envelope());
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_history').get().n,1);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,1);
});

test('owned restored41 keeps captured evidence immutable and admits envelope writes only in the current origin/epoch',async t=>{
 const f=await fixture(t),asset=f.asset(),added=await f.call('timeline.clip.add',addInput(f,asset));
 const clipId=f.timeline.clips[0].id,pending=f.prepare('timeline.clip.update',f.input({clipId,patch:{volumeEnvelope:null}}));
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};
 await f.reopen(db=>{assert.equal(installCurrentWorkspaceRestoreSchema(db,metadata).schemaVersion,41);});
 assert.equal(getWorkspaceRestoreContext(f.store).schemaVersion,41);const context={expectedWorkspaceOrigin:metadata.workspaceOrigin},before=f.state();
 assert.deepEqual(await f.services.call('timeline.clip.add',added.input),added.result);assert.deepEqual(f.state(),before);
 const heldRow=f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id);
 assert.equal(heldRow.executionEpoch,'captured');
 await assert.rejects(f.execute(pending,context),code('RESTORED_RECORD_HELD'));
 await assert.rejects(f.services.call('timeline.clip.update',pending.task.input,context),code('RESTORED_RECORD_HELD'));assert.deepEqual(f.state(),before);
 await assert.rejects(f.services.call('timeline.track.add',f.input({requestId:pending.task.requestId,kind:'audio'}),context),code('RESTORED_RECORD_HELD'));assert.deepEqual(f.state(),before);
 const updates=[{volumeEnvelope:null},{volumeEnvelope:envelope()},{gain:.5}];
 for(const [badContext,expected]of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']]){
  for(const patch of updates){const input=f.input({clipId,patch});
   await assert.rejects(f.services.call('timeline.clip.update',input,badContext),code(expected));
   assert.throws(()=>f.prepare('timeline.clip.update',input,badContext),code(expected));assert.deepEqual(f.state(),before);
  }
  await assert.rejects(f.services.call('timeline.clip.add',addInput(f,asset,{startFrame:60}),badContext),code(expected));assert.deepEqual(f.state(),before);
 }
 await f.call('timeline.clip.update',{clipId,patch:{gain:.5}},context);assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 await f.call('timeline.clip.update',{clipId,patch:{volumeEnvelope:null}},context);assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 await f.call('timeline.clip.update',{clipId,patch:{volumeEnvelope:envelope()}},context);
 await f.call('timeline.clip.add',addInput(f,asset,{startFrame:60}),context);assert.deepEqual(f.timeline.clips[1].volumeEnvelope,envelope());
 const input=f.input({clipId,patch:{volumeEnvelope:null}}),fresh=f.prepare('timeline.clip.update',input,context);
 assert.equal(fresh.restore.executionEpoch,metadata.workspaceOrigin);assert.equal(fresh.restore.held,false);
 for(const [badContext,expected]of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']]){
  const state=f.state();await assert.rejects(f.execute(fresh,badContext),code(expected));assert.deepEqual(f.state(),state);
 }
 const done=await f.execute(fresh,context);assert.equal(done.task.status,'applied');assert.equal(done.result.clips[0].volumeEnvelope,null);f.ack(done,context);
 assert.deepEqual(f.state().tables.workspace_restore_holds,before.tables.workspace_restore_holds);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id),heldRow);
 await f.reopen();assert.equal(getWorkspaceRestoreContext(f.store).workspaceOrigin,metadata.workspaceOrigin);assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 assert.deepEqual(await f.services.call('timeline.clip.update',input),done.result,'retained receipt replays read-only without origin');
});

test('owned ordinary40 durable updates distinguish absent/null/value and retain inherited role/colour fields',async t=>{
 const f=await fixture(t),source=f.asset();
 await f.call('timeline.clip.add',{assetId:source.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:60});
 const clipId=f.timeline.clips[0].id;assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
 for(const value of [null,envelope()]){
  const input=f.input({clipId,patch:{volumeEnvelope:value,audioRole:'human',colour:null}}),saved=f.prepare('timeline.clip.update',input);
  const done=await f.execute(saved);assert.equal(done.task.status,'applied');assert.deepEqual(done.result.clips[0].volumeEnvelope,value);
  assert.equal(done.result.clips[0].audioRole,'human');assert.equal(done.result.clips[0].colour,null);f.ack(done);
  await f.reopen();assert.deepEqual(f.timeline.clips[0].volumeEnvelope,value);assert.equal(f.timeline.clips[0].audioRole,'human');
 }
 await f.call('timeline.undo');assert.equal(f.timeline.clips[0].volumeEnvelope,null);
 await f.call('timeline.undo');assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
});

for(const phase of ['afterClaim','afterBusinessCommit'])test(`owned restored41 current-epoch ${phase} recovery preserves captured holds and rejects stale instances`,async t=>{
 const f=await fixture(t);await f.call('timeline.clip.add',addInput(f));const clipId=f.timeline.clips[0].id;
 const captured=f.prepare('timeline.clip.update',f.input({clipId,patch:{gain:.75}}));
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};
 await f.reopen(db=>installCurrentWorkspaceRestoreSchema(db,metadata));const context={expectedWorkspaceOrigin:metadata.workspaceOrigin};
 const heldRow=f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(captured.task.id),holds=f.state().tables.workspace_restore_holds;
 const input=f.input({clipId,patch:{volumeEnvelope:null}}),saved=f.prepare('timeline.clip.update',input,context);
 f.setFault(label=>{if(label===phase)throw Error('Synthetic restored coordinator interruption');});
 await assert.rejects(f.execute(saved,context),code('EDIT_TASK_STORAGE_UNAVAILABLE'));f.setFault(()=>{});await f.reopen();
 const before=f.state();await assert.rejects(f.execute(saved,context),code('EDIT_TASK_STALE_INSTANCE'));assert.deepEqual(f.state(),before);
 assert.equal(f.tasks.reconcileStartup().unavailable,0);const current=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});
 assert.equal(current.task.status,phase==='afterClaim'?'unknown':'applied');assert.equal(current.restore.executionEpoch,metadata.workspaceOrigin);assert.deepEqual(current.task.input,input);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,phase==='afterClaim'?0:1);
 const done=await f.execute(current,context);assert.equal(done.task.status,'applied');assert.equal(done.result.clips[0].volumeEnvelope,null);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,1);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(captured.task.id),heldRow);assert.deepEqual(f.state().tables.workspace_restore_holds,holds);
});

for(const restored of [false,true])test(`owned ${restored?'restored41':'ordinary40'} complete envelope budget fails atomically before history/redo/receipt/task writes`,async t=>{
 const f=await fixture(t),source=f.asset();await f.call('timeline.clip.add',addInput(f,source));
 await f.call('timeline.clip.update',{clipId:f.timeline.clips[0].id,patch:{gain:.5}});await f.call('timeline.undo');
 // Seed a complete valid boundary-sized synthetic record, not an admission or
 // ownership bypass. Full ordinary40 validation precedes production dispatch.
 const timeline=structuredClone(f.timeline);timeline.revision=9;
 timeline.tracks=Array.from({length:12},(_,i)=>({id:randomUUID(),name:'\x01'.repeat(150),kind:'video',orderIndex:i,hidden:false,muted:false}));
 timeline.clips=Array.from({length:100},(_,i)=>({id:randomUUID(),trackId:timeline.tracks[0].id,assetId:source.id,name:'\x01'.repeat(200),startFrame:i*180,durationFrames:180,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,fadeInFrames:0,fadeOutFrames:0,colour:null,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:Array.from({length:16},(_,j)=>({frame:j*12,multiplier:.12345678901234567}))}}));
 timeline.durationFrames=18000;timeline.subtitles={profileId:'bottom_cjk_v1',cues:Array.from({length:100},(_,i)=>({id:randomUUID(),text:'中'.repeat(20)+'\n'+'中'.repeat(20),startFrame:i*180,durationFrames:180}))};
 let excess=Buffer.byteLength(JSON.stringify(timeline))-262144;assert.ok(excess>20);
 for(const clip of timeline.clips){while(excess>=6&&clip.name.length>1){clip.name=clip.name.slice(1);excess-=6;}if(excess<6)break;}
 if(excess)timeline.tracks[0].name=timeline.tracks[0].name.slice(1)+'a'.repeat(6-excess);
 assert.equal(Buffer.byteLength(JSON.stringify(timeline)),262144);f.store.put('timelines',timeline);validateWorkspaceSchema40(f.store.db);
 let context;
 if(restored){const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};await f.reopen(db=>installCurrentWorkspaceRestoreSchema(db,metadata));context={expectedWorkspaceOrigin:metadata.workspaceOrigin};}
 const input=f.input({expectedRevision:9,trackId:timeline.tracks[0].id,patch:{muted:false}}),before=f.state();
 await assert.rejects(f.services.call('timeline.track.update',input,context),error=>{
  assert.equal(error.code,'TIMELINE_VOLUME_ENVELOPE_LIMIT');assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.track.update'}),true);
  assert.equal(hasRequestNotAppliedProof(error,{...input,requestId:randomUUID()},{operation:'timeline.track.update'}),false);return true;
 });
 assert.deepEqual(f.state(),before,'all tables, raw storage, history cursor, redo and tasks remain identical');assert.equal(f.store.db.isTransaction,false);
 const saved=f.prepare('timeline.track.update',input,context),prepared=f.state(),done=await f.execute(saved,context);
 assert.equal(done.task.status,'not_applied');assert.equal(done.task.errorCode,'TIMELINE_VOLUME_ENVELOPE_LIMIT');
 const after=f.state();assert.deepEqual(after.objects,prepared.objects);for(const name of Object.keys(prepared.tables))if(name!=='edit_tasks')assert.deepEqual(after.tables[name],prepared.tables[name],name);
});
