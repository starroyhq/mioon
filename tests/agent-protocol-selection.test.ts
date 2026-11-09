import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {agentChatProfile, AGENT_CHAT_PROFILES, agentResponsesProfile, AGENT_RESPONSES_PROFILES, agentReadToolProfile, AGENT_READ_TOOL_PROFILES, validateAgentGatewayConfiguration} from '../packages/business/src/agent/model-profiles.ts';
import {presetConfigurations} from './helpers/agent-preset-configurations.ts';

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

test('current OpenAI and OpenRouter defaults select reasoning-family profiles without changing legacy identities', () => {
  for(const protocol of ['chat_completions','responses'] as const){
    const selected=configuration('openai',protocol);
    assert.equal(selected.model,'gpt-5.4-mini');assert.deepEqual(validateAgentGatewayConfiguration(selected),selected);
    const profile=protocol==='chat_completions'?agentChatProfile(selected):agentResponsesProfile(selected);
    assert.notEqual(profile,protocol==='chat_completions'?AGENT_CHAT_PROFILES.openai:AGENT_RESPONSES_PROFILES.openai);
    assert.deepEqual(profile,{models:['gpt-5.4-mini'],...(protocol==='chat_completions'?{tokenField:'max_completion_tokens'}:{}),
      fields:protocol==='chat_completions'?{store:false,reasoning_effort:'none'}:{truncation:'disabled',reasoning:{effort:'none'}},
      thinkingTier:'optional',contextTokens:400000,maxOutputTokens:128000,outputTokens:32768});
    assert.throws(()=>protocol==='chat_completions'?agentResponsesProfile(selected):agentChatProfile(selected),{code:'AGENT_CHAT_VALIDATION'});
  }
  const selected=configuration('openrouter','chat_completions');
  assert.equal(selected.model,'openai/gpt-5.4-mini');assert.deepEqual(validateAgentGatewayConfiguration(selected),selected);
  assert.notEqual(agentChatProfile(selected),AGENT_CHAT_PROFILES.openrouter);
  assert.deepEqual(agentChatProfile(selected),{models:['openai/gpt-5.4-mini'],tokenField:'max_tokens',
    fields:{provider:{require_parameters:true,allow_fallbacks:false},reasoning:{effort:'none'}},
    thinkingTier:'optional',contextTokens:400000,maxOutputTokens:128000,outputTokens:32768});
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
