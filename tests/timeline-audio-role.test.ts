import type {TypedServices, Failure, Asset, AudioSnapshotFreezer} from './helpers/strict-timeline-audio-types.ts';
import type {TestContext} from 'node:test';
import {canEditTimelineAudioRole,isWorkspaceRestoreInspection} from '../packages/contracts/src/workspace-restore.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {parse,isTimelineRecord,isTimelineMutationResponse,hasRequestNotAppliedProof} from '../packages/contracts/src/index.ts';
import {getTimelineAudioRoleIssue,isTimelineAudioRoleSnapshot,TIMELINE_AUDIO_ROLE_PROFILE} from '../packages/contracts/src/timeline-audio-role.ts';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.ts';
import {timelineClipAudioFilter} from '../packages/business/src/timeline-audio-filter-graph.ts';
import type {TimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
interface RoleFixture {store: ReturnType<typeof openStore>; projectId: string; call: TypedServices['call']; restart(): void; asset(mimeType?: string, extra?: Record<string, unknown>): Asset; state(): unknown; outside(): unknown}
const clone=<T>(v: T): T=>JSON.parse(JSON.stringify(v)) as T;
const editable=(t: TimelineRecord)=>clone({tracks:t.tracks,clips:t.clips,durationFrames:t.durationFrames});
const request=(f: {projectId: string},t: TimelineRecord,extra: Record<string, unknown>={})=>({projectId:f.projectId,expectedRevision:t.revision,requestId:randomUUID(),...extra});
async function fixture(t: TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-audio-role-'));let store=openStore(root),services=(createServices(store,new Map()) as TypedServices);
 const f={get store(){return store;},call:<O extends string>(op: O,input: unknown)=>services.call(op,input),restart(){store.close();store=openStore(root);services=(createServices(store,new Map()) as TypedServices);},
 asset(mimeType='audio/wav',extra={}){const id=randomUUID();return store.put('assets',{id,projectId:f.projectId,name:'Role source',mimeType,duration:600,width:720,height:1280,hasVideo:mimeType.startsWith('video/'),hasAudio:true,sha256:'a'.repeat(64),relativePath:`media/${id}.fixture`,...extra}) as unknown as Asset;},
 state(){return Object.fromEntries(['timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(n=>[n,store.db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()]));},
 outside(){return Object.fromEntries(['projects','assets','shots','nodes','edges','jobs','versions','exports'].map(n=>[n,clone(store.list(n))]));}} as RoleFixture;
 f.projectId=(await f.call('project.create',{name:t.name})).id;t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
async function add(f: RoleFixture,extra: Record<string, unknown>={},asset=f.asset()){
 const timeline=await f.call('timeline.get',{projectId:f.projectId}),trackId=timeline.tracks.find(t=>t.kind===(asset.mimeType.startsWith('audio/')?'audio':'video'))!.id;
 const input=request(f,timeline,{assetId:asset.id,trackId,startFrame:0,durationFrames:60,...extra}),result=await f.call('timeline.clip.add',input);
 return {timeline:result,clip:result.clips.at(-1)!,input,asset};
}
async function rejected(f: RoleFixture,op: string,input: unknown,code: string){const before=f.state(),outside=f.outside();await assert.rejects(f.call(op,input),e=>(e as Failure).code===code);assert.deepEqual(f.state(),before);assert.deepEqual(f.outside(),outside);}

test('role inputs preserve omission/null, reject invalid enums and remain ordinary clip operations',()=>{
 const base={projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),clipId:randomUUID()};
 for(const role of ['human','music','sfx',null])assert.deepEqual((parse('timeline.clip.update',{...base,patch:{audioRole:role}}) as {patch: unknown}).patch,{audioRole:role});
 assert.deepEqual((parse('timeline.clip.update',{...base,patch:{gain:1}}) as {patch: unknown}).patch,{gain:1});
 for(const role of ['',0,true,{},[],'voice','HUMAN'])assert.throws(()=>parse('timeline.clip.update',{...base,patch:{audioRole:role}}),{code:'VALIDATION_ERROR'});
 for(const mimeType of ['audio/wav','audio/mpeg','audio/mp4','video/mp4','video/webm'])for(const hasAudio of [false,true,null,undefined])assert.equal(getTimelineAudioRoleIssue({audioRole:'human'},{mimeType,hasAudio}),null);
 for(const role of ['human',null])assert.equal(getTimelineAudioRoleIssue({audioRole:role},{mimeType:'image/png'})!.code,'AUDIO_ROLE_CLIP_UNSUPPORTED');
});

test('roles are clip-owned, editorial and preserve legacy omission and unrelated state',async t=>{
 const f=await fixture(t),asset=f.asset('video/mp4',{hasAudio:false});let {timeline,clip}=await add(f,{},asset);
 assert.equal(Object.hasOwn(clip,'audioRole'),false);const outside=f.outside();
 timeline=await f.call('timeline.clip.update',request(f,timeline,{clipId:clip.id,patch:{audioRole:'human'}}));
 const second=await add(f,{startFrame:60,audioRole:'music'},asset);timeline=second.timeline;
 assert.deepEqual(timeline.clips.map(c=>c.audioRole),['human','music']);assert.equal(isTimelineRecord(timeline),true);
 timeline=await f.call('timeline.track.update',request(f,timeline,{trackId:clip.trackId,patch:{muted:true}}));
 timeline=await f.call('timeline.clip.update',request(f,timeline,{clipId:clip.id,patch:{gain:0}}));
 assert.equal(timeline.clips[0].audioRole,'human');assert.equal(timeline.tracks.find(c=>c.id===clip.trackId)!.muted,true);
 assert.deepEqual(f.outside(),outside);f.restart();assert.deepEqual(await f.call('timeline.get',{projectId:f.projectId}),timeline);
});

test('role edit undo/redo, split inheritance and clear restore exact absent/null shape',async t=>{
 const f=await fixture(t);let {timeline,clip}=await add(f);const original=timeline;
 const set=request(f,timeline,{clipId:clip.id,patch:{audioRole:'sfx'}});timeline=await f.call('timeline.clip.update',set);const labelled=timeline;
 timeline=await f.call('timeline.undo',request(f,timeline));assert.deepEqual(editable(timeline),editable(original));assert.equal(Object.hasOwn(timeline.clips[0],'audioRole'),false);
 timeline=await f.call('timeline.redo',request(f,timeline));assert.deepEqual(editable(timeline),editable(labelled));
 const split=request(f,timeline,{clipId:clip.id,atFrame:30});timeline=await f.call('timeline.clip.split',split);assert.deepEqual(timeline.clips.map(c=>c.audioRole),['sfx','sfx']);assert.equal(isTimelineMutationResponse('timeline.clip.split',split,timeline),true);
 const tampered=clone(timeline);delete tampered.clips[1].audioRole;assert.equal(isTimelineMutationResponse('timeline.clip.split',split,tampered),false);
 timeline=await f.call('timeline.clip.update',request(f,timeline,{clipId:clip.id,patch:{audioRole:null}}));assert.equal(Object.hasOwn(timeline.clips[0],'audioRole'),true);assert.equal(timeline.clips[0].audioRole,null);
 timeline=await f.call('timeline.undo',request(f,timeline));assert.equal(timeline.clips[0].audioRole,'sfx');
 timeline=await f.call('timeline.redo',request(f,timeline));assert.equal(timeline.clips[0].audioRole,null);
 const replacement=f.asset();timeline=await f.call('timeline.clip.replaceSource',request(f,timeline,{clipId:timeline.clips[1].id,assetId:replacement.id}));assert.equal(timeline.clips[1].audioRole,'sfx');
 timeline=await f.call('timeline.clip.remove',request(f,timeline,{clipId:clip.id}));timeline=await f.call('timeline.undo',request(f,timeline));assert.equal(timeline.clips.find(c=>c.id===clip.id)!.audioRole,null);
});

test('role CAS and exact replay preserve old acknowledgements after removal and restart',async t=>{
 const f=await fixture(t);let {timeline,clip,input}=await add(f);const legacy=timeline;
 const set=request(f,timeline,{clipId:clip.id,patch:{audioRole:'human'}});timeline=await f.call('timeline.clip.update',set);const response=timeline;
 await rejected(f,'timeline.clip.update',{...set,requestId:randomUUID(),patch:{audioRole:'music'}},'REVISION_CONFLICT');
 await rejected(f,'timeline.clip.update',{...set,patch:{audioRole:'music'}},'IDEMPOTENCY_CONFLICT');
 timeline=await f.call('timeline.clip.remove',request(f,timeline,{clipId:clip.id}));f.restart();const before=f.state();
 assert.deepEqual(await f.call('timeline.clip.update',set),response);assert.deepEqual(await f.call('timeline.clip.add',input),legacy);assert.deepEqual(f.state(),before);
});

test('still-image role edits including explicit clear fail atomically',async t=>{
 const f=await fixture(t);let {timeline,clip}=await add(f,{},f.asset('image/png'));
 for(const role of ['human',null])await rejected(f,'timeline.clip.update',request(f,timeline,{clipId:clip.id,patch:{audioRole:role}}),'AUDIO_ROLE_CLIP_UNSUPPORTED');
 const asset=f.asset('image/png');for(const role of ['music',null])await rejected(f,'timeline.clip.add',request(f,timeline,{trackId:clip.trackId,assetId:asset.id,startFrame:60,durationFrames:30,audioRole:role}),'AUDIO_ROLE_CLIP_UNSUPPORTED');
});

test('role-only edits explicitly change frozen snapshots but leave audio filter parameters unchanged',async t=>{
 const f=await fixture(t);let {timeline,clip,asset}=await add(f,{gain:.75,fadeInFrames:5,fadeOutFrames:5});
 const sources=new Map([[asset.id,asset]]),before=(freezeTimelineSnapshot as AudioSnapshotFreezer)(timeline as unknown as Parameters<typeof freezeTimelineSnapshot>[0],sources as unknown as Parameters<typeof freezeTimelineSnapshot>[1]),bytes=JSON.stringify(before),filter=timelineClipAudioFilter(clip as unknown as Parameters<typeof timelineClipAudioFilter>[0],0,96000,0);
 assert.equal(Object.hasOwn(before,'audioRoleProfile'),false);assert.equal(isTimelineAudioRoleSnapshot(before),true);
 for(const role of ['human','music','sfx',null]){
  timeline=await f.call('timeline.clip.update',request(f,timeline,{clipId:clip.id,patch:{audioRole:role}}));const snapshot=(freezeTimelineSnapshot as AudioSnapshotFreezer)(timeline as unknown as Parameters<typeof freezeTimelineSnapshot>[0],sources as unknown as Parameters<typeof freezeTimelineSnapshot>[1]);
  assert.equal(snapshot.audioRoleProfile,TIMELINE_AUDIO_ROLE_PROFILE);assert.equal(isTimelineAudioRoleSnapshot(snapshot),true);assert.notEqual(JSON.stringify(snapshot),bytes);
  assert.equal(timelineClipAudioFilter(timeline.clips[0] as unknown as Parameters<typeof timelineClipAudioFilter>[0],0,96000,0),filter);
  for(const change of [{audioRoleProfile:'unknown'},{audioRoleProfile:undefined}])assert.equal(isTimelineAudioRoleSnapshot({...snapshot,...change}),false);
  const missing=clone(snapshot);delete missing.audioRoleProfile;assert.equal(isTimelineAudioRoleSnapshot(missing),false);
 }
 assert.equal(JSON.stringify(before),bytes);assert.equal(isTimelineAudioRoleSnapshot({...before,audioRoleProfile:TIMELINE_AUDIO_ROLE_PROFILE}),false);
});


test('image role rejection proof is bound to exact operation, project and request',async t=>{
 const f=await fixture(t),{timeline,clip}=await add(f,{},f.asset('image/png'));
 const input=request(f,timeline,{clipId:clip.id,patch:{audioRole:'human'}});let error: unknown;
 try{await f.call('timeline.clip.update',input);}catch(e){error=e;}
 assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.clip.update'}),true);
 for(const field of ['operation','projectId','requestId']){const forged={...(error as Failure),details:{...(error as Failure).details}};delete forged.details[field];assert.equal(hasRequestNotAppliedProof(forged,input,{operation:'timeline.clip.update'}),false);}
 assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.clip.add'}),false);
 assert.equal(hasRequestNotAppliedProof(error,{...input,projectId:randomUUID()},{operation:'timeline.clip.update'}),false);
});


test('role write capability is opt-in and missing capability fails closed',async t=>{
 const f=await fixture(t);const legacy=await f.call('workspace.restore.inspect',{});assert.deepEqual(legacy,{restored:false});assert.equal(canEditTimelineAudioRole(legacy),false);
 const current=await f.call('workspace.restore.inspect',{includeAudioRoleCapability:true});assert.equal(isWorkspaceRestoreInspection(current),true);assert.equal(canEditTimelineAudioRole(current),true);assert.equal(current.audioRoleCapability!.profileId,TIMELINE_AUDIO_ROLE_PROFILE);
 assert.equal(canEditTimelineAudioRole({restored:false,audioRoleCapability:{profileId:'unknown',editable:true}}),false);
 assert.throws(()=>parse('workspace.restore.inspect',{includeAudioRoleCapability:false}),{code:'VALIDATION_ERROR'});
});
