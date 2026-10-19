import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {COMFY_IMAGE_OPTIONS,COMFY_IMAGE_POLICY,DEFAULT_COMFY_IMAGE_CONFIGURATION,comfyImageConfigurationSchema,comfyImageExecutionSchema,comfyRemoteSchemas,
  comfyImageSettingsResultSchema,comfyImageBaseUrlSchema,normalizeComfyImageBaseUrl,comfyCheckpointSchema,isComfyObserveResponse,comfyImageGraphSchema} from '../packages/contracts/src/comfy-images.ts';
import {imageSchemas,imageReceiptSchema,imageSnapshotSchema,imageAdapterInputSchema,IMAGE_FIXED_OPTIONS,IMAGE_MODELS} from '../packages/contracts/src/images.ts';
import {imageReviewIntentSchema,imageReviewSchemas,IMAGE_REVIEW_POLICY} from '../packages/contracts/src/image-reviews.ts';
import {buildComfyWorkflow,hashComfyWorkflow} from '../packages/business/src/comfy/workflow.ts';
import {operationDefinition,jsonSchema} from '../packages/client/src/index.ts';
const projectId=randomUUID(),taskId=randomUUID(),groupId=randomUUID(),requestId=randomUUID(),at='2026-10-10T00:00:00.000Z';
function fixture(){const input={projectId,requestId,name:'Local image',providerId:'comfy-local',model:'folder/model.safetensors',prompt:'A red tree',options:COMFY_IMAGE_OPTIONS};
 const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl:'http://127.0.0.1:8188',model:input.model};
 const outputNonce=randomUUID(),seed=123,graph=buildComfyWorkflow({prompt:input.prompt,checkpoint:input.model,seed,outputNonce});
 const execution={workflowId:'comfy-t2i-png-v1',workflowVersion:1,comfyVersion:'0.39.0',seed,promptId:randomUUID(),clientId:randomUUID(),outputNonce,filenamePrefix:`mioon_${outputNonce}`,graph,graphHash:hashComfyWorkflow(graph)};
 return {input,configuration,execution};}
test('local endpoint syntax is exact loopback, explicit port, root, no authentication',()=>{
 for(const value of ['http://127.0.0.1:8188','http://[::1]:65535'])assert.ok(comfyImageBaseUrlSchema.safeParse(value).success);
 assert.equal(normalizeComfyImageBaseUrl('http://127.0.0.1:8188/'),'http://127.0.0.1:8188');
 for(const value of ['http://localhost:8188','https://127.0.0.1:8188','http://127.0.0.1','http://127.0.0.1:08188','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.1:8188','http://2130706433:8188','http://[::ffff:127.0.0.1]:8188','http://user@127.0.0.1:8188','http://127.0.0.1:8188/api','http://127.0.0.1:8188?x','http://127.0.0.1:8188#x','http://127.0.0.1:8188/'])assert.equal(comfyImageBaseUrlSchema.safeParse(value).success,false,value);
});
test('checkpoint selection is a bounded relative name and settings contain no credential or model execution authority',()=>{
 assert.ok(comfyCheckpointSchema.safeParse('folder/测试 model.safetensors').success);
 for(const value of ['/a','C:/a','../a','a/../b','a//b','a\\b','a\0b',' a','a/','https://host/model'])assert.equal(comfyCheckpointSchema.safeParse(value).success,false,value);
 assert.ok(comfyImageConfigurationSchema.safeParse(DEFAULT_COMFY_IMAGE_CONFIGURATION).success);
 const {configuration}=fixture();assert.ok(comfyImageConfigurationSchema.safeParse(configuration).success);
 for(const patch of [{secret:'x'},{model:''},{comfyVersion:'latest'},{options:IMAGE_FIXED_OPTIONS},{baseUrl:'http://localhost:8188'}])assert.equal(comfyImageConfigurationSchema.safeParse({...configuration,...patch}).success,false);
 assert.ok(comfyImageSettingsResultSchema.safeParse({revision:1,configuration,readiness:{checked:false,checkedAt:null}}).success);
 assert.equal(comfyImageSettingsResultSchema.safeParse({revision:1,configuration,readiness:{checked:false,checkedAt:at}}).success,false);
});
test('Comfy is a disjoint image generation branch; seed and graph can only appear in returned review execution',()=>{
 const {input,configuration,execution}=fixture();assert.ok(imageSchemas['image.generate'].safeParse(input).success);
 for(const patch of [{seed:1},{graph:execution.graph},{promptId:randomUUID()},{options:IMAGE_FIXED_OPTIONS},{providerId:'openai'},{model:'../bad'}])assert.equal(imageSchemas['image.generate'].safeParse({...input,...patch}).success,false);
 assert.ok(imageReviewSchemas['image.review.prepare'].safeParse({input,settingsRevision:1}).success);
 assert.equal(imageReviewSchemas['image.review.prepare'].safeParse({input,settingsRevision:1,execution}).success,false);
 const adapter={providerId:input.providerId,model:input.model,prompt:input.prompt,options:input.options};assert.ok(imageAdapterInputSchema.safeParse(adapter).success);
 assert.ok(imageSnapshotSchema.safeParse({schemaVersion:1,projectId,groupId,taskId,name:input.name,...adapter}).success);
 const intent={schemaVersion:3,reviewId:randomUUID(),input,settingsRevision:1,destination:configuration.baseUrl+'/prompt',policy:COMFY_IMAGE_POLICY,configuration,execution};
 assert.ok(imageReviewIntentSchema.safeParse(intent).success);
 for(const mutate of [v=>v.schemaVersion=2,v=>v.policy=IMAGE_REVIEW_POLICY,v=>v.input.prompt='Different',v=>v.configuration.baseUrl='http://127.0.0.1:8189',v=>v.execution.graph['3'].inputs.text='Other',v=>v.execution.seed++,v=>v.execution.filenamePrefix='mioon_bad']){const value=structuredClone(intent);mutate(value);assert.equal(imageReviewIntentSchema.safeParse(value).success,false);}
});
test('exact seven-node graph rejects arbitrary nodes, links, inputs and unknown fields',()=>{
 const {execution}=fixture();assert.ok(comfyImageExecutionSchema.safeParse(execution).success);
 for(const mutate of [g=>g['8']=g['7'],g=>delete g['1'],g=>g['1'].class_type='CustomNode',g=>g['2'].inputs.width=1024,g=>g['5'].inputs.steps=21,g=>g['4'].inputs.text='hidden',g=>g['6'].inputs.vae=['9',0],g=>g['7'].inputs.path='/tmp',g=>g['1']._meta={}]){const graph=structuredClone(execution.graph);mutate(graph);assert.equal(comfyImageGraphSchema.safeParse(graph).success,false);}
});
test('Comfy PNG receipt is explicit schema2; legacy receipts retain exact schema1 shape',()=>{
 const old={schemaVersion:1,taskId,projectId,groupId,inputHash:'a'.repeat(64),assetId:randomUUID(),versionId:randomUUID(),sha256:'b'.repeat(64),mimeType:'image/png',width:1024,height:1024,byteLength:123,isMock:false};
 assert.deepEqual(imageReceiptSchema.parse(old),old);
 const local={...old,schemaVersion:2,providerId:'comfy-local',width:512,height:512};assert.deepEqual(imageReceiptSchema.parse(local),local);
 for(const value of [{...old,width:512,height:512},{...old,providerId:'comfy-local'},{...local,schemaVersion:1},{...local,providerId:'openai'},{...local,width:1024}])assert.equal(imageReceiptSchema.safeParse(value).success,false);
 const legacy={...fixture().input,providerId:'mock',model:IMAGE_MODELS.mock,options:IMAGE_FIXED_OPTIONS};assert.deepEqual(imageSchemas['image.generate'].parse(legacy),legacy);
});
test('remote observation has its own stable acknowledgement and remote-revision CAS',()=>{
 const input={projectId,taskId,expectedRevision:3,requestId};
 const response={id:randomUUID(),projectId,taskId,requestId,state:'queued',revision:1,remoteRevision:4,createdAt:at};
 assert.ok(comfyRemoteSchemas['image.task.observeRemote'].safeParse(input).success);assert.ok(isComfyObserveResponse(input,response));
 for(const patch of [{remoteRevision:3},{requestId:randomUUID()},{state:'finished'},{revision:2},{graph:{}}])assert.equal(isComfyObserveResponse(input,{...response,...patch}),false);
 assert.equal(imageSchemas['image.task.observeRemote'],undefined,'legacy image request journal is unchanged');
});
test('catalog preserves strict image union branches and reports the common required replay key',()=>{
 const definition=operationDefinition('image.generate');assert.equal(definition.inputSchema.type,'object');assert.equal(definition.requiresRequestId,true);
 assert.equal(definition.inputSchema.anyOf.length,3);for(const branch of definition.inputSchema.anyOf){assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);assert.ok(branch.required.includes('requestId'));}
 assert.equal(operationDefinition('image.task.observeRemote').requiresRequestId,true);assert.equal(operationDefinition('image.task.remote.get').requiresRequestId,false);
 const scalar=jsonSchema(comfyRemoteSchemas['image.task.remote.get'].shape.taskId);assert.equal(scalar.type,'string');
});
