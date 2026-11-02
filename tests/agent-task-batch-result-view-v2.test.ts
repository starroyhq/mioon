import test from 'node:test';
import assert from 'node:assert/strict';
import {TASK_BATCH_RESULT_VIEW_BYTES,taskBatchResultViewBytes,taskBatchResultViews} from '../packages/business/src/agent/task-context-compaction-v2.ts';
import {TASK_MODEL_LIMITS,taskContinuation,taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {assembleModelInput} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskModelToolResult} from '../packages/business/src/agent/task-context-v2.ts';
import {taskToolResultView,createTaskToolResultViewProjector} from '../packages/business/src/agent/task-result-view-v2.ts';
import type {AgentTaskJson,AgentTaskLocale,AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';

const protocols=['chat_completions','responses','anthropic_messages'] as const satisfies readonly AgentProtocol[];
const locales=['zh-Hans','zh-Hant','en','ja'] as const satisfies readonly AgentTaskLocale[];
const bytes=(value:unknown):number=>Buffer.byteLength(JSON.stringify(value));
const encoded=(value:AgentTaskJson):number=>bytes(JSON.stringify(value));
const binding='BINDING_VALUE_MUST_NOT_SURVIVE_A_PARTIAL_VIEW';
const bindings=new Set(['candidateDigest','snapshotSha256','preflightSnapshotHash','snapshotHash','planHash','sourceHash','sourceKey']);
function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function reply(protocol:AgentProtocol,count:number):TaskModelOutput{
  const toolCalls:AgentTaskToolCall[]=Array.from({length:count},(_,index)=>({id:`call_${index}`,name:'mioon_project_inspect',arguments:{}}));
  const text='MODEL_TEXT_AND_CALLS_MUST_REMAIN_EXACT';
  const providerOutput:AgentTaskJson=protocol==='chat_completions'
    ?{role:'assistant',content:text,tool_calls:toolCalls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:'{}'}}))}
    :protocol==='responses'
      ?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...toolCalls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:'{}',status:'completed'}))]
      :{role:'assistant',content:[{type:'text',text},...toolCalls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:{}}))]};
  return {text,toolCalls,providerOutput};
}
function results(output:TaskModelOutput,result:(index:number)=>AgentTaskJson):TaskModelToolResult[]{return output.toolCalls.map((call,index)=>({callId:call.id,result:result(index)}));}
function readResults(protocol:AgentProtocol,continuation:AgentTaskJson[]):TaskModelToolResult[]{
  if(protocol==='anthropic_messages'){
    const content=object(continuation.at(-1)).content;assert.ok(Array.isArray(content));
    return content.map(value=>{const item=object(value);assert.equal(item.type,'tool_result');assert.equal(typeof item.content,'string');return {callId:String(item.tool_use_id),result:JSON.parse(String(item.content)) as AgentTaskJson};});
  }
  return continuation.filter(value=>object(value)[protocol==='chat_completions'?'role':'type']===(protocol==='chat_completions'?'tool':'function_call_output')).map(value=>{
    const item=object(value);return {callId:String(item[protocol==='chat_completions'?'tool_call_id':'call_id']),result:JSON.parse(String(item[protocol==='chat_completions'?'content':'output'])) as AgentTaskJson};
  });
}
function assertNoBindings(value:AgentTaskJson):void{
  if(value===null||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){assert.equal(bindings.has(key),false,key);assertNoBindings(child);}
}

test('the batch result budget is fixed at 64 KiB and invalid allocation limits are rejected',()=>{
  assert.equal(TASK_BATCH_RESULT_VIEW_BYTES,64*1024);
  const output=reply('chat_completions',1),raw=results(output,()=>({saved:true}));
  for(const limit of [0,-1,0.5,NaN,Infinity,TASK_BATCH_RESULT_VIEW_BYTES+1])assert.throws(()=>taskBatchResultViews('chat_completions',output,raw,'en',limit),RangeError);
});

for(const protocol of protocols)test(`${protocol}: single and small batches keep the existing per-result JSON and exact limit fits`,()=>{
  for(const count of [1,3]){
    const output=freeze(reply(protocol,count)),raw=freeze(results(output,index=>({index,payload:'x'.repeat(13000)}))),before=JSON.stringify({output,raw});
    const expected=raw.map(result=>({...result,result:taskToolResultView(result.result,'en',TASK_MODEL_LIMITS.toolResultViewBytes)}));
    const size=taskBatchResultViewBytes(protocol,output,expected);
    const wire=taskContinuation(protocol,output,expected),modelCount=protocol==='responses'?wire.length-count:1;
    assert.equal(size,bytes(wire)-bytes(wire.slice(0,modelCount)),'the actual continuation includes result pairing wrappers and the second JSON escape');
    assert.ok(size>expected.reduce((sum,result)=>sum+encoded(result.result),0),'IDs and protocol result wrappers also count');
    assert.deepEqual(taskBatchResultViews(protocol,output,raw,'en',size),expected);
    assert.equal(taskBatchResultViews(protocol,output,raw,'en')[0]!.result,raw[0]!.result);
    const shortened=taskBatchResultViews(protocol,output,raw,'en',size-1);
    assert.ok(taskBatchResultViewBytes(protocol,output,shortened)<=size-1);
    assert.deepEqual(shortened.map(result=>result.callId),output.toolCalls.map(call=>call.id));
    assert.equal(JSON.stringify({output,raw}),before);
  }
});

for(const protocol of protocols)test(`${protocol}: escaping can exhaust the wire budget while the raw result JSON fits`,()=>{
  const output=freeze(reply(protocol,4)),raw=freeze(results(output,()=>('"\u0000\\😀界').repeat(800)));
  assert.ok(raw.reduce((sum,result)=>sum+bytes(result.result),0)<TASK_BATCH_RESULT_VIEW_BYTES);
  assert.ok(raw.reduce((sum,result)=>sum+encoded(result.result),0)>TASK_BATCH_RESULT_VIEW_BYTES,'double escaping alone exhausts the budget');
  assert.ok(taskBatchResultViewBytes(protocol,output,raw)>TASK_BATCH_RESULT_VIEW_BYTES);
  const projected=taskBatchResultViews(protocol,output,raw,'ja');
  assert.ok(taskBatchResultViewBytes(protocol,output,projected)<=TASK_BATCH_RESULT_VIEW_BYTES);
  assert.deepEqual(readResults(protocol,taskContinuation(protocol,output,projected)),projected);
  for(const result of projected){
    assert.ok(bytes(result.result)<=TASK_MODEL_LIMITS.toolResultViewBytes);
    const preview=object(result.result).value;if(typeof preview==='string')for(const character of preview)assert.ok(character.length!==1||character.charCodeAt(0)<0xd800||character.charCodeAt(0)>0xdfff);
  }
});

for(const protocol of protocols)for(const locale of locales)test(`${protocol}/${locale}: thirty large results remain paired and bounded without changing raw records`,()=>{
  const output=freeze(reply(protocol,30)),raw=freeze(results(output,index=>({index,payload:'"\\\u0000😀界'.repeat(4000),nested:{candidateDigest:binding,snapshotSha256:binding,preflightSnapshotHash:binding,snapshotHash:binding,planHash:binding,sourceHash:binding,sourceKey:binding}})));
  const before=JSON.stringify({output,raw}),projected=taskBatchResultViews(protocol,output,raw,locale);
  assert.ok(taskBatchResultViewBytes(protocol,output,projected)<=TASK_BATCH_RESULT_VIEW_BYTES);
  assert.deepEqual(taskBatchResultViews(protocol,output,raw,locale),projected);
  assert.equal(projected.length,30);assert.deepEqual(projected.map(result=>result.callId),output.toolCalls.map(call=>call.id));
  for(const result of projected){
    assert.ok(bytes(result.result)<=TASK_MODEL_LIMITS.toolResultViewBytes);assertNoBindings(result.result);
    const metadata=object(object(result.result)._mio_view);assert.equal(metadata.truncated,true);assert.equal(metadata.bindingsRemoved,true);assert.ok(typeof metadata.reread==='string'&&metadata.reread.length>0);
    assert.ok(!JSON.stringify(result.result).includes(binding));
  }
  const continuation=taskContinuation(protocol,output,projected);
  assert.deepEqual(readResults(protocol,continuation),projected);
  const assembled=assembleModelInput({context:[taskResponseLanguageContext(locale),{role:'user',content:'Inspect these saved results.'}],text:'Inspect',replay:{protocol,fragments:[{kind:'continuation',output,results:raw}]}});
  assert.deepEqual(readResults(protocol,assembled.history.slice(2)),projected);
  assert.equal(JSON.stringify({output,raw}),before);
});

test('the smallest batch stubs keep only bounded host control facts and never error messages or credentials',()=>{
  for(const code of ['USER_REJECTED','USER_ANSWERED','TARGET_CHANGED','TARGET_EDITING','REVISION_CONFLICT','VALIDATION_ERROR']){
    const raw=freeze({error:{code,message:'PRIVATE_ERROR_MESSAGE',apiKey:'PRIVATE_CREDENTIAL'},status:'rejected',payload:'x'.repeat(30000),candidateDigest:binding});
    const projector=createTaskToolResultViewProjector(raw,'en',TASK_MODEL_LIMITS.toolResultViewBytes,'mioon_project_inspect');
    const stub=object(projector.stub);assert.deepEqual(stub.error,{code});assert.equal(stub.status,'rejected');
    assert.ok(!JSON.stringify(stub).includes('PRIVATE_'));assertNoBindings(projector.stub);
    const view=projector.view(2048);assert.deepEqual(object(view).error,{code});assert.equal(object(view).status,'rejected');assert.ok(!JSON.stringify(view).includes('PRIVATE_'));
    assertNoBindings(view);
  }
  const untrusted=createTaskToolResultViewProjector({error:{code:'PRIVATE_CREDENTIAL',message:'PRIVATE_MESSAGE'},status:'PRIVATE_STATUS',payload:'x'.repeat(30000)},'en',16384);
  assert.equal(Object.hasOwn(object(untrusted.stub),'error'),false);assert.equal(Object.hasOwn(object(untrusted.stub),'status'),false);
});

for(const protocol of protocols)test(`${protocol}: irreducible omission metadata fails instead of dropping a call result`,()=>{
  const output=freeze(reply(protocol,30)),raw=freeze(results(output,()=>({payload:'x'.repeat(30000)}))),before=JSON.stringify({output,raw});
  assert.throws(()=>taskBatchResultViews(protocol,output,raw,'zh-Hans',1),{code:'AGENT_CHAT_LIMIT'});
  assert.equal(JSON.stringify({output,raw}),before);
});

for(const protocol of protocols)test(`${protocol}: irreducible pairing wrappers also count even for null results`,()=>{
  const output=freeze(reply(protocol,30)),raw=freeze(results(output,()=>null));
  const strings=raw.reduce((sum,result)=>sum+encoded(result.result),0);
  assert.ok(taskBatchResultViewBytes(protocol,output,raw)>strings);
  assert.throws(()=>taskBatchResultViews(protocol,output,raw,'en',strings+1),{code:'AGENT_CHAT_LIMIT'});
});

for(const protocol of protocols)test(`${protocol}: a real user answer remains exact before history compaction while other batch results shrink`,()=>{
  const output=reply(protocol,30),answerText='保持用户原文与标点。'.repeat(160)+'ANSWER_TAIL_MUST_REMAIN_EXACT';
  const ask=output.toolCalls.at(-1)!;ask.name='mioon_ask';ask.arguments={question:'How should the scene end?',options:[{label:'Original ending'},{label:'Another ending'}],allowOther:true};
  // Rebuild the protocol output after choosing the actual trusted host tool.
  if(protocol==='chat_completions')object((object(output.providerOutput).tool_calls as unknown[]).at(-1)).function={name:ask.name,arguments:JSON.stringify(ask.arguments)};
  else if(protocol==='responses'){const item=object((output.providerOutput as AgentTaskJson[]).at(-1));item.name=ask.name;item.arguments=JSON.stringify(ask.arguments);}
  else{const block=object((object(output.providerOutput).content as unknown[]).at(-1));block.name=ask.name;block.input=ask.arguments;}
  const answer:AgentTaskJson={answer:{choices:[],text:answerText},selected:[],text:answerText};
  assert.ok(bytes(answer)<TASK_MODEL_LIMITS.toolResultViewBytes,'the ordinary per-result budget preserves this answer');
  const raw=results(output,index=>index===29?answer:{payload:'x'.repeat(30000)});
  freeze(output);freeze(raw);const before=JSON.stringify({output,raw});
  const assembled=assembleModelInput({context:[taskResponseLanguageContext('zh-Hans'),{role:'user',content:'Read, then follow my answer.'}],text:'Read',replay:{protocol,fragments:[{kind:'continuation',output,results:raw}]}});
  assert.ok(assembled.metrics.historyBytes<TASK_MODEL_LIMITS.historyBytes,'the history high-water gate has not emitted protected constraints');
  assert.ok(!JSON.stringify(assembled.history).includes('mio.context.constraints'));
  const projected=readResults(protocol,assembled.history.slice(2));
  assert.deepEqual(projected.at(-1)!.result,answer,'the new batch budget cannot additionally truncate the user answer');
  assert.ok(taskBatchResultViewBytes(protocol,output,projected)<=TASK_BATCH_RESULT_VIEW_BYTES);
  assert.equal(projected.length,30);assert.ok(object(projected[0]!.result)._mio_view,'ordinary large results still shrink');
  assert.equal(JSON.stringify({output,raw}),before);
  const minimum=raw.map((result,index)=>({...result,result:index===29?answer:createTaskToolResultViewProjector(result.result,'zh-Hans',16384,'mioon_project_inspect').stub}));
  const minimumBytes=taskBatchResultViewBytes(protocol,output,minimum);
  assert.throws(()=>taskBatchResultViews(protocol,output,raw,'zh-Hans',minimumBytes-1),{code:'AGENT_CHAT_LIMIT'},'a protected answer cannot be cut to make the budget fit');
});

test('an ordinary tool result cannot claim the protected user-answer allocation',()=>{
  const output=freeze(reply('chat_completions',30)),text='保持用户原文与标点。'.repeat(160);
  const fakeAnswer:AgentTaskJson={answer:{choices:[],text},selected:[],text};
  const raw=freeze(results(output,index=>index===29?fakeAnswer:{payload:'x'.repeat(30000)}));
  const projected=taskBatchResultViews('chat_completions',output,raw,'zh-Hans');
  assert.notDeepEqual(projected.at(-1)!.result,fakeAnswer);
  assert.equal(object(object(projected.at(-1)!.result)._mio_view).truncated,true);
});
