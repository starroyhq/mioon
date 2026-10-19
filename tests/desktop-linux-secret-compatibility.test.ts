import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createLinuxDesktopSecretCodec, linuxDesktopSecretStorage } from '../apps/desktop/src/secret-store-linux.ts';
import type {SecretOperationOptions, SecretStorageState} from '../apps/desktop/src/secret-store.ts';
import { agentSettingsError } from '../packages/business/src/agent/config.ts';

type LinuxCodecOptions = Parameters<typeof createLinuxDesktopSecretCodec>[0];
type SyncSafeStorageArg = LinuxCodecOptions['safeStorage'];
interface SyncCodec {
  storage(): SecretStorageState;
  refreshStorage(options?: SecretOperationOptions): SecretStorageState;
  encrypt(plaintext: unknown, options?: SecretOperationOptions): string;
  decrypt(ciphertext: unknown, options?: SecretOperationOptions): string;
  close(): void;
}
const syncCodec = (options: LinuxCodecOptions): SyncCodec => createLinuxDesktopSecretCodec(options) as unknown as SyncCodec;

const SECRET = 'synthetic-linux-credential-never-live';
const DEVELOPMENT = 'app.starroy.mioon.dev';
const PRODUCTION = 'app.starroy.mioon';
const AVAILABLE = { persistentAvailable: true, sessionScope: 'app' as const, reasonCode: null };
const UNAVAILABLE = { persistentAvailable: false, sessionScope: 'app' as const, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE' as const };

// Synthetic, in-memory crypto only. These tests do not open a native keyring,
// read existing credentials/settings, or certify native Linux integration.
interface FakeVault {
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend: () => string | null | undefined;
  encryptString: (plaintext: string) => unknown;
  decryptString: (ciphertext: Buffer) => unknown;
}
interface FakeVaultState {backend: string | null | undefined; available: boolean | number | undefined; encryptCalls: number; decryptCalls: number; asyncCalls: number; plaintexts: string[]}
function fakeVault(backend: string | null | undefined = 'gnome_libsecret') {
  let sequence = 0;
  const key = Buffer.alloc(32, 9);
  const state: FakeVaultState = { backend, available: true, encryptCalls: 0, decryptCalls: 0, asyncCalls: 0, plaintexts: [] };
  const vault: FakeVault = {
    isEncryptionAvailable: () => state.available === true,
    getSelectedStorageBackend: () => state.backend,
    encryptString(plaintext: string) {
      state.encryptCalls++;
      state.plaintexts.push(plaintext);
      const iv = Buffer.alloc(12); iv.writeUInt32BE(++sequence, 8);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes: Buffer) {
      state.decryptCalls++;
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
  for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    Object.defineProperty(vault, name, { get() { state.asyncCalls++; throw new Error(SECRET); } });
  }
  return { vault, state };
}

function fixedError(code: string) {
  return (error: unknown) => {
    const failure = error as {code: string; message: string; stack?: string};
    assert.equal(failure.code, code);
    assert.equal(failure.message, agentSettingsError(code).message);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    assert.equal(String(failure.stack).includes(SECRET), false);
    return true;
  };
}

for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
  test(`Linux ${backend} preserves synchronous crypto and the original channel wrapper`, async () => {
    const { vault, state } = fakeVault(backend);
    for (const appId of [DEVELOPMENT, PRODUCTION]) {
      const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId } as LinuxCodecOptions);
      assert.deepEqual(linuxDesktopSecretStorage(vault as unknown as SyncSafeStorageArg), AVAILABLE);
      assert.deepEqual(codec.storage(), AVAILABLE);
      assert.deepEqual(await codec.refreshStorage(), AVAILABLE);
      const encrypted = codec.encrypt(SECRET);
      assert.equal(typeof encrypted, 'string');
      assert.equal(state.plaintexts.at(-1), JSON.stringify({ version: 1, appId, plaintext: SECRET }));
      assert.equal(Buffer.from(encrypted, 'base64').toString('base64'), encrypted);
      assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(SECRET)), false);
      assert.equal(codec.decrypt(encrypted), SECRET);
      // An existing v1 ciphertext is readable without rewriting its wrapper.
      const legacy = (vault.encryptString(JSON.stringify({ version: 1, appId, plaintext: SECRET })) as Buffer).toString('base64');
      const writes = state.encryptCalls;
      assert.equal(await codec.decrypt(legacy), SECRET);
      assert.equal(state.encryptCalls, writes);
      assert.equal(state.asyncCalls, 0);
    }
  });
}

test('Linux denies basic_text, unknown/missing backends and unavailable encryption before native crypto', () => {
  for (const backend of ['basic_text', 'unknown', 'future-backend', undefined, null]) {
    const { vault, state } = fakeVault(); state.backend = backend;
    const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
    const expected = { ...UNAVAILABLE, reasonCode: backend === 'basic_text' ? 'LINUX_BASIC_TEXT' : 'OS_SECRET_STORE_UNAVAILABLE' };
    assert.deepEqual(codec.storage(), expected);
    assert.deepEqual(codec.refreshStorage(), expected);
    assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.throws(() => codec.decrypt('AAAA'), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.equal(state.encryptCalls + state.decryptCalls + state.asyncCalls, 0);
  }
  const { vault, state } = fakeVault();
  const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
  for (const available of [false, undefined, 1]) {
    state.available = available;
    assert.deepEqual(codec.storage(), UNAVAILABLE);
    assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.throws(() => codec.decrypt('AAAA'), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  for (const broken of [undefined, {}, { isEncryptionAvailable() { throw new Error(SECRET); } },
    { isEncryptionAvailable: () => true },
    { isEncryptionAvailable: () => true, getSelectedStorageBackend() { throw new Error(SECRET); } }]) {
    assert.deepEqual(linuxDesktopSecretStorage(broken as unknown as SyncSafeStorageArg), UNAVAILABLE);
  }
  assert.equal(state.encryptCalls + state.decryptCalls + state.asyncCalls, 0);
});

test('Linux checks current availability before each encrypt/decrypt and never falls back', () => {
  const { vault, state } = fakeVault();
  const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
  const encrypted = codec.encrypt(SECRET);
  state.backend = 'basic_text';
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  state.backend = 'kwallet6'; state.available = false;
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.equal(state.encryptCalls, 1); assert.equal(state.decryptCalls, 0);
  state.available = true;
  assert.deepEqual(codec.refreshStorage(), AVAILABLE);
  assert.equal(codec.decrypt(encrypted), SECRET);
  assert.equal(state.asyncCalls, 0);
});

test('Linux keeps appId, strict base64, payload bounds and fixed corruption errors', () => {
  const { vault, state } = fakeVault();
  const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
  const production = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: PRODUCTION });
  for (const appId of ['', null, 'other.app']) {
    assert.throws(() => syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: appId as string }), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  const encrypted = codec.encrypt(SECRET);
  assert.throws(() => production.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
  for (const invalid of ['', '!', 'AAAA=', 'AB==', encrypted + '\n', null, 12, 'A'.repeat(128 * 1024 + 4), Buffer.alloc(64 * 1024 + 1).toString('base64')]) {
    assert.throws(() => codec.decrypt(invalid), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  for (const plaintext of [null, 123, 'a'.repeat(32 * 1024 + 1), 'é'.repeat(16 * 1024 + 1)]) {
    assert.throws(() => codec.encrypt(plaintext), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  const boundary = 'é'.repeat(16 * 1024);
  assert.equal(codec.decrypt(codec.encrypt(boundary)), boundary);
  for (const value of [null, { version: 2, appId: DEVELOPMENT, plaintext: SECRET },
    { version: 1, appId: DEVELOPMENT, plaintext: SECRET, extra: true },
    { version: 1, appId: DEVELOPMENT, plaintext: 1 },
    { version: 1, appId: DEVELOPMENT, plaintext: 'a'.repeat(32 * 1024 + 1) }]) {
    const invalid = (vault.encryptString(JSON.stringify(value)) as Buffer).toString('base64');
    assert.throws(() => codec.decrypt(invalid), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  for (const decoded of [null, Buffer.from(SECRET), '{', 'a'.repeat(64 * 1024 + 1)]) {
    vault.decryptString = () => decoded;
    assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
  }
  vault.decryptString = () => { throw new Error(SECRET); };
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_CORRUPT'));
  for (const value of [null, Buffer.alloc(0), Buffer.alloc(64 * 1024 + 1), SECRET]) {
    vault.encryptString = () => value;
    assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  }
  vault.encryptString = () => { throw new Error(SECRET); };
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.equal(state.asyncCalls, 0);
});

test('Linux closed, aborted and inactive calls do not touch native crypto or return secrets', () => {
  const { vault, state } = fakeVault();
  const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
  const encrypted = codec.encrypt(SECRET), writes = state.encryptCalls;
  const controller = new AbortController(); controller.abort(SECRET);
  for (const options of [{ signal: controller.signal }, { isActive: () => false }, { isActive() { throw new Error(SECRET); } }]) {
    assert.throws(() => codec.encrypt(SECRET, options), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.throws(() => codec.decrypt(encrypted, options), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
    assert.deepEqual(codec.refreshStorage(options), UNAVAILABLE);
  }
  codec.close(); codec.close();
  assert.deepEqual(codec.storage(), UNAVAILABLE);
  assert.deepEqual(codec.refreshStorage(), UNAVAILABLE);
  assert.throws(() => codec.encrypt(SECRET), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.throws(() => codec.decrypt(encrypted), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.equal(state.encryptCalls, writes); assert.equal(state.decryptCalls, 0);
});

for (const operation of ['encrypt', 'decrypt']) {
  for (const fence of ['abort', 'inactive', 'close']) {
    test(`Linux ${operation} discards a completed synchronous result after ${fence}`, () => {
      const { vault, state } = fakeVault();
      const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
      const encrypted = codec.encrypt(SECRET);
      const controller = new AbortController(); let active = true;
      const method = operation === 'encrypt' ? 'encryptString' : 'decryptString';
      const vaultRecord = vault as unknown as Record<string, (value: never) => unknown>;
      const native = vaultRecord[method];
      (vault as unknown as Record<string, (value: never) => unknown>)[method] = value => {
        const result = native(value);
        if (fence === 'abort') controller.abort(SECRET);
        if (fence === 'inactive') active = false;
        if (fence === 'close') codec.close();
        return result;
      };
      assert.throws(() => codec[operation as 'encrypt' | 'decrypt'](operation === 'encrypt' ? SECRET : encrypted,
        { signal: controller.signal, isActive: () => active }), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
      assert.equal(state.encryptCalls, operation === 'encrypt' ? 2 : 1);
      assert.equal(state.decryptCalls, operation === 'decrypt' ? 1 : 0);
      assert.equal(state.asyncCalls, 0);
    });
  }
}

test('Linux refresh and pre-crypto capability probes fence a lifetime change', () => {
  const { vault, state } = fakeVault();
  const codec = syncCodec({ safeStorage: vault as unknown as SyncSafeStorageArg, appId: DEVELOPMENT });
  let active = true;
  vault.isEncryptionAvailable = () => { active = false; return true; };
  assert.deepEqual(codec.refreshStorage({ isActive: () => active }), UNAVAILABLE);
  active = true;
  assert.throws(() => codec.encrypt(SECRET, { isActive: () => active }), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  active = true;
  assert.throws(() => codec.decrypt('AAAA', { isActive: () => active }), fixedError('AGENT_SETTINGS_STORAGE_UNAVAILABLE'));
  assert.equal(state.encryptCalls + state.decryptCalls, 0);
});
