import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '@mioon/contracts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {parseAgentConfiguration, parseAgentSettingsUpdate} from '../packages/business/src/agent/config.ts';

test('shared protocol labels and fixed suffixes are pure, closed and deeply frozen', async () => {
  assert.deepEqual(AGENT_PROTOCOLS, {
    chat_completions: {label: 'Chat Completions', path: '/chat/completions'},
    responses: {label: 'Responses', path: '/responses'},
    anthropic_messages: {label: 'Anthropic Messages', path: '/v1/messages'},
  });
  assert.ok(Object.isFrozen(AGENT_PROTOCOLS));
  for (const entry of Object.values(AGENT_PROTOCOLS)) assert.ok(Object.isFrozen(entry));
  assert.throws(() => { (AGENT_PROTOCOLS.responses as {path: string}).path = '/other'; }, TypeError);
  for (const file of ['agent-protocol.ts']) {
    const source = await readFile(new URL(`../packages/contracts/src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:import\s|require\(|\bfetch\(|\bBuffer\b|\bprocess\b)/);
  }
});

test('endpoint derivation preserves complete canonical base path and accepts only the three fixed protocol suffixes', () => {
  for (const baseUrl of ['https://api.openai.com/v1', 'https://api.deepseek.com', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
    for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
      const path = AGENT_PROTOCOLS[protocol].path;
      assert.equal(deriveAgentEndpoint({baseUrl, protocol}), baseUrl + path);
      assert.equal(deriveAgentEndpoint({baseUrl, protocol, path: '/attacker', requestPath: '/attacker'} as unknown as Parameters<typeof deriveAgentEndpoint>[0]), baseUrl + path);
    }
  }
  for (const protocol of [undefined, null, '', 'Responses', 'auto', '__proto__', 'constructor', '/responses', ['responses'], {}]) {
    assert.throws(() => deriveAgentEndpoint({baseUrl: 'https://api.example.com/v1', protocol} as unknown as Parameters<typeof deriveAgentEndpoint>[0]), TypeError);
  }
  for (const baseUrl of [undefined, null, '', 123, 'https://API.example.com/v1', 'https://api.example.com:443/v1', 'https://api.example.com/v1/', 'https://api.example.com/v1/../other', 'https://api.example.com/v1//other', 'https://api.example.com/%2fother', 'https://api.example.com/v1?secret=x', 'https://user:key@api.example.com/v1', 'https://api.example.com/v1#other', 'file:///v1', 'https://api.example.com\\@elsewhere.example.com/v1', 'https://api.example.com/v1\n']) {
    assert.throws(() => deriveAgentEndpoint({baseUrl, protocol: 'responses'} as unknown as Parameters<typeof deriveAgentEndpoint>[0]), TypeError);
  }
});

test('presets retain their original defaults while protocol selection is independent for every platform', () => {
  const candidates = ['openai', 'deepseek', 'qwen', 'custom', 'ollama'];
  assert.equal(DEFAULT_AGENT_CONFIGURATION.protocol, 'chat_completions');
  for (const preset of AGENT_PRESETS) {
    const expectedDefault = preset.id === 'anthropic' ? 'anthropic_messages' : 'chat_completions';
    assert.equal(preset.defaultProtocol, expectedDefault);
    assert.deepEqual(preset.availableProtocols, Object.keys(AGENT_PROTOCOLS));
    for (const platform of preset.platforms) {
      assert.equal(platform.defaultProtocol, expectedDefault);
      assert.deepEqual(platform.availableProtocols, preset.availableProtocols);
      assert.ok(Object.isFrozen(platform.availableProtocols));
      const configuration = {presetId: preset.id, platformId: platform.id, baseUrl: platform.baseUrl || 'https://api.example.com/v1', model: platform.model || 'user-model', protocol: expectedDefault};
      assert.deepEqual(parseAgentConfiguration(configuration), configuration);
      for (const protocol of Object.keys(AGENT_PROTOCOLS)) {
        const selected = {...configuration, protocol, ...(preset.id === 'ollama' && protocol === 'anthropic_messages' ? {baseUrl: new URL(configuration.baseUrl).origin} : {})};
        assert.deepEqual(parseAgentConfiguration(selected), selected, `${preset.id}/${platform.id}/${protocol}`);
      }
      if (candidates.includes(preset.id)) {
        const hints = (preset as {supportedModelHints?: {responses: string[]}}).supportedModelHints; assert.ok(hints); assert.ok(Object.isFrozen(hints.responses));
      }
    }
  }
  const qwen = AGENT_PRESETS.find(preset => preset.id === 'qwen'); assert.ok(qwen);
  for (const platform of qwen.platforms) {
    assert.equal(platform.model, 'qwen-plus');
    assert.deepEqual((qwen as {supportedModelHints: {responses: string[]}}).supportedModelHints.responses, ['qwen3.8-flash']);
    assert.match((qwen as {protocolNotes: {responses: string}}).protocolNotes.responses, /截断无法禁用/);
  }
  const minimax = AGENT_PRESETS.find(preset => preset.id === 'minimax'); assert.ok(minimax);
  for (const platform of minimax.platforms) {
    const domain = platform.id === 'china' ? 'cn' : 'io';
    assert.equal(platform.baseUrl, `https://api.minimax.${domain}/v1`);
    assert.ok(platform.sources.some(source => source.url === `https://platform.minimax.${domain}/docs/api-reference/text-anthropic-api`));
  }
});

test('new configuration and write boundaries never infer protocol from model or URL', () => {
  const {protocol, ...legacy} = DEFAULT_AGENT_CONFIGURATION;
  const invalid = [legacy, {...legacy, protocol: undefined}, {...legacy, protocol: null}, {...legacy, protocol: 'auto'}, {...legacy, protocol: '__proto__'}, {...DEFAULT_AGENT_CONFIGURATION, requestPath: '/responses'}];
  for (const configuration of invalid) {
    assert.throws(() => parseAgentConfiguration(configuration), {code: 'AGENT_SETTINGS_VALIDATION'});
    assert.throws(() => parseAgentSettingsUpdate({expectedRevision: 0, configuration, secret: {action: 'keep'}}), {code: 'AGENT_SETTINGS_VALIDATION'});
  }
});
