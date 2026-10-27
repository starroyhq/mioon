import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {VolumeEnvelope} from '../packages/contracts/src/timeline-volume-envelope.ts';
import type {StrictTimelineTasks} from './helpers/strict-timeline-handler-types.ts';
import type {TypedStore as FixtureStore, TypedServices as FixtureServices} from './helpers/strict-service-responses.ts';
import type {SQLInputValue} from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,installCurrentWorkspaceRestoreSchema,classifyCurrentWorkspaceSchema,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';
import {createServices,hash, type OrdinaryServices, type ServiceStore} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {VOLUME_ENVELOPE_PROFILE,VOLUME_ENVELOPE_LIMITS,createVolumeEnvelopeEvaluator} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {hasRequestNotAppliedProof} from '../packages/contracts/src/index.ts';
import {validateWorkspaceSchema62} from '../packages/business/src/workspace-schema-v62.ts';
import {readTimelineVolumeEnvelopeCapability} from '../packages/business/src/timeline-volume-envelope-capability.ts';
import {readTimelineAudioRoleCapability} from '../packages/business/src/timeline-audio-role-business.ts';
import {TIMELINE_AUDIO_ROLE_PROFILE} from '../packages/contracts/src/timeline-audio-role.ts';
import {clipDraftRaw,clipDraftPatch} from '../apps/web/src/clip-draft-state.ts';
import {createVolumeEnvelopeFadePreset,createManualDuckingEnvelope,manualDuckingEnvelopeFromRaw} from '../apps/web/src/clip-volume-envelope-state.ts';
import {snapshot} from './workspace-schema26-fixtures.mjs';

// Genuine owned startup only: no restore-policy mock, facade, manual ordinary
// migration, private ownership token, media file, provider or transport.
const envelope=(): VolumeEnvelope=>({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:1},{frame:10,multiplier:.2},{frame:60,multiplier:.8}]});
const code=(value: string)=>(error?: { code?: unknown; }|null|undefined)=>(error as {code?: unknown}|null|undefined)?.code===value;
async function fixture(t: test.TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-envelope-owned-'));
 let store!: FixtureStore,services!: FixtureServices,tasks!: StrictTimelineTasks,fault: (label: string)=>void=()=>{};
 const start=()=>{store=(openStore(root) as FixtureStore);services=(createServices(store,new Map()) as FixtureServices);tasks=(createEditTasks({store,services,fault:label=>fault(label)}) as StrictTimelineTasks);};start();
 const close=async()=>{await tasks.drain();await services.drain();store.close();};
 t.after(async()=>{if(store.db.isOpen)await close();rmSync(root,{recursive:true,force:true});});
 assert.deepEqual(classifyCurrentWorkspaceSchema(store.db),{schemaVersion:62,profile:'ordinary'});
 const project=await services.call('project.create',{name:'Owned envelope fixture'});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 const f={root,project,get store(){return store;},get services(){return services;},get tasks(){return tasks;},get timeline(){return timeline;},
  asset(fields: {provenance?: string; hasAudio?: boolean;}={}){return store.put('assets',{id:randomUUID(),projectId:project.id,name:'Metadata-only source',mimeType:'video/mp4',duration:20,width:720,height:1280,hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:'media/not-created.mp4',createdAt:'2026-10-15T00:00:00.000Z',...fields});},
  input(fields: { clipId?: string; patch?: Record<string,unknown>|{ volumeEnvelope: null; gain?: undefined; }|{ volumeEnvelope: { profileId: string; points: { frame: number; multiplier: number; }[]; }; gain?: undefined; }|{ gain: number; volumeEnvelope?: undefined; }|{ volumeEnvelope: null; }|{ volumeEnvelope: null; }|{ volumeEnvelope: { profileId: string; points: { frame: number; multiplier: number; }[]; }|null; audioRole: string; colour: null; }|{ gain: number; }|{ volumeEnvelope: null; }|{ muted: boolean; }; requestId?: unknown; kind?: string; expectedRevision?: number; trackId?: string; }={}){return {projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),...fields};},
  async call(operation: 'timeline.clip.add'|'timeline.clip.update'|'timeline.clip.remove'|'timeline.clip.replaceSource'|'timeline.clip.split'|'timeline.undo'|'timeline.redo',fields: Record<string, unknown>={},context?: Parameters<FixtureServices['call']>[2]){const input=f.input(fields),result=await services.call(operation,input,context);timeline=((result as {timeline?:FixtureTimeline}).timeline??result) as FixtureTimeline;return {input,result};},
  prepare(operation: string,input: { projectId: unknown; expectedRevision?: unknown; requestId?: `${string}-${string}-${string}-${string}-${string}`; },context?: string|{ expectedWorkspaceOrigin: `${string}-${string}-${string}-${string}-${string}`; }|{ expectedWorkspaceOrigin?: undefined; }|undefined){return tasks.prepare({projectId:input.projectId,operation,input,origin:'new'},((context) as unknown as Parameters<typeof tasks.prepare>[1]));},
  request(saved: { task: { projectId: unknown; id: unknown; digest: unknown; }; }){return {projectId:saved.task.projectId,taskId:saved.task.id,digest:saved.task.digest};},
  execute(saved: { instanceId: unknown; },context?: string|{ expectedWorkspaceOrigin: `${string}-${string}-${string}-${string}-${string}`; }|{ expectedWorkspaceOrigin?: undefined; }|undefined){return tasks.execute({...f.request(((saved) as unknown as Parameters<typeof f.request>[0])),instanceId:saved.instanceId},((context) as unknown as Parameters<typeof tasks.execute>[1]));},
  ack(saved: { task: { revision: unknown; status: unknown; }; },context?: { expectedWorkspaceOrigin: `${string}-${string}-${string}-${string}-${string}`; }|undefined){return tasks.acknowledge({...f.request(((saved) as unknown as Parameters<typeof f.request>[0])),expectedRevision:saved.task.revision,status:saved.task.status},context);},
  setFault(value: { (label?: unknown): void; (): void; (label?: unknown): void; (): void; (): void; }){fault=value;},
  async reopen(install?: (db: DatabaseSync)=>void){await close();if(install){const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{install(db);}finally{db.close();}}start();timeline=await services.call('timeline.get',{projectId:project.id});},
  state(){return snapshot(store.db);},
 };
 return f;
}
const addInput=(f: Awaited<ReturnType<typeof fixture>>,asset: {id?: unknown;}=f.asset(),fields: {gain?: number; fadeInFrames?: number; fadeOutFrames?: number; durationFrames?: number; startFrame?: number; sourceInFrame?: number; rect?: { x: number; y: number; width: number; height: number; }; audioRole?: string; colour?: null; volumeEnvelope?: { profileId: string; points: { frame: number; multiplier: number; }[]; };}={})=>f.input((({assetId:asset.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:60,volumeEnvelope:envelope(),...fields}) as unknown as Parameters<NonNullable<(typeof f)["input"]>>[0]));

for(const restored of ([false,true] as const))test(`current ${restored?'restored63':'ordinary62'} capability queries validate exact profiles and durable ripple removal stays available`,async t=>{
 const f=await fixture(t);
 await f.call('timeline.clip.add',((addInput(f)) as unknown as Parameters<typeof f.call>[1]));
 let context;
 if(restored){
  const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};
  await f.reopen((db: DatabaseSync)=>installCurrentWorkspaceRestoreSchema(db,metadata));context={expectedWorkspaceOrigin:metadata.workspaceOrigin};
 }
 const before=f.state(),volume={profileId:VOLUME_ENVELOPE_PROFILE,editable:true},audio={profileId:TIMELINE_AUDIO_ROLE_PROFILE,editable:true};
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(f.store.db),volume);
 assert.deepEqual(readTimelineAudioRoleCapability(f.store.db),audio);
 const disclosed=await f.services.call('workspace.restore.inspect',{includeVolumeEnvelopeCapability:true,includeAudioRoleCapability:true});
 assert.deepEqual(disclosed.volumeEnvelopeCapability,volume);assert.deepEqual(disclosed.audioRoleCapability,audio);
 assert.deepEqual(f.state(),before,'capability queries preserve all stored evidence');
 const saved=f.prepare('timeline.clip.rippleRemove',((f.input({clipId:f.timeline.clips[0].id})) as unknown as Parameters<typeof f.prepare>[1]),context),done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]),context);
 assert.equal(done.task.status,'applied');
 const timeline=await f.services.call('timeline.get',{projectId:f.project.id});assert.deepEqual((timeline.clips as unknown),[]);
 f.store.db.exec('CREATE TABLE unrelated_capability_object(value TEXT)');
 assert.deepEqual(readTimelineVolumeEnvelopeCapability(f.store.db),{...volume,editable:false});
 assert.throws(()=>readTimelineAudioRoleCapability(f.store.db),'a marker chain alone never enables the current audio capability');
});

for(const kind of (['in','out'] as const))for(const fadeFrames of ([15,60] as const))test(`owned ordinary62 ${kind} preset ${fadeFrames}/60 replaces the curve through durable Save, history and reopen`,async t=>{
 const f=await fixture(t),durationFrames=60,gain=.75,fadeInFrames=5,fadeOutFrames=7;
 await f.call('timeline.clip.add',((addInput(f,f.asset(),{gain,fadeInFrames,fadeOutFrames})) as unknown as Parameters<typeof f.call>[1]));
 const original=structuredClone(f.timeline.clips[0]),clipId=original.id;
 const preset=createVolumeEnvelopeFadePreset(((kind) as unknown as Parameters<typeof createVolumeEnvelopeFadePreset>[0]),durationFrames,fadeFrames);
 const expected={profileId:VOLUME_ENVELOPE_PROFILE,points:kind==='in'?[{frame:0,multiplier:0},{frame:fadeFrames,multiplier:1}]:[{frame:durationFrames-fadeFrames,multiplier:1},{frame:durationFrames,multiplier:0}]};
 assert.ok(preset);assert.deepEqual(preset,{profileId:expected.profileId,points:expected.points.map(point=>({frame:String(point.frame),multiplier:String(point.multiplier)}))});
 const raw={...clipDraftRaw(((original) as unknown as Parameters<typeof clipDraftRaw>[0])),volumeEnvelope:preset},rawBefore=structuredClone(raw),patch=clipDraftPatch(raw);
 assert.ok(patch);assert.deepEqual(patch.volumeEnvelope,expected);assert.deepEqual(raw,rawBefore,'numeric Save projection does not mutate the form');
 assert.equal(patch.gain,gain);assert.equal(patch.fadeInFrames,fadeInFrames);assert.equal(patch.fadeOutFrames,fadeOutFrames);
 const input=f.input({clipId,patch}),saved=f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1])),done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]));
 assert.equal(done.task.status,'applied');assert.deepEqual((saved.task.input.patch)!.volumeEnvelope,expected);f.ack(((done) as unknown as Parameters<typeof f.ack>[0]));
 const assertSaved=(clip?: unknown)=>{
  assert.deepEqual(clip,{...original,volumeEnvelope:expected},'the preset replaces the old three-point curve and preserves every other clip field');
  const evaluate=createVolumeEnvelopeEvaluator(((clip) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0])),end=durationFrames*VOLUME_ENVELOPE_LIMITS.samplesPerFrame;
  assert.equal(evaluate.atSample(end),0,'the clip end is outside half-open playback membership');
  assert.equal(evaluate.limitAtSample(end),kind==='in'?1:0,'the closed endpoint describes the retained curve');
  if(kind==='out')assert.ok(Math.abs(evaluate.atSample(end-1)-1/(fadeFrames*VOLUME_ENVELOPE_LIMITS.samplesPerFrame))<1e-14,'the final playable sample remains above zero');
  else assert.ok(Math.abs(evaluate.atSample(end-1)-(fadeFrames===durationFrames?1-1/end:1))<1e-14);
 };
 assertSaved((done.result)!.clips[0]);await f.reopen();assertSaved(f.timeline.clips[0]);
 assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:62,profile:'ordinary'});
 const retained=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(retained.task.acknowledged,true);assert.deepEqual((await f.execute(((retained) as unknown as Parameters<typeof f.execute>[0]))).result,done.result);
 await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
 await f.reopen();assert.deepEqual(f.timeline.clips[0],original);await f.call('timeline.redo');assertSaved(f.timeline.clips[0]);
 await f.reopen();assertSaved(f.timeline.clips[0]);
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,1,'durable replay does not create a second Save receipt');
});

for(const spec of ([
 {name:'four-point interval',durationFrames:90,input:{startFrame:15,endFrame:75,multiplier:.25,attackFrames:10,releaseFrames:20},points:[{frame:15,multiplier:1},{frame:25,multiplier:.25},{frame:55,multiplier:.25},{frame:75,multiplier:1}],samples:[[0,1],[20,.625],[40,.25],[65,.625]],endpoint:1,last:1},
 {name:'triangle with a shared ramp anchor',durationFrames:90,input:{startFrame:10,endFrame:70,multiplier:.5,attackFrames:20,releaseFrames:40},points:[{frame:10,multiplier:1},{frame:30,multiplier:.5},{frame:70,multiplier:1}],samples:[[0,1],[20,.75],[30,.5],[50,.75]],endpoint:1,last:1},
 {name:'full-range zero-ramp attenuation',durationFrames:60,input:{startFrame:0,endFrame:60,multiplier:.25,attackFrames:0,releaseFrames:0},points:[{frame:0,multiplier:.25},{frame:60,multiplier:.25}],samples:[[0,.25],[30,.25]],endpoint:.25,last:.25},
 {name:'one-frame full-range attack',durationFrames:1,input:{startFrame:0,endFrame:1,multiplier:.25,attackFrames:1,releaseFrames:0},points:[{frame:0,multiplier:1},{frame:1,multiplier:.25}],samples:[[0,1],[.5,.625]],endpoint:.25,last:.25+.75/VOLUME_ENVELOPE_LIMITS.samplesPerFrame},
] as const))test(`owned ordinary62 manual ducking ${spec.name} saves exact anchors and preserves source identity through history and reopen`,async t=>{
 const f=await fixture(t),source=f.asset({provenance:'generated'}),durationFrames=spec.durationFrames;
 const shot=await f.services.call('shot.create',{projectId:f.project.id,title:'Metadata-only generated source'}),jobId=randomUUID(),versionId=randomUUID();
 const sourceSnapshot={projectId:f.project.id,shotId:shot.id,referenceAssetIds:[],referenceAssets:[]};
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,versionId,assetId:source.id,status:'succeeded',providerId:'mock',requestId:randomUUID(),snapshot:sourceSnapshot});
 f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:shot.id,assetId:source.id,jobId,number:1,sha256:source.sha256,snapshot:sourceSnapshot});
 await f.call('timeline.clip.add',((addInput(f,source,{durationFrames,startFrame:23,sourceInFrame:7,gain:.75,fadeInFrames:durationFrames===1?1:5,fadeOutFrames:durationFrames===1?0:7,
  rect:{x:40,y:80,width:360,height:640},audioRole:'human',colour:null,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:.9},{frame:durationFrames,multiplier:.8}]}})) as unknown as Parameters<typeof f.call>[1]));
 // A complete synthetic generated-reference record exercises all optional
 // source pins; ordinary62 validation precedes genuine owned Save dispatch.
 Object.assign(f.timeline.clips[0],{versionId,shotId:shot.id,jobId});f.store.put('timelines',f.timeline);validateWorkspaceSchema62(f.store.db);
 const original=structuredClone(f.timeline.clips[0]),clipId=original.id,outside=f.state().tables;
 const preset=createManualDuckingEnvelope(durationFrames,spec.input),rawInput=Object.fromEntries(Object.entries(spec.input).map(([key,value])=>[key,String(value)]));
 const fromRaw=manualDuckingEnvelopeFromRaw(durationFrames,((rawInput) as unknown as Parameters<typeof manualDuckingEnvelopeFromRaw>[1])),expected={profileId:VOLUME_ENVELOPE_PROFILE,points:spec.points};
 assert.ok(preset);assert.deepEqual(fromRaw,preset);assert.deepEqual(preset,{profileId:expected.profileId,points:expected.points.map(point=>({frame:String(point.frame),multiplier:String(point.multiplier)}))});
 const raw={...clipDraftRaw(((original) as unknown as Parameters<typeof clipDraftRaw>[0])),volumeEnvelope:fromRaw},rawBefore=structuredClone(raw),patch=clipDraftPatch(raw);
 assert.ok(patch);assert.deepEqual(patch.volumeEnvelope,expected);assert.deepEqual(raw,rawBefore);
 const input=f.input({clipId,patch}),prepared=f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1])),done=await f.execute(((prepared) as unknown as Parameters<typeof f.execute>[0]));
 assert.equal(done.task.status,'applied');assert.deepEqual((prepared.task.input.patch)!.volumeEnvelope,expected);f.ack(((done) as unknown as Parameters<typeof f.ack>[0]));
 const assertSaved=(clip?: unknown)=>{
  assert.deepEqual(clip,{...original,volumeEnvelope:expected},'only the complete envelope changes; gain, legacy fades, geometry and every fixed source field remain exact');
  const evaluate=createVolumeEnvelopeEvaluator(((clip) as unknown as Parameters<typeof createVolumeEnvelopeEvaluator>[0])),end=durationFrames*VOLUME_ENVELOPE_LIMITS.samplesPerFrame;
  for(const [frame,multiplier]of spec.samples)assert.ok(Math.abs(evaluate.atSample(frame*VOLUME_ENVELOPE_LIMITS.samplesPerFrame)-multiplier)<1e-14,`sample at local frame ${frame}`);
  assert.equal(evaluate.limitAtSample(end),spec.endpoint);assert.equal(evaluate.atSample(end),0,'closed curve endpoint is outside half-open playback membership');
  assert.ok(Math.abs(evaluate.atSample(end-1)-spec.last)<1e-14,'the final playable sample uses the retained ramp, not the outside-clip zero');
 };
 assertSaved((done.result)!.clips[0]);await f.reopen();assertSaved(f.timeline.clips[0]);
 const retained=f.tasks.get({projectId:f.project.id,taskId:prepared.task.id});assert.equal(retained.task.acknowledged,true);assert.deepEqual((await f.execute(((retained) as unknown as Parameters<typeof f.execute>[0]))).result,done.result);
 await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);await f.reopen();assert.deepEqual(f.timeline.clips[0],original);
 await f.call('timeline.redo');assertSaved(f.timeline.clips[0]);await f.reopen();assertSaved(f.timeline.clips[0]);
 assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:62,profile:'ordinary'});
 for(const name of (['projects','assets','shots','jobs','versions'] as const))assert.deepEqual(f.state().tables[name],outside[name],`${name} identity and metadata bytes remain unchanged`);
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,1);
});

test('owned ordinary62 starts, durably prepares/applies, replays after Undo and reopens exact envelope receipts',async t=>{
 const f=await fixture(t),input=addInput(f),operation='timeline.clip.add',before=f.state();
 const saved=f.prepare(operation,((input) as unknown as Parameters<typeof f.prepare>[1]));assert.equal(saved.task.digest,hash({operation,input}));assert.deepEqual(saved.task.input,input);
 const after=f.state();for(const name of (['timelines','timeline_history','timeline_history_cursors','timeline_requests'] as const))assert.deepEqual(after.tables[name],before.tables[name]);
 assert.deepEqual(f.prepare(operation,((input) as unknown as Parameters<typeof f.prepare>[1])),saved);
 const done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]));assert.equal(done.task.status,'applied');assert.deepEqual((done.result)!.clips[0].volumeEnvelope,envelope());f.ack(((done) as unknown as Parameters<typeof f.ack>[0]));
 const raw=(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.response;
 await f.call('timeline.undo',(({expectedRevision:(done.result)!.revision}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));assert.equal(f.timeline.clips.length,0);
 assert.deepEqual(await f.services.call(operation,input),done.result);
 await f.reopen();assert.equal(f.timeline.clips.length,0);assert.deepEqual(await f.services.call(operation,input),done.result);
 assert.equal((f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.response,raw);
 const retained=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(retained.task.acknowledged,true);assert.deepEqual((await f.execute(((retained) as unknown as Parameters<typeof f.execute>[0]))).result,done.result);
 await f.call('timeline.redo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
});

test('owned ordinary62 source replacement, atomic shrink/clear, split and history preserve exact anchors',async t=>{
 const f=await fixture(t),a=f.asset(),b=f.asset(),bad=f.asset({hasAudio:false});
 await f.call('timeline.clip.add',((addInput(f,a)) as unknown as Parameters<typeof f.call>[1]));const clipId=f.timeline.clips[0].id;
 await f.call('timeline.clip.replaceSource',{clipId,assetId:b.id});assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 for(const [operation,fields,expected]of ([
  ['timeline.clip.replaceSource',{clipId,assetId:bad.id},'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED'],
  ['timeline.clip.update',{clipId,patch:{durationFrames:30}},'TIMELINE_VOLUME_ENVELOPE_INVALID'],
 ] as const)){const before=f.state();await assert.rejects(f.call(operation,fields),code(expected));assert.deepEqual(f.state(),before);}
 const smaller={profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:4,multiplier:.2},{frame:30,multiplier:.6}]};
 await f.call('timeline.clip.update',(({clipId,patch:{durationFrames:30,volumeEnvelope:smaller}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));assert.deepEqual(f.timeline.clips[0].volumeEnvelope,smaller);
 await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 const original=structuredClone(f.timeline.clips[0]),evaluate=createVolumeEnvelopeEvaluator(original);
 await f.call('timeline.clip.split',(({clipId,atFrame:23}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));const [left,right]=f.timeline.clips;
 assert.equal(createVolumeEnvelopeEvaluator(left).limitAtSample(23*1600),evaluate.limitAtSample(23*1600));
 assert.equal(createVolumeEnvelopeEvaluator(right).limitAtSample(0),evaluate.limitAtSample(23*1600));
 await f.reopen();assert.deepEqual(f.timeline.clips,[left,right]);await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
 await f.call('timeline.clip.update',(({clipId,patch:{durationFrames:30,volumeEnvelope:null}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));assert.equal((f.timeline.clips[0].volumeEnvelope as unknown),null);
 await f.reopen();assert.equal((f.timeline.clips[0].volumeEnvelope as unknown),null);await f.call('timeline.undo');assert.deepEqual(f.timeline.clips[0],original);
});

test('owned ordinary62 durable invalid source is terminal not_applied with no domain writes',async t=>{
 const f=await fixture(t),input=addInput(f,f.asset({hasAudio:false})),saved=f.prepare('timeline.clip.add',((input) as unknown as Parameters<typeof f.prepare>[1])),before=f.state();
 const done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]));assert.equal(done.task.status,'not_applied');assert.equal(done.task.errorCode,'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED');
 const after=f.state();for(const name of (['timelines','timeline_history','timeline_history_cursors','timeline_requests'] as const))assert.deepEqual(after.tables[name],before.tables[name]);
 await f.reopen();const retained=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(retained.task.status,'not_applied');assert.equal(retained.task.digest,saved.task.digest);
});

for(const phase of (['afterClaim','afterBusinessCommit'] as const))test(`owned ordinary62 ${phase} interruption recovers without dispatch and rejects stale instance`,async t=>{
 const f=await fixture(t),input=addInput(f),saved=f.prepare('timeline.clip.add',((input) as unknown as Parameters<typeof f.prepare>[1]));
 f.setFault((((label: string)=>{if(label===phase)throw Error('Synthetic coordinator interruption');}) as unknown as Parameters<typeof f.setFault>[0]));
 await assert.rejects(f.execute(((saved) as unknown as Parameters<typeof f.execute>[0])),code('EDIT_TASK_STORAGE_UNAVAILABLE'));f.setFault(()=>{});await f.reopen();
 const before=f.state();await assert.rejects(f.execute(((saved) as unknown as Parameters<typeof f.execute>[0])),code('EDIT_TASK_STALE_INSTANCE'));assert.deepEqual(f.state(),before);
 const recovery=f.tasks.reconcileStartup();assert.equal(recovery.unavailable,0);
 const current=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});assert.equal(current.task.digest,saved.task.digest);assert.deepEqual(current.task.input,input);
 assert.notEqual(current.instanceId,saved.instanceId);assert.equal(current.task.status,phase==='afterClaim'?'unknown':'applied');
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,phase==='afterClaim'?0:1);
 const done=await f.execute(((current) as unknown as Parameters<typeof f.execute>[0]));assert.equal(done.task.status,'applied');assert.deepEqual((done.result)!.clips[0].volumeEnvelope,envelope());
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_history').get())!.n,1);
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,1);
});

test('owned restored63 keeps captured evidence immutable and admits envelope writes only in the current origin/epoch',async t=>{
 const f=await fixture(t),asset=f.asset(),added=await f.call('timeline.clip.add',((addInput(f,asset)) as unknown as Parameters<typeof f.call>[1]));
 const clipId=f.timeline.clips[0].id,pending=f.prepare('timeline.clip.update',((f.input({clipId,patch:{volumeEnvelope:null}})) as unknown as Parameters<typeof f.prepare>[1]));
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};
 await f.reopen((db: DatabaseSync)=>{assert.equal(installCurrentWorkspaceRestoreSchema(db,metadata).schemaVersion,63);});
 assert.equal((getWorkspaceRestoreContext(f.store))!.schemaVersion,63);const context={expectedWorkspaceOrigin:metadata.workspaceOrigin},before=f.state();
 assert.deepEqual(await f.services.call('timeline.clip.add',added.input),added.result);assert.deepEqual(f.state(),before);
 const heldRow=f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id);
 assert.equal((heldRow)!.executionEpoch,'captured');
 await assert.rejects(f.execute(((pending) as unknown as Parameters<typeof f.execute>[0]),context),code('RESTORED_RECORD_HELD'));
 await assert.rejects(f.services.call('timeline.clip.update',pending.task.input,context),code('RESTORED_RECORD_HELD'));assert.deepEqual(f.state(),before);
 await assert.rejects(f.services.call('timeline.track.add',f.input({requestId:pending.task.requestId,kind:'audio'}),context),code('RESTORED_RECORD_HELD'));assert.deepEqual(f.state(),before);
 const updates=[{volumeEnvelope:null},{volumeEnvelope:envelope()},{gain:.5}];
 for(const [badContext,expected]of ([[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']] as const)){
  for(const patch of updates){const input=f.input({clipId,patch});
   await assert.rejects(f.services.call('timeline.clip.update',input,badContext),code(expected));
   assert.throws(()=>f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1]),badContext),code(expected));assert.deepEqual(f.state(),before);
  }
  await assert.rejects(f.services.call('timeline.clip.add',addInput(f,asset,{startFrame:60}),badContext),code(expected));assert.deepEqual(f.state(),before);
 }
 await f.call('timeline.clip.update',(({clipId,patch:{gain:.5}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]),context);assert.deepEqual(f.timeline.clips[0].volumeEnvelope,envelope());
 await f.call('timeline.clip.update',(({clipId,patch:{volumeEnvelope:null}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]),context);assert.equal((f.timeline.clips[0].volumeEnvelope as unknown),null);
 await f.call('timeline.clip.update',(({clipId,patch:{volumeEnvelope:envelope()}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]),context);
 await f.call('timeline.clip.add',((addInput(f,asset,{startFrame:60})) as unknown as Parameters<typeof f.call>[1]),context);assert.deepEqual(f.timeline.clips[1].volumeEnvelope,envelope());
 const input=f.input({clipId,patch:{volumeEnvelope:null}}),fresh=f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1]),context);
 assert.equal((fresh.restore)!.executionEpoch,metadata.workspaceOrigin);assert.equal((fresh.restore)!.held,false);
 for(const [badContext,expected]of ([[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']] as const)){
  const state=f.state();await assert.rejects(f.execute(((fresh) as unknown as Parameters<typeof f.execute>[0]),badContext),code(expected));assert.deepEqual(f.state(),state);
 }
 const done=await f.execute(((fresh) as unknown as Parameters<typeof f.execute>[0]),context);assert.equal(done.task.status,'applied');assert.equal(((done.result)!.clips[0].volumeEnvelope as unknown),null);f.ack(((done) as unknown as Parameters<typeof f.ack>[0]),context);
 assert.deepEqual(f.state().tables.workspace_restore_holds,before.tables.workspace_restore_holds);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(pending.task.id),heldRow);
 await f.reopen();assert.equal((getWorkspaceRestoreContext(f.store))!.workspaceOrigin,metadata.workspaceOrigin);assert.equal((f.timeline.clips[0].volumeEnvelope as unknown),null);
 assert.deepEqual(await f.services.call('timeline.clip.update',input),done.result,'retained receipt replays read-only without origin');
});

test('owned ordinary62 durable updates distinguish absent/null/value and retain inherited role/colour fields',async t=>{
 const f=await fixture(t),source=f.asset();
 await f.call('timeline.clip.add',(({assetId:source.id,trackId:f.timeline.tracks[0].id,startFrame:0,durationFrames:60}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));
 const clipId=f.timeline.clips[0].id;assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
 for(const value of ([null,envelope()] as const)){
  const input=f.input({clipId,patch:{volumeEnvelope:value,audioRole:'human',colour:null}}),saved=f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1]));
  const done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]));assert.equal(done.task.status,'applied');assert.deepEqual((done.result)!.clips[0].volumeEnvelope,value);
  assert.equal((done.result)!.clips[0].audioRole,'human');assert.equal(((done.result)!.clips[0].colour as unknown),null);f.ack(((done) as unknown as Parameters<typeof f.ack>[0]));
  await f.reopen();assert.deepEqual(f.timeline.clips[0].volumeEnvelope,value);assert.equal(f.timeline.clips[0].audioRole,'human');
 }
 await f.call('timeline.undo');assert.equal((f.timeline.clips[0].volumeEnvelope as unknown),null);
 await f.call('timeline.undo');assert.equal(Object.hasOwn(f.timeline.clips[0],'volumeEnvelope'),false);
});

for(const phase of (['afterClaim','afterBusinessCommit'] as const))test(`owned restored63 current-epoch ${phase} recovery preserves captured holds and rejects stale instances`,async t=>{
 const f=await fixture(t);await f.call('timeline.clip.add',((addInput(f)) as unknown as Parameters<typeof f.call>[1]));const clipId=f.timeline.clips[0].id;
 const captured=f.prepare('timeline.clip.update',((f.input({clipId,patch:{gain:.75}})) as unknown as Parameters<typeof f.prepare>[1]));
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};
 await f.reopen((db: DatabaseSync)=>installCurrentWorkspaceRestoreSchema(db,metadata));const context={expectedWorkspaceOrigin:metadata.workspaceOrigin};
 const heldRow=f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(captured.task.id),holds=f.state().tables.workspace_restore_holds;
 const input=f.input({clipId,patch:{volumeEnvelope:null}}),saved=f.prepare('timeline.clip.update',((input) as unknown as Parameters<typeof f.prepare>[1]),context);
 f.setFault((((label: string)=>{if(label===phase)throw Error('Synthetic restored coordinator interruption');}) as unknown as Parameters<typeof f.setFault>[0]));
 await assert.rejects(f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]),context),code('EDIT_TASK_STORAGE_UNAVAILABLE'));f.setFault(()=>{});await f.reopen();
 const before=f.state();await assert.rejects(f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]),context),code('EDIT_TASK_STALE_INSTANCE'));assert.deepEqual(f.state(),before);
 assert.equal(f.tasks.reconcileStartup().unavailable,0);const current=f.tasks.get({projectId:f.project.id,taskId:saved.task.id});
 assert.equal(current.task.status,phase==='afterClaim'?'unknown':'applied');assert.equal((current.restore)!.executionEpoch,metadata.workspaceOrigin);assert.deepEqual(current.task.input,input);
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,phase==='afterClaim'?0:1);
 const done=await f.execute(((current) as unknown as Parameters<typeof f.execute>[0]),context);assert.equal(done.task.status,'applied');assert.equal(((done.result)!.clips[0].volumeEnvelope as unknown),null);
 assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM timeline_requests WHERE requestId=?').get(((((input.requestId) as unknown as SQLInputValue | Record<string, SQLInputValue>)) as unknown as Parameters<NonNullable<(ReturnType<(((typeof f)["store"])["db"])["prepare"]>)["get"]>>[0])))!.n,1);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(captured.task.id),heldRow);assert.deepEqual(f.state().tables.workspace_restore_holds,holds);
});

for(const restored of ([false,true] as const))test(`owned ${restored?'restored63':'ordinary62'} complete envelope budget fails atomically before history/redo/receipt/task writes`,async t=>{
 const f=await fixture(t),source=f.asset();await f.call('timeline.clip.add',((addInput(f,source)) as unknown as Parameters<typeof f.call>[1]));
 await f.call('timeline.clip.update',(({clipId:f.timeline.clips[0].id,patch:{gain:.5}}) as unknown as Parameters<NonNullable<(typeof f)["call"]>>[1]));await f.call('timeline.undo');
 // Seed a complete valid boundary-sized synthetic record, not an admission or
 // ownership bypass. Full ordinary62 validation precedes production dispatch.
 const timeline=structuredClone(f.timeline);timeline.revision=9;
 timeline.tracks=Array.from({length:12},(_,i)=>({id:randomUUID(),name:'\x01'.repeat(150),kind:'video',orderIndex:i,hidden:false,muted:false}));
 timeline.clips=(Array.from({length:100},(_,i)=>({id:randomUUID(),trackId:timeline.tracks[0].id,assetId:source.id,name:'\x01'.repeat(200),startFrame:i*180,durationFrames:180,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,fadeInFrames:0,fadeOutFrames:0,colour:null,volumeEnvelope:{profileId:VOLUME_ENVELOPE_PROFILE as typeof VOLUME_ENVELOPE_PROFILE,points:Array.from({length:16},(_,j)=>({frame:j*12,multiplier:.12345678901234567}))}})) as unknown as (typeof timeline)["clips"]);
 timeline.durationFrames=18000;timeline.subtitles={profileId:'bottom_cjk_v1',cues:Array.from({length:100},(_,i)=>({id:randomUUID(),text:'中'.repeat(20)+'\n'+'中'.repeat(20),startFrame:i*180,durationFrames:180}))};
 let excess=Buffer.byteLength(JSON.stringify(timeline))-262144;assert.ok(excess>20);
 for(const clip of timeline.clips){while(excess>=6&&(clip.name)!.length>1){clip.name=(clip.name)!.slice(1);excess-=6;}if(excess<6)break;}
 if(excess)timeline.tracks[0].name=(timeline.tracks[0].name)!.slice(1)+'a'.repeat(6-excess);
 assert.equal(Buffer.byteLength(JSON.stringify(timeline)),262144);f.store.put('timelines',timeline);validateWorkspaceSchema62(f.store.db);
 let context;
 if(restored){const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-15T00:00:00.000Z'};await f.reopen((db: DatabaseSync)=>installCurrentWorkspaceRestoreSchema(db,metadata));context={expectedWorkspaceOrigin:metadata.workspaceOrigin};}
 const input=f.input({expectedRevision:9,trackId:timeline.tracks[0].id,patch:{muted:false}}),before=f.state();
 await assert.rejects(f.services.call('timeline.track.update',input,context),error=>{
  assert.equal((error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).code,'TIMELINE_VOLUME_ENVELOPE_LIMIT');assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.track.update'}),true);
  assert.equal(hasRequestNotAppliedProof(error,{...input,requestId:randomUUID()},{operation:'timeline.track.update'}),false);return true;
 });
 assert.deepEqual(f.state(),before,'all tables, raw storage, history cursor, redo and tasks remain identical');assert.equal(f.store.db.isTransaction,false);
 const saved=f.prepare('timeline.track.update',((input) as unknown as Parameters<typeof f.prepare>[1]),context),prepared=f.state(),done=await f.execute(((saved) as unknown as Parameters<typeof f.execute>[0]),context);
 assert.equal(done.task.status,'not_applied');assert.equal(done.task.errorCode,'TIMELINE_VOLUME_ENVELOPE_LIMIT');
 const after=f.state();assert.deepEqual(after.objects,prepared.objects);for(const name of Object.keys(prepared.tables))if(name!=='edit_tasks')assert.deepEqual(after.tables[name],prepared.tables[name],name);
});
