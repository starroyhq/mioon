import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import type {JobRecord} from '../packages/business/src/services.ts';
import {createImageSettings} from '../packages/business/src/images/settings.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {defaultVideoModels,VIDEO_PROVIDER_NAMES} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {createTestSecretCodec,testSecretStorage} from './helpers/secret-codec.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {withAgentTaskJobOrigin,setAgentTaskEffectGate,assertAgentTaskJobEffect,isAgentTaskEffectBlocked} from '../packages/business/src/agent/task-effects-v2.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {object,shot,output,call,fixture} from './helpers/agent-task-runtime-fixture.ts';

for(const reason of ['safety_limit','revocation','audit_failure'] as const)test(reason==='audit_failure'?'an agent audit write failure still stops the worker before unrelated exports':`a queued agent export blocked by ${reason} cannot starve a manual export in the same project`,async t=>{
 const f=await fixture(t,'responses',new Map(),{safetyStepLimit:4}),source=png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]});
 async function prepareTimeline(projectId:string){
  const asset=object(await f.services.call('asset.import',{projectId,name:'Synthetic source.png',mimeType:'image/png',dataBase64:source.toString('base64')}));
  const timeline=object(await f.services.call('timeline.get',{projectId}));assert.ok(Array.isArray(timeline.tracks));
  await f.services.call('timeline.clip.add',{projectId,requestId:randomUUID(),expectedRevision:timeline.revision,assetId:asset.id,trackId:object(timeline.tracks[0]).id,startFrame:0,durationFrames:6});
 }
 await prepareTimeline(f.projectId);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,modes:{...f.runtime.policy().modes,local_irreversible:'direct'}});
 f.setScript(async function*(){yield {type:'done',output:output('responses',[call('mioon_timeline_render',{expectedRevision:2,purpose:'export'})])};},{loadGroups:['exports']});
 const sent=await f.send(),paused=await f.settle(sent.run.id);assert.equal(paused.run.status,'paused');assert.equal(paused.run.pauseReason,'safety_limit');assert.equal(paused.backgroundPending,true);
 const blocked=object(f.store.list('exports',f.projectId)[0]);assert.equal(blocked.status,'queued');
 // A store holds one project, so the manual export is queued in the same project, behind the blocked Mio export.
 const accepted=object(await f.services.call('timeline.render',{projectId:f.projectId,expectedRevision:2,requestId:randomUUID(),purpose:'export'}));
 assert.equal(f.store.db.prepare('SELECT id FROM exports ORDER BY rowid LIMIT 1').get()?.id,blocked.id,'the paused export is the first worker candidate');
 if(reason==='revocation')await f.revoke();
 if(reason==='audit_failure'){
  f.store.db.exec("CREATE TEMP TRIGGER test_block_worker_audit BEFORE INSERT ON mio_events BEGIN SELECT RAISE(ABORT,'synthetic agent audit failure');END;");
  const remove=setAgentTaskEffectGate(f.store.db,()=>{f.store.db.prepare('INSERT INTO mio_events(runId,sequence,createdAt) VALUES(?,?,?)').run(sent.run.id,1000000,new Date().toISOString());});t.after(remove);
  assert.throws(()=>assertAgentTaskJobEffect(f.store.db,'export',String(blocked.id)),error=>isAgentTaskEffectBlocked(error)&&/synthetic agent audit failure/.test(String(error)));
 }
 const worker=startWorker(f.store,f.services,new Map());
 try{
  await worker.tick();assert.equal(object(f.store.get('exports',String(accepted.id))).status,reason==='audit_failure'?'queued':'succeeded');
  await worker.tick();assert.deepEqual(f.store.get('exports',String(blocked.id)),blocked,'the paused export was never claimed or started');
  assert.deepEqual(f.runtime.get(f.projectId,sent.run.id),paused);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(1)+f.loadingEffects);
  assert.equal(f.store.list('assets',f.projectId).length,reason==='audit_failure'?1:2);
  assert.equal(f.store.list('exports',f.projectId).length,2);
  const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);await worker.tick();assert.equal(f.requests.length,(1)+f.loadingRequests);
  assert.equal(f.store.list('exports',f.projectId).length,2);
 }finally{await worker.stop();}
});
test('restart interrupts a completed model run with a queued bound job before the worker can submit',async t=>{
 let posts=0;
 const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'queued');
 assert.equal(completed.backgroundPending,true);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),true);
 f.restart();assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');assert.equal(f.requests.length,(2)+f.loadingRequests);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'interrupted');}finally{await worker.stop();}
});
for(const action of ['pause','stop','finish_result'] as const)test(`completed model with a queued bound job supports ${action} and keeps live background evidence`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-no-network'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.backgroundPending,true);
 if(action==='finish_result'){
  const job=f.store.list('jobs',f.projectId)[0] as JobRecord;withAgentTaskJobOrigin(f.store.db,'job',job.id,()=>f.services.saveJob(job,{status:'succeeded',phase:'complete',progress:100,error:null}));
  const finished=f.runtime.get(f.projectId,sent.run.id);assert.equal(finished.backgroundPending,false);assert.equal(f.runtime.journal.hasPendingBackground(sent.run.id),false);assert.equal(finished.run.status,'completed');assert.ok(finished.changes.length>done.changes.length);assert.equal(f.requests.length,(2)+f.loadingRequests);
  assert.throws(()=>f.runtime.journal.transition(sent.run.id,finished.run.revision,'paused'),{code:'AGENT_TASK_STATE_CONFLICT'});
 }else{
  const controlled=await f.action(done,action);assert.equal(controlled.run.status,action==='pause'?'paused':'stopped');assert.equal(controlled.backgroundPending,action==='pause');if(action==='stop')assert.equal(object(f.store.list('jobs',f.projectId)[0]).status,'cancelled');
  const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(2)+f.loadingRequests);}finally{await worker.stop();}
 }
});
for(const paid of ['direct','confirm'] as const)test(`${paid}: unavailable video gives Mio a non-submission receipt and available video follows the paid mode`,async t=>{
 const f=await fixture(t,'responses',new Map(),{withVideoSettings:true,mockAllowed:false});
 f.services.configuration.set({expectedRevision:f.services.configuration.get().revision,liveGeneration:false});
 const connection:VideoConnectionConfigurationV2={id:randomUUID(),providerId:'minimax',name:VIDEO_PROVIDER_NAMES.minimax,region:'global',workspaceId:'',enabled:true,outputHosts:['output.example'],models:defaultVideoModels('minimax')};
 const target=shot(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{duration:4,aspectRatio:'9:16'}}));
 const input={shotId:target.id,expectedRevision:target.revision,providerId:'minimax',model:connection.models[0]!.modelId,connectionId:connection.id,configurationRevision:1,modelEntryId:connection.models[0]!.id};
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid},acknowledgePaid:paid==='direct'});
 const firstBatch=['first-video','same-batch-video','third-in-batch-video'];
 f.setScript(async function*(index){
  const attempts=index===1?firstBatch.map(id=>call('mioon_generation_submit',input,id)):index===2?[call('mioon_generation_submit',input,'later-video')]:[];
  yield {type:'done',output:output('responses',attempts)};
 },{loadGroups:['video']});
 const sent=await f.send();
 const failed=await f.settle(sent.run.id),attempts=failed.steps.filter(step=>step.toolCall?.name==='mioon_generation_submit');
 assert.equal(attempts[0]?.error?.code,'GENERATION_SERVICE_UNAVAILABLE');
 assert.deepEqual(attempts.map(step=>step.status),['rejected','rejected','rejected','failed']);
 assert.equal(failed.run.status,'failed');assert.equal(failed.run.pauseReason,'GENERATION_SERVICE_UNAVAILABLE');
 const body=JSON.parse(f.scriptRequest(2).body) as {input:Array<{type?:string;call_id?:string;output?:string}>};
 for(const callId of firstBatch){
  const result=body.input.find(item=>item.type==='function_call_output'&&item.call_id===callId);
  assert.ok(result?.output);const error=object(object(JSON.parse(result.output)).error);
  assert.equal(error.code,'GENERATION_SERVICE_UNAVAILABLE');assert.equal(error.mutationOutcome,'not_applied');
  assert.equal(error.submitted,false);assert.equal(error.generationCharged,false);assert.equal(error.settingsAction,'configure_generation_services');
  assert.equal(attempts.find(step=>step.toolCall?.id===callId)?.cost,undefined);
  assert.match(String(error.message),/设置.*生成服务/u);
 }
 assert.equal(f.requests.length,2+f.loadingRequests);
 assert.equal([...f.effects.values()].filter(operation=>operation==='generation.submit').length,0);
 assert.equal(f.store.list('jobs',f.projectId).length,0);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get()?.n,0);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mio_job_origins WHERE operation='generation.submit'").get()?.n,0);

 await f.videoSettings!.put({action:'save',expectedRevision:0,configuration:connection,secret:{action:'replace',value:'synthetic-video-key',storage:'persistent'}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===3?[call('mioon_generation_submit',input,'user-retry-video')]:[])};},{loadGroups:['video']});
 await f.action(failed,'retry',{stepId:attempts[3]!.id});
 if(paid==='confirm'){
  const waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');
  assert.equal(waiting.steps.at(-1)?.toolCall?.id,'user-retry-video');
  assert.equal(f.store.list('jobs',f.projectId).length,0);
  await f.action(waiting,'approve',{stepId:waiting.steps.at(-1)!.id});
 }
 const recovered=await f.settle(sent.run.id);
 assert.equal(recovered.run.status,'completed');assert.equal(recovered.steps.find(step=>step.toolCall?.id==='user-retry-video')?.status,'completed');
 assert.equal(f.store.list('jobs',f.projectId).length,1);
});

test('stable Mio tools and provider discovery omit Mock and return a no-cost receipt for a rejected attempt',async t=>{
 const mock:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(){return assert.fail('The stable runtime cannot submit Mock video');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){return assert.fail('No Mock output');}};
 const f=await fixture(t,'responses',new Map([['mock',mock]]),{mockAllowed:false});
 const video={shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'};
 const image={name:'Synthetic fixture',prompt:'A local test card',providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS}};
 for(const definitions of [f.tools.list(),f.tools.diagnosticList()]){
  for(const operation of ['generation.submit','image.generate']){
   const tool=definitions.find(item=>item.operation===operation);assert.ok(tool);
   assert.doesNotMatch(JSON.stringify(tool),/mock|模拟|"scenario"|"delayMs"/iu);
  }
 }
 f.setScript(async function*(index){
  yield {type:'done',output:output('responses',index===1?[call('mioon_provider_list',{},'video-list'),call('mioon_image_profile_list',{},'image-list'),call('mioon_generation_submit',video,'mock-video'),call('mioon_image_generate',image,'mock-image'),call('mioon_image_generate',{...image,providerId:'openai',model:IMAGE_MODELS.openai},'unconfigured-image')]:[])};
 },{loadGroups:['video','images']});
 const sent=await f.send(),settled=await f.settle(sent.run.id);
 assert.equal(settled.run.status,'completed',"The model can explain why generation didn't run");
 const firstRequest=f.scriptRequest(1).body;
 assert.doesNotMatch(firstRequest,/mock|模拟|"scenario"|"delayMs"/iu);
 assert.match(firstRequest,/mioon_generation_submit/u);assert.match(firstRequest,/mioon_image_generate/u);
 const result=(id:string)=>settled.steps.find(step=>step.toolCall?.id===id)?.result;
 assert.deepEqual(result('video-list'),[]);
 const profiles=object(result('image-list')).items;
 assert.ok(Array.isArray(profiles)&&profiles.length>0);
 assert.ok(profiles.every(profile=>object(profile).providerId!=='mock'&&object(profile).isMock===false));
 for(const id of ['mock-video','mock-image','unconfigured-image']){
  const step=settled.steps.find(item=>item.toolCall?.id===id);
  assert.equal(step?.status,'rejected');assert.equal(step?.cost,undefined);
  assert.deepEqual(object(object(result(id)).error),{code:'GENERATION_SERVICE_UNAVAILABLE',message:step.error?.message,mutationOutcome:'not_applied',submitted:false,generationCharged:false,settingsAction:'configure_generation_services'});
 }
 assert.equal(f.store.list('jobs',f.projectId).length,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()?.n,0);
});

test('Mio requires one paid confirmation for each available image request and submits only the approved one',async t=>{
 const settings=await createImageSettings({persistence:{load:async()=>null,save:async()=>{}},secretCodec:createTestSecretCodec(),storage:testSecretStorage});t.after(()=>settings.close());
 await settings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_IMAGE_GATEWAY_ONLY'}});
 const f=await fixture(t,'responses',new Map(),{mockAllowed:false,imageOptions:{settings,autoRun:false,liveGateway:{generate:async()=>assert.fail('This test observes approval before provider dispatch')}}});
 const image={prompt:'Do not call the provider',providerId:'openai',model:IMAGE_MODELS.openai,options:{...IMAGE_FIXED_OPTIONS}};
 assert.equal(f.runtime.policy().modes.paid,'confirm');
 f.setScript(async function*(index){
  yield {type:'done',output:output('responses',index===1?[call('mioon_image_generate',{...image,name:'First request'},'first-image'),call('mioon_image_generate',{...image,name:'Second request'},'second-image')]:[])};
 },{loadGroups:['images']});
 const sent=await f.send(),first=await f.settle(sent.run.id);
 const reviewCount=()=>f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()?.n;
 assert.equal(first.run.status,'awaiting_approval');assert.equal(first.steps.at(-1)?.toolCall?.id,'first-image');
 assert.equal(reviewCount(),0);
 await f.action(first,'approve',{stepId:first.steps.at(-1)!.id});
 const second=await f.settle(sent.run.id);
 assert.equal(second.run.status,'awaiting_approval');assert.equal(second.steps.at(-1)?.toolCall?.id,'second-image');
 assert.equal(reviewCount(),1);
 await f.action(second,'deny',{stepId:second.steps.at(-1)!.id});
 const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(reviewCount(),1);
 assert.equal(done.steps.find(step=>step.toolCall?.id==='first-image')?.status,'completed');
 assert.equal(done.steps.find(step=>step.toolCall?.id==='second-image')?.status,'rejected');
});

test('Mio tells the user to select from multiple custom image services before creating a paid review',async t=>{
 const settings=await createCustomImageSettingsV2({persistence:{load:async()=>null,save:async()=>{}},secretCodec:createTestSecretCodec(),storage:testSecretStorage});t.after(()=>settings.close());
 const configuration={...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,enabled:true,baseUrl:'https://images.example.com/v1',model:'synthetic-image'};
 await settings.batch({expectedRevision:0,operations:['A','B'].map(name=>({action:'create',connectionId:randomUUID(),name,configuration,secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_CUSTOM_IMAGE_KEY'}}))});
 const f=await fixture(t,'responses',new Map(),{mockAllowed:false,imageOptions:{customSettingsV2:settings,autoRun:false,customGateway:{generate:async()=>assert.fail('An ambiguous request cannot contact a provider')}}});
 const image={name:'Synthetic image',prompt:'Never sent',providerId:'openai-compatible',model:configuration.model,options:{...IMAGE_FIXED_OPTIONS}};
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_image_generate',image,'ambiguous-image')]:[])};},{loadGroups:['images']});
 const sent=await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');
 const step=done.steps.find(item=>item.toolCall?.id==='ambiguous-image');
 assert.equal(step?.status,'rejected');assert.equal(step.cost,undefined);
 assert.deepEqual(object(object(step.result).error),{code:'IMAGE_SETTINGS_SELECTION_REQUIRED',message:step.error?.message,mutationOutcome:'not_applied',submitted:false,generationCharged:false});
 assert.match(f.scriptRequest(2).body,/图片生成面板中选择服务/u);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()?.n,0);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_tasks').get()?.n,0);
});

for(const errorCode of ['LIVE_GENERATION_DISABLED','GENERATION_SERVICE_UNAVAILABLE'])for(const recordedDispatch of [false,true])test(recordedDispatch
 ?`a ${errorCode} label with recorded paid dispatch stays unknown and cannot be marked failed`
 :`an unknown ${errorCode} submission can be marked failed and replanned after checking the acceptance evidence`,async t=>{
 // A code alone does not prove that a generation attempt was never sent.
 const f=await fixture(t);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 const execute=f.tools.execute;
 f.tools.execute=async(prepared,context)=>{
  try{return await execute(prepared,context);}
  catch(error){
   if(prepared.operation!=='generation.submit')throw error;
   assert.equal(object(error).code,'PROVIDER_NOT_FOUND');
   if(recordedDispatch)f.runtime.journal.updateStep(context.runId,context.stepId,{cost:'submitted'});
   throw new AppError(errorCode,'Synthetic failure without non-submission proof',409);
  }
 };
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),paused=await f.settle(sent.run.id),step=paused.steps.find(item=>item.toolCall?.name==='mioon_generation_submit');assert.ok(step);
 assert.equal(paused.run.pauseReason,'unknown_outcome');assert.equal(step.status,'unknown');assert.equal(step.error?.code,errorCode);assert.equal(f.store.list('jobs',f.projectId).length,0);
 f.restart();
 const reopened=f.runtime.get(f.projectId,sent.run.id);
 assert.equal(reopened.run.status,'interrupted');assert.deepEqual(reopened.steps.find(item=>item.id===step.id)?.error,step.error);
 await assert.rejects(f.action(reopened,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});
 if(recordedDispatch){
  assert.equal(step.cost,'submitted');
  await assert.rejects(f.action(reopened,'resolve_unknown',{stepId:step.id,resolution:'discard'}),{code:'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.runtime.get(f.projectId,sent.run.id).steps.find(item=>item.id===step.id)?.status,'unknown');
  assert.equal(f.requests.length,1+f.loadingRequests);return;
 }
 const marked=await f.action(reopened,'resolve_unknown',{stepId:step.id,resolution:'discard'});assert.equal(marked.steps.find(item=>item.id===step.id)?.status,'failed');
 await f.action(marked,'resume');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,(2)+f.loadingRequests);assert.match(f.scriptRequest(2)!.body,/UNKNOWN_NOT_APPLIED/);assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(f.effects.size,(1)+f.loadingEffects);
});
test('the default project format can discard an unknown local step after its target is deleted', async t => {
 const f = await fixture(t), callId = randomUUID();
 assert.equal(f.store.db.prepare('PRAGMA project.user_version').get()?.user_version, PROJECT_FILE_SCHEMA_VERSION);
 f.beforeTool(async prepared => {
  if (prepared.operation === 'shot.update') throw new Error('Synthetic interruption before saving the shot');
 });
 f.setScript(async function*(index) {
  yield {type:'done', output:output('responses', index === 1 ?
   [call('mioon_shot_update', {shotId:f.first.id, expectedRevision:f.first.revision, patch:{prompt:'Uncommitted edit'}}, callId)] : [])};
 }, {loadGroups:['canvas']});
 const sent = await f.send(), paused = await f.settle(sent.run.id);
 const step = paused.steps.find(item => item.toolCall?.id === callId);
 assert.ok(step);
 assert.equal(paused.run.pauseReason, 'unknown_outcome');
 assert.equal(step.status, 'unknown');
 assert.equal(step.tier, 'local_reversible');
 assert.equal(f.store.db.prepare('SELECT 1 FROM main.mutation_requests WHERE requestId=?').get(step.id), undefined);
 assert.equal(f.store.tx(() => f.store.db.prepare('DELETE FROM project.shots WHERE id=?').run(f.first.id).changes), 1);
 assert.equal(f.store.get('shots', f.first.id), null);
 f.restart();
 const restored = f.runtime.get(f.projectId, sent.run.id);
 await assert.rejects(f.action(restored, 'resume'), {code:'AGENT_TASK_UNKNOWN_RESULT'});
 const disposed = await f.action(restored, 'resolve_unknown', {stepId:step.id, resolution:'discard'});
 const failed = disposed.steps.find(item => item.id === step.id);
 assert.equal(failed?.status, 'failed');
 assert.equal(object(failed?.result).reason, 'atomic_receipt_absent');
 assert.equal(object(object(failed?.result).error).code, 'UNKNOWN_NOT_APPLIED');
 assert.equal(f.requests.length, 1 + f.loadingRequests);
 await f.action(disposed, 'resume');
 const done = await f.settle(sent.run.id);
 assert.equal(done.run.status, 'completed');
 assert.deepEqual(done.changes, []);
 assert.equal(f.store.get('shots', f.first.id), null);
 assert.equal(f.effects.size, f.loadingEffects);
 assert.match(f.scriptRequest(2).body, /UNKNOWN_NOT_APPLIED/u);
});
for(const safetyStepLimit of [5,30])for(const action of ['approve','deny'] as const)test(`paid direct disabled after acceptance supports one-time ${action} of the original queued job with safety window ${safetyStepLimit}`,async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},
  async submit(_snapshot,context){context.beforeSubmit?.();posts++;return {providerJobId:'synthetic-approved-once'};},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers,{safetyStepLimit});f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_generation_submit',{shotId:f.first.id,expectedRevision:1,providerId:'mock',model:'mock-motion-v1'})]:[])};},{loadGroups:['video']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.run.stepsUsed,3+f.loadingSteps(done));const window=f.runtime.journal.safetyWindow(sent.run.id);assert.equal(window.remaining,safetyStepLimit-done.run.stepsUsed);const job=object(f.store.list('jobs',f.projectId)[0]),jobId=String(job.id),originalStep=done.steps.find(step=>step.toolCall?.name==='mioon_generation_submit');assert.ok(originalStep);
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'confirm'}});
 const worker=startWorker(f.store,f.services,providers);try{
  await worker.tick();const waiting=f.runtime.get(f.projectId,sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.steps.find(step=>step.id===originalStep.id)?.approvalRequired,true);assert.equal(posts,0);assert.equal(f.store.list('jobs',f.projectId).length,1);
  const request={requestId:randomUUID(),expectedRevision:waiting.run.revision,action,stepId:originalStep.id};await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.action(f.projectId,sent.run.id,request);await f.runtime.drain();await worker.tick();await worker.tick();
  assert.equal(posts,action==='approve'?1:0);assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(String(object(f.store.list('jobs',f.projectId)[0]).id),jobId);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.runtime.policy().modes.paid,'confirm');assert.equal(Boolean(f.runtime.get(f.projectId,sent.run.id).steps.find(step=>step.id===originalStep.id)?.approvalRequired),false);if(action==='deny')assert.equal(object(f.store.get('jobs',jobId)).status,'cancelled');
  const controlled=f.runtime.get(f.projectId,sent.run.id);assert.equal(controlled.run.status,'completed');assert.equal(controlled.run.stepsUsed,3+f.loadingSteps(controlled));assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),window);assert.deepEqual(controlled.steps.map(step=>step.id),done.steps.map(step=>step.id));
 }finally{await worker.stop();}
});
