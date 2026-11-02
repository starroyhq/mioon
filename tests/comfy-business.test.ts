import type {ImageReviewResponse} from '../packages/contracts/src/image-reviews.ts';
import type {createComfyConnector} from '../packages/business/src/comfy/connector.ts';
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
type ComfyExecution = Extract<ImageReviewResponse,{execution:unknown}>['execution'];
type SubmitArgs = {beforeSubmit:()=>void;execution:ComfyExecution};
type ObserveArgs = {execution:ComfyExecution};
type ComfyFixtureOptions = {autoRun?:boolean;fault?:(stage:string)=>void;submit?:(args:SubmitArgs)=>unknown;observe?:(args:ObserveArgs)=>unknown};
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createComfySettings} from '../packages/business/src/comfy/settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION,COMFY_IMAGE_OPTIONS} from '../packages/contracts/src/comfy-images.ts';
import {imageProfilesResponseSchema} from '../packages/contracts/src/images.ts';
import {deflateSync} from 'node:zlib';

function syntheticPng(edge=512,color=0){
  const crc=(data: Buffer<ArrayBuffer>)=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;};
  const chunk=(name: string,data: Buffer<ArrayBuffer>)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,b.length-4)),b.length-4);return b;};
  const h=Buffer.alloc(13);h.writeUInt32BE(edge);h.writeUInt32BE(edge,4);h[8]=8;h[9]=2;
  const raw=Buffer.alloc((edge*3+1)*edge,color);for(let y=0;y<edge;y++)raw[y*(edge*3+1)]=0;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl:'http://127.0.0.1:8188',model:'synthetic.safetensors'};
const memory=()=>{let value: unknown=null;return {load:async()=>structuredClone(value),save:async (next: unknown)=>{value=structuredClone(next);}};};
const deferred=<T = unknown>()=>{let resolve!: (value?: T | PromiseLike<T>) => void;const promise=new Promise<T>(r=>resolve=(r as (value?: T | PromiseLike<T>) => void));return {promise,resolve};};
const waitFor=async<T>(read: () => T | Promise<T>,predicate: (value: Awaited<T>) => boolean)=>{const end=Date.now()+5000;while(Date.now()<end){const value=await read();if(predicate(value))return value;await pause(5);}assert.fail('Synthetic Comfy lifecycle did not settle');};
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-comfy-business-foreign-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices);
 try{return await services.call('project.create',{name:'Other'});}
 finally{await services.drain();store.close();}
}
async function fixture(t: test.TestContext,{autoRun=true,fault=()=>{},submit,observe}:ComfyFixtureOptions={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-comfy-business-')),persistence=memory();let store=(openStore(root) as TypedStore),settings: Awaited<ReturnType<typeof createComfySettings>>,services: TypedServices;const calls={post:0,get:0};
 const connector={submit:async (args: SubmitArgs)=>{calls.post++;if(submit)return submit(args);args.beforeSubmit();return {state:'submitted',promptId:args.execution.promptId};},observe:async (args: ObserveArgs)=>{calls.get++;if(observe)return observe(args);return completed(args);}};
 async function completed(args: { execution: { filenamePrefix: string; }; }){const bytes=syntheticPng();return {state:'completed',contentVerified:true,candidate:{bytes,mimeType:'image/png',width:512,height:512,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),descriptor:{filename:args.execution.filenamePrefix+'_00001_.png',subfolder:'',type:'output'}}};}
 async function create(){settings=await createComfySettings({persistence,reservedPorts:()=>[4318]});services=(createServices(store,new Map(),{env:{},imageOptions:{autoRun,fault,comfySettings:settings,comfyConnector:connector as unknown as ReturnType<typeof createComfyConnector>}}) as TypedServices);}
 await create();await services!.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});const project=await services!.call('project.create',{name:'Comfy synthetic'}),other=await foreignProject(t);
 const f={root,project,other,calls,completed,get store(){return store;},get services(){return services;},get settings(){return settings;},call:<O extends string>(op: O,input: unknown)=>services.call(op,input),input:(patch={})=>({projectId:project.id,requestId:randomUUID(),name:'Comfy image',providerId:'comfy-local',model:configuration.model,prompt:'Exact synthetic prompt.',options:COMFY_IMAGE_OPTIONS,...patch}),
  check(){const result={ok:true,baseUrl:configuration.baseUrl,comfyVersion:'0.39.0',checkpoints:[configuration.model],nodeClasses:['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage'],selectedCheckpointAvailable:true};settings.recordCheck(result,settings.clearCheck(result.baseUrl));},
  prepare:(input: unknown)=>services.call('image.review.prepare',{input,settingsRevision:1}),approve:(review: { id: unknown; })=>services.imageApproval({projectId:project.id,reviewId:review.id,expectedRevision:1}),
  task:(id: unknown)=>services.call('image.task.get',{projectId:project.id,taskId:id}),remote:(id: unknown)=>services.call('image.task.remote.get',{projectId:project.id,taskId:id}),
  async query(id: unknown,patch={}){const value=await f.remote(id);return services.call('image.task.observeRemote',{projectId:project.id,taskId:id,requestId:randomUUID(),expectedRevision:value.remote.revision,...patch});},
  async accepted(){const input=f.input(),review=await f.prepare(input),ack=await f.approve(review);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state!=='queued'&&v.state!=='dispatching');return {input,review,ack};},
  async restart(){await services.drain();await settings.close();store.close();store=(openStore(root) as TypedStore);await create();},
 };
 t.after(async()=>{await services.drain();await settings.close();store.close();rmSync(root,{recursive:true,force:true});});
 await settings!.put({expectedRevision:0,configuration});f.check();return f;
}

test('Comfy profile discovery and review pin the exact fixed graph before one explicitly approved POST',async t=>{
 const f=await fixture(t);const profile=await f.call('image.profile.list',{});assert.ok(imageProfilesResponseSchema.safeParse(profile).success);assert.equal(profile.liveEnabled,true);assert.equal(profile.items.at(-1)!.providerId,'comfy-local');
 const input=f.input(),review=await f.prepare(input);assert.equal(review.execution!.workflowVersion,1);assert.equal(review.execution!.graph['3'].inputs.text,input.prompt);assert.equal(f.calls.post,0);
 await assert.rejects(f.call('image.generate',input),{code:'IMAGE_REVIEW_REQUIRED'});const ack=await f.approve(review);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='receiving');assert.equal(f.calls.post,1);assert.equal(f.calls.get,0);
 assert.deepEqual(await f.approve(review),ack);assert.deepEqual(await f.call('image.generate',input),ack);assert.equal(f.calls.post,1);
 const query=await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='succeeded');const remote=await f.remote(ack.id);assert.equal(remote.remote.contentVerified,true);assert.equal(remote.observation!.state,'finished');
 const inputQuery={projectId:f.project.id,taskId:ack.id,requestId:query.requestId,expectedRevision:query.remoteRevision-1};assert.deepEqual(await f.call('image.task.observeRemote',inputQuery),query);assert.equal(f.calls.get,1);
 const versions=await f.call('image.version.list',{projectId:f.project.id,groupId:ack.groupId});assert.equal(versions.items[0].width,512);assert.equal(versions.items[0].sha256,remote.remote.resultSha256);
 const bytes=readFileSync(path.join(f.root,'media',versions.items[0].assetId+'.png'));assert.equal(createHash('sha256').update(bytes).digest('hex'),remote.remote.resultSha256);
 await f.restart();assert.equal((await f.settings.get()).readiness.checked,false);assert.deepEqual(await f.call('image.generate',input),ack);assert.equal(f.calls.post,1);assert.equal(f.calls.get,1);
});

test('lost POST acknowledgement survives backend recreation and explicit retrieval never resubmits',async t=>{
 const f=await fixture(t,{submit:(args: { beforeSubmit: () => void; })=>{args.beforeSubmit();throw Error('synthetic lost acknowledgement');}});const {input,review,ack}=await f.accepted();assert.equal((await f.task(ack.id)).state,'outcome_unknown');assert.equal((await f.remote(ack.id)).remote.state,'submission_unknown');
 await f.restart();assert.deepEqual(await f.approve(review),ack);assert.equal(f.calls.post,1);assert.equal(f.calls.get,0);await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='succeeded');assert.equal(f.calls.post,1);assert.equal(f.calls.get,1);assert.deepEqual(await f.call('image.generate',input),ack);
});

test('queued cancellation and restart never submit, and startup does not infer readiness',async t=>{
 const f=await fixture(t,{autoRun:false});const input=f.input(),review=await f.prepare(input),ack=await f.approve(review);await f.restart();assert.equal((await f.task(ack.id)).state,'interrupted_before_dispatch');assert.equal((await f.remote(ack.id)).remote.state,'prepared');assert.equal(f.calls.post,0);await f.call('image.task.cancelQueued',{projectId:f.project.id,taskId:ack.id,expectedRevision:2,requestId:randomUUID()});assert.equal(f.calls.post,0);await assert.rejects(f.prepare(f.input()),{code:'IMAGE_LIVE_DISABLED'});
});

test('result pin survives staging crash and permits only explicitly requested identical-byte retrieval',async t=>{
 let crash=true;const f=await fixture(t,{fault:(phase: string)=>{if(phase==='after_remote_result_pin'&&crash){crash=false;throw Error('synthetic pin crash');}}});const {ack}=await f.accepted();await f.query(ack.id);await waitFor(()=>f.remote(ack.id),(v: { observation?: { state: string; } | null; })=>v.observation?.state==='finished');const pin=(await f.remote(ack.id)).remote;assert.equal(pin.state,'completed');assert.ok(pin.resultSha256);assert.equal(existsSync(path.join(f.root,'image-staging',ack.id+'.json')),false);
 await f.restart();assert.equal((await f.task(ack.id)).state,'outcome_unknown');assert.equal(f.calls.post,1);assert.equal(f.calls.get,1);await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='succeeded');assert.equal((await f.remote(ack.id)).remote.resultSha256,pin.resultSha256);assert.equal(f.calls.post,1);assert.equal(f.calls.get,2);
});

test('verified terminal failure alone releases an unknown Comfy task; missing history remains unknown',async t=>{
 let state='not_found';const f=await fixture(t,{submit:(args: { beforeSubmit: () => void; })=>{args.beforeSubmit();throw Error('lost');},observe:()=>({state,contentVerified:state==='failed'})});const {ack}=await f.accepted();await f.query(ack.id);await waitFor(()=>f.remote(ack.id),(v: { observation?: { state: string; } | null; })=>v.observation?.state==='finished');assert.equal((await f.task(ack.id)).state,'outcome_unknown');assert.equal((await f.remote(ack.id)).remote.contentVerified,false);
 state='failed';await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='failed');assert.equal((await f.call('image.group.get',{projectId:f.project.id,groupId:ack.groupId})).activeTaskId,null);assert.equal(f.calls.post,1);
});

test('two windows and busy queries have exact rollback proof, while accepted duplicate retains one observation',async t=>{
 const gate=deferred();const f=await fixture(t,{observe:async()=>{await gate.promise;return {state:'running',contentVerified:false};}});const {ack}=await f.accepted();const remote=await f.remote(ack.id),input={projectId:f.project.id,taskId:ack.id,requestId:randomUUID(),expectedRevision:remote.remote.revision};const accepted=await f.call('image.task.observeRemote',input);
 await assert.rejects(f.call('image.task.observeRemote',{...input,requestId:randomUUID()}),e=>(e as Failure).code==='COMFY_REMOTE_REVISION_CONFLICT'&&(e as {details:{observation:{outcome:string}}}).details.observation.outcome==='not_accepted');
 await assert.rejects(f.query(ack.id),e=>(e as Failure).code==='COMFY_REMOTE_BUSY'&&(e as {details:{observation:{outcome:string}}}).details.observation.outcome==='not_accepted');assert.deepEqual(await f.call('image.task.observeRemote',input),accepted);gate.resolve!();await waitFor(()=>f.remote(ack.id),(v: { observation?: { state: string; } | null; })=>v.observation?.state==='finished');assert.equal(f.calls.get,1);
 await assert.rejects(f.call('image.task.observeRemote',{...input,projectId:f.other.id}),e=>!(e as Failure).details?.observation);assert.equal(f.calls.get,1);
});

test('accepted observation lost ACK and backend restart do not query automatically',async t=>{
 let lose=true;const f=await fixture(t,{fault:(phase: string)=>{if(phase==='after_remote_observation_accept'&&lose){lose=false;throw Error('lost ACK before schedule');}}});const {ack}=await f.accepted(),remote=await f.remote(ack.id),input={projectId:f.project.id,taskId:ack.id,requestId:randomUUID(),expectedRevision:remote.remote.revision};await assert.rejects(f.call('image.task.observeRemote',input));assert.equal(f.calls.get,0);await f.restart();const response=await f.call('image.task.observeRemote',input);assert.equal(response.state,'queued');assert.equal((await f.remote(ack.id)).observation!.state,'interrupted');assert.equal(f.calls.get,0);await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='succeeded');assert.equal(f.calls.post,1);assert.equal(f.calls.get,1);
});


test('changed output bytes at the same descriptor cannot replace a pinned result after staging failure',async t=>{
 let f: Awaited<ReturnType<typeof fixture>>,color=0,crash=true;f=await fixture(t,{fault:(phase: string)=>{if(phase==='after_remote_result_pin'&&crash){crash=false;throw Error('stop before local stage');}},observe:async (args: ObserveArgs)=>{const result=await f.completed(args),bytes=syntheticPng(512,color);result.candidate={...result.candidate,bytes,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};return result;}});
 const {ack}=await f.accepted();await f.query(ack.id);await waitFor(()=>f.remote(ack.id),(v: { observation?: { state: string; } | null; })=>v.observation?.state==='finished');const pin=(await f.remote(ack.id)).remote.resultSha256;await f.restart();color=1;await f.query(ack.id);await waitFor(()=>f.remote(ack.id),(v: { observation?: { state: string; } | null; })=>v.observation?.state==='finished');assert.equal((await f.remote(ack.id)).remote.resultSha256,pin);assert.equal((await f.task(ack.id)).state,'outcome_unknown');assert.equal(f.store.db.prepare('SELECT count(*) n FROM assets').get()!.n,0);assert.equal(f.calls.post,1);
});

test('remote content flags cannot be injected through public DTOs and historical ownership fails closed',async t=>{
 const f=await fixture(t),{ack}=await f.accepted();const remote=await f.remote(ack.id);await assert.rejects(f.query(ack.id,{contentVerified:true}),{code:'VALIDATION_ERROR'});await assert.rejects(f.call('image.task.remote.get',{projectId:f.other.id,taskId:ack.id}));assert.equal(f.calls.get,0);
 await f.query(ack.id);await waitFor(()=>f.task(ack.id),(v: { state: string; })=>v.state==='succeeded');const task=await f.task(ack.id);f.store.db.exec('DROP TRIGGER immutable_image_remote_run_identity');f.store.db.prepare('UPDATE image_remote_runs SET resultSha256=?,revision=revision+1 WHERE taskId=?').run('a'.repeat(64),ack.id);
 const before=f.store.db.prepare('SELECT total_changes() n').get()!.n;await assert.rejects(f.task(ack.id));await assert.rejects(f.call('image.version.list',{projectId:f.project.id,groupId:task.groupId}));assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,before);assert.equal(f.calls.post,1);assert.equal(f.calls.get,1);
});

test('shutdown timeout is unconfirmed and late owned observation cannot publish a result',async t=>{
 const entered=deferred(),gate=deferred();let f: Awaited<ReturnType<typeof fixture>>;f=await fixture(t,{observe:async (args: ObserveArgs)=>{entered.resolve!();await gate.promise;return f.completed(args);}});const {ack}=await f.accepted();await f.query(ack.id);await entered.promise;
 try{await assert.rejects(f.services.drain(),e=>['SERVICE_STOP_TIMEOUT','COMFY_REMOTE_STOP_TIMEOUT'].includes((e as Failure).code));assert.equal(f.store.db.isOpen,true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_versions').get()!.n,0);}finally{gate.resolve!();await f.services.drain();}
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_versions').get()!.n,0);assert.equal((await f.remote(ack.id)).observation!.state,'interrupted');assert.equal(f.calls.post,1);
});
