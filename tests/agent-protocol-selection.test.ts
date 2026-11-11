import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {agentChatProfile, AGENT_CHAT_PROFILES, agentResponsesProfile, AGENT_RESPONSES_PROFILES, agentReadToolProfile, AGENT_READ_TOOL_PROFILES, validateAgentGatewayConfiguration, agentModelAdaptation} from '../packages/business/src/agent/model-profiles.ts';
import {buildTaskModelRequest} from '../packages/business/src/agent/task-gateway-v2.ts';
import {presetConfigurations,defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';

function configuration(presetId: string, protocol: AgentProtocol): AgentConfiguration {
  const result = presetConfigurations().find(item => item.presetId === presetId && item.protocol === protocol);
  assert.ok(result, `${presetId}/${protocol} must have a runnable documented endpoint`);return result;
}

test('existing adapted profiles retain identity and reject calls through another protocol selector', () => {
  assert.equal(agentReadToolProfile(configuration('minimax', 'anthropic_messages')), AGENT_READ_TOOL_PROFILES.anthropic_messages.custom);
  for (const [presetId, profile] of Object.entries(AGENT_CHAT_PROFILES)) {
    const selected=configuration(presetId, 'chat_completions');
    for(const model of profile.models??[selected.model])assert.equal(agentChatProfile({...selected,model}), profile);
  }
  for (const [presetId, profile] of Object.entries(AGENT_RESPONSES_PROFILES)) {
    const selected=configuration(presetId, 'responses');
    for(const model of profile.models??[selected.model])assert.equal(agentResponsesProfile({...selected,model}), profile);
  }
  assert.throws(() => agentChatProfile(configuration('minimax', 'anthropic_messages')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => agentResponsesProfile(configuration('minimax', 'chat_completions')), {code: 'AGENT_CHAT_VALIDATION'});
});

test('current OpenAI and OpenRouter defaults use their independently documented protocol policies', () => {
  const openai=configuration('openai','responses');
  assert.equal(openai.model,'gpt-6.1-terra');assert.deepEqual(validateAgentGatewayConfiguration(openai),openai);
  assert.notEqual(agentResponsesProfile(openai),AGENT_RESPONSES_PROFILES.openai);
  assert.deepEqual(agentResponsesProfile(openai),{models:['gpt-6.1-terra'],fields:{truncation:'disabled',reasoning:{effort:'none'}},
    thinkingTier:'optional',contextTokens:1050000,maxOutputTokens:128000,outputTokens:32768});
  assert.throws(()=>agentChatProfile(openai),{code:'AGENT_CHAT_VALIDATION'});
  const forcedChat={...configuration('openai','chat_completions'),model:'gpt-6.1-terra'};
  assert.deepEqual(validateAgentGatewayConfiguration(forcedChat),forcedChat,'Saving a protocol choice remains allowed; tool calls have a separate admission check');
  assert.deepEqual(agentChatProfile(forcedChat).fields,{store:false});assert.equal(agentChatProfile(forcedChat).thinkingTier,'unsupported');
  assert.throws(()=>agentResponsesProfile(forcedChat),{code:'AGENT_CHAT_VALIDATION'});
  const selected=configuration('openrouter','chat_completions');
  assert.equal(selected.model,'openai/gpt-6.1-terra');assert.deepEqual(validateAgentGatewayConfiguration(selected),selected);
  assert.notEqual(agentChatProfile(selected),AGENT_CHAT_PROFILES.openrouter);
  assert.deepEqual(agentChatProfile(selected),{models:['openai/gpt-6.1-terra'],tokenField:'max_tokens',
    fields:{provider:{require_parameters:true,allow_fallbacks:false},reasoning:{effort:'none'}},
    thinkingTier:'optional',contextTokens:1050000,maxOutputTokens:128000,outputTokens:32768});
});

test('explicit GPT-5.4 mini selections retain both protocol profiles independently of the new default',()=>{
  for(const protocol of ['chat_completions','responses'] as const){
    const selected={...configuration('openai',protocol),model:'gpt-5.4-mini'};
    assert.deepEqual(validateAgentGatewayConfiguration(selected),selected);
    const profile=protocol==='chat_completions'?agentChatProfile(selected):agentResponsesProfile(selected);
    assert.notEqual(profile,protocol==='chat_completions'?AGENT_CHAT_PROFILES.openai:AGENT_RESPONSES_PROFILES.openai);
    assert.deepEqual(profile,{models:['gpt-5.4-mini'],...(protocol==='chat_completions'?{tokenField:'max_completion_tokens'}:{}),
      fields:protocol==='chat_completions'?{store:false,reasoning_effort:'none'}:{truncation:'disabled',reasoning:{effort:'none'}},
      thinkingTier:'optional',contextTokens:400000,maxOutputTokens:128000,outputTokens:32768});
    assert.throws(()=>protocol==='chat_completions'?agentResponsesProfile(selected):agentChatProfile(selected),{code:'AGENT_CHAT_VALIDATION'});
  }
});

test('explicit business fixtures run tools in every requested protocol without rewriting the real default enumeration',()=>{
  const tools=[{name:'synthetic_fixture_tool',description:'Synthetic protocol fixture',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}];
  for(const [protocol,presetId,model] of [['chat_completions','openai','gpt-6-luna'],['responses','openai','gpt-6.1-terra'],['anthropic_messages','ollama','qwen3:8b']] as const){
    const selected=defaultTestAgentConfiguration(protocol);assert.equal(selected.protocol,protocol);assert.equal(selected.presetId,presetId);assert.equal(selected.model,model);
    assert.deepEqual(validateAgentGatewayConfiguration(selected,{selfPort:4318}),selected);
    const body=JSON.parse(buildTaskModelRequest(selected,[{role:'user',content:'Synthetic fixture only'}],tools,4318)) as Record<string,unknown>;
    assert.equal(body.model,model);assert.ok(Array.isArray(body.tools));assert.equal(body.tools.length,1);
    if(protocol==='chat_completions')assert.equal(body.reasoning_effort,'none');
  }
  const actual=configuration('openai','chat_completions');assert.equal(actual.model,'gpt-6.1-terra');assert.equal(agentModelAdaptation(actual),'unverified');
  assert.throws(()=>buildTaskModelRequest(actual,[{role:'user',content:'Synthetic fixture only'}],tools,4318),{code:'AGENT_CHAT_RESPONSES_REQUIRED'});
});

test('unadapted Responses models use their provider generic fields without borrowing named capacity', () => {
  for (const selected of [configuration('minimax', 'responses'), {...configuration('qwen', 'responses'), model: 'qwen-plus'}]) {
    assert.deepEqual(validateAgentGatewayConfiguration(selected), selected);
    const profile = agentResponsesProfile(selected);
    assert.notEqual(profile, AGENT_RESPONSES_PROFILES.custom);
    assert.notEqual(profile, AGENT_RESPONSES_PROFILES.qwen);
    assert.deepEqual(profile, {models: null, fields: {reasoning: {effort: 'none'}}, thinkingTier: 'unsupported', contextTokens: null, maxOutputTokens: null, outputTokens: 4096});
  }
});

test('every unavailable catalog combination is rejected before credential acquisition', () => {
  let blocked = 0;
  for (const preset of AGENT_PRESETS) for (const platform of preset.platforms) for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
    if (platform.availableProtocols.includes(protocol)) continue;
    const selected: AgentConfiguration = {presetId: preset.id, platformId: platform.id, protocol,
      baseUrl: platform.protocols[protocol]?.baseUrl || platform.baseUrl, model: platform.model};
    let acquired = false;
    assert.throws(() => {validateAgentGatewayConfiguration(selected);acquired = true;}, {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
    assert.equal(acquired, false, `${preset.id}/${platform.id}/${protocol}`);blocked++;
  }
  assert.equal(blocked, 9);
});
