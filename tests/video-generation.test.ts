import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rename,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createProjectBackgroundState} from '../packages/business/src/background-task-state.ts';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import {createVideoSecretBroker} from '../apps/desktop/src/video-secret-broker.ts';
import {createVideoSecretClient} from '../apps/desktop/src/video-secret-client.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {setAgentTaskEffectGate} from '../packages/business/src/agent/task-effects-v2.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {projectAgentTaskChangeDisplay} from '../packages/business/src/agent/task-display-v2.ts';
import {beginFixtureToolStep,mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {VIDEO_PROVIDER_NAMES,defaultVideoModels,resolveVideoEndpoint,videoBindingCapabilities,videoInputProfile} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
import {parse} from '../packages/contracts/src/index.ts';
import {projectOutputPublicationProofSchema} from '../packages/contracts/src/project-output-publication.ts';

const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const frozenDate=()=>Date.UTC(2026,9,20);
function codec(){
 const key=randomBytes(32);
 return {encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64');},decrypt(value:string){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString();}};
}
function desktopVideoVault(secretCodec:ReturnType<typeof codec>){
 const gates:Array<{entered:()=>void;released:Promise<void>}>=[];
 const openMain=(probeGate?: Promise<void>)=>createDesktopVideoSecretCodec({
   appId:desktopIdentity.identityForChannel('production').appId,platform:'darwin',timeout:150,
   safeStorage:{
    encryptString(){assert.fail('Desktop macOS used synchronous encryption');},
    decryptString(){assert.fail('Desktop macOS used synchronous decryption');},
    async isAsyncEncryptionAvailable(){await probeGate;return true;},
    async encryptStringAsync(value){return Buffer.from(secretCodec.encrypt(value),'base64');},
    async decryptStringAsync(value){
     const result=secretCodec.decrypt(value.toString('base64'));
     const gate=result.startsWith('{')?gates.shift():undefined;
     if(gate){gate.entered();await gate.released;}
     return {result,shouldReEncrypt:false};
    }
   }
 });
 let videoSecretCodec=openMain();
 function connect(){
  const port=new class extends EventEmitter {postMessage(message:unknown){assert.equal(broker.handle(message),true);}};
  const broker=createVideoSecretBroker({videoSecretCodec,send:data=>port.emit('message',{data})});
  const client=createVideoSecretClient({port});
  return {client,close(){client.close();broker.close();}};
 }
 let nextProbeGate: Promise<void> | undefined;
 return {connect,reopenMain(){videoSecretCodec=openMain(nextProbeGate);nextProbeGate=undefined;},blockNextProbe(){
  const released=Promise.withResolvers<void>();
  nextProbeGate=released.promise;
  return {release:()=>released.resolve()};
 },blockNextDecrypt(){
  const entered=Promise.withResolvers<void>(),released=Promise.withResolvers<void>();
  gates.push({entered:()=>entered.resolve(),released:released.promise});
  return {entered:entered.promise,release:()=>released.resolve()};
 }};
}
async function fixture(t:TestContext,{persistent=false,providerId='minimax' as VideoConnectionConfigurationV2['providerId'],liveGeneration=true,modelId='',desktop=false}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-generation-'))),secretCodec=codec();
 const directory=path.join(root,'video-settings'),desktopVault=desktop?desktopVideoVault(secretCodec):undefined;
 let desktopConnection=desktopVault?.connect();
 const openSettings=async()=>{
  const client=desktopConnection?.client;
  if(client){
   try {await client.refreshStorage();} catch { /* Desktop startup continues without persistence availability. */ }
   return createVideoSettingsV2({directory,privateRoot:root,secretCodec:client,storage:()=>client.storage()});
  }
  return createVideoSettingsV2({directory,privateRoot:root,...(persistent?{secretCodec,storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null}}:{})});
 };
 let store=openStore(root),settings=await openSettings(),worker:ReturnType<typeof startWorker>|null=null;
 let acquireOverride: typeof settings.acquire | undefined;
 const settingsPort=()=>({...settings,acquire: (...args: Parameters<typeof settings.acquire>)=>(acquireOverride??settings.acquire)(...args)});
 const calls:Array<{url:string;init:RequestInit}>=[];
 let response:(url:string,init:RequestInit)=>Response|Promise<Response>=(url,init)=>{if(init.method==='POST')return json({task_id:'original-task'});return json({task:{id:'original-task',status:'running'}});};
 const videoFetch:typeof fetch=async(input,init)=>{const request={url:String(input),init:init??{}};calls.push(request);return response(request.url,request.init);};
 const registry=()=>createProviderRegistry({db:store.db,root,env:{}});
 let providers=registry(),services=createServices(store,providers,{videoSettings:settingsPort(),videoFetch,profileNow:frozenDate});
 if(liveGeneration)await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const configuration:VideoConnectionConfigurationV2={id:randomUUID(),providerId,name:VIDEO_PROVIDER_NAMES[providerId],region:providerId==='ark'||providerId==='wan'?'cn-beijing':providerId==='compatible'?'custom':'global',workspaceId:'',enabled:true,outputHosts:['output.example'],models:defaultVideoModels(providerId),...(providerId==='compatible'?{baseUrl:'https://old.example/v1'}:{})};
 if(modelId)configuration.models[0]!.modelId=modelId;
 const secret=(value='original-synthetic-key')=>({action:'replace' as const,value,storage:persistent?'persistent' as const:'session' as const});
 await settings.put({action:'save',expectedRevision:0,configuration,secret:secret()});
 const project=await services.call('project.create',{name:'Configured video integration'}) as ServiceRow;
 const shot=await services.call('shot.create',{projectId:project.id,title:'Test shot',prompt:'Synthetic shapes move.',aspectRatio:'9:16',duration:providerId==='kling'?5:4,referenceAssetIds:[]}) as ServiceRow;
 const input=()=>({shotId:String(shot.id),expectedRevision:Number(shot.revision),requestId:randomUUID(),providerId,model:configuration.models[0]!.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id});
 const f={root,configuration,secret,calls,shot,input,projectId:String(project.id),desktopVault,
  get store(){return store;},get settings(){return settings;},get services(){return services;},
  overrideAcquire(value?: typeof settings.acquire){acquireOverride=value;},
  reply(fn:typeof response){response=fn;},
  job(id:string){return store.get('jobs',id) as JobRecord;},
  async submit(change:Record<string,unknown>={}){return await services.call('generation.submit',{...input(),...change}) as JobRecord;},
  async live(enabled:boolean){return services.call('workspace.settings.set',{expectedRevision:services.configuration.get().revision,liveGeneration:enabled});},
  async tick(subscribeVideoStorageAvailable=desktopConnection?.client.subscribeStorageAvailable){worker??=startWorker(store,services,providers,{...(subscribeVideoStorageAvailable?{subscribeVideoStorageAvailable}:{})});await worker.tick();},
  async stop(){await worker?.stop();worker=null;},
  async restart({reopenApp=false}={}){await f.stop();await services.drain();await settings.close();desktopConnection?.close();store.close();if(reopenApp)desktopVault?.reopenMain();store=openStore(root);desktopConnection=desktopVault?.connect();settings=await openSettings();providers=registry();services=createServices(store,providers,{videoSettings:settingsPort(),videoFetch,profileNow:frozenDate});},
  ready(id:string){services.saveJob(f.job(id),{nextPollAt:0});},
 };
 t.after(async()=>{await f.stop();await services.drain();await settings.close();desktopConnection?.close();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}

// Seed a historical persisted row through the real settings history. Current
// admission deliberately refuses these parameters, so historical rows are
// fixtures rather than newly submitted paid work.
async function historicalMinimaxJob(f:Awaited<ReturnType<typeof fixture>>,status:JobRecord['status'],parameters:Record<string,unknown>={},options:{modelId?:string;resolution?:'768P'|'2K'}={}){
 const accepted=await f.submit(),current=f.job(accepted.id),configuration=structuredClone(f.configuration);
 // The public acceptance DTO omits private owner fields such as requestHash.
 // Historical settings fixtures must preserve the real persisted job identity.
 assert.match(current.requestHash,/^[a-f0-9]{64}$/);
 const resolution=options.resolution??'768P';
 if(options.modelId)configuration.models[0]!.modelId=options.modelId;
 configuration.models[0]!.durationResolutionMap=[{duration:[4,8],resolution:[resolution]}];
 await f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'keep'}});
 const binding=f.settings.select(configuration.id,2,configuration.models[0]!.id),profile=videoInputProfile(binding),capabilities=videoBindingCapabilities(binding);
 capabilities.modelCapabilities[0]!.resolutions=[resolution];
 const snapshot={...current.snapshot,model:binding.model.modelId,parameters,executionBinding:binding,inputProfileId:profile.profileId,inputProfileVersion:profile.profileVersion,capabilities};
 f.store.put('jobs',{...current,model:binding.model.modelId,status,phase:status==='queued'?'waiting':'polling',snapshot,providerJobId:status==='running'?'original-task':null,submissionCount:status==='queued'?0:1,nextPollAt:0});
 return f.job(current.id);
}

for(const modelId of ['MiniMax-H3','historical-custom-h3'])test(`historical 768P ${modelId} settings and paid tasks restart, query and publish unchanged through the SDK after a 2K account edit`,async t=>{
 const f=await fixture(t,{persistent:true}),job=await historicalMinimaxJob(f,'running',{resolution:'768P'},{modelId}),snapshot=structuredClone(job.snapshot),binding=job.snapshot.executionBinding as VideoExecutionBinding;
 await f.restart();
 assert.deepEqual(f.settings.list()[0]!.configuration.models[0]!.durationResolutionMap,[{duration:[4,8],resolution:['768P']}]);
 assert.equal(await f.settings.acquire(binding),'original-synthetic-key');assert.deepEqual(f.job(job.id).snapshot,snapshot);
 const next=structuredClone(f.configuration);next.region='cn';
 await f.settings.put({action:'save',expectedRevision:2,configuration:next,secret:f.secret('new-2k-account-key')});
 await f.settings.put({action:'save',expectedRevision:3,configuration:{...next,enabled:false},secret:{action:'keep'}});await f.live(false);await f.restart();
 const video=path.join(f.root,'historical-768p.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=360x640:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
 const bytes=await readFile(video);
 f.reply((url,init)=>{
  assert.equal(init.method,'GET');
  if(url==='https://output.example/historical.mp4'){assert.equal(new Headers(init.headers).get('authorization'),null);return new Response(bytes);}
  assert.equal(url,'https://api.minimax.io/v2/query/video_generation/original-task');
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer original-synthetic-key');
  return json({task:{id:'original-task',status:'succeeded',resolution:'768P',content:{url:'https://output.example/historical.mp4'}}});
 });
 f.ready(job.id);await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'succeeded',JSON.stringify(f.job(job.id).error));assert.equal(f.calls.length,2);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
 assert.deepEqual(f.job(job.id).snapshot,snapshot);assert.equal(f.store.list('versions').length,1);
 const proof=projectOutputPublicationProofSchema.parse((f.store.list('assets')[0] as ServiceRow).publication);
 assert.deepEqual(proof.owner,{kind:'generation',id:job.id,requestId:job.requestId,inputHash:job.requestHash});
 assert.deepEqual((f.store.list('versions')[0] as ServiceRow).snapshot,snapshot);assert.equal(await f.settings.acquire(binding),'original-synthetic-key');
});

test('unsupported MiniMax custom models fail admission before creating a job or sending HTTP',async t=>{
 const f=await fixture(t,{modelId:'custom-h3-name'});
 await assert.rejects(f.submit(),{code:'UNSUPPORTED_MODEL'});
 assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 assert.equal(f.settings.list()[0]!.configuration.models[0]!.modelId,'custom-h3-name');
});

test('persisted MiniMax custom-model queued work fails visibly once instead of requeueing forever',async t=>{
 const f=await fixture(t,{persistent:true}),job=await historicalMinimaxJob(f,'queued',{resolution:'2K'},{modelId:'custom-h3-name',resolution:'2K'}),snapshot=structuredClone(job.snapshot);
 await f.restart();await f.tick();await f.stop();
 const failed=structuredClone(f.job(job.id));
 assert.equal(failed.status,'failed');assert.equal((failed.error as ServiceRow).code,'UNSUPPORTED_MODEL');
 assert.equal(failed.submissionCount,0);assert.equal(failed.providerJobId,null);assert.equal(f.calls.length,0);assert.deepEqual(failed.snapshot,snapshot);
 await f.tick();await f.stop();assert.deepEqual(f.job(job.id),failed);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSUPPORTED_MODEL'});
 assert.equal(f.store.list('jobs').length,1);assert.equal(f.calls.length,0);
});

for(const parameters of [{},{resolution:'768P'}])test(`historical ${Object.keys(parameters).length?'explicit':'implicit'} 768P queued work and retries cannot silently submit as 2K`,async t=>{
 const f=await fixture(t,{persistent:true}),job=await historicalMinimaxJob(f,'queued',parameters),snapshot=structuredClone(job.snapshot);
 await f.restart();await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'failed');assert.equal((f.job(job.id).error as ServiceRow).code,'UNSUPPORTED_PARAMETERS');
 assert.equal(f.job(job.id).submissionCount,0);assert.equal(f.job(job.id).providerJobId,null);assert.equal(f.calls.length,0);assert.deepEqual(f.job(job.id).snapshot,snapshot);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSUPPORTED_PARAMETERS'});
 assert.equal(f.store.list('jobs').length,1);assert.equal(f.calls.length,0);assert.deepEqual(f.job(job.id).snapshot,snapshot);
});

test('historical MiniMax uncertain submission never falls back or resubmits after restart',async t=>{
 const f=await fixture(t,{persistent:true}),job=await historicalMinimaxJob(f,'submission_unknown',{resolution:'768P'}),snapshot=structuredClone(job.snapshot);
 await f.restart();await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.job(job.id).submissionCount,1);assert.deepEqual(f.job(job.id).snapshot,snapshot);assert.equal(f.calls.length,0);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});assert.equal(f.store.list('jobs').length,1);
});

test('configured video submission and explicit retry require the persisted workspace live opt-in',async t=>{
 const f=await fixture(t,{liveGeneration:false});
 assert.equal(f.services.configuration.get().liveGeneration,false);assert.equal(f.services.configuration.get().revision,0);
 const input=f.input(),denial={code:'LIVE_GENERATION_DISABLED',status:409,details:{mutationOutcome:'not_applied'}};
 await assert.rejects(f.services.call('generation.submit',input),denial);assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 assert.equal(f.store.db.prepare("SELECT 1 FROM idempotency WHERE scope='generation' AND requestId=?").get(input.requestId),undefined);
 await f.live(true);const job=await f.submit();await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'synthetic definitive failure'}});
 const before=structuredClone(f.job(job.id)),retryInput={jobId:job.id,requestId:randomUUID()};
 await f.live(false);await assert.rejects(f.services.call('job.retry',retryInput),denial);
 assert.deepEqual(f.job(job.id),before);assert.equal(f.store.list('jobs').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 await f.live(true);const retry=await f.services.call('job.retry',retryInput) as JobRecord;
 assert.equal(retry.retryOfJobId,job.id);assert.deepEqual(retry.snapshot,job.snapshot);await f.tick();
 assert.equal(f.job(retry.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,2);
});

for(const [problem,code] of [
 ['removed credential','VIDEO_SETTINGS_NOT_CONFIGURED'],
 ['disabled connection','VIDEO_SETTINGS_DISABLED'],
 ['disabled model','VIDEO_SETTINGS_DISABLED'],
 ['missing output host','VIDEO_SETTINGS_NOT_CONFIGURED'],
] as const)test(`video admission proves a ${problem} left no submission or receipt`,async t=>{
 const f=await fixture(t,problem==='missing output host'?{providerId:'vidu'}:{}),configuration=structuredClone(f.configuration);
 if(problem==='disabled connection')configuration.enabled=false;
 if(problem==='disabled model')configuration.models[0]!.enabled=false;
 if(problem==='missing output host')configuration.outputHosts=[];
 const saved=await f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:problem==='removed credential'?'remove':'keep'}});
 const input={...f.input(),configurationRevision:saved.connections[0]!.revision};
 await assert.rejects(f.services.call('generation.submit',input),{code,status:409,details:{mutationOutcome:'not_applied'}});
 assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 assert.equal(f.store.db.prepare("SELECT 1 FROM idempotency WHERE scope='generation' AND requestId=?").get(input.requestId),undefined);
});

test('a reference revision disagreement rejects video generation before creating a job or receipt',async t=>{
 const f=await fixture(t),input={...f.input(),referenceRevisions:[{assetId:randomUUID(),referenceRevision:1,sha256:'a'.repeat(64)}]};
 await assert.rejects(f.services.call('generation.submit',input),{code:'REFERENCE_CHANGED',status:409,details:{mutationOutcome:'not_applied'}});
 assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 assert.equal(f.store.db.prepare("SELECT 1 FROM idempotency WHERE scope='generation' AND requestId=?").get(input.requestId),undefined);
});

test('revoking the workspace live switch after queueing prevents every generation POST until an explicit enabled retry',async t=>{
 const f=await fixture(t),job=await f.submit();await f.live(false);await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'failed');assert.equal((f.job(job.id).error as ServiceRow).code,'LIVE_GENERATION_DISABLED');
 assert.equal(f.job(job.id).submissionCount,0);assert.equal(f.calls.length,0);assert.equal(f.store.list('versions').length,0);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'LIVE_GENERATION_DISABLED'});
 await f.live(true);assert.equal(f.calls.length,0);const retry=await f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}) as JobRecord;
 assert.deepEqual(retry.snapshot,job.snapshot);await f.tick();
 assert.equal(f.job(retry.id).status,'running');assert.equal(f.job(job.id).status,'failed');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

test('revoking live generation after the submitting claim is fenced before the paid POST without uncertain acceptance',async t=>{
 const f=await fixture(t),job=await f.submit(),snapshot=structuredClone(job.snapshot),saveGenerationGuarded=f.services.saveGenerationGuarded;
 let revoked=0;
 f.services.saveGenerationGuarded=(candidate,patch)=>{
  const saved=saveGenerationGuarded(candidate,patch);
  if(saved&&patch.status==='submitting'){
   assert.equal(saved.status,'submitting');assert.equal(saved.submissionCount,1);assert.equal(f.calls.length,0);
   f.services.configuration.set({expectedRevision:f.services.configuration.get().revision,liveGeneration:false});revoked++;
  }
  return saved;
 };
 await f.tick();await f.stop();f.services.saveGenerationGuarded=saveGenerationGuarded;
 const blocked=f.job(job.id);
 assert.equal(revoked,1);assert.equal(blocked.status,'failed');assert.equal(blocked.phase,'input_preflight_failed');
 assert.equal((blocked.error as ServiceRow).code,'LIVE_GENERATION_DISABLED');assert.equal(blocked.submissionCount,0);assert.equal(blocked.providerJobId,null);
 assert.deepEqual(blocked.snapshot,snapshot);assert.deepEqual(blocked.snapshot.executionBinding,snapshot.executionBinding);
 assert.equal(f.calls.length,0);assert.equal(f.store.list('versions').length,0);
 await f.live(true);await f.tick();await f.stop();assert.equal(f.job(job.id).status,'failed');assert.equal(f.calls.length,0);
 const retry=await f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}) as JobRecord;
 assert.equal(retry.retryOfJobId,job.id);assert.deepEqual(retry.snapshot,snapshot);await f.tick();
 assert.equal(f.job(retry.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

test('configured directory is read-only and paid requests require the complete exact connection selection',async t=>{
 const f=await fixture(t),legacy=await f.services.call('provider.list',{}) as ServiceRow[],directory=await f.services.call('video.connection.list',{}) as ServiceRow[];
 assert.deepEqual(legacy.map(provider=>provider.id),['mock','runway','ark','veo','minimax','vidu']);assert.equal(directory.length,1);assert.equal(directory[0]!.connectionId,f.configuration.id);
 assert.doesNotMatch(JSON.stringify(directory),/original-synthetic-key|credentialRef|encrypted/);assert.equal(f.calls.length,0);
 assert.throws(()=>parse('generation.submit',{...f.input(),modelEntryId:undefined}),{code:'VALIDATION_ERROR'});
 await assert.rejects(f.submit({configurationRevision:2}),{code:'VIDEO_SETTINGS_CONFLICT'});assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 const request=f.input(),job=await f.services.call('generation.submit',request) as JobRecord;
 assert.equal((await f.services.call('generation.submit',request) as JobRecord).id,job.id);
 assert.equal(job.snapshot.executionConnectionName,f.configuration.name);assert.equal(f.store.list('jobs').length,1);
 await assert.rejects(f.services.call('generation.submit',{...request,parameters:{resolution:'768P'}}),{code:'IDEMPOTENCY_CONFLICT'});assert.equal(f.calls.length,0);
});

test('queued jobs and explicit retries retain the old endpoint, model and credential after settings edit',async t=>{
 const f=await fixture(t),job=await f.submit(),original=structuredClone(job.snapshot);
 const next=structuredClone(f.configuration);next.region='cn';next.models[0]!.modelId='another-official-model';
 await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,'https://api.minimax.io/v2/video_generation');
 assert.equal(new Headers(f.calls[0]!.init.headers).get('Authorization'),'Bearer original-synthetic-key');
 assert.equal((JSON.parse(String(f.calls[0]!.init.body)) as ServiceRow).model,f.configuration.models[0]!.modelId);assert.deepEqual(f.job(job.id).snapshot,original);
 await f.stop();f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'synthetic'}});
 const retry=await f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}) as JobRecord;
 assert.deepEqual(retry.snapshot,original);assert.equal(retry.retryOfJobId,job.id);assert.equal(f.calls.length,1);
});

for(const cause of ['explicit removal','session restart'])test(`missing credentials after ${cause} keep queued work frozen with zero POSTs even after re-entering the same key`,async t=>{
 const f=await fixture(t),job=await f.submit(),snapshot=structuredClone(job.snapshot),binding=job.snapshot.executionBinding as VideoExecutionBinding;
 if(cause==='explicit removal')await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:{action:'remove'}});else await f.restart();
 const before=await f.settings.get(),current=before.connections[0]!;
 await f.tick();await f.stop();assert.equal(f.calls.length,0);assert.equal(f.job(job.id).status,'queued');assert.equal(f.job(job.id).phase,'connection_required');assert.equal(f.job(job.id).submissionCount,0);
 await assert.rejects(f.settings.put({action:'restoreCredential',expectedRevision:before.revision,connectionId:binding.connectionId,credentialRef:binding.credentialRef,secret:f.secret()}),{code:'VIDEO_SETTINGS_VALIDATION'});
 await f.settings.put({action:'save',expectedRevision:before.revision,configuration:f.configuration,secret:f.secret()});
 const replacement=f.settings.select(f.configuration.id,current.revision+1,f.configuration.models[0]!.id);assert.notEqual(replacement.credentialRef,binding.credentialRef);
 assert.equal(await f.settings.acquire(replacement),'original-synthetic-key');await assert.rejects(f.settings.acquire(binding),{code:'VIDEO_SETTINGS_NOT_CONFIGURED'});
 for(let attempt=0;attempt<2;attempt++){f.ready(job.id);await f.tick();await f.stop();assert.equal(f.job(job.id).status,'queued');assert.equal(f.job(job.id).phase,'connection_required');assert.equal(f.job(job.id).submissionCount,0);assert.equal(f.job(job.id).providerJobId,null);assert.deepEqual(f.job(job.id).snapshot,snapshot);assert.equal(f.calls.length,0);assert.equal(f.store.list('jobs').length,1);}
});

test('uncertain accepted submissions survive restarts and config edits without another generation POST',async t=>{
 const f=await fixture(t,{persistent:true});f.reply(()=>{throw Error('synthetic response lost');});const job=await f.submit();await f.tick();
 const unknown=f.job(job.id);
 assert.equal(unknown.status,'submission_unknown');assert.equal(unknown.submissionCount,1);assert.equal((unknown.error as ServiceRow).mutationOutcome,undefined);
 assert.equal(f.calls.length,1);await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 const next=structuredClone(f.configuration);next.region='cn';await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.restart();assert.equal(f.services.configuration.get().liveGeneration,true);f.ready(job.id);await f.tick();assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.calls.length,1);
});

test('known task recovery downloads and publishes one decoded immutable version using disabled settings',async t=>{
 const f=await fixture(t,{persistent:true}),video=path.join(f.root,'fixture.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=360x640:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
 const bytes=await readFile(video),job=await f.submit();await f.tick();await f.stop();assert.equal(f.job(job.id).providerJobId,'original-task');
 const next=structuredClone(f.configuration);next.region='cn';await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.settings.put({action:'save',expectedRevision:2,configuration:{...next,enabled:false},secret:{action:'keep'}});await f.live(false);await f.restart();assert.equal(f.services.configuration.get().liveGeneration,false);
 f.reply((url,init)=>{assert.notEqual(init.method,'POST');if(url.startsWith('https://output.example/')){assert.equal(new Headers(init.headers).get('Authorization'),null);return new Response(bytes);}assert.ok(url.startsWith('https://api.minimax.io/'));assert.equal(new Headers(init.headers).get('Authorization'),'Bearer original-synthetic-key');return json({task:{id:'original-task',status:'succeeded',content:{url:'https://output.example/result.mp4'}}});});
 f.ready(job.id);await f.tick();assert.equal(f.job(job.id).status,'succeeded');assert.equal(f.store.list('versions').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 const version=f.store.list('versions')[0] as ServiceRow;assert.equal(version.jobId,job.id);assert.equal((version.snapshot as ServiceRow).executionConnectionName,f.configuration.name);
 const selected=f.store.get('shots',String(f.shot.id)) as ServiceRow;assert.equal(selected.selectedVersionId,version.id);
 await f.tick();assert.equal(f.store.list('versions').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

async function desktopPaidTask(t:TestContext,{mio=false}={}){
 const f=await fixture(t,{persistent:true,desktop:true});
 const video=path.join(f.root,'minimax-output.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=180x320:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
 const bytes=await readFile(video);
 const submitUrl='https://api.minimax.io/v2/video_generation';
 const queryUrl='https://api.minimax.io/v2/query/video_generation/original-task';
 const outputUrl='https://output.example/recovered.mp4';
 let ready=true;
 f.reply((url,init)=>{
  const authorization=new Headers(init.headers).get('Authorization');
  if(init.method==='POST'){
   assert.equal(url,submitUrl);assert.equal(authorization,'Bearer original-synthetic-key');
   assert.equal(JSON.parse(String(init.body)).model,'MiniMax-H3');
   return json({task_id:'original-task'});
  }
  assert.equal(init.method,'GET');
  if(url===outputUrl){assert.equal(authorization,null);return new Response(bytes);}
  assert.equal(url,queryUrl);assert.equal(authorization,'Bearer original-synthetic-key');
  return json({task:{id:'original-task',...(ready?{status:'succeeded',content:{url:outputUrl}}:{status:'running'})}});
 });
 let accepted:JobRecord;
 if(mio){
  const journal=createAgentTaskJournal(f.store),tools=createAgentTaskTools({store:f.store,services:f.services});
  const removeGate=setAgentTaskEffectGate(f.store.db,()=>{});
  t.after(()=>{removeGate();tools.dispose();});
  const run=journal.create({requestId:randomUUID(),projectId:f.projectId,text:'Generate a synthetic shot',configuration:mioFixtureConfiguration}).run;
  const {requestId:_requestId,...args}=f.input();
  const prepared=tools.prepare({projectId:f.projectId,operation:'generation.submit',input:args});
  const step=beginFixtureToolStep(journal,run.id,{tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:'mioon_generation_submit',arguments:args as AgentTaskJson}});
  journal.markDispatch(run.id,step.id);
  const outcome=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,beforeEffect:()=>journal.assertTargets(f.projectId,prepared.targets),recordInside:(result,changes)=>journal.completeStepInside(run.id,step.id,{result,changes}),appendChangesInside:changes=>journal.appendChangesInside(run.id,step.id,changes)});
  assert.equal(outcome.recorded,true);
  const changes=journal.snapshot(run.id).changes.filter(change=>change.stepId===step.id);
  const fields=changes.flatMap(change=>projectAgentTaskChangeDisplay(change).fields);
  assert.equal(fields.find(field=>field.property==='provider')?.after,'minimax');
  assert.equal(fields.find(field=>field.property==='model')?.after,'MiniMax-H3');
  accepted=f.store.list('jobs')[0] as JobRecord;
  await f.tick();await f.stop();
  assert.equal(journal.step(step.id).cost,'submitted');
 }else{accepted=await f.submit();await f.tick();await f.stop();}
 const submitted=f.job(accepted.id),snapshot=structuredClone(submitted.snapshot);
 const assertIdentity=()=>{
  const current=f.job(submitted.id);
  assert.equal(current.requestId,submitted.requestId);
  assert.equal(current.requestHash,submitted.requestHash);
  assert.deepEqual(current.snapshot,snapshot);
  assert.equal(current.providerJobId,'original-task');
  assert.equal(current.submissionCount,1);
  assert.equal(f.store.list('jobs').length,1);
  assert.deepEqual(f.calls.filter(call=>call.init.method==='POST').map(call=>call.url),[submitUrl]);
 };
 assert.equal(submitted.status,'running');
 assertIdentity();
 const assertPublished=(queryCount=1)=>{
  const current=f.job(submitted.id),versions=f.store.list('versions') as ServiceRow[],assets=f.store.list('assets') as ServiceRow[];
  assert.equal(current.status,'succeeded',JSON.stringify(current.error));
  assert.equal(current.error,null);
  assertIdentity();
  assert.deepEqual(f.calls.map(call=>call.url),[submitUrl,...Array(queryCount).fill(queryUrl),outputUrl]);
  assert.equal(versions.length,1);assert.equal(assets.length,1);
  assert.equal(versions[0]!.id,current.versionId);
  assert.equal(versions[0]!.jobId,submitted.id);
  assert.equal(versions[0]!.assetId,assets[0]!.id);
  const proof=projectOutputPublicationProofSchema.parse(assets[0]!.publication);
  assert.deepEqual(proof.owner,{kind:'generation',id:submitted.id,requestId:submitted.requestId,inputHash:submitted.requestHash});
 };
 return {f,submitted,assertIdentity,assertPublished,setReady(value:boolean){ready=value;}};
}

for(const reopenApp of [false,true])test(`Q17 MiniMax queries and publishes the original task after ${reopenApp?'an application update and reopen':'a desktop backend restart'}`,async t=>{
 const {f,submitted,assertPublished}=await desktopPaidTask(t);
 if(reopenApp){
  // An installed 0.1.2 can leave the known task behind a paused projection.
  f.services.saveJob(submitted,{phase:'connection_required',nextPollAt:Date.now()+60_000,error:{code:'VIDEO_CREDENTIAL_UNAVAILABLE',message:'Synthetic old credential error',retryable:true}});
  assert.equal(createProjectBackgroundState(f.store).snapshot().find(task=>task.taskId===submitted.id)?.keepAlive,false);
 }
 await f.restart({reopenApp});
 await f.tick();await f.stop();
 assertPublished();
});

async function desktopTaskDiagnostic(f:Awaited<ReturnType<typeof fixture>>,job:JobRecord,cause:string,recovery:'automatic'|'user_action'){
 const diagnostic={kind:'video_credential',cause,recovery};
 const exposed=await f.services.call('job.get',{jobId:job.id}) as JobRecord;
 const event=f.store.db.prepare('SELECT event FROM job_events WHERE jobId=? ORDER BY id DESC LIMIT 1').get(job.id);
 const eventError=JSON.parse(String(event?.event)).error;
 assert.deepEqual((job.error as ServiceRow).diagnostic,diagnostic);
 assert.deepEqual((exposed.error as ServiceRow).diagnostic,diagnostic);
 assert.deepEqual(eventError.diagnostic,diagnostic);
 assert.equal((exposed.error as ServiceRow).retryable,recovery==='automatic');
 assert.deepEqual(exposed.allowedActions,['cancel']);
 const serialized=JSON.stringify([job.error,exposed.error,eventError]);
 assert.doesNotMatch(serialized,/original-synthetic-key|credentialRef|encrypted/);
 const envelope=JSON.parse(await readFile(path.join(f.root,'video-settings','settings.json'),'utf8'));
 for(const credential of envelope.credentials)if(credential.encrypted)assert.equal(serialized.includes(credential.encrypted),false);
 const projected=createProjectBackgroundState(f.store).snapshot().find(task=>task.taskId===job.id);
 assert.equal(projected?.keepAlive,recovery==='automatic');
}

test('Q17 MiniMax treats a settings save during a Mio task query as temporary and resumes the same task',async t=>{
 // The provider captures Date.now at construction for its GET cache.
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const {f,submitted,assertIdentity,assertPublished,setReady}=await desktopPaidTask(t,{mio:true});
 const probe=f.desktopVault!.blockNextDecrypt();
 t.after(()=>probe.release());
 const pollStarted=Date.now();
 const poll=f.tick();
 await probe.entered;
 const configuration={...f.configuration,enabled:false};
 const save=f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'keep'}});
 probe.release();
 const saved=await save;
 await poll;
 assert.equal(saved.revision,2);
 assertIdentity();assert.equal(f.calls.length,1);
 const waiting=f.job(submitted.id);
 await desktopTaskDiagnostic(f,waiting,'VIDEO_SETTINGS_CONFLICT','automatic');
 assert.equal(waiting.phase,'connection_retrying');
 assert.ok(Number(waiting.nextPollAt)>pollStarted);
 t.mock.timers.setTime(Number(waiting.nextPollAt));
 setReady(false);
 await f.tick();
 const resumed=f.job(submitted.id);
 assert.equal(resumed.status,'running');assert.equal(resumed.phase,'polling');assert.equal(resumed.error,null);
 assertIdentity();assert.equal(f.calls.length,2);
 setReady(true);
 t.mock.timers.setTime(Number(resumed.nextPollAt));
 await f.tick();await f.stop();
 assertPublished(2);
});

test('Q17 MiniMax resumes the original query when macOS vault authorization completes after a timeout',async t=>{
 const {f,submitted,assertIdentity,assertPublished}=await desktopPaidTask(t);
 const probe=f.desktopVault!.blockNextProbe();
 t.after(()=>probe.release());
 await f.restart({reopenApp:true});
 assert.equal((await f.settings.get()).storage.reasonCode,'OS_SECRET_STORE_PENDING');
 const pollStarted=Date.now();
 await f.tick();
 const waiting=f.job(submitted.id);
 assertIdentity();assert.equal(f.calls.length,1);
 await desktopTaskDiagnostic(f,waiting,'VIDEO_SETTINGS_STORAGE_UNAVAILABLE','automatic');
 assert.equal(waiting.phase,'connection_retrying');
 assert.ok(Number(waiting.nextPollAt)>pollStarted);
 const completed=Promise.withResolvers<void>();
 const pending=setInterval(()=>{if(f.job(submitted.id).status==='succeeded')completed.resolve();},20);
 const deadline=setTimeout(()=>completed.reject(Error('The original task was not woken before its scheduled retry')),3000);
 probe.release();
 try {await completed.promise;} finally {clearInterval(pending);clearTimeout(deadline);}
 await f.stop();
 assert.ok(Date.now()<Number(waiting.nextPollAt));
 assertPublished();
 const settings=await f.settings.get();
 assert.deepEqual(settings.storage,{persistentAvailable:true,reasonCode:null,sessionScope:'server'});
 assert.equal(settings.connections[0]!.secret.storage,'persistent');
 assert.doesNotMatch(JSON.stringify(settings),/original-synthetic-key|credentialRef|encrypted/);
});

test('Q17-B transient credential errors back off to five minutes and a manual check wakes the same paid task',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t),job=await f.submit();
 await f.tick();
 const submitted=f.job(job.id),snapshot=structuredClone(submitted.snapshot);
 let attempts=0;
 f.overrideAcquire(async()=>{attempts++;throw Object.assign(Error('synthetic settings conflict'),{code:'VIDEO_SETTINGS_CONFLICT'});});
 for(const delay of [5_000,10_000,20_000,40_000,80_000,160_000,300_000,300_000]){
  const before=attempts;
  await f.tick();
  const waiting=f.job(job.id);
  assert.equal(waiting.phase,'connection_retrying');
  assert.equal(waiting.nextPollAt,Date.now()+delay);
  assert.equal(attempts,before+1);
  t.mock.timers.setTime(Number(waiting.nextPollAt)-1);
  await f.tick();
  assert.equal(attempts,before+1);
  t.mock.timers.setTime(Number(waiting.nextPollAt));
 }
 t.mock.timers.setTime(Date.now()-1);
 f.overrideAcquire();
 await assert.rejects(f.services.call('job.reconcile',{jobId:job.id,providerJobId:'different-task'}),{code:'TASK_ID_CONFLICT'});
 await f.services.call('job.reconcile',{jobId:job.id});
 await f.tick();
 assert.deepEqual(f.calls.map(call=>call.init.method),['POST','GET']);
 const resumed=f.job(job.id);
 assert.equal(resumed.phase,'polling');assert.equal(resumed.error,null);
 assert.equal(resumed.submissionCount,1);assert.equal(resumed.providerJobId,submitted.providerJobId);
 assert.equal(resumed.requestId,submitted.requestId);assert.deepEqual(resumed.snapshot,snapshot);
});

for(const [cause,recovery] of [['VIDEO_CREDENTIAL_UNAVAILABLE','throw'],['VIDEO_CREDENTIAL_INVALID','return']] as const)
test(`Q17-B ${recovery} from credential acquisition pauses queued work without a POST or background retry`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t,{persistent:true}),job=await f.submit(),snapshot=structuredClone(job.snapshot);
 let attempts=0;
 f.overrideAcquire(async()=>{
  attempts++;
  const claiming=f.job(job.id);
  assert.equal(claiming.status,'submitting');
  assert.equal(claiming.submissionCount,1);
  if(recovery==='throw')throw Object.assign(Error('synthetic private detail'),{code:'UNRECOGNIZED_PRIVATE_CODE'});
  return 'invalid key with spaces';
 });
 await f.tick();
 const waiting=f.job(job.id);
 await desktopTaskDiagnostic(f,waiting,cause,'user_action');
 assert.equal(waiting.status,'queued');assert.equal(waiting.phase,'connection_required');
 assert.equal(waiting.submissionCount,0);assert.equal(waiting.providerJobId,null);
 assert.deepEqual(waiting.snapshot,snapshot);assert.equal(f.store.list('jobs').length,1);
 t.mock.timers.setTime(Date.now()+600_000);
 await f.tick();
 assert.equal(attempts,1);assert.equal(f.calls.length,0);
 await f.restart();await f.tick();
 assert.equal(attempts,1);
 assert.equal(f.job(job.id).phase,'connection_required');
 assert.equal(f.calls.length,0);
 const cancelled=await f.services.call('job.cancel',{jobId:job.id}) as JobRecord;
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.phase,'cancelled_before_dispatch');
 assert.equal(cancelled.id,job.id);assert.equal(cancelled.projectId,f.projectId);assert.equal(cancelled.shotId,f.shot.id);
 assert.equal(cancelled.error,null);assert.equal(cancelled.providerJobId,null);assert.equal(cancelled.submissionCount,0);
 await assert.rejects(f.services.call('job.reconcile',{jobId:job.id,providerJobId:'unrelated-task'}),{code:'INVALID_RECONCILIATION_STATE'});
 await f.tick();assert.equal(f.calls.length,0);
});

test('Q17-C a replacement for a corrupt persistent key retrieves and publishes the same paid task',async t=>{
 const {f,submitted,assertIdentity,assertPublished}=await desktopPaidTask(t);
 const binding=submitted.snapshot.executionBinding as VideoExecutionBinding;
 const file=path.join(f.root,'video-settings','settings.json');
 const state=JSON.parse(await readFile(file,'utf8'));
 state.credentials[0].encrypted=Buffer.from('synthetic-corrupt-ciphertext').toString('base64');
 await writeFile(file,JSON.stringify(state));
 await f.restart();await f.tick();
 await desktopTaskDiagnostic(f,f.job(submitted.id),'VIDEO_SETTINGS_CORRUPT','user_action');
 assertIdentity();assert.equal(f.calls.length,1);
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:f.secret()});
 const current=f.settings.select(binding.connectionId,2,binding.model.id);
 assert.notEqual(current.credentialRef,binding.credentialRef);
 assert.equal(await f.settings.acquire(current),'original-synthetic-key');
 await assert.rejects(f.settings.acquire(binding),{code:'VIDEO_SETTINGS_CORRUPT'});
 await f.services.call('job.reconcile',{jobId:submitted.id});
 await f.tick();
 assertPublished();
});

test('Q17-C a replacement account that cannot find the paid task pauses until an explicit check with a different key',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const {f,submitted,assertIdentity,assertPublished}=await desktopPaidTask(t);
 const originalReply=f.calls[0];
 assert.equal(originalReply?.init.method,'POST');
 const originalDownload=await readFile(path.join(f.root,'minimax-output.mp4'));
 const outputUrl='https://output.example/recovered.mp4';
 f.reply((url,init)=>{
  assert.equal(init.method,'GET');
  const authorization=new Headers(init.headers).get('Authorization');
  if(url===outputUrl){assert.equal(authorization,null);return new Response(originalDownload);}
  assert.match(url,/\/query\/video_generation\/original-task$/);
  if(authorization==='Bearer original-synthetic-key')return new Response('{}',{status:401});
  if(authorization==='Bearer other-account-synthetic-key')return new Response('synthetic private service detail',{status:404});
  assert.equal(authorization,'Bearer recovered-account-synthetic-key');
  return json({task:{id:'original-task',status:'succeeded',content:{url:outputUrl}}});
 });
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:f.secret('other-account-synthetic-key')});
 await f.tick();
 const waiting=f.job(submitted.id);
 await desktopTaskDiagnostic(f,waiting,'VIDEO_TASK_NOT_FOUND_WITH_REPLACEMENT','user_action');
 assert.doesNotMatch(JSON.stringify(waiting.error),/private service detail|other-account/);
 assert.equal(waiting.phase,'connection_required');assert.equal(f.calls.length,3);assertIdentity();
 t.mock.timers.setTime(Date.now()+600_000);
 await f.tick();await f.restart();await f.tick();
 assert.equal(f.calls.length,3);assertIdentity();
 await f.settings.put({action:'save',expectedRevision:2,configuration:f.configuration,secret:f.secret('recovered-account-synthetic-key')});
 await f.services.call('job.reconcile',{jobId:submitted.id});
 await f.tick();
 assertPublished(4);
});

test('Q17-C an address change cannot send a replacement key to either service for a frozen task',async t=>{
 const f=await fixture(t,{providerId:'compatible'});
 f.reply((url,init)=>{
  assert.equal(url,'https://old.example/v1/videos');assert.equal(init.method,'POST');
  return json({id:'video_original',status:'queued'});
 });
 const job=await f.submit();await f.tick();await f.stop();
 const submitted=f.job(job.id);
 assert.equal(submitted.providerJobId,'video_original');
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:{action:'remove'}});
 await f.tick();await f.stop();
 await f.settings.put({action:'save',expectedRevision:2,configuration:{...f.configuration,baseUrl:'https://new.example/v1'},secret:f.secret('new-address-synthetic-key')});
 await f.services.call('job.reconcile',{jobId:job.id});
 await f.tick();
 const waiting=f.job(job.id);
 assert.equal(waiting.phase,'connection_required');
 assert.equal((waiting.error as ServiceRow).code,'VIDEO_SETTINGS_NOT_CONFIGURED');
 assert.deepEqual(waiting.snapshot,submitted.snapshot);assert.equal(waiting.providerJobId,submitted.providerJobId);
 assert.equal(waiting.submissionCount,1);assert.equal(f.calls.length,1);
});

test('Q17-C a new key cannot reconcile an unbound remote ID or dispatch a queued job frozen to a removed key',async t=>{
 const f=await fixture(t,{providerId:'kling'});
 f.reply((_url,init)=>{assert.equal(init.method,'POST');throw Error('Synthetic lost submission reply');});
 const uncertain=await f.submit();
 await f.tick();await f.stop();
 assert.equal(f.job(uncertain.id).status,'submission_unknown');
 const queued=await f.submit();
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:{action:'remove'}});
 await f.settings.put({action:'save',expectedRevision:2,configuration:f.configuration,secret:f.secret('replacement-synthetic-key')});
 await assert.rejects(f.services.call('job.reconcile',{jobId:uncertain.id,providerJobId:'unbound-task'}),{code:'VIDEO_SETTINGS_NOT_CONFIGURED'});
 await f.tick();await f.stop();
 assert.equal(f.job(uncertain.id).providerJobId,null);
 assert.equal(f.job(queued.id).phase,'connection_required');
 assert.equal(f.job(queued.id).providerJobId,null);
 assert.equal(f.job(queued.id).submissionCount,0);
 assert.equal(f.calls.length,1);
});

test('Q17 MiniMax retains a paid task when a settings save loses file ownership and recovers it on restart',async t=>{
 const {f,submitted,assertIdentity,assertPublished}=await desktopPaidTask(t);
 const file=path.join(f.root,'video-settings','settings.json'),before=await readFile(file);
 // Replacing the inode with equal bytes forces the real owner comparison to
 // fail. Restart can safely read this unchanged envelope under a new owner.
 await rename(file,`${file}.previous`);
 await writeFile(file,before,{mode:0o600});
 const configuration={...f.configuration,enabled:false};
 await assert.rejects(f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'keep'}}),{code:'VIDEO_SETTINGS_SAVE_FAILED'});
 await assert.rejects(f.settings.get(),{code:'VIDEO_SETTINGS_SAVE_FAILED'});
 await f.tick();await f.stop();
 const paused=f.job(submitted.id);
 assertIdentity();assert.equal(f.calls.length,1);
 assert.deepEqual(await readFile(file),before);
 await desktopTaskDiagnostic(f,paused,'VIDEO_SETTINGS_SAVE_FAILED','user_action');
 assert.equal(paused.phase,'connection_required');
 await f.restart();
 await f.tick();await f.stop();
 assertPublished();
});

test('Q17 MiniMax pauses after explicit removal without rebinding or resubmitting the paid task',async t=>{
 const {f,submitted,assertIdentity}=await desktopPaidTask(t);
 const binding=submitted.snapshot.executionBinding as VideoExecutionBinding;
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:{action:'remove'}});
 await f.tick();
 const paused=f.job(submitted.id);
 await desktopTaskDiagnostic(f,paused,'VIDEO_SETTINGS_NOT_CONFIGURED','user_action');
 assert.equal(paused.phase,'connection_required');
 await f.settings.put({action:'save',expectedRevision:2,configuration:f.configuration,secret:f.secret()});
 const replacement=f.settings.select(f.configuration.id,3,f.configuration.models[0]!.id);
 assert.notEqual(replacement.credentialRef,binding.credentialRef);
 await f.tick();await f.stop();
 assertIdentity();assert.equal(f.calls.length,1);
 assert.equal(f.job(submitted.id).phase,'connection_required');
 assert.equal(f.store.list('versions').length,0);
});

for(const retained of [true,false])test(`MiniMax CN rejected output ${retained?'keeps its persistent credential and downloads once':'can use a replacement key after losing its session credential without rebinding'}`,async t=>{
 const f=await fixture(t,{persistent:true}),configuration=structuredClone(f.configuration),video=path.join(f.root,'recovered-output.mp4');
 configuration.region='cn';
 await f.settings.put({action:'save',expectedRevision:1,configuration,secret:retained?f.secret():{...f.secret(),storage:'session'}});
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=360x640:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
 const bytes=await readFile(video),job=await f.submit({configurationRevision:2,parameters:{resolution:'2K'}}),snapshot=structuredClone(job.snapshot),binding=snapshot.executionBinding as VideoExecutionBinding;
 const unapprovedUrl='https://unverified.example/private-signed-path.mp4?token=synthetic-secret-token&signature=synthetic-secret-signature';
 let output=unapprovedUrl;
 f.reply((url,init)=>{
  if(init.method==='POST'){
   assert.equal(url,'https://api.minimax.cn/v2/video_generation');
   assert.equal(new Headers(init.headers).get('Authorization'),'Bearer original-synthetic-key');
   const body=JSON.parse(String(init.body)) as ServiceRow;
   assert.equal(body.model,'MiniMax-H3');assert.equal(body.resolution,'2K');assert.equal(body.duration,4);
   return json({task_id:'original-task'});
  }
  assert.equal(init.method,'GET');
  if(url==='https://output.example/recovered.mp4'){
   assert.equal(new Headers(init.headers).get('Authorization'),null);return new Response(bytes);
  }
  assert.equal(url,'https://api.minimax.cn/v2/query/video_generation/original-task');
  assert.equal(new Headers(init.headers).get('Authorization'),'Bearer original-synthetic-key');
  return json({task:{id:'original-task',status:'succeeded',content:{url:output}}});
 });
 const assertIdentity=()=>{
  const current=f.job(job.id);
  assert.equal(current.requestId,job.requestId);assert.equal(current.providerJobId,'original-task');assert.equal(current.submissionCount,1);
  assert.deepEqual(current.snapshot,snapshot);assert.equal(f.store.list('jobs').length,1);
  assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 };
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'running');assertIdentity();
 f.ready(job.id);await f.tick();await f.stop();
 const rejected=f.job(job.id),error=rejected.error as ServiceRow;
 assert.equal(rejected.status,'downloading');assert.equal(error.code,'UNAPPROVED_OUTPUT_HOST');
 assert.match(String(error.message),/unverified\.example/);
 assert.doesNotMatch(String(error.message),/private-signed-path|synthetic-secret-token|synthetic-secret-signature|\?token=/);
 assert.equal(f.calls.length,2);assert.equal(f.store.list('versions').length,0);assertIdentity();
 await f.live(false);await f.restart();
 if(!retained){
  await assert.rejects(f.settings.acquire(binding),{code:'VIDEO_SETTINGS_NOT_CONFIGURED'});
  f.ready(job.id);await f.tick();await f.stop();assert.equal(f.job(job.id).phase,'connection_required');assert.equal(f.calls.length,2);assertIdentity();
  await f.settings.put({action:'save',expectedRevision:2,configuration,secret:f.secret()});
  const replacement=f.settings.select(configuration.id,3,configuration.models[0]!.id);assert.notEqual(replacement.credentialRef,binding.credentialRef);assert.equal(await f.settings.acquire(replacement),'original-synthetic-key');
  await f.restart();output='https://output.example/recovered.mp4';
  await assert.rejects(f.settings.acquire(binding),{code:'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.equal(f.job(job.id).phase,'connection_required');assert.equal(f.calls.length,2);assertIdentity();
  await f.services.call('job.reconcile',{jobId:job.id});
 } else {
  assert.equal(await f.settings.acquire(binding),'original-synthetic-key');assert.equal(f.calls.length,2);assertIdentity();
  output='https://output.example/recovered.mp4';
  f.ready(job.id);
 }
 await f.tick();await f.stop();
 const completed=f.job(job.id),versions=f.store.list('versions') as ServiceRow[],assets=f.store.list('assets') as ServiceRow[];
 assert.equal(completed.status,'succeeded');assert.equal(completed.error,null);assertIdentity();
 assert.equal(f.calls.length,4);assert.equal(versions.length,1);assert.equal(assets.length,1);
 assert.equal(versions[0]!.id,completed.versionId);assert.equal(versions[0]!.jobId,job.id);assert.deepEqual(versions[0]!.snapshot,snapshot);
 assert.equal(assets[0]!.id,versions[0]!.assetId);assert.equal(assets[0]!.width,360);assert.equal(assets[0]!.height,640);assert.equal(assets[0]!.duration,4);
 await f.tick();await f.stop();assertIdentity();assert.equal(f.calls.length,4);assert.equal(f.store.list('versions').length,1);
});

test('Kling external task reconciliation binds the existing task without a replacement submit',async t=>{
 const f=await fixture(t,{providerId:'kling'});f.reply((_url,init)=>{if(init.method==='POST')throw Error('synthetic response lost');return json({code:0,data:[]});});
 const job=await f.submit();await f.tick();assert.equal(f.job(job.id).status,'submission_unknown');await f.stop();
 await f.live(false);
 f.reply((url,init)=>{assert.equal(init.method,'GET');assert.ok(url.includes('external_task_ids='));return json({code:0,data:[{id:'recovered-kling-task',external_id:job.requestId,status:'processing',outputs:[]}]});});
 f.ready(job.id);await f.tick();assert.equal(f.job(job.id).providerJobId,'recovered-kling-task');assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

test('old environment generations do not acquire a newly configured UI connection',async t=>{
 const f=await fixture(t);await assert.rejects(f.services.call('generation.submit',{shotId:f.shot.id,expectedRevision:f.shot.revision,requestId:randomUUID(),providerId:'minimax',model:f.configuration.models[0]!.modelId}),error=>{
  assert.equal((error as {details?:ServiceRow}).details?.providerId,'minimax');
  assert.equal((error as {details?:ServiceRow}).details?.mutationOutcome,'not_applied');
  return (error as {code?:string}).code==='PROVIDER_DISABLED'&&(error as {status?:number}).status===403;
 });
 assert.equal(f.calls.length,0);assert.equal(resolveVideoEndpoint('minimax','cn'),'https://api.minimax.cn');
});

test('restart preserves uncertain acceptance even when a stored connection binding is malformed',async t=>{
 const f=await fixture(t),job=await f.submit();
 f.store.put('jobs',{...job,status:'submitting',snapshot:{...job.snapshot,executionBinding:null}});
 const services=createServices(f.store,new Map(),{videoSettings:f.settings}),worker=startWorker(f.store,services,new Map());
 try{await worker.tick();assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.calls.length,0);assert.equal(f.store.list('versions').length,0);}
 finally{await worker.stop();await services.drain();}
});
