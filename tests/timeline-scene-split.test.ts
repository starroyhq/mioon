import type {ServiceResponse as FixtureServiceResult, TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {schemas,descriptions,operationEffect,isTimelineMutationResponse,hasRequestNotAppliedProof,TIMELINE_MUTATION_OPERATIONS,DURABLE_EDIT_OPERATIONS,
 TIMELINE_SCENE_SPLIT_OPERATION,TIMELINE_SCENE_SPLIT_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';
import type { BinaryLike } from 'crypto';

const SPLIT=TIMELINE_SCENE_SPLIT_OPERATION;
const digest=(bytes: BinaryLike|Buffer<ArrayBuffer>)=>createHash('sha256').update(bytes).digest('hex');
const code=(expected: string,check: ((arg0?: unknown) => unknown)|undefined=()=>true)=>(error?: Error&{ code: string; status?: number; details?: { mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];[key: string]: unknown; }; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; })=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code===expected&&check(error);
const writes=['timelines','timeline_history','timeline_history_cursors','timeline_requests'];

async function fixture(t: test.TestContext,cuts: number[]|undefined=[45,100,230,280]){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-scene-split-')));
 let detected=cuts;
 const store=(openStore(root) as FixtureStore),services=(createServices(store,new Map(),{sceneOptions:{detect:((async (input: { beforeSpawn:(signal?:unknown)=>void; signal: unknown; options: unknown; asset: { sha256: unknown; }; })=>{(input.beforeSpawn)!(((input.signal) as unknown as Parameters<typeof input.beforeSpawn>[0]));
  return {profileId:'scene-cuts-v1',fps:30,frameCount:300,options:input.options,cuts:detected.map(frame=>({frame,score:0.4})),segments:[],sourceHash:input.asset.sha256,analysis:{width:256,height:144,decodedFrames:300}};}) as unknown as ((options: import("@mioon/business/scene-detection-decoder").DetectManagedScenesOptions) => Promise<import("@mioon/business/scene-detection-decoder").ManagedSceneDetection>) | undefined)}}) as FixtureServices);
 const _strictFixtureBase={root,store,call:<O extends string>(op: O, input?: unknown) => services.call(op,input) as Promise<FixtureServiceResult<O>>,
  capture:()=>Object.fromEntries(writes.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  video(){
   const bytes=Buffer.from(`Reference film ${randomUUID()}`),id=randomUUID(),relativePath=`media/${id}.mp4`;writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
   return store.put('assets',{id,projectId:f.projectId,name:'Reference.mp4',mimeType:'video/mp4',sha256:digest(bytes),sizeBytes:bytes.length,relativePath,width:720,height:1280,duration:10,hasVideo:true,hasAudio:true,provenance:'user-import'});
  },
  async detect(asset: { id: unknown; projectId?: unknown; name?: string; mimeType?: string; sha256: unknown; sizeBytes?: number; relativePath?: string; width?: number; height?: number; duration?: number; hasVideo?: boolean; hasAudio?: boolean; provenance?: string; },next?: number[]|undefined){
   if(next)detected=next;
   const ack=await f.call('scene.detect',{projectId:f.projectId,sourceAssetId:asset.id,sourceHash:asset.sha256,requestId:randomUUID()});
   for(let tries=0;tries<2000;tries++){const value=await f.call('scene.task.get',{projectId:f.projectId,taskId:ack.id});if(value.state==='succeeded')return (value as Extract<typeof value,{result:unknown}>).result!.id;await pause(5);}
   assert.fail('detection did not finish');
  },
  timeline:()=>f.call('timeline.get',{projectId:f.projectId}),
  async add(asset: { id: unknown; projectId?: unknown; name?: string; mimeType?: string; sha256?: string; sizeBytes?: number; relativePath?: string; width?: number; height?: number; duration?: number; hasVideo?: boolean; hasAudio?: boolean; provenance?: string; },patch: Record<string, unknown>={}){
   const timeline=await f.timeline();
   const next=await f.call('timeline.clip.add',{projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,
    trackId:(timeline.tracks.find((track)=>track.kind==='video'))!.id,startFrame:0,durationFrames:60,...patch});
   return next.clips.at(-1);
  },
  request:<P extends Record<string,unknown>=Record<never,never>>(timeline: { revision: number; },extra?: P):P & {projectId:string;expectedRevision:number;requestId:string}=>({projectId:f.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...(extra as P)}),
 };
 const f = _strictFixtureBase as typeof _strictFixtureBase & {projectId: string};
 f.projectId=(await f.call('project.create',{name:t.name.slice(0,150)})).id;
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}

test('the split is registered, described, effect-annotated, restore-denied and localized', ()=>{
 assert.ok(schemas[SPLIT]&&descriptions[SPLIT].length>40);
 assert.ok(TIMELINE_MUTATION_OPERATIONS.includes(SPLIT));assert.ok(!DURABLE_EDIT_OPERATIONS.includes(SPLIT));
 assert.ok(RESTORE_DENIED_OPERATIONS.includes(SPLIT));assert.equal(TIMELINE_SCENE_SPLIT_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES+64*1024);
 const effect=operationEffect(SPLIT);
 assert.deepEqual([effect.readOnly,effect.idempotent,effect.destructive,effect.paidGeneration,effect.externalIO],[false,true,true,false,false]);
 assert.equal(translate('zh-Hans',`operation.${SPLIT}`),descriptions[SPLIT]);
 for(const locale of (['zh-Hant','en','ja'] as const))assert.ok(translate(locale,`operation.${SPLIT}`).length>40);
});

test('every clip of the video splits at its in-range cuts in one undoable edit', async t=>{
 const f=await fixture(t),film=await f.video(),other=await f.video();
 const a=await f.add(film,{startFrame:0,durationFrames:120,sourceInFrame:0}),b=await f.add(film,{startFrame:150,durationFrames:60,sourceInFrame:200});
 const keep=await f.add(other,{startFrame:300,durationFrames:60});
 const resultId=await f.detect(film),before=await f.timeline();
 const input=f.request(before,{assetId:film.id,resultId}),response=await f.call(SPLIT,input);
 assert.ok(isTimelineMutationResponse(SPLIT,input,response));
 assert.deepEqual(response.split.map((row)=>[row.clipId,row.cutFrames,row.fadeCutFrames,row.clipIds.length]),[[(a)!.id,[45,100],[],3],[(b)!.id,[230],[],2]]);
 assert.deepEqual((response.skipped as unknown),[]);
 const clips=new Map(response.timeline.clips.map((clip)=>[clip.id,clip]));
 assert.deepEqual(response.split[0].clipIds.map((id?)=>[(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.startFrame,(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.durationFrames,(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.sourceInFrame]),[[0,45,0],[45,55,45],[100,20,100]]);
 assert.deepEqual(response.split[1].clipIds.map((id?)=>[(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.startFrame,(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.durationFrames,(clips.get(((id) as unknown as Parameters<NonNullable<(typeof clips)["get"]>>[0])))!.sourceInFrame]),[[150,30,200],[180,30,230]]);
 assert.deepEqual(clips.get((keep)!.id),before.clips.find((clip)=>clip.id===(keep)!.id),'other sources are untouched');
 assert.equal(response.timeline.revision,before.revision+1);
 const history=await f.call('timeline.history.get',{projectId:f.projectId});assert.equal((history.undoEntry)!.operation,SPLIT);
 assert.deepEqual(await f.call(SPLIT,input),response,'exact replay');
 const undone=await f.call('timeline.undo',{projectId:f.projectId,expectedRevision:response.timeline.revision,requestId:randomUUID()});
 assert.deepEqual(undone.clips,before.clips,'one undo restores every clip');
});

test('nothing to split, a superseded result and a stale result write nothing', async t=>{
 const f=await fixture(t),film=await f.video();
 const resultId=await f.detect(film),timeline=await f.timeline(),before=f.capture();
 const empty=f.request(timeline,{assetId:film.id,resultId});
 await assert.rejects(f.call(SPLIT,empty),code('NOTHING_TO_SPLIT',(((error?: unknown)=>hasRequestNotAppliedProof(error,empty,{operation:SPLIT})) as unknown as Parameters<typeof code>[1])));
 assert.deepEqual(f.capture(),before);
 await f.add(film,{startFrame:0,durationFrames:40,sourceInFrame:50});
 const current=await f.timeline(),inside=f.request(current,{assetId:film.id,resultId});
 await assert.rejects(f.call(SPLIT,inside),code('NOTHING_TO_SPLIT',(((error?: Error&{ code: string; status?: number; details?: { mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[];[key: string]: unknown; }; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; })=>(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.skipped)!.length===1&&(((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).details)!.skipped)![0].reason==='NO_CUT_IN_RANGE') as unknown as Parameters<typeof code>[1])));
 const newer=await f.detect(film,[60]),afterAdd=f.capture(),old=f.request(current,{assetId:film.id,resultId});
 await assert.rejects(f.call(SPLIT,old),code('SCENE_RESULT_CONFLICT',(((error?: unknown)=>hasRequestNotAppliedProof(error,old,{operation:SPLIT})) as unknown as Parameters<typeof code>[1])));
 f.store.put('assets',{...f.store.get('assets',film.id),sha256:'d'.repeat(64)});
 const stale=f.request(current,{assetId:film.id,resultId:newer});
 await assert.rejects(f.call(SPLIT,stale),code('SCENE_RESULT_STALE'));
 assert.deepEqual(f.capture(),afterAdd);
});

test('cuts inside audio fades are left out and reported', async t=>{
 const f=await fixture(t,[20,45,100]),film=await f.video();
 const faded=await f.add(film,{startFrame:0,durationFrames:120,sourceInFrame:0,fadeInFrames:30,fadeOutFrames:30}),edge=await f.add(film,{startFrame:200,durationFrames:40,sourceInFrame:0,fadeInFrames:30});
 const resultId=await f.detect(film),input=f.request(await f.timeline(),{assetId:film.id,resultId}),response=await f.call(SPLIT,input);
 assert.deepEqual(response.split,[{clipId:(faded)!.id,clipIds:response.split[0].clipIds,cutFrames:[45],fadeCutFrames:[20,100]}]);
 assert.deepEqual(response.skipped,[{clipId:(edge)!.id,reason:'FADE_BOUNDS',cutFrames:[20]}]);
 const [left,right]=response.split[0].clipIds.map((id?)=>response.timeline.clips.find((clip)=>clip.id===id));
 assert.deepEqual([(left)!.fadeInFrames,(left)!.fadeOutFrames,(right)!.fadeInFrames,(right)!.fadeOutFrames],[30,0,0,30],'outer fades stay at the outer edges');
});

test('splitting past the timeline clip limit is refused with a proof', async t=>{
 const f=await fixture(t,Array.from({length:120},(_,index)=>index+1)),film=await f.video();
 await f.add(film,{startFrame:0,durationFrames:150,sourceInFrame:0});
 const resultId=await f.detect(film),input=f.request(await f.timeline(),{assetId:film.id,resultId}),before=f.capture();
 await assert.rejects(f.call(SPLIT,input),code('TIMELINE_LIMIT',(((error?: unknown)=>hasRequestNotAppliedProof(error,input,{operation:SPLIT})) as unknown as Parameters<typeof code>[1])));
 assert.deepEqual(f.capture(),before);
});
