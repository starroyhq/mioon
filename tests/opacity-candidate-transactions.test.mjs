import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openOpacityCandidateStore,getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {installWorkspaceRestoreSchemaV43,validateWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {openStore} from '../packages/business/src/db.ts';
import {hasRequestNotAppliedProof} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

const stamp='2026-10-16T00:00:00.000Z';
const curve=(end=30)=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:end,opacity:1}]});
const volume=()=>({profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:.5},{frame:30,multiplier:1}]});
function metadata(ids={}){
  const projectId=ids.projectId??randomUUID(),assetId=ids.assetId??randomUUID(),timelineId=ids.timelineId??randomUUID(),trackId=ids.trackId??randomUUID(),clipId=ids.clipId??randomUUID();
  const project={id:projectId,name:'Synthetic opacity transactions',revision:1,createdAt:stamp,updatedAt:stamp};
  const asset={id:assetId,projectId,name:'Synthetic metadata only; no source file',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:true,
    sha256:'a'.repeat(64),relativePath:'media/never-opened.mp4',createdAt:stamp};
  const clip={id:clipId,assetId,trackId,name:'Synthetic clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
    volumeEnvelope:volume(),audioRole:'human',colour:null};
  const timeline={id:timelineId,projectId,revision:1,fps:30,width:720,height:1280,tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
    clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
  return {project,asset,timeline,clip};
}
function seed(store,data){store.put('projects',data.project);store.put('assets',data.asset);store.put('timelines',data.timeline);}
function snapshot(store,tables=['timelines','timeline_requests','timeline_history','timeline_history_cursors','edit_tasks']){
  return JSON.stringify(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function fixture(t,data=metadata()){
  const root=mkdtempPortable('mioon-opacity-transactions-');
  let store,services,tasks,providerTouches=0;
  const media=[],off=onMediaProcess(event=>media.push(event));
  const providers=new Proxy(new Map(),{get(){providerTouches++;throw Error('Candidate services must not inspect providers');}});
  function open(){store=openOpacityCandidateStore(root);services=createServices(store,providers);tasks=createEditTasks({store,services});}
  open();seed(store,data);
  const f={root,data,get store(){return store;},get services(){return services;},get tasks(){return tasks;},
    input(patch,revision=store.get('timelines',data.timeline.id).revision){return {projectId:data.project.id,clipId:data.clip.id,patch,expectedRevision:revision,requestId:randomUUID()};},
    prepare(input,context={}){return tasks.prepare({projectId:data.project.id,operation:'timeline.clip.update',input,origin:'new'},context);},
    execute(saved,context={}){return tasks.execute({projectId:saved.task.projectId,taskId:saved.task.id,digest:saved.task.digest,instanceId:saved.instanceId},context);},
    ack(saved,context={}){return tasks.acknowledge({projectId:saved.task.projectId,taskId:saved.task.id,digest:saved.task.digest,expectedRevision:saved.task.revision,status:saved.task.status},context);},
    async close(){await tasks.drain();await services.drain();store.close();},
    async reopen(){await f.close();open();},
    open,
  };
  t.after(async()=>{try{await f.close();assert.equal(providerTouches,0);assert.equal(media.length,0);}finally{off();rmSync(root,{recursive:true,force:true});}});
  return f;
}

test('actual42 prepare and execute commit exact opacity while preserving volume, role and colour',async t=>{
  const f=fixture(t),input=f.input({opacityEnvelope:curve()}),saved=f.prepare(input);
  assert.equal(saved.task.status,'prepared');assert.deepEqual(saved.task.input,input);
  const applied=await f.execute(saved);
  assert.equal(applied.task.status,'applied');assert.equal(applied.result.revision,2);
  assert.deepEqual(applied.result.clips[0].opacityEnvelope,curve());
  for(const key of ['volumeEnvelope','audioRole','colour'])assert.deepEqual(applied.result.clips[0][key],f.data.clip[key]);
  assert.deepEqual(f.store.get('timelines',f.data.timeline.id),applied.result);
  const receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId);
  assert.equal(receipt.response,JSON.stringify(applied.result));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_history').get().n,1);
  assert.deepEqual(await f.execute(applied),applied);
});

test('42 durable replay, reopen, undo/redo and compound updates preserve exact fields and reject shrink atomically',async t=>{
  const f=fixture(t),input=f.input({opacityEnvelope:curve()}),saved=f.prepare(input),applied=await f.execute(saved);
  f.ack(applied);
  await f.reopen();
  assert.deepEqual(await f.services.call('timeline.get',{projectId:f.data.project.id}),applied.result);
  const recovered=f.tasks.get({projectId:f.data.project.id,taskId:saved.task.id});
  assert.notEqual(recovered.instanceId,saved.instanceId);
  assert.deepEqual((await f.execute(recovered)).result,applied.result);
  const undo=await f.services.call('timeline.undo',{projectId:f.data.project.id,expectedRevision:2,requestId:randomUUID()});
  assert.equal(undo.revision,3);assert.equal(Object.hasOwn(undo.clips[0],'opacityEnvelope'),false);
  const redo=await f.services.call('timeline.redo',{projectId:f.data.project.id,expectedRevision:3,requestId:randomUUID()});
  assert.equal(redo.revision,4);assert.deepEqual(redo.clips[0].opacityEnvelope,curve());
  assert.deepEqual(await f.services.call('timeline.clip.update',input),applied.result,'exact historical ACK survives later revision and undo/redo');
  const mixedVolume={profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:.25},{frame:30,multiplier:.75}]};
  const mixed=f.input({opacityEnvelope:curve(),volumeEnvelope:mixedVolume,audioRole:'music',colour:null});
  const mixedApplied=await f.execute(f.prepare(mixed));f.ack(mixedApplied);
  assert.deepEqual(mixedApplied.result.clips[0].volumeEnvelope,mixedVolume);
  assert.equal(mixedApplied.result.clips[0].audioRole,'music');assert.equal(mixedApplied.result.clips[0].colour,null);
  const before=snapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const shrink=f.input({durationFrames:15,volumeEnvelope:null});
  await assert.rejects(f.services.call('timeline.clip.update',shrink),{code:'INVALID_OPACITY_ENVELOPE'});
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.equal(f.store.get('timelines',f.data.timeline.id).clips[0].durationFrames,30);
  assert.deepEqual(f.store.get('timelines',f.data.timeline.id).clips[0].volumeEnvelope,mixedVolume,'same-patch volume clear rolls back with invalid opacity shrink');
  assert.equal(f.store.db.isTransaction,false);
  await f.reopen();assert.deepEqual(await f.services.call('timeline.get',{projectId:f.data.project.id}),mixedApplied.result);
});

test('a real receipt INSERT followed by failure rolls back timeline, redo replacement, history and cursor before exact retry',async t=>{
  const f=fixture(t),first=await f.services.call('timeline.clip.update',f.input({opacityEnvelope:curve()}));
  const undone=await f.services.call('timeline.undo',{projectId:f.data.project.id,expectedRevision:first.revision,requestId:randomUUID()});
  const history=await f.services.call('timeline.history.get',{projectId:f.data.project.id});
  assert.equal(history.canRedo,true);assert.equal(history.cursor,0);
  const input=f.input({opacityEnvelope:{profileId:curve().profileId,points:[{frame:0,opacity:1},{frame:30,opacity:.25}]}},undone.revision);
  const tables=['timelines','timeline_requests','timeline_history','timeline_history_cursors'];
  const before=snapshot(f.store,tables),db=f.store.db,changes=db.prepare('SELECT total_changes() AS n').get().n;
  const oldHistoryId=db.prepare('SELECT id FROM timeline_history WHERE position=1').get().id;
  const descriptor=Object.getOwnPropertyDescriptor(db,'prepare'),nativePrepare=db.prepare;
  // Use a normally definitive business rejection so the no-proof assertion
  // exercises writesStarted, rather than passing only for an unknown Error.
  const failure=new AppError('REVISION_CONFLICT','Synthetic failure after the real receipt insert',409);
  let faults=0,writtenChanges=0;
  db.prepare=function(sql){
    const statement=Reflect.apply(nativePrepare,this,[sql]);
    if(sql!=='INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)')return statement;
    return {run(...args){
      Reflect.apply(statement.run,statement,args);faults++;
      assert.equal(db.isTransaction,true);
      assert.equal(JSON.parse(db.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.data.project.id).data).revision,undone.revision+1);
      assert.equal(db.prepare('SELECT requestId FROM timeline_requests WHERE requestId=?').get(input.requestId).requestId,input.requestId);
      assert.equal(db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(f.data.project.id).position,1);
      assert.notEqual(db.prepare('SELECT id FROM timeline_history WHERE position=1').get().id,oldHistoryId,'the old redo row was really replaced before failure');
      writtenChanges=db.prepare('SELECT total_changes() AS n').get().n;
      throw failure;
    }};
  };
  try{
    await assert.rejects(f.services.call('timeline.clip.update',input),error=>{
      assert.equal(error,failure);assert.notEqual(error.details?.mutationOutcome,'not_applied');
      assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.clip.update'}),false);return true;
    });
  }finally{if(descriptor)Object.defineProperty(db,'prepare',descriptor);else delete db.prepare;}
  assert.equal(faults,1);assert.ok(writtenChanges>=changes+5,'timeline, redo delete/new history, cursor and receipt were written inside the failed transaction');
  assert.equal(db.isTransaction,false);assert.equal(snapshot(f.store,tables),before);
  assert.ok(db.prepare('SELECT total_changes() AS n').get().n>changes,'SQLite reports real attempted writes even after rollback');
  const restoredHistory=await f.services.call('timeline.history.get',{projectId:f.data.project.id});
  assert.deepEqual(restoredHistory,history);assert.equal(restoredHistory.canRedo,true);
  const retried=await f.services.call('timeline.clip.update',input);
  assert.equal(retried.revision,undone.revision+1);assert.deepEqual(retried.clips[0].opacityEnvelope,input.patch.opacityEnvelope);
  assert.deepEqual(await f.services.call('timeline.clip.update',input),retried);
  assert.equal((await f.services.call('timeline.history.get',{projectId:f.data.project.id})).canRedo,false);
});

async function restore43(f){
  await f.close();
  const info={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'c'.repeat(64),sourceDbHash:'d'.repeat(64),createdAt:stamp};
  const db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
  try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');installWorkspaceRestoreSchemaV43(db,info);}finally{db.close();}
  f.open();return info;
}

test('43 requires exact origin, holds captured tasks, and reopens after fresh update/undo/redo with frozen evidence intact',async t=>{
  const f=fixture(t),applied=await f.execute(f.prepare(f.input({opacityEnvelope:curve()})));f.ack(applied);
  const captured=f.prepare(f.input({name:'Captured task must stay held'}));
  const info=await restore43(f),context={expectedWorkspaceOrigin:info.workspaceOrigin};
  assert.equal(getOpacityCandidateAssembly(f.store).getRestoreContext().schemaVersion,43);
  const held=f.tasks.get({projectId:f.data.project.id,taskId:captured.task.id});
  assert.equal(held.restore.held,true);assert.equal(held.restore.executionEpoch,'captured');
  const heldTables=['workspace_restoration','workspace_restore_holds','workspace_restore_timeline_history'];
  const heldBefore=snapshot(f.store,heldTables),before=snapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const input=f.input({opacityEnvelope:{profileId:curve().profileId,points:[{frame:0,opacity:1},{frame:30,opacity:.5}]}});
  assert.throws(()=>f.prepare(input),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  assert.throws(()=>f.prepare(input,{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  await assert.rejects(f.services.call('timeline.clip.update',input),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.execute(held,context),{code:'RESTORED_RECORD_HELD'});
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  const saved=f.prepare(input,context);
  assert.equal(saved.restore.held,false);assert.equal(saved.restore.executionEpoch,info.workspaceOrigin);
  const preparedBefore=snapshot(f.store);
  await assert.rejects(f.execute(saved),{code:'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.execute(saved,{expectedWorkspaceOrigin:randomUUID()}),{code:'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  assert.equal(snapshot(f.store),preparedBefore);
  const fresh=await f.execute(saved,context);assert.equal(fresh.task.status,'applied');f.ack(fresh,context);
  const undo=await f.services.call('timeline.undo',{projectId:f.data.project.id,expectedRevision:fresh.result.revision,requestId:randomUUID()},context);
  assert.deepEqual(undo.clips[0].opacityEnvelope,curve());
  const redo=await f.services.call('timeline.redo',{projectId:f.data.project.id,expectedRevision:undo.revision,requestId:randomUUID()},context);
  assert.deepEqual(redo.clips[0].opacityEnvelope,input.patch.opacityEnvelope);
  assert.equal(snapshot(f.store,heldTables),heldBefore);
  assert.equal(validateWorkspaceRestoreSchemaV43(f.store.db).workspaceOrigin,info.workspaceOrigin);
  await f.reopen();
  assert.equal(validateWorkspaceRestoreSchemaV43(f.store.db).workspaceOrigin,info.workspaceOrigin);
  assert.deepEqual(await f.services.call('timeline.get',{projectId:f.data.project.id}),redo);
  assert.equal(snapshot(f.store,heldTables),heldBefore);
  const recovered=f.tasks.get({projectId:f.data.project.id,taskId:captured.task.id});
  assert.equal(recovered.restore.held,true);await assert.rejects(f.execute(recovered,context),{code:'RESTORED_RECORD_HELD'});
});

test('candidate task services must be privately bound to the same store, including duplicate domain IDs',async t=>{
  const data=metadata(),a=fixture(t,data),b=fixture(t,structuredClone(data));
  const beforeA=snapshot(a.store),beforeB=snapshot(b.store);
  assert.throws(()=>createEditTasks({store:a.store,services:b.services}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.throws(()=>createEditTasks({store:a.store,services:{call:a.services.call}}),{code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
  assert.equal(snapshot(a.store),beforeA);assert.equal(snapshot(b.store),beforeB);
  const info=await restore43(a),authority=getOpacityCandidateAssembly(a.store),input=b.input({opacityEnvelope:curve()});
  const stable=snapshot(b.store),changes=b.store.db.prepare('SELECT total_changes() AS n').get().n;
  await authority.withInvocation('timeline.clip.update',input,{},async()=>{
    await assert.rejects(b.services.call('timeline.clip.update',input),{code:'RESTORE_OPERATION_UNAVAILABLE'});
    assert.throws(()=>b.prepare(input),error=>['RESTORE_OPERATION_UNAVAILABLE','EDIT_TASK_OWNER_REQUIRED'].includes(error?.code));
  });
  assert.equal(snapshot(b.store),stable);assert.equal(b.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.equal(getOpacityCandidateAssembly(a.store).getRestoreContext().workspaceOrigin,info.workspaceOrigin);
  assert.doesNotThrow(getOpacityCandidateAssembly(b.store).checkpoint);
});

test('revision digit growth refuses the final complete record above 262144 bytes with no partial history or receipt',async t=>{
  const f=fixture(t),base=structuredClone(f.data.timeline);base.revision=9;
  const colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:f.data.asset.sha256,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null};
  const largeVolume={profileId:volume().profileId,points:Array.from({length:16},(_,frame)=>({frame,multiplier:1.2345678901234567e-100}))};
  const largeOpacity={profileId:curve().profileId,points:Array.from({length:7},(_,frame)=>({frame,opacity:1.2345678901234567e-100}))};
  base.clips=Array.from({length:100},(_,index)=>({...f.data.clip,id:index===0?f.data.clip.id:randomUUID(),name:'x',startFrame:index*30,colour,
    volumeEnvelope:largeVolume,opacityEnvelope:largeOpacity}));base.durationFrames=3000;
  let remaining=262144-Buffer.byteLength(JSON.stringify(base));assert.ok(remaining>0);
  for(const clip of base.clips){
    const escaped=Math.min(199,Math.floor(remaining/6));clip.name+='\u0001'.repeat(escaped);remaining-=escaped*6;
    const plain=Math.min(200-clip.name.length,remaining);clip.name+='x'.repeat(plain);remaining-=plain;
  }
  assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(base)),262144);
  f.store.put('timelines',base);
  const checked=await f.services.call('timeline.get',{projectId:f.data.project.id});assert.equal(checked.revision,9);
  const input=f.input({gain:1}),before=snapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.services.call('timeline.clip.update',input),error=>{
    assert.equal(error.code,'TIMELINE_OPACITY_ENVELOPE_LIMIT');assert.equal(error.details.actualBytes,262145);
    assert.notEqual(error.details.mutationOutcome,'not_applied');
    assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.clip.update'}),false);
    return true;
  });
  assert.equal(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.equal(f.store.get('timelines',f.data.timeline.id).revision,9);assert.equal(f.store.db.isTransaction,false);
});

test('default52 still refuses opacity without opting into a candidate workspace',async t=>{
  const root=mkdtempPortable('mioon-opacity-legacy40-'),store=openStore(root),services=createServices(store,new Map());
  const media=[],off=onMediaProcess(event=>media.push(event));
  t.after(async()=>{try{await services.drain();store.close();assert.equal(media.length,0);}finally{off();rmSync(root,{recursive:true,force:true});}});
  const data=metadata();seed(store,data);const tasks=createEditTasks({store,services});t.after(()=>tasks.drain());
  const input={projectId:data.project.id,clipId:data.clip.id,expectedRevision:1,requestId:randomUUID(),patch:{opacityEnvelope:curve()}};
  const before=snapshot(store),changes=store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.throws(()=>tasks.prepare({projectId:data.project.id,operation:'timeline.clip.update',input,origin:'new'}),{code:'EDIT_TASK_VALIDATION'});
  await assert.rejects(services.call('timeline.clip.update',input),{code:'VALIDATION_ERROR'});
  assert.equal(snapshot(store),before);assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,52);
});
