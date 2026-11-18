import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomUUID} from 'node:crypto';
import {createDesktopSecretCodec, desktopSecretStorage} from '../apps/desktop/src/secret-store.ts';
import type {DesktopSafeStorage, SecretOperationOptions, SecretStorageState} from '../apps/desktop/src/secret-store.ts';
import {createDesktopImageSecretCodec} from '../apps/desktop/src/image-secret-store.ts';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import {agentSettingsError} from '../packages/business/src/agent/config.ts';
import {customImageCredentialBindingV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE} from '../packages/contracts/src/generation-image-settings.ts';
import {VIDEO_SECRET_NAMESPACE} from '../packages/contracts/src/video-providers.ts';

const SECRET = 'synthetic-windows-credential-never-live';
const DEVELOPMENT = 'app.starroy.mioon.dev', PRODUCTION = 'app.starroy.mioon';
const AVAILABLE = {persistentAvailable: true, reasonCode: null};
const UNAVAILABLE = {persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE' as const};
interface SyncCodec {
  storage(): SecretStorageState;
  refreshStorage(options?: SecretOperationOptions): SecretStorageState;
  encrypt(plaintext: unknown, options?: SecretOperationOptions): string;
  decrypt(ciphertext: unknown, options?: SecretOperationOptions): string;
  close(): void;
}
interface FakeVault {
  isEncryptionAvailable(): unknown;
  encryptString(plaintext: string): unknown;
  decryptString(ciphertext: Buffer): unknown;
}
function codecFor(vault: FakeVault, appId = DEVELOPMENT): SyncCodec {
  return createDesktopSecretCodec({safeStorage: vault as unknown as DesktopSafeStorage, appId, platform: 'win32'}) as SyncCodec;
}
// In-memory authenticated crypto exercises the adapter, not native DPAPI.
// No OS store, provider, user setting, file or real credential is accessed.
function fixture() {
  const key = Buffer.alloc(32, 11);
  let sequence = 0;
  const state = {available: true as unknown, encrypted: 0, decrypted: 0, forbiddenCalls: 0, wrapped: ''};
  const vault: FakeVault = {
    isEncryptionAvailable: () => state.available,
    encryptString(plaintext) {
      state.encrypted++; state.wrapped = plaintext;
      const iv = Buffer.alloc(12); iv.writeUInt32BE(++sequence, 8);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(bytes) {
      state.decrypted++;
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  for (const name of ['getSelectedStorageBackend', 'isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    Object.defineProperty(vault, name, {get() {state.forbiddenCalls++; throw Error(SECRET);}});
  }
  return {vault, state};
}
function fixedError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal('code' in error ? error.code : undefined, code);
    assert.equal(error.message, agentSettingsError(code).message);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    assert.equal(String(error.stack).includes(SECRET), false);
    return true;
  };
}

test('Windows availability uses only ready synchronous DPAPI methods', () => {
  const {vault, state} = fixture(), codec = codecFor(vault);
  assert.deepEqual(codec.storage(), AVAILABLE);
  assert.deepEqual(codec.refreshStorage(), AVAILABLE);
  assert.deepEqual(desktopSecretStorage(vault as unknown as DesktopSafeStorage, 'win32'), AVAILABLE);
  state.available = false;
  assert.deepEqual(codec.storage(), UNAVAILABLE);
  assert.equal(state.encrypted + state.decrypted + state.forbiddenCalls, 0);
});

test('Windows ciphertext keeps the v1 channel wrapper and survives codec recreation', () => {
  const {vault, state} = fixture(), dev = codecFor(vault), production = codecFor(vault, PRODUCTION);
  const encrypted = dev.encrypt(SECRET);
  assert.equal(state.wrapped, JSON.stringify({version: 1, appId: DEVELOPMENT, plaintext: SECRET}));
  assert.equal(Buffer.from(encrypted, 'base64').toString('base64'), encrypted);
  assert.equal(encrypted.includes(SECRET), false);
  assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(SECRET)), false);
  dev.close();
  const reopened = codecFor(vault), before = state.encrypted;
  assert.equal(reopened.decrypt(encrypted), SECRET);
  assert.equal(state.encrypted, before, 'reading existing ciphertext does not rewrite it');
  assert.throws(() => production.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
  assert.equal(state.forbiddenCalls, 0);
});

test('Windows unavailable or malformed native APIs refuse before crypto and may recover', () => {
  const {vault, state} = fixture(), codec = codecFor(vault), encrypted = codec.encrypt(SECRET);
  for (const unavailable of [false, undefined, null, 1]) {
    state.available = unavailable;
    assert.deepEqual(codec.storage(), UNAVAILABLE);
    assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  vault.isEncryptionAvailable = () => {throw Error(SECRET);};
  assert.deepEqual(codec.refreshStorage(), UNAVAILABLE);
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  for (const broken of [undefined, {}, {isEncryptionAvailable: () => true},
    {isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(1)}]) {
    assert.deepEqual(desktopSecretStorage(broken as unknown as DesktopSafeStorage, 'win32'), UNAVAILABLE);
  }
  vault.isEncryptionAvailable = () => true;
  assert.deepEqual(codec.refreshStorage(), AVAILABLE);
  assert.equal(codec.decrypt(encrypted), SECRET);
  assert.equal(state.encrypted, 1); assert.equal(state.decrypted, 1); assert.equal(state.forbiddenCalls, 0);
});

test('Windows rejects invalid identities, noncanonical base64, malformed envelopes and payload bounds', () => {
  const {vault, state} = fixture(), codec = codecFor(vault), encrypted = codec.encrypt(SECRET);
  for (const appId of ['', 'other.app', null]) {
    assert.throws(() => codecFor(vault, appId as string), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  for (const invalid of ['', '!', 'AAAA=', 'AB==', encrypted + '\n', null, 12,
    'A'.repeat(128 * 1024 + 4), Buffer.alloc(64 * 1024 + 1).toString('base64')]) {
    assert.throws(() => codec.decrypt(invalid), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  for (const invalid of [undefined, 1, 'a'.repeat(32 * 1024 + 1), 'é'.repeat(16 * 1024 + 1)]) {
    assert.throws(() => codec.encrypt(invalid), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  const boundary = 'é'.repeat(16 * 1024);
  assert.equal(codec.decrypt(codec.encrypt(boundary)), boundary);
  for (const envelope of [null, [], {version: 2, appId: DEVELOPMENT, plaintext: SECRET},
    {version: 1, appId: DEVELOPMENT, plaintext: SECRET, extra: true},
    {version: 1, appId: DEVELOPMENT, plaintext: 1},
    {version: 1, appId: DEVELOPMENT, plaintext: 'a'.repeat(32 * 1024 + 1)}]) {
    const invalid = (vault.encryptString(JSON.stringify(envelope)) as Buffer).toString('base64');
    assert.throws(() => codec.decrypt(invalid), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  for (const invalid of [null, Buffer.from(SECRET), '{', 'a'.repeat(64 * 1024 + 1)]) {
    vault.decryptString = () => invalid;
    assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  for (const invalid of [null, Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1), SECRET]) {
    vault.encryptString = () => invalid;
    assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  assert.equal(state.forbiddenCalls, 0);
});

test('Windows native failures expose fixed errors without native secret text', () => {
  const {vault} = fixture(), codec = codecFor(vault), encrypted = codec.encrypt(SECRET);
  vault.encryptString = () => {throw Error(SECRET);};
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  vault.decryptString = () => {throw Error(SECRET);};
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
});

test('Windows Images and Video retain their exact private namespaces around the shared OS codec', async () => {
  const {vault, state} = fixture();
  const options = {safeStorage: vault as unknown as DesktopSafeStorage, appId: DEVELOPMENT, platform: 'win32' as const};
  const image = createDesktopImageSecretCodec(options), video = createDesktopVideoSecretCodec(options);
  const official = DEFAULT_IMAGE_CONFIGURATION;
  const officialPlaintext = JSON.stringify({version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, value: SECRET,
    binding: JSON.stringify([IMAGE_SETTINGS_NAMESPACE, official.providerId, official.profileId, official.baseUrl, official.model, official.options])});
  const connectionId = randomUUID(), configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true,
    baseUrl: 'https://synthetic-images.example/v1', model: 'synthetic-image'};
  const customPlaintext = JSON.stringify({version: 2, namespace: CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, connectionId,
    binding: customImageCredentialBindingV2(connectionId, configuration), value: SECRET});
  const videoPlaintext = JSON.stringify({version: 1, namespace: VIDEO_SECRET_NAMESPACE, credentialRef: randomUUID(),
    connectionId: randomUUID(), providerId: 'minimax', region: 'global', workspaceId: '', endpoint: 'https://api.minimax.io', value: SECRET});
  for (const plaintext of [officialPlaintext, customPlaintext]) {
    const encrypted = await image.encrypt(plaintext);
    assert.equal(await image.decrypt(encrypted), plaintext);
    assert.equal(encrypted.includes(SECRET), false);
  }
  const encrypted = await video.encrypt(videoPlaintext);
  assert.equal(await video.decrypt(encrypted), videoPlaintext);
  await assert.rejects(image.encrypt(videoPlaintext), {code: 'IMAGE_SETTINGS_VALIDATION'});
  await assert.rejects(video.encrypt(officialPlaintext), {code: 'VIDEO_SETTINGS_VALIDATION'});
  const unrelated = codecFor(vault).encrypt(SECRET);
  await assert.rejects(image.decrypt(unrelated), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await assert.rejects(video.decrypt(unrelated), {code: 'VIDEO_SETTINGS_CORRUPT'});
  assert.equal(state.forbiddenCalls, 0);
});

test('Windows closed, aborted and inactive calls do not reach native crypto', () => {
  const {vault, state} = fixture(), codec = codecFor(vault), encrypted = codec.encrypt(SECRET);
  const controller = new AbortController(); controller.abort(SECRET);
  for (const options of [{signal: controller.signal}, {isActive: () => false}, {isActive() {throw Error(SECRET);}}]) {
    assert.throws(() => codec.encrypt(SECRET, options), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.throws(() => codec.decrypt(encrypted, options), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.deepEqual(codec.refreshStorage(options), UNAVAILABLE);
  }
  codec.close(); codec.close();
  assert.deepEqual(codec.storage(), UNAVAILABLE);
  assert.deepEqual(codec.refreshStorage(), UNAVAILABLE);
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.equal(state.encrypted, 1); assert.equal(state.decrypted, 0);
});

for (const operation of ['encrypt', 'decrypt'] as const) for (const fence of ['abort', 'inactive', 'close'] as const) {
  test(`Windows ${operation} discards synchronous results after ${fence}`, () => {
    const {vault} = fixture(), codec = codecFor(vault), encrypted = codec.encrypt(SECRET);
    const controller = new AbortController(); let active = true;
    const retire = () => {
      if (fence === 'abort') controller.abort(SECRET);
      if (fence === 'inactive') active = false;
      if (fence === 'close') codec.close();
    };
    if (operation === 'encrypt') {
      const original = vault.encryptString;
      vault.encryptString = plaintext => {const result = original(plaintext); retire(); return result;};
    } else {
      const original = vault.decryptString;
      vault.decryptString = bytes => {const result = original(bytes); retire(); return result;};
    }
    assert.throws(() => codec[operation](operation === 'encrypt' ? SECRET : encrypted,
      {signal: controller.signal, isActive: () => active}), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  });
}
