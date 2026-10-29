import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {defaultVideoModels,SEEDANCE25_MODEL_ID} from '../packages/contracts/src/video-providers.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import type {VideoConnectionConfiguration,VideoModelEntry} from '../packages/contracts/src/video-providers.ts';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const TASK='seedance-task-1';
async function fixture(t:TestContext,{models}:{models?:(defaults:VideoModelEntry[])=>VideoModelEntry[]}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-seedance-generation-'))),store=openStore(root);
 const settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
 const providers=createProviderRegistry({db:store.db,root,env:{}}),calls:Array<{url:string;init:RequestInit}>=[];
 let reply:(url:string,init:RequestInit)=>Response|Promise<Response>=(_url,init)=>json(init.method==='POST'?{id:TASK}:{id:TASK,status:'running'});
 const services=createServices(store,providers,{videoSettings:settings,profileNow:()=>Date.UTC(2026,9,30),videoFetch:async(input,init)=>{const request={url:String(input),init:init??{}};calls.push(request);return reply(request.url,request.init);}});
 await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const defaults=defaultVideoModels('ark'),configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'ark',name:'Ark account',region:'cn-beijing',workspaceId:'',enabled:true,archived:false,outputHosts:['output.example'],models:models?models(defaults):defaults};
 await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',value:'synthetic-ark-key',storage:'session'}});
 const project=await services.call('project.create',{name:'Seedance 2.5 generation'}) as ServiceRow;
 const shot=await services.call('shot.create',{projectId:project.id,title:'Seedance shot',prompt:'A synthetic paper boat drifts across a pond.',aspectRatio:'9:16',duration:4,referenceAssetIds:[]}) as ServiceRow;
 let worker:ReturnType<typeof startWorker>|null=null;
 const f={root,store,services,configuration,calls,project,shot,
  input:(parameters:Record<string,unknown>,model=configuration.models[0]!)=>({shotId:String(shot.id),expectedRevision:Number(shot.revision),requestId:randomUUID(),providerId:'ark',model:model.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:model.id,parameters}),
  async tick(){worker??=startWorker(store,services,providers);await worker.tick();},
  async stop(){await worker?.stop();worker=null;},
  reply(next:typeof reply){reply=next;},
  job(id:string){return store.get('jobs',id) as JobRecord;},
  posts(){return calls.filter(call=>call.init.method==='POST');},
 };
 t.after(async()=>{await f.stop();await services.drain();await settings.close();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const body=(call:{init:RequestInit})=>JSON.parse(String(call.init.body)) as Record<string,unknown>;
async function output(f:Awaited<ReturnType<typeof fixture>>,size:string,seconds:number){
 const file=path.join(f.root,'seedance-output.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${size}:r=24`,'-t',String(seconds),'-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',file]);
 const bytes=await readFile(file);
 f.reply((url,init)=>url.startsWith('https://output.example/')?new Response(bytes):json(init.method==='POST'?{id:TASK}:{id:TASK,status:'succeeded',content:{video_url:'https://output.example/seedance-output.mp4'}}));
}
async function finish(f:Awaited<ReturnType<typeof fixture>>,id:string){await f.tick();await f.stop();f.services.saveJob(f.job(id),{nextPollAt:0});await f.tick();await f.stop();}

test('Seedance 2.5 sends a 30-second 1080p generation with sound without rewriting the 4-second shot',async t=>{
 const f=await fixture(t),parameters={durationSeconds:30,aspectRatio:'21:9',resolution:'1080p',generateAudio:true};
 assert.equal(f.configuration.models[0]!.modelId,SEEDANCE25_MODEL_ID);assert.equal(f.configuration.models[0]!.audio,'optional');
 const job=await f.services.call('generation.submit',f.input(parameters)) as JobRecord;
 assert.deepEqual(job.snapshot.parameters,parameters);assert.equal(job.snapshot.duration,4);assert.equal(job.snapshot.aspectRatio,'9:16');
 const saved=f.store.get('shots',String(f.shot.id)) as ServiceRow;assert.equal(saved.duration,4);assert.equal(saved.aspectRatio,'9:16');
 await f.tick();await f.stop();assert.equal(f.posts().length,1);
 const sent=body(f.posts()[0]!);
 assert.equal(sent.model,SEEDANCE25_MODEL_ID);assert.equal(sent.duration,30);assert.equal(sent.ratio,'21:9');assert.equal(sent.resolution,'1080p');
 assert.equal(sent.generate_audio,true);assert.equal(sent.output_format,'mp4');assert.equal(Object.hasOwn(sent,'watermark'),false);
});

test('Seedance 2.5 keeps sound off unless the user turns it on, and a shot-length request needs no new fields',async t=>{
 const f=await fixture(t);
 for(const parameters of [{resolution:'720p'},{resolution:'480p',generateAudio:false}])await f.services.call('generation.submit',f.input(parameters));
 await f.tick();await f.stop();await f.tick();await f.stop();
 const sent=f.posts().map(body);assert.equal(sent.length,2);
 for(const request of sent){assert.equal(request.generate_audio,false);assert.equal(request.duration,4);assert.equal(request.ratio,'9:16');}
 assert.deepEqual(sent.map(request=>request.resolution).sort(),['480p','720p']);
});

test('Seedance 2.5 automatic duration and adaptive ratio publish an output inside the documented range',async t=>{
 const f=await fixture(t);await output(f,'320x320',5);
 const job=await f.services.call('generation.submit',f.input({durationSeconds:-1,aspectRatio:'adaptive',resolution:'720p'})) as JobRecord;
 await finish(f,job.id);
 assert.equal(body(f.posts()[0]!).duration,-1);assert.equal(body(f.posts()[0]!).ratio,'adaptive');
 assert.equal(f.job(job.id).status,'succeeded');assert.equal(f.store.list('versions').length,1);
 const version=f.store.list('versions')[0] as ServiceRow,asset=f.store.get('assets',String(version.assetId)) as ServiceRow;
 assert.equal(asset.width,320);assert.equal(asset.height,320);
});

test('Seedance 2.5 documented 480p 21:9 size passes the ratio check',async t=>{
 const f=await fixture(t);await output(f,'992x432',4);
 const job=await f.services.call('generation.submit',f.input({durationSeconds:4,aspectRatio:'21:9',resolution:'480p'})) as JobRecord;
 await finish(f,job.id);assert.equal(f.job(job.id).status,'succeeded');
});

const rejectedOutputs:Array<{name:string;size:string;seconds:number;parameters:Record<string,unknown>;code:string}>=[
 {name:'fixed ratio mismatch',size:'320x320',seconds:4,parameters:{durationSeconds:4,aspectRatio:'16:9',resolution:'720p'},code:'OUTPUT_ASPECT_RATIO_MISMATCH'},
 {name:'fixed duration mismatch',size:'180x320',seconds:4,parameters:{durationSeconds:6,aspectRatio:'9:16',resolution:'720p'},code:'OUTPUT_DURATION_MISMATCH'},
 {name:'automatic duration below the documented range',size:'180x320',seconds:2,parameters:{durationSeconds:-1,aspectRatio:'9:16',resolution:'720p'},code:'OUTPUT_DURATION_MISMATCH'},
];
for(const scenario of rejectedOutputs)test(`Seedance 2.5 ${scenario.name} pauses the paid task without publishing or resubmitting`,async t=>{
 const f=await fixture(t);await output(f,scenario.size,scenario.seconds);
 const job=await f.services.call('generation.submit',f.input(scenario.parameters)) as JobRecord;
 await finish(f,job.id);
 const paused=f.job(job.id);
 assert.equal(paused.status,'cancelled');assert.equal(paused.phase,'output_review_required');assert.equal((paused.error as ServiceRow).code,scenario.code);
 assert.equal(paused.providerJobId,TASK);assert.equal(paused.submissionCount,1);assert.equal(f.store.list('versions').length,0);assert.equal(f.posts().length,1);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
});

test('generation-level fields stay with the exact Seedance 2.5 row and an audio choice needs an optional-audio model',async t=>{
 // Subject mode is implemented only for the exact Seedance 2.5 ID.
 const f=await fixture(t,{models:defaults=>[defaults[0]!,{...defaults[0]!,id:randomUUID(),name:'Custom Ark model',modelId:'custom-seedance-model',inputModes:['text','image','frames'],durationResolutionMap:[{duration:[4,8],resolution:['720p']}]},{...defaults[0]!,id:randomUUID(),name:'Silent Seedance',audio:'off'}]});
 const [exact,custom,silent]=f.configuration.models as [VideoModelEntry,VideoModelEntry,VideoModelEntry];
 // The shared request schema rejects Wan-only fields and values outside every
 // model; the frozen binding rejects what this exact model does not offer.
 const rejected:Array<[Record<string,unknown>,VideoModelEntry,string]>=[
  [{durationSeconds:8,resolution:'720p'},custom,'UNSUPPORTED_PARAMETERS'],[{aspectRatio:'16:9',resolution:'720p'},custom,'UNSUPPORTED_PARAMETERS'],
  [{durationSeconds:3,resolution:'720p'},exact,'UNSUPPORTED_PARAMETERS'],[{seed:1,resolution:'720p'},exact,'UNSUPPORTED_PARAMETERS'],
  [{resolution:'4k'},exact,'UNSUPPORTED_PARAMETERS'],[{generateAudio:true,resolution:'720p'},silent,'UNSUPPORTED_PARAMETERS'],
  [{durationSeconds:31,resolution:'720p'},exact,'VALIDATION_ERROR'],[{aspectRatio:'5:4',resolution:'720p'},exact,'VALIDATION_ERROR'],
  [{promptExtend:true,resolution:'720p'},exact,'VALIDATION_ERROR'],[{watermark:false,resolution:'720p'},exact,'VALIDATION_ERROR'],
 ];
 for(const [parameters,model,code] of rejected)await assert.rejects(f.services.call('generation.submit',f.input(parameters,model)),{code},JSON.stringify(parameters));
 assert.equal(f.store.list('jobs').length,0);
 await f.services.call('generation.submit',f.input({resolution:'720p'},custom));await f.services.call('generation.submit',f.input({resolution:'720p'},silent));
 await f.tick();await f.stop();await f.tick();await f.stop();
 const sent=f.posts().map(body);assert.equal(sent.length,2);
 for(const request of sent){assert.equal(request.duration,4);assert.equal(request.generate_audio,false);}
});

test('Seedance 2.5 prompts may use the shot field limit of 5000 characters',async t=>{
 const f=await fixture(t),long='一'.repeat(5000);
 const shot=await f.services.call('shot.update',{shotId:f.shot.id,expectedRevision:f.shot.revision,patch:{prompt:long}}) as ServiceRow;
 const job=await f.services.call('generation.submit',{...f.input({resolution:'720p'}),expectedRevision:Number(shot.revision)}) as JobRecord;
 assert.equal((job.snapshot.prompt as string).length,5000);
 const custom=await fixture(t,{models:defaults=>[{...defaults[0]!,modelId:'custom-seedance-model',inputModes:['text','image','frames']}]});
 const customShot=await custom.services.call('shot.update',{shotId:custom.shot.id,expectedRevision:custom.shot.revision,patch:{prompt:'a'.repeat(1001)}}) as ServiceRow;
 await assert.rejects(custom.services.call('generation.submit',{...custom.input({resolution:'720p'}),expectedRevision:Number(customShot.revision)}),{code:'INVALID_PROMPT'});
});

const sizes=[[360,640],[640,360],[480,480]] as const;
async function references(f:Awaited<ReturnType<typeof fixture>>){
 const images:ServiceRow[]=[];
 for(const [width,height] of sizes)images.push(await f.services.call('asset.import',{projectId:String(f.project.id),name:`Reference ${width}x${height}.png`,mimeType:'image/png',dataBase64:png({width,height,rgba:false}).toString('base64')}) as ServiceRow);
 return {version:1 as const,mode:'reference_images' as const,images:images.map(image=>({role:'reference_image' as const,assetId:String(image.id)}))};
}

test('Seedance 2.5 sends an ordered reference group for this generation only, with the saved shot prompt',async t=>{
 const f=await fixture(t),videoInput=await references(f);
 const input={...f.input({durationSeconds:12,aspectRatio:'16:9',resolution:'720p'}),videoInput};
 const job=await f.services.call('generation.submit',input) as JobRecord;
 assert.deepEqual(job.snapshot.videoInput,videoInput);assert.equal(job.snapshot.prompt,f.shot.prompt,'The saved shot prompt is the prompt sent');
 assert.deepEqual(job.snapshot.referenceAssetIds,videoInput.images.map(image=>image.assetId));
 assert.deepEqual((job.snapshot.referenceBindings as Array<{role:string;assetId:string}>).map(({role,assetId})=>({role,assetId})),videoInput.images);
 assert.equal((await f.services.call('generation.submit',input) as JobRecord).id,job.id,'Replaying the request returns the same job');
 assert.equal((f.store.get('shots',String(f.shot.id)) as ServiceRow).revision,f.shot.revision,'The shot is not edited');
 await f.tick();await f.stop();assert.equal(f.posts().length,1);
 const sent=body(f.posts()[0]!),content=sent.content as Array<Record<string,unknown>>;
 assert.equal(sent.omni_reference_task_type,'reference');assert.equal(sent.ratio,'16:9');assert.equal(sent.duration,12);
 assert.deepEqual(content[0],{type:'text',text:f.shot.prompt});
 assert.deepEqual(content.slice(1),sizes.map(([width,height])=>({type:'image_url',image_url:{url:`data:image/png;base64,${png({width,height,rgba:false}).toString('base64')}`},role:'reference_image'})));
});

test('Seedance 2.5 reference groups need the saved reference mode and stay within the request schema',async t=>{
 const f=await fixture(t,{models:defaults=>[defaults[0]!,{...defaults[0]!,id:randomUUID(),name:'Saved Seedance',inputModes:['text','image','frames','subject']}]});
 const [exact,saved]=f.configuration.models as [VideoModelEntry,VideoModelEntry],videoInput=await references(f);
 await assert.rejects(f.services.call('generation.submit',{...f.input({resolution:'720p'},saved),videoInput}),{code:'UNSUPPORTED_INPUT_ROLE'});
 const first=videoInput.images[0]!,many={...videoInput,images:Array.from({length:31},()=>({...first,assetId:randomUUID()}))};
 for(const invalid of [many,{...videoInput,images:[{...first,role:'first_frame' as const},...videoInput.images.slice(1)]},{...videoInput,images:[first,first]}])
  await assert.rejects(f.services.call('generation.submit',{...f.input({resolution:'720p'},exact),videoInput:invalid}),{code:'VALIDATION_ERROR'});
 assert.equal(f.store.list('jobs').length,0);assert.equal(f.posts().length,0);
});
