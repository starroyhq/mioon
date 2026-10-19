import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {agentCredentialBinding} from '../packages/business/src/agent/config.ts';
import {createAgentSettings, AGENT_CREDENTIAL_ACQUIRE, sanitizeAgentSettingsResult} from '../packages/business/src/agent/settings.ts';
import {createAgentSettingsFile} from '../packages/business/src/agent/settings-file.ts';

const KEY = 'SYNTHETIC_MIGRATION_KEY_NEVER_LIVE';
const persistent = {persistentAvailable: true, sessionScope: 'app', reasonCode: null};
const locked = {...persistent, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'};
const cc = () => ({...DEFAULT_AGENT_CONFIGURATION});
const responses = () => ({...cc(), protocol: 'responses'});
const legacyConfiguration = () => { const {protocol, ...legacy} = cc(); return legacy; };
const envelope = (configuration = legacyConfiguration(), version = 1, secret = null, revision = 7) => ({version, revision, configuration, secret});
const update = (expectedRevision, configuration, secret = {action: 'keep'}) => ({expectedRevision, configuration, secret});
function memory(seed) {
  let value = structuredClone(seed), writes = 0;
  return {load: async () => structuredClone(value), save: async candidate => { writes++; value = structuredClone(candidate); }, get value() { return structuredClone(value); }, get writes() { return writes; }};
}
function codec() {
  const key = randomBytes(32); let encryptions = 0, decryptions = 0;
  return {
    encrypt(text) { encryptions++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(text) { decryptions++; const bytes = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); },
    get encryptions() { return encryptions; }, get decryptions() { return decryptions; },
  };
}
function encryptedLegacy(vault, configuration = legacyConfiguration()) {
  const binding = agentCredentialBinding(configuration);
  return envelope(configuration, 1, {binding, encrypted: vault.encrypt(JSON.stringify({version: 1, binding, value: KEY}))});
}
const acquire = (settings, snapshot) => settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: snapshot.revision, configuration: snapshot.configuration});

test('strict legacy metadata projects CC only in memory, with no read-time revision or disk write', async t => {
  const seed = envelope(), persistence = memory(seed), settings = await createAgentSettings({persistence});
  t.after(() => settings.close());
  const snapshot = await settings.get();
  assert.equal(snapshot.revision, 7); assert.deepEqual(snapshot.configuration, cc());
  assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
  assert.equal((await acquire(settings, snapshot)).apiKey, null);
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: 7, configuration: legacyConfiguration()}), {code: 'AGENT_SETTINGS_VALIDATION'});
  await assert.rejects(settings.put(update(7, legacyConfiguration())), {code: 'AGENT_SETTINGS_VALIDATION'});
  assert.throws(() => sanitizeAgentSettingsResult({...snapshot, configuration: legacyConfiguration()}), {code: 'AGENT_SETTINGS_VALIDATION'});
  assert.equal(persistence.writes, 0);
  const saved = await settings.put(update(7, responses()));
  assert.equal(saved.revision, 8); assert.deepEqual(saved.configuration, responses());
  assert.deepEqual(persistence.value, envelope(responses(), 2, null, 8));
  const restarted = await createAgentSettings({persistence}); t.after(() => restarted.close());
  assert.deepEqual(await restarted.get(), saved);
});

test('actual v1 settings file stays byte-identical until first authorized atomic v2 save', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-agent-migration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const persistence = createAgentSettingsFile({directory: path.join(root, 'settings')}), file = path.join(root, 'settings/settings.json');
  await persistence.save(envelope());
  const bytes = await readFile(file), before = await stat(file), settings = await createAgentSettings({persistence});
  t.after(() => settings.close());
  await settings.get();
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await settings.put(update(7, responses()));
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 2); assert.equal(stored.revision, 8); assert.equal(stored.configuration.protocol, 'responses');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('unknown versions and malformed legacy/v2 shapes fail closed without overwriting existing data', async t => {
  const seeds = [
    ...[0, 3, -1, '1', null, undefined].map(version => ({...envelope(), version})),
    {...envelope(), revision: -1}, {...envelope(), revision: 1.5}, {...envelope(), revision: Number.MAX_SAFE_INTEGER + 1},
    {...envelope(), extra: true}, {...envelope(), secret: undefined},
    envelope({...legacyConfiguration(), protocol: 'chat_completions'}),
    envelope({...legacyConfiguration(), protocol: 'responses'}), envelope({...legacyConfiguration(), apiKey: KEY}),
    envelope({...legacyConfiguration(), model: ' gpt-4.1-mini '}),
    envelope({...legacyConfiguration(), baseUrl: 'https://API.OPENAI.COM:443/v1/'}),
    envelope({...legacyConfiguration(), platformId: 'missing'}),
    envelope(legacyConfiguration(), 2), envelope({...responses(), protocol: 'unknown'}, 2),
    envelope({...responses(), extra: true}, 2),
    envelope(legacyConfiguration(), 1, {binding: 'wrong', encrypted: 'AAAA'}),
    envelope(legacyConfiguration(), 1, {binding: agentCredentialBinding(cc()), encrypted: 'not base64'}),
  ];
  for (const seed of seeds) {
    const persistence = memory(seed), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'AGENT_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put(update(7, cc())), {code: 'AGENT_SETTINGS_CORRUPT'});
    assert.equal(persistence.writes, 0); assert.deepEqual(persistence.value, seed);
  }
});

test('locked legacy vault preserves ciphertext and exact binding across protocol-only keep and v2 restart', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed);
  const settings = await createAgentSettings({persistence, secretCodec: vault, storage: locked}); t.after(() => settings.close());
  const before = await settings.get();
  assert.equal(before.secret.configured, true); assert.equal(before.storage.persistentAvailable, false);
  assert.equal(persistence.writes, 0); assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
  const saved = await settings.put(update(7, responses()));
  assert.equal(saved.revision, 8); assert.deepEqual(persistence.value.secret, seed.secret);
  assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
  assert.equal(seed.secret.binding, JSON.stringify(['openai', 'global', 'https://api.openai.com/v1']));
  await assert.rejects(acquire(settings, saved), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  const restart = await createAgentSettings({persistence, secretCodec: vault, storage: persistent}); t.after(() => restart.close());
  assert.deepEqual((await restart.get()).configuration, responses());
  assert.equal((await acquire(restart, await restart.get())).apiKey, KEY);
  const payload = JSON.parse(vault.decrypt(persistence.value.secret.encrypted));
  assert.deepEqual(payload, {version: 1, binding: seed.secret.binding, value: KEY});
  assert.equal(vault.encryptions, 1); assert.deepEqual(persistence.value.secret, seed.secret);
});

test('unreadable legacy vault remains visible but unusable; protocol keep never decrypts or re-encrypts', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed); let reads = 0;
  const unavailableCodec = {encrypt() { assert.fail('must not re-encrypt keep'); }, decrypt() { reads++; throw Error(KEY); }};
  const settings = await createAgentSettings({persistence, secretCodec: unavailableCodec, storage: persistent}); t.after(() => settings.close());
  const snapshot = await settings.get(); assert.equal(reads, 1); assert.equal(snapshot.storage.persistentAvailable, false);
  const saved = await settings.put(update(7, responses()));
  assert.equal(reads, 1); assert.deepEqual(persistence.value.secret, seed.secret);
  await assert.rejects(acquire(settings, saved), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal(reads, 1);
  assert.equal((await settings.put(update(8, responses(), {action: 'remove'}))).secret.configured, false);
  assert.equal(persistence.value.secret, null);
});

test('valid legacy ciphertext uses unchanged payload v1 and protocol-aware acquisition without re-encryption', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed);
  const settings = await createAgentSettings({persistence, secretCodec: vault, storage: persistent}); t.after(() => settings.close());
  const old = await settings.get(); assert.equal(vault.decryptions, 1); assert.equal(vault.encryptions, 1);
  const saved = await settings.put(update(7, responses()));
  assert.equal(vault.decryptions, 1); assert.equal(vault.encryptions, 1); assert.deepEqual(persistence.value.secret, seed.secret);
  await assert.rejects(acquire(settings, old), {code: 'AGENT_SETTINGS_CONFLICT'});
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: saved.revision, configuration: old.configuration}), {code: 'AGENT_SETTINGS_CONFLICT'});
  assert.equal(vault.decryptions, 1, 'stale revision or protocol fails before decryption');
  assert.equal((await acquire(settings, saved)).apiKey, KEY);
  assert.equal(vault.decryptions, 2); assert.equal(vault.encryptions, 1);
});

test('protocol/model-only session edits keep the key, but full configuration and revision still gate acquisition', async t => {
  const persistence = memory(null), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
  const first = await settings.put(update(0, cc(), {action: 'replace', storage: 'session', value: KEY}));
  const changed = await settings.put(update(1, responses()));
  assert.equal((await acquire(settings, changed)).apiKey, KEY);
  await assert.rejects(acquire(settings, first), {code: 'AGENT_SETTINGS_CONFLICT'});
  await assert.rejects(settings[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: changed.revision, configuration: cc()}), {code: 'AGENT_SETTINGS_CONFLICT'});
  const newModel = await settings.put(update(2, {...responses(), model: 'gpt-4.1-mini-2025-04-14'}));
  assert.equal((await acquire(settings, newModel)).apiKey, KEY);
  assert.equal(persistence.value.secret, null); assert.equal(JSON.stringify(persistence.value).includes(KEY), false);
});

test('preset/platform/base-path edits invalidate legacy stored keys even when a locked vault cannot decrypt', async t => {
  const cases = [
    [legacyConfiguration(), {...responses(), presetId: 'deepseek'}],
    [legacyConfiguration(), {...responses(), baseUrl: 'https://api.openai.com/v1/other'}],
    [{...legacyConfiguration(), presetId: 'qwen', platformId: 'beijing'}, {...responses(), presetId: 'qwen', platformId: 'singapore'}],
  ];
  for (const [legacy, changed] of cases) {
    const vault = codec(), persistence = memory(encryptedLegacy(vault, legacy));
    const settings = await createAgentSettings({persistence, secretCodec: vault, storage: locked}); t.after(() => settings.close());
    const saved = await settings.put(update(7, changed));
    assert.equal(saved.secret.configured, false); assert.equal(persistence.value.secret, null); assert.equal(vault.decryptions, 0);
    assert.equal((await acquire(settings, saved)).apiKey, null);
  }
});

test('failed first migration saves and stale CAS preserve v1 bytes, ciphertext and old in-memory protocol', async t => {
  const vault = codec(), seed = encryptedLegacy(vault), persistence = memory(seed), save = persistence.save;
  const settings = await createAgentSettings({persistence, secretCodec: vault, storage: locked}); t.after(() => settings.close());
  const snapshot = await settings.get();
  persistence.save = async () => { throw Error(KEY); };
  await assert.rejects(settings.put(update(7, responses())), error => error.code === 'AGENT_SETTINGS_SAVE_FAILED' && !error.message.includes(KEY));
  assert.deepEqual(await settings.get(), snapshot); assert.deepEqual(persistence.value, seed);
  await assert.rejects(settings.put(update(6, responses(), {action: 'remove'})), {code: 'AGENT_SETTINGS_CONFLICT'});
  persistence.save = save;
  const racers = await Promise.allSettled([settings.put(update(7, responses())), settings.put(update(7, cc(), {action: 'remove'}))]);
  assert.equal(racers[0].status, 'fulfilled'); assert.equal(racers[1].reason.code, 'AGENT_SETTINGS_CONFLICT');
  assert.equal(persistence.value.version, 2); assert.equal(persistence.value.revision, 8); assert.deepEqual(persistence.value.secret, seed.secret);
  assert.equal(vault.decryptions, 0); assert.equal(vault.encryptions, 1);
});

test('a web engine cannot adopt encrypted desktop v1 or v2 envelopes', async t => {
  const vault = codec(), seed = encryptedLegacy(vault);
  for (const stored of [seed, {...seed, version: 2, configuration: responses()}]) {
    const persistence = memory(stored), settings = await createAgentSettings({persistence}); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'AGENT_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put(update(7, responses())), {code: 'AGENT_SETTINGS_CORRUPT'});
    assert.deepEqual(persistence.value, stored);
  }
});
