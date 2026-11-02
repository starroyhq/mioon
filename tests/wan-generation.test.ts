import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration} from '../packages/contracts/src/video-providers.ts';
import type {WanVideoInput} from '../packages/contracts/src/wan-video.ts';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function png():Buffer {
 const chunk=(type:string,data:Buffer)=>{const content=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(content));return Buffer.concat([size,content,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(360);header.writeUInt32BE(640,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((360*3+1)*640))),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(t:TestContext,{legacyWan=false}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-wan-generation-'))),store=openStore(root);
 const settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
 const providers=createProviderRegistry({db:store.db,root,env:{}}),calls:Array<{url:string;init:RequestInit}>=[];
 let reply:(url:string,init:RequestInit)=>Response|Promise<Response>=(_url,init)=>json({output:{task_id:'wan-task',task_status:init.method==='POST'?'PENDING':'RUNNING'}});
 const services=createServices(store,providers,{videoSettings:settings,profileNow:()=>Date.UTC(2026,9,23),videoFetch:async(input,init)=>{const request={url:String(input),init:init??{}};calls.push(request);return reply(request.url,request.init);}});
 await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const models=defaultVideoModels('wan').filter(model=>model.templateId===(legacyWan?'wan27-t2v':'wan30-v1'));
 if(legacyWan)models[0]!.durationResolutionMap=[{duration:[4,5,10],resolution:['720P']}];
 const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'wan',name:'Wan account',region:'cn-beijing',workspaceId:'test-workspace',enabled:true,archived:false,outputHosts:['output.example'],models};
 await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',value:'synthetic-wan-key',storage:'session'}});
 const project=await services.call('project.create',{name:'Wan 3 local images'}) as ServiceRow;
 const shot=await services.call('shot.create',{projectId:project.id,title:'Wan shot',prompt:'Original shot prompt.',aspectRatio:'9:16',duration:4,referenceAssetIds:[]}) as ServiceRow;
 let worker:ReturnType<typeof startWorker>|null=null;
 const f={root,store,settings,services,configuration,calls,project,shot,
  input:(videoInput:WanVideoInput)=>({shotId:String(shot.id),expectedRevision:Number(shot.revision),requestId:randomUUID(),providerId:'wan',connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id,videoInput}),
  async image(projectId=String(project.id)){return await services.call('asset.import',{projectId,name:'Reference.png',mimeType:'image/png',dataBase64:png().toString('base64')}) as ServiceRow;},
  async tick(){worker??=startWorker(store,services,providers);await worker.tick();},
  async stop(){await worker?.stop();worker=null;},
  reply(next:typeof reply){reply=next;},
  job(id:string){return store.get('jobs',id) as JobRecord;},
 };
 t.after(async()=>{await f.stop();await services.drain();await settings.close();store.close();await rm(root,{recursive:true,force:true});});
 return f;
}
const textInput:WanVideoInput={version:1,mode:'text',images:[],prompt:'A new generation prompt.'};

const defaultWanParameters={durationSeconds:5,resolution:'720P',aspectRatio:'9:16',generateAudio:true,promptExtend:true,watermark:false};
for(const modelIndex of [0,1])test(`new ${modelIndex===0?'Wan 3.0':'Wan 3.0 Prime'} submissions freeze server defaults without rewriting the shot`,async t=>{
 const f=await fixture(t),input={...f.input(textInput),videoInput:modelIndex===0?undefined:textInput,modelEntryId:f.configuration.models[modelIndex]!.id};
 const job=await f.services.call('generation.submit',input) as JobRecord,snapshot=structuredClone(job.snapshot);
 assert.deepEqual(job.snapshot.parameters,defaultWanParameters);assert.equal(job.snapshot.duration,4);assert.equal(job.snapshot.aspectRatio,'9:16');
 const saved=f.store.get('shots',String(f.shot.id)) as ServiceRow;
 assert.equal(saved.duration,4);assert.equal(saved.aspectRatio,'9:16');assert.deepEqual(saved.parameters,{});
 await f.services.call('shot.update',{requestId:randomUUID(),shotId:saved.id,expectedRevision:saved.revision,patch:{duration:8,aspectRatio:'16:9'}});
 const narrowed=structuredClone(f.configuration);narrowed.models[modelIndex]!.durationResolutionMap=[{duration:[7],resolution:['480P']}];
 await f.settings.put({action:'save',expectedRevision:1,configuration:narrowed,secret:{action:'keep'}});
 assert.equal((await f.services.call('generation.submit',input) as JobRecord).id,job.id);
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'running');assert.deepEqual(f.job(job.id).snapshot,snapshot);
 assert.equal(f.calls.length,1);const body=JSON.parse(String(f.calls[0]!.init.body));
 assert.equal(body.model,f.configuration.models[modelIndex]!.modelId);
 assert.deepEqual(body.parameters,{resolution:'720P',duration:5,ratio:'9:16',audio:true,prompt_extend:true,watermark:false});
});

test('new Wan defaults honor narrowed model choices and freeze the fallback aspect ratio',async t=>{
 const f=await fixture(t),configuration=structuredClone(f.configuration);
 configuration.models[0]!.durationResolutionMap=[{duration:[7,3],resolution:['480P','1080P']}];configuration.models[0]!.aspectRatios=['16:9','1:1'];
 await f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'keep'}});
 const job=await f.services.call('generation.submit',{...f.input(textInput),configurationRevision:2}) as JobRecord;
 assert.deepEqual(job.snapshot.parameters,{...defaultWanParameters,durationSeconds:7,resolution:'480P',aspectRatio:'16:9'});
 assert.equal(job.snapshot.duration,4);assert.equal(job.snapshot.aspectRatio,'9:16');
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'running');
 assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)).parameters,{resolution:'480P',duration:7,ratio:'16:9',audio:true,prompt_extend:true,watermark:false});
});

test('new Wan partial and automatic overrides retain explicit values and freeze the remaining defaults',async t=>{
 const f=await fixture(t);
 for(const parameters of [{durationSeconds:8,generateAudio:false,seed:0},{durationSeconds:-1,aspectRatio:'adaptive',promptExtend:false,watermark:true}]){
  const job=await f.services.call('generation.submit',{...f.input(textInput),parameters}) as JobRecord;
  assert.deepEqual(job.snapshot.parameters,{...defaultWanParameters,...parameters});assert.equal(job.snapshot.duration,4);assert.equal(job.snapshot.aspectRatio,'9:16');
 }
 assert.equal(f.calls.length,0);
});

for(const oldParameters of [undefined,{}, {resolution:'1080P',seed:7}])test(`historical Wan snapshots with ${oldParameters===undefined?'missing':Object.keys(oldParameters).length?'partial':'empty'} parameters retain four seconds through dispatch, query and retry`,async t=>{
 const f=await fixture(t),created=await f.services.call('generation.submit',f.input(textInput)) as JobRecord,snapshot=structuredClone(created.snapshot);
 if(oldParameters===undefined)delete snapshot.parameters;else snapshot.parameters=oldParameters;
 f.store.put('jobs',{...created,snapshot});
 // This seed is valid on a saved shot but unsupported by Wan; frozen retries must ignore it.
 await f.services.call('shot.update',{requestId:randomUUID(),shotId:f.shot.id,expectedRevision:f.shot.revision,patch:{duration:8,aspectRatio:'16:9',parameters:{seed:4294967295}}});
 const configuration=structuredClone(f.configuration);configuration.models[0]!.durationResolutionMap=[{duration:[5],resolution:['480P']}];
 await f.settings.put({action:'save',expectedRevision:1,configuration,secret:{action:'replace',value:'replacement-synthetic-key',storage:'session'}});
 await f.tick();await f.stop();assert.equal(f.job(created.id).status,'running');assert.deepEqual(f.job(created.id).snapshot,snapshot);
 const firstBody=JSON.parse(String(f.calls[0]!.init.body));assert.equal(firstBody.parameters.duration,4);assert.equal(firstBody.parameters.ratio,'9:16');assert.equal(firstBody.parameters.resolution,oldParameters?.resolution??'720P');
 assert.equal(new Headers(f.calls[0]!.init.headers).get('Authorization'),'Bearer synthetic-wan-key');
 f.services.saveJob(f.job(created.id),{nextPollAt:0});await f.tick();await f.stop();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.init.method,'GET');assert.deepEqual(f.job(created.id).snapshot,snapshot);
 f.services.saveJob(f.job(created.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'Synthetic definitive failure'}});
 const retry=await f.services.call('job.retry',{jobId:created.id,requestId:randomUUID()}) as JobRecord;
 assert.deepEqual(retry.snapshot,snapshot);await f.tick();await f.stop();
 assert.equal(f.job(retry.id).status,'running');assert.deepEqual(f.job(retry.id).snapshot,snapshot);assert.deepEqual(f.job(created.id).snapshot,snapshot);
 assert.equal(f.calls.length,3);assert.deepEqual(JSON.parse(String(f.calls[2]!.init.body)),firstBody);
 assert.equal(f.calls.filter(call=>call.init.method==='POST').length,2);
});

test('new Wan 2.7 submissions retain legacy shot duration and do not acquire Wan 3.0 defaults',async t=>{
 const f=await fixture(t,{legacyWan:true}),job=await f.services.call('generation.submit',{...f.input(textInput),videoInput:undefined}) as JobRecord;
 assert.deepEqual(job.snapshot.parameters,{});assert.equal(job.snapshot.duration,4);assert.equal(job.snapshot.aspectRatio,'9:16');
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'running');
 const body=JSON.parse(String(f.calls[0]!.init.body));assert.equal(body.model,'wan2.7-t2v');
 assert.deepEqual(body.parameters,{resolution:'720P',duration:4,ratio:'9:16',prompt_extend:false,watermark:false});
});

test('Wan 3 freezes ordered ten-image input and exact request options through the official SDK',async t=>{
 const f=await fixture(t),images:WanVideoInput['images']=[];
 for(let index=0;index<10;index++){const image=await f.image();images.unshift({assetId:String(image.id),role:'reference_image'});}
 const videoInput:WanVideoInput={version:1,mode:'reference_images',images,prompt:'图1和图10在草地上散步。'};
 const input={...f.input(videoInput),parameters:{durationSeconds:30,aspectRatio:'21:9',resolution:'480P',generateAudio:false,promptExtend:false,watermark:true,seed:-1}};
 const job=await f.services.call('generation.submit',input) as JobRecord;
 assert.deepEqual(job.snapshot.videoInput,videoInput);assert.equal(job.snapshot.prompt,videoInput.prompt);
 assert.deepEqual(job.snapshot.referenceAssetIds,images.map(image=>image.assetId));
 assert.equal((await f.services.call('generation.submit',input) as JobRecord).id,job.id);
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'running');assert.equal(f.calls.length,1);
 const body=JSON.parse(String(f.calls[0]!.init.body));
 assert.equal(body.model,'wan3.0-video');assert.equal(body.input.prompt,videoInput.prompt);
 assert.deepEqual(body.input.media,images.map(()=>({type:'reference_image',url:`data:image/png;base64,${png().toString('base64')}`})));
 assert.deepEqual(body.parameters,{resolution:'480P',duration:30,ratio:'21:9',audio:false,seed:-1,prompt_extend:false,watermark:true});
 assert.equal((f.store.get('shots',String(f.shot.id)) as ServiceRow).duration,4);
 assert.equal((f.store.get('shots',String(f.shot.id)) as ServiceRow).aspectRatio,'9:16');
 await assert.rejects(f.services.call('generation.submit',{...input,videoInput:{...videoInput,images:[...images].reverse()}}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('explicit Wan images replace saved frame selections without rewriting the shot',async t=>{
 const f=await fixture(t),first=await f.image(),last=await f.image();
 const shot=await f.services.call('shot.update',{requestId:randomUUID(),shotId:f.shot.id,expectedRevision:f.shot.revision,patch:{referenceAssetIds:[first.id],lastFrameAssetId:last.id}}) as ServiceRow;
 const input={...f.input(textInput),expectedRevision:Number(shot.revision)};
 const job=await f.services.call('generation.submit',input) as JobRecord;
 assert.deepEqual(job.snapshot.referenceAssets,[]);assert.deepEqual(job.snapshot.referenceConnections,[]);assert.equal(job.snapshot.lastFrameAssetId,null);
 assert.deepEqual((f.store.get('shots',String(shot.id)) as ServiceRow).referenceAssetIds,[first.id]);
 await f.tick();await f.stop();assert.equal(f.calls.length,1);assert.equal(JSON.parse(String(f.calls[0]!.init.body)).input.media,undefined);
});

test('Wan first-last frame order is frozen and retry cannot acquire current model defaults',async t=>{
 const f=await fixture(t),first=await f.image(),last=await f.image();
 const videoInput:WanVideoInput={version:1,mode:'first_last_frame',images:[{role:'first_frame',assetId:String(first.id)},{role:'last_frame',assetId:String(last.id)}],prompt:'Move from first to last.'};
 const job=await f.services.call('generation.submit',{...f.input(videoInput),parameters:{durationSeconds:5,resolution:'720P'}}) as JobRecord;
 await f.tick();await f.stop();f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'Synthetic failure'}});
 const next=structuredClone(f.configuration);next.models[0]!.modelId='wan3.0-video-prime';
 await f.settings.put({action:'save',expectedRevision:1,configuration:next,secret:{action:'replace',value:'another-synthetic-key',storage:'session'}});
 const retry=await f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}) as JobRecord;
 assert.deepEqual(retry.snapshot,job.snapshot);await f.tick();await f.stop();
 assert.equal(f.calls.length,2);assert.equal(JSON.parse(String(f.calls[1]!.init.body)).model,'wan3.0-video');
 assert.equal(new Headers(f.calls[1]!.init.headers).get('Authorization'),'Bearer synthetic-wan-key');
 assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)).input.media.map((image:{type:string})=>image.type),['first_frame','last_frame']);
});

test('Wan rejects foreign and changed assets before a generation POST',async t=>{
 // Another project lives in a store of its own: its image does not exist in this one.
 const f=await fixture(t),g=await fixture(t),foreign=await g.image();
 const videoInput:WanVideoInput={version:1,mode:'first_frame',images:[{role:'first_frame',assetId:String(foreign.id)}]};
 await assert.rejects(f.services.call('generation.submit',f.input(videoInput)),{code:'NOT_FOUND'});assert.equal(f.store.list('jobs').length,0);
 const image=await f.image(),job=await f.services.call('generation.submit',f.input({...videoInput,images:[{role:'first_frame',assetId:String(image.id)}]})) as JobRecord;
 f.store.put('assets',{...image,sha256:'0'.repeat(64)});await f.tick();await f.stop();
 assert.equal(f.calls.length,0);assert.equal(f.job(job.id).status,'failed');assert.equal(f.job(job.id).submissionCount,0);
});

test('uncertain Wan acceptance never creates another SDK submission',async t=>{
 const f=await fixture(t);f.reply(()=>{throw Error('Synthetic receipt lost');});
 const job=await f.services.call('generation.submit',f.input(textInput)) as JobRecord;
 await f.tick();await f.stop();assert.equal(f.job(job.id).status,'submission_unknown');
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 f.services.saveJob(f.job(job.id),{nextPollAt:0});await f.tick();await f.stop();assert.equal(f.calls.length,1);
});

for(const field of ['referenceAssetIds','referenceConnections','prompt'] as const)test(`Wan frozen ${field} conflicts are rejected before retry or dispatch`,async t=>{
 const f=await fixture(t),job=await f.services.call('generation.submit',f.input(textInput)) as JobRecord;
 const changed={...job.snapshot,[field]:field==='prompt'?'Changed duplicate prompt':[randomUUID()]};
 f.store.put('jobs',{...job,status:'failed',snapshot:changed});
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.equal(f.store.list('jobs').length,1);assert.equal(f.calls.length,0);
 f.store.put('jobs',{...job,snapshot:changed});await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'failed');assert.equal(f.job(job.id).submissionCount,0);assert.equal(f.calls.length,0);
});

test('automatic Wan output records real dimensions and duration instead of the planned shot geometry',async t=>{
 const f=await fixture(t),file=path.join(f.root,'square.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x320:r=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',file]);
 const bytes=await readFile(file);
 f.reply((url,init)=>url.startsWith('https://output.example/')?new Response(bytes):json({output:{task_id:'wan-task',task_status:init.method==='POST'?'PENDING':'SUCCEEDED',video_url:'https://output.example/square.mp4'}}));
 const job=await f.services.call('generation.submit',{...f.input(textInput),parameters:{durationSeconds:-1,aspectRatio:'adaptive'}}) as JobRecord;
 await f.tick();await f.stop();f.services.saveJob(f.job(job.id),{nextPollAt:0});await f.tick();await f.stop();
 assert.equal(f.job(job.id).status,'succeeded');assert.equal(f.store.list('versions').length,1);
 const version=f.store.list('versions')[0] as ServiceRow,asset=f.store.get('assets',String(version.assetId)) as ServiceRow;
 assert.equal(asset.width,320);assert.equal(asset.height,320);assert.equal(asset.duration,2);
 assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 assert.equal(new Headers(f.calls.find(call=>call.url.startsWith('https://output.example/'))!.init.headers).get('Authorization'),null);
});

const rejectedOutputs:Array<{name:string;size:string;seconds:number;parameters:Record<string,unknown>;code:string}>=[
 {name:'fixed aspect ratio mismatch',size:'320x320',seconds:2,parameters:{durationSeconds:2,aspectRatio:'9:16'},code:'OUTPUT_ASPECT_RATIO_MISMATCH'},
 {name:'fixed duration mismatch',size:'180x320',seconds:2,parameters:{durationSeconds:5,aspectRatio:'9:16'},code:'OUTPUT_DURATION_MISMATCH'},
 {name:'smart duration outside model limits',size:'320x320',seconds:1,parameters:{durationSeconds:-1,aspectRatio:'adaptive'},code:'OUTPUT_DURATION_MISMATCH'},
];
for(const scenario of rejectedOutputs)test(`Wan ${scenario.name} pauses the paid task without publishing or resubmitting`,async t=>{
 const f=await fixture(t),file=path.join(f.root,'rejected-output.mp4');
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${scenario.size}:r=30`,'-t',String(scenario.seconds),'-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',file]);
 const bytes=await readFile(file);
 f.reply((url,init)=>url.startsWith('https://output.example/')?new Response(bytes):json({output:{task_id:'wan-task',task_status:init.method==='POST'?'PENDING':'SUCCEEDED',video_url:'https://output.example/rejected-output.mp4'}}));
 const job=await f.services.call('generation.submit',{...f.input(textInput),parameters:scenario.parameters}) as JobRecord;
 await f.tick();await f.stop();f.services.saveJob(f.job(job.id),{nextPollAt:0});await f.tick();await f.stop();
 const paused=f.job(job.id);
 assert.equal(paused.status,'cancelled');assert.equal(paused.phase,'output_review_required');assert.equal(paused.cancelScope,'local_only');
 assert.equal((paused.error as ServiceRow).code,scenario.code);assert.equal(paused.providerJobId,'wan-task');assert.equal(paused.submissionCount,1);
 assert.equal(f.store.list('versions').length,0);assert.equal(f.store.list('assets').length,0);
 assert.equal(f.calls.filter(call=>call.init.method==='POST').length,1);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
});
