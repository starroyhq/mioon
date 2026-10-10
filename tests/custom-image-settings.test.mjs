import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_NAMESPACE,
  isCustomImageSettingsResult} from '../packages/contracts/src/image-settings.mjs';
import {createImageSettings, createCustomImageSettings, parseCustomImageConfiguration, parseCustomImageSettingsUpdate,
  sanitizeCustomImageSettingsResult, sanitizeCustomImageCredentialResult, validateImageSettingsEnvelope,
  validateCustomImageSettingsEnvelope, validateImageSecretPlaintext, IMAGE_CREDENTIAL_ACQUIRE,
  IMAGE_SETTINGS_ASSERT_CURRENT, IMAGE_SETTINGS_READ_CURRENT} from '../packages/business/src/images/settings.mjs';

const SENTINEL = 'synthetic-custom-images-key';
const config = (changes = {}) => ({...structuredClone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION), enabled: true,
  baseUrl: 'https://images.example.com/vendor/v1', model: 'custom-image-v1', ...changes});
const update = (revision = 0, secret = {action: 'keep'}, configuration = config()) => ({expectedRevision: revision, configuration, secret});
const replace = (value = SENTINEL, storage = 'session') => ({action: 'replace', storage, value});
const expected = snapshot => ({expectedRevision: snapshot.revision, configuration: snapshot.configuration});
const available = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};
function memory(initial = null) {
  let stored = structuredClone(initial);
  return {load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); }, get value() { return structuredClone(stored); }};
}
function cipher() {
  const key = randomBytes(32);
  return {
    encrypt(value) { const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, enc.update(value), enc.final(), enc.getAuthTag()]).toString('base64'); },
    decrypt(value) { const bytes = Buffer.from(value, 'base64'), dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); dec.setAuthTag(bytes.subarray(-16)); return Buffer.concat([dec.update(bytes.subarray(12, -16)), dec.final()]).toString(); },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function redacted(value) { assert.equal(JSON.stringify(value).includes(SENTINEL), false); }

test('custom slot starts empty, disabled, network-free and cannot bind a credential before complete configuration', async t => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Saving settings must never probe a provider');
  t.after(() => { globalThis.fetch = previous; });
  const persistence = memory(), settings = await createCustomImageSettings({persistence}); t.after(() => settings.close());
  const initial = await settings.get();
  assert.deepEqual(initial.configuration, DEFAULT_CUSTOM_IMAGE_CONFIGURATION);
  assert.ok(isCustomImageSettingsResult(initial));
  assert.deepEqual(initial.secret, {configured: false, storage: 'none'});
  assert.equal(persistence.value, null);
  for (const secret of [replace(), replace(SENTINEL, 'persistent')]) {
    await assert.rejects(settings.put(update(0, secret, DEFAULT_CUSTOM_IMAGE_CONFIGURATION)), {code: 'IMAGE_SETTINGS_VALIDATION'});
  }
  for (const changed of [{baseUrl: '', model: 'model'}, {baseUrl: 'https://images.example.com', model: ''},
    {enabled: true, baseUrl: '', model: ''}, {connectionId: 'second'}, {profileId: 'agent'}, {providerId: 'openai'},
    {baseUrl: 'https://localhost/v1'}, {baseUrl: 'https://127.0.0.1/v1'}, {baseUrl: 'https://images.example.com:444/v1'},
    {baseUrl: 'https://images.example.com/v1?key=hidden'}, {baseUrl: 'https://images.example.com/v1/'},
    {model: ' padded '}, {options: {...config().options, n: 2}}]) {
    assert.throws(() => parseCustomImageConfiguration(config(changed)), {code: 'IMAGE_SETTINGS_VALIDATION'});
  }
  for (const bad of [{...update(), apiKey: SENTINEL}, {...update(), secret: {action: 'keep', value: SENTINEL}},
    update(0, replace('x'.repeat(4097))), update(0, replace('not valid')), update(0, {action: 'replace', storage: 'plaintext', value: SENTINEL})]) {
    assert.throws(() => parseCustomImageSettingsUpdate(bad), {code: 'IMAGE_SETTINGS_VALIDATION'});
  }
  assert.equal((await settings.put(update())).secret.configured, false);
});

test('official and custom engines have independent configuration, revisions and session credentials', async t => {
  const officialFile = memory(), customFile = memory();
  const official = await createImageSettings({persistence: officialFile}), custom = await createCustomImageSettings({persistence: customFile});
  t.after(async () => { await official.close(); await custom.close(); });
  const a = await official.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: replace('synthetic-official-only')});
  const old = officialFile.value, b = await custom.put(update(0, replace()));
  assert.equal((await official[IMAGE_CREDENTIAL_ACQUIRE](expected(a))).apiKey, 'synthetic-official-only');
  const credential = await custom[IMAGE_CREDENTIAL_ACQUIRE](expected(b));
  assert.equal(credential.apiKey, SENTINEL); assert.equal(credential.namespace, CUSTOM_IMAGE_SETTINGS_NAMESPACE);
  assert.deepEqual(sanitizeCustomImageCredentialResult(credential, expected(b)), credential);
  assert.deepEqual(officialFile.value, old);
  assert.equal(customFile.value.namespace, CUSTOM_IMAGE_SETTINGS_NAMESPACE);
  assert.equal(officialFile.value.namespace, IMAGE_SETTINGS_NAMESPACE);
  await assert.rejects(custom[IMAGE_CREDENTIAL_ACQUIRE](expected(a)), {code: 'IMAGE_SETTINGS_VALIDATION'});
  await assert.rejects(official[IMAGE_CREDENTIAL_ACQUIRE](expected(b)), {code: 'IMAGE_SETTINGS_VALIDATION'});
  assert.throws(() => validateImageSettingsEnvelope(customFile.value), {code: 'IMAGE_SETTINGS_CORRUPT'});
  assert.throws(() => validateCustomImageSettingsEnvelope(officialFile.value), {code: 'IMAGE_SETTINGS_CORRUPT'});
  assert.equal(customFile.value.secret, null); redacted(customFile.value); redacted(b);
  const clean = sanitizeCustomImageSettingsResult({...b, apiKey: SENTINEL, ciphertext: 'hidden', secret: {...b.secret, value: SENTINEL, hash: 'hidden'}});
  assert.deepEqual(clean, b); redacted(clean);
});

test('custom recipient or model changes require explicit replacement or removal and never reuse the old binding', async t => {
  for (const change of [{baseUrl: 'https://different.example.com/v2'}, {baseUrl: 'https://images.example.com/other'}, {model: 'next-image'}]) {
    const persistence = memory(), settings = await createCustomImageSettings({persistence}); t.after(() => settings.close());
    const old = await settings.put(update(0, replace())), before = persistence.value;
    await assert.rejects(settings.put(update(1, {action: 'keep'}, config(change))), {code: 'IMAGE_SETTINGS_CONFLICT'});
    assert.deepEqual(await settings.get(), old); assert.deepEqual(persistence.value, before);
    assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(old))).apiKey, SENTINEL);
    const changed = await settings.put(update(1, replace('synthetic-explicit-new-key'), config(change)));
    assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(changed))).apiKey, 'synthetic-explicit-new-key');
    await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(old)), {code: 'IMAGE_SETTINGS_CONFLICT'});
    const removed = await settings.put(update(2, {action: 'remove'}, config()));
    assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(removed))).apiKey, null);
    assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(removed)), {code: 'IMAGE_SETTINGS_NOT_CONFIGURED'});
  }
});

test('enable toggles retain a custom key, every save fences old revisions, backend close drops session secrets', async () => {
  const persistence = memory(); let settings = await createCustomImageSettings({persistence});
  const old = await settings.put(update(0, replace()));
  const disabled = await settings.put(update(1, {action: 'keep'}, config({enabled: false})));
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(disabled))).apiKey, SENTINEL);
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(disabled)), {code: 'IMAGE_SETTINGS_DISABLED'});
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(old)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await settings.close();
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(disabled)), {code: 'IMAGE_SETTINGS_CLOSED'});
  settings = await createCustomImageSettings({persistence});
  assert.deepEqual((await settings.get()).secret, {configured: false, storage: 'none'});
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(disabled))).apiKey, null);
  await settings.close();
});

test('custom CAS and admitted mutation fences match official lifecycle, including known failed saves', async t => {
  const persistence = memory(), settings = await createCustomImageSettings({persistence}); t.after(() => settings.close());
  const incoming = update(0, replace()), first = settings.put(incoming);
  incoming.configuration.model = 'mutated'; incoming.secret.value = 'mutated';
  const results = await Promise.allSettled([first, settings.put(update(0, replace('racer')))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'IMAGE_SETTINGS_CONFLICT');
  const current = await settings.get();
  const gate = deferred(), entered = deferred(); persistence.save = async () => { entered.resolve(); await gate.promise; };
  const failing = settings.put(update(1, {action: 'remove'}));
  assert.throws(() => settings[IMAGE_SETTINGS_READ_CURRENT](), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await entered.promise;
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(current)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  gate.reject(Error(SENTINEL));
  await assert.rejects(failing, {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.deepEqual(await settings.get(), current);
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(current))).apiKey, SENTINEL);
});

test('custom unknown-save outcomes remain fenced during read-back and latch closed unless old durable state is proven', async t => {
  for (const outcome of ['candidate', 'foreign', 'unreadable']) {
    const persistence = memory(), settings = await createCustomImageSettings({persistence}); t.after(() => settings.close());
    const old = await settings.put(update(0, replace())), save = persistence.save;
    const gate = deferred(), read = deferred();
    persistence.save = async candidate => {
      if (outcome === 'candidate') await save(candidate);
      persistence.load = async () => { read.resolve(); await gate.promise; if (outcome === 'unreadable') throw Error(SENTINEL); return outcome === 'foreign' ? {secret: SENTINEL} : memoryValue(); };
      throw Error(SENTINEL);
    };
    const memoryValue = () => persistence.value;
    const pending = settings.put(update(1, replace('synthetic-replacement'), config({model: 'next-model'})));
    await read.promise;
    assert.throws(() => settings[IMAGE_SETTINGS_READ_CURRENT](), {code: 'IMAGE_SETTINGS_CONFLICT'});
    assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(old)), {code: 'IMAGE_SETTINGS_CONFLICT'});
    gate.resolve(); await assert.rejects(pending, {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(old)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    await assert.rejects(settings.put(update(1, {action: 'remove'})), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  }
});

test('custom persistent secrets bind namespace, connection, profile, origin, model and options and survive restart', async () => {
  const persistence = memory(), secretCodec = cipher();
  let settings = await createCustomImageSettings({persistence, secretCodec, storage: available});
  const saved = await settings.put(update(0, replace(SENTINEL, 'persistent'))), envelope = persistence.value;
  redacted(envelope); redacted(saved);
  const plain = validateImageSecretPlaintext(secretCodec.decrypt(envelope.secret.encrypted));
  assert.deepEqual(JSON.parse(plain.binding), [CUSTOM_IMAGE_SETTINGS_NAMESPACE, 'openai-compatible', 'custom', config().profileId,
    config().baseUrl, config().model, config().options]);
  assert.equal(plain.value, SENTINEL);
  await settings.close(); settings = await createCustomImageSettings({persistence, secretCodec, storage: available});
  assert.deepEqual(await settings.get(), saved);
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved))).apiKey, SENTINEL);
  assert.equal(settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), true);
  await settings.close();
});

test('custom vault unavailable/locked never silently falls back and explicit session or removal is possible', async t => {
  for (const options of [{}, {storage: available}, {secretCodec: cipher(), storage: {...available, persistentAvailable: false, reasonCode: 'LINUX_BASIC_TEXT'}}]) {
    const persistence = memory(), settings = await createCustomImageSettings({persistence, ...options}); t.after(() => settings.close());
    await assert.rejects(settings.put(update(0, replace(SENTINEL, 'persistent'))), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
    assert.equal(persistence.value, null); assert.equal((await settings.get()).secret.configured, false);
    assert.equal((await settings.put(update(0, replace()))).secret.storage, 'session');
  }
  const persistence = memory(), secretCodec = cipher();
  const original = await createCustomImageSettings({persistence, secretCodec, storage: available});
  const saved = await original.put(update(0, replace(SENTINEL, 'persistent'))); await original.close();
  const locked = await createCustomImageSettings({persistence, secretCodec: {...secretCodec, decrypt() { throw Error(SENTINEL); }}, storage: available});
  t.after(() => locked.close());
  assert.equal((await locked.get()).secret.configured, true); assert.equal((await locked.get()).storage.persistentAvailable, false);
  await assert.rejects(locked[IMAGE_CREDENTIAL_ACQUIRE](expected(saved)), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await locked.put(update(1, replace()))).secret.storage, 'session');
  assert.equal(persistence.value.secret, null); redacted(persistence.value);
});

test('custom envelopes fail closed on corrupt, foreign or incomplete binding without rewriting', async t => {
  const valid = {version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, revision: 3, configuration: config(), secret: null};
  for (const bad of [{...valid, namespace: IMAGE_SETTINGS_NAMESPACE}, {...valid, version: 2}, {...valid, apiKey: SENTINEL},
    {...valid, configuration: config({connectionId: 'other'})}, {...valid, secret: {binding: 'agent', encrypted: 'YWJj'}},
    {...valid, configuration: DEFAULT_CUSTOM_IMAGE_CONFIGURATION, secret: {binding: 'empty', encrypted: 'YWJj'}}]) {
    const persistence = memory(bad), settings = await createCustomImageSettings({persistence}); t.after(() => settings.close());
    await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(settings.put(update(3, {action: 'remove'})), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.deepEqual(persistence.value, bad);
  }
});
