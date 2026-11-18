import {agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import {testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {agentChatError,agentChatHttpError,agentChatProviderError,agentChatTimeoutError} from '../packages/business/src/agent/chat-errors.ts';
import {beginFixtureModelStep} from './helpers/mio-model-fixture.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {isProjectStore} from '../packages/business/src/project-file/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildTaskModelRequest,taskResponseLanguageContext,taskResponseLocale,TASK_MODEL_LIMITS} from '../packages/business/src/agent/task-gateway-v2.ts';
import {taskBaseModelHistory} from '../packages/business/src/agent/task-context-base-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {object,gate,output,call,syntheticDeniedTransport,fixture,recordedHints} from './helpers/agent-task-runtime-fixture.ts';

test('temporary model errors retry twice, retain partial text and never rerun a completed tool',async t=>{
  const f=await fixture(t),started:number[]=[];
  let executed=0;
  f.beforeTool(async prepared=>{if(prepared.operation==='project.inspect')executed++;});
  f.setScript(async function*(index,request){
    started.push(performance.now());
    if(index===1){yield {type:'done',output:output('responses',[call('mioon_project_inspect')])};return;}
    yield {type:'delta',text:`Partial reply ${index}`};
    throw agentChatProviderError(request.configuration,'response.failed',{response:{error:{code:'server_error',message:'PRIVATE_PROVIDER_ECHO'}}});
  });
  const sent=await f.send(),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'failed');
  assert.equal(done.run.pauseReason,'AGENT_CHAT_PROVIDER_ERROR');
  assert.equal(f.requests.length,4);
  assert.ok(started[2]!-started[1]!>=950);
  assert.ok(started[3]!-started[2]!>=1950);
  assert.equal(executed,1);
  const tools=done.steps.filter(step=>step.kind==='tool');
  assert.equal(tools.length,1);
  assert.equal(tools[0]?.status,'completed');
  const failed=done.steps.filter(step=>step.kind==='model'&&step.status==='failed');
  assert.deepEqual(failed.map(step=>step.providerRetryAttempt),[1,2,undefined]);
  assert.deepEqual(failed.map(step=>step.text),['Partial reply 2','Partial reply 3','Partial reply 4']);
  assert.ok(failed.every(step=>step.error?.diagnostic?.kind==='provider'&&step.error.diagnostic.reason==='server'));
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_PROVIDER_ECHO/u);
  assert.deepEqual(f.requests.slice(1).map(request=>request.body),Array(3).fill(f.requests[1]!.body));
  const replay=await f.send('执行测试',sent.run.requestId);
  assert.equal(replay.run.id,sent.run.id);
  assert.equal(executed,1);
  assert.equal(f.requests.length,4);
});

test('a hard quota failure remains a single model attempt with its cause',async t=>{
  const f=await fixture(t);
  f.setScript(async function*(_index,request){
    throw agentChatProviderError(request.configuration,'error',{type:'error',code:'insufficient_quota'});
  });
  const sent=await f.send(),done=await f.settle(sent.run.id);
  assert.equal(f.requests.length,1);
  assert.equal(done.run.status,'failed');
  assert.equal(done.steps[0]?.providerRetryAttempt,undefined);
  assert.deepEqual(done.steps[0]?.error?.diagnostic,{kind:'provider',reason:'quota',event:'error',code:'insufficient_quota'});
});

test('a provider Retry-After beyond the automatic wait budget keeps a resolvable failure',async t=>{
  const f=await fixture(t);
  f.setScript(async function*(_index,request){
    throw agentChatHttpError(429,Buffer.from(JSON.stringify({error:{code:'rate_limit_exceeded'}})),request.configuration,'60');
  });
  const sent=await f.send(),done=await f.settle(sent.run.id);
  assert.equal(f.requests.length,1);
  assert.equal(done.run.status,'failed');
  assert.equal(done.steps[0]?.providerRetryAttempt,undefined);
  assert.deepEqual(done.steps[0]?.error?.diagnostic,{kind:'http',status:429,providerCode:'rate_limit_exceeded',
    provider:{kind:'provider',reason:'rate_limit',code:'rate_limit_exceeded'}});
});

test('stopping during a recorded model retry backoff prevents another dispatch',async t=>{
  const f=await fixture(t);
  f.setScript(async function*(_index,request){
    throw agentChatHttpError(503,undefined,request.configuration,'5');
  });
  const sent=await f.send();
  let snapshot=f.runtime.get(f.projectId,sent.run.id);
  const deadline=Date.now()+2000;
  while(Date.now()<deadline&&snapshot.steps.at(-1)?.providerRetryAttempt!==1){
    await delay(5);
    snapshot=f.runtime.get(f.projectId,sent.run.id);
  }
  assert.equal(snapshot.steps.at(-1)?.providerRetryAttempt,1);
  await f.action(snapshot,'stop');
  assert.equal((await f.settle(sent.run.id)).run.status,'stopped');
  assert.equal(f.requests.length,1);
  assert.equal(f.effects.size,0);
});

test('timeout phase and elapsed time persist on the failed model step across restart',async t=>{
  const f=await fixture(t);
  f.setScript(async function*(){
    throw agentChatTimeoutError('first_byte',90180);
  });
  const sent=await f.send(),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'failed');
  assert.equal(done.run.pauseReason,'AGENT_CHAT_TIMEOUT');
  assert.equal(f.requests.length,1);
  const diagnostic={kind:'timeout',phase:'first_byte',elapsedMs:90180};
  assert.deepEqual(done.steps[0]?.error?.diagnostic,diagnostic);
  f.restart();
  assert.deepEqual(f.runtime.get(f.projectId,sent.run.id).steps[0]?.error?.diagnostic,diagnostic);
  assert.equal(f.requests.length,1);
});

test('all classified Chat Completions stream failures persist safe diagnostics, execute no tools and never replay',async t=>{
  const frame=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`,finish=(reason:string)=>frame({choices:[{index:0,delta:{},finish_reason:reason}]});
  for(const reason of ['missing_done','missing_finish','unframed_sse','output_limit','read_failed'] as const){
    await t.test(reason,async t=>{
    const f=await fixture(t,'chat_completions'),argumentsJson=JSON.stringify({shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'PRIVATE_TOOL_ARGUMENT'}});
    const prefix=frame({choices:[{index:0,delta:{content:'预备',tool_calls:[{index:0,id:'private_call',type:'function',function:{name:'mioon_shot_update',arguments:argumentsJson}}]},finish_reason:null}]});
    const wire=prefix+(reason==='missing_done'?finish('tool_calls'):reason==='missing_finish'?'data: [DONE]\n\n':reason==='unframed_sse'?finish('tool_calls')+'data: [DONE]':reason==='output_limit'?finish('length')+'data: [DONE]\n\n':'');
    const transport=syntheticDeniedTransport('8.8.8.8',200,wire,reason==='read_failed');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
    const sent=await f.send(),done=await f.settle(sent.run.id),model=done.steps[0]!;
    assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_TRUNCATED');assert.equal(done.steps.length,1);assert.equal(model.status,'failed');assert.equal(model.error?.code,'AGENT_CHAT_TRUNCATED');
    assert.ok(model.error!.message.includes(`流终止诊断：${reason}`));assert.match(model.error!.message,/工具数 1/u);assert.match(model.error!.message,/输出字节 6/u);
    assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id).filter(event=>event.type==='error')}),/PRIVATE_TOOL_ARGUMENT|PRIVATE_PROVIDER_READ_FAILURE|mioon_shot_update|private_call/u);
    assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
    f.restart();const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.error?.message,model.error?.message);await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.effects.size,0);
    });
  }
});
test('forged stream diagnostics and provider causes never reach persisted task error messages',async t=>{
  const f=await fixture(t,'chat_completions');f.setScript(async function*(){throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_TRUNCATED',reason:'missing_done',streamEvidence:{reason:'read_failed'},state:{finishReason:'PRIVATE_KEY'},cause:{reason:'output_limit'}});});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.message,'任务未完成，请检查已保存记录。');assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)}),/PRIVATE_PROVIDER_BODY|PRIVATE_KEY|missing_done|read_failed|output_limit/u);assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);
});
for(const [failure,status] of [['AGENT_CHAT_OUTPUT_LIMIT',413],['AGENT_CHAT_RESPONSES_INCOMPLETE',502],['AGENT_CHAT_RESPONSES_ITEM_UNSUPPORTED',422]] as const)test(`Responses ${failure} is an observed failure, not an unknown result, and retries only by explicit control`,async t=>{
  const f=await fixture(t,'responses');
  const before=[f.store.get('shots',f.first.id),f.store.get('shots',f.other.id)];
  f.setScript(async function*(){throw Object.assign(new Error('PRIVATE_UNSUPPORTED_RESPONSE'),{code:failure,status});});
  const sent=await f.send(),done=await f.settle(sent.run.id),model=done.steps[0]!;
  assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,failure);
  assert.equal(done.steps.length,1);assert.equal(model.kind,'model');assert.equal(model.status,'failed');assert.equal(model.error?.code,failure);
  assert.equal(model.error?.message,agentChatError(failure).message,'The accurate bounded model failure survives runtime and journal persistence');
  assert.equal(done.steps.some(step=>step.status==='unknown'),false);
  assert.ok(isProjectStore(f.store));const records=createMioRecords(f.store),request=records.request(records.step(model.id).currentRequestId!);
  assert.equal(request.state,'failed');assert.equal(request.originalBody,f.requests[0]!.body);assert.ok(request.dispatchStartedAt);
  assert.equal(recordedHints(f,sent.run.id,'dispatch_prevented').length,0,'The model request was dispatched before its output was rejected');
  assert.deepEqual([f.store.get('shots',f.first.id),f.store.get('shots',f.other.id)],before);
  assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);assert.equal(f.requests.length,1);
  assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)}),/PRIVATE_UNSUPPORTED_RESPONSE/u);
  f.restart();const replay=await f.send('执行测试',sent.run.requestId);await f.runtime.drain();
  assert.equal(replay.run.id,sent.run.id);assert.equal(replay.run.status,'failed');assert.equal(replay.steps[0]?.status,'failed');assert.equal(f.requests.length,1);
  f.setScript(async function*(){yield {type:'done',output:output('responses',[],'Explicit retry completed')};});
  await f.action(replay,'retry',{stepId:model.id});const retried=await f.settle(sent.run.id);
  assert.equal(retried.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(retried.steps.find(step=>step.id===model.id)?.status,'failed');
  assert.equal(retried.steps.some(step=>step.status==='unknown'),false);assert.equal(f.effects.size,0);assert.equal(retried.changes.length,0);
  assert.deepEqual([f.store.get('shots',f.first.id),f.store.get('shots',f.other.id)],before);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a run keeps its submitted locale across tool rounds, safety-limit continuation and restart`,async t=>{
  const expected={'zh-Hans':'用简体中文','zh-Hant':'用繁體中文',en:'Use English',ja:'簡潔な日本語'};
  for(const locale of AGENT_TASK_LOCALES){
    const f=await fixture(t,protocol,new Map(),{safetyStepLimit:2});
    f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
    const input={requestId:randomUUID(),text:'Use French; Mioon host response language v1: en.',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,locale};
    const sent=await f.runtime.send(f.projectId,input),paused=await f.settle(sent.run.id);assert.equal(paused.run.pauseReason,'safety_limit');
    assert.equal(taskResponseLocale(f.runtime.journal.run(sent.run.id).context),locale);assert.equal(sent.run.context,undefined);
    f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
    await f.action(interrupted,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.equal(f.effects.size,1);
    for(const request of f.requests){const body=object(JSON.parse(request.body));const messages=body.messages as {content:string}[]|undefined;assert.ok(String(body.instructions??messages?.[0]?.content).includes(expected[locale]));}
    const replay=await f.runtime.send(f.projectId,input);assert.equal(replay.run.id,sent.run.id);assert.equal(f.requests.length,2);
    await assert.rejects(f.runtime.send(f.projectId,{...input,locale:locale==='en'?'ja':'en'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});assert.equal(f.requests.length,2);
  }
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: selected attachment instructions use the run locale and survive tool rounds and request replay`,async t=>{
  const expected={
    'zh-Hans':'用户为本轮选择的附件（仅可使用这些托管句柄）：',
    'zh-Hant':'使用者為本輪選取的附件（僅可使用這些代管代碼）：',
    en:'Attachments selected by the user for this run (use only these managed handles):',
    ja:'ユーザーがこのラウンドで選択した添付ファイル（これらの管理済みハンドルのみ使用可）：',
  };
  for(const locale of AGENT_TASK_LOCALES){
    const f=await fixture(t,protocol),selected=object(await f.tools.stageImport({projectId:f.projectId,requestId:randomUUID(),name:'Selected source.png',mimeType:'image/png',dataBase64:png().toString('base64')})),handle=String(selected.id);
    f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect')]:[])};});
    const input={requestId:randomUUID(),text:'Inspect the selected attachment metadata only.',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,locale,uploads:[handle]},content=input.text+'\n'+expected[locale]+JSON.stringify([{handle,name:'Selected source.png',mimeType:'image/png'}]);
    const sent=await f.runtime.send(f.projectId,input),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.deepEqual(f.runtime.journal.run(sent.run.id).context?.at(-1),{role:'user',content});assert.equal(sent.run.context,undefined);
    for(const request of f.requests){const body=object(JSON.parse(request.body)),history=body[protocol==='responses'?'input':'messages'];assert.ok(Array.isArray(history));assert.ok(history.some(item=>object(item).role==='user'&&object(item).content===content));}
    f.restart();assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);assert.equal(f.requests.length,2);assert.deepEqual(f.runtime.journal.run(sent.run.id).context?.at(-1),{role:'user',content});
  }
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a tool explanation survives approval and restart without entering business arguments or results`,async t=>{
  const f=await fixture(t,protocol),caption='Update the shot description',args={shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'approved description'}},planned=call('mioon_shot_update',args),executed:Record<string,unknown>[]=[];
  f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
  f.beforeTool(async prepared=>{if(prepared.operation==='tools.load')return;executed.push(structuredClone(prepared.input));});
  f.setScript(async function*(index){
    if(index!==1){yield {type:'done',output:output(protocol)};return;}
    // The protocol gateway retains provider output for its explanation while
    // stripping the host-only presentation field from executable arguments.
    // Its dual-protocol wire stripping is covered by the gateway integration.
    const retained=output(protocol,[{...planned,arguments:{...args,_mio_step:caption}}]);retained.toolCalls=[planned];yield {type:'done',output:retained};
  },{loadGroups:['canvas']});
  const sent=await f.send(),waiting=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const original=waiting.steps.find(step=>step.kind==='tool'&&step.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(original);
  assert.equal(original.status,'awaiting_approval');assert.equal(original.text,caption);assert.deepEqual(original.toolCall?.arguments,args);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(executed.length,0);
  f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.steps.find(step=>step.id===original.id)?.text,caption);assert.equal(f.requests.length,(1)+f.loadingRequests);
  await f.action(interrupted,'resume');const approval=await f.wait(sent.run.id,['awaiting_approval']);await f.runtime.drain();const restored=approval.steps.find(step=>step.id===original.id);assert.ok(restored);assert.equal(restored.text,caption);assert.equal(restored.status,'awaiting_approval');assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
  await f.action(approval,'approve',{stepId:original.id});const done=await f.settle(sent.run.id),completed=done.steps.find(step=>step.id===original.id);assert.ok(completed);assert.equal(done.run.status,'completed');assert.equal(completed.status,'completed');assert.equal(completed.text,caption);assert.deepEqual(completed.toolCall?.arguments,args);assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(executed.length,1);assert.deepEqual(executed[0],args);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'approved description');
  assert.doesNotMatch(JSON.stringify({prepared:executed[0],tool:completed.toolCall,result:completed.result,savedTool:f.runtime.journal.step(original.id),business:f.store.get('shots',f.first.id)}),/_mio_step/u);
  f.restart();const stable=f.runtime.get(f.projectId,sent.run.id);assert.equal(stable.steps.find(step=>step.id===original.id)?.text,caption);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.effects.size,(1)+f.loadingEffects);
});
test('omitted locale and explicit Simplified Chinese replay the same run; invalid locale never creates a request',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),text:'English user content does not choose the response language',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision};
  const sent=await f.runtime.send(f.projectId,input);await f.settle(sent.run.id);
  assert.equal((await f.runtime.send(f.projectId,{...input,locale:'zh-Hans'})).run.id,sent.run.id);
  for(const locale of [null,'','EN','zh-CN','fr',{},1])await assert.rejects(f.runtime.send(f.projectId,{...input,requestId:randomUUID(),locale}),{code:'AGENT_TASK_INVALID'});
  assert.equal(f.requests.length,1);assert.equal(f.runtime.journal.list(f.projectId).length,1);
});
test('a legacy locale receipt survives an old retained context without the host marker',async t=>{
  const f=await fixture(t,'responses',new Map()),input={requestId:randomUUID(),text:'Legacy retained context',expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision};
  // A real native v1 request can retain context without the later host marker.
  const settings=await f.settings.get(),context:AgentTaskJson[]=[{role:'user',content:input.text}],created=f.runtime.journal.create({projectId:f.projectId,requestId:input.requestId,text:input.text,settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,configuration:testAgentExecution(settings).configuration as unknown as AgentTaskJson,context});
  f.runtime.journal.beginModelStep(created.run.id,{request:{body:buildTaskModelRequest(testAgentExecution(settings).configuration,context,[],4318),history:context},data:{baseline:[]}},[]);
  f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const sent=await f.settle(created.run.id);
  f.restart();assert.equal((await f.runtime.send(f.projectId,input)).run.id,sent.run.id);assert.equal((await f.runtime.send(f.projectId,{...input,locale:'zh-Hans'})).run.id,sent.run.id);assert.equal(f.requests.length,1);
});
test('history byte trimming keeps the exact host language and final user message without inheriting an earlier locale',async t=>{
  const f=await fixture(t);f.setScript(async function*(){yield {type:'done',output:output('responses',[],'x'.repeat(50000))};});
  let conversationId:string|undefined;for(let index=0;index<4;index++){const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'previous '+index+' '+('x'.repeat(28000)),expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,locale:'en',...(conversationId?{conversationId}:{})});conversationId=sent.run.conversationId;await f.settle(sent.run.id);}
  const text='現在の指示',sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text,expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision,locale:'ja',conversationId});await f.settle(sent.run.id);
  const context=f.runtime.journal.run(sent.run.id).context!;assert.deepEqual(context[0],taskResponseLanguageContext('ja'));assert.deepEqual(context.at(-1),{role:'user',content:text});assert.ok(Buffer.byteLength(JSON.stringify(taskBaseModelHistory(context)))<=TASK_MODEL_LIMITS.historyBytes);assert.ok(context.length<10);assert.equal(taskResponseLocale(context),'ja');
});
test('resuming a legacy model intent sends its original journaled body without rewriting language',async t=>{
  const f=await fixture(t),settings=await f.settings.get(),context=[{role:'user',content:'legacy request'}];
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'legacy request',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,context});
  const body=object(JSON.parse(buildTaskModelRequest(testAgentExecution(settings).configuration,context,[],4318)));body.instructions='旧版固定中文指令';const original=JSON.stringify(body);
  const step=f.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history:context},data:{baseline:[]}},[]);
  f.restart();const interrupted=f.runtime.get(f.projectId,created.run.id);assert.equal(interrupted.run.status,'interrupted');assert.equal(interrupted.steps[0]!.status,'intent');
  await f.action(interrupted,'resume');const done=await f.settle(created.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.body,original);assert.equal(object(f.runtime.journal.step(step.id).request).body,original);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: an unsent intent bypasses reassembly even when retained base context cannot fit`,async t=>{
  const f=await fixture(t,protocol),settings=await f.settings.get(),history=[{role:'user',content:'Retained request before the assembler upgrade.'}];
  const original=buildTaskModelRequest(testAgentExecution(settings).configuration,history,[],4318),context=[taskResponseLanguageContext('en'),{role:'user',content:'x'.repeat(TASK_MODEL_LIMITS.historyBytes+1)}];
  const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Retained request before the assembler upgrade.',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,context});
  const model=f.runtime.journal.beginModelStep(created.run.id,{request:{body:original,history},data:{baseline:[]}},[]),frozen=structuredClone(model.request);
  f.restart();await f.action(f.runtime.get(f.projectId,created.run.id),'resume');const done=await f.settle(created.run.id);
  assert.equal(done.run.status,'completed');assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.body,original);
  assert.deepEqual(f.runtime.journal.step(model.id).request,frozen);assert.deepEqual(f.runtime.journal.run(created.run.id).context,context);
  assert.equal(done.run.stepsUsed,1);assert.deepEqual(done.run.notes,[]);assert.equal(f.effects.size,0);
});
test('retained continuation is validated before a later historical model can execute its tool batch',async t=>{
 const f=await fixture(t,'responses',new Map()),settings=await f.settings.get(),context=[taskResponseLanguageContext('en'),{role:'user',content:'Resume recorded work.'}],body=buildTaskModelRequest(testAgentExecution(settings).configuration,context,f.tools.list(),4318);
 const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'Resume recorded work.',configuration:{...testAgentExecution(settings).configuration},settingsRevision:testAgentExecution(settings).revision,settingsBinding:testAgentExecution(settings).binding,context});
 const first=beginFixtureModelStep(f.runtime.journal,created.run.id);first.complete('Earlier observed output');
 f.runtime.journal.updateStep(created.run.id,first.step.id,{data:{baseline:[],noteContinuationRequested:true}});
 const edit=call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Must not execute after invalid history'}}),second=beginFixtureModelStep(f.runtime.journal,created.run.id,[edit]);second.complete();
 const records=createMioRecords(f.store),entryId=records.step(first.step.id).resultEntryId;assert.ok(entryId);
 const trigger=f.store.db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='immutable_mio_entries'").get()!.sql;assert.equal(typeof trigger,'string');
 const original=f.store.db.prepare('SELECT payloadJson FROM mio_entries WHERE id=?').get(entryId)!.payloadJson;assert.equal(typeof original,'string');
 f.store.db.exec('DROP TRIGGER main.immutable_mio_entries');
 try{f.store.db.prepare('UPDATE mio_entries SET payloadJson=? WHERE id=?').run('{"invalidRetainedResponse":true}',entryId);}finally{f.store.db.exec(String(trigger));}
 try{
  f.restart();assert.throws(()=>f.runtime.get(f.projectId,created.run.id),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
  assert.equal(f.requests.length,0);assert.equal(f.effects.size,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_changes WHERE runId=?').get(created.run.id)!.n,0);
  assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM mio_steps WHERE runId=? AND kind='tool'").get(created.run.id)!.n,0);
 }finally{
  // Restore only this explicit fault so fixture shutdown never leaves a guard
  // removed or a bad immutable source available to another test.
  f.store.db.exec('DROP TRIGGER main.immutable_mio_entries');try{f.store.db.prepare('UPDATE mio_entries SET payloadJson=? WHERE id=?').run(String(original),entryId);}finally{f.store.db.exec(String(trigger));}
 }
});
for(const protocol of ['chat_completions','responses'] as const){
 test(`${protocol}: a trusted DNS denial records prevented dispatch and never becomes an unknown model result`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('198.18.10.207');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_NETWORK_DENIED');
  assert.equal(done.steps.length,1);const model=done.steps[0]!;assert.equal(model.kind,'model');assert.equal(model.status,'failed');assert.equal(model.error?.code,'AGENT_CHAT_NETWORK_DENIED');assert.equal(done.steps.some(step=>step.status==='unknown'),false);
  assert.equal(object(f.runtime.journal.step(model.id).data).dispatchPrevented,true);assert.ok(isProjectStore(f.store));const records=createMioRecords(f.store),request=records.request(records.step(model.id).currentRequestId!);assert.equal(request.state,'failed');assert.equal(request.originalBody,f.requests[0]!.body);assert.ok(request.dispatchStartedAt);assert.ok(f.runtime.journal.events(sent.run.id).every(event=>event.type==='invalidate'&&event.data===null));
  assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();assert.equal(f.runtime.lookup(f.projectId,sent.run.requestId).snapshot?.run.status,'failed');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'failed');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:0,ends:0});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: a provider HTTP error after request end is a recorded failure without automatic replay`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8');f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_CHAT_HTTP_ERROR');assert.equal(done.steps.length,1);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.code,'AGENT_CHAT_HTTP_ERROR');
  assert.match(done.steps[0]!.error!.message,/HTTP 401/u);assert.deepEqual(recordedHints(f,sent.run.id,'error'),[{code:'AGENT_CHAT_HTTP_ERROR',message:done.steps[0]!.error!.message}]);
  assert.equal(recordedHints(f,sent.run.id,'dispatch_prevented').length,0);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);assert.equal(done.changes.length,0);
  f.restart();const found=f.runtime.lookup(f.projectId,sent.run.requestId);assert.equal(found.snapshot?.steps[0]?.status,'failed');const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.status,'failed');
  await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.effects.size,0);
 });
 test(`${protocol}: arbitrary provider exception fields never become persisted HTTP diagnostics`,async t=>{
  const f=await fixture(t,protocol);f.setScript(async function*(){throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{code:'AGENT_CHAT_HTTP_ERROR',httpStatus:401,statusCode:403,headers:{authorization:'PRIVATE_KEY'}});});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.steps[0]?.status,'failed');assert.equal(done.steps[0]?.error?.message,'任务未完成，请检查已保存记录。');
  const serialized=JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)});assert.doesNotMatch(serialized,/PRIVATE_PROVIDER_BODY|PRIVATE_KEY|HTTP 401|HTTP 403/u);assert.equal(f.requests.length,1);
 });
 test(`${protocol}: HTTP 400 persists only fixed parameter hints and keeps the original failed request`,async t=>{
  const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',400,JSON.stringify({error:{message:'Invalid function schema for tools[0].function.parameters: PRIVATE_PROVIDER_BODY PRIVATE_KEY',param:'tools'}}));f.setScript(async function*(_index,request){yield*transport.gateway(request);});
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.steps[0]?.status,'failed');const message=done.steps[0]!.error!.message;assert.match(message,/HTTP 400/u);assert.match(message,/参数提示/u);assert.match(message,/tools/u);
  assert.doesNotMatch(JSON.stringify({done,events:f.runtime.journal.events(sent.run.id)}),/PRIVATE_PROVIDER_BODY|PRIVATE_KEY/u);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
  f.restart();const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(replay.steps[0]?.error?.message,message);await f.runtime.drain();assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});assert.equal(f.requests.length,1);assert.equal(f.effects.size,0);
 });
 test(`${protocol}: desktop broker pins snapshot, send and credential acquisition to the live backend port`,async t=>{
  const f=await fixture(t,protocol,new Map(),{desktopBridge:true});assert.ok(f.bridge);
  const project=await f.runtime.snapshot(f.projectId);assert.equal(project.projectId,f.projectId);assert.equal(testAgentExecution(project.settings).secret.configured,true);assert.deepEqual(project.runs,[]);
  assert.ok(!JSON.stringify(project).includes('SYNTHETIC_LOCAL_TEST_ONLY'));
  const sent=await f.send('仅回复连接正常'),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed');assert.equal(done.steps.length,1);assert.equal(done.steps[0]?.kind,'model');assert.equal(done.steps[0]?.status,'completed');assert.equal(done.changes.length,0);assert.equal(f.effects.size,0);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0]?.apiKey,'SYNTHETIC_LOCAL_TEST_ONLY');assert.equal(f.requests[0]?.selfPort,4318);
  assert.deepEqual(f.bridge.requests,[{operation:'get',selfPort:4318},{operation:'get',selfPort:4318},{operation:'get',selfPort:4318},{operation:'acquire',selfPort:4318}]);
 });
 test(`${protocol}: multiple tools and model rounds execute sequentially and replay never repeats`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[call('mioon_project_inspect'),call('mioon_shot_inspect',{limit:2})]:index===2?[call('mioon_timeline_inspect')]:[])};});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.requests.length,3);assert.equal(f.effects.size,3);assert.equal(done.steps.length,6);const replay=await f.send('执行测试',sent.run.requestId);assert.equal(replay.run.id,sent.run.id);assert.equal(f.effects.size,3);assert.match(f.requests[1].body,protocol==='responses'?/function_call_output/:/tool_call_id/);f.restart();assert.equal(f.requests.length,3);assert.equal(f.effects.size,3);});
 test(`${protocol}: revocation after first done prevents every tool and continuation`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_project_inspect')])};await f.revoke();});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);});
 test(`${protocol}: revocation after durable tool intent prevents actual read and continuation`,async t=>{const f=await fixture(t,protocol);f.setScript(async function*(){yield {type:'done',output:output(protocol,[call('mioon_project_inspect')])};});f.beforeTool(async()=>{const intent=f.store.db.prepare("SELECT status FROM mio_steps WHERE kind='tool'").get();assert.equal(intent?.status,'dispatch_started');await f.revoke();});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_TASK_CONSENT_REQUIRED');assert.equal(f.effects.size,0);assert.equal(f.requests.length,1);assert.ok(done.steps.some(step=>step.kind==='tool'));});
}

for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: explicit retry starts a new model step after proven unsent failure and keeps its budget and receipt`,async t=>{
 const f=await fixture(t,protocol),transport=syntheticDeniedTransport('198.18.10.207');f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;assert.equal(failed.run.status,'failed');assert.equal(step.status,'failed');
 const control={requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id};await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.action(f.projectId,sent.run.id,control);const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.id,failed.run.id);assert.equal(done.run.budget,failed.run.budget);assert.equal(done.run.stepsUsed,2);assert.equal(f.requests.length,2);assert.notEqual(done.steps[1]!.id,step.id);assert.equal(done.steps[0]!.status,'failed');assert.equal(done.steps[1]!.status,'completed');assert.equal(done.executionEndedAt,done.run.updatedAt);
 f.restart();await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();assert.equal(f.requests.length,2);assert.equal(f.runtime.lookupAction(f.projectId,sent.run.id,control.requestId).receipt?.action,'retry');await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...control,stepId:randomUUID()}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
});
for(const protocol of ['chat_completions','responses'] as const)for(const statusCode of [422,429] as const)test(`${protocol}: HTTP ${statusCode} after sending is a failure retried only on explicit request`,async t=>{
 const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',statusCode);f.setScript(async function*(index,request){if(index===1){yield*transport.gateway(request);return;}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;
 assert.equal(failed.run.status,'failed');assert.equal(step.kind,'model');assert.equal(step.status,'failed');assert.equal(step.error?.code,'AGENT_CHAT_HTTP_ERROR');assert.match(step.error!.message,new RegExp(`HTTP ${statusCode}`,'u'));assert.equal(failed.steps.some(item=>item.status==='unknown'),false);
 await f.runtime.drain();assert.equal(f.requests.length,1);assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
 await f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.budget,failed.run.budget);assert.equal(done.run.stepsUsed,2);assert.equal(f.requests.length,2);assert.equal(done.steps[0]!.status,'failed');assert.equal(done.steps[0]!.error?.code,'AGENT_CHAT_HTTP_ERROR');assert.equal(done.steps[1]!.status,'completed');assert.equal(f.effects.size,0);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a trusted OpenAI HTTP 500 records the failed attempt before automatic retry`,async t=>{
 const f=await fixture(t,protocol),transport=syntheticDeniedTransport('8.8.8.8',500);
 f.setScript(async function*(index,request){
   if(index===1){yield*transport.gateway(request);return;}
   yield {type:'done',output:output(protocol,[],'Automatic retry completed')};
 });
 const sent=await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');
 assert.deepEqual(done.steps.map(step=>step.status),['failed','completed']);
 assert.equal(done.steps[0]?.error?.code,'AGENT_CHAT_HTTP_ERROR');
 assert.match(done.steps[0]!.error!.message,/HTTP 500/u);
 assert.equal(done.steps[0]?.providerRetryAttempt,1);
 assert.equal(done.run.stepsUsed,2);
 assert.equal(f.requests.length,2);
 assert.equal(f.requests[1]?.body,f.requests[0]?.body);
 assert.deepEqual(transport.counts,{dns:1,requests:1,ends:1});
 assert.equal(f.effects.size,0);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: a timeout after partial text records a failure and the retry does not feed that text back`,async t=>{
 // Below 8 KiB: a failure must flush received text before recording its status.
 const partial='PARTIAL_REPLY_BEFORE_TIMEOUT '.repeat(100);
 const f=await fixture(t,protocol);f.setScript(async function*(index){if(index===1){yield {type:'delta',text:partial};throw Object.assign(new Error('timeout'),{code:'AGENT_CHAT_TIMEOUT'});}yield {type:'done',output:output(protocol,[],'Retry completed')};});
 const sent=await f.send(),failed=await f.settle(sent.run.id),step=failed.steps.at(-1)!;
 assert.equal(failed.run.status,'failed');assert.equal(step.status,'failed');assert.equal(step.error?.code,'AGENT_CHAT_TIMEOUT');assert.equal(step.text,partial);
 await f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:failed.run.revision,action:'retry',stepId:step.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.doesNotMatch(f.requests[1]!.body,/PARTIAL_REPLY_BEFORE_TIMEOUT/u);assert.equal(done.steps[0]!.text,partial);assert.equal(done.steps[1]!.status,'completed');
});
test('an unclassified exception during a model request still keeps the unknown rule',async t=>{
 const f=await fixture(t);f.setScript(async function*(){throw new Error('unclassified gateway failure');});
 const sent=await f.send(),done=await f.settle(sent.run.id),step=done.steps.at(-1)!;
 assert.equal(step.status,'unknown');await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{requestId:randomUUID(),expectedRevision:done.run.revision,action:'retry',stepId:step.id}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.equal(f.requests.length,1);
});

for(const changed of ['other','active-key','selection-aba'] as const)test(`connection witness: ${changed} between model requests preserves isolation`,async t=>{
 const f=await fixture(t),entered=gate(),release=gate();
 f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect')]:[])};});
 const sent=await f.send();await entered.promise;
 const old=await f.settings.get(),services=old.services.map(agentServiceInput);
 if(changed==='selection-aba'){
  await f.settings.put({expectedRevision:old.revision,services,mioSelection:{serviceKey:'ollama',modelId:'qwen3:8b'},secretActions:[]});
  await f.settings.put({expectedRevision:(await f.settings.get()).revision,services,mioSelection:old.mioSelection,secretActions:[]});
 }else await f.settings.put({expectedRevision:old.revision,services,mioSelection:old.mioSelection,secretActions:[{serviceKey:changed==='other'?'deepseek':'openai',action:'replace',storage:'persistent',value:'SYNTHETIC_UPDATED_ENTRY_KEY'}]});
 release.resolve();const done=await f.settle(sent.run.id);
 if(changed==='other'){assert.equal(done.run.status,'completed');assert.equal(f.requests.length,2);assert.ok(f.requests.every(request=>request.apiKey==='SYNTHETIC_LOCAL_TEST_ONLY'));}
 else{assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_SETTINGS_CONFLICT');assert.equal(f.requests.length,1);}
});

test('an old frozen run without an entry witness cannot be re-signed from current settings',async t=>{
 const f=await fixture(t),execution=testAgentExecution(await f.settings.get());
 const created=f.runtime.journal.create({projectId:f.projectId,requestId:randomUUID(),text:'legacy unsigned intent',configuration:{...execution.configuration},settingsRevision:execution.revision,context:[{role:'user',content:'legacy unsigned intent'}]});
 f.restart();const restored=f.runtime.get(f.projectId,created.run.id);assert.equal(restored.run.status,'interrupted');
 await f.action(restored,'resume');const failed=await f.settle(created.run.id);
 assert.equal(failed.run.status,'failed');assert.equal(failed.run.pauseReason,'AGENT_TASK_SETTINGS_CHANGED');assert.equal(f.requests.length,0);assert.equal(f.runtime.journal.run(created.run.id).settingsBinding,undefined);assert.deepEqual(failed.run.configuration,execution.configuration);
});
