import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {imageSchemas,IMAGE_FIXED_OPTIONS,IMAGE_MODELS,IMAGE_LIMITS,IMAGE_STATES,imageSnapshotSchema,imageReceiptSchema,imageAdapterInputSchema,isImageTaskResponse,isImageMutationResponse,isImageListResponse,isImageRequestResponse,isImageProfilesResponse} from '../packages/contracts/src/images.ts';
import {isSubjectVersionResponse} from '../packages/contracts/src/subjects.ts';
const projectId=randomUUID(),groupId=randomUUID(),taskId=randomUUID(),assetId=randomUUID(),versionId=randomUUID(),requestId=randomUUID(),timestamp='2026-10-10T00:00:00.000Z';
const input={projectId,name:'Example',prompt:'A blue square',providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS,requestId};
const task={id:taskId,projectId,groupId,requestId,name:input.name,prompt:input.prompt,providerId:input.providerId,model:input.model,options:input.options,state:'queued',revision:1,dispatched:false,versionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp};

test('image inputs are explicit, exact and fixed to bounded single-output presets',()=>{
 assert.deepEqual(imageSchemas['image.generate'].parse(input),input);
 for(const patch of [{extra:true},{endpoint:'https://example.test'},{apiKey:'secret'},{requestId:undefined},{prompt:' '},{prompt:'x'.repeat(IMAGE_LIMITS.promptCharacters+1)},{prompt:'bad\0prompt'},{providerId:'openai'},{groupId},{expectedRevision:1},{options:{...input.options,n:2}},{options:{...input.options,output_format:'png'}}])assert.equal(imageSchemas['image.generate'].safeParse({...input,...patch}).success,false);
 assert.ok(imageSchemas['image.generate'].safeParse({...input,groupId,expectedRevision:2}).success);
 const {projectId:_,name:__,requestId:___,...adapter}=input;assert.ok(imageAdapterInputSchema.safeParse(adapter).success);assert.equal(imageAdapterInputSchema.safeParse(input).success,false);
 assert.ok(imageSnapshotSchema.safeParse({schemaVersion:1,projectId,groupId,taskId,name:input.name,...adapter}).success);
 const schemas=imageSchemas as unknown as Record<string, {safeParse(value: unknown): {success: boolean}}>;
 for(const op of ['image.task.cancelQueued','image.task.recoverResult'])assert.ok(schemas[op].safeParse({projectId,taskId,expectedRevision:1,requestId}).success);
 for(const op of ['image.task.list','image.group.list','image.version.list'])assert.equal(schemas[op].safeParse({projectId,groupId,limit:51}).success,false);
});

test('task receipts bind exact submitted intent and keep action key separate from generation key',()=>{
 assert.ok(isImageTaskResponse(task));assert.ok(isImageMutationResponse('image.generate',input,task));
 for(const patch of [{prompt:'Wrong'},{requestId:randomUUID()},{revision:2},{state:'succeeded',versionId},{options:{...input.options,n:2}},{secret:'hidden'}])assert.equal(isImageMutationResponse('image.generate',input,{...task,...patch}),false);
 assert.ok(IMAGE_STATES.includes('interrupted_before_dispatch'));
 const cancelled={...task,revision:2,state:'cancelled_before_dispatch'};
 assert.ok(isImageMutationResponse('image.task.cancelQueued',{projectId,taskId,expectedRevision:1,requestId:randomUUID()},cancelled));
 assert.ok(isImageRequestResponse({projectId,requestId:randomUUID(),operation:'image.task.cancelQueued',response:cancelled}));
 assert.equal(isImageRequestResponse({projectId,requestId:randomUUID(),operation:'image.generate',response:task}),false);
 assert.equal(isImageTaskResponse({...task,state:'outcome_unknown'}),false);assert.ok(isImageTaskResponse({...task,state:'outcome_unknown',dispatched:true}));
 assert.equal(isImageTaskResponse({...task,state:'succeeded',dispatched:true}),false);
 assert.ok(isImageListResponse('image.task.list',{projectId},{projectId,items:[task],nextCursor:null}));
 assert.equal(isImageListResponse('image.task.list',{projectId},{projectId,items:[task,task],nextCursor:null}),false);
});

test('receipt excludes paths and base64; profile DTO distinguishes configured activation from live verification',()=>{
 const receipt={schemaVersion:1,taskId,projectId,groupId,inputHash:'a'.repeat(64),assetId,versionId,sha256:'b'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:100,isMock:true};
 assert.ok(imageReceiptSchema.safeParse(receipt).success);
 for(const extra of [{path:'/tmp/a'},{dataBase64:'AAAA'},{byteLength:IMAGE_LIMITS.resultBytes+1}])assert.equal(imageReceiptSchema.safeParse({...receipt,...extra}).success,false);
 const profile={providerId:'openai',model:IMAGE_MODELS.openai,name:'OpenAI',enabled:false,isMock:false,evidence:'offline-tested-not-live',options:IMAGE_FIXED_OPTIONS};
 assert.ok(isImageProfilesResponse({items:[profile],liveEnabled:false}));assert.ok(isImageProfilesResponse({items:[{...profile,enabled:true}],liveEnabled:true}));assert.equal(isImageProfilesResponse({items:[{...profile,enabled:true}],liveEnabled:false}),false);assert.equal(isImageProfilesResponse({items:[{...profile,evidence:'live-verified'}],liveEnabled:false}),false);
});

test('subject typed image provenance is additive and never mixes legacy identifiers',()=>{
 const legacy={id:randomUUID(),projectId,subjectId:randomUUID(),number:1,assetId,sha256:'a'.repeat(64),mimeType:'image/png',width:1024,height:1024,provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:timestamp};
 const serialized=JSON.stringify(legacy);assert.ok(isSubjectVersionResponse(legacy));assert.equal(JSON.stringify(legacy),serialized);
 const sourced={...legacy,provenance:{...legacy.provenance,kind:'synthetic-mock',imageSource:{imageGroupId:groupId,imageTaskId:taskId,imageVersionId:versionId}}};assert.ok(isSubjectVersionResponse(sourced));
 for(const provenance of [{...sourced.provenance,versionId},{...sourced.provenance,kind:'user-import'},{...sourced.provenance,imageSource:{imageGroupId:groupId}}])assert.equal(isSubjectVersionResponse({...sourced,provenance}),false);
});
