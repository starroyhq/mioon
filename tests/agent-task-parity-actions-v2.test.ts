import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,IMAGE_EDIT_REVIEW_DESTINATION,IMAGE_REVIEW_POLICY,PREVIS_LIMITS,
 DEFAULT_TIMELINE_OUTPUT_PRESET,imageReviewResponseSchema,imageTaskResponseSchema,previsThumbnailPublicSchemas,subjectVariantBatchSchema,subjectVariantImageRequestId} from '@mioon/contracts';
import {prepareParityThumbnail,executeParityThumbnail,executeSubjectVariantRetry} from '../packages/business/src/agent/task-parity-actions-v2.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openStore,openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const noEffect=():void=>{};
// The thumbnail cache checks a browser-style JPEG container, without decoding
// pixels. This contains one baseline frame and one complete scan.
const jpeg=():Buffer=>Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0x80,0x01,0x00,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01,
 0xff,0xda,0x00,0x0c,0x03,0x01,0x00,0x02,0x11,0x03,0x11,0x00,0x3f,0x00,0x12,0x34,0xff,0xd9]);

async function fixture(t:TestContext,format4=false){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-parity-actions-')),projectFile=path.join(root,'Film.mioon');
 if(format4)createProjectFile(projectFile,{format4:{}});
 const store=format4?openServerTestStore({projectFile,format4:{},locate:()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'temp')})},path.join(root,'app')):openStore(root);
 const services=createServices(store,new Map(),{imageOptions:{autoRun:false}}),value=await services.call('project.create',{name:'Parity actions'});
 assert.ok(record(value)&&typeof value.id==='string');const projectId=value.id;
 t.after(async()=>{await services.drain();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,store,services,projectId};
}

for(const format4 of [false,true])test(`thumbnail tools preserve the bounded JPEG and current frame in format ${format4?4:3}`,async t=>{
 const f=await fixture(t,format4),created=await f.services.call('previs.create',{projectId:f.projectId,position:{x:0,y:0},requestId:randomUUID()});
 assert.ok(record(created)&&typeof created.id==='string');
 const frame=format4?{framePresetId:DEFAULT_TIMELINE_OUTPUT_PRESET}:{},dataBase64=jpeg().toString('base64');
 const input=prepareParityThumbnail('previs.thumbnail.set',{nodeId:created.id,slot:'card',sceneRevision:1,dataBase64,...frame},f.projectId,{format4});
 const saved=await executeParityThumbnail({operation:'previs.thumbnail.set',input,services:f.services,beforeEffect:noEffect});
 assert.ok('byteLength' in saved);assert.equal(saved.byteLength,jpeg().length);
 const getInput=prepareParityThumbnail('previs.thumbnail.get',{nodeId:created.id,slots:['card'],...frame},f.projectId,{format4});
 const result=await executeParityThumbnail({operation:'previs.thumbnail.get',input:getInput,services:f.services,beforeEffect:noEffect});
 assert.ok('items' in result);assert.equal(result.items[0]!.dataBase64,dataBase64);assert.equal(result.framePresetId,format4?DEFAULT_TIMELINE_OUTPUT_PRESET:undefined);
 let calls=0;
 await assert.rejects(executeParityThumbnail({operation:'previs.thumbnail.set',input,services:{call:async()=>{calls++;return saved;}},beforeEffect:()=>{throw new Error('approval required');}}),/approval required/);
 assert.equal(calls,0);
});

test('thumbnail byte exception is limited to the exact typed root field and valid JPEG bounds',()=>{
 const projectId=randomUUID(),nodeId=randomUUID(),base={nodeId,slot:'card',sceneRevision:1,dataBase64:jpeg().toString('base64')};
 for(const input of [{...base,projectId},{...base,token:'secret'},{...base,input:{dataBase64:base.dataBase64}},{...base,dataBase64:'AAAA'},
  {...base,dataBase64:Buffer.alloc(PREVIS_LIMITS.thumbnailBytes+1).toString('base64')},{...base,dataBase64:base.dataBase64.slice(0,-1)+'A'}])
  assert.throws(()=>prepareParityThumbnail('previs.thumbnail.set',input,projectId,{format4:false}),{code:'VALIDATION_ERROR'});
 assert.throws(()=>prepareParityThumbnail('previs.thumbnail.set',base,projectId,{format4:true}),{code:'VALIDATION_ERROR'});
 assert.throws(()=>prepareParityThumbnail('previs.thumbnail.get',{nodeId,slots:['card','card']},projectId,{format4:false}),{code:'VALIDATION_ERROR'});
 const multiple={nodeId,slots:['card','k1234']};
 assert.equal(previsThumbnailPublicSchemas['previs.thumbnail.get'].safeParse({...multiple,projectId}).success,true,'ordinary clients retain the multi-slot API');
 assert.throws(()=>prepareParityThumbnail('previs.thumbnail.get',multiple,projectId,{format4:false}),{code:'VALIDATION_ERROR'});
});

test('thumbnail reads reject foreign or oversized service results',async()=>{
 const projectId=randomUUID(),nodeId=randomUUID(),input=prepareParityThumbnail('previs.thumbnail.get',{nodeId,slots:['card']},projectId,{format4:false});
 const item={slot:'card',sceneRevision:1,width:256,height:128,byteLength:jpeg().length,updatedAt:new Date().toISOString(),dataBase64:jpeg().toString('base64')};
 for(const result of [{projectId:randomUUID(),nodeId,items:[item]},{projectId,nodeId,items:[{...item,byteLength:PREVIS_LIMITS.thumbnailBytes+1}]}])
  await assert.rejects(executeParityThumbnail({operation:'previs.thumbnail.get',input,services:{call:async()=>result},beforeEffect:noEffect}),{code:'AGENT_TASK_INVALID_TOOL_RESULT'});
});

test('a local variant retry queues the exact backend-derived next attempt in both formats',async t=>{
 for(const format4 of [false,true]){
  const f=await fixture(t,format4),bytes=await renderMockImagePng({width:768,height:1024});
  const asset=await f.services.call('asset.import',{projectId:f.projectId,name:'Source.png',mimeType:'image/png',dataBase64:bytes.toString('base64')});
  assert.ok(record(asset)&&typeof asset.id==='string');
  const subject=await f.services.call('subject.create',{projectId:f.projectId,kind:'character',name:'Actor',assetId:asset.id,requestId:randomUUID()});
  assert.ok(record(subject)&&typeof subject.id==='string'&&typeof subject.headVersionId==='string');
  const batch=subjectVariantBatchSchema.parse(await f.services.call('subject.variants.create',{projectId:f.projectId,subjectId:subject.id,sourceVersionId:subject.headVersionId,kind:'angle',
   items:[{kind:'angle',position:'left',focal:'standard'}],providerId:'mock',model:IMAGE_MODELS.mock,requestId:randomUUID()}));
  const prior=imageTaskResponseSchema.parse(await f.services.call('image.generate',batch.items[0]!.imageInput));
  await f.services.call('image.task.cancelQueued',{projectId:f.projectId,taskId:prior.id,expectedRevision:prior.revision,requestId:randomUUID()});
  const result=await executeSubjectVariantRetry({services:f.services,projectId:f.projectId,input:{projectId:f.projectId,batchId:batch.id,position:1,expectedRevision:1,requestId:randomUUID()},beforeEffect:noEffect});
  assert.equal(result.batch.items[0]!.attempt,2);assert.equal(result.task.requestId,subjectVariantImageRequestId(batch.id,1,2));assert.equal(result.task.state,'queued');
  const current=subjectVariantBatchSchema.parse(await f.services.call('subject.variants.get',{projectId:f.projectId,batchId:batch.id}));
  assert.equal(current.items[0]!.image!.taskId,result.task.id);
 }
});

function retryFixture(providerId:'mock'|'openai'='openai'){
 const projectId=randomUUID(),batchId=randomUUID(),assetId=randomUUID(),timestamp=new Date().toISOString(),sourceImage={assetId,sha256:'a'.repeat(64),mimeType:'image/png',byteLength:100,width:768,height:1024,name:'Source.png',origin:{kind:'user-import'}};
 const imageInput={projectId,providerId,model:IMAGE_MODELS[providerId],name:'Actor · Left',prompt:'View from the left',purpose:'edit',inputImage:{assetId,sha256:sourceImage.sha256},
  options:{...IMAGE_FIXED_OPTIONS,size:'1152x1536'},requestId:subjectVariantImageRequestId(batchId,1,1)};
 const previous=subjectVariantBatchSchema.parse({id:batchId,projectId,subjectId:randomUUID(),sourceVersionId:randomUUID(),kind:'angle',requestId:randomUUID(),providerId,model:IMAGE_MODELS[providerId],size:'1152x1536',state:'active',revision:1,
  items:[{position:1,spec:{kind:'angle',position:'left',focal:'standard'},attempt:1,imageInput,versionId:null,image:{taskId:randomUUID(),state:'failed',dispatched:true,errorCode:'PROVIDER_ERROR'},status:'failed'}],
  undo:{available:true,blockers:[]},createdAt:timestamp,updatedAt:timestamp});
 const next=subjectVariantBatchSchema.parse({...previous,revision:2,undo:null,items:[{...previous.items[0],attempt:2,imageInput:{...imageInput,requestId:subjectVariantImageRequestId(batchId,1,2)},image:null,status:'pending'}]});
 const selected=next.items[0]!.imageInput;
 const task=imageTaskResponseSchema.parse({...selected,id:randomUUID(),groupId:randomUUID(),sourceImage,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp});
 const review=imageReviewResponseSchema.parse({id:randomUUID(),projectId,requestId:selected.requestId,input:selected,inputHash:'b'.repeat(64),settingsRevision:3,destination:IMAGE_EDIT_REVIEW_DESTINATION,policy:IMAGE_REVIEW_POLICY,
  sourceImage,state:'pending',revision:1,taskId:null,postAttempts:0,createdAt:timestamp,updatedAt:timestamp,approvedAt:null,rejectedAt:null,dispatchedAt:null});
 const profiles={items:[{providerId:'openai',model:IMAGE_MODELS.openai,name:'Images',enabled:true,isMock:false,evidence:'offline-tested-not-live',options:IMAGE_FIXED_OPTIONS,settingsRevision:3}],liveEnabled:true};
 const input={projectId,batchId,position:1,expectedRevision:1,requestId:randomUUID()},calls:{operation:string;input:unknown}[]=[];
 let reads=0,approvals=0;
 const services={call:async(operation:string,value:unknown):Promise<unknown>=>{
  calls.push({operation,input:value});
  if(operation==='subject.variants.get')return reads++===0?previous:{...next,undo:{available:true,blockers:[]}};
  if(operation==='subject.variants.retry')return next;
  if(operation==='image.profile.list')return profiles;
  if(operation==='image.review.prepare')return review;
  if(operation==='image.generate')return task;
  throw Error(`Unexpected operation ${operation}`);
 },imageApproval:(value:unknown):unknown=>{approvals++;calls.push({operation:'imageApproval',input:value});return task;}};
 return {projectId,previous,next,task,review,profiles,input,calls,services,get approvals(){return approvals;}};
}

test('official retry uses the exact selected image request and one immutable review approval',async()=>{
 const f=retryFixture(),result=await executeSubjectVariantRetry({services:f.services,projectId:f.projectId,input:f.input,beforeEffect:noEffect});
 assert.equal(result.task.id,f.task.id);assert.equal(f.approvals,1);assert.equal(f.calls.filter(call=>call.operation==='subject.variants.retry').length,1);
 assert.equal(f.calls.some(call=>call.operation==='image.generate'),false);
 assert.deepEqual(f.calls.find(call=>call.operation==='image.review.prepare')!.input,{input:f.next.items[0]!.imageInput,settingsRevision:3});
 assert.deepEqual(f.calls.find(call=>call.operation==='imageApproval')!.input,{projectId:f.projectId,reviewId:f.review.id,expectedRevision:1});
});

test('approval fence or disabled official profile prevents any retry or paid acceptance',async()=>{
 const blocked=retryFixture();
 await assert.rejects(executeSubjectVariantRetry({services:blocked.services,projectId:blocked.projectId,input:blocked.input,beforeEffect:()=>{throw Error('approval required');}}),/approval required/);
 assert.equal(blocked.calls.length,0);assert.equal(blocked.approvals,0);
 const disabled=retryFixture(),call=disabled.services.call;disabled.profiles.items[0]!.enabled=false;disabled.profiles.liveEnabled=false;
 await assert.rejects(executeSubjectVariantRetry({services:{...disabled.services,call},projectId:disabled.projectId,input:disabled.input,beforeEffect:noEffect}),{code:'AGENT_TASK_GENERATION_SERVICE_UNAVAILABLE'});
 assert.equal(disabled.calls.some(item=>item.operation==='subject.variants.retry'),false);assert.equal(disabled.approvals,0);
});

test('foreign batch, unresolved outcome, forged derived request, and changed attempt never dispatch',async()=>{
 for(const scenario of ['foreign','unknown','derived','changed'] as const){
  const f=retryFixture(),call=f.services.call;let reads=0;
  const services={...f.services,call:async(operation:string,input:unknown):Promise<unknown>=>{
   const result=await call(operation,input);
   if(operation==='subject.variants.get'){
    reads++;
    if(scenario==='foreign'&&reads===1)return {...f.previous,projectId:randomUUID(),items:f.previous.items.map(item=>({...item,imageInput:{...item.imageInput,projectId:randomUUID()}}))};
    if(scenario==='unknown'&&reads===1)return {...f.previous,items:[{...f.previous.items[0]!,status:'unknown',image:{...f.previous.items[0]!.image!,state:'outcome_unknown'}}],undo:{available:false,blockers:[{code:'UNKNOWN',position:1}]}};
    if(scenario==='changed'&&reads>1)return {...f.next,revision:3};
   }
   if(operation==='subject.variants.retry'&&scenario==='derived')return {...f.next,items:[{...f.next.items[0]!,imageInput:{...f.next.items[0]!.imageInput,requestId:randomUUID()}}]};
   return result;
  }};
  await assert.rejects(executeSubjectVariantRetry({services,projectId:f.projectId,input:f.input,beforeEffect:noEffect}));
  assert.equal(f.approvals,0,scenario);assert.equal(f.calls.some(item=>item.operation==='image.generate'),false,scenario);
  if(scenario==='foreign'||scenario==='unknown')assert.equal(f.calls.some(item=>item.operation==='subject.variants.retry'),false,scenario);
 }
});

test('a lost retry acknowledgement is not automatically retried or submitted',async()=>{
 const f=retryFixture(),call=f.services.call;
 const services={...f.services,call:async(operation:string,input:unknown):Promise<unknown>=>{const result=await call(operation,input);if(operation==='subject.variants.retry')throw Error('acknowledgement lost');return result;}};
 await assert.rejects(executeSubjectVariantRetry({services,projectId:f.projectId,input:f.input,beforeEffect:noEffect}),/acknowledgement lost/);
 assert.equal(f.calls.filter(item=>item.operation==='subject.variants.retry').length,1);assert.equal(f.approvals,0);assert.equal(f.calls.some(item=>item.operation==='image.review.prepare'),false);
});
