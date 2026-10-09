import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const domain = timeline => clone({tracks:timeline.tracks, clips:timeline.clips, durationFrames:timeline.durationFrames});
const unrelated = ['projects','assets','shots','nodes','edges','jobs','versions','exports'];
async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-history-'));
 let store=openStore(root), services=createServices(store,new Map());
 const f={root,get store(){return store;}, call:(operation,input)=>services.call(operation,input),
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());},
  asset(projectId,mimeType='image/png') {const id=randomUUID();return store.put('assets',{id,projectId,name:'Local synthetic fixture',mimeType,duration:2,width:720,height:1280,sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`});},
  capture(){return Object.fromEntries(unrelated.map(table=>[table,clone(store.list(table))]));},
  state(projectId){return {timeline:store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId),history:store.db.prepare('SELECT * FROM timeline_history WHERE projectId=? ORDER BY position').all(projectId),cursor:store.db.prepare('SELECT * FROM timeline_history_cursors WHERE projectId=?').get(projectId),requests:store.db.prepare('SELECT * FROM timeline_requests ORDER BY requestId').all()};}
 };
 f.projectId=(await f.call('project.create',{name:t.name})).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const input=(projectId,timeline,fields={})=>({projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
async function rejectAtomic(f,operation,params,code) {
 const before=f.state(params.projectId);
 await assert.rejects(f.call(operation,params),error=>error.code===code);
 assert.deepEqual(f.state(params.projectId),before,`${code} must not change state, cursor, branch or durable responses`);
}

test('history reads and unavailable undo/redo never initialize a timeline or journal',async t=>{
 const f=await fixture(t),projectId=f.projectId,before=f.state(projectId);
 const expected={projectId,timelineId:null,revision:null,cursor:0,length:0,canUndo:false,canRedo:false,undoEntry:null,redoEntry:null};
 assert.deepEqual(await f.call('timeline.history.get',{projectId}),expected);
 assert.deepEqual(f.state(projectId),before);
 for(const operation of ['undo','redo'])await rejectAtomic(f,`timeline.${operation}`,{projectId,expectedRevision:1,requestId:randomUUID()},`NOTHING_TO_${operation.toUpperCase()}`);
 f.restart();assert.deepEqual(await f.call('timeline.history.get',{projectId}),expected);
 const timeline=await f.call('timeline.get',{projectId});
 assert.deepEqual(await f.call('timeline.history.get',{projectId}),{...expected,timelineId:timeline.id,revision:1});
 for(const operation of ['undo','redo'])await rejectAtomic(f,`timeline.${operation}`,input(projectId,timeline),`NOTHING_TO_${operation.toUpperCase()}`);
 await assert.rejects(f.call('timeline.history.get',{projectId:randomUUID()}),{code:'NOT_FOUND'});
});

test('every track and clip edit round-trips complete domain snapshots with stable IDs and monotonic revisions',async t=>{
 const f=await fixture(t),projectId=f.projectId,asset=f.asset(projectId,'video/mp4');
 let timeline=await f.call('timeline.get',{projectId}),revision=timeline.revision;
 const original=clone(timeline),snapshots=[domain(timeline)],requests=[];
 async function edit(operation,fields){const params=input(projectId,timeline,fields);timeline=await f.call(operation,params);assert.equal(timeline.revision,++revision);snapshots.push(domain(timeline));requests.push({operation,params,response:clone(timeline)});}
 await edit('timeline.track.add',{kind:'video',name:'Overlay'});
 const lane=timeline.tracks.at(-1).id;
 await edit('timeline.track.update',{trackId:lane,patch:{name:'Foreground',hidden:true,muted:true}});
 await edit('timeline.clip.add',{trackId:lane,assetId:asset.id,startFrame:10,durationFrames:40});
 const clipId=timeline.clips[0].id;
 await edit('timeline.clip.update',{clipId,patch:{trackId:timeline.tracks[0].id,startFrame:20,sourceInFrame:5,durationFrames:30,gain:.5,rect:{x:100,y:200,width:300,height:400},name:'Trimmed'}});
 await edit('timeline.clip.remove',{clipId});
 const outside=f.capture();
 const entries=f.store.db.prepare('SELECT * FROM timeline_history WHERE projectId=? ORDER BY position').all(projectId);
 assert.equal(entries.length,5);
 for(const [index,entry] of entries.entries()){
  assert.deepEqual(Object.keys(JSON.parse(entry.beforeSnapshot)).sort(),['clips','durationFrames','tracks']);
  assert.deepEqual(JSON.parse(entry.beforeSnapshot),snapshots[index]);assert.deepEqual(JSON.parse(entry.afterSnapshot),snapshots[index+1]);
 }
 assert.throws(()=>f.store.db.prepare('UPDATE timeline_history SET operation=? WHERE id=?').run('changed',entries[0].id),/immutable/);
 for(let index=4;index>=0;index--){
  const history=await f.call('timeline.history.get',{projectId});assert.equal(history.undoEntry.id,entries[index].id);
  timeline=await f.call('timeline.undo',input(projectId,timeline));assert.equal(timeline.revision,++revision);assert.deepEqual(domain(timeline),snapshots[index]);
  assert.equal(timeline.id,original.id);assert.equal(timeline.createdAt,original.createdAt);assert.equal(timeline.fps,original.fps);assert.equal(timeline.width,720);assert.equal(timeline.height,1280);
 }
 await rejectAtomic(f,'timeline.undo',input(projectId,timeline),'NOTHING_TO_UNDO');
 f.restart();
 for(let index=0;index<5;index++){
  const history=await f.call('timeline.history.get',{projectId});assert.equal(history.redoEntry.id,entries[index].id);
  timeline=await f.call('timeline.redo',input(projectId,timeline));assert.equal(timeline.revision,++revision);assert.deepEqual(domain(timeline),snapshots[index+1]);
 }
 await rejectAtomic(f,'timeline.redo',input(projectId,timeline),'NOTHING_TO_REDO');
 assert.deepEqual(f.capture(),outside,'history cannot rewrite assets, projects, jobs, versions, exports or shots');
 for(const request of requests)assert.deepEqual(await f.call(request.operation,request.params),request.response);
 assert.deepEqual((await f.call('project.get',{projectId})).timelineHistory,await f.call('timeline.history.get',{projectId}));
});

test('seed undo/redo retains its frozen asset references and does not reverse selections, jobs, exports or spending',async t=>{
 const f=await fixture(t),projectId=f.projectId,assets=[f.asset(projectId,'video/mp4'),f.asset(projectId,'video/mp4')];
 const shot=await f.call('shot.create',{projectId,title:'Selected story'}),versions=[];
 for(const [index,asset] of assets.entries()){
  const jobId=randomUUID(),versionId=randomUUID();
  f.store.put('jobs',{id:jobId,projectId,shotId:shot.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),submissionCount:1,versionId});
  versions.push(f.store.put('versions',{id:versionId,projectId,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:index+1}));
 }
 let selected=await f.call('version.select',{shotId:shot.id,versionId:versions[0].id,expectedRevision:shot.revision});
 let timeline=await f.call('timeline.get',{projectId});
 timeline=await f.call('timeline.seed',input(projectId,timeline));const seeded=domain(timeline);
 const previewInput=input(projectId,timeline,{purpose:'preview'}),preview=await f.call('timeline.render',previewInput);
 await f.call('version.select',{shotId:shot.id,versionId:versions[1].id,expectedRevision:selected.revision});
 const outside=f.capture();
 timeline=await f.call('timeline.undo',input(projectId,timeline));assert.deepEqual(timeline.clips,[]);
 f.restart();timeline=await f.call('timeline.redo',input(projectId,timeline));assert.deepEqual(domain(timeline),seeded);
 assert.equal(timeline.clips[0].assetId,assets[0].id);
 assert.deepEqual(f.capture(),outside);assert.deepEqual(await f.call('timeline.render',previewInput),preview);
 assert.equal((await f.call('timeline.history.get',{projectId})).length,1,'render is not an undoable edit');
});

test('new edits discard redo, while old edit/undo/redo requests replay exactly after branching and restart',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 const editInput=input(projectId,timeline,{kind:'video'}),edit=await f.call('timeline.track.add',editInput);timeline=edit;
 const undoInput=input(projectId,timeline),undo=await f.call('timeline.undo',undoInput);timeline=undo;
 const redoInput=input(projectId,timeline),redo=await f.call('timeline.redo',redoInput);timeline=redo;
 timeline=await f.call('timeline.undo',input(projectId,timeline));
 const before=await f.call('timeline.history.get',{projectId});assert.equal(before.canRedo,true);
 await rejectAtomic(f,'timeline.track.update',input(projectId,timeline,{trackId:randomUUID(),patch:{name:'Invalid'}}),'TRACK_NOT_FOUND');
 await rejectAtomic(f,'timeline.track.add',input(projectId,{revision:timeline.revision-1},{kind:'audio'}),'REVISION_CONFLICT');
 timeline=await f.call('timeline.track.update',input(projectId,timeline,{trackId:timeline.tracks[0].id,patch:{name:'New branch'}}));
 const history=await f.call('timeline.history.get',{projectId});assert.equal(history.length,1);assert.equal(history.cursor,1);assert.equal(history.canRedo,false);assert.notEqual(history.undoEntry.id,before.redoEntry.id);
 const latest=clone(timeline),latestHistory=clone(history);f.restart();
 for(const [operation,params,response] of [['timeline.track.add',editInput,edit],['timeline.undo',undoInput,undo],['timeline.redo',redoInput,redo]])assert.deepEqual(await f.call(operation,params),response);
 assert.deepEqual(await f.call('timeline.get',{projectId}),latest);assert.deepEqual(await f.call('timeline.history.get',{projectId}),latestHistory);
 await rejectAtomic(f,'timeline.undo',{...undoInput,expectedRevision:latest.revision},'IDEMPOTENCY_CONFLICT');
 await rejectAtomic(f,'timeline.redo',undoInput,'IDEMPOTENCY_CONFLICT');
 await rejectAtomic(f,'timeline.redo',input(projectId,latest),'NOTHING_TO_REDO');
});

test('history duplicates apply once and competing fresh revisions conflict atomically in both directions',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 for(let i=0;i<3;i++)timeline=await f.call('timeline.track.update',input(projectId,timeline,{trackId:timeline.tracks[0].id,patch:{name:`Step ${i}`}}));
 for(const operation of ['timeline.undo','timeline.redo']){
  const params=input(projectId,timeline),responses=await Promise.all(Array.from({length:12},()=>f.call(operation,params)));
  responses.forEach(response=>assert.deepEqual(response,responses[0]));assert.equal(responses[0].revision,timeline.revision+1);timeline=responses[0];
 }
 const params=input(projectId,timeline),results=await Promise.allSettled(Array.from({length:12},()=>f.call('timeline.undo',{...params,requestId:randomUUID()})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);results.filter(r=>r.status==='rejected').forEach(r=>assert.equal(r.reason.code,'REVISION_CONFLICT'));
 timeline=await f.call('timeline.get',{projectId});assert.equal((await f.call('timeline.history.get',{projectId})).cursor,2);
 await rejectAtomic(f,'timeline.redo',params,'REVISION_CONFLICT');
});

test('independent SQLite connections serialize duplicate undo requests without double traversal',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 for(let i=0;i<2;i++)timeline=await f.call('timeline.track.update',input(projectId,timeline,{trackId:timeline.tracks[0].id,patch:{name:`Step ${i}`}}));
 const params=input(projectId,timeline);
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});try{parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({result:await createServices(store,new Map()).call('timeline.undo',workerData.input)});}catch(error){parentPort.postMessage({error:error.code||error.message});}finally{store.close();}});}catch(error){store.close();throw error;}})();`;
 const workers=Array.from({length:4},()=>new Worker(source,{eval:true,workerData:{root:f.root,input:params,db:new URL('../packages/business/src/db.mjs',import.meta.url).href,services:new URL('../packages/business/src/services.mjs',import.meta.url).href}}));
 t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
 await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));
 const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach(worker=>worker.postMessage('go'));
 const responses=await Promise.all(results);responses.forEach(response=>{assert.ok(!response.error,response.error);assert.deepEqual(response.result,responses[0].result);});
 assert.equal(responses[0].result.revision,timeline.revision+1);assert.equal((await f.call('timeline.history.get',{projectId})).cursor,1);
});

test('failed durable-response commit rolls back snapshots, branch removal, cursor and timeline together',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 timeline=await f.call('timeline.track.add',input(projectId,timeline,{kind:'audio'}));
 timeline=await f.call('timeline.undo',input(projectId,timeline));
 f.store.db.exec("CREATE TRIGGER fail_history_response BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'injected response failure');END;");
 for(const [operation,fields] of [['timeline.redo',{}],['timeline.track.add',{kind:'video'}]]){
  const before=f.state(projectId);await assert.rejects(f.call(operation,input(projectId,timeline,fields)),/injected response failure/);assert.deepEqual(f.state(projectId),before);
 }
 f.store.db.exec('DROP TRIGGER fail_history_response');
 timeline=await f.call('timeline.redo',input(projectId,timeline));assert.equal(timeline.tracks.length,4);
});

test('additive migration preserves legacy timeline and response bytes, using legacy state as first undo baseline',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 const params=input(projectId,timeline,{kind:'audio',name:'Legacy audio'});timeline=await f.call('timeline.track.add',params);
 const before=f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId).data;
 const responses=f.store.db.prepare('SELECT * FROM timeline_requests').all(),outside=f.capture();
 f.store.db.exec('DROP TABLE timeline_history; DROP TABLE timeline_history_cursors; DELETE FROM schema_version WHERE version=3;');f.restart();
 assert.equal(f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId).data,before);assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_requests').all(),responses);assert.deepEqual(f.capture(),outside);
 assert.equal((await f.call('timeline.history.get',{projectId})).length,0);assert.deepEqual(await f.call('timeline.track.add',params),timeline);
 const baseline=domain(timeline);timeline=await f.call('timeline.track.update',input(projectId,timeline,{trackId:timeline.tracks[0].id,patch:{name:'After migration'}}));
 f.restart();timeline=await f.call('timeline.undo',input(projectId,timeline));assert.deepEqual(domain(timeline),baseline);assert.deepEqual(f.capture(),outside);
 assert.equal(f.store.db.prepare('SELECT max(version) AS version FROM schema_version').get().version,3);
});

test('project history, cursor, request identities and state remain isolated',async t=>{
 const f=await fixture(t),first=f.projectId,second=(await f.call('project.create',{name:'Other project'})).id;
 let a=await f.call('timeline.get',{projectId:first}),b=await f.call('timeline.get',{projectId:second});
 a=await f.call('timeline.track.add',input(first,a,{kind:'video'}));b=await f.call('timeline.track.add',input(second,b,{kind:'audio'}));
 const untouched=f.state(second),params=input(first,a);a=await f.call('timeline.undo',params);
 assert.deepEqual(f.state(second).timeline,untouched.timeline);assert.deepEqual(f.state(second).history,untouched.history);assert.deepEqual(f.state(second).cursor,untouched.cursor);
 await rejectAtomic(f,'timeline.undo',{...params,projectId:second,expectedRevision:b.revision},'IDEMPOTENCY_CONFLICT');
 assert.equal((await f.call('timeline.history.get',{projectId:first})).cursor,0);assert.equal((await f.call('timeline.history.get',{projectId:second})).cursor,1);
 b=await f.call('timeline.undo',input(second,b));assert.equal(b.tracks.length,3);assert.equal(a.tracks.length,3);
});

test('history metadata and project snapshots stay coherent during independent SQLite undo/redo writes',async t=>{
 const f=await fixture(t),projectId=f.projectId;let timeline=await f.call('timeline.get',{projectId});
 timeline=await f.call('timeline.track.add',input(projectId,timeline,{kind:'audio'}));
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});const services=createServices(store,new Map());try{parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{let timeline=await services.call('timeline.get',{projectId:workerData.projectId});for(let i=0;i<120;i++){timeline=await services.call(i%2===0?'timeline.undo':'timeline.redo',{projectId:workerData.projectId,expectedRevision:timeline.revision,requestId:'snapshot-race-'+i});}parentPort.postMessage({done:true});}catch(error){parentPort.postMessage({error:error.code||error.message});}finally{store.close();}});}catch(error){store.close();throw error;}})();`;
 const worker=new Worker(source,{eval:true,workerData:{root:f.root,projectId,db:new URL('../packages/business/src/db.mjs',import.meta.url).href,services:new URL('../packages/business/src/services.mjs',import.meta.url).href}});
 t.after(()=>worker.terminate());await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
 const done=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.postMessage('go');
 for(let index=0;index<160;index++){
  const history=await f.call('timeline.history.get',{projectId});
  assert.equal(history.cursor,history.revision%2===0?1:0);assert.equal(history.length,1);
  assert.equal(history.canUndo,history.cursor===1);assert.equal(history.canRedo,history.cursor===0);
  assert.equal(Boolean(history.undoEntry),history.canUndo);assert.equal(Boolean(history.redoEntry),history.canRedo);
  const project=await f.call('project.get',{projectId});assert.equal(project.timeline.revision,project.timelineHistory.revision);
  assert.equal(project.timeline.tracks.length,3+project.timelineHistory.cursor);
 }
 const result=await done;assert.ok(!result.error,result.error);assert.equal((await f.call('timeline.get',{projectId})).revision,122);
});
