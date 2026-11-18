import {beginFixtureToolStep} from './helpers/mio-model-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {JobRecord} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {withAgentTaskJobOrigin,allowAgentTaskJobTargetMutation,setAgentTaskEffectGate,setAgentTaskJobResumer,assertAgentTaskJobEffect} from '../packages/business/src/agent/task-effects-v2.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {authorizeTestScope} from './helpers/agent-authorizations.ts';
import {object,revisionField,gate,output,call,fixture,recordedHints,setRestartReason,m4PauseFromApproval,m4ConflictPause,lateSelectionFixture} from './helpers/agent-task-runtime-fixture.ts';

for(const protocol of ['chat_completions','responses'] as const)for(const recovery of ['none','preserved','legacy'] as const)test(`${protocol}: ${recovery} background conflict recovery cannot cross an ABA before submit; skip cancels the old job and replans once`,async t=>{
 const entered=gate(),release=gate();let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){entered.resolve();await release.promise;context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-must-not-send'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,protocol,providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send();await f.settle(sent.run.id);const jobId=String(object(f.store.list('jobs',f.projectId)[0]).id);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id),step=waiting.steps.find(item=>item.approvalRequired);assert.ok(step);await f.action(waiting,'approve',{stepId:step.id});await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Synthetic provider did not reach before-submit barrier');})]);
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual after approval'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:f.first.prompt}});release.resolve();
  await worker.tick();let paused=await f.wait(sent.run.id,['paused']);assert.equal(paused.run.pauseReason,'conflict');assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('jobs',jobId)).status,'queued');const marked=paused.steps.find(item=>item.id===step.id);assert.equal(marked?.status,'completed');assert.equal(marked?.display?.conflict,true);assert.equal(marked?.data,undefined);assert.equal(f.runtime.journal.step(step.id).display,undefined);
  if(recovery!=='none'){
   f.restart();let interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
   if(recovery==='legacy'){setRestartReason(f,sent.run.id);interrupted=f.runtime.get(f.projectId,sent.run.id);}
   let wakeups=0;const removeResumer=setAgentTaskJobResumer(f.store.db,'synthetic-background-conflict-resume',()=>{wakeups++;});t.after(removeResumer);
   await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);
   const control={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'};paused=await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'conflict');assert.equal(paused.run.budget,interrupted.run.budget);assert.equal(wakeups,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(posts,0);
   const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(wakeups,0);await worker.tick();assert.equal(posts,0);assert.equal(object(f.store.get('jobs',jobId)).status,'queued');
  }
  await f.action(paused,'skip');const replanned=await f.settle(sent.run.id);assert.equal(replanned.run.status,'completed');assert.equal(replanned.backgroundPending,false);assert.ok(replanned.steps.every(item=>item.display?.conflict===undefined));assert.equal(f.requests.length,(3)+f.loadingRequests);assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);await worker.tick();assert.equal(posts,0);
 }finally{release.resolve();await worker.stop();}
});
test('a denied background approval invalidates its live source batch before the next tool and preserves later work',async t=>{
 const f=await lateSelectionFixture(t,'deny',{holdAcceptedGeneration:true,sourceSuffix:true});
 try{
  const accepted=f.runtime.journal.step(f.generationStepId),sourceId=object(accepted.data).sourceModelStepId;assert.equal(typeof sourceId,'string');assert.equal(accepted.status,'completed');
  assert.equal(f.runtime.journal.snapshot(f.sent.run.id).steps.some(step=>step.toolCall?.id==='old-batch-suffix'),false);
  f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
  assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'job',f.jobId),{code:'AGENT_TASK_APPROVAL_REQUIRED'});
  const waiting=f.runtime.get(f.projectId,f.sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.steps.find(step=>step.id===f.generationStepId)?.approvalRequired,true);
  const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action:'deny',stepId:f.generationStepId};
  await f.runtime.action(f.projectId,f.sent.run.id,request);
  const invalidated=f.runtime.journal.step(sourceId as string);assert.equal(object(invalidated.data).toolsInvalidated,true);assert.equal(object(invalidated.data).toolsInvalidatedReason,'user_rejected');
  f.generationRelease.resolve();await f.secondEntered.promise;
  const afterSource=f.runtime.get(f.projectId,f.sent.run.id);
  assert.equal(afterSource.steps.some(step=>step.toolCall?.id==='old-batch-suffix'),false,'the live executor must read the saved batch decision before preparing its suffix');
  assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');
  assert.ok(f.scriptRequest(2).body.includes('USER_REJECTED'),'the next model sees why its old suffix was not executed');
  assert.equal([...f.effects.values()].filter(operation=>operation==='generation.submit').length,1,'the accepted prefix is not dispatched twice');
  await f.runtime.action(f.projectId,f.sent.run.id,request);
  f.secondRelease.resolve();await f.thirdEntered.promise;
  assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other target continues','a later independent model keeps its own execution scope');
  f.thirdRelease.resolve();const done=await f.settle(f.sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.steps.find(step=>step.id===f.generationStepId)?.status,'completed');
  assert.equal(object(f.runtime.journal.step(f.generationStepId).data).backgroundDenied,true);assert.equal(f.submissions,0);
  assert.equal([...f.effects.values()].filter(operation=>operation==='generation.submit').length,1);assert.equal([...f.effects.values()].filter(operation=>operation==='shot.update').length,1);
 }finally{f.release();await f.runtime.drain();}
});
for(const mode of ['skip','deny'] as const)test(`a late ${mode==='skip'?'skipped-target':'denied-background'} result stays recorded without pausing unrelated work`,async t=>{
 const f=await lateSelectionFixture(t,mode);try{
  if(mode==='skip'){
   // X4 hands a foreground conflict back; stop the stale call at approval to reach M4's pause.
   const modes=f.runtime.policy().modes;f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...modes,local_reversible:'confirm'}});f.secondRelease.resolve();const waiting=await f.settle(f.sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');
   await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual content kept'}});f.runtime.journal.updatePolicy({...f.runtime.policy(),modes});const paused=m4PauseFromApproval(f,f.sent.run.id,'conflict');assert.equal(paused.run.pauseReason,'conflict');const changes=paused.changes;
   const skipped=await f.action(paused,'skip');assert.deepEqual(skipped.changes,changes);assert.equal(skipped.run.skippedTargets?.length,1);await f.thirdEntered.promise;
  }else{
   f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'job',f.jobId),{code:'AGENT_TASK_APPROVAL_REQUIRED'});f.secondRelease.resolve();await f.runtime.drain();const waiting=f.runtime.get(f.projectId,f.sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');await f.action(waiting,'deny',{stepId:f.generationStepId});await f.thirdEntered.promise;assert.equal(object(f.runtime.journal.step(f.generationStepId).data).backgroundDenied,true);
  }
  const before=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(before.run.status,'running');assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);const after=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(after.run.status,'running');assert.deepEqual(after.run.skippedTargets,before.run.skippedTargets);assert.deepEqual(after.changes,before.changes);
  if(mode==='skip'){
   const original=f.runtime.journal.step(f.generationStepId);f.runtime.journal.updateStep(f.sent.run.id,original.id,{targets:[...(original.targets??[]),{kind:'shot',id:f.other.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.other.id)}]});
   assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.other.id}),false);assert.equal(f.runtime.journal.run(f.sent.run.id).status,'running');assert.equal(f.runtime.journal.run(f.sent.run.id).skippedTargets?.some(item=>item.target.id===f.other.id),false);
  }
  const handled=recordedHints(f,f.sent.run.id,'background_selection_skipped').at(-1);assert.ok(handled);assert.equal(handled.reason,mode==='skip'?'target_skipped':'background_denied');
  const current=f.store.get('jobs',f.jobId) as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',f.jobId,()=>f.services.saveJob(current,{status:'succeeded',phase:'complete',progress:100,error:null}));assert.equal(object(f.store.get('jobs',f.jobId)).status,'succeeded');assert.equal(f.runtime.journal.run(f.sent.run.id).status,'running');
  f.release();const done=await f.settle(f.sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,false);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other target continues');assert.equal(object(f.store.get('shots',f.first.id)).prompt,mode==='skip'?'manual content kept':'saved first');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a late unhandled target conflict still pauses with actual source evidence while retaining the result',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unhandled manual edit'}});assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);const paused=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'conflict');assert.deepEqual(paused.run.skippedTargets,[]);const source=object(f.runtime.journal.step(f.generationStepId).data);assert.equal(source.backgroundInvalidated,true);assert.ok(Array.isArray(source.conflictTargets)&&source.conflictTargets.some(target=>object(target).kind==='shot'&&object(target).id===f.first.id));
  const job=f.store.get('jobs',f.jobId) as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',f.jobId,()=>f.services.saveJob(job,{status:'succeeded',phase:'complete',progress:100,error:null}));assert.equal(object(f.store.get('jobs',f.jobId)).status,'succeeded');assert.equal(f.runtime.journal.run(f.sent.run.id).status,'paused');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'unhandled manual edit');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a late selection denied by revoked authorization reads no target and resumes only after reauthorization',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  await f.revoke();const prepare=f.store.db.prepare.bind(f.store.db);let targetReads=0;
  f.store.db.prepare=(sql:string)=>{if(/\bFROM\s+(?:shots|agent_task_target_revisions_v2|mio_edit_claims)\b/iu.test(sql))targetReads++;return prepare(sql);};
  try{assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);}finally{f.store.db.prepare=prepare;}
  assert.equal(targetReads,0);const denied=f.runtime.journal.snapshot(f.sent.run.id);assert.equal(denied.run.status,'paused');assert.equal(denied.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.deepEqual(denied.run.skippedTargets,[]);assert.equal(object(f.runtime.journal.step(f.generationStepId).data).conflictTargets,undefined);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);
  f.release();await f.runtime.drain();await authorizeTestScope(f.authorizations,'project_agent');await f.action(f.runtime.get(f.projectId,f.sent.run.id),'resume');const done=await f.settle(f.sent.run.id);assert.equal(done.run.status,'completed');assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other target continues');assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
test('a stopped run still rejects late selection without changing its terminal status or another target',async t=>{
 const f=await lateSelectionFixture(t,'unhandled');try{
  const stopped=await f.action(f.runtime.get(f.projectId,f.sent.run.id),'stop');assert.equal(stopped.run.status,'stopped');assert.equal(allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),false);assert.equal(f.runtime.journal.run(f.sent.run.id).status,'stopped');assert.deepEqual(f.runtime.journal.run(f.sent.run.id).skippedTargets,[]);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(f.submissions,0);
 }finally{f.release();await f.runtime.drain();}
});
for(const failure of ['SQLITE_IOERR','UNRECOGNIZED_GATE_FAILURE'] as const)test(`late selection propagates ${failure} instead of disguising it as a handled choice`,async t=>{
 const f=await lateSelectionFixture(t,'unhandled'),injected=Object.assign(Error('Synthetic late gate failure'),{code:failure}),remove=setAgentTaskEffectGate(f.store.db,()=>{throw injected;});try{
  const before=f.runtime.journal.snapshot(f.sent.run.id);assert.throws(()=>allowAgentTaskJobTargetMutation(f.store.db,'job',f.jobId,{kind:'shot',id:f.first.id}),error=>error===injected);assert.deepEqual(f.runtime.journal.snapshot(f.sent.run.id),before);assert.equal(f.effects.size,2);assert.equal(f.loadingEffects,1);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.submissions,0);await f.action(f.runtime.get(f.projectId,f.sent.run.id),'stop');
 }finally{remove();f.release();await f.runtime.drain();}
});

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: skipping a track also denies later nested clip references without blocking another target`,async t=>{
 const f=await fixture(t,protocol),assetId=randomUUID();
 f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,duration:0,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:'media/fixture.png',provenance:'user-import',createdAt:new Date().toISOString()});
 const readTimeline=()=>object(JSON.parse(String(f.store.db.prepare('SELECT data FROM timelines WHERE projectId=?').get(f.projectId)!.data)));
 const initial=object(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(initial.tracks));const sourceTrack=String(object(initial.tracks[0]).id);
 await f.services.call('timeline.track.add',{projectId:f.projectId,requestId:randomUUID(),kind:'video',name:'Kept track',expectedRevision:revisionField(initial)});
 await f.services.call('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),assetId,trackId:sourceTrack,expectedRevision:revisionField(readTimeline()),startFrame:0,durationFrames:30});
 const saved=readTimeline();assert.ok(Array.isArray(saved.tracks)&&Array.isArray(saved.clips));const clipId=String(object(saved.clips[0]).id),targetTrack=String(object(saved.tracks.find(value=>object(value).name==='Kept track')).id),timelineRevision=revisionField(saved);
 const {sent,paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'timeline_track',id:targetTrack},protocol,ownerId:'kept-track-draft',loadGroups:['canvas','editing'],calls:[call('mioon_timeline_track_update',{trackId:targetTrack,expectedRevision:timelineRevision,patch:{name:'Never rename'}})],script:index=>index===2?[call('mioon_timeline_clip_update',{clipId,expectedRevision:timelineRevision,patch:{trackId:targetTrack}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:f.other.revision,patch:{prompt:'unrelated target still works'}})]:[]});assert.equal(paused.run.pauseReason,'editing');await f.action(paused,'skip');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.length,1);assert.equal(done.run.skippedTargets?.[0]?.target.id,targetTrack);assert.equal(done.changes.length,1);assert.equal(done.changes[0]?.operation,'shot.update');
 const rejected=done.steps.find(step=>step.toolCall?.name==='mioon_timeline_clip_update');assert.equal(rejected?.status,'denied');assert.equal(rejected?.error?.code,'TARGET_SKIPPED');const final=readTimeline();assert.ok(Array.isArray(final.clips));assert.equal(object(final.clips.find(value=>object(value).id===clipId)).trackId,sourceTrack);assert.equal(f.runtime.journal.claims(f.projectId).length,1);assert.equal(f.requests.length,4);assert.equal(f.loadingRequests,1);
});

for(const metadata of ['saved','legacy'] as const)test(`background effect gates reject skipped nested references from ${metadata} accepted steps`,async t=>{
 const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(){entered.resolve();await release.promise;yield {type:'done',output:output('responses')};});
 const sent=await f.send();await entered.promise;
 try{
  const reference={kind:'asset',id:randomUUID(),revision:0},target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)};
  const tool=beginFixtureToolStep(f.runtime.journal,sent.run.id,{targets:[target],toolCall:call('mioon_image_generate',{purpose:'edit',inputImage:{assetId:reference.id,sha256:'a'.repeat(64)}}),...(metadata==='saved'?{data:{referencedTargets:[reference]}}:{})});
  f.runtime.journal.markDispatch(sent.run.id,tool.id);f.runtime.journal.completeStep(sent.run.id,tool.id,{result:{accepted:true}});
  const conflict=beginFixtureToolStep(f.runtime.journal,sent.run.id,{targets:[reference],data:{conflictTargets:[reference]}});
  f.store.tx(()=>{f.runtime.journal.skipTargetsInside(sent.run.id,[{stepId:conflict.id,target:reference}]);f.store.db.prepare('INSERT INTO mio_job_origins(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('image','synthetic-pending-image',sent.run.id,tool.id,f.projectId,tool.id,'image.generate');});
  assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'image','synthetic-pending-image'),{code:'AGENT_TASK_TARGET_SKIPPED'});assert.equal(f.runtime.journal.run(sent.run.id).status,'running');assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);
 }finally{release.resolve();await f.settle(sent.run.id);}
});
