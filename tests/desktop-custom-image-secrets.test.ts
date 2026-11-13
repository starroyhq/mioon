import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCipheriv, createDecipheriv, randomUUID} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createDesktopImageSecretCodec,validateDesktopImageSecretPlaintext} from '../apps/desktop/src/image-secret-store.ts';
import {createDesktopSecretCodec} from '../apps/desktop/src/secret-store.ts';
import {createImageSecretBroker, createImageSecretClient} from '../apps/desktop/src/image-secret-broker.ts';
import {createImageSettings, IMAGE_CREDENTIAL_ACQUIRE} from '../packages/business/src/images/settings.ts';
import {createCustomImageSettingsV2,customImageCredentialBindingV2,validateCustomImageSettingsV2Envelope} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE} from '../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConnectionV2} from '../packages/contracts/src/generation-image-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION, DEFAULT_IMAGE_CONFIGURATION, CUSTOM_IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';

const APP_ID = 'app.starroy.mioon.dev', SENTINEL = 'synthetic-custom-vault-key';
type ImageCodecOptions = Parameters<typeof createDesktopImageSecretCodec>[0];
type BrokerOptions = Parameters<typeof createImageSecretBroker>[0];
type ImageSettingsOptions = Parameters<typeof createImageSettings>[0];
interface AsyncImageCodec {storage(): unknown; encrypt(plaintext: unknown): Promise<string>; decrypt(ciphertext: unknown): Promise<string>; close(): void}
const imageCodec = (options: ImageCodecOptions): AsyncImageCodec => createDesktopImageSecretCodec(options) as unknown as AsyncImageCodec;
const config = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image'},connectionId=randomUUID();
const binding = customImageCredentialBindingV2(connectionId,config);
const wrapper = {version: 2, namespace: CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE,connectionId,binding,value: SENTINEL};
const plaintext = JSON.stringify(wrapper);
const expected = (value: {revision: number; configuration: unknown}) => ({expectedRevision: value.revision, configuration: value.configuration});
const customExpected=(value:CustomImageConnectionV2)=>({connectionId:value.connectionId,configurationRevision:value.configurationRevision,configuration:value.configuration});
interface FakeImageVault {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
function fakeVault(): FakeImageVault {
  const key = Buffer.alloc(32, 19); let counter = 0;
  return {
    async isAsyncEncryptionAvailable() { return this.isEncryptionAvailable(); },
    async encryptStringAsync(value: string) { return this.encryptString(value); },
    async decryptStringAsync(value: Buffer) { return {result: this.decryptString(value), shouldReEncrypt: false}; },
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value: string) { const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8); const enc = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, enc.update(value), enc.final(), enc.getAuthTag()]); },
    decryptString(value: Buffer) { const dec = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); dec.setAuthTag(value.subarray(-16)); return Buffer.concat([dec.update(value.subarray(12, -16)), dec.final()]).toString(); },
  };
}
const codecFor = (safeStorage: unknown, platform: NodeJS.Platform = 'darwin'): AsyncImageCodec =>
  imageCodec({safeStorage, appId: APP_ID, platform} as unknown as ImageCodecOptions);
function memory(): {load(): Promise<Record<string, unknown> | null>; save(value: unknown): Promise<void>; readonly value: Record<string, unknown> | null} {
  let stored: Record<string, unknown> | null = null;
  return {load: async () => structuredClone(stored), save: async (value: unknown) => { stored = structuredClone(value) as Record<string, unknown>; }, get value() { return stored; }};
}
function connected(safeStorage: unknown = fakeVault(), platform: NodeJS.Platform = 'darwin') {
  const port = new EventEmitter() as EventEmitter & {postMessage(value: unknown): void};
  const responses: Array<Record<string, unknown>> = [], requests: Array<Record<string, unknown>> = [];
  const broker = createImageSecretBroker({imageSecretCodec: codecFor(safeStorage, platform), send: (data: unknown) => { responses.push(data as Record<string, unknown>); port.emit('message', {data}); }} as unknown as BrokerOptions);
  port.postMessage = value => { requests.push(value as Record<string, unknown>); broker.handle(value); };
  const client = createImageSecretClient({port} as unknown as Parameters<typeof createImageSecretClient>[0]);
  return {client, broker, responses, requests, close() { client.close(); broker.close(); }};
}
function safe(value: unknown) { assert.equal((String((value as {message?: unknown} | null)?.message) + JSON.stringify(value)).includes(SENTINEL), false); return true; }

for (const platform of ['linux', 'darwin'] as const) test('main codec accepts exactly official and custom complete Images bindings while keeping legacy channel wrapper unchanged (' + platform + ')', async () => {
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
  const mutateBinding = (change: (values: unknown[]) => unknown)=> JSON.stringify({...wrapper, binding: JSON.stringify(change(JSON.parse(binding)))});
  const bad = [SENTINEL, JSON.stringify({...wrapper, namespace: 'mioon.agent.v1'}), JSON.stringify({...wrapper, namespace: 'mioon.images.compatible.v1'}),
    JSON.stringify({...wrapper, extra: SENTINEL}), JSON.stringify({...wrapper, version: 1}), JSON.stringify({...wrapper, binding: []}),
    JSON.stringify({...wrapper, binding: ' ' + binding}), JSON.stringify({...wrapper, value: {secret: SENTINEL}}), JSON.stringify({...wrapper, value: SENTINEL + '\n'}),
    JSON.stringify({...wrapper, value: 'x'.repeat(4097)}), 'x'.repeat(16385)];
  const bindingMutations: Array<[number, unknown]> = [[0, IMAGE_SETTINGS_NAMESPACE], [1, 'openai'], [2, 'arbitrary'], [3, 'chat-completions'],
    [4, 'https://localhost/v1'], [4, 'https://images.example.com:443/v1'], [4, 'https://images.example.com/v1/'], [4, ''], [5, ''], [5, 'bad model'], [6, {...config.options, n: 2}]];
  for (const [index, value] of bindingMutations) {
    bad.push(mutateBinding((values: unknown[]) => { values[index] = value; return values; }));
  }
  bad.push(mutateBinding((values: unknown[]) => [...values, 'unexpected']));
  for (const plain of bad) {
    assert.throws(() => validateDesktopImageSecretPlaintext(plain), safe);
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
  const messages: Array<Record<string, unknown>> = []; let calls = 0;
  const broker = createImageSecretBroker({imageSecretCodec: {storage: pair.client.storage,
    encrypt() { calls++; return encrypted; }, decrypt() { calls++; return JSON.stringify({...wrapper, namespace: 'agent'}); }}, send: (value: unknown) => messages.push(value as Record<string, unknown>)} as unknown as BrokerOptions);
  t.after(() => broker.close());
  const request = (operation: string, input: unknown) => ({type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId: randomUUID(), operation, input});
  broker.handle(request('encrypt', JSON.stringify({...wrapper, connection: 'hidden'})));
  await nextTurn(); assert.equal(calls, 0); assert.equal(messages[0]?.ok, false); safe(messages[0]);
  broker.handle(request('decrypt', encrypted)); await nextTurn();
  assert.equal(calls, 1); assert.equal(messages[1]?.ok, false); safe(messages[1]);
});

for (const platform of ['linux', 'darwin'] as const) test('two utility engines share only an OS codec, persistent bindings stay separate and session keys die with backend engines (' + platform + ')', async t => {
  const vault = fakeVault(), pair = connected(vault, platform); t.after(() => pair.close());
  const officialFile = memory(), customFile = memory(), options = {secretCodec: pair.client, storage: pair.client.storage};
  const official = await createImageSettings({persistence: officialFile, ...options} as unknown as ImageSettingsOptions); t.after(() => official.close());
  let custom = await createCustomImageSettingsV2({persistence: customFile, ...options}); t.after(() => custom.close());
  const a = await official.put({expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'persistent', value: 'synthetic-official'}});
  const savedOfficial = structuredClone(officialFile.value);
  const b = (await custom.create({expectedRevision: 0,connectionId,name:'Custom',configuration: config, secret: {action: 'replace', storage: 'persistent', value: SENTINEL}})).connections[0];
  safe(customFile.value); safe(b); assert.deepEqual(officialFile.value, savedOfficial);
  assert.equal((await custom.acquire(customExpected(b))).apiKey, SENTINEL);
  assert.equal((await official[IMAGE_CREDENTIAL_ACQUIRE](expected(a))).apiKey, 'synthetic-official');
  await custom.close(); custom = await createCustomImageSettingsV2({persistence: customFile, ...options});
  assert.equal((await custom.acquire(customExpected(b))).apiKey, SENTINEL);
  if (platform === 'linux') vault.isEncryptionAvailable = () => false;
  else vault.encryptStringAsync = async () => { throw Error('Synthetic vault failure'); };
  const update={expectedRevision:1,connectionId,expectedConfigurationRevision:1,name:'Custom',configuration:config};
  await assert.rejects(async () => custom.put({...update,secret: {action: 'replace', storage: 'persistent', value: SENTINEL}}), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await custom.get()).connections[0].secret.storage, 'persistent'); assert.deepEqual(officialFile.value, savedOfficial);
  const session = (await custom.put({...update,secret: {action: 'replace', storage: 'session', value: SENTINEL}})).connections[0];
  assert.equal(session.secret.storage, 'session'); assert.equal(validateCustomImageSettingsV2Envelope(customFile.value).connections[0].secret, null); safe(customFile.value);
  await custom.close(); custom = await createCustomImageSettingsV2({persistence: customFile, ...options});
  assert.deepEqual((await custom.get()).connections[0].secret, {configured: false, storage: 'none'});
});

test('copied ciphertext from another Images slot or custom recipient never yields its key from a settings engine', async t => {
  const pair = connected(); t.after(() => pair.close());
  const copied = await pair.client.encrypt(plaintext);
  const wrongConfig = {...config, baseUrl: 'https://other-images.example.com/v2'};
  const wrongBinding = customImageCredentialBindingV2(connectionId,wrongConfig);
  const persistence = memory();
  await persistence.save({version: 2, namespace: CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, revision: 1,deletedConnectionIds:[],connections:[{connectionId,name:'Custom',configurationRevision:1,configuration: wrongConfig, secret: {binding: wrongBinding, encrypted: copied}}]});
  const settings = await createCustomImageSettingsV2({persistence, secretCodec: pair.client, storage: pair.client.storage}); t.after(() => settings.close());
  const snapshot = await settings.get();safe(snapshot);
  await assert.rejects(settings.acquire(customExpected(snapshot.connections[0])), {code: 'IMAGE_SETTINGS_CORRUPT'});
});

test('legacy custom v1 credentials are rejected before OS encryption and legacy file reset never asks the broker to decrypt',async t=>{
  const vault=fakeVault(),codec=codecFor(vault),oldConfiguration={...DEFAULT_CUSTOM_IMAGE_CONFIGURATION,enabled:true,baseUrl:config.baseUrl,model:config.model};
  const oldBinding=JSON.stringify([CUSTOM_IMAGE_SETTINGS_NAMESPACE,oldConfiguration.providerId,'custom',oldConfiguration.profileId,oldConfiguration.baseUrl,oldConfiguration.model,oldConfiguration.options]);
  const oldPlaintext=JSON.stringify({version:1,namespace:CUSTOM_IMAGE_SETTINGS_NAMESPACE,binding:oldBinding,value:SENTINEL});
  let encrypts=0,decrypts=0;vault.encryptString=()=>{encrypts++;throw Error(SENTINEL);};vault.decryptString=()=>{decrypts++;throw Error(SENTINEL);};
  await assert.rejects(codec.encrypt(oldPlaintext),{code:'IMAGE_SETTINGS_VALIDATION'});assert.equal(encrypts,0);
  const persistence=memory();await persistence.save({version:1,namespace:CUSTOM_IMAGE_SETTINGS_NAMESPACE,revision:1,configuration:oldConfiguration,secret:{binding:oldBinding,encrypted:Buffer.from('synthetic-old-cipher').toString('base64')}});
  const settings=await createCustomImageSettingsV2({persistence,secretCodec:codec,storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null}});t.after(()=>settings.close());
  assert.deepEqual((await settings.get()).connections,[]);assert.equal((await settings.get()).notice,'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');assert.equal(decrypts,0);
});
