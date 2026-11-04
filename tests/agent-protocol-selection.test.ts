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
  for (const [presetId, profile] of Object.entries(AGENT_CHAT_PROFILES)) assert.equal(agentChatProfile(configuration(presetId, 'chat_completions')), profile);
  for (const [presetId, profile] of Object.entries(AGENT_RESPONSES_PROFILES)) assert.equal(agentResponsesProfile(configuration(presetId, 'responses')), profile);
  assert.throws(() => agentChatProfile(configuration('minimax', 'anthropic_messages')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => agentResponsesProfile(configuration('minimax', 'chat_completions')), {code: 'AGENT_CHAT_VALIDATION'});
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
