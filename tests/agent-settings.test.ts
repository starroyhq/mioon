import type {Failure} from './helpers/strict-agent-workspace-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {normalizeAgentBaseUrl, parseAgentConfiguration, parseAgentSettingsUpdate, agentSettingsError, safeAgentSettingsError} from '../packages/business/src/agent/config.ts';
import {createAgentSettings, sanitizeAgentSettingsResult} from '../packages/business/src/agent/settings.ts';
import {AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import type {SettingsEnvelope} from '../packages/business/src/agent/settings-envelope.ts';
import {adapterSettings, adapterMetadata, ADAPTER_CUSTOM_SERVICE_KEY} from './helpers/agent-adapter-fixture.ts';
import {testAgentExecution, testAgentCredential} from './helpers/agent-settings-fixture.ts';
import type { BinaryLike } from 'crypto';
import type { WithImplicitCoercion } from 'buffer';

const configuration = () => ({...DEFAULT_AGENT_CONFIGURATION});
const input = (revision = 0, secret: Record<string,unknown>|null = {action: 'keep'}, config = configuration()) => ({
  ...adapterMetadata(adapterSettings(config, {revision})),
  secretActions: [secret === null ? null : {serviceKey: config.presetId === 'custom' ? ADAPTER_CUSTOM_SERVICE_KEY : config.presetId, ...secret}],
});
function persistedSecret(value: SettingsEnvelope|null, serviceKey = 'openai') {assert.ok(value); const entry = value.services.find(item => item.serviceKey === serviceKey); assert.ok(entry); return entry.secret;}
function memoryPersistence() {
  let value: unknown = null;
  return {load: async () => structuredClone(value), save: async (candidate: unknown) => { value = structuredClone(candidate); }, get value() { return structuredClone(value) as SettingsEnvelope|null; }};
}
// Synthetic local test cipher, never a production vault/fallback.
function syntheticCodec() {
  const key = randomBytes(32);
  return {
    encrypt(value: BinaryLike) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(value: WithImplicitCoercion<string>) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); },
  };
}
const persistent = {persistentAvailable: true, sessionScope: 'app', reasonCode: null} as const;

test('all researched preset families have explicit platform defaults and no executable network work', () => {
  assert.deepEqual(AGENT_PRESETS.map(item => item.id), ['openai', 'anthropic', 'deepseek', 'qwen', 'zhipu', 'kimi', 'minimax', 'openrouter', 'custom', 'ollama']);
  assert.equal(AGENT_PRESETS.find(p => p.id === 'qwen')!.platforms.length, 8);
  for (const preset of AGENT_PRESETS) for (const platform of preset.platforms) {
    assert.ok(platform.id && platform.label);
    if (platform.baseUrl) assert.equal(parseAgentConfiguration({presetId: preset.id, platformId: platform.id, baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol}).baseUrl, platform.baseUrl);
    else assert.ok(preset.id === 'custom' || platform.baseUrlTemplate);
  }
  assert.ok(Object.isFrozen(AGENT_PRESETS[0].platforms[0]));
});

test('remote endpoint syntax blocks credentials, alternate local IP forms and unsafe path parsing without DNS', () => {
  const denied = ['http://api.example.com/v1', 'https://user:key@api.example.com/v1', 'https://@api.example.com/v1', 'https://api.example.com/v1?key=synthetic', 'https://api.example.com/v1#key', 'https://api.example.com/%2fadmin', 'https://api.example.com/v1/../admin', 'https://api.example.com/v1/./', 'https://api.example.com//v1', 'https://api.example.com\\@evil.example.com/v1', 'https://api.example.com/中文', 'https://api.example.com /v1', 'https://localhost/v1', 'https://foo.localhost/v1', 'https://host.local/v1', 'https://metadata.google.internal/v1', 'https://singlelabel/v1', 'https://127.0.0.1/v1', 'https://127.1/v1', 'https://2130706433/v1', 'https://0x7f000001/v1', 'https://0177.0.0.1/v1', 'https://10.0.0.1/v1', 'https://172.31.0.1/v1', 'https://192.168.1.2/v1', 'https://169.254.169.254/v1', 'https://100.100.100.200/v1', 'https://0.0.0.0/v1', 'https://198.18.0.1/v1', 'https://224.0.0.1/v1', 'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://[fd00:ec2::254]/v1', 'https://[fe80::1]/v1', 'https://[2001:db8::1]/v1', 'https://[2002:7f00:1::]/v1'];
  for (const baseUrl of denied) assert.throws(() => normalizeAgentBaseUrl(baseUrl), {code: 'AGENT_SETTINGS_VALIDATION'}, baseUrl);
  assert.equal(normalizeAgentBaseUrl('https://API.Example.com:443/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeAgentBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeAgentBaseUrl('https://8.8.8.8/v1'), 'https://8.8.8.8/v1');
  assert.equal(normalizeAgentBaseUrl('https://[2606:4700:4700::1111]/v1'), 'https://[2606:4700:4700::1111]/v1');
});

test('only explicit local Ollama profile permits loopback /v1 and never current Mioon port', () => {
  const local = {presetId: 'ollama', platformId: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', protocol: 'chat_completions' as const};
  assert.deepEqual(parseAgentConfiguration(local, {selfPort: 4318}), local);
  assert.throws(() => parseAgentConfiguration(local, {selfPort: 11434}), {code: 'AGENT_SETTINGS_VALIDATION'});
  for (const url of ['http://10.0.0.2:11434/v1', 'http://127.0.0.2:11434/v1', 'http://foo.localhost:11434/v1', 'http://localhost:11434/api/chat', 'http://localhost:11434/v1/models', 'https://ollama.com/v1'] as const) assert.throws(() => parseAgentConfiguration({...local, baseUrl: url}), {code: 'AGENT_SETTINGS_VALIDATION'});
  for (const url of ['http://localhost:11434/v1', 'http://[::1]:11434/v1'] as const) assert.equal(parseAgentConfiguration({...local, baseUrl: url}).baseUrl, url);
  assert.throws(() => parseAgentConfiguration({...configuration(), baseUrl: local.baseUrl}), {code: 'AGENT_SETTINGS_VALIDATION'});
});

test('strict mutation/configuration/key shapes and bounds reject unrecognized fields without reflecting values', async t => {
  const persistence = memoryPersistence(), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  const valid = input(0, {action: 'replace', storage: 'session', value: 'synthetic-only'});
  const service = valid.services.find(item => item.serviceKey === 'openai'); assert.ok(service);
  const withService = (patch: Record<string,unknown>) => ({...valid, services: valid.services.map(item => item.serviceKey === 'openai' ? {...item, ...patch} : item)});
  const withSecret = (action: Record<string,unknown>) => ({...valid, secretActions: [{serviceKey:'openai', ...action}]});
  const invalid = [null, [], {}, {...valid, expectedRevision: -1}, {...valid, expectedRevision: .1}, {...valid, expectedRevision: '0'}, {...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1}, {...valid, unexpected: 'synthetic-only'},
    {expectedRevision:0, configuration:configuration(), secret:{action:'keep'}}, withService({apiKey:'synthetic-only'}), withService({presetId:'other'}), withService({platformId:'china'}),
    withService({manualModelIds:['x'.repeat(201)]}), withService({manualModelIds:['bad\nmodel']}), withService({revision:0}), withService({secret:{configured:false,storage:'none'}}),
    {...valid,mioSelection:{serviceKey:'openai',modelId:'x'.repeat(201)}}, {...valid,mioSelection:{serviceKey:'openai',modelId:'bad\nmodel'}},
    withSecret({action:'keep',value:'synthetic-only'}), withSecret({action:'remove',storage:'session'}), withSecret({action:'replace',storage:'sqlite',value:'synthetic-only'})];
  for (const value of ['', ' ', 'x'.repeat(8193), 'é'.repeat(4097), '\nsynthetic-only', 'synthetic\u0000only', 'x\u0085key'] as const) invalid.push(withSecret({action:'replace',storage:'session',value}));
  const safeValidation = (error: unknown) => (error as Failure).code === 'AGENT_SETTINGS_VALIDATION' && !(error as Failure).message.includes('synthetic-only');
  for (const value of invalid) {
    assert.throws(() => parseAgentSettingsUpdate(value), safeValidation);
    await assert.rejects(settings.put(value), safeValidation);
  }
  assert.equal((await settings.get()).revision,0); assert.equal(persistence.value,null);
  for (const value of ['x'.repeat(8192), 'é'.repeat(4096)]) {
    const parsed = parseAgentSettingsUpdate(withSecret({action:'replace',storage:'session',value})).secretActions[0]; assert.equal(parsed?.action,'replace');
    assert.ok(parsed?.action==='replace'); assert.equal(Buffer.byteLength(parsed.value),8192);
  }
  for (const code of ['__proto__', 'constructor', 'toString', 'unknown', undefined] as const) assert.equal(safeAgentSettingsError({code, message: 'synthetic-only'}).code, 'AGENT_SETTINGS_SAVE_FAILED');
  assert.equal(agentSettingsError().code, 'AGENT_SETTINGS_VALIDATION');
});

test('session keys are write-only, never reach envelope, and vanish on fresh engine restart', async () => {
  const persistence = memoryPersistence(), settings = await createAgentSettings({persistence});
  assert.equal((await settings.get()).revision, 0);
  const saved = await settings.put(input(0, {action: 'replace', storage: 'session', value: 'synthetic-session-marker'}));
  assert.deepEqual(testAgentExecution(saved).secret, {configured: true, storage: 'session'});
  assert.equal(saved.storage.sessionScope, 'server'); assert.equal(saved.scope, 'settings_only'); assert.equal(saved.verification, 'not_tested');
  assert.equal(JSON.stringify(saved).includes('synthetic-session-marker'), false);
  assert.equal(JSON.stringify(persistence.value).includes('synthetic-session-marker'), false);
  assert.equal(persistedSecret(persistence.value), null);
  assert.deepEqual(Object.keys(settings).sort(), ['close', 'get', 'put']);
  await settings.close();
  await assert.rejects(settings.get(), {code: 'AGENT_SETTINGS_CLOSED'});
  const restarted = await createAgentSettings({persistence});
  assert.equal((await restarted.get()).revision, 1);
  assert.deepEqual(testAgentExecution(await restarted.get()).secret, {configured: false, storage: 'none'});
  await restarted.close();
});

test('credential binding covers exact normalized endpoint, preset and platform; model and protocol changes retain it', async () => {
  for (const field of ['baseUrl', 'presetId', 'platformId'] as const) {
    const p = memoryPersistence(), settings = await createAgentSettings({persistence: p});
    const start = field === 'platformId' ? {presetId: 'qwen', platformId: 'beijing', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'chat_completions' as const}
      : field === 'baseUrl' ? {...configuration(), presetId:'custom', platformId:'custom', baseUrl:'https://synthetic.example/v1'} : configuration();
    await settings.put(input(0, {action: 'replace', storage: 'session', value: 'synthetic-binding-marker'}, start));
    const changed = {...start};
    if (field === 'baseUrl') changed.baseUrl += '/other';
    if (field === 'presetId') {changed.presetId = 'deepseek'; changed.baseUrl = 'https://api.deepseek.com';}
    if (field === 'platformId') {changed.platformId = 'singapore'; changed.baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';}
    assert.equal(testAgentExecution(await settings.put(input(1, {action: 'keep'}, changed))).secret.configured, false, field);
    await settings.close();
  }
  const settings = await createAgentSettings({persistence: memoryPersistence()});
  await settings.put(input(0, {action: 'replace', storage: 'session', value: 'synthetic-model-marker'}));
  assert.equal(testAgentExecution(await settings.put(input(1, {action: 'keep'}, parseAgentConfiguration({...configuration(), baseUrl: 'https://API.OPENAI.COM:443/v1/', model: 'user-model'})))).secret.configured, true);
  assert.equal(testAgentExecution(await settings.put(input(2, {action: 'keep'}, {...configuration(), protocol:'responses'}))).secret.configured, true);
  assert.equal(testAgentExecution(await settings.put(input(3, {action: 'remove'}, configuration()))).secret.configured, false);
  await settings.close();
});

test('CAS serializes concurrent saves, every successful save increments, stale writes cannot replace secrets', async () => {
  const persistence = memoryPersistence(), settings = await createAgentSettings({persistence});
  const results = await Promise.allSettled(Array.from({length: 12}, (_, i) => settings.put(input(0, {action: 'replace', storage: 'session', value: `synthetic-racer-${i}`}))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const failure of results.filter(r => r.status === 'rejected')) assert.equal(failure.reason.code, 'AGENT_SETTINGS_CONFLICT');
  assert.equal((await settings.get()).revision, 1);
  assert.equal((await settings.put(input(1))).revision, 2);
  assert.equal((await settings.put(input(2))).revision, 3);
  assert.equal(persistence.value!.revision, 3);
});

test('failed replacements, removals and binding edits preserve prior atomic envelope and RAM state', async () => {
  const persistence = memoryPersistence(), settings = await createAgentSettings({persistence});
  const saved = await settings.put(input(0, {action: 'replace', storage: 'session', value: 'synthetic-original'}));
  const previous = persistence.value;
  persistence.save = async () => { throw new Error('synthetic-original native raw failure'); };
  for (const update of [input(1, {action: 'remove'}), input(1, {action: 'replace', storage: 'session', value: 'synthetic-replacement'}), input(1, {action: 'keep'}, {...configuration(), presetId:'custom', platformId:'custom', baseUrl: 'https://changed.example.com/v1'})] as const) {
    await assert.rejects(settings.put(update), error => (error as Failure).code === 'AGENT_SETTINGS_SAVE_FAILED' && !(error as Failure).message.includes('synthetic'));
    assert.deepEqual(await settings.get(), saved);
    assert.deepEqual(persistence.value, previous);
  }
});

test('persistent encryption, restart validation, explicit fallback and deletion use one envelope', async () => {
  const persistence = memoryPersistence(), secretCodec = syntheticCodec();
  let available = true;
  const storage = () => available ? persistent : {...persistent, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE' as const};
  const settings = await createAgentSettings({persistence, secretCodec, storage});
  const first = await settings.put(input(0, {action: 'replace', storage: 'persistent', value: 'synthetic-persistent-marker'}));
  assert.deepEqual(testAgentExecution(first).secret, {configured: true, storage: 'persistent'});
  assert.equal(JSON.stringify(persistence.value).includes('synthetic-persistent-marker'), false);
  const ciphertext = persistedSecret(persistence.value); assert.ok(ciphertext);
  assert.equal(JSON.stringify(first).includes(ciphertext.encrypted), false);
  await settings.close();
  let restarted = await createAgentSettings({persistence, secretCodec, storage});
  assert.deepEqual(testAgentExecution(await restarted.get()).secret, testAgentExecution(first).secret);
  available = false;
  await restarted.close(); restarted = await createAgentSettings({persistence, secretCodec, storage});
  assert.equal(testAgentExecution(await restarted.get()).secret.configured, true, 'stored key is not silently deleted while OS vault is locked');
  await assert.rejects(restarted.put(input(1, {action: 'replace', storage: 'persistent', value: 'synthetic-failed'})), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await restarted.get()).revision, 1);
  assert.equal(testAgentExecution(await restarted.put(input(1, {action: 'replace', storage: 'session', value: 'synthetic-explicit-fallback'}))).secret.storage, 'session');
  assert.equal(persistedSecret(persistence.value), null);
  assert.equal(testAgentExecution(await restarted.put(input(2, {action: 'remove'}))).secret.configured, false);
  await restarted.close();
});

test('unreadable persistent ciphertext stays stored but fails closed and allows explicit new session key', async () => {
  const persistence = memoryPersistence(), secretCodec = syntheticCodec();
  const settings = await createAgentSettings({persistence, secretCodec, storage: persistent});
  await settings.put(input(0, {action: 'replace', storage: 'persistent', value: 'synthetic-old'}));
  await settings.close();
  const restart = await createAgentSettings({persistence, secretCodec: {...secretCodec, decrypt() { throw Error('synthetic-unreadable'); }}, storage: persistent});
  const status = await restart.get();
  assert.equal(testAgentExecution(status).secret.configured, true);
  const original = persistence.value;
  await assert.rejects(restart[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(status)), {code:'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.deepEqual(persistence.value, original, 'failed trusted decryption never deletes the stored ciphertext');
  assert.equal(testAgentExecution(await restart.put(input(1, {action: 'replace', storage: 'session', value: 'synthetic-new'}))).secret.storage, 'session');
  await restart.close();
});

test('corrupt metadata fails closed only for settings and strict public serializer rejects hidden fields without reflection', async () => {
  const settings = await createAgentSettings({persistence: {load: async () => ({version: 999, value: 'synthetic-corrupt'}), save: async () => { assert.fail('must not overwrite corruption'); }}});
  await assert.rejects(settings.get(), {code: 'AGENT_SETTINGS_CORRUPT'});
  await assert.rejects(settings.put(input()), {code: 'AGENT_SETTINGS_CORRUPT'});
  const healthy = await createAgentSettings({persistence: memoryPersistence()});
  const snapshot = await healthy.get();
  assert.throws(() => sanitizeAgentSettingsResult({...snapshot, encrypted: 'synthetic-ciphertext', value: 'synthetic-key'}), error =>
    (error as Failure).code === 'AGENT_SETTINGS_CORRUPT' && !(error as Failure).message.includes('synthetic'));
  assert.deepEqual(sanitizeAgentSettingsResult(snapshot), snapshot);
  await settings.close(); await healthy.close();
});
