import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { desktopSecretStorage, createDesktopSecretCodec, createDesktopAgentSettings } from '../apps/desktop/src/secret-store.mjs';
import { createAgentSettingsBroker, createAgentSettingsClient, MAX_AGENT_SETTINGS_MESSAGE_BYTES } from '../apps/desktop/src/secret-broker.mjs';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.mjs';

const DUMMY_KEY = 'dummy-desktop-only-credential-never-live';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// Synthetic crypto fixture only. This does not certify native OS keychain
// behavior on Linux, macOS or Windows, and no provider request is made.
function fakeVault({ backend = 'gnome_libsecret', available = true } = {}) {
  let counter = 0;
  const key = Buffer.alloc(32, 7);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(text) {
      const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const result = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), result]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

function request(operation = 'get', extra = {}) {
  return { type: 'agent-settings-request', version: 1, requestId: randomUUID(), operation, ...extra };
}
function assertSanitized(error) {
  assert.equal(JSON.stringify(error).includes(DUMMY_KEY), false);
  assert.equal(String(error?.message).includes(DUMMY_KEY), false);
  return true;
}

// Supplied once below from the real shared engine, so broker tests exercise the
// same public DTO serializer as production rather than inventing a parallel API.
async function sampleSettings() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-agent-sample-'));
  const engine = await createDesktopAgentSettings({ safeStorage: fakeVault(), userData: directory, appId: 'app.starroy.mioon.dev', platform: 'linux' });
  const settings = await engine.get();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
  return settings;
}

test('desktop persistent capability fails closed without real OS encryption', () => {
  for (const vault of [undefined, fakeVault({ available: false }), { isEncryptionAvailable() { throw new Error(DUMMY_KEY); } }]) {
    assert.deepEqual(desktopSecretStorage(vault, 'linux'), {
      persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'
    });
  }
  assert.deepEqual(desktopSecretStorage(fakeVault({ backend: 'basic_text' }), 'linux'), {
    persistentAvailable: false, sessionScope: 'app', reasonCode: 'LINUX_BASIC_TEXT'
  });
  for (const backend of ['unknown', 'future-unknown', undefined]) {
    const vault = fakeVault(); vault.getSelectedStorageBackend = () => backend;
    assert.equal(desktopSecretStorage(vault, 'linux').persistentAvailable, false);
  }
  const vault = fakeVault(); delete vault.getSelectedStorageBackend;
  assert.equal(desktopSecretStorage(vault, 'linux').persistentAvailable, false);
  for (const platform of ['darwin', 'win32']) assert.equal(desktopSecretStorage(vault, platform).persistentAvailable, true);
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal(desktopSecretStorage(fakeVault({ backend }), 'linux').persistentAvailable, true);
  }
});

test('desktop codec encrypts channel-bound payloads and rejects copied or corrupt ciphertext', () => {
  const safeStorage = fakeVault();
  const dev = createDesktopSecretCodec({ safeStorage, appId: 'app.starroy.mioon.dev', platform: 'linux' });
  const production = createDesktopSecretCodec({ safeStorage, appId: 'app.starroy.mioon', platform: 'linux' });
  const encrypted = dev.encrypt(DUMMY_KEY);
  assert.equal(encrypted.includes(DUMMY_KEY), false);
  assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(DUMMY_KEY)), false);
  assert.equal(dev.decrypt(encrypted), DUMMY_KEY);
  assert.throws(() => production.decrypt(encrypted), assertSanitized);
  assert.throws(() => dev.decrypt(Buffer.from(DUMMY_KEY).toString('base64')), assertSanitized);
  for (const invalid of ['!', '', 'AAAA=', encrypted + '\n', null, 12]) assert.throws(() => dev.decrypt(invalid), assertSanitized);
});

test('desktop codec rechecks availability and never leaks native error text', () => {
  const safeStorage = fakeVault();
  const codec = createDesktopSecretCodec({ safeStorage, appId: 'app.starroy.mioon.dev', platform: 'linux' });
  const encrypted = codec.encrypt(DUMMY_KEY);
  safeStorage.getSelectedStorageBackend = () => 'basic_text';
  safeStorage.encryptString = () => { throw new Error('Should not run ' + DUMMY_KEY); };
  assert.throws(() => codec.encrypt(DUMMY_KEY), assertSanitized);
  assert.throws(() => codec.decrypt(encrypted), assertSanitized);
  safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  assert.throws(() => codec.encrypt(DUMMY_KEY), assertSanitized);
  safeStorage.decryptString = () => { throw new Error(DUMMY_KEY); };
  assert.throws(() => codec.decrypt(encrypted), assertSanitized);
  assert.throws(() => codec.encrypt('a'.repeat(33 * 1024)), assertSanitized);
});

test('broker exposes only bounded get/put requests with safe errors', async () => {
  const messages = []; let calls = 0;
  const broker = createAgentSettingsBroker({ send: value => messages.push(value),
    agentSettings: { get() { calls++; throw Object.assign(new Error(DUMMY_KEY), { code: DUMMY_KEY }); }, put() { calls++; } } });
  for (const message of [request('decrypt', { input: { apiKey: DUMMY_KEY } }), request('get', { input: {} }),
    request('put', { input: [] }), request('put', { input: { apiKey: 'a'.repeat(MAX_AGENT_SETTINGS_MESSAGE_BYTES) } }),
    request('get', { arbitrary: DUMMY_KEY }), request('get', { selfPort: 0 }), request('get', { version: 2 })]) {
    assert.equal(broker.handle(message), true);
  }
  assert.equal(calls, 0);
  assert.equal(messages.length, 7);
  for (const message of messages) { assert.equal(message.ok, false); assertSanitized(message); }
  assert.equal(broker.handle({ type: 'different' }), false);
  assert.equal(broker.handle({ type: 'agent-settings-request', requestId: DUMMY_KEY }), true);
  assert.equal(messages.length, 7);
  broker.handle(request());
  await nextTurn();
  assert.equal(calls, 1); assert.equal(messages.at(-1).ok, false); assertSanitized(messages.at(-1));
  broker.close();
});

test('broker public serializer excludes raw keys, ciphertext and arbitrary engine properties', async () => {
  const base = await sampleSettings();
  const messages = [];
  const broker = createAgentSettingsBroker({ send: value => messages.push(value),
    agentSettings: { get: async () => ({ ...base, apiKey: DUMMY_KEY, plaintext: DUMMY_KEY, encryptedKey: DUMMY_KEY, envelope: { secret: DUMMY_KEY },
      secret: { ...base.secret, value: DUMMY_KEY, ciphertext: DUMMY_KEY },
      storage: { ...base.storage, path: DUMMY_KEY }, presets: [{ secret: DUMMY_KEY }] }) } });
  broker.handle(request()); await nextTurn();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, true);
  assert.deepEqual(messages[0].data, base);
  assertSanitized(messages[0]);
  broker.close();
});

test('broker fails closed on malformed public configuration without echoing it', async () => {
  const base = await sampleSettings(), messages = [];
  const broker = createAgentSettingsBroker({ send: value => messages.push(value),
    agentSettings: { get: async () => ({ ...base, configuration: { ...base.configuration, value: DUMMY_KEY } }) } });
  broker.handle(request()); await nextTurn();
  assert.equal(messages.length, 1); assert.equal(messages[0].ok, false); assertSanitized(messages[0]);
  broker.close();
});

test('broker handles duplicates once, pins service port and ignores late replies after close', async () => {
  const base = await sampleSettings();
  let finish, calls = 0;
  const messages = [];
  const broker = createAgentSettingsBroker({ send: value => messages.push(value), getSelfPort: () => 4319,
    agentSettings: { put(input, options) { calls++; assert.deepEqual(options, { selfPort: 4319 }); return new Promise(resolve => { finish = resolve; }); } } });
  broker.handle(request('put', { input: {}, selfPort: 4320 }));
  assert.equal(messages.at(-1).ok, false); assert.equal(calls, 0);
  const message = request('put', { input: {}, selfPort: 4319 });
  broker.handle(message); broker.handle(message);
  assert.equal(calls, 1);
  finish(base); await nextTurn();
  assert.equal(messages.at(-1).ok, true);
  broker.handle(message); assert.equal(calls, 1);
  const late = request('put', { input: {}, selfPort: 4319 });
  broker.handle(late); const count = messages.length;
  broker.close(); finish(base); await nextTurn();
  assert.equal(messages.length, count);
  broker.handle(request('put', { input: {}, selfPort: 4319 })); assert.equal(calls, 2);
});

function pairedPort() {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = value => port.sent.push(value);
  return port;
}

test('utility client resolves only a matching safe reply and rejects pending work on close', async () => {
  const base = await sampleSettings(), port = pairedPort();
  const client = createAgentSettingsClient({ port });
  assert.deepEqual(Object.keys(client).sort(), ['close', 'get', 'put']);
  const operation = client.get({ selfPort: 4319 });
  const sent = port.sent[0];
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: randomUUID(), ok: true, data: base } });
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: sent.requestId, ok: true, data: base } });
  assert.deepEqual(await operation, base);
  const pending = client.put({ apiKey: DUMMY_KEY });
  const rejected = assert.rejects(pending, error => error.code === 'AGENT_SETTINGS_UNAVAILABLE' && assertSanitized(error));
  port.emit('close'); await rejected;
  assert.equal(port.listenerCount('message'), 0);
  await assert.rejects(client.get(), { code: 'AGENT_SETTINGS_UNAVAILABLE' });
  client.close();
});

test('utility client bounds requests, timeouts and malformed/raw-error replies', async () => {
  const port = pairedPort(), client = createAgentSettingsClient({ port, timeout: 10 });
  await assert.rejects(client.put({ apiKey: 'a'.repeat(MAX_AGENT_SETTINGS_MESSAGE_BYTES) }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(client.get({ selfPort: -1 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(client.get(), { code: 'AGENT_SETTINGS_TIMEOUT' });
  const pending = client.get();
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: port.sent.at(-1).requestId,
    ok: false, error: { code: DUMMY_KEY, message: DUMMY_KEY, details: DUMMY_KEY } } });
  await assert.rejects(pending, assertSanitized);
  const malformed = client.get();
  port.emit('message', { data: { type: 'agent-settings-response', version: 2, requestId: port.sent.at(-1).requestId, ok: true, data: DUMMY_KEY } });
  await assert.rejects(malformed, { code: 'AGENT_SETTINGS_UNAVAILABLE' });
  client.close();
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 23456; child.sent = [];
  child.postMessage = message => {
    child.sent.push(message);
    if (message.type === 'start') setImmediate(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:4321', runtime: { pid: child.pid } }));
    if (message.type === 'stop') setImmediate(() => child.emit('exit', 0));
  };
  child.kill = () => child.emit('exit', 1);
  return child;
}

test('supervisor binds each settings reply to its child across exit and replacement', async () => {
  const base = await sampleSettings();
  const first = fakeChild(), second = fakeChild();
  let finish, count = 0;
  const engine = { get: async () => base, put() { count++; return new Promise(resolve => { finish = resolve; }); } };
  let next = first;
  const supervisor = new BackendSupervisor({ fork: () => next, modulePath: '/app/backend.cjs', environment: {}, agentSettings: engine });
  await supervisor.start({});
  first.emit('message', request('put', { input: {}, selfPort: 4321 }));
  assert.equal(count, 1);
  first.emit('exit', 1);
  next = second;
  await supervisor.start({});
  finish(base); await nextTurn();
  assert.equal(first.sent.filter(message => message.type === 'agent-settings-response').length, 0);
  assert.equal(second.sent.filter(message => message.type === 'agent-settings-response').length, 0);
  first.emit('message', request('put', { input: {}, selfPort: 4321 }));
  assert.equal(count, 1);
  second.emit('message', request('get', { selfPort: 4321 })); await nextTurn();
  assert.equal(second.sent.at(-1).ok, true);
  await supervisor.stop();
});

test('desktop source keeps the renderer sandbox and native secret channel private', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../apps/desktop/src/backend.mjs', import.meta.url), 'utf8');
  const broker = await readFile(new URL('../apps/desktop/src/secret-broker.mjs', import.meta.url), 'utf8');
  assert.match(main, /app\.enableSandbox\(\)/);
  assert.match(main, /app\.getPath\('userData'\)/);
  assert.match(backend, /createAgentSettingsClient\(\{ port: process\.parentPort \}\)/);
  for (const source of [main, backend, broker]) {
    assert.doesNotMatch(source, /ipcMain|ipcRenderer|contextBridge|preload\s*:/);
    assert.doesNotMatch(source, /sandbox\s*:\s*false|nodeIntegration\s*:\s*true/);
  }
});

test('desktop settings persist ciphertext outside project data with owner-only files', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-persistent-'));
  const safeStorage = fakeVault();
  let engine;
  try {
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    const initial = await engine.get();
    const saved = await engine.put({ expectedRevision: initial.revision, configuration: initial.configuration,
      secret: { action: 'replace', value: DUMMY_KEY, storage: 'persistent' } });
    assert.deepEqual(saved.secret, { configured: true, storage: 'persistent' });
    assert.deepEqual(saved.storage, { persistentAvailable: true, sessionScope: 'app', reasonCode: null });
    assertSanitized(saved);
    const directory = path.join(userData, 'agent-settings'), file = path.join(directory, 'settings.json');
    const stored = await readFile(file, 'utf8');
    assert.equal(stored.includes(DUMMY_KEY), false);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(userData), ['agent-settings']);
    await engine.close();
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    const restored = await engine.get();
    assert.deepEqual(restored.secret, saved.secret); assert.equal(restored.revision, saved.revision); assertSanitized(restored);
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

test('unavailable Linux vault supports explicit session-only entry until app engine closes', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-session-'));
  const safeStorage = fakeVault({ backend: 'basic_text' });
  let engine;
  try {
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    const initial = await engine.get();
    await assert.rejects(engine.put({ expectedRevision: initial.revision, configuration: initial.configuration,
      secret: { action: 'replace', value: DUMMY_KEY, storage: 'persistent' } }), { code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE' });
    const saved = await engine.put({ expectedRevision: initial.revision, configuration: initial.configuration,
      secret: { action: 'replace', value: DUMMY_KEY, storage: 'session' } });
    assert.deepEqual(saved.secret, { configured: true, storage: 'session' });
    assert.equal(saved.storage.sessionScope, 'app'); assert.equal(saved.storage.persistentAvailable, false);
    // A new utility/client gets the same main-owned session, with no getter for
    // its actual key. Closing that client does not close the app-owned engine.
    for (let restart = 0; restart < 2; restart++) {
      const port = pairedPort();
      const broker = createAgentSettingsBroker({ agentSettings: engine, send: data => port.emit('message', { data }) });
      port.postMessage = data => { queueMicrotask(() => broker.handle(data)); };
      const client = createAgentSettingsClient({ port });
      assert.deepEqual((await client.get()).secret, saved.secret);
      client.close(); broker.close();
    }
    assert.equal((await readFile(path.join(userData, 'agent-settings/settings.json'), 'utf8')).includes(DUMMY_KEY), false);
    await engine.close();
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    assert.deepEqual((await engine.get()).secret, { configured: false, storage: 'none' });
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

test('native encryption failure preserves the previously committed credential and hides native errors', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-failure-'));
  const safeStorage = fakeVault();
  let engine;
  try {
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    const initial = await engine.get();
    const saved = await engine.put({ expectedRevision: initial.revision, configuration: initial.configuration,
      secret: { action: 'replace', value: DUMMY_KEY, storage: 'persistent' } });
    const file = path.join(userData, 'agent-settings/settings.json'), before = await readFile(file, 'utf8');
    safeStorage.encryptString = () => { throw new Error(DUMMY_KEY); };
    await assert.rejects(engine.put({ expectedRevision: saved.revision, configuration: saved.configuration,
      secret: { action: 'replace', value: DUMMY_KEY + '-replacement', storage: 'persistent' } }), assertSanitized);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await engine.get(), saved);
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

test('settings initialization failure stays scoped to the dedicated settings service', async () => {
  const settings = await createDesktopAgentSettings({ safeStorage: fakeVault(), userData: 'relative-not-allowed', appId: 'app.starroy.mioon.dev' });
  assert.deepEqual(Object.keys(settings).sort(), ['close', 'get', 'put']);
  await assert.rejects(settings.get(), assertSanitized);
  await assert.rejects(settings.put({ secret: DUMMY_KEY }), assertSanitized);
  await settings.close();
});

test('broker bounds concurrent utility requests without retaining unbounded plaintext inputs', async () => {
  const base = await sampleSettings(), messages = [], finishes = [];
  const broker = createAgentSettingsBroker({ send: value => messages.push(value),
    agentSettings: { get: () => new Promise(resolve => finishes.push(resolve)) } });
  for (let index = 0; index < 33; index++) broker.handle(request());
  assert.equal(finishes.length, 32); assert.equal(messages.length, 1);
  assert.equal(messages[0].error.code, 'AGENT_SETTINGS_BUSY');
  broker.close();
  for (const finish of finishes) finish(base);
  await nextTurn();
  assert.equal(messages.length, 1);
});

test('supervisor lets an in-flight settings request reply during graceful HTTP shutdown', async () => {
  const base = await sampleSettings(), child = fakeChild();
  const originalSend = child.postMessage;
  child.postMessage = message => { if (message.type === 'stop') child.sent.push(message); else originalSend(message); };
  let finish;
  const supervisor = new BackendSupervisor({ fork: () => child, modulePath: '/app/backend.cjs', environment: {},
    agentSettings: { get: () => new Promise(resolve => { finish = resolve; }) } });
  await supervisor.start({});
  child.emit('message', request('get', { selfPort: 4321 }));
  const stopping = supervisor.stop();
  finish(base); await nextTurn();
  assert.equal(child.sent.at(-1).type, 'agent-settings-response');
  assert.equal(child.sent.at(-1).ok, true);
  child.emit('exit', 0); await stopping;
});
