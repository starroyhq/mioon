import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {agentCredentialBinding, parseAgentConfiguration} from '../packages/business/src/agent/config.ts';
import {agentProviderCatalogSchema, resolveAgentPresetBaseUrl} from '../packages/contracts/src/agent-provider-catalog.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';

const c = 'chat_completions', r = 'responses', m = 'anthropic_messages';
function configuration(presetId: string, platformId: string, protocol: AgentProtocol, addressInput?: string): AgentConfiguration {
  return {presetId, platformId, protocol, model: 'synthetic-model', baseUrl: resolveAgentPresetBaseUrl(AGENT_PRESETS, presetId, platformId, protocol, addressInput)};
}

test('the static catalog derives runnable protocols from exact endpoints and preserves blocked documentation', () => {
  assert.equal(agentProviderCatalogSchema.safeParse(AGENT_PRESETS).success, true);
  const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic'); assert.ok(anthropic);
  assert.deepEqual(anthropic.availableProtocols, [m]);
  assert.ok(anthropic.platforms[0]!.protocols[c]?.blockedReason);
  for (const preset of AGENT_PRESETS) for (const platform of preset.platforms) {
    assert.ok(Object.isFrozen(platform.protocols));
    for (const protocol of platform.availableProtocols) {
      const endpoint = platform.protocols[protocol]; assert.ok(endpoint); assert.equal(endpoint.blockedReason, undefined);
      assert.equal(endpoint.checkedAt, '2026-11-03');
      if (preset.id !== 'custom') assert.ok(endpoint.sources.length);
    }
  }
  const forged = AGENT_PRESETS.map(preset => preset.id === 'anthropic' ? {...preset, availableProtocols: [c, m]} : preset);
  assert.equal(agentProviderCatalogSchema.safeParse(forged).success, false);
});

for (const [preset, platform, protocol, expected] of [
  ['openai', 'global', c, 'https://api.openai.com/v1'], ['openai', 'global', r, 'https://api.openai.com/v1'],
  ['anthropic', 'global', m, 'https://api.anthropic.com'],
  ['deepseek', 'global', c, 'https://api.deepseek.com'], ['deepseek', 'global', r, 'https://api.deepseek.com'], ['deepseek', 'global', m, 'https://api.deepseek.com/anthropic'],
  ['qwen', 'beijing', m, 'https://dashscope.aliyuncs.com/apps/anthropic'], ['qwen', 'singapore', m, 'https://dashscope-intl.aliyuncs.com/apps/anthropic'],
  ['zhipu', 'china', c, 'https://open.bigmodel.cn/api/paas/v4'], ['zhipu', 'china', r, 'https://open.bigmodel.cn/api/v1'], ['zhipu', 'china', m, 'https://open.bigmodel.cn/api/anthropic'],
  ['zhipu', 'international', m, 'https://api.z.ai/api/anthropic'],
  ['kimi', 'china', c, 'https://api.moonshot.cn/v1'], ['kimi', 'international', c, 'https://api.moonshot.ai/v1'],
  ['minimax', 'china', c, 'https://api.minimax.cn/v1'], ['minimax', 'china', r, 'https://api.minimax.cn/v1'], ['minimax', 'china', m, 'https://api.minimax.cn/anthropic'],
  ['minimax', 'international', m, 'https://api.minimax.io/anthropic'],
  ['openrouter', 'global', r, 'https://openrouter.ai/api/v1'],
] as const) test(`${preset}/${platform}/${protocol} resolves its documented endpoint`, () => {
  assert.equal(configuration(preset, platform, protocol).baseUrl, expected);
  assert.equal(parseAgentConfiguration(configuration(preset, platform, protocol)).baseUrl, expected);
});

for (const [preset, platform, protocol] of [
  ['openai', 'global', m], ['anthropic', 'global', c], ['anthropic', 'global', r],
  ['kimi', 'china', r], ['kimi', 'international', r], ['kimi', 'china', m], ['kimi', 'international', m],
  ['zhipu', 'international', r], ['openrouter', 'global', m],
] as const) test(`${preset}/${platform}/${protocol} cannot resolve or save a blocked endpoint`, () => {
  assert.throws(() => configuration(preset, platform, protocol));
  assert.throws(() => parseAgentConfiguration({presetId: preset, platformId: platform, protocol, model: 'synthetic-model', baseUrl: 'https://api.example.com/v1'}), {code: 'AGENT_SETTINGS_VALIDATION'});
});

test('fixed platforms accept only normalized exact directory addresses', () => {
  const good = configuration('openai', 'global', c);
  assert.equal(parseAgentConfiguration({...good, baseUrl: 'HTTPS://API.OPENAI.COM:443/v1/'}).baseUrl, good.baseUrl);
  for (const baseUrl of ['https://other.example.com/v1', 'https://api.openai.com:8443/v1', 'https://api.openai.com/v2', 'https://api.openai.com/v1/extra', 'https://api.openai.com.evil.example/v1', 'https://api.openai.com/v1?x=1', 'https://api.openai.com/v1#x', 'https://user@api.openai.com/v1', 'https://api.openai.com/%76%31', 'https://api.openai.com/a/../v1']) {
    assert.throws(() => parseAgentConfiguration({...good, baseUrl}), {code: 'AGENT_SETTINGS_VALIDATION'}, baseUrl);
  }
  assert.throws(() => parseAgentConfiguration({...good, addressMode: 'custom'}), {code: 'AGENT_SETTINGS_VALIDATION'});
  assert.throws(() => configuration('openai', 'global', c, good.baseUrl));
});

for (const region of ['cn-beijing', 'ap-southeast-1', 'us-east-1', 'cn-hongkong', 'ap-northeast-1', 'eu-central-1']) test(`workspace ${region} binds the ID, not a protocol path`, () => {
  const platform = `workspace-${region}`, chat = configuration('qwen', platform, c, 'project-123'), messages = configuration('qwen', platform, m, 'project-123');
  assert.equal(chat.baseUrl, `https://project-123.${region}.maas.aliyuncs.com/compatible-mode/v1`);
  assert.equal(messages.baseUrl, `https://project-123.${region}.maas.aliyuncs.com/apps/anthropic`);
  assert.equal(agentCredentialBinding(chat), agentCredentialBinding(messages));
  assert.notEqual(agentCredentialBinding(chat), agentCredentialBinding(configuration('qwen', platform, c, 'other-123')));
  for (const input of ['', '-invalid', 'invalid-', 'a.b', 'a/b', 'a%2eb', 'a:443', 'a'.repeat(64), '全角']) assert.throws(() => configuration('qwen', platform, c, input), input);
  assert.doesNotThrow(() => configuration('qwen', platform, c, 'a'.repeat(63)));
  assert.throws(() => parseAgentConfiguration({...messages, baseUrl: messages.baseUrl.replace('/apps/anthropic', '/compatible-mode/v1')}), {code: 'AGENT_SETTINGS_VALIDATION'});
});

test('local protocols share only a proven loopback origin and keep host/port isolation', () => {
  for (const origin of ['http://127.0.0.1:11434', 'https://localhost:11434', 'http://[::1]:11434']) {
    const chat = configuration('ollama', 'local', c, origin), messages = configuration('ollama', 'local', m, origin);
    assert.equal(chat.baseUrl, origin + '/v1'); assert.equal(messages.baseUrl, origin);
    assert.equal(agentCredentialBinding(chat), agentCredentialBinding(messages));
    assert.notEqual(agentCredentialBinding(chat), agentCredentialBinding(configuration('ollama', 'local', c, origin.replace('11434', '11435'))));
    assert.throws(() => parseAgentConfiguration(chat, {selfPort: 11434}), {code: 'AGENT_SETTINGS_VALIDATION'});
  }
  for (const origin of ['http://127.0.0.2:11434', 'http://localhost.example:11434', 'http://127.0.0.1:0', 'http://localhost:65536', 'http://localhost:11434/v1']) assert.throws(() => configuration('ollama', 'local', c, origin));
});

test('custom keys bind the complete normalized base, while protocol and model remain separate', () => {
  const one = configuration('custom', 'custom', c, 'https://gateway.example.com/team/v1');
  assert.equal(agentCredentialBinding(one), agentCredentialBinding({...one, protocol: r, model: 'another-model'}));
  assert.notEqual(agentCredentialBinding(one), agentCredentialBinding({...one, baseUrl: 'https://gateway.example.com/other/v1'}));
  assert.notEqual(agentCredentialBinding(configuration('openai', 'global', c)), agentCredentialBinding(configuration('custom', 'custom', c, 'https://api.openai.com/v1')));
  for (const baseUrl of ['http://gateway.example.com/v1', 'https://127.0.0.1/v1', 'https://192.168.1.2/v1']) assert.throws(() => parseAgentConfiguration({...one, baseUrl}), {code: 'AGENT_SETTINGS_VALIDATION'});
  for (const model of ['', 'bad\nmodel', '\ud800', 'a'.repeat(201)]) assert.throws(() => parseAgentConfiguration({...one, model}), {code: 'AGENT_SETTINGS_VALIDATION'});
});
