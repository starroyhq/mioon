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
import {WRAPPED_TIMELINE_OPERATIONS} from '../packages/business/src/workspace-wrapped-timeline-receipts.ts';
import {schemas,descriptions,operationEffect,isTimelineMutationResponse,hasRequestNotAppliedProof,TIMELINE_MUTATION_OPERATIONS,DURABLE_EDIT_OPERATIONS,
 TIMELINE_CLIP_GAINS_OPERATION,TIMELINE_CLIP_GAINS_RESPONSE_BYTES,TIMELINE_CLIP_GAINS_LIMITS,TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
import {translate} from '../packages/i18n/src/index.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';

const GAINS=TIMELINE_CLIP_GAINS_OPERATION;
interface Clip {id: string;trackId: string;gain: number;fadeInFrames?: number;fadeOutFrames?: number;volumeEnvelope?: unknown;audioRole?: string|null}
interface Timeline {revision: number;tracks: {id: string;kind: string}[];clips: Clip[]}
interface Change {clipId: string;previousGain: number;gain: number}
interface Response {operation: string;requestId: string;timeline: Timeline;gains: Change[]}
type Failure = Error & {code?: string;status?: number;details?: Record<string, unknown>};
type Request = {projectId: string;expectedRevision: number;requestId: string;gains: {clipId: string;gain: number}[]};
const digest=(bytes: Buffer)=>createHash('sha256').update(bytes).digest('hex');
const writes=['timelines','timeline_history','timeline_history_cursors','timeline_requests'];

async function fixture(t: test.TestContext){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-clip-gains-')));
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
  request:(timeline: Timeline,gains: {clipId: string;gain: number}[]): Request=>({projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),gains}),
  async reopen(){await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());},
  async close(){await services.drain();store.close();},
 };
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function dialogue(f: Fixture){
 const audio=(await f.timeline()).tracks.find(track=>track.kind==='audio')!.id;
 const a=await f.add(f.asset('audio'),audio,0,90,{audioRole:'human'}),b=await f.add(f.asset('audio'),audio,90,60,{audioRole:'human'});
 const music=await f.add(f.asset('audio'),await f.track('audio'),0,150,{audioRole:'music'});
 return {a,b,music};
}
async function rejects(f: Fixture,input: Request,code: string){
 const before=f.capture();
 await assert.rejects(f.call(GAINS,input),(error: Failure)=>{
  assert.equal(error.code,code);
  assert.equal(hasRequestNotAppliedProof(error,input,{operation:GAINS}),true,`${code} carries a not-applied proof`);
  return true;
 });
 assert.deepEqual(f.capture(),before,`${code} writes nothing`);
}

test('the clip-gain batch is registered, described, effect-annotated, restore-denied, user-only and localized',()=>{
 assert.ok(schemas[GAINS]&&descriptions[GAINS].length>40);
 assert.ok(TIMELINE_MUTATION_OPERATIONS.includes(GAINS));assert.ok(!DURABLE_EDIT_OPERATIONS.includes(GAINS));
 assert.ok(RESTORE_DENIED_OPERATIONS.includes(GAINS));assert.ok(WRAPPED_TIMELINE_OPERATIONS.includes(GAINS));
 assert.equal(TIMELINE_CLIP_GAINS_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES+16*1024);assert.equal(TIMELINE_CLIP_GAINS_LIMITS.clips,100);
 assert.equal((AGENT_TASK_OPERATION_ADMISSION as Record<string,{allowed: boolean}>)[GAINS].allowed,false);
 const effect=operationEffect(GAINS);
 assert.deepEqual([effect.readOnly,effect.idempotent,effect.destructive,effect.paidGeneration,effect.externalIO],[false,true,true,false,false]);
 assert.equal(translate('zh-Hans',`operation.${GAINS}`),descriptions[GAINS]);
 for(const locale of (['zh-Hant','en','ja'] as const))assert.ok(translate(locale,`operation.${GAINS}`).length>40);
});

test('several dialogue gains change in one undoable edit',async t=>{
 const f=await fixture(t),{a,b,music}=await dialogue(f),before=await f.timeline();
 const input=f.request(before,[{clipId:b.id,gain:0.5},{clipId:a.id,gain:1.5}]),response=await f.call<Response>(GAINS,input);
 assert.ok(isTimelineMutationResponse(GAINS,input,response));
 assert.deepEqual(response.gains,[{clipId:b.id,previousGain:1,gain:0.5},{clipId:a.id,previousGain:1,gain:1.5}],'changes follow the request order');
 const clips=new Map(response.timeline.clips.map(clip=>[clip.id,clip]));
 assert.deepEqual([clips.get(a.id)!.gain,clips.get(b.id)!.gain],[1.5,0.5]);
 assert.deepEqual(clips.get(music.id),before.clips.find(clip=>clip.id===music.id),'unlisted clips are untouched');
 assert.deepEqual({...clips.get(a.id),gain:1},before.clips.find(clip=>clip.id===a.id),'only the gain changes');
 assert.equal(response.timeline.revision,before.revision+1);
 const history=await f.call<{undoEntry: {operation: string}}>('timeline.history.get',{projectId:f.projectId});
 assert.equal(history.undoEntry.operation,GAINS);
 assert.deepEqual(await f.call(GAINS,input),response,'exact replay');
 await f.reopen();
 assert.deepEqual(await f.call(GAINS,input),response,'exact replay survives a restart');
 const undone=await f.call<Timeline>('timeline.undo',{projectId:f.projectId,expectedRevision:response.timeline.revision,requestId:randomUUID()});
 assert.deepEqual(undone.clips,before.clips,'one undo restores every clip');
 const redone=await f.call<Timeline>('timeline.redo',{projectId:f.projectId,expectedRevision:undone.revision,requestId:randomUUID()});
 assert.deepEqual(redone.clips,response.timeline.clips);
 await assert.rejects(f.call(GAINS,{...input,gains:[{clipId:a.id,gain:1.2}]}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('a listed clip that keeps its gain is reported unchanged beside the ones that change',async t=>{
 const f=await fixture(t),{a,b}=await dialogue(f);
 const response=await f.call<Response>(GAINS,f.request(await f.timeline(),[{clipId:a.id,gain:1},{clipId:b.id,gain:0.8}]));
 assert.deepEqual(response.gains,[{clipId:a.id,previousGain:1,gain:1},{clipId:b.id,previousGain:1,gain:0.8}]);
});

test('missing clips, stale revisions, soundless sources and no-op batches are refused before any write',async t=>{
 const f=await fixture(t),{a,b}=await dialogue(f);
 const video=(await f.timeline()).tracks.find(track=>track.kind==='video')!.id;
 const silent=await f.add(f.asset('silent'),video,0,30),image=await f.add(f.asset('image'),video,30,30);
 const timeline=await f.timeline();
 await rejects(f,f.request(timeline,[{clipId:a.id,gain:1.2},{clipId:randomUUID(),gain:1}]),'CLIP_NOT_FOUND');
 await rejects(f,{...f.request(timeline,[{clipId:a.id,gain:1.2}]),expectedRevision:timeline.revision-1},'REVISION_CONFLICT');
 await rejects(f,f.request(timeline,[{clipId:a.id,gain:1.2},{clipId:silent.id,gain:0.5}]),'CLIP_GAINS_AUDIO_UNSUPPORTED');
 await rejects(f,f.request(timeline,[{clipId:image.id,gain:0.5}]),'CLIP_GAINS_AUDIO_UNSUPPORTED');
 await rejects(f,f.request(timeline,[{clipId:a.id,gain:1},{clipId:b.id,gain:1}]),'CLIP_GAINS_UNCHANGED');
 const before=f.capture();
 for(const gains of [[],[{clipId:a.id,gain:2.01}],[{clipId:a.id,gain:-0.1}],[{clipId:a.id,gain:1.2},{clipId:a.id,gain:1.3}],
  Array.from({length:101},()=>({clipId:randomUUID(),gain:1}))])
  await assert.rejects(f.call(GAINS,f.request(timeline,gains)),{code:'VALIDATION_ERROR'});
 assert.deepEqual(f.capture(),before,'invalid input writes nothing');
});

test('fades and volume envelopes are kept',async t=>{
 const f=await fixture(t),audio=(await f.timeline()).tracks.find(track=>track.kind==='audio')!.id;
 const volumeEnvelope={profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0.5},{frame:40,multiplier:1}]};
 const clip=await f.add(f.asset('audio'),audio,0,90,{fadeInFrames:6,fadeOutFrames:12,volumeEnvelope,audioRole:'human'});
 const response=await f.call<Response>(GAINS,f.request(await f.timeline(),[{clipId:clip.id,gain:1.7}]));
 const saved=response.timeline.clips.find(item=>item.id===clip.id)!;
 assert.deepEqual([saved.gain,saved.fadeInFrames,saved.fadeOutFrames,saved.volumeEnvelope],[1.7,6,12,volumeEnvelope]);
});

test('gain receipts beside dialogue keep the workspace valid through backup and restore, and the restored copy refuses new batches',async t=>{
 const f=await fixture(t),{a,b}=await dialogue(f);
 const input=f.request(await f.timeline(),[{clipId:a.id,gain:1.3},{clipId:b.id,gain:0.7}]),response=await f.call<Response>(GAINS,input);
 // The receipt wraps a timeline whose clips carry audio roles; the workspace
 // validators behind both capabilities must still read it as a valid receipt.
 const inspected=await f.call<{audioRoleCapability?: {editable: boolean};volumeEnvelopeCapability?: {editable: boolean}}>('workspace.restore.inspect',{includeAudioRoleCapability:true,includeVolumeEnvelopeCapability:true});
 assert.deepEqual([inspected.audioRoleCapability?.editable,inspected.volumeEnvelopeCapability?.editable],[true,true]);
 await f.close();
 const backup=path.join(path.dirname(f.root),`${path.basename(f.root)}-backup`),destination=path.join(path.dirname(f.root),`${path.basename(f.root)}-restored`);
 t.after(async()=>{await rm(backup,{recursive:true,force:true});await rm(destination,{recursive:true,force:true});});
 const created=await createWorkspaceBackup({source:f.root,destination:backup}) as {integrity: string};
 assert.equal(created.integrity,'verified');assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const restored=await restoreWorkspaceBackup({directory:backup,destination}) as {workspaceOrigin: string};
 const store=openStore(destination),services=createServices(store,new Map());
 try{
  const timeline=await services.call('timeline.get',{projectId:f.projectId}) as Timeline;
  assert.deepEqual(timeline.clips,response.timeline.clips,'the new gains are restored exactly');
  await assert.rejects(services.call(GAINS,{...input,requestId:randomUUID(),expectedRevision:timeline.revision,gains:[{clipId:a.id,gain:1}]},{expectedWorkspaceOrigin:restored.workspaceOrigin}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 }finally{await services.drain();store.close();}
});
