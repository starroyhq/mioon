import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {RESTORE_DENIED_OPERATIONS} from '../packages/business/src/workspace-restore-policy.ts';
import {AGENT_TASK_OPERATION_ADMISSION} from '../packages/business/src/agent/task-tools-v2.ts';
import {schemas,descriptions,operationEffect,isTimelineMutationResponse,hasRequestNotAppliedProof,TIMELINE_MUTATION_OPERATIONS,DURABLE_EDIT_OPERATIONS,
 TIMELINE_CROSSFADE_OPERATION,TIMELINE_CROSSFADE_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES,timelineCrossfadeOverlap} from '@mioon/contracts';
import {createVolumeEnvelopeEvaluator} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {translate} from '../packages/i18n/src/index.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';

const CROSSFADE=TIMELINE_CROSSFADE_OPERATION;
interface Clip {id: string;trackId: string;startFrame: number;durationFrames: number;volumeEnvelope?: unknown;fadeInFrames?: number;fadeOutFrames?: number}
interface Timeline {revision: number;tracks: {id: string;kind: string}[];clips: Clip[]}
interface Response {operation: string;requestId: string;timeline: Timeline;crossfade: {outgoingClipId: string;incomingClipId: string;startFrame: number;durationFrames: number}}
type Failure = Error & {code?: string;status?: number;details?: Record<string, unknown>};
type Request = {projectId: string;expectedRevision: number;requestId: string;outgoingClipId: string;incomingClipId: string};
const digest=(bytes: Buffer)=>createHash('sha256').update(bytes).digest('hex');
const writes=['timelines','timeline_history','timeline_history_cursors','timeline_requests'];

async function fixture(t: test.TestContext){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-crossfade-')));
 let store=openStore(root),services=createServices(store,new Map());
 const call=async <T,>(operation: string,input: unknown): Promise<T>=>await services.call(operation,input) as T;
 const project=await call<{id: string}>('project.create',{name:t.name.slice(0,150)});
 const f={root,projectId:project.id,call,
  get store(){return store;},
  capture:()=>Object.fromEntries(writes.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  timeline:()=>call<Timeline>('timeline.get',{projectId:project.id}),
  asset(kind: 'audio'|'video'|'silent'|'image'){
   const bytes=Buffer.from(`${kind} ${randomUUID()}`),id=randomUUID(),extension=kind==='audio'?'wav':kind==='image'?'png':'mp4',relativePath=`media/${id}.${extension}`;
   writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
   const media=kind==='audio'?{mimeType:'audio/wav',duration:20,hasAudio:true}:kind==='image'?{mimeType:'image/png',width:720,height:1280}:
    {mimeType:'video/mp4',duration:20,width:720,height:1280,hasVideo:true,hasAudio:kind==='video'};
   return store.put('assets',{id,projectId:project.id,name:`${kind}.${extension}`,sha256:digest(bytes),sizeBytes:bytes.length,relativePath,provenance:'user-import',...media}) as {id: string};
  },
  async track(kind: 'audio'|'video'){
   const timeline=await f.timeline();
   const next=await call<Timeline>('timeline.track.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind});
   return next.tracks.at(-1)!.id;
  },
  async add(asset: {id: string},trackId: string,startFrame: number,durationFrames: number,extra: Record<string, unknown>={}){
   const timeline=await f.timeline();
   const next=await call<Timeline>('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId,startFrame,durationFrames,...extra});
   return next.clips.at(-1)!;
  },
  request:(timeline: Timeline,outgoingClipId: string,incomingClipId: string): Request=>({projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),outgoingClipId,incomingClipId}),
  async reopen(){await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());},
  async close(){await services.drain();store.close();},
 };
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function audioPair(f: Fixture){
 const first=(await f.timeline()).tracks.find(track=>track.kind==='audio')!.id,second=await f.track('audio');
 const a=await f.add(f.asset('audio'),first,0,90),b=await f.add(f.asset('audio'),second,60,90);
 return {a,b,first,second};
}
async function rejects(f: Fixture,input: Request,code: string){
 const before=f.capture();
 await assert.rejects(f.call(CROSSFADE,input),(error: Failure)=>{
  assert.equal(error.code,code);
  assert.equal(hasRequestNotAppliedProof(error,input,{operation:CROSSFADE}),true,`${code} carries a not-applied proof`);
  return true;
 });
 assert.deepEqual(f.capture(),before,`${code} writes nothing`);
}

test('the crossfade is registered, described, effect-annotated, restore-denied, a reversible Mio tool and localized',()=>{
 assert.ok(schemas[CROSSFADE]&&descriptions[CROSSFADE].length>40);
 assert.ok(TIMELINE_MUTATION_OPERATIONS.includes(CROSSFADE));assert.ok(!DURABLE_EDIT_OPERATIONS.includes(CROSSFADE));
 assert.ok(RESTORE_DENIED_OPERATIONS.includes(CROSSFADE));assert.equal(TIMELINE_CROSSFADE_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES+1024);
 assert.deepEqual((AGENT_TASK_OPERATION_ADMISSION as Record<string,unknown>)[CROSSFADE],{allowed:true,tier:'local_reversible'});
 const effect=operationEffect(CROSSFADE);
 assert.deepEqual([effect.readOnly,effect.idempotent,effect.destructive,effect.paidGeneration,effect.externalIO],[false,true,true,false,false]);
 assert.equal(translate('zh-Hans',`operation.${CROSSFADE}`),descriptions[CROSSFADE]);
 for(const locale of (['zh-Hant','en','ja'] as const))assert.ok(translate(locale,`operation.${CROSSFADE}`).length>40);
});

test('two overlapping clips on different tracks fade linearly in one undoable edit',async t=>{
 const f=await fixture(t),{a,b}=await audioPair(f),before=await f.timeline();
 const input=f.request(before,a.id,b.id),response=await f.call<Response>(CROSSFADE,input);
 assert.ok(isTimelineMutationResponse(CROSSFADE,input,response));
 assert.deepEqual(response.crossfade,{outgoingClipId:a.id,incomingClipId:b.id,startFrame:60,durationFrames:30});
 const clips=new Map(response.timeline.clips.map(clip=>[clip.id,clip]));
 assert.deepEqual(clips.get(a.id)!.volumeEnvelope,{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:60,multiplier:1},{frame:90,multiplier:0}]});
 assert.deepEqual(clips.get(b.id)!.volumeEnvelope,{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0},{frame:30,multiplier:1}]});
 for(const clip of before.clips)if(![a.id,b.id].includes(clip.id))assert.deepEqual(clips.get(clip.id),clip,'other clips are untouched');
 assert.equal(response.timeline.revision,before.revision+1);
 const history=await f.call<{undoEntry: {operation: string}}>('timeline.history.get',{projectId:f.projectId});
 assert.equal(history.undoEntry.operation,CROSSFADE);
 assert.deepEqual(await f.call(CROSSFADE,input),response,'exact replay');
 await f.reopen();
 assert.deepEqual(await f.call(CROSSFADE,input),response,'exact replay survives a restart');
 const undone=await f.call<Timeline>('timeline.undo',{projectId:f.projectId,expectedRevision:response.timeline.revision,requestId:randomUUID()});
 assert.deepEqual(undone.clips,before.clips,'one undo restores both clips');
 const redone=await f.call<Timeline>('timeline.redo',{projectId:f.projectId,expectedRevision:undone.revision,requestId:randomUUID()});
 assert.deepEqual(redone.clips,response.timeline.clips);
 await assert.rejects(f.call(CROSSFADE,{...input,incomingClipId:a.id,outgoingClipId:b.id}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('the two curves sum to one at every sample of the overlap',()=>{
 const outgoing={id:randomUUID(),trackId:'a',startFrame:10,durationFrames:50},incoming={id:randomUUID(),trackId:'b',startFrame:40,durationFrames:70};
 const overlap=timelineCrossfadeOverlap(outgoing,incoming)!;
 assert.deepEqual(overlap,{startFrame:40,durationFrames:20});
 const left=createVolumeEnvelopeEvaluator({durationFrames:50,volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:30,multiplier:1},{frame:50,multiplier:0}]}});
 const right=createVolumeEnvelopeEvaluator({durationFrames:70,volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0},{frame:20,multiplier:1}]}});
 for(let sample=0;sample<=20*1600;sample+=7)assert.ok(Math.abs(left.limitAtSample(30*1600+sample)+right.limitAtSample(sample)-1)<1e-12,`sample ${sample}`);
 assert.equal(left.limitAtSample(29*1600),1,'before the overlap the outgoing clip is untouched');
 assert.equal(right.limitAtSample(21*1600),1,'after the overlap the incoming clip is untouched');
});

test('a sounding video and an audio clip on different kinds of track crossfade too',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),video=timeline.tracks.find(track=>track.kind==='video')!.id,audio=timeline.tracks.find(track=>track.kind==='audio')!.id;
 const a=await f.add(f.asset('video'),video,0,60),b=await f.add(f.asset('audio'),audio,45,60);
 const response=await f.call<Response>(CROSSFADE,f.request(await f.timeline(),a.id,b.id));
 assert.deepEqual(response.crossfade,{outgoingClipId:a.id,incomingClipId:b.id,startFrame:45,durationFrames:15});
});

test('illegal pairs, silent sources and existing curves are refused before any write',async t=>{
 const f=await fixture(t),{a,b,first,second}=await audioPair(f);
 let timeline=await f.timeline();
 await rejects(f,f.request(timeline,a.id,a.id),'CROSSFADE_SAME_CLIP');
 await rejects(f,f.request(timeline,b.id,a.id),'CROSSFADE_GEOMETRY');
 await rejects(f,f.request(timeline,a.id,randomUUID()),'CLIP_NOT_FOUND');
 await rejects(f,{...f.request(timeline,a.id,b.id),expectedRevision:timeline.revision-1},'REVISION_CONFLICT');
 // Same track, adjacent: a crossfade needs an overlap on two tracks.
 const next=await f.add(f.asset('audio'),first,90,30);timeline=await f.timeline();
 await rejects(f,f.request(timeline,a.id,next.id),'CROSSFADE_GEOMETRY');
 // The incoming clip must continue after the outgoing one ends.
 const third=await f.track('audio'),inside=await f.add(f.asset('audio'),third,10,40);timeline=await f.timeline();
 await rejects(f,f.request(timeline,a.id,inside.id),'CROSSFADE_GEOMETRY');
 const fourth=await f.track('audio'),gap=await f.add(f.asset('audio'),fourth,200,30);timeline=await f.timeline();
 await rejects(f,f.request(timeline,b.id,gap.id),'CROSSFADE_GEOMETRY');
 const videoTrack=timeline.tracks.find(track=>track.kind==='video')!.id;
 const silent=await f.add(f.asset('silent'),videoTrack,120,60);timeline=await f.timeline();
 await rejects(f,f.request(timeline,b.id,silent.id),'CROSSFADE_AUDIO_UNSUPPORTED');
 const sixth=await f.track('audio');
 const curved=await f.add(f.asset('audio'),sixth,140,60,{volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0.5}]}});timeline=await f.timeline();
 await rejects(f,f.request(timeline,b.id,curved.id),'CROSSFADE_ENVELOPE_EXISTS');
 void second;
});

test('fades are kept and still multiply the new curves',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),first=timeline.tracks.find(track=>track.kind==='audio')!.id,second=await f.track('audio');
 const a=await f.add(f.asset('audio'),first,0,90,{fadeOutFrames:12,fadeInFrames:4}),b=await f.add(f.asset('audio'),second,60,90,{fadeInFrames:10});
 const response=await f.call<Response>(CROSSFADE,f.request(await f.timeline(),a.id,b.id));
 const clips=new Map(response.timeline.clips.map(clip=>[clip.id,clip]));
 assert.deepEqual([clips.get(a.id)!.fadeInFrames,clips.get(a.id)!.fadeOutFrames,clips.get(b.id)!.fadeInFrames],[4,12,10]);
 assert.deepEqual(clips.get(a.id)!.volumeEnvelope,{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:60,multiplier:1},{frame:90,multiplier:0}]});
});

test('the clips may start together or end together, but the incoming clip may not end first',async t=>{
 const f=await fixture(t),timeline=await f.timeline(),first=timeline.tracks.find(track=>track.kind==='audio')!.id;
 const second=await f.track('audio'),third=await f.track('audio');
 const a=await f.add(f.asset('audio'),first,0,90),together=await f.add(f.asset('audio'),second,0,120),sameEnd=await f.add(f.asset('audio'),third,30,60);
 const started=await f.call<Response>(CROSSFADE,f.request(await f.timeline(),a.id,together.id));
 assert.deepEqual(started.crossfade,{outgoingClipId:a.id,incomingClipId:together.id,startFrame:0,durationFrames:90});
 assert.deepEqual(started.timeline.clips.find(clip=>clip.id===a.id)!.volumeEnvelope,{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:1},{frame:90,multiplier:0}]});
 await f.call('timeline.undo',{projectId:f.projectId,expectedRevision:started.timeline.revision,requestId:randomUUID()});
 const ended=await f.call<Response>(CROSSFADE,f.request(await f.timeline(),a.id,sameEnd.id));
 assert.deepEqual(ended.crossfade,{outgoingClipId:a.id,incomingClipId:sameEnd.id,startFrame:30,durationFrames:60});
 assert.deepEqual(ended.timeline.clips.find(clip=>clip.id===sameEnd.id)!.volumeEnvelope,{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0},{frame:60,multiplier:1}]});
 await rejects(f,f.request(await f.timeline(),together.id,a.id),'CROSSFADE_GEOMETRY');
});

test('crossfaded receipts survive backup and restore, and the restored copy refuses new crossfades',async t=>{
 const f=await fixture(t),{a,b}=await audioPair(f),input=f.request(await f.timeline(),a.id,b.id),response=await f.call<Response>(CROSSFADE,input);
 await f.close();
 const backup=path.join(path.dirname(f.root),`${path.basename(f.root)}-backup`),destination=path.join(path.dirname(f.root),`${path.basename(f.root)}-restored`);
 t.after(async()=>{await rm(backup,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
 const created=await createWorkspaceBackup({source:f.root,destination:backup}) as {integrity: string};
 assert.equal(created.integrity,'verified');assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const restored=await restoreWorkspaceBackup({directory:backup,destination}) as {workspaceOrigin: string};
 const store=openStore(destination),services=createServices(store,new Map());
 try{
  const timeline=await services.call('timeline.get',{projectId:f.projectId}) as Timeline;
  assert.deepEqual(timeline.clips,response.timeline.clips,'the crossfaded curves are restored exactly');
  await assert.rejects(services.call(CROSSFADE,{...input,requestId:randomUUID(),expectedRevision:timeline.revision},{expectedWorkspaceOrigin:restored.workspaceOrigin}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 }finally{await services.drain();store.close();}
});

test('a crossfade beside a dialogue clip keeps the workspace valid through backup and restore',async t=>{
 const f=await fixture(t),{a,b}=await audioPair(f),line=await f.add(f.asset('audio'),await f.track('audio'),0,150,{audioRole:'human'});
 const response=await f.call<Response>(CROSSFADE,f.request(await f.timeline(),a.id,b.id));
 // The receipt wraps a timeline with an audio role; the workspace validators
 // behind both capabilities must still read it as a valid receipt.
 const inspected=await f.call<{audioRoleCapability?: {editable: boolean};volumeEnvelopeCapability?: {editable: boolean}}>('workspace.restore.inspect',{includeAudioRoleCapability:true,includeVolumeEnvelopeCapability:true});
 assert.deepEqual([inspected.audioRoleCapability?.editable,inspected.volumeEnvelopeCapability?.editable],[true,true]);
 await f.close();
 const backup=path.join(path.dirname(f.root),`${path.basename(f.root)}-backup`),destination=path.join(path.dirname(f.root),`${path.basename(f.root)}-restored`);
 t.after(async()=>{await rm(backup,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
 assert.equal((await createWorkspaceBackup({source:f.root,destination:backup}) as {integrity: string}).integrity,'verified');
 await restoreWorkspaceBackup({directory:backup,destination});
 const store=openStore(destination),services=createServices(store,new Map());
 try{
  const timeline=await services.call('timeline.get',{projectId:f.projectId}) as Timeline;
  assert.deepEqual(timeline.clips,response.timeline.clips);
  assert.equal((timeline.clips.find(clip=>clip.id===line.id) as Clip&{audioRole?: string}).audioRole,'human');
 }finally{await services.drain();store.close();}
});
