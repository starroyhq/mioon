import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { desktopSecretStorage, createDesktopSecretCodec, createDesktopAgentSettings } from '../apps/desktop/src/secret-store.ts';
import { createAgentSettingsBroker, createAgentSettingsClient, MAX_AGENT_SETTINGS_MESSAGE_BYTES } from '../apps/desktop/src/secret-broker.ts';
import { BackendSupervisor } from '../apps/desktop/src/supervisor.ts';
import { DEFAULT_AGENT_CONFIGURATION } from '../packages/business/src/agent/presets.ts';
import { AGENT_CREDENTIAL_ACQUIRE } from '../packages/business/src/agent/settings.ts';
import { agentCredentialBinding } from '../packages/business/src/agent/config.ts';

type AgentCodecOptions = Parameters<typeof createDesktopSecretCodec>[0];
type SafeStorageArg = Parameters<typeof desktopSecretStorage>[0];
type BrokerOptions = Parameters<typeof createAgentSettingsBroker>[0];
type SupervisorOptions = ConstructorParameters<typeof BackendSupervisor>[0];
type EngineOptions = Parameters<typeof createDesktopAgentSettings>[0];
interface SentMessage {ok?: boolean; data?: unknown; error?: {code?: string}; type?: string; requestId?: string; [key: string]: unknown}
type Port = EventEmitter & {sent: SentMessage[]; postMessage(message: unknown): void};
interface AsyncAgentCodec {storage(): {persistentAvailable: boolean}; refreshStorage(): Promise<unknown>; encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string>; close(): void}
interface SyncAgentCodec {storage(): {persistentAvailable: boolean}; refreshStorage(): unknown; encrypt(plaintext: string): string; decrypt(ciphertext: string): string; close(): void}
const asyncCodec = (options: AgentCodecOptions): AsyncAgentCodec => createDesktopSecretCodec(options) as unknown as AsyncAgentCodec;
const syncCodec = (options: AgentCodecOptions): SyncAgentCodec => createDesktopSecretCodec(options) as unknown as SyncAgentCodec;
const storageOf = (vault: unknown, platform: NodeJS.Platform) => desktopSecretStorage(vault as unknown as SafeStorageArg, platform);
type SafeStorage = Parameters<typeof createDesktopSecretCodec>[0]['safeStorage'];
const DUMMY_KEY = 'dummy-desktop-only-credential-never-live';
const nextTurn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

// Synthetic crypto fixture only. This does not certify native OS keychain
// behavior on Linux, macOS or Windows, and no provider request is made.
interface FakeAgentVault {
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(value: string): Promise<Buffer>;
  decryptStringAsync?(value: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
  isEncryptionAvailable?(): boolean;
  getSelectedStorageBackend?(): string | undefined;
  encryptString?(value: string): Buffer;
  decryptString?(value: Buffer): string;
}
function fakeVault({ backend = 'gnome_libsecret', available = true }: {backend?: string | undefined; available?: boolean} = {}): FakeAgentVault & SafeStorage {
  let counter = 0;
  const key = Buffer.alloc(32, 7);
  const encryptString = (text: string): Buffer => {
    const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const result = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), result]);
  };
  const decryptString = (bytes: Buffer): string => {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  };
  let vault!: FakeAgentVault & SafeStorage;
  vault = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend as unknown as string,
    encryptString,
    decryptString,
    isAsyncEncryptionAvailable: async () => vault.isEncryptionAvailable?.() === true,
    encryptStringAsync: async (value: string) => vault.encryptString!(value),
    decryptStringAsync: async (value: Buffer) => ({result: vault.decryptString!(value), shouldReEncrypt: false}),
  } as unknown as FakeAgentVault & SafeStorage;
  return vault;
}

function request(operation: string = 'get', extra: Record<string, unknown> = {}) {
  return { type: 'agent-settings-request', version: 1, requestId: randomUUID(), operation, ...extra };
}
function assertSanitized(error: unknown) {
  assert.equal(JSON.stringify(error).includes(DUMMY_KEY), false);
  assert.equal(String((error as {message?: unknown} | null)?.message).includes(DUMMY_KEY), false);
  return true;
}

// Supplied once below from the real shared engine, so broker tests exercise the
// same public DTO serializer as production rather than inventing a parallel API.
async function sampleSettings() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-agent-sample-'));
  const engine = await createDesktopAgentSettings({ safeStorage: fakeVault(), userData: directory, appId: 'app.starroy.mioon.dev', platform: 'darwin' } as unknown as EngineOptions);
  const settings = await engine.get();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
  return settings;
}

test('desktop capability preserves Linux strong keyrings and requires proved macOS async crypto', async () => {
  for (const vault of [undefined, fakeVault({ available: false }), { isEncryptionAvailable() { throw new Error(DUMMY_KEY); } }]) {
    assert.deepEqual(storageOf(vault, 'linux'), {
      persistentAvailable: false, sessionScope: 'app', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'
    });
  }
  assert.deepEqual(storageOf(fakeVault({ backend: 'basic_text' }), 'linux'), {
    persistentAvailable: false, sessionScope: 'app', reasonCode: 'LINUX_BASIC_TEXT'
  });
  for (const backend of ['unknown', 'future-unknown', undefined]) {
    const vault = fakeVault(); vault.getSelectedStorageBackend = () => backend as unknown as string;
    assert.equal(storageOf(vault, 'linux').persistentAvailable, false);
  }
  const vault = fakeVault(); delete vault.getSelectedStorageBackend;
  assert.equal(storageOf(vault, 'linux').persistentAvailable, false);
  const codec = asyncCodec({safeStorage: vault, appId: 'app.starroy.mioon.dev', platform: 'darwin'});
  assert.equal(storageOf(vault, 'darwin').persistentAvailable, false);
  await codec.refreshStorage();
  assert.equal(storageOf(vault, 'darwin').persistentAvailable, true);
  assert.equal(storageOf(vault, 'win32').persistentAvailable, false);
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal(storageOf(fakeVault({ backend }), 'linux').persistentAvailable, true);
  }
});

for (const platform of ['linux', 'darwin'] as const) test('desktop codec encrypts channel-bound payloads and rejects copied or corrupt ciphertext (' + platform + ')', async () => {
  const safeStorage = fakeVault();
  const dev = asyncCodec({ safeStorage, appId: 'app.starroy.mioon.dev', platform });
  const production = asyncCodec({ safeStorage, appId: 'app.starroy.mioon', platform });
  const encrypted = await dev.encrypt(DUMMY_KEY);
  assert.equal(encrypted.includes(DUMMY_KEY), false);
  assert.equal(Buffer.from(encrypted, 'base64').includes(Buffer.from(DUMMY_KEY)), false);
  assert.equal(await dev.decrypt(encrypted), DUMMY_KEY);
  await assert.rejects(async () => production.decrypt(encrypted), assertSanitized);
  await assert.rejects(async () => dev.decrypt(Buffer.from(DUMMY_KEY).toString('base64')), assertSanitized);
  for (const invalid of ['!', '', 'AAAA=', encrypted + '\n', null, 12]) await assert.rejects(async () => dev.decrypt(invalid as string), assertSanitized);
});

test('desktop codec latches unavailable status and never leaks native error text', async () => {
  const safeStorage = fakeVault();
  const codec = asyncCodec({ safeStorage, appId: 'app.starroy.mioon.dev', platform: 'darwin' });
  const encrypted = await codec.encrypt(DUMMY_KEY);
  safeStorage.isEncryptionAvailable = () => false;
  safeStorage.encryptString = () => { throw new Error('Should not run ' + DUMMY_KEY); };
  await assert.rejects(codec.encrypt(DUMMY_KEY), assertSanitized);
  await assert.rejects(codec.decrypt(encrypted), assertSanitized);
  safeStorage.isEncryptionAvailable = () => true;
  await assert.rejects(codec.encrypt(DUMMY_KEY), assertSanitized);
  safeStorage.decryptString = () => { throw new Error(DUMMY_KEY); };
  await assert.rejects(codec.decrypt(encrypted), assertSanitized);
  await assert.rejects(codec.encrypt('a'.repeat(33 * 1024)), assertSanitized);
});

test('broker exposes only bounded get/put requests with safe errors', async () => {
  const messages: SentMessage[] = []; let calls = 0;
  const broker = createAgentSettingsBroker({ send: (value: unknown) => messages.push(value as SentMessage),
    agentSettings: { get() { calls++; throw Object.assign(new Error(DUMMY_KEY), { code: DUMMY_KEY }); }, put() { calls++; } } } as unknown as BrokerOptions);
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
  assert.equal(calls, 1); assert.equal(messages.at(-1)?.ok, false); assertSanitized(messages.at(-1));
  broker.close();
});

test('broker public serializer excludes raw keys, ciphertext and arbitrary engine properties', async () => {
  const base = await sampleSettings();
  const messages: SentMessage[] = [];
  const broker = createAgentSettingsBroker({ send: (value: unknown) => messages.push(value as SentMessage),
    agentSettings: { get: async () => ({ ...base, apiKey: DUMMY_KEY, plaintext: DUMMY_KEY, encryptedKey: DUMMY_KEY, envelope: { secret: DUMMY_KEY },
      secret: { ...base.secret, value: DUMMY_KEY, ciphertext: DUMMY_KEY },
      storage: { ...base.storage, path: DUMMY_KEY }, presets: [{ secret: DUMMY_KEY }] }) } } as unknown as BrokerOptions);
  broker.handle(request()); await nextTurn();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, true);
  assert.deepEqual(messages[0].data, base);
  assertSanitized(messages[0]);
  broker.close();
});

test('broker fails closed on malformed public configuration without echoing it', async () => {
  const base = await sampleSettings(), messages: SentMessage[] = [];
  const broker = createAgentSettingsBroker({ send: (value: unknown) => messages.push(value as SentMessage),
    agentSettings: { get: async () => ({ ...base, configuration: { ...base.configuration, value: DUMMY_KEY } }) } } as unknown as BrokerOptions);
  broker.handle(request()); await nextTurn();
  assert.equal(messages.length, 1); assert.equal(messages[0].ok, false); assertSanitized(messages[0]);
  broker.close();
});

test('broker handles duplicates once, pins service port and ignores late replies after close', async () => {
  const base = await sampleSettings();
  let finish: ((value: unknown) => void) | undefined; let calls = 0;
  const messages: SentMessage[] = [];
  const broker = createAgentSettingsBroker({ send: (value: unknown) => messages.push(value as SentMessage), getSelfPort: () => 4319,
    agentSettings: { put(_input: unknown, options: {selfPort?: number; signal?: AbortSignal; isActive?: () => boolean}) { calls++; assert.equal(options.selfPort, 4319); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.isActive?.(), true); return new Promise(resolve => { finish = resolve; }); } } } as unknown as BrokerOptions);
  broker.handle(request('put', { input: {}, selfPort: 4320 }));
  assert.equal(messages.at(-1)?.ok, false); assert.equal(calls, 0);
  const message = request('put', { input: {}, selfPort: 4319 });
  broker.handle(message); broker.handle(message);
  assert.equal(calls, 1);
  finish!(base); await nextTurn();
  assert.equal(messages.at(-1)?.ok, true);
  broker.handle(message); assert.equal(calls, 1);
  const late = request('put', { input: {}, selfPort: 4319 });
  broker.handle(late); const count = messages.length;
  broker.close(); finish!(base); await nextTurn();
  assert.equal(messages.length, count);
  broker.handle(request('put', { input: {}, selfPort: 4319 })); assert.equal(calls, 2);
});

function pairedPort(): Port {
  const port = new EventEmitter() as Port;
  port.sent = [];
  port.postMessage = value => { port.sent.push(value as SentMessage); };
  return port;
}

test('utility client resolves only a matching safe reply and rejects pending work on close', async () => {
  const base = await sampleSettings(), port = pairedPort();
  const client = createAgentSettingsClient({ port } as unknown as Parameters<typeof createAgentSettingsClient>[0]);
  assert.deepEqual(Object.keys(client).sort(), ['close', 'get', 'put']);
  const operation = client.get({ selfPort: 4319 });
  const sent = port.sent[0]!;
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: randomUUID(), ok: true, data: base } });
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: sent.requestId, ok: true, data: base } });
  assert.deepEqual(await operation, base);
  const pending = client.put({ apiKey: DUMMY_KEY });
  const rejected = assert.rejects(pending, (error: unknown) => (error as {code?: string}).code === 'AGENT_SETTINGS_UNAVAILABLE' && assertSanitized(error));
  port.emit('close'); await rejected;
  assert.equal(port.listenerCount('message'), 0);
  await assert.rejects(client.get(), { code: 'AGENT_SETTINGS_UNAVAILABLE' });
  client.close();
});

test('utility client bounds requests, timeouts and malformed/raw-error replies', async () => {
  const port = pairedPort(), client = createAgentSettingsClient({ port, timeout: 10 } as unknown as Parameters<typeof createAgentSettingsClient>[0]);
  await assert.rejects(client.put({ apiKey: 'a'.repeat(MAX_AGENT_SETTINGS_MESSAGE_BYTES) }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(client.get({ selfPort: -1 }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(client.get(), { code: 'AGENT_SETTINGS_TIMEOUT' });
  const pending = client.get();
  port.emit('message', { data: { type: 'agent-settings-response', version: 1, requestId: port.sent.at(-1)?.requestId,
    ok: false, error: { code: DUMMY_KEY, message: DUMMY_KEY, details: DUMMY_KEY } } });
  await assert.rejects(pending, assertSanitized);
  const malformed = client.get();
  port.emit('message', { data: { type: 'agent-settings-response', version: 2, requestId: port.sent.at(-1)?.requestId, ok: true, data: DUMMY_KEY } });
  await assert.rejects(malformed, { code: 'AGENT_SETTINGS_UNAVAILABLE' });
  client.close();
});

interface FakeChild extends EventEmitter {pid: number | undefined; sent: SentMessage[]; postMessage(message: SentMessage): void; kill(): void}
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 23456; child.sent = [];
  child.postMessage = message => {
    child.sent.push(message);
    if (message.type === 'start') setImmediate(() => child.emit('message', { type: 'ready', url: 'http://127.0.0.1:4321', runtime: { pid: child.pid } }));
    if (message.type === 'stop') setImmediate(() => child.emit('exit', 0));
  };
  child.kill = () => { child.emit('exit', 1); };
  return child;
}

test('supervisor binds each settings reply to its child across exit and replacement', async () => {
  const base = await sampleSettings();
  const first = fakeChild(), second = fakeChild();
  let finish, count = 0;
  const engine = { get: async () => base, put() { count++; return new Promise(resolve => { finish = resolve; }); } };
  let next = first;
  const supervisor = new BackendSupervisor({ fork: (() => next) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {}, agentSettings: engine } as unknown as SupervisorOptions);
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  first.emit('message', request('put', { input: {}, selfPort: 4321 }));
  assert.equal(count, 1);
  first.emit('exit', 1);
  next = second;
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  finish!(base); await nextTurn();
  assert.equal(first.sent.filter(message => message.type === 'agent-settings-response').length, 0);
  assert.equal(second.sent.filter(message => message.type === 'agent-settings-response').length, 0);
  first.emit('message', request('put', { input: {}, selfPort: 4321 }));
  assert.equal(count, 1);
  second.emit('message', request('get', { selfPort: 4321 })); await nextTurn();
  assert.equal(second.sent.at(-1)?.ok, true);
  await supervisor.stop();
});

test('desktop source keeps the renderer sandbox and native secret channel private', async () => {
  const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../apps/desktop/src/backend.ts', import.meta.url), 'utf8');
  const broker = await readFile(new URL('../apps/desktop/src/secret-broker.ts', import.meta.url), 'utf8');
  assert.match(main, /app\.enableSandbox\(\)/);
  assert.match(main, /app\.getPath\('userData'\)/);
  assert.match(backend, /createAgentSettingsClient\(\{ port: process\.parentPort \}\)/);
  for (const source of [backend, broker]) {
    assert.doesNotMatch(source, /ipcMain|ipcRenderer|contextBridge|preload\s*:/);
    assert.doesNotMatch(source, /sandbox\s*:\s*false|nodeIntegration\s*:\s*true/);
  }
  assert.doesNotMatch(main, /sandbox\s*:\s*false|nodeIntegration\s*:\s*true/);
  assert.deepEqual([...main.matchAll(/ipcMain\s*\.\s*handle\s*\(\s*([^,]+),/g)].map(match => match[1].trim()).sort(),
    ['APP_LANGUAGE_CHANNEL', 'CLIP_LUT_RECOVERY_CHANNEL', 'MENU_COMMAND_CHANNEL', 'NATIVE_AUDIO_CHANNEL', 'PROJECT_WINDOW_CHANNEL', 'WORKSPACE_NATIVE_CHANNEL', 'WORKSPACE_TOOLS_CHANNEL']);
  assert.doesNotMatch(main, /ipcMain\s*\[|ipcMain\s*\.\s*(?:on|once|handleOnce)\s*\(/);
  assert.match(main, /ipcMain\.handle\(PROJECT_WINDOW_CHANNEL,/);
  const preload = await readFile(new URL('../apps/desktop/src/preload.ts', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../apps/desktop/src/project-window-preload.ts', import.meta.url), 'utf8');
  const audioBridge = await readFile(new URL('../apps/desktop/src/native-audio-preview-preload.ts', import.meta.url), 'utf8');
  const languageBridge = await readFile(new URL('../apps/desktop/src/app-language-preload.ts', import.meta.url), 'utf8');
  const menuBridge = await readFile(new URL('../apps/desktop/src/menu-command-preload.ts', import.meta.url), 'utf8');
  const menuProtocol = await readFile(new URL('../apps/desktop/src/menu-command-protocol.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(preload + bridge + audioBridge + languageBridge + menuBridge + menuProtocol + await readFile(new URL('../apps/desktop/src/workspace-native-preload.ts', import.meta.url), 'utf8'), /safeStorage|secretCodec|agentSettings|decrypt|process\.parentPort|imageSecret|\.env|access-token/);
  assert.deepEqual([...preload.matchAll(/exposeInMainWorld\('([^']+)'/g)].map(match => match[1]).sort(),
    ['__mioonAppLanguage', '__mioonDesktop', '__mioonExportFiles', '__mioonLutRecovery', '__mioonMenuCommands', '__mioonNativeAudioPreview', '__mioonProjectPackages', '__mioonProjectWindow', '__mioonWorkspaceBackups', '__mioonWorkspaceTools']);
});

for (const platform of ['linux', 'darwin'] as const) test('desktop settings persist ciphertext outside project data with owner-only files (' + platform + ')', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-persistent-'));
  const safeStorage = fakeVault();
  let engine: Awaited<ReturnType<typeof createDesktopAgentSettings>> | undefined;
  try {
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform });
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
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform });
    const restored = await engine.get();
    assert.deepEqual(restored.secret, saved.secret); assert.equal(restored.revision, saved.revision); assertSanitized(restored);
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin'] as const) test('desktop legacy migration preserves encrypted channel wrapper v1 through locked-vault protocol save (' + platform + ')', async t => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-legacy-desktop-'));
  const safeStorage = fakeVault(), appId = 'app.starroy.mioon.dev';
  const vault = asyncCodec({safeStorage, appId, platform});
  const {protocol, ...configuration} = DEFAULT_AGENT_CONFIGURATION;
  const binding = agentCredentialBinding(configuration as unknown as Parameters<typeof agentCredentialBinding>[0]);
  const encrypted = await vault.encrypt(JSON.stringify({version: 1, binding, value: DUMMY_KEY}));
  const directory = path.join(userData, 'agent-settings'), file = path.join(directory, 'settings.json');
  await mkdir(directory, {mode: 0o700});
  const bytes = JSON.stringify({version: 1, revision: 12, configuration, secret: {binding, encrypted}});
  await writeFile(file, bytes, {mode: 0o600});
  const decrypt = safeStorage.decryptString!; let reads = 0;
  safeStorage.decryptString = value => { reads++; return decrypt(value); };
  safeStorage.isEncryptionAvailable = () => false;
  let engine = await createDesktopAgentSettings({safeStorage, userData, appId, platform});
  t.after(async () => { await engine.close(); await rm(userData, {recursive: true, force: true}); });
  const port = pairedPort(), replies: SentMessage[] = [];
  const broker = createAgentSettingsBroker({agentSettings: engine, send: (data: unknown) => { replies.push(data as SentMessage); port.emit('message', {data}); }});
  port.postMessage = data => queueMicrotask(() => broker.handle(data));
  type SnapshotShape = {revision: number; configuration: {protocol: string; [key: string]: unknown}; secret: {configured: boolean}; storage: {persistentAvailable: boolean}};
  const client = createAgentSettingsClient({port}) as unknown as {get(): Promise<SnapshotShape>; put(input: unknown): Promise<SnapshotShape>; close(): void}; t.after(() => { client.close(); broker.close(); });
  const initial = await client.get();
  assert.equal(initial.configuration.protocol, 'chat_completions'); assert.equal(initial.revision, 12);
  assert.equal(initial.secret.configured, true); assert.equal(initial.storage.persistentAvailable, false);
  assert.equal(await readFile(file, 'utf8'), bytes); assert.equal(reads, 0);
  const saved = await client.put({expectedRevision: 12, configuration: {...initial.configuration, protocol: 'responses'}, secret: {action: 'keep'}});
  assert.equal(saved.revision, 13); assert.equal(saved.configuration.protocol, 'responses');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 2); assert.deepEqual(stored.secret, {binding, encrypted}); assert.equal(reads, 0);
  assert.ok(replies.every(reply => reply.version === 1)); replies.forEach(assertSanitized);
  await engine.close(); safeStorage.isEncryptionAvailable = () => true;
  engine = await createDesktopAgentSettings({safeStorage: fakeVault(), userData, appId, platform});
  const restored = await engine.get();
  assert.equal((await engine[AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: restored.revision, configuration: restored.configuration})).apiKey, DUMMY_KEY);
  const wrapper = JSON.parse(decrypt(Buffer.from(encrypted, 'base64')));
  assert.equal(wrapper.version, 1); assert.equal(wrapper.appId, appId);
  assert.deepEqual(JSON.parse(wrapper.plaintext), {version: 1, binding, value: DUMMY_KEY});
  assert.equal(JSON.parse(await readFile(file, 'utf8')).secret.encrypted, encrypted);
});

test('unavailable Linux vault supports explicit session-only entry until app engine closes', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-session-'));
  const safeStorage = fakeVault({ backend: 'basic_text' });
  let engine: Awaited<ReturnType<typeof createDesktopAgentSettings>> | undefined;
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
      const broker = createAgentSettingsBroker({ agentSettings: engine, send: (data: unknown) => port.emit('message', { data }) });
      port.postMessage = data => { queueMicrotask(() => broker.handle(data)); };
      const client = createAgentSettingsClient({ port } as unknown as Parameters<typeof createAgentSettingsClient>[0]) as unknown as {get(): Promise<{secret: unknown}>; close(): void};
      assert.deepEqual((await client.get()).secret, saved.secret);
      client.close(); broker.close();
    }
    assert.equal((await readFile(path.join(userData, 'agent-settings/settings.json'), 'utf8')).includes(DUMMY_KEY), false);
    await engine.close();
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform: 'linux' });
    assert.deepEqual((await engine.get()).secret, { configured: false, storage: 'none' });
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin'] as const) test('native encryption failure preserves the previously committed credential and hides native errors (' + platform + ')', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'mioon-agent-failure-'));
  const safeStorage = fakeVault();
  let engine: Awaited<ReturnType<typeof createDesktopAgentSettings>> | undefined;
  try {
    engine = await createDesktopAgentSettings({ safeStorage, userData, appId: 'app.starroy.mioon.dev', platform });
    const initial = await engine.get();
    const saved = await engine.put({ expectedRevision: initial.revision, configuration: initial.configuration,
      secret: { action: 'replace', value: DUMMY_KEY, storage: 'persistent' } });
    const file = path.join(userData, 'agent-settings/settings.json'), before = await readFile(file, 'utf8');
    const encrypt = safeStorage.encryptString!; let payloadFailures = 0;
    safeStorage.encryptString = value => {
      if (value.startsWith('{')) { payloadFailures++; throw new Error(DUMMY_KEY); }
      return encrypt(value); // The disposable availability probe must succeed.
    };
    await assert.rejects(async () => engine!.put({ expectedRevision: saved.revision, configuration: saved.configuration,
      secret: { action: 'replace', value: DUMMY_KEY + '-replacement', storage: 'persistent' } }), assertSanitized);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(payloadFailures, 1);
    const after = await engine.get();
    assert.equal(after.revision, saved.revision); assert.deepEqual(after.secret, saved.secret);
    assert.deepEqual(after.configuration, saved.configuration);
    assert.equal(after.storage.persistentAvailable, platform === 'linux', 'Linux status remains dynamically checked; macOS native failure is latched');
  } finally { await engine?.close(); await rm(userData, { recursive: true, force: true }); }
});

test('settings initialization failure stays scoped to the dedicated settings service', async () => {
  const settings = await createDesktopAgentSettings({ safeStorage: fakeVault(), userData: 'relative-not-allowed', appId: 'app.starroy.mioon.dev' });
  assert.deepEqual(Object.keys(settings).sort(), ['close', 'get', 'put']);
  await assert.rejects(settings.get(), assertSanitized);
  await assert.rejects(settings.put({ secret: DUMMY_KEY } as unknown as Parameters<typeof settings.put>[0]), assertSanitized);
  await settings.close();
});

test('broker bounds concurrent utility requests without retaining unbounded plaintext inputs', async () => {
  const base = await sampleSettings(), messages: SentMessage[] = [], finishes: Array<(value: unknown) => void> = [];
  const broker = createAgentSettingsBroker({ send: (value: unknown) => messages.push(value as SentMessage),
    agentSettings: { get: () => new Promise(resolve => { finishes.push(resolve as (value: unknown) => void); }) } } as unknown as BrokerOptions);
  for (let index = 0; index < 33; index++) broker.handle(request());
  assert.equal(finishes.length, 32); assert.equal(messages.length, 1);
  assert.equal(messages[0]?.error?.code, 'AGENT_SETTINGS_BUSY');
  broker.close();
  for (const finish of finishes) finish(base);
  await nextTurn();
  assert.equal(messages.length, 1);
});

test('supervisor lets an in-flight settings request reply during graceful HTTP shutdown', async () => {
  const base = await sampleSettings(), child = fakeChild();
  const originalSend = child.postMessage;
  child.postMessage = message => { if (message.type === 'stop') child.sent.push(message); else originalSend(message); };
  let finish: ((value: unknown) => void) | undefined;
  const supervisor = new BackendSupervisor({ fork: (() => child) as unknown as SupervisorOptions['fork'], modulePath: '/app/backend.cjs', environment: {},
    agentSettings: { get: () => new Promise(resolve => { finish = resolve; }) } } as unknown as SupervisorOptions);
  await supervisor.start({} as Parameters<typeof supervisor.start>[0]);
  child.emit('message', request('get', { selfPort: 4321 }));
  const stopping = supervisor.stop();
  finish!(base); await nextTurn();
  assert.equal(child.sent.at(-1)?.type, 'agent-settings-response');
  assert.equal(child.sent.at(-1)?.ok, true);
  child.emit('exit', 0); await stopping;
});


test('Linux public factory rechecks availability and reads the same prior ciphertext after recovery', () => {
  const safeStorage = fakeVault();
  const vaultRecord = safeStorage as unknown as Record<string, () => unknown>;
  for (const method of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) vaultRecord[method] = () => {throw Error('Linux must never use async vault selection');};
  const codec = syncCodec({safeStorage, appId: 'app.starroy.mioon.dev', platform: 'linux'});
  const encrypted = codec.encrypt(DUMMY_KEY);
  safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => codec.decrypt(encrypted), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  safeStorage.isEncryptionAvailable = () => true;
  assert.equal(codec.decrypt(encrypted), DUMMY_KEY);
  assert.equal(codec.storage().persistentAvailable, true);
  codec.close();
  assert.equal(codec.storage().persistentAvailable, false);
});
