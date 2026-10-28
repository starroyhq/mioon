import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleRunContext, assembleModelInput, cloneTaskBaseContext, replayModelContext, selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskContextPreviousRun, TaskModelContextFragment, TaskRunContextInput} from '../packages/business/src/agent/task-context-v2.ts';
import {TASK_MODEL_LIMITS, buildTaskModelRequest, taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput, TaskToolDefinition} from '../packages/business/src/agent/task-gateway-v2.ts';
import {anthropicMessages} from '../packages/business/src/agent/anthropic-wire.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskChange, AgentTaskJson, AgentTaskLocale, AgentTaskNote, AgentTaskSkippedTarget, AgentTaskStep, AgentTaskTier, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
const stamp = '2026-10-27T00:00:00.000Z';
const modelStepId = '00000000-0000-4000-8000-000000000001';
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function note(text: string, bound = false): AgentTaskNote {
  return {requestId: bound ? 'bound-note-request' : 'queued-note-request', text, createdAt: stamp, ...(bound ? {modelStepId} : {})};
}
function previous(text: string, reply: string, notes: AgentTaskNote[] = []): TaskContextPreviousRun {
  return {text, notes, steps: [{kind: 'model', status: 'completed', result: {text: reply}}]};
}
function configuration(protocol: AgentProtocol): AgentConfiguration {
  return {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
}
const tools: TaskToolDefinition[] = [
  {name: 'mioon_project_inspect', description: 'Inspect the current project.', parameters: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'mioon_shot_inspect', description: 'Inspect saved shots.', parameters: {type: 'object', properties: {limit: {type: 'integer', minimum: 1}}, additionalProperties: false}},
];
function output(protocol: AgentProtocol, calls: AgentTaskToolCall[]): TaskModelOutput {
  const text = 'Inspect both saved views.';
  const providerOutput: AgentTaskJson = protocol === 'anthropic_messages'
    ? {role: 'assistant', content: [{type: 'text', text}, ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]}
    : protocol === 'responses'
      ? [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}, ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'}))]
      : {role: 'assistant', content: text, tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))};
  return {text, toolCalls: calls, providerOutput};
}
function callResults(body: string, protocol: AgentProtocol): {calls: string[]; results: {id: string; value: unknown}[]} {
  const wire = object(JSON.parse(body)), history = wire[protocol === 'responses' ? 'input' : 'messages'];
  assert.ok(Array.isArray(history));
  if (protocol === 'anthropic_messages') anthropicMessages(history as AgentTaskJson[]);
  const calls: string[] = [], results: {id: string; value: unknown}[] = [];
  for (const item of history) {
    const row = object(item);
    if (protocol === 'chat_completions') {
      if (Array.isArray(row.tool_calls)) calls.push(...row.tool_calls.map(value => String(object(value).id)));
      if (row.role === 'tool') results.push({id: String(row.tool_call_id), value: JSON.parse(String(row.content))});
    } else if (protocol === 'responses') {
      if (row.type === 'function_call') calls.push(String(row.call_id));
      if (row.type === 'function_call_output') results.push({id: String(row.call_id), value: JSON.parse(String(row.output))});
    } else if (Array.isArray(row.content)) {
      for (const item of row.content) {
        const block = object(item);
        if (block.type === 'tool_use') calls.push(String(block.id));
        if (block.type === 'tool_result') results.push({id: String(block.tool_use_id), value: JSON.parse(String(block.content))});
      }
    }
  }
  return {calls, results};
}

test('run context trims an entire oldest round only after the serialized UTF-8 limit is exceeded', () => {
  const oldNote = note('旧'.repeat(10000), true), recentNote = note('Keep the selected range.', true);
  const marker = taskResponseLanguageContext('zh-Hans'), text = '本轮消息';
  const recent = previous('Recent request.', 'Recent reply.', [recentNote]);
  const emptyContext: AgentTaskJson[] = [marker, {role: 'user', content: 'Old request.'}, {role: 'user', content: oldNote.text}, {role: 'assistant', content: ''}, {role: 'user', content: recent.text}, {role: 'user', content: recentNote.text}, {role: 'assistant', content: 'Recent reply.'}, {role: 'user', content: text}];
  const reply = 'x'.repeat(TASK_MODEL_LIMITS.historyBytes - bytes(emptyContext));
  const exact = freeze<TaskRunContextInput>({locale: 'zh-Hans', text, previousRuns: [previous('Old request.', reply, [oldNote]), recent]});
  const savedExact = JSON.stringify(exact), full = assembleRunContext(exact);
  assert.equal(full.metrics.historyBytes, TASK_MODEL_LIMITS.historyBytes);
  assert.deepEqual(full.metrics, {historyBytes: TASK_MODEL_LIMITS.historyBytes, retainedRuns: 2, trimmedRuns: 0});
  assert.ok(JSON.stringify(full.context).length < TASK_MODEL_LIMITS.historyBytes, 'Character count cannot substitute for UTF-8 bytes');
  assert.equal(JSON.stringify(exact), savedExact);

  const overflow = freeze<TaskRunContextInput>({...exact, previousRuns: [previous('Old request.', reply + '界', [oldNote]), recent]});
  const before = JSON.stringify(overflow), trimmed = assembleRunContext(overflow);
  assert.deepEqual(trimmed.context, [marker, {role: 'user', content: recent.text}, {role: 'user', content: recentNote.text}, {role: 'assistant', content: 'Recent reply.'}, {role: 'user', content: text}]);
  assert.deepEqual(trimmed.metrics, {historyBytes: bytes(trimmed.context), retainedRuns: 1, trimmedRuns: 1});
  assert.equal(JSON.stringify(overflow), before);
  assert.deepEqual(assembleRunContext(overflow), trimmed);
});

test('an explicitly empty saved history is distinct from missing legacy context', () => {
  assert.deepEqual(assembleModelInput({context: [], text: 'Do not reconstruct this saved history.'}).history, []);
  assert.deepEqual(assembleModelInput({text: 'Legacy user message.'}).history, [{role: 'user', content: 'Legacy user message.'}]);
});

for (const protocol of protocols) test(`${protocol}: frozen replay fragments preserve ordered multi-tool pairs and bind each note once`, () => {
  const calls: AgentTaskToolCall[] = [{id: 'first_read', name: tools[0]!.name, arguments: {}}, {id: 'second_read', name: tools[1]!.name, arguments: {limit: 2}}];
  const results = [{callId: calls[0]!.id, result: null}, {callId: calls[1]!.id, result: {shots: [{title: '镜头'}]}}];
  const source = freeze({context: [taskResponseLanguageContext('en'), {role: 'user', content: 'Read the saved project.'}], notes: [note('Bound before this reply.', true), note('Keep the original colours.')], tools, output: output(protocol, calls), results});
  const before = JSON.stringify(source);
  const fragments = [replayModelContext(protocol, {kind: 'notes', notes: source.notes, modelStepId}), replayModelContext(protocol, {kind: 'continuation', output: source.output, results: source.results})];
  const input = {context: source.context, text: 'Ignored fallback.', fragments, notes: source.notes, tools: source.tools};
  const first = assembleModelInput(input), second = assembleModelInput(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(first.pendingNotes, [source.notes[1]]);
  assert.equal(first.history.filter(value => object(value).content === source.notes[0]!.text).length, 1);
  assert.equal(first.history.filter(value => object(value).content === source.notes[1]!.text).length, 1);
  assert.deepEqual(first.metrics, {historyBytes: bytes(first.history), toolCount: tools.length});
  const body = buildTaskModelRequest(configuration(protocol), first.history, first.tools);
  const paired = callResults(body, protocol);
  assert.deepEqual(paired.calls, calls.map(call => call.id));
  assert.deepEqual(paired.results, results.map(result => ({id: result.callId, value: result.result})));
});

for (const protocol of protocols) test(`${protocol}: a capacity probe counts supplied persisted text without changing frozen history or notes`, () => {
  const source = freeze({context: [taskResponseLanguageContext('en'), {role: 'user', content: 'Saved request.'}, {role: 'assistant', content: 'h'.repeat(TASK_MODEL_LIMITS.historyBytes - 512)}], notes: [note('Already in the saved request.', true), note('Queued after the request.')]});
  const before = JSON.stringify(source);
  const known = assembleModelInput({context: source.context, text: 'Do not replace the saved history.', notes: source.notes});
  assert.ok(known.metrics.historyBytes < TASK_MODEL_LIMITS.historyBytes);
  assert.doesNotThrow(() => buildTaskModelRequest(configuration(protocol), known.history, known.tools));
  const partial = replayModelContext(protocol, {kind: 'partial', text: 'p'.repeat(1024)});
  const withPersistedText = assembleModelInput({context: source.context, text: 'Do not replace the saved history.', fragments: [partial], notes: source.notes});
  assert.ok(withPersistedText.metrics.historyBytes > TASK_MODEL_LIMITS.historyBytes);
  assert.throws(() => buildTaskModelRequest(configuration(protocol), withPersistedText.history, withPersistedText.tools), {code: 'AGENT_CHAT_LIMIT'});
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(assembleModelInput({context: source.context, text: 'Do not replace the saved history.', notes: source.notes}), known);
});

test('catalog diagnostics retain host catalog order when their selected names arrive in reverse order', () => {
  const catalog = freeze<(TaskToolDefinition & {risk: AgentTaskTier})[]>([{...tools[0]!, risk: 'read_only'}, {name: 'mioon_shot_update', description: 'Update a shot.', parameters: {type: 'object', properties: {}}, risk: 'local_reversible'}, {...tools[1]!, risk: 'read_only'}]);
  const before = JSON.stringify(catalog), selected = selectTaskModelTools(catalog, {profile: 'catalog', toolNames: [catalog[2]!.name, catalog[0]!.name]});
  assert.deepEqual(selected.map(tool => tool.name), [catalog[0]!.name, catalog[2]!.name]);
  assert.equal(JSON.stringify(catalog), before);
});

const contextId=(index:number):string=>`00000000-0000-4000-8000-${index.toString(16).padStart(12,'0')}`;
const currentText='CURRENT_REQUEST_MUST_REMAIN_EXACT';
const isContextObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lateNoteText='KEEP_ALL_COLOURS_AND_THE_ORIGINAL_USER_NOTE';
const binding='SYNTHETIC_BINDING_MUST_NOT_SURVIVE_A_TRUNCATED_VIEW';
function largeOutput(protocol:AgentProtocol,index:number,calls:AgentTaskToolCall[],size=30*1024):TaskModelOutput{
  const text=`Complete reply ${index}: `+'m'.repeat(size);
  const providerOutput:AgentTaskJson=protocol==='chat_completions'
    ?{role:'assistant',content:text,tool_calls:calls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}))}
    :protocol==='responses'
      ?[{type:'message',role:'assistant',content:[{type:'output_text',text}]},...calls.map(call=>({type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments),status:'completed'}))]
      :{role:'assistant',content:[{type:'text',text},...calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.arguments}))]};
  return {text,toolCalls:calls,providerOutput};
}
function longContext(protocol:AgentProtocol,count:number,{locale='en',noteAt=6,replyBytes=30*1024}:{locale?:AgentTaskLocale;noteAt?:number;replyBytes?:number}={}){
  const activeNotes:AgentTaskNote[]=count<noteAt?[]:[{requestId:'late-note-request',text:lateNoteText,createdAt:stamp,...(count>noteAt?{modelStepId:contextId(100+noteAt)}:{})}];
  const fragments:TaskModelContextFragment[]=[],steps:AgentTaskStep[]=[];
  for(let index=0;index<count;index++){
    const modelId=contextId(100+index),calls:AgentTaskToolCall[]=Array.from({length:index===0?2:1},(_,callIndex)=>({id:`read_${index}_${callIndex}`,name:tools[0]!.name,arguments:{}}));
    const result:AgentTaskJson={payload:'result'.repeat(3500),candidateDigest:binding,identity:{snapshotSha256:binding}};
    const results=calls.map(call=>({callId:call.id,result})),reply=largeOutput(protocol,index,calls,replyBytes);
    const model:AgentTaskStep={id:modelId,runId:contextId(1),kind:'model',position:steps.length,status:'completed',createdAt:stamp,updatedAt:stamp,result:JSON.parse(JSON.stringify(reply)) as AgentTaskJson};
    steps.push(model);
    for(const call of calls)steps.push({id:contextId(1000+steps.length),runId:contextId(1),kind:'tool',position:steps.length,status:'completed',createdAt:stamp,updatedAt:stamp,toolCall:call,result,data:{sourceModelStepId:modelId},targets:[{kind:'project',id:contextId(2),revision:1}]});
    fragments.push({kind:'notes',notes:activeNotes,modelStepId:modelId},{kind:'continuation',modelStepId:modelId,output:reply,results});
  }
  return {context:[taskResponseLanguageContext(locale),{role:'user',content:currentText}] as AgentTaskJson[],text:currentText,notes:activeNotes,tools,replay:{protocol,fragments,steps}};
}
function hostData(history:AgentTaskJson[],kind:string):Record<string,unknown>|undefined{
  for(const item of history){
    if(!isContextObject(item)||item.role!=='user'||typeof item.content!=='string')continue;
    const newline=item.content.indexOf('\n');if(newline<0)continue;
    try{const value:unknown=JSON.parse(item.content.slice(newline+1));if(isContextObject(value)&&value.kind===kind)return object(value.data);}catch{/* Ordinary user/host prose is not a derived record. */}
  }
  return;
}

test('base-context clones never invoke compaction, even for an irreducible legacy context',()=>{
  const context:AgentTaskJson[]=[taskResponseLanguageContext('en'),{role:'user',content:'x'.repeat(TASK_MODEL_LIMITS.historyBytes+1)}],before=JSON.stringify(context);
  assert.deepEqual(cloneTaskBaseContext(context,'Ignored'),context);assert.equal(JSON.stringify(context),before);
  assert.deepEqual(cloneTaskBaseContext([],'No fallback'),[]);assert.deepEqual(cloneTaskBaseContext(undefined,'Fallback'),[{role:'user',content:'Fallback'}]);
});

for(const protocol of protocols)test(`${protocol}: semantic replay leaves every small request byte unchanged`,()=>{
  const calls:AgentTaskToolCall[]=[{id:'unchanged_read',name:tools[0]!.name,arguments:{}}],reply=output(protocol,calls),results=[{callId:calls[0]!.id,result:{saved:true}}];
  const context=[taskResponseLanguageContext('en'),{role:'user',content:'Read once.'}],notes=[note('Keep the note.')],fragment:TaskModelContextFragment={kind:'continuation',output:reply,results};
  const before=assembleModelInput({context,text:'Fallback',notes,tools,fragments:[replayModelContext(protocol,fragment)]});
  const after=assembleModelInput({context,text:'Fallback',notes,tools,replay:{protocol,fragments:[{kind:'notes',notes:[],modelStepId},fragment]}});
  assert.deepEqual(after,before);assert.equal(buildTaskModelRequest(configuration(protocol),after.history,after.tools),buildTaskModelRequest(configuration(protocol),before.history,before.tools));
});

for(const protocol of protocols)test(`${protocol}: thirty large rounds remain paired, deterministic and preserve a compacted prefix and later notes`,()=>{
  const histories:AgentTaskJson[][]=[];
  for(let count=0;count<=30;count++){
    const source=freeze(longContext(protocol,count)),saved=JSON.stringify(source),assembled=assembleModelInput(source);
    assert.deepEqual(assembleModelInput(source),assembled);assert.equal(JSON.stringify(source),saved);
    assert.ok(assembled.metrics.historyBytes<=TASK_MODEL_LIMITS.historyBytes);
    assert.deepEqual(assembled.history[0],taskResponseLanguageContext('en'));
    assert.equal(assembled.history.filter(item=>isContextObject(item)&&item.role==='user'&&item.content===currentText).length,1);
    assert.equal(assembled.history.filter(item=>isContextObject(item)&&item.role==='user'&&item.content===lateNoteText).length,count>=6?1:0);
    const body=buildTaskModelRequest(configuration(protocol),assembled.history,assembled.tools),paired=callResults(body,protocol);
    assert.deepEqual(paired.calls,paired.results.map(result=>result.id));assert.ok(!body.includes(binding));
    if(count){
      const last=source.replay.fragments.at(-1);assert.ok(last?.kind==='continuation');assert.ok(body.includes(last.output.text));
      for(const call of last.output.toolCalls){const result=paired.results.find(item=>item.id===call.id);assert.ok(result);assert.equal(object(object(result.value)._mio_view).truncated,true);assert.ok(Object.hasOwn(object(result.value),'value'),'The latest result keeps its view instead of becoming a stub');}
    }
    histories.push(assembled.history);
  }
  const first=histories.findIndex(history=>hostData(history,'mio.context.journal')!==undefined);
  assert.ok(first>0&&first+1<histories.length);
  assert.deepEqual(histories[first+1]!.slice(0,histories[first]!.length),histories[first]);
});

for(const protocol of protocols)test(`${protocol}: an oversized newest whole round keeps its exact output and fails the existing hard limit`,()=>{
  const source=freeze(longContext(protocol,1,{replyBytes:100*1024})),assembled=assembleModelInput(source),last=source.replay.fragments.at(-1);assert.ok(last?.kind==='continuation');
  assert.ok(assembled.metrics.historyBytes>TASK_MODEL_LIMITS.historyBytes);assert.ok(JSON.stringify(assembled.history).includes(last.output.text));
  assert.equal(hostData(assembled.history,'mio.context.journal'),undefined);
  assert.throws(()=>buildTaskModelRequest(configuration(protocol),assembled.history,assembled.tools),{code:'AGENT_CHAT_LIMIT'});
  if(protocol==='anthropic_messages')assert.doesNotThrow(()=>anthropicMessages(assembled.history));
  const paired=callResults(JSON.stringify({[protocol==='responses'?'input':'messages']:assembled.history}),protocol);
  assert.deepEqual(paired.calls,last.output.toolCalls.map(call=>call.id));assert.deepEqual(paired.results.map(result=>result.id),paired.calls);
});

for(const protocol of protocols)test(`${protocol}: late multi-target background Changes preserve the earlier compressed prefix until the next compaction`,()=>{
  const job={kind:'job',id:contextId(44),revision:1},asset={kind:'asset',id:contextId(45),revision:1};
  const source=(count:number,late=false)=>{
    const input=longContext(protocol,count,{noteAt:100});
    for(const model of input.replay.steps.filter(step=>step.kind==='model'))model.data={baseline:[job]};
    const tool=input.replay.steps.find(step=>step.kind==='tool');assert.ok(tool);
    const known:AgentTaskChange={id:contextId(7000),runId:contextId(1),projectId:contextId(2),stepId:tool.id,operation:'generation.submit',targets:[job],before:{},after:{},reversible:false,status:'applied',createdAt:stamp};
    const publication:AgentTaskChange={...known,id:contextId(7001),operation:'generation.publish',targets:[job,asset]};
    return {...input,replay:{...input.replay,changes:late?[known,publication]:[known]}};
  };
  let first=1;while(first<10&&!hostData(assembleModelInput(source(first)).history,'mio.context.journal'))first++;
  assert.ok(first<10);const before=assembleModelInput(source(first)),input=freeze(source(first+1,true)),saved=JSON.stringify(input),next=assembleModelInput(input);
  assert.equal(JSON.stringify(input),saved);assert.deepEqual(assembleModelInput(input),next);
  assert.ok(next.metrics.historyBytes<=TASK_MODEL_LIMITS.historyBytes);
  assert.deepEqual(next.history.slice(0,before.history.length),before.history);
  assert.ok(JSON.stringify(hostData(next.history,'mio.context.journal')).includes('generation.submit'));
  assert.ok(!JSON.stringify(hostData(next.history,'mio.context.journal')).includes('generation.publish'));
  // A later request's frozen snapshot knows both targets. At the next high
  // water crossing it may refresh the journal with that publication.
  const later=source(first+2,true),lastModel=later.replay.steps.filter(step=>step.kind==='model').at(-1);assert.ok(lastModel);
  lastModel.data={baseline:[job,asset]};const refreshed=assembleModelInput(freeze(later));
  assert.ok(JSON.stringify(hostData(refreshed.history,'mio.context.journal')).includes('generation.publish'));
  assert.deepEqual(callResults(buildTaskModelRequest(configuration(protocol),refreshed.history,refreshed.tools),protocol).calls,callResults(buildTaskModelRequest(configuration(protocol),refreshed.history,refreshed.tools),protocol).results.map(item=>item.id));
});

for(const protocol of protocols)test(`${protocol}: note-capacity views drop whole older conversations and retain known partial text exactly`,()=>{
  const source=longContext(protocol,0),partial='PERSISTED_PARTIAL_'+'r'.repeat(8192),notes=[note('CURRENT_NOTE_'+'n'.repeat(1024))];
  const context=[taskResponseLanguageContext('en'),...Array.from({length:3},(_,index)=>[{role:'user',content:`old ${index}: `+'u'.repeat(30000)},{role:'assistant',content:'a'.repeat(2000)}]).flat(),{role:'user',content:'c'.repeat(30000)}];
  const input=freeze({...source,context,notes,replay:{...source.replay,fragments:[{kind:'notes',notes:[],modelStepId},{kind:'partial',modelStepId,text:partial}] as TaskModelContextFragment[]}});
  const before=JSON.stringify(input),assembled=assembleModelInput(input);assert.equal(JSON.stringify(input),before);
  assert.ok(assembled.metrics.historyBytes<=TASK_MODEL_LIMITS.historyBytes);assert.deepEqual(assembled.history[0],context[0]);
  assert.equal(assembled.history.filter(item=>isContextObject(item)&&item.role==='user'&&item.content==='c'.repeat(30000)).length,1);
  assert.ok(JSON.stringify(assembled.history).includes(partial));assert.equal(assembled.history.filter(item=>isContextObject(item)&&item.content===notes[0]!.text).length,1);
  assert.ok(assembled.history.length<context.length+2);assert.doesNotThrow(()=>buildTaskModelRequest(configuration(protocol),assembled.history,assembled.tools));
});

for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const)test(`${locale}: compaction records preserve complete control facts as reference data`,()=>{
  const source=longContext('responses',6,{locale}),tool=source.replay.steps.find(step=>step.kind==='tool');assert.ok(tool);
  tool.status='rejected';tool.error={code:'USER_REJECTED',message:'User kept the target.'};
  const failed=source.replay.steps.filter(step=>step.kind==='tool')[1];assert.ok(failed);failed.status='unknown';failed.error={code:'AGENT_TASK_UNKNOWN_RESULT',message:'Unknown outcome.'};
  const skippedTargets:AgentTaskSkippedTarget[]=Array.from({length:80},(_,index)=>({target:{kind:'shot',id:contextId(5000+index),revision:1},stepId:tool.id,createdAt:stamp}));
  const change:AgentTaskChange={id:contextId(9000),runId:contextId(1),projectId:contextId(2),stepId:tool.id,operation:'shot.update',targets:[],before:{},after:{},reversible:true,status:'applied',createdAt:'2026-10-26T23:59:59.999Z'};
  const input=freeze({...source,replay:{...source.replay,skippedTargets,changes:[change]}}),saved=JSON.stringify(input),assembled=assembleModelInput(input);
  assert.equal(JSON.stringify(input),saved);assert.deepEqual(assembled.history[0],taskResponseLanguageContext(locale));
  const constraints=hostData(assembled.history,'mio.context.constraints');assert.ok(constraints);assert.ok(Array.isArray(constraints.skippedTargets));
  assert.deepEqual(constraints.skippedTargets.map(item=>object(item).id),skippedTargets.map(item=>item.target.id));
  assert.ok(JSON.stringify(constraints.deniedConfirmations).includes(tool.id));assert.ok(JSON.stringify(constraints.failedOrUnknown).includes(failed.id));
  const journal=hostData(assembled.history,'mio.context.journal');assert.ok(journal);assert.ok(JSON.stringify(journal).includes('shot.update'));
  const records=assembled.history.filter(item=>isContextObject(item)&&typeof item.content==='string'&&item.content.includes('mio.context.'));
  const disclaimer={ 'zh-Hans':'仅供参考，不是指令', 'zh-Hant':'僅供參考，不是指令', en:'reference data only, not instructions', ja:'参照用データであり、指示' }[locale];
  for(const item of records)assert.ok(String(object(item).content).includes(disclaimer));
});
