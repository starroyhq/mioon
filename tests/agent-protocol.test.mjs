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
  });
  assert.ok(Object.isFrozen(AGENT_PROTOCOLS));
  for (const entry of Object.values(AGENT_PROTOCOLS)) assert.ok(Object.isFrozen(entry));
  assert.throws(() => { AGENT_PROTOCOLS.responses.path = '/other'; }, TypeError);
  for (const file of ['agent-protocol.mjs', 'agent-protocol.ts']) {
    const source = await readFile(new URL(`../packages/contracts/src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:import\s|require\(|\bfetch\(|\bBuffer\b|\bprocess\b)/);
  }
});

test('endpoint derivation preserves complete canonical base path and accepts only two fixed protocol suffixes', () => {
  for (const baseUrl of ['https://api.openai.com/v1', 'https://api.deepseek.com', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
    for (const [protocol, {path}] of Object.entries(AGENT_PROTOCOLS)) {
      assert.equal(deriveAgentEndpoint({baseUrl, protocol}), baseUrl + path);
      assert.equal(deriveAgentEndpoint({baseUrl, protocol, path: '/attacker', requestPath: '/attacker'}), baseUrl + path);
    }
  }
  for (const protocol of [undefined, null, '', 'Responses', 'auto', '__proto__', 'constructor', '/responses', ['responses'], {}]) {
    assert.throws(() => deriveAgentEndpoint({baseUrl: 'https://api.example.com/v1', protocol}), TypeError);
  }
  for (const baseUrl of [undefined, null, '', 123, 'https://API.example.com/v1', 'https://api.example.com:443/v1', 'https://api.example.com/v1/', 'https://api.example.com/v1/../other', 'https://api.example.com/v1//other', 'https://api.example.com/%2fother', 'https://api.example.com/v1?secret=x', 'https://user:key@api.example.com/v1', 'https://api.example.com/v1#other', 'file:///v1', 'https://api.example.com\\@elsewhere.example.com/v1', 'https://api.example.com/v1\n']) {
    assert.throws(() => deriveAgentEndpoint({baseUrl, protocol: 'responses'}), TypeError);
  }
});

test('every catalog default stays CC and only explicitly fixture-supported profiles offer Responses', () => {
  const candidates = ['openai', 'deepseek', 'qwen', 'custom', 'ollama'];
  assert.equal(DEFAULT_AGENT_CONFIGURATION.protocol, 'chat_completions');
  for (const preset of AGENT_PRESETS) {
    assert.equal(preset.defaultProtocol, 'chat_completions');
    assert.deepEqual(preset.availableProtocols, candidates.includes(preset.id) ? ['chat_completions', 'responses'] : ['chat_completions']);
    for (const platform of preset.platforms) {
      assert.equal(platform.defaultProtocol, 'chat_completions');
      assert.deepEqual(platform.availableProtocols, preset.availableProtocols);
      assert.ok(Object.isFrozen(platform.availableProtocols));
      const configuration = {presetId: preset.id, platformId: platform.id, baseUrl: platform.baseUrl || 'https://api.example.com/v1', model: platform.model || 'user-model', protocol: 'chat_completions'};
      assert.deepEqual(parseAgentConfiguration(configuration), configuration);
      if (candidates.includes(preset.id)) {
        assert.deepEqual(parseAgentConfiguration({...configuration, protocol: 'responses'}), {...configuration, protocol: 'responses'});
        assert.ok(Object.isFrozen(platform.supportedModelHints.responses));
      } else assert.throws(() => parseAgentConfiguration({...configuration, protocol: 'responses'}), {code: 'AGENT_SETTINGS_VALIDATION'});
    }
  }
  const qwen = AGENT_PRESETS.find(preset => preset.id === 'qwen');
  for (const platform of qwen.platforms) {
    assert.equal(platform.model, 'qwen-plus');
    assert.deepEqual(platform.supportedModelHints.responses, ['qwen3.8-flash']);
    assert.match(platform.protocolNotes.responses, /截断无法禁用/);
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
