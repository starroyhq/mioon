import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {defaultVideoModels,videoBindingCapabilities,videoInputProfile,validateVideoSnapshot} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoInputMode} from '../packages/contracts/src/video-providers.ts';
import {isSubjectGenerationResponse,isSubjectGenerationRetryResponse} from '../packages/contracts/src/subject-generation.ts';
import {withoutForeignKeys} from './helpers/project-database.ts';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const row=(value:unknown)=>value as ServiceRow;
const rows=(value:unknown)=>value as ServiceRow[];
function png(width:number,height:number,fill=0):Buffer {
  const chunk=(type:string,data:Buffer)=>{const content=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(content));return Buffer.concat([size,content,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height,fill))),chunk('IEND',Buffer.alloc(0))]);
}
interface ManagedAsset {id:string;projectId:string;relativePath:string;mimeType:string;sha256:string;sizeBytes:number;width:number;height:number;[key:string]:unknown}
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t:TestContext,name='Foreign project'){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-configured-ark-foreign-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=openStore(root),services=createServices(store,new Map());
  try{return row(await services.call('project.create',{name}));}
  finally{await services.drain();store.close();}
}
async function fixture(t:TestContext,inputModes?:VideoInputMode[]){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-configured-ark-'))),store=openStore(root);
  const settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root}),providers=createProviderRegistry({db:store.db,root,env:{}});
  const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'ark',name:'Ark UI only',region:'cn-beijing',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('ark')};
  if(inputModes)configuration.models[0]!.inputModes=inputModes;
  await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',storage:'session',value:'synthetic-ark-ui-key'}});
  const calls:Array<{url:string;init:RequestInit}> = [];let count=0,worker:ReturnType<typeof startWorker>|null=null;
  const services=createServices(store,providers,{videoSettings:settings,profileNow:()=>Date.UTC(2026,9,20),videoFetch:async(input,init)=>{calls.push({url:String(input),init:init??{}});if(init?.method==='POST')return json({id:`configured-ark-task-${++count}`});return json({id:new URL(String(input)).pathname.split('/').at(-1),status:'running'});}});
  await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
  const project=row(await services.call('project.create',{name:'Configured Ark references'})),other=await foreignProject(t,'Other project');
  let assetIndex=0;
  const asset=async({width=360,height=640,projectId=String(project.id)}:{width?:number;height?:number;projectId?:string}={}):Promise<ManagedAsset>=>{
    const id=randomUUID(),bytes=png(width,height,assetIndex++),value:ManagedAsset={id,projectId,name:'Synthetic managed reference',relativePath:`media/${id}.png`,mimeType:'image/png',sha256:hash(bytes),sizeBytes:bytes.length,width,height,provenance:'user-import',createdAt:'2026-10-20T00:00:00.000Z'};
    store.put('assets',value);await writeFile(path.join(root,value.relativePath),bytes);return value;
  };
  const shot=async(patch:Record<string,unknown>={})=>row(await services.call('shot.create',{projectId:project.id,title:'Ark shot',prompt:'A synthetic object turns slowly.',aspectRatio:'9:16',duration:4,referenceAssetIds:[],...patch}));
  const input=(selected:ServiceRow,patch:Record<string,unknown>={})=>({shotId:selected.id,expectedRevision:selected.revision,requestId:randomUUID(),providerId:'ark',model:configuration.models[0]!.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id,parameters:{resolution:'720p'},...patch});
  const subject=async(selected:ManagedAsset)=>row(await services.call('subject.create',{projectId:selected.projectId,assetId:selected.id,kind:'product',name:'Synthetic product',requestId:randomUUID()}));
  const stop=async()=>{await worker?.stop();worker=null;};
  const tick=async()=>{worker??=startWorker(store,services,providers);await worker.tick();await stop();};
  t.after(async()=>{await stop();await services.drain();await settings.close();store.close();await rm(root,{recursive:true,force:true});});
  return {root,store,settings,services,providers,configuration,project,other,calls,asset,shot,input,subject,tick,stop,job:(id:string)=>store.get('jobs',id)as JobRecord,posts:()=>calls.filter(call=>call.init.method==='POST')};
}

test('configured Ark first/last frames dispatch the complete approved byte pair without legacy environment allowlists',async t=>{
  const f=await fixture(t),first=await f.asset(),last=await f.asset(),shot=await f.shot({referenceAssetIds:[first.id],lastFrameAssetId:last.id});
  assert.equal(f.providers.get('ark')!.capabilities.enabled,false);
  const input=f.input(shot),job=await f.services.call('generation.submit',input)as JobRecord;
  assert.deepEqual(job.snapshot.referenceAssetIds,[first.id,last.id]);assert.deepEqual(job.snapshot.referenceBindings,[{role:'first_frame',assetId:first.id,sha256:first.sha256},{role:'last_frame',assetId:last.id,sha256:last.sha256}]);assert.equal(f.calls.length,0);
  await f.tick();assert.equal(f.job(job.id).status,'running');assert.equal(f.posts().length,1);
  const post=f.posts()[0]!,body=row(JSON.parse(String(post.init.body))),content=rows(body.content);
  assert.equal(post.url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(new Headers(post.init.headers).get('Authorization'),'Bearer synthetic-ark-ui-key');
  assert.deepEqual(content.map(item=>item.role),[undefined,'first_frame','last_frame']);
  for(const [index,selected]of [first,last].entries())assert.equal(hash(Buffer.from(String(row(content[index+1]!.image_url).url).split(',')[1]!,'base64')),selected.sha256);
  assert.equal(body.ratio,'adaptive');assert.equal(body.resolution,'720p');assert.equal(body.output_format,'mp4');assert.equal(body.generate_audio,false);assert.equal(body.omni_reference_task_type,undefined);
});

test('a changed selected last-frame file fails before POST and never falls back to a single frame',async t=>{
  const f=await fixture(t),first=await f.asset(),last=await f.asset(),shot=await f.shot({referenceAssetIds:[first.id],lastFrameAssetId:last.id}),job=await f.services.call('generation.submit',f.input(shot))as JobRecord;
  await writeFile(path.join(f.root,last.relativePath),png(360,640,9));await f.tick();
  assert.equal(f.job(job.id).status,'failed');assert.equal(row(f.job(job.id).error).code,'REFERENCE_CHANGED');assert.equal(f.posts().length,0);assert.deepEqual(f.job(job.id).snapshot.referenceAssetIds,[first.id,last.id]);
});

test('configured Ark rejects a foreign frame selection before queueing any paid job',async t=>{
  const f=await fixture(t);
  // The other project is not in this store; write the selected asset as a corrupt file would hold it.
  const foreign=await withoutForeignKeys(f.store.db,()=>f.asset({projectId:String(f.other.id)}));
  const shot=await f.shot();
  f.store.put('shots',{...shot,referenceAssetIds:[foreign.id]});
  await assert.rejects(f.services.call('generation.submit',f.input(shot)));assert.equal(f.store.list('jobs').length,0);assert.equal(f.calls.length,0);
});

test('configured Ark subject generation produces verifiable public receipts and exact frozen retries',async t=>{
  const f=await fixture(t),selected=await f.asset({width:480,height:480}),subject=await f.subject(selected),shot=await f.shot(),input=f.input(shot,{subjectVersionId:subject.headVersionId}),job=await f.services.call('generation.submit',input)as JobRecord;
  assert.equal(isSubjectGenerationResponse('generation.submit',input,job,{projectId:f.project.id}),true);
  assert.deepEqual(job.snapshot.referenceAssetIds,[selected.id]);assert.deepEqual(job.snapshot.referenceBindings,[{role:'subject_reference',assetId:selected.id,sha256:selected.sha256}]);
  await f.tick();assert.equal(f.job(job.id).status,'running');assert.equal(f.posts().length,1);
  const body=row(JSON.parse(String(f.posts()[0]!.init.body))),content=rows(body.content);
  assert.equal(body.omni_reference_task_type,'reference');assert.equal(body.ratio,'9:16');assert.equal(content[1]!.role,'reference_image');assert.equal(hash(Buffer.from(String(row(content[1]!.image_url).url).split(',')[1]!,'base64')),selected.sha256);
  const second=await f.asset({width:480,height:480});await f.services.call('subject.version.add',{projectId:f.project.id,subjectId:subject.id,expectedRevision:1,assetId:second.id,requestId:randomUUID()});
  await f.settings.put({action:'save',expectedRevision:1,configuration:{...f.configuration,name:'Renamed and disabled',enabled:false},secret:{action:'keep'}});
  f.services.saveJob(f.job(job.id),{status:'failed',error:{code:'PROVIDER_GENERATION_FAILED',message:'synthetic definitive failure'}});
  const retryInput={jobId:job.id,requestId:randomUUID()},retry=await f.services.call('job.retry',retryInput)as JobRecord;
  assert.equal(isSubjectGenerationRetryResponse(retryInput,retry,{projectId:f.project.id,snapshot:job.snapshot}),true);assert.deepEqual(retry.snapshot,job.snapshot);
  assert.equal(row(retry.snapshot.subjectReference).subjectVersionId,subject.headVersionId);assert.equal(isSubjectGenerationRetryResponse(retryInput,retry,{snapshot:{...job.snapshot,prompt:'Changed'}}),false);
  assert.equal(isSubjectGenerationResponse('generation.submit',{...input,modelEntryId:randomUUID()},job),false);
  await f.tick();assert.equal(f.job(retry.id).status,'running');assert.equal(f.posts().length,2);assert.equal(row(JSON.parse(String(f.posts()[1]!.init.body))).omni_reference_task_type,'reference');
});

test('configured Ark revalidates a subject reference file and rejects an unrelated project subject version',async t=>{
  // Another project lives in a store of its own: its subject version does not exist in this one.
  const f=await fixture(t),g=await fixture(t),foreign=await g.subject(await g.asset({width:480,height:480})),shot=await f.shot();
  await assert.rejects(f.services.call('generation.submit',f.input(shot,{subjectVersionId:foreign.headVersionId})));assert.equal(f.store.list('jobs').length,0);
  const selected=await f.asset({width:480,height:480}),subject=await f.subject(selected),job=await f.services.call('generation.submit',f.input(shot,{subjectVersionId:subject.headVersionId}))as JobRecord;
  await writeFile(path.join(f.root,selected.relativePath),png(480,480,12));await f.tick();assert.equal(f.job(job.id).status,'failed');assert.equal(row(f.job(job.id).error).code,'REFERENCE_CHANGED');assert.equal(f.posts().length,0);
});

for(const mode of ['text','subject']as const)test(`configured ${mode}-only Ark profiles advertise exactly their permitted role combinations`,async t=>{
  const f=await fixture(t,[mode]),binding=f.settings.select(f.configuration.id,1,f.configuration.models[0]!.id),profile=videoInputProfile(binding),capabilities=videoBindingCapabilities(binding,{asOf:'2026-10-20'});
  assert.deepEqual(profile.inputModes,[mode]);assert.deepEqual(capabilities.modelCapabilities[0]!.inputModes,[mode]);
  assert.equal(profile.inputs.roles.first_frame!.implemented,false);assert.equal(profile.inputs.roles.last_frame!.implemented,false);assert.equal(profile.inputs.roles.subject_reference!.implemented,mode==='subject');
  assert.deepEqual(profile.inputs.combinations,mode==='text'?[[]]:[['subject_reference']]);assert.equal(profile.inputs.minReferences,mode==='text'?0:1);assert.equal(profile.inputs.maxReferences,mode==='text'?0:1);
  const selected=await f.asset({width:480,height:480}),snapshot={providerId:'ark',model:binding.model.modelId,prompt:'Synthetic object moves.',duration:4,aspectRatio:'9:16',parameters:{resolution:'720p'},referenceAssets:mode==='text'?[]:[{...selected,role:'subject_reference'}]};
  assert.equal(validateVideoSnapshot(binding,snapshot,{asOf:'2026-10-20'}),true);assert.throws(()=>validateVideoSnapshot(binding,{...snapshot,referenceAssets:[{...selected,width:360,height:640,role:'first_frame'}]},{asOf:'2026-10-20'}),{code:'UNSUPPORTED_INPUT_ROLE'});
  const directory=await f.services.call('video.connection.list',{});assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(directory),/synthetic-ark-ui-key/);
});
