import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID, createCipheriv, createDecipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createDesktopSecretCodec} from '../apps/desktop/src/secret-store.mjs';
import {createDesktopImageSecretCodec} from '../apps/desktop/src/image-secret-store.mjs';
import {createImageSecretBroker, createImageSecretClient, MAX_IMAGE_SECRET_MESSAGE_BYTES} from '../apps/desktop/src/image-secret-broker.mjs';
import {BackendSupervisor} from '../apps/desktop/src/supervisor.mjs';
import {createImageSettings, IMAGE_CREDENTIAL_ACQUIRE} from '../packages/business/src/images/settings.mjs';
import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.mjs';

const SENTINEL = 'synthetic-images-key-never-live';
const AGENT_SENTINEL = 'synthetic-agent-key-never-live';
const APP_ID = 'app.starroy.mioon.dev';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const configuration = structuredClone(DEFAULT_IMAGE_CONFIGURATION);
const binding = JSON.stringify([IMAGE_SETTINGS_NAMESPACE, configuration.providerId, configuration.profileId,
  configuration.baseUrl, configuration.model, configuration.options]);
const plaintext = JSON.stringify({version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, binding, value: SENTINEL});
const storage = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};

// Synthetic authenticated crypto only. No native Electron, provider, live key,
// macOS keychain or network is involved in this fixture or this test file.
function fakeVault() {
  let counter = 0;
  const key = Buffer.alloc(32, 12);
  return {
    async isAsyncEncryptionAvailable() { return this.isEncryptionAvailable(); },
    async encryptStringAsync(value) { return this.encryptString(value); },
    async decryptStringAsync(value) { return {result: this.decryptString(value), shouldReEncrypt: false}; },
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
function imageCodec(safeStorage = fakeVault(), platform = 'darwin') {
  return createDesktopImageSecretCodec({safeStorage, appId: APP_ID, platform});
}
function request(operation = 'status', extra = {}) {
  return {type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId: randomUUID(), operation, ...extra};
}
function reply(requestId, data, extra = {}) {
  return {type: 'image-secret-codec-response', version: 1, namespace: 'images', requestId, ok: true, data, ...extra};
}
function assertSanitized(value) {
  const bytes = JSON.stringify(value) + String(value?.message);
  for (const secret of [SENTINEL, AGENT_SENTINEL]) assert.equal(bytes.includes(secret), false);
  return true;
}
function pairedPort() {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = message => port.sent.push(message);
  return port;
}
function connected(safeStorage = fakeVault(), platform = 'darwin') {
  const port = pairedPort(), replies = [];
  const broker = createImageSecretBroker({imageSecretCodec: imageCodec(safeStorage, platform),
    send: data => { replies.push(data); port.emit('message', {data}); }});
  port.postMessage = data => { port.sent.push(data); broker.handle(data); };
  const client = createImageSecretClient({port});
  return {port, broker, client, replies, close() { client.close(); broker.close(); }};
}

for (const platform of ['linux', 'darwin']) test('Images codec preserves the existing channel wrapper and fixes utility session scope (' + platform + ')', async () => {
  const safeStorage = fakeVault(), codec = imageCodec(safeStorage, platform);
  assert.deepEqual(await codec.storage(), storage);
  const encrypted = await codec.encrypt(plaintext);
  assert.equal(await codec.decrypt(encrypted), plaintext);
  assert.equal(encrypted.includes(SENTINEL), false);
  assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(SENTINEL)), false);
  const wrapper = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
  assert.deepEqual(wrapper, {version: 1, appId: APP_ID, plaintext});
  const production = createDesktopImageSecretCodec({safeStorage, appId: 'app.starroy.mioon', platform});
  await assert.rejects(async () => production.decrypt(encrypted), assertSanitized);
});

for (const platform of ['linux', 'darwin']) test('Images codec cannot encrypt arbitrary plaintext or disclose copied Agent/video ciphertext (' + platform + ')', async () => {
  const safeStorage = fakeVault(), codec = imageCodec(safeStorage, platform);
  const legacy = createDesktopSecretCodec({safeStorage, appId: APP_ID, platform});
  const bad = [AGENT_SENTINEL, JSON.stringify({version: 1, binding, value: AGENT_SENTINEL}),
    JSON.stringify({...JSON.parse(plaintext), namespace: 'mioon.agent.v1'}),
    JSON.stringify({...JSON.parse(plaintext), binding: binding.replace('https://api.openai.com/v1', 'https://attacker.example/v1')}),
    JSON.stringify({...JSON.parse(plaintext), binding: binding.replace('gpt-image-', 'different-image-')}),
    JSON.stringify({...JSON.parse(plaintext), binding: binding.replace('1024x1024', '1536x1024')}),
    JSON.stringify({...JSON.parse(plaintext), extra: 'unexpected'}),
    JSON.stringify({...JSON.parse(plaintext), value: SENTINEL + '\n'}),
    JSON.stringify({...JSON.parse(plaintext), value: 'x'.repeat(8193)})];
  for (const value of bad) {
    await assert.rejects(async () => codec.encrypt(value), assertSanitized);
    const copied = await legacy.encrypt(value);
    await assert.rejects(async () => codec.decrypt(copied), assertSanitized);
    assert.equal(await legacy.decrypt(copied), value);
  }
  await assert.rejects(async () => codec.encrypt('x'.repeat(17 * 1024)), assertSanitized);
});

test('Images Linux codec rejects weak backends and sanitizes actual strong-keyring native failures', async () => {
  const safeStorage = fakeVault(), codec = createDesktopImageSecretCodec({safeStorage, appId: APP_ID, platform: 'linux'});
  const encrypted = Buffer.from('synthetic-ciphertext').toString('base64');
  let calls = 0;
  safeStorage.encryptString = () => { calls++; throw new Error(SENTINEL); };
  safeStorage.decryptString = () => { calls++; throw new Error(AGENT_SENTINEL); };
  safeStorage.getSelectedStorageBackend = () => 'basic_text';
  assert.deepEqual(await codec.storage(), {persistentAvailable: false, sessionScope: 'server', reasonCode: 'LINUX_BASIC_TEXT'});
  await assert.rejects(codec.encrypt(plaintext), assertSanitized);
  await assert.rejects(codec.decrypt(encrypted), assertSanitized);
  assert.equal(calls, 0);
  safeStorage.getSelectedStorageBackend = () => 'unknown';
  assert.equal((await codec.storage()).persistentAvailable, false);
  safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  await assert.rejects(codec.encrypt(plaintext), assertSanitized);
  await assert.rejects(codec.decrypt(encrypted), assertSanitized);
  assert.equal(calls, 2, 'Both actual Linux crypto failures are sanitized');
  await assert.rejects(imageCodec(safeStorage).encrypt(plaintext), assertSanitized);
  assert.equal(calls, 3, 'The macOS probe failure is separately exercised');
});

test('Images broker rejects all nonfixed operations, namespaces and oversized envelopes', async () => {
  const messages = []; let calls = 0;
  const codec = {storage() { calls++; return storage; }, encrypt() { calls++; }, decrypt() { calls++; }};
  const broker = createImageSecretBroker({imageSecretCodec: codec, send: value => messages.push(value)});
  for (const invalid of [request('get'), request('put', {input: {apiKey: SENTINEL}}), request('acquire'),
    request('status', {input: SENTINEL}), request('status', {namespace: 'agent'}), request('status', {version: 2}),
    request('status', {path: '/private/agent-settings.json'}), request('status', {url: 'https://attacker.example'}),
    request('encrypt', {input: SENTINEL}), request('decrypt', {input: SENTINEL}),
    request('encrypt', {input: 'x'.repeat(MAX_IMAGE_SECRET_MESSAGE_BYTES)})]) {
    assert.equal(broker.handle(invalid), true);
  }
  await nextTurn();
  assert.equal(calls, 0); assert.equal(messages.length, 11);
  for (const message of messages) { assert.equal(message.ok, false); assertSanitized(message); }
  assert.equal(broker.handle({type: 'agent-settings-request'}), false);
  broker.handle(request('status', {requestId: SENTINEL}));
  assert.equal(messages.length, 11);
  broker.close();
});

test('Images broker queues bounded work and never replays completed plaintext responses', async () => {
  const messages = [], codec = imageCodec(), encrypted = await codec.encrypt(plaintext);
  let decrypts = 0;
  const broker = createImageSecretBroker({imageSecretCodec: {...codec, decrypt(value) { decrypts++; return codec.decrypt(value); }},
    send: value => messages.push(value)});
  const repeated = request('decrypt', {input: encrypted});
  broker.handle(repeated); broker.handle(repeated);
  await nextTurn();
  assert.equal(decrypts, 1); assert.equal(messages.length, 1); assert.equal(messages[0].data, plaintext);
  broker.handle(repeated);
  assert.equal(decrypts, 1); assert.equal(messages.length, 2); assert.equal(messages[1].ok, false); assertSanitized(messages[1]);
  for (let i = 0; i < 17; i++) broker.handle(request());
  assert.equal(messages.at(-1).error.code, 'IMAGE_SECRET_CODEC_BUSY');
  await nextTurn();
  assert.equal(messages.filter(value => value.ok && typeof value.data === 'object').length, 16);
  broker.close();
});

test('Images broker sanitizes malformed outputs and fences queued work on close or inactive child', async () => {
  const messages = []; let active = true, calls = 0;
  const broker = createImageSecretBroker({imageSecretCodec: {storage() { calls++; return {...storage, path: SENTINEL}; },
    encrypt() { throw new Error(SENTINEL); }, decrypt() { return AGENT_SENTINEL; }},
    isActive: () => active, send: value => messages.push(value)});
  broker.handle(request()); await nextTurn();
  broker.handle(request('encrypt', {input: plaintext})); await nextTurn();
  broker.handle(request('decrypt', {input: Buffer.from('synthetic-ciphertext').toString('base64')})); await nextTurn();
  assert.equal(messages.length, 3);
  for (const message of messages) { assert.equal(message.ok, false); assertSanitized(message); }
  broker.handle(request()); active = false; await nextTurn();
  assert.equal(calls, 1); assert.equal(messages.length, 3);
  active = true; broker.handle(request()); broker.close(); await nextTurn();
  assert.equal(calls, 1); assert.equal(messages.length, 3);
});

for (const platform of ['linux', 'darwin']) test('Images utility client refreshes redacted availability before every cryptographic operation (' + platform + ')', async t => {
  const safeStorage = fakeVault(), pair = connected(safeStorage, platform); t.after(() => pair.close());
  assert.deepEqual(pair.client.storage(), {persistentAvailable: false, sessionScope: 'server', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'});
  assert.deepEqual(await pair.client.refreshStorage(), storage);
  const encrypted = await pair.client.encrypt(plaintext);
  assert.equal(await pair.client.decrypt(encrypted), plaintext);
  assert.deepEqual(pair.port.sent.map(value => value.operation), ['status', 'status', 'encrypt', 'status', 'decrypt']);
  const detached = pair.client.storage(); detached.persistentAvailable = false;
  assert.equal(pair.client.storage().persistentAvailable, true);
  safeStorage.isEncryptionAvailable = () => false;
  await assert.rejects(async () => pair.client.encrypt(plaintext), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal(pair.port.sent.at(-1).operation, 'status');
  assert.equal(pair.client.storage().persistentAvailable, false);
  safeStorage.isEncryptionAvailable = () => true;
  if (platform === 'darwin') await assert.rejects(async () => pair.client.decrypt(encrypted), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  else assert.equal(await pair.client.decrypt(encrypted), plaintext, 'Linux availability recovery preserves the same ciphertext');
  const restarted = connected(fakeVault(), platform); t.after(() => restarted.close());
  assert.equal(await restarted.client.decrypt(encrypted), plaintext);
});

test('Images utility never receives another namespace key through copied ciphertext', async t => {
  const safeStorage = fakeVault(), pair = connected(safeStorage); t.after(() => pair.close());
  const legacy = createDesktopSecretCodec({safeStorage, appId: APP_ID, platform: 'darwin'});
  const encrypted = await legacy.encrypt(JSON.stringify({version: 1, binding: 'agent', value: AGENT_SENTINEL}));
  await assert.rejects(pair.client.decrypt(encrypted), assertSanitized);
  pair.replies.forEach(assertSanitized);
  assert.equal(pair.client.storage().persistentAvailable, false);
});

test('Images utility ignores uncorrelated replies and rejects malformed, raw-error and late replies', async t => {
  const port = pairedPort(), client = createImageSecretClient({port, timeout: 20}); t.after(() => client.close());
  const pending = client.refreshStorage(), requestId = port.sent.at(-1).requestId;
  port.emit('message', {data: reply(randomUUID(), storage)});
  port.emit('message', {data: reply(requestId, storage, {namespace: 'agent'})});
  await assert.rejects(pending, {code: 'IMAGE_SECRET_CODEC_UNAVAILABLE'});
  const rawError = client.refreshStorage();
  port.emit('message', {data: {type: 'image-secret-codec-response', version: 1, namespace: 'images',
    requestId: port.sent.at(-1).requestId, ok: false, error: {code: SENTINEL, message: SENTINEL, status: 500}}});
  await assert.rejects(rawError, assertSanitized);
  const timeout = client.refreshStorage(), lateId = port.sent.at(-1).requestId;
  await assert.rejects(timeout, {code: 'IMAGE_SECRET_CODEC_TIMEOUT'});
  port.emit('message', {data: reply(lateId, storage)});
  assert.equal(client.storage().persistentAvailable, false);
  await assert.rejects(client.encrypt(SENTINEL), {code: 'IMAGE_SECRET_CODEC_VALIDATION'});
});

test('Images utility caps in-flight requests and closes all pending operations', async () => {
  const port = pairedPort(), client = createImageSecretClient({port});
  const outcomes = Array.from({length: 17}, () => client.encrypt(plaintext).then(() => null, error => error));
  assert.equal(port.sent.length, 1);
  port.emit('message', {data: reply(port.sent[0].requestId, storage)});
  await nextTurn();
  assert.equal(port.sent.filter(value => value.operation === 'encrypt').length, 16);
  port.emit('close');
  const errors = await Promise.all(outcomes);
  assert.equal(errors.filter(error => error.code === 'IMAGE_SECRET_CODEC_BUSY').length, 1);
  assert.equal(errors.filter(error => error.code === 'IMAGE_SECRET_CODEC_UNAVAILABLE').length, 16);
  assert.equal(port.listenerCount('message'), 0); assert.equal(port.listenerCount('close'), 0);
  await assert.rejects(client.refreshStorage(), {code: 'IMAGE_SECRET_CODEC_UNAVAILABLE'});
  assert.equal(client.storage().persistentAvailable, false);
});

function fakeChild() {
  const child = new EventEmitter(); child.pid = 23456; child.sent = [];
  child.postMessage = message => {
    child.sent.push(message);
    if (message.type === 'start') setImmediate(() => child.emit('message', {type: 'ready', url: 'http://127.0.0.1:4321', runtime: {pid: child.pid}}));
    if (message.type === 'stop') setImmediate(() => child.emit('exit', 0));
  };
  child.kill = () => child.emit('exit', 1);
  return child;
}

test('supervisor serves Images startup status and fences crypto across child replacement', async () => {
  const first = fakeChild(), second = fakeChild(), codec = imageCodec(); let next = first;
  const supervisor = new BackendSupervisor({fork: () => next, modulePath: '/app/backend.cjs', environment: {}, imageSecretCodec: codec});
  const starting = supervisor.start({});
  first.emit('message', request()); await nextTurn(); await starting;
  assert.equal(first.sent.find(value => value.type === 'image-secret-codec-response').data.sessionScope, 'server');
  const encrypted = await codec.encrypt(plaintext), before = first.sent.length;
  first.emit('message', request('decrypt', {input: encrypted})); first.emit('exit', 1);
  next = second; await supervisor.start({});
  assert.equal(first.sent.length, before);
  assert.equal(second.sent.filter(value => value.type === 'image-secret-codec-response').length, 0);
  first.emit('message', request('decrypt', {input: encrypted}));
  second.emit('message', request()); await nextTurn();
  assert.equal(second.sent.at(-1).ok, true); assert.equal(first.sent.length, before);
  await supervisor.stop();
});

for (const platform of ['linux', 'darwin']) test('utility engine persists only ciphertext and drops session Images credentials at utility close (' + platform + ')', async t => {
  let stored = null;
  const persistence = {async load() { return structuredClone(stored); }, async save(value) { stored = structuredClone(value); }};
  const safeStorage = fakeVault(), pair = connected(safeStorage, platform); t.after(() => pair.close());
  let engine = await createImageSettings({persistence, secretCodec: pair.client, storage: pair.client.storage});
  t.after(() => engine.close());
  const initial = await engine.get();
  assert.equal(initial.storage.sessionScope, 'server');
  const saved = await engine.put({expectedRevision: initial.revision, configuration: {...configuration, enabled: true},
    secret: {action: 'replace', storage: 'persistent', value: SENTINEL}});
  assert.equal(saved.secret.storage, 'persistent'); assertSanitized(stored);
  await engine.close();
  engine = await createImageSettings({persistence, secretCodec: pair.client, storage: pair.client.storage});
  assert.equal((await engine[IMAGE_CREDENTIAL_ACQUIRE]({expectedRevision: saved.revision, configuration: saved.configuration})).apiKey, SENTINEL);
  safeStorage.isEncryptionAvailable = () => false;
  const locked = await engine.get(); assert.equal(locked.storage.persistentAvailable, false);
  const session = await engine.put({expectedRevision: locked.revision, configuration: locked.configuration,
    secret: {action: 'replace', storage: 'session', value: SENTINEL}});
  assert.equal(session.secret.storage, 'session'); assert.equal(stored.secret, null); assertSanitized(stored);
  await engine.close();
  engine = await createImageSettings({persistence, secretCodec: pair.client, storage: pair.client.storage});
  assert.deepEqual((await engine.get()).secret, {configured: false, storage: 'none'});
});

test('desktop wiring adds no renderer capability and leaves settings ownership in the utility', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../apps/desktop/src/backend.mjs', import.meta.url), 'utf8');
  const broker = await readFile(new URL('../apps/desktop/src/image-secret-broker.mjs', import.meta.url), 'utf8');
  assert.match(main, /createDesktopImageSecretCodec\(\{ safeStorage, appId: identity\.appId \}\)/);
  assert.doesNotMatch(main, /createImageSettings\(/);
  assert.match(backend, /createImageSecretClient\(\{ port: process\.parentPort \}\)/);
  assert.match(backend, /startServer\(\{ dataDir: data\.dataDir, port: 0, distDir: data\.distDir, token: data\.token, agentSettings, imageSecretCodec, localDraftChannel: __MIOON_DESKTOP_CHANNEL__ \}\)/);
  for (const source of [main, backend, broker]) {
    assert.doesNotMatch(source, /ipcMain|ipcRenderer|contextBridge|preload\s*:/);
    assert.doesNotMatch(source, /sandbox\s*:\s*false|nodeIntegration\s*:\s*true/);
  }
});
