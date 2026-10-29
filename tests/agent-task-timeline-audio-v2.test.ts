import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {AGENT_TASK_OPERATION_ADMISSION,agentTaskExplicitTargets,createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {agentTaskToolGroupForName} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_TOOL_SCHEMAS} from '../packages/business/src/agent/task-tool-schemas-v2.ts';
import {agentTaskDisplayTargetReader,projectAgentTaskChangeDisplay,projectAgentTaskStepDisplay} from '../packages/business/src/agent/task-display-v2.ts';
import type {AgentTaskChange,AgentTaskJson,AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

type Row=Record<string,unknown>;
interface Clip {id:string;trackId:string;startFrame:number;durationFrames:number;gain?:number;volumeEnvelope?:unknown}
interface Timeline {revision:number;tracks:{id:string;kind:string}[];clips:Clip[]}
const CROSSFADE='timeline.clip.crossfade',GAINS='timeline.clip.setGains';
const db=(gain:number)=>gain===0?'muted':20*Math.log10(gain);

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-task-audio-'))),store=openStore(root),services=createServices(store,new Map());
 const call=async<T=Row>(operation:string,input:unknown):Promise<T>=>await services.call(operation,input) as T;
 const projectId=(await call<{id:string}>('project.create',{name:'Audio tools'})).id;
 const journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
 const run=journal.create({requestId:randomUUID(),projectId,text:'synthetic audio task',configuration:{}}).run;
 t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const name=(operation:string)=>tools.list().find(tool=>tool.operation===operation)!.name;
 const timeline=()=>call<Timeline>('timeline.get',{projectId});
 const clip=async(id:string)=>(await timeline()).clips.find(item=>item.id===id)!;
 // A sounding WAV the clip checks accept; only its recorded metadata is read.
 function asset(kind:'audio'|'image'='audio'):string{
  const bytes=Buffer.from(`${kind} ${randomUUID()}`),id=randomUUID(),extension=kind==='audio'?'wav':'png',relativePath=`media/${id}.${extension}`;
  writeFileSync(path.join(root,relativePath),bytes,{mode:0o600});
  const media=kind==='audio'?{mimeType:'audio/wav',duration:20,hasAudio:true}:{mimeType:'image/png',width:720,height:1280};
  store.put('assets',{id,projectId,name:`${kind==='audio'?'对白':'海报'}-${id.slice(0,4)}.${extension}`,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,relativePath,provenance:'user-import',...media});
  return id;
 }
 async function track():Promise<string>{
  const current=await timeline();
  return (await call<Timeline>('timeline.track.add',{projectId,expectedRevision:current.revision,requestId:randomUUID(),kind:'audio'})).tracks.at(-1)!.id;
 }
 async function add(assetId:string,trackId:string,startFrame:number,durationFrames:number):Promise<Clip>{
  const current=await timeline();
  return (await call<Timeline>('timeline.clip.add',{projectId,expectedRevision:current.revision,requestId:randomUUID(),assetId,trackId,startFrame,durationFrames})).clips.at(-1)!;
 }
 // Two sounding clips on two tracks: b starts 60 frames into a (90 frames long) and runs past its end.
 async function pair(at=0){
  const first=(await timeline()).tracks.find(item=>item.kind==='audio')!.id,second=await track();
  return {a:await add(asset(),first,at,90),b:await add(asset(),second,at+60,90)};
 }
 const prepare=(operation:string,input:Row)=>tools.prepare({projectId,operation:name(operation),input});
 async function execute(operation:string,input:Row){
  const prepared=prepare(operation,input);
  const step=journal.beginStep(run.id,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:name(operation),arguments:JSON.parse(JSON.stringify(input)) as AgentTaskJson}});
  journal.markDispatch(run.id,step.id);
  const outcome=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,beforeEffect:()=>journal.assertTargets(projectId,prepared.targets),
   recordInside:(result,changes)=>journal.completeStepInside(run.id,step.id,{result,changes}),appendChangesInside:changes=>journal.appendChangesInside(run.id,step.id,changes)});
  if(!outcome.recorded)journal.completeStep(run.id,step.id,{result:outcome.result,changes:outcome.changes});
  return {result:journal.step(step.id).result,changes:journal.snapshot(run.id).changes.filter(change=>change.stepId===step.id),stepId:step.id};
 }
 const undo=(change:AgentTaskChange)=>tools.undo(change,{beforeEffect:()=>{},recordInside:item=>{journal.markChangeRevertedInside(item.id);},retainInside:(item,reason)=>{journal.markChangeRetainedInside(item.id,reason);}});
 return {store,call,projectId,journal,tools,run,name,timeline,clip,asset,add,pair,prepare,execute,undo};
}

test('Mio crossfades with the editing tools and sets several gains with the audio tools, both local and reversible',async t=>{
 const f=await fixture(t),tools=f.tools.list(),find=(operation:string)=>tools.find(tool=>tool.operation===operation)!;
 assert.deepEqual([CROSSFADE,GAINS].map(operation=>[find(operation).name,find(operation).risk,find(operation).undo,agentTaskToolGroupForName(find(operation).name)]),
  [['mioon_timeline_clip_crossfade','local_reversible','target compensation','editing'],['mioon_timeline_clip_setGains','local_reversible','target compensation','audio']]);
 for(const operation of [CROSSFADE,GAINS]){
  assert.deepEqual((AGENT_TASK_OPERATION_ADMISSION as Record<string,unknown>)[operation],{allowed:true,tier:'local_reversible'});
  const parameters=find(operation).parameters as {properties:Row};
  assert.equal(parameters,AGENT_TASK_TOOL_SCHEMAS[operation],'the shared generated schema, unchanged');
  for(const field of ['projectId','requestId'])assert.equal(Object.hasOwn(parameters.properties,field),false,field);
 }
 assert.equal((AGENT_TASK_OPERATION_ADMISSION as Record<string,{allowed:boolean}>)['timeline.clip.setTransform'].allowed,false,'transforms stay with the user');
 const [a,b,c]=[randomUUID(),randomUUID(),randomUUID()];
 assert.deepEqual(agentTaskExplicitTargets('mioon_timeline_clip_crossfade',{expectedRevision:3,outgoingClipId:a,incomingClipId:b},f.projectId),[{kind:'timeline_clip',id:a},{kind:'timeline_clip',id:b}]);
 assert.deepEqual(agentTaskExplicitTargets('mioon_timeline_clip_setGains',{expectedRevision:3,gains:[{clipId:a,gain:1},{clipId:c,gain:0.5}]},f.projectId),[{kind:'timeline_clip',id:a},{kind:'timeline_clip',id:c}]);
});

test('a Mio crossfade writes both clips as one change that one undo restores, and a later edit keeps it',async t=>{
 const f=await fixture(t),{a,b}=await f.pair(),start=await f.timeline();
 const prepared=f.prepare(CROSSFADE,{expectedRevision:start.revision,outgoingClipId:a.id,incomingClipId:b.id});
 assert.deepEqual([prepared.risk,prepared.targets.map(item=>[item.kind,item.id])],['local_reversible',[['timeline_clip',a.id],['timeline_clip',b.id]]]);
 const {result,changes}=await f.execute(CROSSFADE,{expectedRevision:start.revision,outgoingClipId:a.id,incomingClipId:b.id});
 assert.ok(result&&typeof result==='object'&&!Array.isArray(result));
 assert.deepEqual((result as Row).crossfade,{outgoingClipId:a.id,incomingClipId:b.id,startFrame:60,durationFrames:30});
 const crossed=await f.timeline();
 assert.equal(crossed.revision,start.revision+1);
 assert.deepEqual([(await f.clip(a.id)).volumeEnvelope,(await f.clip(b.id)).volumeEnvelope].map(curve=>(curve as {points:unknown[]}).points),
  [[{frame:60,multiplier:1},{frame:90,multiplier:0}],[{frame:0,multiplier:0},{frame:30,multiplier:1}]]);
 assert.equal(changes.length,1);const change=changes[0]!;
 assert.deepEqual([change.operation,change.reversible,change.targets.map(item=>[item.kind,item.id])],[CROSSFADE,true,[['timeline_clip',a.id],['timeline_clip',b.id]]]);
 const display=projectAgentTaskChangeDisplay(change);
 assert.deepEqual([display.operation,display.targetCount,display.fields],[CROSSFADE,2,[]],'the curves are named by the operation; no clip field moved');
 f.undo(change);
 assert.deepEqual([await f.clip(a.id),await f.clip(b.id)],[a,b],'one undo restores both clips');
 assert.equal((await f.timeline()).revision,crossed.revision+1);
 assert.equal(f.journal.snapshot(f.run.id).changes.find(item=>item.id===change.id)?.status,'reverted');
 // Crossfaded again, then the user turns one clip down: the pair is no longer Mio's to restore.
 const again=(await f.execute(CROSSFADE,{expectedRevision:(await f.timeline()).revision,outgoingClipId:a.id,incomingClipId:b.id})).changes[0]!;
 const edited=await f.timeline();
 await f.call('timeline.clip.update',{projectId:f.projectId,expectedRevision:edited.revision,clipId:b.id,patch:{gain:0.5},requestId:randomUUID()});
 assert.throws(()=>f.undo(again),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.equal(((await f.clip(a.id)).volumeEnvelope as {points:unknown[]}).points.length,2,'the crossfade stays');
});

test('a refused crossfade is not applied, a clip changed after planning stops it, and an unknown one is checked against the receipts',async t=>{
 const f=await fixture(t),{a,b}=await f.pair();
 // b already has a curve of its own; the first version never replaces it.
 const curved=await f.timeline();
 await f.call('timeline.clip.update',{projectId:f.projectId,expectedRevision:curved.revision,clipId:b.id,patch:{volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:[{frame:0,multiplier:0.5},{frame:90,multiplier:1}]}},requestId:randomUUID()});
 const before=await f.timeline();
 await assert.rejects(f.execute(CROSSFADE,{expectedRevision:before.revision,outgoingClipId:a.id,incomingClipId:b.id}),
  (error:{code?:string;details?:Row})=>error.code==='CROSSFADE_ENVELOPE_EXISTS'&&error.details?.mutationOutcome==='not_applied');
 assert.deepEqual(await f.timeline(),before,'nothing was written');
 assert.throws(()=>f.prepare(CROSSFADE,{expectedRevision:before.revision,outgoingClipId:a.id,incomingClipId:randomUUID()}),{code:'AGENT_TASK_INVALID_TARGET'});
 // The host checks the two clips, not the whole timeline: a change to either clip after planning stops the step,
 // while the model's timeline revision going stale is no conflict of its own.
 const moved=await f.pair(300),planned={expectedRevision:(await f.timeline()).revision,outgoingClipId:moved.a.id,incomingClipId:moved.b.id},early=f.prepare(CROSSFADE,planned);
 await f.call('timeline.clip.update',{projectId:f.projectId,expectedRevision:planned.expectedRevision,clipId:moved.b.id,patch:{gain:0.8},requestId:randomUUID()});
 const blocked=f.journal.beginStep(f.run.id,{kind:'tool',tier:early.risk,targets:early.targets,toolCall:{id:randomUUID(),name:'mioon_timeline_clip_crossfade',arguments:planned as unknown as AgentTaskJson}});
 f.journal.markDispatch(f.run.id,blocked.id);
 await assert.rejects(f.tools.execute(early,{runId:f.run.id,stepId:blocked.id,requestId:blocked.id,beforeEffect:()=>f.journal.assertTargets(f.projectId,early.targets),recordInside:()=>assert.fail('nothing to record')}),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.deepEqual(await f.clip(moved.a.id),moved.a,'nothing was written');
 const replanned=await f.execute(CROSSFADE,planned);
 assert.deepEqual((replanned.result as Row).crossfade,{outgoingClipId:moved.a.id,incomingClipId:moved.b.id,startFrame:360,durationFrames:30});
 // An unknown save: absent receipt proves nothing ran; a present one keeps the step for inspection.
 const fresh=await f.pair(600),input={expectedRevision:(await f.timeline()).revision,outgoingClipId:fresh.a.id,incomingClipId:fresh.b.id};
 const prepared=f.prepare(CROSSFADE,input);
 const step=f.journal.beginStep(f.run.id,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:'mioon_timeline_clip_crossfade',arguments:input as unknown as AgentTaskJson}});
 f.journal.markDispatch(f.run.id,step.id);f.journal.updateStep(f.run.id,step.id,{status:'unknown'});
 assert.deepEqual(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),{outcome:'not_applied',reason:'atomic_receipt_absent'});
 await f.call(CROSSFADE,{projectId:f.projectId,...input,requestId:step.id});
 assert.equal(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),null,'a retained receipt keeps the step for inspection');
});

test('a Mio gain batch shows each planned and saved gain, stops on a held clip, and one undo restores every clip',async t=>{
 const f=await fixture(t),{a,b}=await f.pair(),start=await f.timeline();
 const input={expectedRevision:start.revision,gains:[{clipId:a.id,gain:0.5},{clipId:b.id,gain:0}]};
 const prepared=f.prepare(GAINS,input);
 assert.deepEqual(prepared.targets.map(item=>[item.kind,item.id]),[['timeline_clip',a.id],['timeline_clip',b.id]]);
 // Before it runs (a confirmation or a conflict), each listed clip shows its planned and current gain.
 const planned=projectAgentTaskStepDisplay({toolCall:{id:randomUUID(),name:'mioon_timeline_clip_setGains',arguments:input},targets:prepared.targets} as unknown as AgentTaskStep,agentTaskDisplayTargetReader(f.store,f.projectId),true);
 assert.deepEqual(planned?.fields.map(field=>[field.targetIndex,field.property,field.after,field.current]),[[0,'gainDb',db(0.5),0],[1,'gainDb','muted',0]]);
 // The user is editing a in the timeline: the batch waits for the clip instead of writing past it.
 const target={kind:'timeline_clip',id:a.id,revision:f.journal.targetRevision(f.projectId,'timeline_clip',a.id)},ownerId=randomUUID();
 f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 await assert.rejects(f.execute(GAINS,input),{code:'AGENT_TASK_TARGET_CLAIMED'});
 assert.deepEqual(await f.timeline(),start,'nothing was saved while the clip was held');
 f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
 const {changes}=await f.execute(GAINS,input);
 assert.deepEqual([(await f.clip(a.id)).gain,(await f.clip(b.id)).gain],[0.5,0]);
 assert.equal(changes.length,1);const change=changes[0]!;
 assert.deepEqual([change.operation,change.reversible,change.targets.map(item=>item.id)],[GAINS,true,[a.id,b.id]]);
 assert.deepEqual(projectAgentTaskChangeDisplay(change).fields.map(field=>[field.targetIndex,field.property,field.before,field.after]),[[0,'gainDb',0,db(0.5)],[1,'gainDb',0,'muted']]);
 f.undo(change);
 assert.deepEqual([await f.clip(a.id),await f.clip(b.id)],[a,b],'one undo restores every listed clip');
 await assert.rejects(f.execute(GAINS,{expectedRevision:(await f.timeline()).revision,gains:[{clipId:a.id,gain:a.gain??1}]}),
  (error:{code?:string;details?:Row})=>error.code==='CLIP_GAINS_UNCHANGED'&&error.details?.mutationOutcome==='not_applied');
 const image=await f.add(f.asset('image'),(await f.timeline()).tracks.find(item=>item.kind==='video')!.id,0,30);
 await assert.rejects(f.execute(GAINS,{expectedRevision:(await f.timeline()).revision,gains:[{clipId:a.id,gain:0.8},{clipId:image.id,gain:0.8}]}),
  (error:{code?:string;details?:Row})=>error.code==='CLIP_GAINS_AUDIO_UNSUPPORTED'&&error.details?.mutationOutcome==='not_applied');
});
