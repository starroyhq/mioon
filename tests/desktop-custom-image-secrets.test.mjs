import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCipheriv, createDecipheriv, randomUUID} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createDesktopImageSecretCodec} from '../apps/desktop/src/image-secret-store.ts';
import {createDesktopSecretCodec} from '../apps/desktop/src/secret-store.ts';
import {createImageSecretBroker, createImageSecretClient} from '../apps/desktop/src/image-secret-broker.ts';
import {createImageSettings, createCustomImageSettings, IMAGE_CREDENTIAL_ACQUIRE, validateImageSecretPlaintext} from '../packages/business/src/images/settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION, DEFAULT_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';

const APP_ID = 'app.starroy.mioon.dev', SENTINEL = 'synthetic-custom-vault-key';
const config = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image'};
const binding = JSON.stringify([CUSTOM_IMAGE_SETTINGS_NAMESPACE, config.providerId, config.connectionId, config.profileId, config.baseUrl, config.model, config.options]);
const wrapper = {version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, binding, value: SENTINEL};
const plaintext = JSON.stringify(wrapper);
const expected = value => ({expectedRevision: value.revision, configuration: value.configuration});
function fakeVault() {
  const key = Buffer.alloc(32, 19); let counter = 0;
  return {
    async isAsyncEncryptionAvailable() { return this.isEncryptionAvailable(); },
    async encryptStringAsync(value) { return this.encryptString(value); },
    async decryptStringAsync(value) { return {result: this.decryptString(value), shouldReEncrypt: false}; },
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8); const enc = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, enc.update(value), enc.final(), enc.getAuthTag()]); },
    decryptString(value) { const dec = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); dec.setAuthTag(value.subarray(-16)); return Buffer.concat([dec.update(value.subarray(12, -16)), dec.final()]).toString(); },
  };
}
const codecFor = (safeStorage, platform = 'darwin') => createDesktopImageSecretCodec({safeStorage, appId: APP_ID, platform});
function memory() { let stored = null; return {load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); }, get value() { return stored; }}; }
function connected(safeStorage = fakeVault(), platform = 'darwin') {
  const port = new EventEmitter(), responses = [], requests = [];
  const broker = createImageSecretBroker({imageSecretCodec: codecFor(safeStorage, platform), send: data => { responses.push(data); port.emit('message', {data}); }});
  port.postMessage = value => { requests.push(value); broker.handle(value); };
  const client = createImageSecretClient({port});
  return {client, broker, responses, requests, close() { client.close(); broker.close(); }};
}
function safe(value) { assert.equal((String(value?.message) + JSON.stringify(value)).includes(SENTINEL), false); return true; }

for (const platform of ['linux', 'darwin']) test('main codec accepts exactly official and custom complete Images bindings while keeping legacy channel wrapper unchanged (' + platform + ')', async () => {
  const vault = fakeVault(), codec = codecFor(vault, platform);
  const official = DEFAULT_IMAGE_CONFIGURATION;
  const officialPlain = JSON.stringify({version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, value: 'synthetic-official',
    binding: JSON.stringify([IMAGE_SETTINGS_NAMESPACE, official.providerId, official.profileId, official.baseUrl, official.model, official.options])});
  for (const plain of [officialPlain, plaintext]) {
    const encrypted = await codec.encrypt(plain);
    assert.equal(await codec.decrypt(encrypted), plain);
    assert.deepEqual(JSON.parse(vault.decryptString(Buffer.from(encrypted, 'base64'))), {version: 1, appId: APP_ID, plaintext: plain});
    assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(SENTINEL)), false);
  }
  const otherChannel = createDesktopImageSecretCodec({safeStorage: vault, appId: 'app.starroy.mioon', platform});
  await assert.rejects(async () => otherChannel.decrypt(await codec.encrypt(plaintext)), safe);
});

test('custom plaintext validation rejects arbitrary profiles, incomplete or noncanonical bindings, secret smuggling and oversize', async () => {
  const vault = fakeVault(), codec = codecFor(vault), legacy = createDesktopSecretCodec({safeStorage: vault, appId: APP_ID, platform: 'darwin'});
  const mutateBinding = change => JSON.stringify({...wrapper, binding: JSON.stringify(change(JSON.parse(binding)))});
  const bad = [SENTINEL, JSON.stringify({...wrapper, namespace: 'mioon.agent.v1'}), JSON.stringify({...wrapper, namespace: 'mioon.images.compatible.v1'}),
    JSON.stringify({...wrapper, extra: SENTINEL}), JSON.stringify({...wrapper, version: 2}), JSON.stringify({...wrapper, binding: []}),
    JSON.stringify({...wrapper, binding: ' ' + binding}), JSON.stringify({...wrapper, value: {secret: SENTINEL}}), JSON.stringify({...wrapper, value: SENTINEL + '\n'}),
    JSON.stringify({...wrapper, value: 'x'.repeat(4097)}), 'x'.repeat(16385)];
  for (const [index, value] of [[0, IMAGE_SETTINGS_NAMESPACE], [1, 'openai'], [2, 'arbitrary'], [3, 'chat-completions'],
    [4, 'https://localhost/v1'], [4, 'https://images.example.com:443/v1'], [4, 'https://images.example.com/v1/'], [4, ''], [5, ''], [5, 'bad model'], [6, {...config.options, n: 2}]]) {
    bad.push(mutateBinding(values => { values[index] = value; return values; }));
  }
  bad.push(mutateBinding(values => [...values, 'unexpected']));
  for (const plain of bad) {
    assert.throws(() => validateImageSecretPlaintext(plain), safe);
    await assert.rejects(codec.encrypt(plain), safe);
    const encrypted = await legacy.encrypt(plain);
    await assert.rejects(codec.decrypt(encrypted), safe);
  }
  let reads = 0; vault.decryptString = () => { reads++; throw Error(SENTINEL); };
  for (const ciphertext of [null, {}, '', 'Zh==', 'not base64', 'YWFh'.repeat(12289)]) await assert.rejects(codec.decrypt(ciphertext), safe);
  assert.equal(reads, 0);
});

test('private broker/client transports custom keys only after both strict Images gates and cannot return malformed plaintext', async t => {
  const pair = connected(); t.after(() => pair.close());
  const encrypted = await pair.client.encrypt(plaintext);
  assert.equal(await pair.client.decrypt(encrypted), plaintext);
  assert.deepEqual(pair.requests.map(value => value.operation), ['status', 'encrypt', 'status', 'decrypt']);
  assert.ok(pair.requests.every(value => value.namespace === 'images' && !('configuration' in value)));
  const messages = []; let calls = 0;
  const broker = createImageSecretBroker({imageSecretCodec: {storage: pair.client.storage,
    encrypt() { calls++; return encrypted; }, decrypt() { calls++; return JSON.stringify({...wrapper, namespace: 'agent'}); }}, send: value => messages.push(value)});
  t.after(() => broker.close());
  const request = (operation, input) => ({type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId: randomUUID(), operation, input});
  broker.handle(request('encrypt', JSON.stringify({...wrapper, connection: 'hidden'})));
  await nextTurn(); assert.equal(calls, 0); assert.equal(messages[0].ok, false); safe(messages[0]);
  broker.handle(request('decrypt', encrypted)); await nextTurn();
  assert.equal(calls, 1); assert.equal(messages[1].ok, false); safe(messages[1]);
});

for (const platform of ['linux', 'darwin']) test('two utility engines share only an OS codec, persistent bindings stay separate and session keys die with backend engines (' + platform + ')', async t => {
  const vault = fakeVault(), pair = connected(vault, platform); t.after(() => pair.close());
  const officialFile = memory(), customFile = memory(), options = {secretCodec: pair.client, storage: pair.client.storage};
  const official = await createImageSettings({persistence: officialFile, ...options}); t.after(() => official.close());
  let custom = await createCustomImageSettings({persistence: customFile, ...options}); t.after(() => custom.close());
  const a = await official.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'persistent', value: 'synthetic-official'}});
  const savedOfficial = structuredClone(officialFile.value);
  const b = await custom.put({expectedRevision: 0, configuration: config, secret: {action: 'replace', storage: 'persistent', value: SENTINEL}});
  safe(customFile.value); safe(b); assert.deepEqual(officialFile.value, savedOfficial);
  assert.equal((await custom[IMAGE_CREDENTIAL_ACQUIRE](expected(b))).apiKey, SENTINEL);
  assert.equal((await official[IMAGE_CREDENTIAL_ACQUIRE](expected(a))).apiKey, 'synthetic-official');
  await custom.close(); custom = await createCustomImageSettings({persistence: customFile, ...options});
  assert.equal((await custom[IMAGE_CREDENTIAL_ACQUIRE](expected(b))).apiKey, SENTINEL);
  vault.isEncryptionAvailable = () => false;
  await assert.rejects(async () => custom.put({expectedRevision: 1, configuration: config, secret: {action: 'replace', storage: 'persistent', value: SENTINEL}}), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await custom.get()).secret.storage, 'persistent'); assert.deepEqual(officialFile.value, savedOfficial);
  const session = await custom.put({expectedRevision: 1, configuration: config, secret: {action: 'replace', storage: 'session', value: SENTINEL}});
  assert.equal(session.secret.storage, 'session'); assert.equal(customFile.value.secret, null); safe(customFile.value);
  await custom.close(); custom = await createCustomImageSettings({persistence: customFile, ...options});
  assert.deepEqual((await custom.get()).secret, {configured: false, storage: 'none'});
});

test('copied ciphertext from another Images slot or custom recipient never yields its key from a settings engine', async t => {
  const pair = connected(); t.after(() => pair.close());
  const copied = await pair.client.encrypt(plaintext);
  const wrongConfig = {...config, model: 'different-image'};
  const wrongBinding = JSON.stringify([CUSTOM_IMAGE_SETTINGS_NAMESPACE, config.providerId, config.connectionId, config.profileId, config.baseUrl, wrongConfig.model, config.options]);
  const persistence = memory();
  await persistence.save({version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, revision: 1, configuration: wrongConfig, secret: {binding: wrongBinding, encrypted: copied}});
  const settings = await createCustomImageSettings({persistence, secretCodec: pair.client, storage: pair.client.storage}); t.after(() => settings.close());
  const snapshot = await settings.get(); assert.equal(snapshot.storage.persistentAvailable, false); safe(snapshot);
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(snapshot)), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
});
