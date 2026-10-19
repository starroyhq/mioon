import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {prepareTimelineInputs} from '../packages/business/src/timeline-sources.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {isEditTaskEnvelope,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256} from '@mioon/contracts';
const at='2026-10-11T12:00:00.000Z',clone=value=>structuredClone(value);
const tables=['projects','timelines','assets','shots','jobs','versions','exports','timeline_requests','timeline_history','timeline_history_cursors','edit_tasks'];
async function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-subtitles-recovery-'));let store=openStore(root),services=createServices(store,new Map()),tasks,fault=()=>{},calls=0;
 const start=()=>{tasks=createEditTasks({store,services:{call(operation,input){calls++;return services.call(operation,input);}},fault:point=>fault(point)});};start();
 const f={root,get store(){return store;},get tasks(){return tasks;},get calls(){return calls;},call:(operation,input)=>services.call(operation,input),setFault(fn){fault=fn;},
 restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},capture:()=>JSON.stringify(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
 prepare:(operation,input)=>tasks.prepare({projectId:f.projectId,operation,input,origin:'new'}),execute:envelope=>tasks.execute({projectId:f.projectId,taskId:envelope.task.id,digest:envelope.task.digest,instanceId:envelope.instanceId}),
 ack:task=>tasks.acknowledge({projectId:f.projectId,taskId:task.id,digest:task.digest,expectedRevision:task.revision,status:task.status}),
 asset(){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Fixture',mimeType:'video/mp4',duration:20,width:720,height:1280,hasAudio:true,hasVideo:true,sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,provenance:'user-import',createdAt:at});}};
 f.projectId=(await f.call('project.create',{name:'Subtitle recovery'})).id;t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return f;
}
const request=(f,timeline,fields={})=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
async function populated(f){const timeline=await f.call('timeline.get',{projectId:f.projectId}),asset=f.asset();return f.call('timeline.clip.add',request(f,timeline,{assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:300}));}
async function added(f){const timeline=await populated(f),input=request(f,timeline,{text:'历史字幕',startFrame:0,durationFrames:30}),result=await f.call('timeline.subtitle.add',input);return {timeline:result,input};}

test('all three durable subtitle operations use the existing lane, immutable identity and complete result',async t=>{
 const f=await fixture(t);let timeline=await populated(f),cueId;const definitions=[['timeline.subtitle.add',()=>({text:'one',startFrame:0,durationFrames:30})],['timeline.subtitle.update',()=>({cueId,patch:{text:'two'}})],['timeline.subtitle.remove',()=>({cueId})]];
 for(const [operation,fields] of definitions){const input=request(f,timeline,fields()),prepared=f.prepare(operation,input);assert.equal(prepared.task.lane,'timeline:mutation');assert.ok(isEditTaskEnvelope(prepared));assert.deepEqual(prepared.task.input,input);
  const applied=await f.execute(prepared);assert.ok(isEditTaskEnvelope(applied));assert.equal(applied.task.status,'applied');assert.equal(applied.task.requestId,input.requestId);timeline=applied.result;cueId=timeline.subtitles.cues[0]?.id??cueId;f.ack(applied.task);
 }
 assert.equal(f.calls,3);assert.equal(f.tasks.list({projectId:f.projectId}).items.length,0);assert.equal(f.tasks.list({projectId:f.projectId,pendingOnly:false}).items.length,3);
});

for(const point of ['afterClaim','beforeDispatch','afterBusinessCommit','beforeOutcomePersist','afterOutcomePersist'])test(`durable subtitle restart at ${point} retains exact input and never auto-dispatches`,async t=>{
 const f=await fixture(t),timeline=await populated(f),input=request(f,timeline,{text:'恢复原始输入\n100% {}',startFrame:1,durationFrames:30}),prepared=f.prepare('timeline.subtitle.add',input);
 const raw=f.store.db.prepare('SELECT input FROM edit_tasks WHERE id=?').get(prepared.task.id).input;
 f.setFault(label=>{if(label===point)throw Error('injected crash');});await assert.rejects(f.execute(prepared),error=>error.code==='EDIT_TASK_STORAGE_UNAVAILABLE');f.setFault(()=>{});f.restart();
 const before=f.calls;f.tasks.reconcileStartup();assert.equal(f.calls,before);const recovered=f.tasks.get({projectId:f.projectId,taskId:prepared.task.id});
 const committed=!['afterClaim','beforeDispatch'].includes(point);assert.equal(recovered.task.status,committed?'applied':'unknown');assert.deepEqual(recovered.task.input,input);
 await assert.rejects(f.execute(prepared),error=>error.code==='EDIT_TASK_STALE_INSTANCE');const applied=await f.execute(recovered);assert.equal(applied.task.status,'applied');assert.equal(f.calls,before+(committed?0:1));assert.equal(applied.result.subtitles.cues.length,1);
 assert.equal(f.store.db.prepare('SELECT input FROM edit_tasks WHERE id=?').get(prepared.task.id).input,raw);assert.equal(f.store.db.prepare('SELECT count(*) n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,1);
});

test('definitive subtitle rejection retains task terminal state and original key until explicit acknowledgement',async t=>{
 const f=await fixture(t),timeline=await populated(f),input=request(f,timeline,{text:'outside',startFrame:299,durationFrames:2}),prepared=f.prepare('timeline.subtitle.add',input);
 const applied=await f.execute(prepared);assert.equal(applied.task.status,'not_applied');assert.equal(applied.task.errorCode,'SUBTITLE_BOUNDS');assert.equal(Object.hasOwn(applied,'result'),false);assert.deepEqual(applied.task.input,input);
 f.restart();assert.equal(f.tasks.get({projectId:f.projectId,taskId:prepared.task.id}).task.status,'not_applied');assert.throws(()=>f.prepare('timeline.subtitle.add',{...input,requestId:randomUUID(),durationFrames:1}),error=>error.code==='EDIT_TASK_CONFLICT');
 f.ack(applied.task);const next=f.prepare('timeline.subtitle.add',{...input,requestId:randomUUID(),durationFrames:1});assert.equal((await f.execute(next)).task.status,'applied');
});

test('independent connections race under the one shared timeline revision fence',async t=>{
 const f=await fixture(t),timeline=await populated(f),reader=openStore(f.root,{lock:false});t.after(()=>reader.close());const second=createServices(reader,new Map());
 const first=request(f,timeline,{text:'one',startFrame:0,durationFrames:30}),other=request(f,timeline,{text:'two',startFrame:30,durationFrames:30});
 const outcomes=await Promise.allSettled([f.call('timeline.subtitle.add',first),second.call('timeline.subtitle.add',other)]);assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
 assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'REVISION_CONFLICT');assert.equal((await f.call('timeline.get',{projectId:f.projectId})).subtitles.cues.length,1);
});

for(const mutation of ['unknown profile','duplicate cue','unsupported scalar','out of bounds','extra cue field'])test(`corrupt persisted subtitle ${mutation} denies edits and replay without writes`,async t=>{
 const f=await fixture(t),{timeline,input}=await added(f),bad=clone(timeline);
 if(mutation==='unknown profile')bad.subtitles.profileId='untrusted';if(mutation==='duplicate cue')bad.subtitles.cues.push(clone(bad.subtitles.cues[0]));if(mutation==='unsupported scalar')bad.subtitles.cues[0].text='😀';if(mutation==='out of bounds')bad.subtitles.cues[0].startFrame=300;if(mutation==='extra cue field')bad.subtitles.cues[0].fontFile='/PRIVATE';
 f.store.put('timelines',bad);const before=f.capture();for(const [operation,params] of [['timeline.subtitle.add',input],['timeline.subtitle.remove',request(f,bad,{cueId:bad.subtitles.cues[0].id})]])await assert.rejects(f.call(operation,params),error=>error.code==='INVALID_TIMELINE_SNAPSHOT'&&error.details?.mutationOutcome===undefined);assert.equal(f.capture(),before);
});

test('historical subtitle receipt corruption and historical snapshot corruption fail without repair or media work',async t=>{
 const f=await fixture(t),{timeline,input}=await added(f),events=[],stop=onMediaProcess(event=>events.push(event));t.after(stop);
 // Simulate out-of-band disk corruption only after proving production guards exist.
 assert.throws(()=>f.store.db.exec("UPDATE timeline_requests SET response=response"),/immutable/);
 f.store.db.exec('DROP TRIGGER immutable_timeline_responses; DROP TRIGGER immutable_timeline_history;');
 const receipt=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId).response;const bad=JSON.parse(receipt);bad.subtitles.cues[0].text='different';f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(JSON.stringify(bad),input.requestId);
 let before=f.capture();await assert.rejects(f.call('timeline.subtitle.add',input),error=>error.code==='INVALID_TIMELINE_SNAPSHOT');assert.equal(f.capture(),before);
 f.store.db.prepare('UPDATE timeline_requests SET response=? WHERE requestId=?').run(receipt,input.requestId);
 const entry=f.store.db.prepare('SELECT * FROM timeline_history WHERE projectId=? AND position=2').get(f.projectId),history=JSON.parse(entry.beforeSnapshot);history.subtitles={profileId:'bad',cues:[]};f.store.db.prepare('UPDATE timeline_history SET beforeSnapshot=? WHERE id=?').run(JSON.stringify(history),entry.id);
 before=f.capture();await assert.rejects(f.call('timeline.undo',request(f,timeline)),error=>error.code==='INVALID_TIMELINE_SNAPSHOT');assert.equal(f.capture(),before);assert.deepEqual(events,[]);
});

test('invalid frozen subtitle profile and unsupported text fail before source reads, hashing, probing or process spawn',async()=>{
 const projectId=randomUUID(),assetId=randomUUID(),trackId=randomUUID(),timeline={id:randomUUID(),projectId,revision:1,fps:30,width:720,height:1280,createdAt:at,updatedAt:at,durationFrames:30,
 tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[{id:randomUUID(),trackId,assetId,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],
 subtitles:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[{id:randomUUID(),text:'字幕',startFrame:0,durationFrames:30}]}};
 const original={timeline,subtitleProfile:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256},assets:[{id:assetId,sha256:'a'.repeat(64),mimeType:'video/mp4',duration:1,hasAudio:true}]};
 for(const kind of ['missing','hash','extra','text','unwanted']){const snapshot=clone(original);if(kind==='missing')delete snapshot.subtitleProfile;if(kind==='hash')snapshot.subtitleProfile.fontSha256='0'.repeat(64);if(kind==='extra')snapshot.subtitleProfile.path='/PRIVATE';if(kind==='text')snapshot.timeline.subtitles.cues[0].text='🦋';if(kind==='unwanted')snapshot.timeline.subtitles.cues=[];
  let reads=0,probes=0;await assert.rejects(prepareTimelineInputs(snapshot,{projectId,root:'/unused',readAsset:()=>{reads++;throw Error('should never read');},probe:()=>{probes++;throw Error('should never probe');}}),error=>error.code==='INVALID_TIMELINE_SNAPSHOT');assert.equal(reads,0);assert.equal(probes,0);
 }
});
