import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {reviewedShotSyncSourceDeltas,reverseReviewedShotSync} from './helpers/current-shot-sync-delta.ts';
import {schemas,descriptions,operationEffect,isTimelineMutationResponse,TIMELINE_MUTATION_OPERATIONS,
 TIMELINE_SHOT_SYNC_OPERATIONS,TIMELINE_SHOT_SYNC_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES,DURABLE_EDIT_OPERATIONS} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';

const REFRESH='timeline.clip.refreshSources',APPEND='timeline.shots.append';
const clone=value=>JSON.parse(JSON.stringify(value));
const at='2026-10-23T00:00:00.000Z';
const writes=['timelines','timeline_history','timeline_history_cursors','timeline_requests'];
const code=(expected,check=()=>true)=>error=>error.code===expected&&check(error);

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-shot-sync-')));
 const store=openStore(root),services=createServices(store,new Map());let closed=false;
 const f={root,store,call:(op,input)=>services.call(op,input),
  close(){if(!closed){closed=true;store.close();}},
  capture:()=>Object.fromEntries(writes.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Synthetic source',mimeType:'video/mp4',
   duration:10,width:720,height:1280,hasVideo:true,hasAudio:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,createdAt:at,...patch});},
  // One shot owning generated versions of the given durations (seconds); select picks one by index.
  async shot(title,durations,select){
   const shot=await f.call('shot.create',{projectId:f.projectId,title}),versions=[];
   for(const [index,duration] of durations.entries()){
    const asset=f.asset({provenance:'generated',duration,name:`${title} v${index+1}`}),jobId=randomUUID(),versionId=randomUUID();
    const snapshot={projectId:f.projectId,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
    store.put('jobs',{id:jobId,projectId:f.projectId,shotId:shot.id,versionId,assetId:asset.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot});
    versions.push({...store.put('versions',{id:versionId,projectId:f.projectId,shotId:shot.id,assetId:asset.id,jobId,number:index+1,sha256:asset.sha256,snapshot}),asset});
   }
   if(select!==undefined)await f.select(shot.id,versions[select].id);
   return {id:shot.id,title,versions};
  },
  async select(shotId,versionId){await f.call('version.select',{shotId,versionId,expectedRevision:store.get('shots',shotId).revision});},
  async timeline(){return f.call('timeline.get',{projectId:f.projectId});},
  async add(asset,patch={}){
   const timeline=await f.timeline();
   const next=await f.call('timeline.clip.add',{projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
    trackId:timeline.tracks.find(track=>track.kind==='video').id,name:'Keep this clip',startFrame:0,durationFrames:60,...patch});
   return next.clips.at(-1);
  },
  request:(timeline,extra={})=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...extra}),
 };
 f.projectId=(await f.call('project.create',{name:t.name.slice(0,150)})).id;
 t.after(async()=>{f.close();await rm(root,{recursive:true,force:true});});
 return f;
}

test('both operations are registered, described, effect-annotated, restore-denied and localized', () => {
 assert.deepEqual([...TIMELINE_SHOT_SYNC_OPERATIONS],[REFRESH,APPEND]);
 assert.equal(TIMELINE_SHOT_SYNC_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES+64*1024);
 for(const operation of TIMELINE_SHOT_SYNC_OPERATIONS){
  assert.ok(schemas[operation]&&descriptions[operation].length>40,operation);
  assert.ok(TIMELINE_MUTATION_OPERATIONS.includes(operation),'shares the timeline request namespace and history');
  assert.ok(RESTORE_DENIED_OPERATIONS.includes(operation),'unavailable in restored workspaces');
  const effect=operationEffect(operation);
  assert.deepEqual([effect.readOnly,effect.idempotent,effect.destructive,effect.paidGeneration,effect.externalIO],[false,true,true,false,false]);
  assert.equal(translate('zh-Hans',`operation.${operation}`),descriptions[operation]);
  for(const locale of ['zh-Hant','en','ja'])assert.ok(translate(locale,`operation.${operation}`).length>40);
 }
 const id=randomUUID(),base={projectId:id,expectedRevision:1,requestId:'request-key'};
 assert.equal(schemas[REFRESH].safeParse({...base,clipIds:[id]}).success,true);
 for(const clipIds of [[],[id,id],Array.from({length:101},()=>randomUUID()),['not-a-uuid']])
  assert.equal(schemas[REFRESH].safeParse({...base,clipIds}).success,false,JSON.stringify(clipIds).slice(0,40));
 assert.equal(schemas[APPEND].safeParse(base).success,true);
 assert.equal(schemas[APPEND].safeParse({...base,shotIds:[id]}).success,false,'append takes no shot list');
});

test('refresh switches stale clips to the selected version, keeps every editable field and undoes as one step', async t => {
 const f=await fixture(t);
 const a=await f.shot('Shot A',[10,10],0),b=await f.shot('Shot B',[10,10],0);
 const first=await f.add(a.versions[0].asset,{startFrame:0,sourceInFrame:7,durationFrames:60,gain:.65,fadeInFrames:5,fadeOutFrames:4,rect:{x:40,y:80,width:360,height:640}});
 const second=await f.add(b.versions[0].asset,{startFrame:60,durationFrames:90});
 await f.select(a.id,a.versions[1].id);await f.select(b.id,b.versions[1].id);
 const before=await f.timeline(),historyBefore=await f.call('timeline.history.get',{projectId:f.projectId});
 const input=f.request(before,{clipIds:[second.id,first.id]}),response=await f.call(REFRESH,input);
 assert.deepEqual(Object.keys(response).sort(),['operation','refreshed','requestId','skipped','timeline']);
 assert.equal(response.operation,REFRESH);assert.equal(response.requestId,input.requestId);assert.equal(response.timeline.revision,before.revision+1);
 assert.deepEqual(response.refreshed,[
  {clipId:second.id,shotId:b.id,fromVersionId:b.versions[0].id,toVersionId:b.versions[1].id,assetId:b.versions[1].asset.id},
  {clipId:first.id,shotId:a.id,fromVersionId:a.versions[0].id,toVersionId:a.versions[1].id,assetId:a.versions[1].asset.id},
 ]);
 assert.deepEqual(response.skipped,[]);
 assert.equal(isTimelineMutationResponse(REFRESH,input,response),true);
 for(const [old,versionSet] of [[first,a],[second,b]]){
  const clip=response.timeline.clips.find(item=>item.id===old.id);
  assert.deepEqual({...clip,assetId:old.assetId,versionId:undefined,shotId:undefined},{...old,versionId:undefined,shotId:undefined},'only the source and its pin change');
  assert.deepEqual([clip.assetId,clip.versionId,clip.shotId],[versionSet.versions[1].asset.id,versionSet.versions[1].id,versionSet.id]);
 }
 const history=await f.call('timeline.history.get',{projectId:f.projectId});
 assert.equal(history.length,historyBefore.length+1);assert.equal(history.undoEntry.operation,REFRESH);
 assert.deepEqual(await f.call(REFRESH,input),response,'exact replay returns the original acknowledgement');
 await assert.rejects(f.call(REFRESH,{...input,clipIds:[first.id]}),code('IDEMPOTENCY_CONFLICT'));
 const undone=await f.call('timeline.undo',f.request(response.timeline));
 assert.deepEqual(undone.clips,before.clips,'one undo restores the whole batch');
 const redone=await f.call('timeline.redo',f.request(undone));
 assert.deepEqual(redone.clips,response.timeline.clips);
});

test('refresh skips with reasons and reports clips in request order', async t => {
 const f=await fixture(t);
 const ready=await f.shot('Ready',[10,10],0),short=await f.shot('Short',[10,2],0),current=await f.shot('Current',[10],0),none=await f.shot('Unselected',[10]);
 const imported=f.asset();
 const clips=[await f.add(ready.versions[0].asset),await f.add(short.versions[0].asset,{sourceInFrame:7,durationFrames:60,startFrame:60}),
  await f.add(current.versions[0].asset,{startFrame:120}),await f.add(none.versions[0].asset,{startFrame:180}),await f.add(imported,{startFrame:240})];
 await f.select(ready.id,ready.versions[1].id);await f.select(short.id,short.versions[1].id);
 const before=await f.timeline(),input=f.request(before,{clipIds:clips.map(clip=>clip.id).reverse()});
 const response=await f.call(REFRESH,input);
 assert.deepEqual(response.refreshed.map(row=>row.clipId),[clips[0].id]);
 assert.deepEqual(response.skipped,[
  {clipId:clips[4].id,reason:'NOT_GENERATED'},
  {clipId:clips[3].id,reason:'NO_SELECTION',shotId:none.id,fromVersionId:none.versions[0].id},
  {clipId:clips[2].id,reason:'UP_TO_DATE',shotId:current.id,fromVersionId:current.versions[0].id},
  // 7 + 60 frames are needed; the selected 2 s version has 60.
  {clipId:clips[1].id,reason:'SOURCE_TOO_SHORT',shotId:short.id,fromVersionId:short.versions[0].id,toVersionId:short.versions[1].id,shortByFrames:7},
 ]);
 assert.equal(isTimelineMutationResponse(REFRESH,input,response),true);
 for(const index of [1,2,3,4])assert.deepEqual(response.timeline.clips.find(clip=>clip.id===clips[index].id),before.clips.find(clip=>clip.id===clips[index].id));
});

test('refresh writes nothing when nothing can be refreshed or a clip is unknown', async t => {
 const f=await fixture(t);
 const shot=await f.shot('Current',[10,1],0),clip=await f.add(shot.versions[0].asset);
 const before=await f.timeline();
 await assert.rejects(f.call(REFRESH,f.request(before,{clipIds:[clip.id]})),
  code('NOTHING_TO_REFRESH',error=>error.status===409&&error.details.skipped[0].reason==='UP_TO_DATE'));
 await f.select(shot.id,shot.versions[1].id);
 const stale=await f.timeline(),captured=f.capture();
 // 60 frames are needed and the selected 1 s version has 30.
 await assert.rejects(f.call(REFRESH,f.request(stale,{clipIds:[clip.id]})),
  code('NOTHING_TO_REFRESH',error=>error.details.skipped[0].reason==='SOURCE_TOO_SHORT'&&error.details.skipped[0].shortByFrames===30));
 await assert.rejects(f.call(REFRESH,f.request(stale,{clipIds:[clip.id,randomUUID()]})),code('CLIP_NOT_FOUND',error=>error.status===404));
 await assert.rejects(f.call(REFRESH,f.request({revision:stale.revision+5},{clipIds:[clip.id]})),code('REVISION_CONFLICT'));
 assert.deepEqual(f.capture(),captured,'no timeline, history, cursor or receipt write');
});

test('append adds missing shots in canvas order after the last clip of the first video track', async t => {
 const f=await fixture(t);
 const placed=await f.shot('Placed',[3],0),a=await f.shot('Shot A',[2,4],1),skipped=await f.shot('No selection',[2]),b=await f.shot('Shot B',[1.5],0);
 const existing=await f.add(placed.versions[0].asset,{durationFrames:90,name:'Placed clip'});
 const timeline=await f.timeline(),second=timeline.tracks.filter(track=>track.kind==='video')[1];
 await f.add(f.asset(),{trackId:second.id,startFrame:300,durationFrames:30,name:'Other track'});
 const before=await f.timeline(),input=f.request(before),response=await f.call(APPEND,input);
 assert.equal(isTimelineMutationResponse(APPEND,input,response),true);
 assert.deepEqual(response.appended.map(({clipId: _clipId,...row})=>row),[
  {shotId:a.id,versionId:a.versions[1].id,startFrame:90,durationFrames:120},
  {shotId:b.id,versionId:b.versions[0].id,startFrame:210,durationFrames:45},
 ]);
 assert.deepEqual(response.skipped,[{shotId:skipped.id,reason:'NO_SELECTION'}]);
 const lane=before.tracks.filter(track=>track.kind==='video').sort((x,y)=>x.orderIndex-y.orderIndex)[0];
 for(const [row,shot] of [[response.appended[0],a],[response.appended[1],b]]){
  const clip=response.timeline.clips.find(item=>item.id===row.clipId);
  assert.deepEqual(clip,{id:row.clipId,trackId:lane.id,assetId:shot.versions.find(version=>version.id===row.versionId).asset.id,name:shot.title,
   startFrame:row.startFrame,durationFrames:row.durationFrames,sourceInFrame:0,rect:{x:0,y:0,width:before.width,height:before.height},gain:1,
   versionId:row.versionId,shotId:shot.id});
 }
 assert.deepEqual(response.timeline.clips.slice(0,before.clips.length),before.clips,'existing clips do not move');
 assert.equal(response.timeline.clips.find(clip=>clip.id===existing.id).startFrame,0);
 assert.deepEqual(await f.call(APPEND,input),response,'replay keeps the new clip IDs');
 const undone=await f.call('timeline.undo',f.request(response.timeline));
 assert.deepEqual(undone.clips,before.clips);
 // Everything selectable is now on the timeline again after redo: nothing to append.
 const redone=await f.call('timeline.redo',f.request(undone)),captured=f.capture();
 await assert.rejects(f.call(APPEND,f.request(redone)),code('NOTHING_TO_APPEND',error=>error.status===409&&
  JSON.stringify(error.details.skipped)===JSON.stringify([{shotId:skipped.id,reason:'NO_SELECTION'}])));
 assert.deepEqual(f.capture(),captured);
});

test('append starts an empty timeline at frame 0 and refuses to exceed the timeline length', async t => {
 const f=await fixture(t);
 const a=await f.shot('Shot A',[2],0),b=await f.shot('Shot B',[3],0);
 const empty=await f.timeline(),response=await f.call(APPEND,f.request(empty));
 assert.deepEqual(response.appended.map(row=>[row.shotId,row.startFrame,row.durationFrames]),[[a.id,0,60],[b.id,60,90]]);
 await f.shot('Too long',[600.5],0);
 const current=await f.timeline(),captured=f.capture();
 await assert.rejects(f.call(APPEND,f.request(current)),code('TIMELINE_LIMIT'));
 assert.deepEqual(f.capture(),captured);
});

test('response validators reject altered, reordered or incomplete outcomes', async t => {
 const f=await fixture(t);
 const a=await f.shot('Shot A',[10,10],0),b=await f.shot('Shot B',[10,10],0),c=await f.shot('Shot C',[10]);
 const clips=[await f.add(a.versions[0].asset),await f.add(b.versions[0].asset,{startFrame:60}),await f.add(c.versions[0].asset,{startFrame:120})];
 await f.select(a.id,a.versions[1].id);await f.select(b.id,b.versions[1].id);
 const input=f.request(await f.timeline(),{clipIds:clips.map(clip=>clip.id)}),response=await f.call(REFRESH,input);
 assert.equal(isTimelineMutationResponse(REFRESH,input,response),true);
 const mutations={
  extraKey:value=>{value.extra=true;},
  wrongOperation:value=>{value.operation=APPEND;},
  wrongRequest:value=>{value.requestId='another-request';},
  staleRevision:value=>{value.timeline.revision--;},
  reordered:value=>{value.refreshed.reverse();},
  dropped:value=>{value.skipped=[];},
  duplicated:value=>{value.skipped.push({...value.skipped[0]});},
  clipMismatch:value=>{value.refreshed[0].assetId=randomUUID();},
  sameVersion:value=>{value.refreshed[0].fromVersionId=value.refreshed[0].toVersionId;},
  unknownReason:value=>{value.skipped[0].reason='LOCKED';},
  missingReasonField:value=>{delete value.skipped[0].fromVersionId;},
  noRefreshed:value=>{value.skipped.unshift(...value.refreshed.map(row=>({clipId:row.clipId,reason:'NOT_GENERATED'})));value.refreshed=[];},
 };
 for(const [name,mutate] of Object.entries(mutations)){const value=clone(response);mutate(value);assert.equal(isTimelineMutationResponse(REFRESH,input,value),false,name);}
 assert.equal(isTimelineMutationResponse(REFRESH,{...input,clipIds:[...input.clipIds,randomUUID()]},response),false,'every requested clip is accounted for');
 assert.equal(isTimelineMutationResponse(REFRESH,input,{...response,timeline:{...response.timeline,clips:[]}}),false);
 const appendInput=f.request(response.timeline),appended=await (async()=>{await f.shot('Shot D',[1],0);return f.call(APPEND,appendInput);})();
 assert.equal(isTimelineMutationResponse(APPEND,appendInput,appended),true);
 const appendMutations={
  shiftedStart:value=>{value.appended[0].startFrame++;},
  otherShot:value=>{value.appended[0].shotId=randomUUID();},
  otherVersion:value=>{value.appended[0].versionId=randomUUID();},
  alsoSkipped:value=>{value.skipped.push({shotId:value.appended[0].shotId,reason:'NO_SELECTION'});},
  unpinned:value=>{delete value.timeline.clips.find(clip=>clip.id===value.appended[0].clipId).versionId;},
  notAtTrackEnd:value=>{value.timeline.clips.find(clip=>clip.id===clips[2].id).startFrame=value.appended[0].startFrame+1;},
  nothingAppended:value=>{value.appended=[];},
 };
 for(const [name,mutate] of Object.entries(appendMutations)){const value=clone(appended);mutate(value);assert.equal(isTimelineMutationResponse(APPEND,appendInput,value),false,name);}
});

test('both operations stay out of the durable edit-task ledger, whose table checks its exact operation list', async t => {
 const f=await fixture(t),tasks=createEditTasks({store:f.store,services:{call:(op,input)=>f.call(op,input)},fault:()=>{}});
 for(const operation of TIMELINE_SHOT_SYNC_OPERATIONS)assert.equal(DURABLE_EDIT_OPERATIONS.includes(operation),false,operation);
 assert.equal(DURABLE_EDIT_OPERATIONS.length,21);
 const a=await f.shot('Shot A',[10,10],0),clip=await f.add(a.versions[0].asset),timeline=await f.timeline();
 const rows=()=>f.store.db.prepare('SELECT count(*) AS n FROM edit_tasks').get().n,before=rows();
 for(const [operation,fields] of [[REFRESH,{clipIds:[clip.id]}],[APPEND,{}]])
  assert.throws(()=>tasks.prepare({projectId:f.projectId,operation,input:f.request(timeline,fields),origin:'new'}),error=>typeof error.code==='string',operation);
 assert.equal(rows(),before,'nothing is recorded in the ledger');
});

test('reviewed shot-sync deltas recover the previous pinned sources exactly and reject any other byte', () => {
 for(const delta of reviewedShotSyncSourceDeltas){
  const source=readFileSync(new URL(`../${delta.path}`,import.meta.url),'utf8');
  assert.ok(reverseReviewedShotSync(delta.path,Buffer.from(source)).length>0,delta.path);
  assert.deepEqual(reverseReviewedShotSync(delta.path,reverseReviewedShotSync(delta.path,Buffer.from(source))),reverseReviewedShotSync(delta.path,Buffer.from(source)),'already recovered bytes pass unchanged');
  for(const inverse of delta.inverse){
   for(const changed of [source.replace(inverse.after,inverse.after+' '),source.replace(inverse.after,inverse.after+inverse.after),source.replace(inverse.after,''),source+'\n// unreviewed addition\n'])
    assert.throws(()=>reverseReviewedShotSync(delta.path,Buffer.from(changed)),delta.path);
  }
 }
});

test('shot-sync history and receipts survive backup and restore; restored copies only replay them', async t => {
 const f=await fixture(t),a=await f.shot('Shot A',[10,10],0),clip=await f.add(a.versions[0].asset);
 await f.select(a.id,a.versions[1].id);await f.shot('Shot B',[2],0);
 const refreshInput=f.request(await f.timeline(),{clipIds:[clip.id]}),refreshed=await f.call(REFRESH,refreshInput);
 const appendInput=f.request(refreshed.timeline),appended=await f.call(APPEND,appendInput);
 f.close();
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-shot-sync-restore-')));
 t.after(()=>rm(base,{recursive:true,force:true}));
 await createWorkspaceBackup({source:f.root,destination:path.join(base,'backup')});
 await restoreWorkspaceBackup({directory:path.join(base,'backup'),destination:path.join(base,'restored')});
 const store=openStore(path.join(base,'restored')),services=createServices(store,new Map());
 t.after(()=>store.close());
 const history=await services.call('timeline.history.get',{projectId:f.projectId});
 assert.equal(history.undoEntry.operation,APPEND);
 assert.deepEqual((await services.call('timeline.get',{projectId:f.projectId})).clips,appended.timeline.clips);
 assert.deepEqual(await services.call(REFRESH,refreshInput),refreshed,'a retained acknowledgement replays');
 assert.deepEqual(await services.call(APPEND,appendInput),appended);
 const current=await services.call('timeline.get',{projectId:f.projectId});
 await assert.rejects(services.call(APPEND,f.request(current)),code('RESTORE_OPERATION_UNAVAILABLE'));
 await assert.rejects(services.call(REFRESH,f.request(current,{clipIds:[clip.id]})),code('RESTORE_OPERATION_UNAVAILABLE'));
});
