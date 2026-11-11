import type {Failure} from './helpers/strict-agent-workspace-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE, sanitizeAgentSettingsResult} from '../packages/business/src/agent/settings.ts';
import type {AgentSettingsService, AgentSettingsSnapshot} from '../packages/business/src/agent/settings.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {parseCurrentEnvelope, serviceBinding} from '../packages/business/src/agent/settings-envelope.ts';
import {agentServiceInput} from '../packages/contracts/src/agent-connection-settings.ts';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.ts';
import {adapterMetadata, adapterSettings} from './helpers/agent-adapter-fixture.ts';
import {putTestAgentConfiguration, testAgentExecution, testAgentCredential} from './helpers/agent-settings-fixture.ts';
import type {BinaryLike} from 'node:crypto';
import type {WithImplicitCoercion} from 'node:buffer';

const KEY = 'SYNTHETIC_MIGRATION_KEY_NEVER_LIVE';
const persistent = {persistentAvailable:true, sessionScope:'app', reasonCode:null} as const;
const locked = {...persistent, persistentAvailable:false, reasonCode:'OS_SECRET_STORE_UNAVAILABLE'} as const;
const cc = () => ({...DEFAULT_AGENT_CONFIGURATION,model:'gpt-4.1-mini',protocol:'chat_completions' as const});
const responses = () => ({...cc(), baseUrl:'https://api.openai.com/v1', protocol:'responses' as const});
const legacyConfiguration = () => {const {protocol, ...legacy} = cc(); return legacy;};
const envelope = (configuration:Record<string,unknown> = legacyConfiguration(), version = 1, secret:Record<string,unknown>|null = null, revision = 7) => ({version, revision, configuration, secret});
const legacyBinding = (configuration:Record<string,unknown>) => JSON.stringify([configuration.presetId, configuration.platformId, configuration.baseUrl]);
const candidate = (revision = 7) => ({...adapterMetadata(adapterSettings(cc(), {revision})), secretActions:[]});
const save = (settings:AgentSettingsService, expectedRevision:number, configuration:AgentConfiguration, secret:Record<string,unknown> = {action:'keep'}) =>
  putTestAgentConfiguration(settings, {expectedRevision, configuration, secret});
const acquire = (settings:AgentSettingsService, snapshot:AgentSettingsSnapshot) => settings[AGENT_CREDENTIAL_ACQUIRE](testAgentCredential(snapshot));
function memory(seed:unknown) {
  let value:unknown = structuredClone(seed), writes = 0;
  return {load:async () => structuredClone(value), save:async (candidate:unknown) => {writes++; value = structuredClone(candidate);},
    get value() {return structuredClone(value);}, get writes() {return writes;}};
}
function codec() {
  const key = randomBytes(32); let encryptions = 0, decryptions = 0;
  return {
    encrypt(text:BinaryLike) {encryptions++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64');},
    decrypt(text:WithImplicitCoercion<string>) {decryptions++; const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();},
    get encryptions() {return encryptions;}, get decryptions() {return decryptions;},
  };
}
function encryptedLegacy(vault:ReturnType<typeof codec>, configuration:Record<string,unknown> = legacyConfiguration(), version = 1) {
  const binding = legacyBinding(configuration);
  return envelope(configuration, version, {binding, encrypted:vault.encrypt(JSON.stringify({version:1, binding, value:KEY}))});
}

test('strict legacy metadata projects CC only in memory, with no read-time revision or disk write', async t => {
  const seed = envelope(), persistence = memory(seed), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  const snapshot = await settings.get();
  assert.equal(snapshot.revision, 7); assert.deepEqual(testAgentExecution(snapshot).configuration, cc());
  assert.ok(snapshot.notices.includes('LEGACY_KEYS_CLEARED'));
  assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
  assert.equal((await acquire(settings, snapshot)).apiKey, null);
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision:7, configuration:legacyConfiguration()}), {code:'AGENT_SETTINGS_VALIDATION'});
  await assert.rejects(settings.put({expectedRevision:7, configuration:legacyConfiguration(), secret:{action:'keep'}}), {code:'AGENT_SETTINGS_VALIDATION'});
  assert.throws(() => sanitizeAgentSettingsResult({...snapshot, configuration:legacyConfiguration()}), {code:'AGENT_SETTINGS_CORRUPT'});
  assert.equal(persistence.writes, 0);
  const saved = await save(settings, 7, responses());
  assert.equal(saved.revision, 8); assert.deepEqual(testAgentExecution(saved).configuration, responses());
  const stored = parseCurrentEnvelope(persistence.value);
  assert.equal(stored.version, 3); assert.equal(stored.revision, 8); assert.ok(stored.services.every(service => service.secret === null));
  const restarted = await createAgentSettings({persistence}); t.after(() => restarted.close());
  assert.deepEqual(await restarted.get(), saved);
});

test('legacy custom settings keep CC even when their URL and model look like Anthropic', async t => {
  const legacy = {presetId:'custom', platformId:'custom', baseUrl:'https://api.anthropic.com', model:'claude-haiku-4-5'};
  const seed = envelope(legacy), persistence = memory(seed), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  const snapshot = await settings.get();
  assert.deepEqual(testAgentExecution(snapshot).configuration, {...legacy, protocol:'chat_completions'});
  assert.match(testAgentExecution(snapshot).binding.serviceKey, /^[a-f0-9-]{36}$/u);
  assert.deepEqual((await settings.get()).mioSelection, snapshot.mioSelection);
  assert.equal(snapshot.revision, 7); assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
});

test('legal legacy official URLs reset to the catalog, with the permitted platform default and notice', async t => {
  const minimax = {presetId:'minimax', platformId:'china', baseUrl:'https://api.minimax.cn/user-prefix', model:'MiniMax-M3'};
  const cases = [
    {seed:envelope(minimax), expected:{...minimax, baseUrl:'https://api.minimax.cn/v1', protocol:'chat_completions'}},
    {seed:envelope({...minimax, protocol:'chat_completions'}, 2), expected:{...minimax, baseUrl:'https://api.minimax.cn/v1', protocol:'chat_completions'}},
    {seed:envelope({presetId:'anthropic', platformId:'global', baseUrl:'https://old-gateway.example/compat', model:'claude-haiku-4-5', protocol:'chat_completions'}, 2),
      expected:{presetId:'anthropic', platformId:'global', baseUrl:'https://api.anthropic.com', model:'claude-haiku-4-5', protocol:'anthropic_messages'}},
  ];
  for (const {seed, expected} of cases) {
    const persistence = memory(seed), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
    const snapshot = await settings.get(); assert.deepEqual(testAgentExecution(snapshot).configuration, expected);
    assert.ok(snapshot.notices.includes('LEGACY_ENDPOINT_RESET')); assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
  }
});

test('actual v1 settings file stays byte-identical until first authorized atomic v3 save', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-agent-migration-')); t.after(() => rm(root, {recursive:true, force:true}));
  const persistence = createAgentSettingsFile({directory:path.join(root, 'settings')}), file = path.join(root, 'settings/settings.json');
  await persistence.save(envelope());
  const bytes = await readFile(file), before = await stat(file), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  await settings.get(); assert.deepEqual(await readFile(file), bytes); assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await save(settings, 7, responses());
  const stored = parseCurrentEnvelope(JSON.parse(await readFile(file, 'utf8')));
  assert.equal(stored.version, 3); assert.equal(stored.revision, 8); assert.equal(stored.services.find(service => service.serviceKey === 'openai')?.protocol, 'responses');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('legal unmappable legacy workspace metadata resets to no Mio selection without a read-time save', async t => {
  const legacy={presetId:'qwen',platformId:'workspace-cn-beijing',baseUrl:'https://old-gateway.example/v1',model:'qwen-plus',protocol:'chat_completions'};
  const seed=envelope(legacy,2),persistence=memory(seed),settings=await createAgentSettings({persistence});t.after(()=>settings.close());
  const snapshot=await settings.get();assert.equal(snapshot.revision,7);assert.equal(snapshot.execution,null);assert.equal(snapshot.mioSelection,null);
  assert.deepEqual(snapshot.notices,['LEGACY_SETTINGS_RESET']);assert.ok(snapshot.services.every(entry=>entry.manualModelIds.length===0&&!entry.secret.configured));
  assert.deepEqual(persistence.value,seed);assert.equal(persistence.writes,0);
  const saved=await settings.put(candidate(7));assert.equal(saved.revision,8);assert.equal(parseCurrentEnvelope(persistence.value).version,3);
});

test('unknown versions and malformed legacy/current shapes fail closed without overwriting existing data', async t => {
  const seeds = [
    ...[0, 3, 4, -1, '1', null, undefined].map(version => ({...envelope(), version})),
    {...envelope(), revision:-1}, {...envelope(), revision:1.5}, {...envelope(), revision:Number.MAX_SAFE_INTEGER + 1},
    {...envelope(), extra:true}, {...envelope(), secret:undefined},
    envelope({...legacyConfiguration(), protocol:'chat_completions'}), envelope({...legacyConfiguration(), protocol:'responses'}),
    envelope({...legacyConfiguration(), apiKey:KEY}), envelope({...legacyConfiguration(), model:' gpt-4.1-mini '}),
    envelope({...legacyConfiguration(), baseUrl:'https://API.OPENAI.COM:443/v1/'}), envelope({...legacyConfiguration(), platformId:'missing'}),
    envelope(legacyConfiguration(), 2), envelope({...responses(), protocol:'unknown'}, 2), envelope({...responses(), extra:true}, 2),
    envelope(legacyConfiguration(), 1, {binding:'wrong', encrypted:'AAAA'}),
    envelope(legacyConfiguration(), 1, {binding:legacyBinding(cc()), encrypted:'not base64'}),
  ];
  for (const seed of seeds) {
    const persistence = memory(seed), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code:'AGENT_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put(candidate()), {code:'AGENT_SETTINGS_CORRUPT'});
    assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
  }
});

test('locked legacy vault discards the old key without decrypting and the first v3 keep cannot adopt it', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed);
  const settings = await createAgentSettings({persistence, secretCodec:vault, storage:locked}); t.after(() => settings.close());
  const before = await settings.get();
  assert.equal(testAgentExecution(before).secret.configured, false); assert.equal(before.storage.persistentAvailable, false);
  assert.equal(persistence.writes, 0); assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
  assert.deepEqual(persistence.value, seed); assert.equal((await acquire(settings, before)).apiKey, null);
  const saved = await save(settings, 7, responses()), stored = parseCurrentEnvelope(persistence.value);
  assert.equal(saved.revision, 8); assert.ok(stored.services.every(service => service.secret === null));
  assert.equal(JSON.stringify(stored).includes(String(seed.secret?.encrypted)), false);
  assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
  const restart = await createAgentSettings({persistence, secretCodec:vault, storage:persistent}); t.after(() => restart.close());
  assert.deepEqual(testAgentExecution(await restart.get()).configuration, responses());
  assert.equal((await acquire(restart, await restart.get())).apiKey, null); assert.equal(vault.decryptions, 0);
});

test('unreadable legacy vault is never invoked by projection, keep, acquisition or removal', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed); let reads = 0;
  const unavailableCodec = {encrypt() {assert.fail('must not re-encrypt keep');}, decrypt() {reads++; throw Error(KEY);}};
  const settings = await createAgentSettings({persistence, secretCodec:unavailableCodec, storage:persistent}); t.after(() => settings.close());
  const snapshot = await settings.get(); assert.equal(reads, 0); assert.equal(testAgentExecution(snapshot).secret.configured, false);
  assert.deepEqual(persistence.value, seed); assert.equal(persistence.writes, 0);
  const saved = await save(settings, 7, responses()); assert.equal(reads, 0);
  assert.ok(parseCurrentEnvelope(persistence.value).services.every(service => service.secret === null));
  assert.equal((await acquire(settings, saved)).apiKey, null); assert.equal(reads, 0);
  assert.equal(testAgentExecution(await save(settings, 8, responses(), {action:'remove'})).secret.configured, false);
});

test('a valid legacy key is not read, and explicit replacement creates the new service namespace', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed);
  const settings = await createAgentSettings({persistence, secretCodec:vault, storage:persistent}); t.after(() => settings.close());
  const old = await settings.get(); assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
  assert.equal((await acquire(settings, old)).apiKey, null); assert.equal(vault.decryptions, 0);
  const newKey = KEY + '_REENTERED';
  const saved = await save(settings, 7, responses(), {action:'replace', storage:'persistent', value:newKey});
  await assert.rejects(acquire(settings, old), {code:'AGENT_SETTINGS_CONFLICT'});
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({...testAgentCredential(saved), configuration:testAgentExecution(old).configuration}), {code:'AGENT_SETTINGS_CONFLICT'});
  assert.equal(vault.decryptions, 0, 'stale execution witness and configuration fail before decryption');
  assert.equal((await acquire(settings, saved)).apiKey, newKey); assert.equal(vault.decryptions, 1); assert.equal(vault.encryptions, 2);
  const stored = parseCurrentEnvelope(persistence.value), entry = stored.services.find(service => service.serviceKey === 'openai'); assert.ok(entry?.secret);
  const plaintext = JSON.parse(vault.decrypt(entry.secret.encrypted));
  assert.deepEqual(plaintext, {version:2, serviceKey:'openai', binding:serviceBinding(entry), value:newKey});
  assert.notEqual(entry.secret.binding, seed.secret?.binding); assert.notEqual(entry.secret.encrypted, seed.secret?.encrypted);
  assert.equal(JSON.stringify(stored).includes(KEY), false);
});

test('protocol/model-only session edits keep the key, but full configuration and execution witness gate acquisition', async t => {
  const persistence = memory(null), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  const first = await save(settings, 0, cc(), {action:'replace', storage:'session', value:KEY});
  const changed = await save(settings, 1, responses()); assert.equal((await acquire(settings, changed)).apiKey, KEY);
  await assert.rejects(acquire(settings, first), {code:'AGENT_SETTINGS_CONFLICT'});
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({...testAgentCredential(changed), configuration:cc()}), {code:'AGENT_SETTINGS_CONFLICT'});
  const newModel = await save(settings, 2, {...responses(), model:'gpt-4.1-mini-2025-04-14'});
  assert.equal((await acquire(settings, newModel)).apiKey, KEY);
  assert.ok(parseCurrentEnvelope(persistence.value).services.every(service => service.secret === null)); assert.equal(JSON.stringify(persistence.value).includes(KEY), false);
});

test('explicit Messages changes retain newly bound v3 ciphertext across restart while stale acquisition fails', async t => {
  for (const presetId of ['custom', 'minimax']) {
    const vault = codec(), persistence = memory(null), settings = await createAgentSettings({persistence, secretCodec:vault, storage:persistent}); t.after(() => settings.close());
    const configuration = {...cc(), presetId, platformId:presetId === 'custom' ? 'custom' : 'china', baseUrl:presetId === 'custom' ? 'https://compat.example.com/anthropic' : 'https://api.minimax.cn/v1', model:'explicit-model'};
    const before = await save(settings, 0, configuration, {action:'replace', storage:'persistent', value:KEY});
    const first = parseCurrentEnvelope(persistence.value), ciphertext = first.services.find(service => service.serviceKey === testAgentExecution(before).binding.serviceKey)?.secret?.encrypted; assert.ok(ciphertext);
    const selected = {...configuration, baseUrl:presetId === 'custom' ? configuration.baseUrl : 'https://api.minimax.cn/anthropic', protocol:'anthropic_messages' as const};
    const changed = await save(settings, 1, selected), stored = parseCurrentEnvelope(persistence.value);
    assert.equal(testAgentExecution(changed).configuration.protocol, 'anthropic_messages'); assert.equal(stored.version, 3);
    assert.equal(stored.services.find(service => service.serviceKey === testAgentExecution(changed).binding.serviceKey)?.secret?.encrypted, ciphertext); assert.equal(vault.encryptions, 1);
    assert.equal((await acquire(settings, changed)).apiKey, KEY); await assert.rejects(acquire(settings, before), {code:'AGENT_SETTINGS_CONFLICT'});
    const restarted = await createAgentSettings({persistence, secretCodec:vault, storage:persistent}); t.after(() => restarted.close());
    const restored = await restarted.get(); assert.deepEqual(testAgentExecution(restored).configuration, selected);
    assert.equal((await acquire(restarted, restored)).apiKey, KEY); assert.equal(vault.encryptions, 1);
    assert.equal(JSON.stringify(persistence.value).includes(KEY), false);
  }
});

test('preset/platform/custom path edits cannot recover any legacy key even with a locked vault', async t => {
  const cases = [
    {legacy:legacyConfiguration(), changed:{...responses(), presetId:'deepseek', baseUrl:'https://api.deepseek.com'}},
    {legacy:{...legacyConfiguration(), presetId:'custom', platformId:'custom', baseUrl:'https://compat.example.com/v1'}, changed:{...responses(), presetId:'custom', platformId:'custom', baseUrl:'https://compat.example.com/v1/other'}},
    {legacy:{...legacyConfiguration(), presetId:'qwen', platformId:'beijing', baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'}, changed:{...responses(), presetId:'qwen', platformId:'singapore', baseUrl:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'}},
  ];
  for (const {legacy, changed} of cases) {
    const vault = codec(), persistence = memory(encryptedLegacy(vault, legacy));
    const settings = await createAgentSettings({persistence, secretCodec:vault, storage:locked}); t.after(() => settings.close());
    const saved = await save(settings, 7, changed);
    assert.equal(testAgentExecution(saved).secret.configured, false); assert.ok(parseCurrentEnvelope(persistence.value).services.every(service => service.secret === null));
    assert.equal(vault.decryptions, 0); assert.equal((await acquire(settings, saved)).apiKey, null);
  }
});

test('failed first migration saves and stale CAS preserve legacy bytes and the old in-memory projection', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed), write = persistence.save;
  const settings = await createAgentSettings({persistence, secretCodec:vault, storage:locked}); t.after(() => settings.close());
  const snapshot = await settings.get(); persistence.save = async () => {throw Error(KEY);};
  await assert.rejects(save(settings, 7, responses()), error => (error as Failure).code === 'AGENT_SETTINGS_SAVE_FAILED' && !(error as Failure).message.includes(KEY));
  assert.deepEqual(await settings.get(), snapshot); assert.deepEqual(persistence.value, seed);
  await assert.rejects(save(settings, 6, responses(), {action:'remove'}), {code:'AGENT_SETTINGS_CONFLICT'});
  persistence.save = write;
  const racers = await Promise.allSettled([save(settings, 7, responses()), save(settings, 7, cc(), {action:'remove'})]);
  assert.equal(racers[0].status, 'fulfilled'); assert.ok(racers[1].status === 'rejected'); assert.equal(racers[1].reason.code, 'AGENT_SETTINGS_CONFLICT');
  const stored = parseCurrentEnvelope(persistence.value); assert.equal(stored.version, 3); assert.equal(stored.revision, 8); assert.ok(stored.services.every(service => service.secret === null));
  assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
});

test('web engines project encrypted desktop v1/v2 metadata without adopting keys or overwriting the source', async t => {
  const vault = codec();
  for (const stored of [encryptedLegacy(vault), encryptedLegacy(vault, responses(), 2)]) {
    const persistence = memory(stored), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
    const snapshot = await settings.get(); assert.equal(testAgentExecution(snapshot).secret.configured, false);
    assert.ok(snapshot.notices.includes('LEGACY_KEYS_CLEARED')); assert.equal((await acquire(settings, snapshot)).apiKey, null);
    assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, stored); assert.equal(vault.decryptions, 0);
    await save(settings, 7, responses()); assert.ok(parseCurrentEnvelope(persistence.value).services.every(service => service.secret === null));
  }
});

test('v3 rejects copied cross-service bindings and channel-valid ciphertext from another service', async t => {
  const vault = codec(), persistence = memory(null), settings = await createAgentSettings({persistence, secretCodec:vault, storage:persistent}); t.after(() => settings.close());
  const configuration = {...cc(), presetId:'custom', platformId:'custom', baseUrl:'https://compat.example.com/v1'};
  const first = await save(settings, 0, configuration, {action:'replace', storage:'persistent', value:KEY});
  const keyA = testAgentExecution(first).binding.serviceKey, entryA = first.services.find(service => service.serviceKey === keyA); assert.ok(entryA);
  const keyB = '22222222-3333-4444-8555-666666666666', entryB = {...agentServiceInput(entryA), serviceKey:keyB, name:'Second service'};
  await settings.put({expectedRevision:first.revision, services:[...first.services.map(agentServiceInput), entryB], mioSelection:{serviceKey:keyB, modelId:configuration.model}, secretActions:[]});
  const source = parseCurrentEnvelope(persistence.value), secretA = source.services.find(service => service.serviceKey === keyA)?.secret; assert.ok(secretA);
  for (const binding of ['copied', 'retargeted']) {
    const copied = structuredClone(source), second = copied.services.find(service => service.serviceKey === keyB); assert.ok(second);
    second.secret = {...secretA, binding:binding === 'copied' ? secretA.binding : serviceBinding(second)};
    const p = memory(copied), engine = await createAgentSettings({persistence:p, secretCodec:vault, storage:persistent}); t.after(() => engine.close());
    const reads = vault.decryptions;
    if (binding === 'copied') {await assert.rejects(engine.get(), {code:'AGENT_SETTINGS_CORRUPT'}); assert.equal(vault.decryptions, reads);}
    else {const current = await engine.get(); await assert.rejects(acquire(engine, current), {code:'AGENT_SETTINGS_STORAGE_UNAVAILABLE'}); assert.equal(vault.decryptions, reads + 1);}
    assert.equal(p.writes, 0); assert.deepEqual(p.value, copied);
  }
});
