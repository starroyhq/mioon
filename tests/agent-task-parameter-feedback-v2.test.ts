import {putTestAgentConfiguration,testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {agentTaskGenerationAspectFeedback,agentTaskParameterFeedback} from '../packages/business/src/agent/task-tool-errors-v2.ts';
import {defaultVideoModels,resolveVideoEndpoint,videoBindingCapabilities} from '../packages/contracts/src/video-providers.ts';
import type {VideoExecutionBinding,VideoProviderId,VideoTemplateId,VideoConnectionConfiguration} from '../packages/contracts/src/video-providers.ts';
import {openServerTestStore,openStore} from '../packages/business/src/project-file/test-store.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord} from '../packages/business/src/services.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway,TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentTaskJson,AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const json=(value:unknown):AgentTaskJson=>JSON.parse(JSON.stringify(value)) as AgentTaskJson;
function bindingFor(providerId:VideoProviderId='minimax',templateId?:VideoTemplateId):VideoExecutionBinding{
  const model=defaultVideoModels(providerId).find(model=>!templateId||model.templateId===templateId)!;
  const region=providerId==='wan'||providerId==='ark'?'cn-beijing':providerId==='minimax'?'cn':'global';
  return {version:1,connectionId:randomUUID(),configurationRevision:1,providerId,region,workspaceId:'',endpoint:resolveVideoEndpoint(providerId,region),credentialRef:randomUUID(),model,outputHosts:[]};
}
function inputFor(binding:VideoExecutionBinding){return {shotId:randomUUID(),expectedRevision:1,providerId:binding.providerId,model:binding.model.modelId,connectionId:binding.connectionId,configurationRevision:binding.configurationRevision,modelEntryId:binding.model.id,parameters:{resolution:binding.model.durationResolutionMap[0]!.resolution[0]!}};}
const mixed={resolution:'2K',aspectRatio:'9:16',durationSeconds:4,promptExtend:true,watermark:false};
test('MiniMax feedback identifies Wan-only fields and derives supported parameters from the exact selected model',()=>{
  const binding=bindingFor(),input={...inputFor(binding),parameters:{...mixed}},before=structuredClone(input),capabilities=videoBindingCapabilities(binding);
  const feedback=agentTaskParameterFeedback({operation:'generation.submit',input,capabilities});assert.ok(feedback);
  for(const field of ['aspectRatio','durationSeconds','promptExtend','watermark'])assert.ok(feedback.issues.some(issue=>issue.field===`parameters.${field}`&&issue.reason==='unsupported_parameter'));
  assert.deepEqual(feedback.supported,{parameters:['resolution'],aspectRatios:['9:16','16:9'],durationsSeconds:[4,8],durationResolutionMap:[{duration:[4,8],resolution:['2K']}]});
  assert.match(feedback.message,/patch\.aspectRatio、patch\.duration、patch\.prompt/u);assert.match(feedback.message,/不授权付费/u);assert.deepEqual(input,before);
  const corrected={...input,parameters:Object.fromEntries(Object.entries(input.parameters).filter(([field])=>feedback.supported!.parameters.includes(field)))};
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input:corrected,capabilities}),null);
});
test('feedback ignores all provider messages, input values, credentials, URLs and unrecognized field names',()=>{
  const binding=bindingFor(),capabilities={...videoBindingCapabilities(binding),message:'PRIVATE_PROVIDER_MESSAGE',inputProfiles:[{parameters:{apiKey:'PRIVATE_KEY'}}],credentialRef:'PRIVATE_CREDENTIAL',endpoint:'https://PRIVATE_URL.invalid'},input={...inputFor(binding),parameters:{...mixed,resolution:'https://PRIVATE_VALUE.invalid',PRIVATE_UNKNOWN_KEY:'PRIVATE_KEY'}};
  const feedback=agentTaskParameterFeedback({operation:'generation.submit',input,capabilities});assert.ok(feedback?.supported);assert.ok(feedback.issues.some(issue=>issue.field==='parameters'&&issue.reason==='unknown_field'));
  assert.doesNotMatch(JSON.stringify(feedback),/PRIVATE|https?:\/\/|credentialRef/u);
  assert.deepEqual(feedback.supported.parameters,['resolution']);
});
test('mismatched connection, revision, model entry or exact model cannot borrow another model capability',()=>{
  const binding=bindingFor(),input={...inputFor(binding),parameters:{...mixed}},capabilities=videoBindingCapabilities(binding);
  for(const changed of [{...input,connectionId:randomUUID()},{...input,configurationRevision:2},{...input,modelEntryId:randomUUID()},{...input,model:'MiniMax-H3-similar'},{...input,providerId:'ark'}]){
    const feedback=agentTaskParameterFeedback({operation:'generation.submit',input:changed,capabilities});assert.ok(feedback);assert.equal(feedback.supported,undefined);
  }
  const forged={...capabilities,videoConnection:{...capabilities.videoConnection,endpoint:'https://PRIVATE_ORIGIN.invalid'}};
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input,capabilities:forged})?.supported,undefined);
});
test('valid Wan options and other providers retain their own parameter capabilities',()=>{
  const wan=bindingFor('wan','wan30-v1'),input={...inputFor(wan),parameters:{resolution:'720P',aspectRatio:'adaptive',durationSeconds:-1,promptExtend:true,watermark:false}};
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input,capabilities:videoBindingCapabilities(wan)}),null);
  const runway=bindingFor('runway'),runwayInput={...inputFor(runway),parameters:{resolution:'720p',seed:1}};
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input:runwayInput,capabilities:videoBindingCapabilities(runway)}),null);
  const miniMax=bindingFor(),miniMaxInput={...inputFor(miniMax),parameters:{resolution:'2K',seed:1,generateAudio:true}};
  const rejected=agentTaskParameterFeedback({operation:'generation.submit',input:miniMaxInput,capabilities:videoBindingCapabilities(miniMax)});assert.ok(rejected);
  assert.ok(rejected.issues.some(issue=>issue.field==='parameters.seed'&&issue.reason==='unsupported_parameter'));assert.ok(rejected.issues.some(issue=>issue.field==='parameters.generateAudio'&&issue.reason==='unsupported_parameter'));
});
test('Seedance 2.5 accepts generation duration and ratio while other Ark models and Wan-only fields are corrected locally',()=>{
  const seedance=bindingFor('ark'),capabilities=videoBindingCapabilities(seedance);
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input:{...inputFor(seedance),parameters:{resolution:'1080p',durationSeconds:30,aspectRatio:'21:9',generateAudio:true}},capabilities}),null);
  assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input:{...inputFor(seedance),parameters:{resolution:'720p',durationSeconds:-1,aspectRatio:'adaptive'}},capabilities}),null);
  const wanOnly=agentTaskParameterFeedback({operation:'generation.submit',input:{...inputFor(seedance),parameters:{resolution:'720p',durationSeconds:8,promptExtend:true,watermark:false}},capabilities});assert.ok(wanOnly);
  assert.deepEqual(wanOnly.issues.filter(issue=>issue.reason==='unsupported_parameter').map(issue=>issue.field).sort(),['parameters.promptExtend','parameters.watermark']);
  assert.ok(wanOnly.supported?.parameters.includes('durationSeconds'));assert.match(wanOnly.message,/Seedance 2\.5/u);assert.match(wanOnly.message,/parameters\.durationSeconds、parameters\.aspectRatio/u);
  assert.doesNotMatch(wanOnly.message,/patch\.duration/u);
  const custom=bindingFor('ark');custom.model={...custom.model,modelId:'custom-seedance-model',inputModes:['text','image','frames']};
  const legacy=agentTaskParameterFeedback({operation:'generation.submit',input:{...inputFor(custom),parameters:{resolution:'720p',durationSeconds:8}},capabilities:videoBindingCapabilities(custom)});assert.ok(legacy);
  assert.ok(legacy.issues.some(issue=>issue.field==='parameters.durationSeconds'&&issue.reason==='unsupported_parameter'));assert.match(legacy.message,/patch\.aspectRatio、patch\.duration、patch\.prompt/u);
});
test('field feedback uses closed paths and categories without exposing validation values or identities',()=>{
  const binding=bindingFor(),base=inputFor(binding),capabilities=videoBindingCapabilities(binding);
  for(const [patch,field,reason] of [
    [{expectedRevision:0},'expectedRevision','invalid_value'],[{expectedRevision:'PRIVATE'},'expectedRevision','invalid_type'],[{shotId:undefined},'shotId','required'],
    [{parameters:{resolution:17}},'parameters.resolution','invalid_type'],[{parameters:{resolution:'768P'}},'parameters.resolution','invalid_value'],
    [{parameters:{resolution:'2K'},PRIVATE_KEY:'PRIVATE_VALUE'},'input','unknown_field'],
    [{aspectSource:{kind:'PRIVATE'}},'aspectSource.kind','invalid_value'],
    [{aspectSource:{kind:'project',aspectRatio:'9:16'}},'aspectSource.expectedTimelineRevision','required'],
    [{aspectSource:{kind:'explicit',aspectRatio:'PRIVATE'}},'aspectSource.aspectRatio','invalid_value'],
    [{aspectSource:{kind:'shot',PRIVATE_KEY:'PRIVATE_VALUE'}},'aspectSource','unknown_field'],
  ] as const){const feedback=agentTaskParameterFeedback({operation:'generation.submit',input:{...base,...patch},capabilities});assert.ok(feedback?.issues.some(issue=>issue.field===field&&issue.reason===reason));assert.doesNotMatch(JSON.stringify(feedback),/PRIVATE|credentialRef|https?:\/\//u);}
  assert.equal(agentTaskParameterFeedback({operation:'shot.update',input:{PRIVATE:'secret'}}),null);assert.equal(agentTaskParameterFeedback({operation:'generation.submit',input:null}),null);
});

test('generation aspect feedback gives only proven aspect choices or the current frame',()=>{
  const projectId=randomUUID(),requestId=randomUUID(),shotId=randomUUID();
  const proof={projectId,requestId,shotId,mutationOutcome:'not_applied',providerId:'PRIVATE_PROVIDER',model:'PRIVATE_MODEL'};
  const input={requestId,shotId,aspectSource:{kind:'project',expectedTimelineRevision:1,aspectRatio:'1:1'}};
  const feedback=(error:unknown,candidate:unknown=input,owner=projectId)=>agentTaskGenerationAspectFeedback({operation:'generation.submit',input:candidate,error,projectId:owner});
  const unsupported=(supportedAspectRatios:unknown=['9:16','16:9'],extra:Record<string,unknown>={})=>new AppError('PROJECT_ASPECT_UNSUPPORTED','PRIVATE_PROVIDER_BODY',400,{...proof,projectAspectRatio:'1:1',supportedAspectRatios,...extra});
  const rejected=feedback(unsupported());assert.ok(rejected);
  assert.deepEqual(rejected,{code:'PROJECT_ASPECT_UNSUPPORTED',message:rejected.message,mutationOutcome:'not_applied',projectAspectRatio:'1:1',supportedAspectRatios:['9:16','16:9']});
  assert.match(rejected.message,/项目画幅 1:1.*9:16、16:9.*明确选择.*explicit.*确认/u);
  const changed=(projectAspectRatio='16:9',timelineRevision=2)=>new AppError('PROJECT_ASPECT_CHANGED','PRIVATE_PROVIDER_BODY',409,{...proof,projectAspectRatio,timelineRevision});
  const current=feedback(changed());assert.ok(current);
  assert.deepEqual(current,{code:'PROJECT_ASPECT_CHANGED',message:current.message,mutationOutcome:'not_applied',projectAspectRatio:'16:9',timelineRevision:2});
  assert.match(current.message,/16:9.*修订为 2.*timeline\.format\.get.*确认/u);
  const explicit=feedback(new AppError('GENERATION_ASPECT_UNSUPPORTED','PRIVATE_PROVIDER_BODY',400,{...proof,aspectRatio:'adaptive',supportedAspectRatios:['9:16']}),{...input,aspectSource:{kind:'explicit',aspectRatio:'adaptive'}});assert.ok(explicit);
  assert.deepEqual(explicit,{code:'GENERATION_ASPECT_UNSUPPORTED',message:explicit.message,mutationOutcome:'not_applied',aspectRatio:'adaptive',supportedAspectRatios:['9:16']});
  for(const result of [rejected,current,explicit]){
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|providerId|shotId|requestId|projectId/u);
    for(const id of [projectId,shotId,requestId])assert.equal(JSON.stringify(result).includes(id),false);
  }
  assert.match(feedback(unsupported([]))!.message,/没有可用画幅/u);
  const unreadable=Object.defineProperty(['9:16'],0,{get(){throw Error('must not read ratio accessor');}});
  for(const error of [unsupported(['9:16','9:16']),unsupported(['PRIVATE_RATIO']),unsupported(['1:1']),unsupported(Array(1)),unsupported(unreadable),unsupported(Array(8).fill('9:16')),unsupported(undefined,{mutationOutcome:'uncertain'}),unsupported(undefined,{projectAspectRatio:'16:9'}),changed('1:1',1),changed('16:9',-1),changed('adaptive'),new AppError('PROJECT_ASPECT_CHANGED','PRIVATE',400,{...proof,projectAspectRatio:'16:9',timelineRevision:2})])assert.equal(feedback(error),null);
  assert.equal(feedback(unsupported(),{...input,requestId:randomUUID()}),null);
  assert.equal(feedback(unsupported(),{...input,shotId:randomUUID()}),null);
  assert.equal(feedback(unsupported(),input,randomUUID()),null);
});

function findFeedback(value:unknown):Record<string,unknown>|null{
  if(Array.isArray(value)){for(const child of value){const found=findFeedback(child);if(found)return found;}return null;}
  if(!object(value))return null;if(Array.isArray(value.issues)&&object(value.supported))return value;
  for(const child of Object.values(value)){const found=findFeedback(child);if(found)return found;}return null;
}
async function runtimeFixture(t:TestContext,protocol:'chat_completions'|'responses',format4=false){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-parameter-feedback-'))),projectFile=path.join(root,'project.mioon');
  if(format4)createProjectFile(projectFile);
  const store=format4?openServerTestStore({projectFile,locate:()=>({localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')}),format4:{approveUpgrade:()=>true}},path.join(root,'app')):openStore(root);
  const videoSettings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
  const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'minimax',name:'Synthetic MiniMax',region:'cn',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('minimax')};
  await videoSettings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',storage:'session',value:'SYNTHETIC_VIDEO_KEY'}});
  const posts:Array<{url:string;body:Record<string,unknown>}>=[];
  const services=createServices(store,new Map(),{videoSettings,profileNow:()=>Date.UTC(2026,9,24),videoFetch:async(url,init)=>{
    if(init?.method==='POST'){assert.ok(typeof init.body==='string');posts.push({url:String(url),body:JSON.parse(init.body) as Record<string,unknown>});return new Response(JSON.stringify({task_id:'one-original-video-task'}),{headers:{'content-type':'application/json'}});}
    return new Response(JSON.stringify({task:{id:'one-original-video-task',status:'running'}}),{headers:{'content-type':'application/json'}});
  }});
  await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
  const project=await services.call('project.create',{name:'Correction fixture'});assert.ok(object(project)&&typeof project.id==='string');const projectId=project.id;
  const shot=await services.call('shot.create',{projectId,title:'Saved shot',prompt:'A synthetic blue cube rotates.',duration:4,aspectRatio:'9:16'});assert.ok(object(shot));
  const settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}}),initial=await settings.get();await putTestAgentConfiguration(settings,{expectedRevision:0,configuration:defaultTestAgentConfiguration(protocol),secret:{action:'replace',storage:'session',value:'SYNTHETIC_CHAT_KEY'}});
  const authorizations=createTestAuthorizations(()=>({...store}),settings);await authorizeTestScope(authorizations,'project_agent');
  const sourceTools=createAgentTaskTools({store,services}),requests:string[]=[];let script:TaskGateway=async function*(){throw Error('A synthetic model script is required');},executeFailure:unknown;
  const tools={...sourceTools,async execute(...args:Parameters<typeof sourceTools.execute>){if(executeFailure)throw executeFailure;return sourceTools.execute(...args);}};
  const runtime=createAgentTaskRuntime({store,agentSettings:settings,authorizations,tools,selfPort:()=>4318,gateway:async function*(request){requests.push(request.body);if(requests.length===1){yield {type:'done',output:output({names:['mioon_generation_submit']},'mioon_tools_load')};return;}yield*script(request);}});
  let worker:ReturnType<typeof startWorker>|undefined;
  t.after(async()=>{await worker?.stop();runtime.close();await runtime.drain();tools.dispose();await services.drain();await settings.close();await videoSettings.close();store.close();await rm(root,{recursive:true,force:true});});
  const base={shotId:shot.id,expectedRevision:shot.revision,providerId:'minimax',model:'MiniMax-H3',connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id};
  function output(args?:Record<string,unknown>,name='mioon_generation_submit'):TaskModelOutput{
    const calls=args?[{id:`call-${requests.length}`,name,arguments:json(args)}]:[];
    return {text:'',toolCalls:calls,providerOutput:protocol==='responses'?calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'})):{role:'assistant',content:null,tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}};
  }
  return {root,store,services,settings,authorizations,tools,runtime,posts,requests,base,projectId,shot,setScript(value:TaskGateway){script=value;},failExecute(error:unknown){executeFailure=error;},output,
    async send(policy?:{modes:{read_only:'direct';local_reversible:'direct';local_irreversible:'direct';paid:'direct'};acknowledgePaid:true}){return runtime.send(projectId,{requestId:randomUUID(),text:'Correct parameters locally then request one 2K four-second video.',expectedSettingsRevision:testAgentExecution(await settings.get()).revision,...(policy?{policy}:{})});},
    async settle(runId:string){await runtime.drain();return runtime.get(projectId,runId);},
    async approve(snapshot:AgentTaskSnapshot){const step=snapshot.steps.find(step=>step.status==='awaiting_approval');assert.ok(step);const control={requestId:randomUUID(),expectedRevision:snapshot.run.revision,action:'approve' as const,stepId:step.id};await runtime.action(projectId,snapshot.run.id,control);await runtime.action(projectId,snapshot.run.id,control);},
    async tick(){worker??=startWorker(store,services,new Map());await worker.tick();},
  };
}
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: local feedback lets Mio correct parameters before one approval and one real-SDK video POST`,async t=>{
  const f=await runtimeFixture(t,protocol);let corrected=false;
  f.setScript(async function*(request){
    if(f.requests.length===2){yield {type:'done',output:f.output({...f.base,parameters:{...mixed}})};return;}
    if(f.requests.length===3){
      const body:unknown=JSON.parse(request.body);assert.ok(object(body));const history=protocol==='responses'?body.input:body.messages;assert.ok(Array.isArray(history));
      const results=history.flatMap(item=>{if(!object(item))return [];const text=protocol==='responses'?item.output:item.role==='tool'?item.content:undefined;if(typeof text!=='string')return [];try{return [JSON.parse(text) as unknown];}catch{return [];}}),feedback=findFeedback(results);assert.ok(feedback&&object(feedback.supported));
      assert.doesNotMatch(JSON.stringify(feedback),/SYNTHETIC_.*KEY|https?:\/\/|credentialRef/u);const allowed=feedback.supported.parameters;assert.ok(Array.isArray(allowed));
      const parameters=Object.fromEntries(Object.entries(mixed).filter(([field])=>allowed.includes(field)));assert.deepEqual(parameters,{resolution:'2K'});corrected=true;yield {type:'done',output:f.output({...f.base,parameters})};return;
    }
    yield {type:'done',output:f.output()};
  });
  const sent=await f.send(),waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(corrected,true);assert.equal(f.requests.length,3);assert.equal(f.posts.length,0);assert.equal(f.store.list('jobs',f.projectId).length,0);
  assert.equal(waiting.steps.filter(step=>step.kind==='tool'&&step.status==='rejected').length,1);assert.equal(waiting.steps.filter(step=>step.status==='awaiting_approval').length,1);
  await f.approve(waiting);const completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(f.store.list('jobs',f.projectId).length,1);
  await f.tick();await f.tick();assert.equal(f.posts.length,1);assert.equal(f.posts[0]!.url,'https://api.minimax.cn/v2/video_generation');assert.deepEqual(f.posts[0]!.body,{model:'MiniMax-H3',content:[{type:'text',text:'A synthetic blue cube rotates.'}],duration:4,resolution:'2K',ratio:'9:16'});
  const job=f.store.list('jobs',f.projectId)[0] as JobRecord;assert.equal(job.submissionCount,1);assert.equal(job.providerJobId,'one-original-video-task');assert.equal(f.requests.length,4);
});

for(const [protocol,scenario] of [['chat_completions','unsupported'],['responses','changed'],['chat_completions','unbound']] as const)test(`${protocol}: ${scenario} project aspect requires proof before Mio can request another confirmation`,async t=>{
  const f=await runtimeFixture(t,protocol,true);
  const format=async()=>timelineFormatResponseSchema.parse(await f.services.call('timeline.format.get',{projectId:f.projectId}));
  const setFrame=async(presetId:string)=>{
    const previous=await format();
    await f.services.call('timeline.format.set',{projectId:f.projectId,expectedProjectRevision:previous.projectRevision,expectedRevision:previous.timelineRevision,requestId:randomUUID(),presetId});
    return format();
  };
  const initial=scenario==='unsupported'?await setFrame('square_1080'):await format();
  const args={...f.base,parameters:{resolution:'2K'},aspectSource:{kind:'project',expectedTimelineRevision:initial.timelineRevision,aspectRatio:scenario==='unsupported'?'1:1':'9:16'}};
  f.setScript(async function*(){
    if(f.requests.length===2){yield {type:'done',output:f.output(args)};return;}
    if(scenario==='unsupported'){yield {type:'done',output:f.output({...args,aspectSource:{kind:'explicit',aspectRatio:'9:16'}})};return;}
    yield {type:'done',output:f.output()};
  });
  const sent=await f.send(),waiting=await f.settle(sent.run.id);
  assert.equal(waiting.run.status,'awaiting_approval');
  const approved=waiting.steps.find(step=>step.status==='awaiting_approval');assert.ok(approved);
  const changed=scenario==='changed'?await setFrame('landscape_1080'):null;
  if(scenario==='unbound')f.failExecute(new AppError('PROJECT_ASPECT_CHANGED','PRIVATE_PROVIDER_BODY',409,{requestId:randomUUID(),shotId:f.shot.id,projectId:f.projectId,projectAspectRatio:'16:9',timelineRevision:1,mutationOutcome:'not_applied'}));
  await f.approve(waiting);
  const done=await f.settle(sent.run.id),step=done.steps.find(item=>item.id===approved.id);assert.ok(step);
  assert.equal(f.store.list('jobs',f.projectId).length,0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get()?.n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM job_events').get()?.n,0);
  assert.equal(f.posts.length,0);
  if(scenario==='unbound'){
    assert.equal(done.run.status,'paused');assert.equal(done.run.pauseReason,'unknown_outcome');assert.equal(step.status,'unknown');
    assert.equal(f.requests.length,2);assert.equal(step.result,undefined);
  }else{
    assert.equal(done.run.status,scenario==='unsupported'?'awaiting_approval':'completed');assert.equal(step.status,'rejected');assert.equal(f.requests.length,3);
    if(scenario==='unsupported'){
      const correction=done.steps.find(item=>item.status==='awaiting_approval');assert.ok(correction);
      assert.notEqual(correction.id,step.id);assert.ok(object(correction.toolCall?.arguments));
      assert.deepEqual(correction.toolCall.arguments.aspectSource,{kind:'explicit',aspectRatio:'9:16'});
    }
    assert.ok(object(step.result)&&object(step.result.error));const error=step.result.error;
    assert.deepEqual(error,{message:error.message,mutationOutcome:'not_applied',...(changed?{code:'PROJECT_ASPECT_CHANGED',projectAspectRatio:'16:9',timelineRevision:changed.timelineRevision}:{code:'PROJECT_ASPECT_UNSUPPORTED',projectAspectRatio:'1:1',supportedAspectRatios:['9:16','16:9']})});
    const body:unknown=JSON.parse(f.requests[2]!);assert.ok(object(body));const history=protocol==='responses'?body.input:body.messages;assert.ok(Array.isArray(history));
    const continuation=history.find(item=>object(item)&&(protocol==='responses'?item.type==='function_call_output':item.role==='tool')&&String(item.output??item.content).includes(String(error.code)));
    assert.ok(object(continuation));assert.deepEqual(JSON.parse(String(continuation.output??continuation.content)),{error});
    assert.doesNotMatch(JSON.stringify(error),/providerId|shotId|requestId|projectId|MiniMax|SYNTHETIC/u);
  }
  assert.doesNotMatch(JSON.stringify(step.result??step.error),/PRIVATE_PROVIDER_BODY/u);
});

test('an incompatible project ratio requires a separate approval even in direct mode',async t=>{
  const f=await runtimeFixture(t,'chat_completions',true);
  const before=timelineFormatResponseSchema.parse(await f.services.call('timeline.format.get',{projectId:f.projectId}));
  await f.services.call('timeline.format.set',{projectId:f.projectId,expectedProjectRevision:before.projectRevision,expectedRevision:before.timelineRevision,requestId:randomUUID(),presetId:'square_1080'});
  const after=timelineFormatResponseSchema.parse(await f.services.call('timeline.format.get',{projectId:f.projectId}));
  const initial={...f.base,parameters:{resolution:'2K'},aspectSource:{kind:'project',expectedTimelineRevision:after.timelineRevision,aspectRatio:'1:1'}};
  const fallback={...initial,aspectSource:{kind:'explicit',aspectRatio:'9:16'}};
  f.setScript(async function*(){
    yield {type:'done',output:f.output(f.requests.length===2?initial:f.requests.length===3?fallback:undefined)};
  });
  const sent=await f.send({modes:{read_only:'direct',local_reversible:'direct',local_irreversible:'direct',paid:'direct'},acknowledgePaid:true});
  const waiting=await f.settle(sent.run.id);
  assert.equal(waiting.run.status,'awaiting_approval');
  assert.equal(waiting.steps.find(step=>step.status==='rejected')?.error?.code,'PROJECT_ASPECT_UNSUPPORTED');
  assert.deepEqual(waiting.steps.find(step=>step.status==='awaiting_approval')?.toolCall?.arguments,fallback);
  assert.equal(f.store.list('jobs',f.projectId).length,0);
  assert.equal(f.posts.length,0);
  await f.approve(waiting);
  const done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');
  assert.equal((f.store.list('jobs',f.projectId)[0] as JobRecord).snapshot.aspectRatio,'9:16');
  assert.equal(f.posts.length,0);
});

for(const protocol of ['chat_completions','responses'] as const){
  test(`${protocol}: parameter correction never reveals feedback for a foreign shot or host authority fields`,async t=>{
    for(const obstacle of ['foreign_shot','host_field'] as const)await t.test(obstacle,async t=>{
      const f=await runtimeFixture(t,protocol);let args:Record<string,unknown>={...f.base,parameters:{...mixed}};
      if(obstacle==='foreign_shot'){
        // Another project's shot lives in that project's own store: this project has no such shot.
        const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-parameter-feedback-other-'))),store=openStore(root),services=createServices(store,new Map());t.after(()=>rm(root,{recursive:true,force:true}));
        try{const project=await services.call('project.create',{name:'PRIVATE_OTHER_PROJECT'});assert.ok(object(project));const shot=await services.call('shot.create',{projectId:project.id,title:'PRIVATE_OTHER_SHOT'});assert.ok(object(shot));args={...args,shotId:shot.id};}
        finally{await services.drain();store.close();}
      }else args={...args,apiKey:'PRIVATE_FORBIDDEN_KEY'};
      f.setScript(async function*(){yield {type:'done',output:f.output(args)};});
      const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(f.requests.length,2);assert.equal(f.posts.length,0);assert.equal(f.store.list('jobs',f.projectId).length,0);assert.equal(done.steps.some(step=>step.status==='awaiting_approval'),false);
      const toolResults=done.steps.filter(step=>step.kind==='tool').map(step=>({result:step.result,error:step.error}));
      assert.equal(findFeedback(toolResults),null);assert.doesNotMatch(JSON.stringify(toolResults),/PRIVATE_OTHER_PROJECT|PRIVATE_OTHER_SHOT|PRIVATE_FORBIDDEN_KEY/u);
    });
  });
  test(`${protocol}: a validation-shaped error after dispatch remains unknown and cannot trigger parameter correction`,async t=>{
    const f=await runtimeFixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:f.output({...f.base,parameters:{resolution:'2K'}})};});
    const sent=await f.send(),waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');f.failExecute(new AppError('VALIDATION_ERROR','PRIVATE_PROVIDER_BODY',400,{message:'PRIVATE_PROVIDER_KEY',mutationOutcome:'uncertain'}));
    await f.approve(waiting);const done=await f.settle(sent.run.id);assert.equal(done.run.status,'paused');assert.equal(done.run.pauseReason,'unknown_outcome');assert.equal(done.steps.some(step=>step.status==='unknown'),true);assert.equal(f.requests.length,2);assert.equal(f.posts.length,0);assert.equal(findFeedback(done.steps.map(step=>step.result)),null);assert.doesNotMatch(JSON.stringify(done),/PRIVATE_PROVIDER_BODY|PRIVATE_PROVIDER_KEY/u);
  });
}
