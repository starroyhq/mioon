import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {agentChatProfile, AGENT_CHAT_PROFILES, agentResponsesProfile, AGENT_RESPONSES_PROFILES, agentReadToolProfile, AGENT_READ_TOOL_PROFILES, validateAgentGatewayConfiguration} from '../packages/business/src/agent/model-profiles.ts';

function configuration(presetId: string, protocol: AgentProtocol): AgentConfiguration {
  const preset = AGENT_PRESETS.find(item => item.id === presetId)!;
  const platform = preset.platforms[0]!;
  return {presetId, platformId: platform.id, protocol,
    baseUrl: presetId === 'ollama' && protocol === 'anthropic_messages' ? new URL(platform.baseUrl).origin : platform.baseUrl || 'https://selection.example.com/v1',
    model: presetId === 'qwen' && protocol === 'responses' ? 'qwen3.8-flash' : platform.model || 'synthetic-model'};
}

test('new combinations select a generic protocol template while existing profiles retain identity', () => {
  assert.equal(agentChatProfile(configuration('anthropic', 'chat_completions')), AGENT_CHAT_PROFILES.custom);
  assert.equal(agentResponsesProfile(configuration('minimax', 'responses')), AGENT_RESPONSES_PROFILES.custom);
  assert.equal(agentReadToolProfile(configuration('minimax', 'anthropic_messages')), AGENT_READ_TOOL_PROFILES.anthropic_messages.custom);
  for (const [presetId, profile] of Object.entries(AGENT_CHAT_PROFILES)) assert.equal(agentChatProfile(configuration(presetId, 'chat_completions')), profile);
  for (const [presetId, profile] of Object.entries(AGENT_RESPONSES_PROFILES)) assert.equal(agentResponsesProfile(configuration(presetId, 'responses')), profile);
  assert.throws(() => agentChatProfile(configuration('minimax', 'anthropic_messages')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => agentResponsesProfile(configuration('minimax', 'chat_completions')), {code: 'AGENT_CHAT_VALIDATION'});
  assert.throws(() => validateAgentGatewayConfiguration({...configuration('qwen', 'responses'), model: 'qwen-plus'}), {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
});
