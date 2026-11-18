import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {IMAGE_MODELS,imageTaskResponseSchema,imageReviewResponseSchema,subjectVariantBatchSchema,subjectVariantImageRequestId} from '@mioon/contracts';
import type {AgentTaskControlAction,AgentTaskSnapshot,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {TaskModelRequest,TaskModelItem,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createImageSettings} from '../packages/business/src/images/settings.ts';
import {renderMockImagePng,validatePng} from '../packages/business/src/images/png.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import {agentTaskJobBinding} from '../packages/business/src/agent/task-effects-v2.ts';
import {sourceTaskModelToolNames} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {createTestAgentSettings,createTestSecretCodec,testSecretStorage} from './helpers/secret-codec.ts';
import {putTestAgentConfiguration,testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';

const RETRY='mioon_subject_variants_retry';
const object=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
function output(calls:AgentTaskToolCall[]=[]):TaskModelOutput {
 return {text:'完成',toolCalls:calls,providerOutput:calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}))};
}
const call=(name:string,args:AgentTaskToolCall['arguments']={}):AgentTaskToolCall=>({id:randomUUID(),name,arguments:args});
async function until<T>(read:()=>Promise<T>|T,done:(value:T)=>boolean):Promise<T>{
 const deadline=Date.now()+10000;
 for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)assert.fail('Expected state was not reached');await delay(5);}
}
async function fixture(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-parity-runtime-')),store=openStore(root);
 const imageSettings=await createImageSettings({persistence:{load:async()=>null,save:async()=>{}},secretCodec:createTestSecretCodec(),storage:testSecretStorage});
 const imageSnapshot=await imageSettings.put({expectedRevision:0,configuration:{...DEFAULT_IMAGE_CONFIGURATION,enabled:true},secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_IMAGE_TEST_ONLY'}});
 const outputBytes=await renderMockImagePng({width:1152,height:1536}),outputMetadata=await validatePng(outputBytes,{width:1152,height:1536});let posts=0;
 const services=createServices(store,new Map(),{mockAllowed:false,imageOptions:{settings:imageSettings,deferRecovery:true,liveGateway:{async generate(_input,context={}){
  assert.equal(typeof context.beforeDispatch,'function');(context.beforeDispatch as ()=>void)();posts++;
  return {bytes:outputBytes,metadata:{...outputMetadata,isMock:false,providerRequestId:'synthetic-variant-request',usage:null}};
 }}}});
 const projectId=String(object(await services.call('project.create',{name:'Parity runtime'})).id);
 const sourceBytes=await renderMockImagePng({width:768,height:1024});
 const asset=object(await services.call('asset.import',{projectId,name:'Source.png',mimeType:'image/png',dataBase64:sourceBytes.toString('base64')}));
 const subject=object(await services.call('subject.create',{projectId,kind:'character',name:'Actor',assetId:asset.id,requestId:randomUUID()}));
 const batch=subjectVariantBatchSchema.parse(await services.call('subject.variants.create',{projectId,subjectId:subject.id,sourceVersionId:subject.headVersionId,kind:'angle',items:[{kind:'angle',position:'left',focal:'standard'}],providerId:'openai',model:IMAGE_MODELS.openai,requestId:randomUUID()}));
 // A real cancelled-before-dispatch attempt is eligible for the paid retry.
 // Background execution stays inactive until the runtime has obtained consent.
 const oldReview=imageReviewResponseSchema.parse(await services.call('image.review.prepare',{input:batch.items[0]!.imageInput,settingsRevision:imageSnapshot.revision}));
 const oldTask=imageTaskResponseSchema.parse(await services.imageApproval({projectId,reviewId:oldReview.id,expectedRevision:oldReview.revision}));
 await services.call('image.task.cancelQueued',{projectId,taskId:oldTask.id,expectedRevision:oldTask.revision,requestId:randomUUID()});
 const settings=await createTestAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});
 await putTestAgentConfiguration(settings,{expectedRevision:(await settings.get()).revision,configuration:{...DEFAULT_AGENT_CONFIGURATION,protocol:'responses'},secret:{action:'replace',storage:'persistent',value:'SYNTHETIC_MIO_TEST_ONLY'}});
 const authorizations=createTestAuthorizations(()=>store,settings);await authorizeTestScope(authorizations,'project_agent');
 const tools=createAgentTaskTools({store,services});let retryOffered=false,loads=0;
 const gateway=async function*(request:TaskModelRequest):AsyncGenerator<TaskModelItem,void,undefined>{
  const visible=sourceTaskModelToolNames('responses',{body:request.body});
  if(!visible.includes(RETRY)){loads++;yield {type:'done',output:output([call(AGENT_TASK_TOOLS_LOAD_NAME,{names:[RETRY]})])};return;}
  if(!retryOffered){retryOffered=true;yield {type:'done',output:output([call(RETRY,{batchId:batch.id,position:1,expectedRevision:1})])};return;}
  yield {type:'done',output:output()};
 };
 const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,gateway,selfPort:()=>4318});
 runtime.updatePolicy({requestId:randomUUID(),expectedRevision:runtime.policy().revision,modes:{...runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 t.after(async()=>{runtime.close();await services.drain();tools.dispose();await settings.close();await imageSettings.close();store.close();rmSync(root,{recursive:true,force:true});});
 const action=(snapshot:AgentTaskSnapshot,action:AgentTaskControlAction,extra:Record<string,unknown>={})=>runtime.action(projectId,snapshot.run.id,{requestId:randomUUID(),expectedRevision:snapshot.run.revision,action,...extra});
 return {store,services,projectId,batch,runtime,action,get posts(){return posts;},get loads(){return loads;},
  async send(){return runtime.send(projectId,{requestId:randomUUID(),text:'重试这个主体变体',expectedSettingsRevision:testAgentExecution(await settings.get()).revision});},
  async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
  currentBatch:async()=>subjectVariantBatchSchema.parse(await services.call('subject.variants.get',{projectId,batchId:batch.id})),
 };
}

test('subject variant retry requires explicit consent in paid direct mode, then binds one paid dispatch to the same step',async t=>{
 const f=await fixture(t),sent=await f.send(),waiting=await f.settle(sent.run.id),step=waiting.steps.find(item=>item.toolCall?.name===RETRY);
 assert.ok(step);assert.equal(f.loads,1);assert.equal(f.runtime.policy().modes.paid,'direct');assert.equal(waiting.run.status,'awaiting_approval');assert.equal(step.status,'awaiting_approval');
 assert.equal(f.posts,0);assert.equal((await f.currentBatch()).items[0]!.attempt,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM image_reviews').get()!.n,1);
 await f.action(waiting,'approve',{stepId:step.id});const accepted=await f.settle(sent.run.id),current=await f.currentBatch(),taskId=current.items[0]!.image?.taskId;
 assert.equal(accepted.run.status,'completed');assert.equal(current.items[0]!.attempt,2);assert.ok(taskId);assert.equal(f.posts,0);
 assert.deepEqual(agentTaskJobBinding(f.store.db,'image',taskId),{projectId:f.projectId,runId:sent.run.id,stepId:step.id,requestId:step.id,operation:'subject.variants.retry'});
 const task=imageTaskResponseSchema.parse(await f.services.call('image.task.get',{projectId:f.projectId,taskId}));
 assert.equal(task.requestId,subjectVariantImageRequestId(f.batch.id,1,2));assert.equal(task.dispatched,false);
 f.services.activateBackground();
 await until(()=>f.runtime.get(f.projectId,sent.run.id),snapshot=>snapshot.steps.find(item=>item.id===step.id)?.cost==='submitted');
 assert.equal(f.posts,1);
 await until(()=>f.currentBatch(),batch=>batch.items[0]!.status==='succeeded');
 assert.equal((await f.currentBatch()).items[0]!.attempt,2);assert.equal(f.posts,1);
});

test('pausing an approved queued retry keeps the original origin and prevents provider dispatch',async t=>{
 const f=await fixture(t),sent=await f.send(),waiting=await f.settle(sent.run.id),step=waiting.steps.find(item=>item.toolCall?.name===RETRY);assert.ok(step);
 await f.action(waiting,'approve',{stepId:step.id});const accepted=await f.settle(sent.run.id),batch=await f.currentBatch(),taskId=batch.items[0]!.image?.taskId;assert.ok(taskId);
 await f.action(accepted,'pause');f.services.activateBackground();
 await until(()=>f.services.isBusy(),busy=>!busy);
 const paused=f.runtime.get(f.projectId,sent.run.id),task=imageTaskResponseSchema.parse(await f.services.call('image.task.get',{projectId:f.projectId,taskId}));
 assert.equal(paused.run.status,'paused');assert.equal(f.posts,0);assert.equal(task.dispatched,false);assert.notEqual(paused.steps.find(item=>item.id===step.id)?.cost,'submitted');
 assert.equal(agentTaskJobBinding(f.store.db,'image',taskId)?.stepId,step.id);assert.equal((await f.currentBatch()).items[0]!.attempt,2);
});
