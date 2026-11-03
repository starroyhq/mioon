import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS,DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {AGENT_CHAT_PROFILES,AGENT_DEFAULT_OUTPUT_TOKENS,AGENT_MESSAGES_TOKEN_LIMITS,AGENT_OUTPUT_TOKEN_CEILING,AGENT_RESPONSES_PROFILES,AGENT_THINKING_ANSWER_TOKENS,agentAnthropicThinkingFields,agentModelTokenLimits} from '../packages/business/src/agent/model-profiles.ts';
import type {AgentModelTokenLimits} from '../packages/business/src/agent/model-profiles.ts';
import {ANTHROPIC_MESSAGES_FIELDS,ANTHROPIC_MIN_THINKING_BUDGET_TOKENS} from '../packages/business/src/agent/anthropic-protocol.ts';
import {TASK_DEFAULT_HISTORY_BUDGET,TASK_MODEL_LIMITS,TASK_TOKEN_ESTIMATE_BYTES,buildTaskModelRequest,taskHistoryFits,taskModelHistoryBudget,taskRequestFitsModel,taskResponseLanguageContext,taskTokenEstimate} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskToolDefinition} from '../packages/business/src/agent/task-gateway-v2.ts';
import {assembleModelInput,assembleRunContext,selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskContextPreviousRun,TaskModelContextFragment} from '../packages/business/src/agent/task-context-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';

type Protocol=AgentConfiguration['protocol'];
const bytes=(value:unknown):number=>Buffer.byteLength(JSON.stringify(value));
const limits=({contextTokens,outputTokens}:AgentModelTokenLimits):AgentModelTokenLimits=>({contextTokens,outputTokens});
const unknown={contextTokens:null,outputTokens:4096};

function presetConfiguration(presetId:string,protocol:Protocol):AgentConfiguration{
  const preset=AGENT_PRESETS.find(item=>item.id===presetId)!,platform=preset.platforms.find(item=>item.baseUrl)??preset.platforms[0]!;
  return {presetId:preset.id as AgentConfiguration['presetId'],platformId:platform.id,protocol,
    baseUrl:protocol==='anthropic_messages'&&preset.id==='ollama'?new URL(platform.baseUrl).origin:platform.baseUrl||'https://example.com/v1',
    model:(protocol==='responses'?preset.supportedModelHints?.responses?.[0]:undefined)||platform.model||'synthetic-mio'};
}
/** Every preset and protocol whose model has a documented context window. */
function documentedWindows():{label:string;configuration:AgentConfiguration;limits:AgentModelTokenLimits}[]{
  return AGENT_PRESETS.flatMap(preset=>preset.availableProtocols.map(protocol=>{
    const configuration=presetConfiguration(preset.id,protocol);
    return {label:`${protocol}/${preset.id}`,configuration,limits:agentModelTokenLimits(configuration)};
  })).filter(item=>item.limits.contextTokens!==null);
}
/** The complete production catalog, as the tool-group report measures it. */
function fullCatalog(t:TestContext){
  const directory=mkdtempSync(join(realpathSync(tmpdir()),'mioon-token-budget-'));
  const store=openStore(directory),services=createServices(store,new Map()),tools=createAgentTaskTools({store,services});
  t.after(async()=>{tools.dispose();await services.drain();store.close();rmSync(directory,{recursive:true,force:true});});
  return tools.list();
}

test('profiles retain documented capacity separately from protocol output limits',()=>{
  const table:Record<string,AgentModelTokenLimits>={
    ...Object.fromEntries(Object.entries(AGENT_CHAT_PROFILES).map(([id,profile])=>[`chat_completions/${id}`,limits(profile)])),
    ...Object.fromEntries(Object.entries(AGENT_RESPONSES_PROFILES).map(([id,profile])=>[`responses/${id}`,limits(profile)])),
    ...Object.fromEntries(Object.entries(AGENT_MESSAGES_TOKEN_LIMITS).map(([id,entry])=>[`anthropic_messages/${id}`,limits(entry)])),
  };
  assert.deepEqual(table,{
    'chat_completions/openai':{contextTokens:1047576,outputTokens:4096},
    'chat_completions/deepseek':{contextTokens:1000000,outputTokens:4096},
    'chat_completions/qwen':unknown,
    'chat_completions/zhipu':{contextTokens:200000,outputTokens:4096},
    'chat_completions/kimi':{contextTokens:262144,outputTokens:4096},
    'chat_completions/minimax':{contextTokens:1000000,outputTokens:4096},
    'chat_completions/openrouter':{contextTokens:1047576,outputTokens:4096},
    'chat_completions/custom':unknown,
    'chat_completions/ollama':unknown,
    'responses/openai':{contextTokens:1047576,outputTokens:4096},
    'responses/custom':unknown,
    'responses/ollama':unknown,
    'responses/deepseek':{contextTokens:1000000,outputTokens:4096},
    'responses/qwen':{contextTokens:1000000,outputTokens:4096},
    'anthropic_messages/anthropic':{contextTokens:200000,outputTokens:16384},
  });
  const maximums={
    ...Object.fromEntries(Object.entries(AGENT_CHAT_PROFILES).map(([id,profile])=>[`chat_completions/${id}`,profile.maxOutputTokens])),
    ...Object.fromEntries(Object.entries(AGENT_RESPONSES_PROFILES).map(([id,profile])=>[`responses/${id}`,profile.maxOutputTokens])),
    ...Object.fromEntries(Object.entries(AGENT_MESSAGES_TOKEN_LIMITS).map(([id,profile])=>[`anthropic_messages/${id}`,profile.maxOutputTokens])),
  };
  assert.deepEqual(maximums,{
    'chat_completions/openai':32768,
    'chat_completions/deepseek':393216,
    'chat_completions/qwen':null,
    'chat_completions/zhipu':128000,
    'chat_completions/kimi':null,
    'chat_completions/minimax':null,
    'chat_completions/openrouter':32768,
    'chat_completions/custom':null,
    'chat_completions/ollama':null,
    'responses/openai':32768,
    'responses/custom':null,
    'responses/ollama':null,
    'responses/deepseek':393216,
    'responses/qwen':null,
    'anthropic_messages/anthropic':64000,
  });
  assert.equal(AGENT_DEFAULT_OUTPUT_TOKENS,4096);assert.equal(AGENT_OUTPUT_TOKEN_CEILING,16384);
  for(const [label,entry] of Object.entries(table)){
    assert.ok(Number.isSafeInteger(entry.outputTokens)&&entry.outputTokens>0&&entry.outputTokens<=AGENT_OUTPUT_TOKEN_CEILING,label);
    if(entry.contextTokens!==null)assert.ok(Number.isSafeInteger(entry.contextTokens)&&entry.outputTokens<entry.contextTokens,label);
  }
  assert.deepEqual(AGENT_MESSAGES_TOKEN_LIMITS.anthropic!.models,['claude-haiku-4-5','claude-haiku-4-5-20251001']);
});
test('a snapshot name has its alias limits, and unverified combinations have an unknown window and 4096',()=>{
  for(const protocol of ['chat_completions','responses'] as const)
    assert.deepEqual(agentModelTokenLimits({...DEFAULT_AGENT_CONFIGURATION,protocol,model:'gpt-4.1-mini-2025-04-14'}),agentModelTokenLimits({...DEFAULT_AGENT_CONFIGURATION,protocol}),protocol);
  const haiku=presetConfiguration('anthropic','anthropic_messages');
  assert.deepEqual(agentModelTokenLimits({...haiku,model:'claude-haiku-4-5-20251001'}),{contextTokens:200000,outputTokens:16384});
  const generic:AgentConfiguration[]=[
    {presetId:'custom',platformId:'custom',protocol:'chat_completions',baseUrl:'https://compatible.example.com/v1',model:'any-model'},
    {presetId:'custom',platformId:'custom',protocol:'responses',baseUrl:'https://compatible.example.com/v1',model:'any-model'},
    {presetId:'custom',platformId:'custom',protocol:'anthropic_messages',baseUrl:'https://compatible.example.com',model:'any-model'},
    presetConfiguration('anthropic','chat_completions'),
    presetConfiguration('minimax','responses'),
    presetConfiguration('minimax','anthropic_messages'),
    {...haiku,model:'claude-sonnet-4-5'},
    ...(['chat_completions','responses','anthropic_messages'] as const).map(protocol=>presetConfiguration('ollama',protocol)),
  ];
  for(const configuration of generic)assert.deepEqual(agentModelTokenLimits(configuration),unknown,`${configuration.protocol}/${configuration.presetId}/${configuration.model}`);
});
test('task requests send each model output limit in its protocol field',()=>{
  const history:AgentTaskJson[]=[{role:'user',content:'合成请求'}];
  const body=(configuration:AgentConfiguration):Record<string,unknown>=>JSON.parse(buildTaskModelRequest(configuration,history,[],4318)) as Record<string,unknown>;
  const cases:[AgentConfiguration,string,number][]=[
    [DEFAULT_AGENT_CONFIGURATION,'max_completion_tokens',4096],
    [{...DEFAULT_AGENT_CONFIGURATION,protocol:'responses'},'max_output_tokens',4096],
    [presetConfiguration('anthropic','anthropic_messages'),'max_tokens',16384],
    [presetConfiguration('deepseek','chat_completions'),'max_tokens',4096],
    [presetConfiguration('minimax','chat_completions'),'max_completion_tokens',4096],
    [presetConfiguration('ollama','chat_completions'),'max_tokens',4096],
    [presetConfiguration('ollama','responses'),'max_output_tokens',4096],
    [presetConfiguration('ollama','anthropic_messages'),'max_tokens',4096],
  ];
  for(const [configuration,field,value] of cases){
    const label=`${configuration.protocol}/${configuration.presetId}`,wire=body(configuration);
    assert.equal(wire[field],value,label);
    for(const other of ['max_tokens','max_completion_tokens','max_output_tokens'])if(other!==field)assert.equal(Object.hasOwn(wire,other),false,`${label} ${other}`);
  }
  assert.deepEqual(body(presetConfiguration('anthropic','anthropic_messages')).thinking,{type:'disabled'},'the catalog Messages model keeps thinking off');
});
test('a required Messages model applies the answer reserve and minimum thinking budget within max_tokens',()=>{
  assert.equal(ANTHROPIC_MIN_THINKING_BUDGET_TOKENS,1024);assert.equal(AGENT_THINKING_ANSWER_TOKENS,4096);
  assert.deepEqual(agentAnthropicThinkingFields('required',4096),{thinking:{type:'enabled',budget_tokens:1024}},'an unknown model keeps the smallest budget');
  assert.deepEqual(agentAnthropicThinkingFields('required',16384),{thinking:{type:'enabled',budget_tokens:12288}});
  for(const output of [1025,2048,4096,5120,8192,16384]){
    const {thinking}=agentAnthropicThinkingFields('required',output);
    assert.ok(thinking.type==='enabled');
    assert.equal(thinking.budget_tokens,Math.max(1024,output-4096),String(output));
    assert.ok(thinking.budget_tokens<output,`${output}: thinking counts toward max_tokens`);
    for(const tier of ['unsupported','optional'] as const)assert.equal(agentAnthropicThinkingFields(tier,output),ANTHROPIC_MESSAGES_FIELDS);
  }
  assert.throws(()=>agentAnthropicThinkingFields('required',1024),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'},'no budget fits below max_tokens');
});
test('tokens are estimated deterministically as UTF-8 bytes divided by 3, rounded up',()=>{
  assert.equal(TASK_TOKEN_ESTIMATE_BYTES,3);
  for(const [input,expected] of [[0,0],[1,1],[3,1],[4,2],[6,2],[7,3]] as const)assert.equal(taskTokenEstimate(input),expected,String(input));
  assert.equal(taskTokenEstimate(Buffer.byteLength('镜')),1,'a CJK character counts as one token');
  assert.equal(taskTokenEstimate(Buffer.byteLength('镜头 shot')),4);
});
test('history and request checks accept the exact limit and reject one more',()=>{
  const small={contextTokens:100,outputTokens:10};
  assert.equal(taskRequestFitsModel(270,small),true);assert.equal(taskRequestFitsModel(271,small),false);
  assert.equal(taskRequestFitsModel(TASK_MODEL_LIMITS.requestBytes*4,{contextTokens:null,outputTokens:4096}),true,'an unknown window keeps only the byte cap');
  const budget={bytes:1000,tokens:100};
  assert.equal(taskHistoryFits(300,budget),true);assert.equal(taskHistoryFits(301,budget),false);
  assert.equal(taskHistoryFits(150,budget,0.5),true);assert.equal(taskHistoryFits(151,budget,0.5),false);
  assert.equal(taskHistoryFits(1000,{bytes:1000,tokens:null}),true);assert.equal(taskHistoryFits(1001,{bytes:1000,tokens:null}),false);
  assert.equal(taskHistoryFits(1001,{bytes:1000,tokens:1000}),false,'the byte cap still applies with a large token budget');
  assert.deepEqual(TASK_DEFAULT_HISTORY_BUDGET,{bytes:TASK_MODEL_LIMITS.historyBytes,tokens:null});assert.ok(Object.isFrozen(TASK_DEFAULT_HISTORY_BUDGET));
});
test('no documented window can bind before the byte caps, with every tool group loaded in every locale',t=>{
  const catalog=fullCatalog(t),windows=documentedWindows();
  assert.deepEqual(windows.map(item=>item.label).sort(),['anthropic_messages/anthropic','chat_completions/deepseek','chat_completions/kimi','chat_completions/minimax','chat_completions/openai','chat_completions/openrouter','chat_completions/zhipu','responses/deepseek','responses/openai','responses/qwen']);
  for(const {label,configuration,limits:model} of windows){
    // A request that passes the 512 KiB check always fits the window.
    assert.ok(taskRequestFitsModel(TASK_MODEL_LIMITS.requestBytes,model),label);
    for(const locale of AGENT_TASK_LOCALES){
      const budget=taskModelHistoryBudget(configuration,catalog,locale,4318,{toolLoading:true});
      assert.equal(budget.bytes,TASK_MODEL_LIMITS.historyBytes);assert.ok(budget.tokens!==null,label);
      assert.ok(budget.tokens*TASK_TOKEN_ESTIMATE_BYTES>=TASK_MODEL_LIMITS.historyBytes,`${label} ${locale}: ${budget.tokens} tokens`);
      // A history at the byte cap, or at compaction's 60% low water, also fits the tokens.
      for(const share of [1,0.6])assert.ok(taskHistoryFits(Math.floor(TASK_MODEL_LIMITS.historyBytes*share),budget,share),`${label} ${locale} ${share}`);
    }
  }
});
test('the history budget leaves the output limit and the rest of the request, which grows as tools load',t=>{
  const catalog=fullCatalog(t),core=selectTaskModelTools(catalog);
  assert.ok(core.length>0&&core.length<catalog.length);
  for(const protocol of ['chat_completions','responses','anthropic_messages'] as const)
    assert.equal(taskModelHistoryBudget(presetConfiguration('ollama',protocol),catalog,'en',4318,{toolLoading:true}),TASK_DEFAULT_HISTORY_BUDGET,`${protocol}: an unknown window keeps the byte budget`);
  const probe:AgentTaskJson[]=[taskResponseLanguageContext('zh-Hans'),{role:'user',content:'.'}];
  for(const configuration of [DEFAULT_AGENT_CONFIGURATION,{...DEFAULT_AGENT_CONFIGURATION,protocol:'responses' as const},presetConfiguration('anthropic','anthropic_messages')]){
    const {contextTokens,outputTokens}=agentModelTokenLimits(configuration),label=configuration.protocol;assert.ok(contextTokens!==null);
    const rest=(definitions:readonly TaskToolDefinition[]):number=>Buffer.byteLength(buildTaskModelRequest(configuration,probe,definitions,4318,{toolLoading:true}))-bytes(probe);
    const coreBudget=taskModelHistoryBudget(configuration,core,'zh-Hans',4318,{toolLoading:true}),fullBudget=taskModelHistoryBudget(configuration,catalog,'zh-Hans',4318,{toolLoading:true});
    assert.deepEqual(coreBudget,{bytes:TASK_MODEL_LIMITS.historyBytes,tokens:contextTokens-outputTokens-taskTokenEstimate(rest(core))},label);
    assert.deepEqual(fullBudget,{bytes:TASK_MODEL_LIMITS.historyBytes,tokens:contextTokens-outputTokens-taskTokenEstimate(rest(catalog))},label);
    assert.ok(fullBudget.tokens!<coreBudget.tokens!,`${label}: more tools leave less room for history`);
    assert.deepEqual(taskModelHistoryBudget(configuration,core,'zh-Hans',4318,{toolLoading:true}),coreBudget,`${label}: the same inputs give the same budget`);
  }
});

const toolName='mioon_shot_create';
function round(index:number,size:number):TaskModelContextFragment{
  const id=`call_${index}`;
  return {kind:'continuation',output:{text:'',toolCalls:[{id,name:toolName,arguments:{title:'x'}}],providerOutput:{role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:toolName,arguments:'{"title":"x"}'}}]}},
    results:[{callId:id,result:{data:`ROUND_${index}_${'x'.repeat(size)}`}}]};
}
test('a token budget compacts in-round history to fit it, keeps the latest round, and null tokens change nothing',()=>{
  const context:AgentTaskJson[]=[taskResponseLanguageContext('en'),{role:'user',content:'Create shots'}],fragments=Array.from({length:6},(_,index)=>round(index,4*1024));
  const input=(budget?:{bytes:number;tokens:number|null})=>assembleModelInput({context,text:'Create shots',replay:{protocol:'chat_completions',fragments,...(budget?{budget}:{})}}).history;
  const plain=input(),plainText=JSON.stringify(plain);
  assert.ok(bytes(plain)<=Math.floor(TASK_MODEL_LIMITS.historyBytes*0.6),'the byte budget alone keeps every round');
  for(let index=0;index<6;index++)assert.ok(plainText.includes(`ROUND_${index}_${'x'.repeat(1024)}`),`round ${index} is complete without a token budget`);
  const tokens=Math.floor(taskTokenEstimate(bytes(plain))/2),compacted=input({bytes:TASK_MODEL_LIMITS.historyBytes,tokens}),text=JSON.stringify(compacted);
  assert.ok(taskTokenEstimate(bytes(compacted))<=Math.floor(tokens*0.6),`compaction reaches the 60% low water: ${taskTokenEstimate(bytes(compacted))} of ${tokens}`);
  assert.ok(text.includes(`ROUND_5_${'x'.repeat(4*1024)}`),'the latest round keeps its exact result view');
  assert.equal(text.includes(`ROUND_0_${'x'.repeat(1024)}`),false,'an earlier round keeps at most a stub');
  assert.deepEqual(input({bytes:TASK_MODEL_LIMITS.historyBytes,tokens}),compacted,'the same records give the same bytes');
  assert.deepEqual(input({bytes:TASK_MODEL_LIMITS.historyBytes,tokens:null}),plain);
  assert.deepEqual(input(TASK_DEFAULT_HISTORY_BUDGET),plain);
});
test('a token budget trims the oldest earlier runs first, and null tokens change nothing',()=>{
  const previousRuns:TaskContextPreviousRun[]=Array.from({length:4},(_,index)=>({text:`Run ${index}`,steps:[{kind:'model',status:'completed',result:{text:`RUN_${index}_${'y'.repeat(6*1024)}`}}]}));
  const plain=assembleRunContext({locale:'en',text:'Next',previousRuns});
  assert.equal(plain.metrics.trimmedRuns,0);
  const tokens=Math.floor(taskTokenEstimate(plain.metrics.historyBytes)/2),trimmed=assembleRunContext({locale:'en',text:'Next',previousRuns,budget:{bytes:TASK_MODEL_LIMITS.historyBytes,tokens}});
  assert.ok(trimmed.metrics.trimmedRuns>0&&trimmed.metrics.retainedRuns>0,JSON.stringify(trimmed.metrics));
  assert.ok(taskTokenEstimate(trimmed.metrics.historyBytes)<=tokens);
  const text=JSON.stringify(trimmed.context);
  assert.ok(text.includes('RUN_3_'),'the newest earlier run stays');assert.equal(text.includes('RUN_0_'),false,'the oldest earlier run goes first');
  assert.ok(text.includes('"content":"Next"'),'the current message stays');
  assert.deepEqual(assembleRunContext({locale:'en',text:'Next',previousRuns,budget:{bytes:TASK_MODEL_LIMITS.historyBytes,tokens:null}}),plain);
});
