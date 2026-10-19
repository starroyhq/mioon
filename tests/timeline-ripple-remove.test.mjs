import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {parse,isTimelineMutationResponse,operationEffect} from '../packages/contracts/src/index.mjs';

const operation='timeline.clip.rippleRemove';
const input=(timeline,fields={})=>({projectId:timeline.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});
const editable=timeline=>({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames,...(timeline.subtitles?{subtitles:timeline.subtitles}:{})});
async function fixture(t){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-ripple-domain-'));
 let store=openStore(root),services=createServices(store,new Map());
 const projectId=(await services.call('project.create',{name:t.name})).id;
 const assetId=randomUUID();store.put('assets',{id:assetId,projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,sha256:'a'.repeat(64),relativePath:`media/${assetId}.fixture`});
 const f={root,projectId,assetId,get store(){return store;},call:(op,args)=>services.call(op,args),restart(){store.close();store=openStore(root);services=createServices(store,new Map());},state(){return Object.fromEntries(['timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}};
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
async function add(f,timeline,track,start,duration){return f.call('timeline.clip.add',input(timeline,{assetId:f.assetId,trackId:track,startFrame:start,durationFrames:duration,name:`Clip ${start}`}));}

test('ripple contract is strict, shares the durable timeline lane and preserves ordinary remove schema',()=>{
 const value={projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),clipId:randomUUID()};
 assert.deepEqual(parse(operation,value),value);
 for(const invalid of [{...value,mode:'ripple'},{...value,expectedRevision:0},{...value,clipId:'invalid'}])assert.throws(()=>parse(operation,invalid),{code:'VALIDATION_ERROR'});
 assert.throws(()=>parse('timeline.clip.remove',{...value,mode:'ripple'}),{code:'VALIDATION_ERROR'});
 assert.equal(operationEffect(operation).databaseWrite,true);
});

test('ripple closes only the removed interval on its own track; one edit undoes/redoes and exactly replays across restart',async t=>{
 const f=await fixture(t);let timeline=await f.call('timeline.get',{projectId:f.projectId});
 const [lane,other]=timeline.tracks.filter(track=>track.kind==='video').map(track=>track.id);
 timeline=await add(f,timeline,lane,0,10);timeline=await add(f,timeline,lane,20,30);
 const removed=timeline.clips.at(-1).id;timeline=await add(f,timeline,lane,60,10);
 const shifted=timeline.clips.at(-1);timeline=await add(f,timeline,other,20,40);
 const before=editable(timeline),historyBefore=await f.call('timeline.history.get',{projectId:f.projectId});
 const request=input(timeline,{clipId:removed}),result=await f.call(operation,request);
 assert.ok(isTimelineMutationResponse(operation,request,result));
 assert.equal(result.clips.some(clip=>clip.id===removed),false);
 assert.deepEqual(result.clips.find(clip=>clip.id===shifted.id),{...shifted,startFrame:30});
 assert.deepEqual(result.clips.filter(clip=>clip.trackId===other),timeline.clips.filter(clip=>clip.trackId===other));
 assert.equal(result.durationFrames,60);
 const history=await f.call('timeline.history.get',{projectId:f.projectId});
 assert.equal(history.length,historyBefore.length+1);assert.equal(history.undoEntry.operation,operation);
 timeline=await f.call('timeline.undo',input(result));assert.deepEqual(editable(timeline),before);
 f.restart();timeline=await f.call('timeline.redo',input(timeline));assert.deepEqual(editable(timeline),editable(result));
 const current=f.state();assert.deepEqual(await f.call(operation,request),result);assert.deepEqual(f.state(),current);
 await assert.rejects(f.call(operation,{...request,clipId:shifted.id}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('last/only clip removal reaches an empty timeline and ordinary removal continues to leave a gap',async t=>{
 const f=await fixture(t);let timeline=await f.call('timeline.get',{projectId:f.projectId});const lane=timeline.tracks[0].id;
 timeline=await add(f,timeline,lane,0,10);timeline=await add(f,timeline,lane,20,10);
 const first=timeline.clips[0].id,last=timeline.clips[1].id;
 timeline=await f.call('timeline.clip.remove',input(timeline,{clipId:first}));assert.equal(timeline.clips[0].startFrame,20);
 timeline=await f.call(operation,input(timeline,{clipId:last}));assert.deepEqual(timeline.clips,[]);assert.equal(timeline.durationFrames,0);
 timeline=await f.call('timeline.undo',input(timeline));assert.equal(timeline.clips[0].startFrame,20);
});

test('shifted media retains source clocks, provenance, fades, audio role and relative volume automation',async t=>{
 const f=await fixture(t);let timeline=await f.call('timeline.get',{projectId:f.projectId});const lane=timeline.tracks[0].id;
 timeline=await add(f,timeline,lane,0,10);const removed=timeline.clips[0].id;
 const assetId=randomUUID();f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic video',mimeType:'video/mp4',duration:2,width:720,height:1280,hasAudio:true,sha256:'b'.repeat(64),relativePath:`media/${assetId}.fixture`});
 timeline=await f.call('timeline.clip.add',input(timeline,{trackId:lane,assetId,startFrame:20,durationFrames:10,sourceInFrame:5,gain:.5,fadeInFrames:2,fadeOutFrames:2,audioRole:'human',colour:null,
  volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:.5},{frame:9,multiplier:1}]}}));
 const retained=timeline.clips[1];timeline=await f.call(operation,input(timeline,{clipId:removed}));
 assert.deepEqual(timeline.clips,[{...retained,startFrame:10}]);
});

test('stale revisions, foreign clip IDs and out-of-bounds retained subtitles reject atomically',async t=>{
 const f=await fixture(t);let timeline=await f.call('timeline.get',{projectId:f.projectId});
 timeline=await add(f,timeline,timeline.tracks[0].id,0,60);const clipId=timeline.clips[0].id;
 timeline=await f.call('timeline.subtitle.add',input(timeline,{text:'Retained caption',startFrame:40,durationFrames:10}));
 for(const [fields,code]of [[{clipId,expectedRevision:1},'REVISION_CONFLICT'],[{clipId:randomUUID()},'CLIP_NOT_FOUND'],[{clipId},'SUBTITLE_BOUNDS']]){
  const before=f.state();await assert.rejects(f.call(operation,input(timeline,fields)),{code});assert.deepEqual(f.state(),before);
 }
});
