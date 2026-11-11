import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {resolveAgentPresetBaseUrl} from '../packages/contracts/src/agent-provider-catalog.ts';
import {agentAdaptedModelHints, agentChatAllowsNaturalEof, agentModelAdaptation, agentModelThinkingTier, agentModelTokenLimits, agentRequestThinks, validateAgentGatewayConfiguration} from '../packages/business/src/agent/model-profiles.ts';
import {buildTaskModelRequest, createTaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
import {collectGenericRequestFingerprints, genericConfigurations, genericNetwork, genericSse, GENERIC_MODEL, readGenericRequestFingerprints} from './helpers/agent-generic-request-fingerprints.ts';

const object = (value: unknown): Record<string, unknown> => {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;};
const history = [{role: 'user', content: 'Synthetic generic profile request'}];
function configured(presetId: string, platformId: string, protocol: AgentConfiguration['protocol'], model = GENERIC_MODEL): AgentConfiguration {
  return {presetId, platformId, protocol, model, baseUrl: resolveAgentPresetBaseUrl(AGENT_PRESETS, presetId, platformId, protocol, presetId === 'ollama' ? 'http://127.0.0.1:11434' : presetId === 'custom' ? 'https://gateway.example.com/team/v1' : undefined)};
}

test('the separate generic fixture locks 204 raw SDK/network requests across all 51 approved endpoint combinations', {timeout: 120000}, async () => {
  const raw: Array<{configuration: string; body: Record<string, unknown>}> = [];
  const actual = await collectGenericRequestFingerprints((row, text) => raw.push({configuration: `${row.presetId}/${row.platformId}/${row.protocol}`, body: object(JSON.parse(text))}));
  assert.deepEqual(actual, readGenericRequestFingerprints(), 'Review generic wire differences before rewriting only the new generic fixture');
  assert.equal(actual.length, 204); assert.equal(genericConfigurations().length, 51);
  for (const configuration of genericConfigurations()) {
    const rows = actual.filter(row => row.presetId === configuration.presetId && row.platformId === configuration.platformId && row.protocol === configuration.protocol);
    assert.deepEqual(rows.map(row => [row.scenario, row.index]), [['text', 1], ['tool_roundtrip', 1], ['tool_roundtrip', 2], ['tool_roundtrip', 3]]);
    assert.deepEqual(agentModelTokenLimits(configuration), {contextTokens: null, outputTokens: 4096});
    assert.equal(agentModelAdaptation(configuration), 'unverified');
    assert.equal(agentModelThinkingTier(configuration), configuration.protocol === 'anthropic_messages' ? 'optional' : configuration.protocol === 'responses' && configuration.presetId === 'openai' ? 'required' : 'unsupported');
  }
  for (const {configuration, body} of raw) {
    const [presetId, , protocol] = configuration.split('/');
    assert.equal(body.model, GENERIC_MODEL); assert.equal(body.stream, true);
    if (protocol === 'anthropic_messages') {assert.equal(body.max_tokens, 4096); assert.deepEqual(body.thinking, {type: 'disabled'}); continue;}
    if (protocol === 'responses') {
      assert.equal(body.max_output_tokens, 4096); assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined); assert.equal(body.conversation, undefined);
      assert.deepEqual(body.include,presetId==='openai'?['reasoning.encrypted_content']:undefined);
      if (presetId === 'openai' || presetId === 'custom') assert.equal(body.reasoning, undefined);
      else assert.deepEqual(body.reasoning, presetId === 'openrouter' ? {enabled: false} : {effort: 'none'});
    } else {
      assert.equal(body.max_completion_tokens ?? body.max_tokens, 4096);
      if (presetId === 'openai') {assert.equal(body.store, false); assert.equal(body.reasoning_effort, undefined); assert.equal(body.reasoning, undefined);}
      if (['deepseek', 'zhipu', 'kimi', 'minimax'].includes(presetId!)) assert.deepEqual(body.thinking, {type: 'disabled'});
      if (presetId === 'qwen') assert.equal(body.enable_thinking, false);
      if (presetId === 'ollama') assert.equal(body.reasoning_effort, 'none');
      if (presetId === 'openrouter') assert.deepEqual(body.reasoning, {enabled: false});
    }
    if (presetId === 'openrouter') assert.deepEqual(body.provider, {require_parameters: true, allow_fallbacks: false});
  }
});

test('adapted labels and named capacities come only from their exact static provider/protocol model profile', () => {
  for (const presetId of ['openai', 'anthropic', 'deepseek', 'qwen', 'zhipu', 'kimi', 'minimax', 'openrouter', 'ollama']) {
    for (const [protocol, models] of Object.entries(agentAdaptedModelHints(presetId))) for (const model of models) {
      const preset = AGENT_PRESETS.find(entry => entry.id === presetId); assert.ok(preset);
      const platform = preset.platforms.find(entry => entry.availableProtocols.includes(protocol as AgentConfiguration['protocol'])); assert.ok(platform);
      const config = configured(presetId, platform.id, protocol as AgentConfiguration['protocol'], model);
      assert.equal(agentModelAdaptation(config), 'adapted');
      assert.equal(agentModelAdaptation({...config, model: model + '-unreviewed'}), 'unverified');
    }
  }
  assert.deepEqual(agentModelTokenLimits(configured('anthropic', 'global', 'anthropic_messages', 'claude-haiku-4-5')), {contextTokens: 200000, outputTokens: 16384});
  assert.deepEqual(agentModelTokenLimits(configured('openai', 'global', 'responses', 'gpt-4.1-mini')), {contextTokens: 1047576, outputTokens: 4096});
  assert.equal(agentModelAdaptation(configured('custom', 'custom', 'responses', 'gpt-4.1-mini')), 'unverified');
});

test('new generic metadata cannot upgrade the thinking meaning of old Responses fallback requests', () => {
  for (const [presetId, platformId] of [['minimax', 'china'], ['zhipu', 'china'], ['openrouter', 'global']] as const) {
    const configuration = configured(presetId, platformId, 'responses');
    assert.equal(agentRequestThinks(configuration, {model: configuration.model, stream: true, store: false, truncation: 'disabled'}), false);
  }
});

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) test(`${protocol}: generic branches reject unrequested reasoning or an incomplete native carrier without retry or rendering it`, async () => {
  for (const configuration of genericConfigurations().filter(item => item.protocol === protocol)) {
    const body = buildTaskModelRequest(configuration, history, [], 4318), network = genericNetwork(configuration, genericSse(configuration, undefined, {reasoning: true}));
    const shown: string[] = [];
    await assert.rejects(async () => {for await (const item of createTaskGateway(network.dependencies)({configuration, body, apiKey: 'SYNTHETIC_GENERIC_WIRE_ONLY', selfPort: 4318})) if (item.type === 'delta') shown.push(item.text);},
      {code: protocol === 'responses' ? configuration.presetId === 'openai' ? 'AGENT_CHAT_RESPONSES_INCOMPLETE' : 'AGENT_CHAT_TOOLS_UNSUPPORTED' : 'AGENT_CHAT_REASONING_UNSUPPORTED'}, `${configuration.presetId}/${configuration.platformId}`);
    assert.equal(network.constructions, 1); assert.equal(network.requests.length, 1); assert.ok(!shown.join('').includes('SYNTHETIC_PRIVATE_REASONING'));
  }
});

test('unsupported provider/protocol combinations stop in the common preflight without a socket', () => {
  for (const [presetId, platformId, protocol, baseUrl] of [
    ['anthropic', 'global', 'chat_completions', 'https://api.anthropic.com/v1'],
    ['anthropic', 'global', 'responses', 'https://api.anthropic.com/v1'],
    ['openai', 'global', 'anthropic_messages', 'https://api.openai.com/v1'],
    ['kimi', 'china', 'responses', 'https://api.moonshot.cn/v1'],
    ['kimi', 'international', 'anthropic_messages', 'https://api.moonshot.ai/anthropic'],
    ['zhipu', 'international', 'responses', 'https://api.z.ai/api/v1'],
    ['openrouter', 'global', 'anthropic_messages', 'https://openrouter.ai/api'],
  ] as const) {
    let acquired = false; const configuration = {presetId, platformId, protocol, baseUrl, model: GENERIC_MODEL};
    assert.throws(() => {validateAgentGatewayConfiguration(configuration); acquired = true;}, {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
    assert.equal(acquired, false);
  }
});

test('provider rejection keeps the generic off fields, uses one request and exposes only the safe fixed error', async () => {
  const configuration = configured('minimax', 'china', 'responses'), body = buildTaskModelRequest(configuration, history, [], 4318);
  const network = genericNetwork(configuration, JSON.stringify({error: {message: 'PRIVATE_PROVIDER_TEXT', code: 'bad_parameter'}}), 400); let failure: unknown;
  try {for await (const _ of createTaskGateway(network.dependencies)({configuration, body, apiKey: 'SYNTHETIC_GENERIC_WIRE_ONLY', selfPort: 4318})) {}} catch (error) {failure = error;}
  assert.equal(object(failure).code, 'AGENT_CHAT_HTTP_ERROR'); assert.equal(network.requests.length, 1); assert.equal(network.constructions, 1);
  assert.deepEqual(object(JSON.parse(network.requests[0]!.body)).reasoning, {effort: 'none'});
  assert.ok(!JSON.stringify(safeAgentChatError(failure)).includes('PRIVATE_PROVIDER_TEXT'));
});

test('MiniMax generic cannot inherit the exact M3 natural EOF contract', async () => {
  const configuration = configured('minimax', 'china', 'chat_completions'), body = buildTaskModelRequest(configuration, history, [], 4318);
  assert.equal(agentChatAllowsNaturalEof(configuration, object(JSON.parse(body))), false);
  const network = genericNetwork(configuration, genericSse(configuration, undefined, {omitDone: true}));
  await assert.rejects(async () => {for await (const _ of createTaskGateway(network.dependencies)({configuration, body, apiKey: 'SYNTHETIC_GENERIC_WIRE_ONLY', selfPort: 4318})) {}}, {code: 'AGENT_CHAT_TRUNCATED'});
  assert.equal(network.requests.length, 1);
});
