import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {defaultVideoModels,resolveVideoEndpoint,videoBindingCapabilities,videoInputProfile} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';
import {parse} from '../packages/contracts/src/index.ts';

const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const frozenDate=()=>Date.UTC(2026,9,20);
function codec(){
 const key=randomBytes(32);
 return {encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64');},decrypt(value:string){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString();}};
}
async function fixture(t:TestContext,{persistent=false,providerId='minimax' as VideoConnectionConfiguration['providerId'],liveGeneration=true}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-generation-'))),secretCodec=codec();
 const settingsOptions={directory:path.join(root,'video-settings'),privateRoot:root,...(persistent?{secretCodec,storage:{persistentAvailable:true,sessionScope:'server' as const,reasonCode:null}}:{})};
 let store=openStore(root),settings=await createVideoSettings(settingsOptions),worker:ReturnType<typeof startWorker>|null=null;
 const calls:Array<{url:string;init:RequestInit}>=[];
 let response:(url:string,init:RequestInit)=>Response|Promise<Response>=(url,init)=>{if(init.method==='POST')return json({task_id:'original-task'});return json({task:{id:'original-task',status:'running'}});};
 const videoFetch:typeof fetch=async(input,init)=>{const request={url:String(input),init:init??{}};calls.push(request);return response(request.url,request.init);};
 const registry=()=>createProviderRegistry({db:store.db,root,env:{}});
 let providers=registry(),services=createServices(store,providers,{videoSettings:settings,videoFetch,profileNow:frozenDate});
 if(liveGeneration)await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId,name:'Original account',region:providerId==='ark'?'cn-beijing':providerId==='wan'?'cn-beijing':'global',workspaceId:'',enabled:true,archived:false,outputHosts:['output.example'],models:defaultVideoModels(providerId)};
 const secret=(value='original-synthetic-key')=>({action:'replace' as const,value,storage:persistent?'persistent' as const:'session' as const});
 await settings.put({action:'save',expectedRevision:0,configuration,secret:secret()});
 const project=await services.call('project.create',{name:'Configured video integration'}) as ServiceRow;
 const shot=await services.call('shot.create',{projectId:project.id,title:'Test shot',prompt:'Synthetic shapes move.',aspectRatio:'9:16',duration:providerId==='kling'?5:4,referenceAssetIds:[]}) as ServiceRow;
 const input=()=>({shotId:String(shot.id),expectedRevision:Number(shot.revision),requestId:randomUUID(),providerId,model:configuration.models[0]!.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id});
 const f={root,configuration,secret,calls,shot,input,
  get store(){return store;},get settings(){return settings;},get services(){return services;},
  reply(fn:typeof response){response=fn;},
  job(id:string){return store.get('jobs',id) as JobRecord;},
  async submit(change:Record<string,unknown>={}){return await services.call('generation.submit',{...input(),...change}) as JobRecord;},
  async live(enabled:boolean){return services.call('workspace.settings.set',{expectedRevision:services.configuration.get().revision,liveGeneration:enabled});},
  async tick(){worker??=startWorker(store,services,providers);await worker.tick();},
  async stop(){await worker?.stop();worker=null;},
  async restart(){await f.stop();await services.drain();await settings.close();store.close();store=openStore(root);settings=await createVideoSettings(settingsOptions);providers=registry();services=createServices(store,providers,{videoSettings:settings,videoFetch,profileNow:frozenDate});},
  ready(id:string){services.saveJob(f.job(id),{nextPollAt:0});},
 };
 t.after(async()=>{await f.stop();await services.drain();await settings.close();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}

// Seed a pre-SDK persisted row through the real settings history. Current
// admission deliberately refuses these parameters, so historical rows are
// fixtures rather than newly submitted paid work.
async function historicalMinimaxJob(f:Awaited<ReturnType<typeof fixture>>,status:JobRecord['status'],parameters:Record<string,unknown>={}){
 const current=await f.submit(),configuration=structuredClone(f.configuration);
 configuration.models[0]!.durationResolutionMap=[{duration:[4,8],resolution:['768P']}];
 await f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'keep'}});
 const binding=f.settings.select(configuration.id,2,configuration.models[0]!.id),profile=videoInputProfile(binding),capabilities=videoBindingCapabilities(binding);
 capabilities.modelCapabilities[0]!.resolutions=['768P'];
 const snapshot={...current.snapshot,parameters,executionBinding:binding,inputProfileId:profile.profileId,inputProfileVersion:profile.profileVersion,capabilities};
 f.store.put('jobs',{...current,status,phase:status==='queued'?'waiting':'polling',snapshot,providerJobId:status==='running'?'original-task':null,submissionCount:status==='queued'?0:1,nextPollAt:0});
 return f.job(current.id);
}

test('historical 768P settings and paid tasks restart, query and publish unchanged through the SDK after a 2K account edit',async t=>{
 const f=await fixture(t,{persistent:true}),job=await historicalMinimaxJob(f,'running',{resolution:'768P'}),snapshot=structuredClone(job.snapshot),binding=job.snapshot.executionBinding as VideoExecutionBinding;
 await f.restart();
 assert.deepEqual(f.settings.list()[0]!.configuration.models[0]!.durationResolutionMap,[{duration:[4,8],resolution:['768P']}]);
 assert.equal(await f.settings.acquire(binding),'original-synthetic-key');assert.deepEqual(f.job(job.id).snapshot,snapshot);
 const next=structuredClone(f.configuration);next.region='cn';
 await f.settings.put({action:'save',expectedRevision:2,configuration:next,secret:f.secret('new-2k-account-key')});
 await f.settings.put({action:'archive',expectedRevision:3,connectionId:next.id});await f.live(false);await f.restart();
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
 assert.equal(f.job(job.id).status,'succeeded');assert.equal(f.calls.length,2);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,0);
 assert.deepEqual(f.job(job.id).snapshot,snapshot);assert.equal(f.store.list('versions').length,1);
 assert.deepEqual((f.store.list('versions')[0] as ServiceRow).snapshot,snapshot);assert.equal(await f.settings.acquire(binding),'original-synthetic-key');
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
 await assert.rejects(f.submit(),{code:'LIVE_GENERATION_DISABLED'});assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
 await f.live(true);const job=await f.submit();await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'synthetic definitive failure'}});
 const before=structuredClone(f.job(job.id)),retryInput={jobId:job.id,requestId:randomUUID()};
 await f.live(false);await assert.rejects(f.services.call('job.retry',retryInput),{code:'LIVE_GENERATION_DISABLED'});
 assert.deepEqual(f.job(job.id),before);assert.equal(f.store.list('jobs').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 await f.live(true);const retry=await f.services.call('job.retry',retryInput) as JobRecord;
 assert.equal(retry.retryOfJobId,job.id);assert.deepEqual(retry.snapshot,job.snapshot);await f.tick();
 assert.equal(f.job(retry.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,2);
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
 assert.equal(job.snapshot.executionConnectionName,'Original account');assert.equal(f.store.list('jobs').length,1);
 await assert.rejects(f.services.call('generation.submit',{...request,parameters:{resolution:'768P'}}),{code:'IDEMPOTENCY_CONFLICT'});assert.equal(f.calls.length,0);
});

test('queued jobs and explicit retries retain the old endpoint, model and credential after settings edit',async t=>{
 const f=await fixture(t),job=await f.submit(),original=structuredClone(job.snapshot);
 const next=structuredClone(f.configuration);next.name='New account';next.region='cn';next.models[0]!.modelId='another-official-model';
 await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.url,'https://api.minimax.io/v2/video_generation');
 assert.equal(new Headers(f.calls[0]!.init.headers).get('Authorization'),'Bearer original-synthetic-key');
 assert.equal((JSON.parse(String(f.calls[0]!.init.body)) as ServiceRow).model,f.configuration.models[0]!.modelId);assert.deepEqual(f.job(job.id).snapshot,original);
 await f.stop();f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'synthetic'}});
 const retry=await f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}) as JobRecord;
 assert.deepEqual(retry.snapshot,original);assert.equal(retry.retryOfJobId,job.id);assert.equal(f.calls.length,1);
});

test('missing credentials pause queued work and explicit restoration resumes one POST on the same job',async t=>{
 const f=await fixture(t),job=await f.submit(),binding=job.snapshot.executionBinding as VideoExecutionBinding;
 await f.settings.put({action:'save',expectedRevision:1,configuration:f.configuration,secret:{action:'remove'}});
 await f.tick();assert.equal(f.calls.length,0);assert.equal(f.job(job.id).status,'queued');assert.equal(f.job(job.id).phase,'connection_required');assert.equal(f.job(job.id).submissionCount,0);
 await f.settings.put({action:'restoreCredential',expectedRevision:2,connectionId:binding.connectionId,credentialRef:binding.credentialRef,secret:f.secret()});
 f.ready(job.id);await f.tick();assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);assert.equal(f.job(job.id).providerJobId,'original-task');
});

test('uncertain accepted submissions survive restarts and config edits without another generation POST',async t=>{
 const f=await fixture(t,{persistent:true});f.reply(()=>{throw Error('synthetic response lost');});const job=await f.submit();await f.tick();
 assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.calls.length,1);await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 const next=structuredClone(f.configuration);next.region='cn';await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.restart();assert.equal(f.services.configuration.get().liveGeneration,true);f.ready(job.id);await f.tick();assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.calls.length,1);
});

test('known task recovery downloads and publishes one decoded immutable version using archived settings',async t=>{
 const f=await fixture(t,{persistent:true}),video=path.join(f.root,'fixture.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=360x640:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
 const bytes=await readFile(video),job=await f.submit();await f.tick();await f.stop();assert.equal(f.job(job.id).providerJobId,'original-task');
 const next=structuredClone(f.configuration);next.region='cn';await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:f.secret('new-synthetic-key')});
 await f.settings.put({action:'archive',expectedRevision:2,connectionId:f.configuration.id});await f.live(false);await f.restart();assert.equal(f.services.configuration.get().liveGeneration,false);
 f.reply((url,init)=>{assert.notEqual(init.method,'POST');if(url.startsWith('https://output.example/')){assert.equal(new Headers(init.headers).get('Authorization'),null);return new Response(bytes);}assert.ok(url.startsWith('https://api.minimax.io/'));assert.equal(new Headers(init.headers).get('Authorization'),'Bearer original-synthetic-key');return json({task:{id:'original-task',status:'succeeded',content:{url:'https://output.example/result.mp4'}}});});
 f.ready(job.id);await f.tick();assert.equal(f.job(job.id).status,'succeeded');assert.equal(f.store.list('versions').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 const version=f.store.list('versions')[0] as ServiceRow;assert.equal(version.jobId,job.id);assert.equal((version.snapshot as ServiceRow).executionConnectionName,'Original account');
 const selected=f.store.get('shots',String(f.shot.id)) as ServiceRow;assert.equal(selected.selectedVersionId,version.id);
 await f.tick();assert.equal(f.store.list('versions').length,1);assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

test('Kling external task reconciliation binds the existing task without a replacement submit',async t=>{
 const f=await fixture(t,{providerId:'kling'});f.reply((_url,init)=>{if(init.method==='POST')throw Error('synthetic response lost');return json({code:0,data:[]});});
 const job=await f.submit();await f.tick();assert.equal(f.job(job.id).status,'submission_unknown');await f.stop();
 await f.live(false);
 f.reply((url,init)=>{assert.equal(init.method,'GET');assert.ok(url.includes('external_task_ids='));return json({code:0,data:[{id:'recovered-kling-task',external_id:job.requestId,status:'processing',outputs:[]}]});});
 f.ready(job.id);await f.tick();assert.equal(f.job(job.id).providerJobId,'recovered-kling-task');assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
});

test('old environment generations do not acquire a newly configured UI connection',async t=>{
 const f=await fixture(t);await assert.rejects(f.services.call('generation.submit',{shotId:f.shot.id,expectedRevision:f.shot.revision,requestId:randomUUID(),providerId:'minimax',model:f.configuration.models[0]!.modelId}),{code:'PROVIDER_DISABLED'});
 assert.equal(f.calls.length,0);assert.equal(resolveVideoEndpoint('minimax','cn'),'https://api.minimax.cn');
});

test('restart preserves uncertain acceptance even when a stored connection binding is malformed',async t=>{
 const f=await fixture(t),job=await f.submit();
 f.store.put('jobs',{...job,status:'submitting',snapshot:{...job.snapshot,executionBinding:null}});
 const services=createServices(f.store,new Map(),{videoSettings:f.settings}),worker=startWorker(f.store,services,new Map());
 try{await worker.tick();assert.equal(f.job(job.id).status,'submission_unknown');assert.equal(f.calls.length,0);assert.equal(f.store.list('versions').length,0);}
 finally{await worker.stop();await services.drain();}
});
