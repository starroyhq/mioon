import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_PRESETS,DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {agentChatProfile,agentResponsesProfile,agentModelTokenLimits,agentModelAdaptation,agentModelThinkingTier,agentResponsesReasoningCapable,agentAdaptedModelHints,AGENT_OPENAI_REASONING_OUTPUT_TOKENS} from '../packages/business/src/agent/model-profiles.ts';
import {agentCredentialBinding, parseAgentConfiguration} from '../packages/business/src/agent/config.ts';
import {agentProviderCatalogSchema, resolveAgentPresetBaseUrl} from '../packages/contracts/src/agent-provider-catalog.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {agentOpenAiReasoningFamily} from '../packages/contracts/src/agent-openai-model-family.ts';

const c = 'chat_completions', r = 'responses', m = 'anthropic_messages';
function configuration(presetId: string, platformId: string, protocol: AgentProtocol, addressInput?: string): AgentConfiguration {
  return {presetId, platformId, protocol, model: 'synthetic-model', baseUrl: resolveAgentPresetBaseUrl(AGENT_PRESETS, presetId, platformId, protocol, addressInput)};
}

test('current OpenAI defaults use GPT-6.1 Terra over Responses while older models remain explicit options',()=>{
 assert.equal(DEFAULT_AGENT_CONFIGURATION.model,'gpt-6.1-terra');
 assert.equal(DEFAULT_AGENT_CONFIGURATION.protocol,r);
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openai')?.platforms[0]?.model,'gpt-6.1-terra');
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openrouter')?.platforms[0]?.model,'openai/gpt-6.1-terra');
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openrouter')?.defaultProtocol,c);
 assert.doesNotMatch(AGENT_PRESETS.find(preset=>preset.id==='openai')!.description,/非推理文本基线/);
 assert.ok(AGENT_PRESETS.find(preset=>preset.id==='openai')!.supportedModelHints?.responses?.includes('gpt-5.4-mini'));
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openai')!.supportedModelHints?.responses?.includes('gpt-4.1-mini'),false);
});

test('Qwen and Kimi defaults advance only on their existing platforms while deferred and Q11 defaults stay fixed',()=>{
 const qwen=AGENT_PRESETS.find(preset=>preset.id==='qwen')!,kimi=AGENT_PRESETS.find(preset=>preset.id==='kimi')!;
 assert.equal(qwen.platforms.length,8);assert.equal(kimi.platforms.length,2);
 for(const platform of qwen.platforms){
  assert.equal(platform.model,'qwen3.8-flash',platform.id);
  assert.deepEqual(platform.availableProtocols,[c,r,m],platform.id);
  for(const protocol of platform.availableProtocols){
   const config={...configuration('qwen',platform.id,protocol,platform.addressMode==='workspace'?'synthetic-workspace':undefined),model:'qwen3.8-flash'};
   assert.equal(agentModelAdaptation(config),'adapted',`${platform.id}/${protocol}`);
  }
 }
 for(const platform of kimi.platforms){
  assert.equal(platform.model,'kimi-k3.1-pro',platform.id);
  assert.deepEqual(platform.availableProtocols,[c],platform.id);
  assert.ok(platform.protocols[r]?.blockedReason);assert.ok(platform.protocols[m]?.blockedReason);
  assert.equal(agentModelAdaptation({...configuration('kimi',platform.id,c),model:'kimi-k3.1-pro'}),'adapted');
 }
 assert.equal(qwen.defaultProtocol,c);assert.equal(kimi.defaultProtocol,c);
 for(const platform of AGENT_PRESETS.find(preset=>preset.id==='zhipu')!.platforms)assert.equal(platform.model,'glm-4.7',platform.id);
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='ollama')!.platforms[0]!.model,'qwen3:8b');
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='deepseek')!.platforms[0]!.model,'deepseek-flash');
 assert.deepEqual(DEFAULT_AGENT_CONFIGURATION,{presetId:'openai',platformId:'global',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra',protocol:r});
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openrouter')!.platforms[0]!.model,'openai/gpt-6.1-terra');
 assert.equal(AGENT_PRESETS.find(preset=>preset.id==='openrouter')!.defaultProtocol,c);
});

test('Sonnet 5.5 is the current Anthropic default while Haiku remains independent and all protocol defaults stay fixed',()=>{
 const anthropic=AGENT_PRESETS.find(preset=>preset.id==='anthropic')!;
 assert.equal(anthropic.platforms.length,1);assert.equal(anthropic.platforms[0]!.id,'global');
 assert.equal(anthropic.platforms[0]!.model,'claude-sonnet-5-5');assert.equal(anthropic.platforms[0]!.baseUrl,'https://api.anthropic.com');
 assert.deepEqual(anthropic.availableProtocols,[m]);assert.equal(anthropic.defaultProtocol,m);
 const selected={...configuration('anthropic','global',m),model:'claude-sonnet-5-5'};
 assert.equal(agentModelAdaptation(selected),'adapted');assert.equal(agentModelThinkingTier(selected),'required');
 assert.equal(agentAdaptedModelHints('anthropic').anthropic_messages?.[0],'claude-sonnet-5-5');
 for(const model of ['claude-haiku-4-5','claude-haiku-4-5-20251001']){
  const legacy={...selected,model};assert.equal(agentModelAdaptation(legacy),'adapted',model);assert.equal(agentModelThinkingTier(legacy),'optional',model);
  assert.deepEqual(agentModelTokenLimits(legacy),{contextTokens:200000,outputTokens:16384},model);
 }
 for(const preset of AGENT_PRESETS)assert.equal(preset.defaultProtocol,preset.id==='openai'?r:preset.id==='anthropic'?m:c,preset.id);
});

test('documented OpenAI reasoning families use each supported minimum effort and reserve output for reasoning',()=>{
 for(const [model,effort,tier,contextTokens,maxOutputTokens] of [
  ['gpt-5','minimal','required',400000,128000],['gpt-5-mini-2025-08-07','minimal','required',400000,128000],
  ['gpt-5.1','none','optional',400000,128000],['gpt-5.2','none','optional',400000,128000],
  ['gpt-5.4-mini','none','optional',400000,128000],['gpt-5.4-mini-2026-03-17','none','optional',400000,128000],
  ['gpt-5.4','none','optional',1050000,128000],['o3','low','required',200000,100000],
 ] as const)for(const protocol of [c,r] as const){
  const config={...configuration('openai','global',protocol),model},profile=protocol===c?agentChatProfile(config):agentResponsesProfile(config);
  assert.equal(agentModelAdaptation(config),'adapted',`${model}/${protocol}`);assert.equal(agentModelThinkingTier(config),tier);
  assert.deepEqual(agentModelTokenLimits(config),{contextTokens,outputTokens:profile.outputTokens});assert.equal(profile.maxOutputTokens,maxOutputTokens);
  assert.equal(profile.outputTokens,AGENT_OPENAI_REASONING_OUTPUT_TOKENS);assert.ok(profile.outputTokens<=maxOutputTokens,'The request reserves bounded space below the documented maximum');
  if(protocol===c)assert.equal(profile.fields.reasoning_effort,effort);
  else assert.deepEqual(profile.fields.reasoning,{effort});
 }
});

test('current GPT-6 and GPT-5.6 Responses profiles have their own documented minimum and capacity',()=>{
 for(const [model,effort,tier] of [
  ['gpt-6.1-terra','none','optional'],['gpt-6.1-sol','low','required'],['gpt-6-astra','low','required'],
  ['gpt-6-luna','none','optional'],['gpt-6-sol','none','optional'],
  ['gpt-5.6-sol','none','optional'],['gpt-5.6-terra','none','optional'],['gpt-5.6-luna','none','optional'],['gpt-5.6','none','optional'],
 ] as const){
  const config={...configuration('openai','global',r),model},profile=agentResponsesProfile(config);
  assert.equal(agentResponsesReasoningCapable(config),true,model);assert.equal(agentModelAdaptation(config),'adapted',model);
  assert.equal(agentModelThinkingTier(config),tier);assert.deepEqual(profile.fields,{truncation:'disabled',reasoning:{effort}});
  assert.deepEqual(agentModelTokenLimits(config),{contextTokens:1050000,outputTokens:32768});assert.equal(profile.maxOutputTokens,128000);
  assert.deepEqual(agentOpenAiReasoningFamily(model)?.efforts,tier==='required'?['low','medium','high','xhigh','max']:['none','low','medium','high','xhigh','max'],`${model}: documented efforts include max without inventing none`);
 }
 const luna={...configuration('openai','global',c),model:'gpt-6-luna'};
 assert.equal(agentModelAdaptation(luna),'adapted');assert.deepEqual(agentChatProfile(luna).fields,{store:false,reasoning_effort:'none'});
 for(const model of ['gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra'])assert.equal(agentModelAdaptation({...luna,model}),'unverified',`${model}: Chat Completions cannot run Mio tools`);
});

test('OpenAI suggestions only contain current models and lead with the current generation',()=>{
 const openai=AGENT_PRESETS.find(preset=>preset.id==='openai')!,responses=openai.supportedModelHints!.responses!;
 assert.deepEqual(responses.slice(0,9),['gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra','gpt-6-luna','gpt-6-sol','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.6']);
 for(const model of ['gpt-5.4-nano','gpt-5.3-codex','gpt-5.1','gpt-5','gpt-5-mini','gpt-5-nano','gpt-5-pro','o3','gpt-4.1-mini','o1','o3-mini','o4-mini'])for(const hints of Object.values(openai.supportedModelHints!))assert.equal(hints!.includes(model),false,model);
 const chatHints=agentAdaptedModelHints('openai').chat_completions;assert.ok(chatHints);
 for(const model of ['gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra'])assert.equal(chatHints.includes(model),false,model);
});

test('unrecognized OpenAI special variants remain conservative and the legacy mini profile remains unchanged',()=>{
 for(const protocol of [c,r] as const){
  for(const [model,responseCarrier] of [['gpt-5.1-mini',false],['gpt-5.3-chat-latest',false],['gpt-5-codex',false],['gpt-5.4-codex',true],['o1-preview',false],['o3-deep-research',false],['o3-pro',true],['unknown-model',true]] as const){
   const config={...configuration('openai','global',protocol),model},profile=protocol===c?agentChatProfile(config):agentResponsesProfile(config);
   assert.equal(agentModelAdaptation(config),'unverified');assert.equal(agentModelThinkingTier(config),protocol===r&&responseCarrier?'required':'unsupported');
   assert.equal(agentResponsesReasoningCapable(config),protocol===r&&responseCarrier);
   assert.deepEqual(agentModelTokenLimits(config),{contextTokens:null,outputTokens:4096});
   assert.deepEqual(profile.fields,protocol===c?{store:false}:{truncation:'disabled'});
  }
  const config={...configuration('openai','global',protocol),model:'gpt-4.1-mini'};
  assert.equal(agentModelAdaptation(config),'adapted');assert.equal(agentModelThinkingTier(config),'unsupported');
  assert.deepEqual(agentModelTokenLimits(config),{contextTokens:1047576,outputTokens:4096});
 }
});

test('shut down OpenAI models have no documented policy or reasoning carrier even when entered by hand',()=>{
 for(const model of ['o1','o3-mini','o4-mini-2025-04-16','gpt-5.1-codex','gpt-3.5-turbo'])for(const protocol of [c,r] as const){
  const config={...configuration('openai','global',protocol),model};
  assert.equal(agentOpenAiReasoningFamily(model),null,model);assert.equal(agentModelAdaptation(config),'unverified');assert.equal(agentResponsesReasoningCapable(config),false);
  assert.equal(agentModelThinkingTier(config),'unsupported');assert.deepEqual(agentModelTokenLimits(config),{contextTokens:null,outputTokens:4096});
  assert.deepEqual((protocol===c?agentChatProfile(config):agentResponsesProfile(config)).fields,protocol===c?{store:false}:{truncation:'disabled'});
 }
});

test('documented specialized OpenAI Responses models retain their own minimum instead of borrowing none',()=>{
 for(const [model,effort,contextTokens,maxOutputTokens] of [['gpt-5.3-codex','low',400000,128000],['gpt-5-pro-2025-10-06','high',400000,272000],['gpt-5.4-pro','medium',1050000,128000]] as const){
  const config={...configuration('openai','global',r),model};
  assert.equal(agentResponsesReasoningCapable(config),true);assert.equal(agentModelAdaptation(config),'adapted');
  assert.equal(agentModelThinkingTier(config),'required');assert.deepEqual(agentResponsesProfile(config).fields,{truncation:'disabled',reasoning:{effort}});
  assert.equal(agentResponsesProfile(config).maxOutputTokens,maxOutputTokens);assert.deepEqual(agentModelTokenLimits(config),{contextTokens,outputTokens:32768});
  const chat:AgentConfiguration={...config,protocol:c};assert.equal(agentModelAdaptation(chat),'unverified');assert.deepEqual(agentModelTokenLimits(chat),{contextTokens:null,outputTokens:4096});
 }
});

test('arbitrarily named future official models carry Responses reasoning conservatively without guessing Chat Completions support',()=>{
 for(const model of ['gpt-5.9','gpt-5.9-mini-2027-01-01','future-text-family-2099'])for(const protocol of [c,r] as const){
  const config={...configuration('openai','global',protocol),model},profile=protocol===c?agentChatProfile(config):agentResponsesProfile(config);
  assert.equal(agentResponsesReasoningCapable(config),protocol===r);assert.equal(agentModelAdaptation(config),'unverified');
  assert.equal(agentModelThinkingTier(config),protocol===r?'required':'unsupported');assert.deepEqual(agentModelTokenLimits(config),{contextTokens:null,outputTokens:4096});
  assert.equal(profile.maxOutputTokens,null);assert.deepEqual(profile.fields,protocol===c?{store:false}:{truncation:'disabled'});
 }
 assert.equal(agentResponsesReasoningCapable({...configuration('openai','global',r),model:'gpt-4.1-mini'}),false);
 assert.equal(agentResponsesReasoningCapable({...configuration('custom','custom',r,'https://gateway.example/v1'),model:'gpt-5.4-mini'}),false);
 const router:AgentConfiguration={...configuration('openrouter','global',c),model:'openai/gpt-5.4-mini'};
 assert.equal(agentModelAdaptation(router),'adapted');assert.deepEqual(agentModelTokenLimits(router),{contextTokens:400000,outputTokens:32768});
 assert.deepEqual(agentChatProfile(router).fields,{provider:{require_parameters:true,allow_fallbacks:false},reasoning:{effort:'none'}});
 const responses:AgentConfiguration={...router,protocol:r};assert.equal(agentResponsesReasoningCapable(responses),false);assert.equal(agentModelAdaptation(responses),'unverified');
 assert.deepEqual(agentModelTokenLimits(responses),{contextTokens:null,outputTokens:4096});assert.deepEqual(agentResponsesProfile(responses).fields,{provider:{require_parameters:true,allow_fallbacks:false},reasoning:{enabled:false}});
});

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
