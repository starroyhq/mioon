import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {EventEmitter} from 'node:events';
import {randomUUID, createCipheriv, createDecipheriv} from 'node:crypto';

const APP_ID = 'app.starroy.mioon.dev';
const SENTINEL = 'synthetic-async-vault-only';
const imagePlaintexts = ['official', 'custom'].map(profile => JSON.stringify({auditProfile: profile, value: SENTINEL}));
const turn = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
function deferred<T = unknown>(): Pending<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = (value?: T | PromiseLike<T>) => { yes(value as T); }; reject = no; });
  return {promise, resolve, reject};
}
type Pending<T = void> = {promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void};
type BeforeHook = (method: string, value: string | Buffer) => Promise<void>;
const asString = (value: string | Buffer): string => value as string;
const asBuffer = (value: string | Buffer): Buffer => value as Buffer;
interface VaultNative {
  isEncryptionAvailable(): never; encryptString(...args: never[]): never; decryptString(...args: never[]): never;
  getSelectedStorageBackend(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
}
interface VaultFixture {native: VaultNative; calls: string[]; seal(value: string): Buffer; open(bytes: Buffer): string; set before(value: BeforeHook)}
type TestPort = EventEmitter & {postMessage(message: unknown): void};
interface TestChild extends EventEmitter {messages: Array<Record<string, unknown>>; postMessage(message: Record<string, unknown>): void; kill(): void}
const root = new URL('../', import.meta.url);
const data = (source: string): string => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');

// No installed dependencies are used or borrowed. Real Agent config/settings,
// codecs, brokers, supervisor and quit-helper bodies use import-only rewriting.
// Every approved TypeScript module uses Node's strip-only erasure;
// their type-only imports must never become runtime imports. Native audition
// schemas are a counted rejecting double: this secrets-only fixture supplies no
// audio configuration and must never execute an audio admission or proof.
// The Images validator is explicitly a two-string test double: these tests do
// NOT claim Zod/profile schema or filesystem acceptance. Existing suites cover it.
// Download parsing is outside this fixture. Its exact contract double counts
// calls as well as throwing, because the production download guard catches errors.
const forbidden = () => { throw Error('Filesystem persistence is outside this fixture'); };
// Exercise the real diagnostic/classification body while denying filesystem
// operations. These fixtures have no dataDir; disk acceptance has its own suite.
const diagnosticFsUrl = data(`export let writes = 0; export const constants = {};
  export function readFileSync() { throw Error('Diagnostic metadata is outside this fixture'); }
  const denied = () => { writes++; throw Error('Diagnostic persistence is outside this fixture'); };
  export {denied as chmodSync, denied as closeSync, denied as fchmodSync, denied as fstatSync,
    denied as fsyncSync, denied as lstatSync, denied as mkdirSync, denied as openSync,
    denied as renameSync, denied as unlinkSync, denied as writeSync};`);
const diagnosticFs = await import(diagnosticFsUrl);
after(() => assert.equal(diagnosticFs.writes, 0, 'Secrets-only fixtures must never attempt diagnostic writes'));
const deliveryParserUrl = data('export let calls = 0; export function parseTimelineDeliveryContentDisposition() { calls++; throw Error("Timeline delivery parsing is outside this secrets fixture"); }');
const deliveryParser = await import(deliveryParserUrl);
const nativeAudioContractsUrl = data('export let calls = 0; const forbidden = () => { calls++; throw Error("Native audition schemas are outside this secrets fixture"); }; export const nativeAudioConfigSchema = {parse: forbidden}; export const nativeAudioCommandSchema = {safeParse: forbidden}; export const nativeAudioReplySchema = {safeParse: forbidden};');
const nativeAudioContracts = await import(nativeAudioContractsUrl);
after(() => assert.equal(nativeAudioContracts.calls, 0, 'Secrets fixtures must never execute native audition schemas'));
after(() => assert.equal(deliveryParser.calls, 0, 'Secrets fixtures must never execute download parsing'));
const overrides = new Map([
  ['node:fs', diagnosticFsUrl],
  ['@mioon/contracts/timeline-delivery', deliveryParserUrl],
  ['@mioon/contracts/native-audio-preview', nativeAudioContractsUrl],
  ['@mioon/contracts', data('export {AGENT_PROTOCOLS} from ' + JSON.stringify(new URL('packages/contracts/src/agent-protocol.ts', root).href) + '; export const IMAGE_SETTINGS_LIMITS = {ciphertextCharacters: 49152};')],
  ['@mioon/business/images/settings', data('const accepted = ' + JSON.stringify(imagePlaintexts) + '; export function validateImageSecretPlaintext(value) { if (!accepted.includes(value)) throw Object.assign(new Error("Synthetic Images validation"), {code: "IMAGE_SETTINGS_VALIDATION"}); } export const imageSettingsError = code => Object.assign(new Error("Synthetic Images error"), {code});')],
  // Video crypto is outside this Agent/Images vault fixture; its fixed namespace
  // has an independent real-code suite. Importing the new broker grants no crypto.
  ['../../../packages/business/src/video/settings.ts', data('export function validateVideoSecretPlaintext() { throw Object.assign(new Error("Video credentials are outside this fixture"), {code: "VIDEO_SETTINGS_VALIDATION"}); }')],
  ['@mioon/business/agent/settings-file', data('export const createAgentSettingsFile = ' + forbidden.toString())],
  ['@mioon/contracts/private-storage', data('export const validatePrivateDirectory = ' + forbidden.toString() + '; export const ensurePrivateDirectory = validatePrivateDirectory')],
]);
const approved = new Set(['apps/desktop/src/app-language-text.ts', 'packages/i18n/src/catalogs/native.ts', 'apps/desktop/src/secret-store-linux.ts', 'apps/desktop/src/secret-store.ts', 'apps/desktop/src/image-secret-store.ts',
  'apps/desktop/src/image-secret-broker.ts', 'apps/desktop/src/video-secret-broker.ts', 'apps/desktop/src/secret-broker.ts', 'apps/desktop/src/supervisor.ts',
  'apps/desktop/src/security.ts', 'apps/desktop/src/timeline-delivery-download.ts', 'apps/desktop/src/exit-diagnostics.ts',
  'apps/desktop/src/project-window-navigation.ts', 'apps/desktop/src/native-audio-preview-broker.ts', 'apps/desktop/src/shutdown.ts', 'packages/business/src/agent/settings.ts', 'packages/business/src/agent/config.ts',
  'packages/business/src/agent/presets.ts']);
const reviewedTypeScript = approved;
const urls = new Map<string, string>();
function moduleUrl(name: string): string {
  if (urls.has(name)) return urls.get(name)!;
  assert.ok(approved.has(name), 'Unreviewed source: ' + name);
  let source = readFileSync(new URL(name, root), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/);
  if (reviewedTypeScript.has(name)) source = stripTypeScriptTypes(source, {mode: 'strip'});
  source = source.replace(/\bfrom\s+(['"])([^'"]+)\1/g, (_match: string, quote: string, specifier: string) => {
    let url = overrides.get(specifier);
    if (!url && ['node:path', 'node:crypto', 'node:net', 'node:events'].includes(specifier)) url = specifier;
    if (!url && specifier === '../identity.ts') {
      const identity = new URL('apps/desktop/identity.ts', root);
      assert.doesNotMatch(readFileSync(identity, 'utf8'), /\bimport\b|\brequire\s*\(/);
      url = identity.href;
    }
    if (!url && specifier.startsWith('@mioon/business/agent/')) url = moduleUrl('packages/business/src/agent/' + specifier.split('/').at(-1) + '.ts');
    if (!url && specifier.startsWith('.')) url = moduleUrl(new URL(specifier, new URL(name, root)).href.slice(root.href.length));
    assert.ok(url, 'Unreviewed import: ' + specifier);
    return 'from ' + JSON.stringify(url);
  });
  assert.doesNotMatch(source, /\bimport\s*['"]/);
  const url = data(source); urls.set(name, url); return url;
}
const secret = await import(moduleUrl('apps/desktop/src/secret-store.ts'));
const images = await import(moduleUrl('apps/desktop/src/image-secret-store.ts'));
const imageBridge = await import(moduleUrl('apps/desktop/src/image-secret-broker.ts'));
const agentBridge = await import(moduleUrl('apps/desktop/src/secret-broker.ts'));
const agent = await import(moduleUrl('packages/business/src/agent/settings.ts'));
const agentConfig = await import(moduleUrl('packages/business/src/agent/config.ts'));
const {DEFAULT_AGENT_CONFIGURATION} = await import(moduleUrl('packages/business/src/agent/presets.ts'));
const {BackendSupervisor} = await import(moduleUrl('apps/desktop/src/supervisor.ts'));
const {stopBackendForQuit} = await import(moduleUrl('apps/desktop/src/shutdown.ts'));

function vault(): VaultFixture {
  const key = Buffer.alloc(32, 23), calls: string[] = [];
  let counter = 0; let before: BeforeHook = async () => {};
  const seal = (value: string): Buffer => {
    const iv = Buffer.alloc(12); iv.writeUInt32BE(++counter, 8);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  };
  const open = (bytes: Buffer): string => {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  };
  const native: VaultNative = {
    isEncryptionAvailable() { throw Error('Synchronous status must not run'); },
    encryptString() { throw Error('Synchronous encryption must not run'); },
    decryptString() { throw Error('Synchronous decryption must not run'); },
    getSelectedStorageBackend: () => 'gnome_libsecret',
    async isAsyncEncryptionAvailable() { calls.push('status'); await before('status', ''); return true; },
    async encryptStringAsync(value: string) { calls.push('encrypt'); await before('encrypt', value); return seal(value); },
    async decryptStringAsync(value: Buffer) { calls.push('decrypt'); await before('decrypt', value); return {result: open(value), shouldReEncrypt: true}; },
  };
  return {native, calls, seal, open, set before(value: BeforeHook) { before = value; }};
}
const codecFor = (fixture: VaultFixture, extra: Record<string, unknown> = {}): Record<string, any> => secret.createDesktopSecretCodec({safeStorage: fixture.native, appId: APP_ID, platform: 'darwin', ...extra});
const imageFor = (fixture: VaultFixture, extra: Record<string, unknown> = {}): Record<string, any> => images.createDesktopImageSecretCodec({safeStorage: fixture.native, appId: APP_ID, platform: 'darwin', ...extra});
function memory(initial: unknown = null): {load(): Promise<Record<string, unknown> | null>; save(value: unknown): Promise<void>; readonly value: Record<string, unknown> | null; readonly saves: number} {
  let stored: Record<string, unknown> | null = structuredClone(initial) as Record<string, unknown> | null; let saves = 0;
  return {async load() { return structuredClone(stored); }, async save(value: unknown) { saves++; stored = structuredClone(value) as Record<string, unknown> | null; },
    get value() { return structuredClone(stored); }, get saves() { return saves; }};
}
function agentPair(engine: unknown, {timeout = 1000, isActive = undefined, delayCancel = false}: {timeout?: number; isActive?: () => boolean; delayCancel?: boolean} = {}) {
  const port = new EventEmitter() as TestPort, messages: Array<Record<string, unknown>> = [], requests: Array<Record<string, unknown>> = [], delayed: Array<Record<string, unknown>> = [];
  const broker = agentBridge.createAgentSettingsBroker({agentSettings: engine, isActive,
    send: (message: Record<string, unknown>) => { messages.push(message); port.emit('message', {data: message}); }});
  port.postMessage = message => {
    requests.push(message as Record<string, unknown>);
    if (delayCancel && (message as {type?: string}).type === 'agent-credential-cancel') delayed.push(message as Record<string, unknown>);
    else broker.handle(message);
  };
  const client = agentBridge.createAgentSettingsClient({port, timeout});
  return {client, broker, requests, messages, delayed, close() { client.close(); broker.close(); }};
}
function imagePair(codec: unknown, {timeout = 1000}: {timeout?: number} = {}) {
  const port = new EventEmitter() as TestPort, messages: Array<Record<string, unknown>> = [];
  const broker = imageBridge.createImageSecretBroker({imageSecretCodec: codec, send: (message: Record<string, unknown>) => { messages.push(message); port.emit('message', {data: message}); }});
  port.postMessage = message => { broker.handle(message); };
  const client = imageBridge.createImageSecretClient({port, timeout});
  return {client, broker, messages, close() { client.close(); broker.close(); }};
}
const update = (revision = 0, storage = 'persistent') => ({expectedRevision: revision, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: {action: 'replace', storage, value: SENTINEL}});
const safeError = (error: unknown): boolean => { assert.ok(!(JSON.stringify(error) + String((error as {message?: unknown})?.message)).includes(SENTINEL)); return true; };

test('audited imports and codec construction make no native calls; Images client completes an async round trip', async t => {
  const f = vault(), codec = imageFor(f);
  assert.deepEqual(f.calls, []);
  assert.ok(![...urls.keys()].some(name => /\/(?:main|backend)\.mjs$/.test(name)));
  assert.ok(urls.has('apps/desktop/src/timeline-delivery-download.ts'));
  assert.ok(!urls.has('packages/contracts/src/timeline-delivery.ts'));
  const pair = imagePair(codec); t.after(() => pair.close());
  const encrypted = await pair.client.encrypt(imagePlaintexts[0]);
  assert.equal(await pair.client.decrypt(encrypted), imagePlaintexts[0]);
  assert.deepEqual(pair.client.storage(), {persistentAvailable: true, sessionScope: 'server', reasonCode: null});
  assert.ok(['status', 'encrypt', 'decrypt'].every(method => f.calls.includes(method)));
});

test('import fixture permits only six reviewed erased modules and refuses runtime Electron or unknown source paths', () => {
  const name = 'apps/desktop/src/timeline-delivery-download.ts';
  const original = readFileSync(new URL(name, root), 'utf8');
  assert.match(original, /import type \{[^}]*\} from 'electron'/);
  const erased = stripTypeScriptTypes(original, {mode: 'strip'});
  assert.doesNotMatch(erased, /from ['"]electron['"]/);
  assert.deepEqual([...erased.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)].map(match => match[2]), ['./app-language-text.ts', 'node:path', '@mioon/contracts/timeline-delivery']);
  assert.equal(overrides.has('electron'), false);
  assert.equal(overrides.has('@mioon/contracts/arbitrary'), false);
  for (const unreviewed of ['apps/desktop/src/main.ts', 'apps/desktop/src/backend.ts', 'packages/contracts/src/timeline-delivery.ts', 'apps/desktop/src/../src/not-approved.ts']) {
    assert.throws(() => moduleUrl(unreviewed), /Unreviewed source:/);
  }
  assert.equal(deliveryParser.calls, 0);
  assert.equal(nativeAudioContracts.calls, 0);
  assert.equal(reviewedTypeScript.size, approved.size);
  for (const name of approved) assert.ok(reviewedTypeScript.has(name), name);
  for (const adapter of reviewedTypeScript) assert.ok(urls.has(adapter));
});

test('Images client directly arms its 2000ms default and times out a silent port', {timeout: 5000}, async t => {
  const port = new EventEmitter() as TestPort, requests: Array<Record<string, unknown>> = [], delays: unknown[] = [];
  port.postMessage = message => { requests.push(message as Record<string, unknown>); };
  const client = imageBridge.createImageSecretClient({port}); t.after(() => client.close());
  const original = globalThis.setTimeout, begun = performance.now();
  let outcome;
  try {
    // Observe the argument synchronously, then restore the real timer before
    // awaiting its actual expiry. No other test runs during this interception.
    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => { delays.push(Number(delay)); return original(callback, Number(delay), ...args); }) as unknown as typeof setTimeout;
    outcome = client.refreshStorage().then(() => 'unexpected-success', (error: unknown) => (error as {code?: string}).code);
  } finally { globalThis.setTimeout = original; }
  assert.deepEqual(delays, [2000]);
  assert.equal(await outcome, 'IMAGE_SECRET_CODEC_TIMEOUT');
  assert.ok(performance.now() - begun >= 1900);
  const request = requests[0];
  assert.ok(requests.some(message => message.type === 'image-secret-codec-cancel' && message.requestId === request.requestId));
  port.emit('message', {data: {type: 'image-secret-codec-response', version: 1, namespace: 'images', requestId: request!.requestId,
    ok: true, data: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}});
  assert.equal(client.storage().persistentAvailable, false);
});

test('Images broker close before its microtask makes zero native calls and sends no reply', async () => {
  const f = vault(), messages: Array<Record<string, unknown>> = [];
  const broker = imageBridge.createImageSecretBroker({imageSecretCodec: imageFor(f), send: (value: unknown) => messages.push(value as Record<string, unknown>)});
  broker.handle({type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId: randomUUID(), operation: 'status'});
  broker.close(); await turn();
  assert.deepEqual(f.calls, []); assert.deepEqual(messages, []);
});

for (const phase of ['status', 'encrypt', 'decrypt']) {
  test('pending async ' + phase + ' permits heartbeat, queued quit and owned supervisor stop budgets', {timeout: 4000}, async t => {
    const f = vault(), gate = deferred(), entered = deferred(), unconfirmed = deferred(), beatsReady = deferred();
    const plaintext = imagePlaintexts[0];
    const ciphertext = f.seal(JSON.stringify({version: 1, appId: APP_ID, plaintext}));
    let nativeFinished = false, entries = 0, beats = 0, beatTarget = Infinity;
    let quitEntered = false, quitFinished = false, cleanup = false, kills = 0, settled = false;
    const forcedChildren: unknown[] = [];
    let probe: ReturnType<typeof setInterval>; let quit: Promise<unknown>;
    f.before = async (method, value) => {
      const matches = method === phase && (phase === 'status' ||
        (phase === 'encrypt' ? asString(value).startsWith('{') : asBuffer(value).equals(ciphertext)));
      if (!matches) return;
      if (phase === 'encrypt') assert.deepEqual(JSON.parse(asString(value)), {version: 1, appId: APP_ID, plaintext});
      entries++; entered.resolve();
      await gate.promise; nativeFinished = true;
    };
    const port = new EventEmitter() as TestPort, child = new EventEmitter() as TestChild, requests: Array<Record<string, unknown>> = [], replies: Array<Record<string, unknown>> = [];
    child.postMessage = (message: Record<string, unknown>) => {
      if (message.type === 'start') queueMicrotask(() => child.emit('message', {type: 'ready', url: 'http://127.0.0.1:43191/'}));
      if (message.type === 'image-secret-codec-response') { replies.push(message); port.emit('message', {data: message}); }
      // Deliberately never acknowledge stop or synthesize exit from a signal.
    };
    child.kill = () => { kills++; };
    const supervisor = new BackendSupervisor({fork: () => child, modulePath: 'synthetic-never-executed', environment: {},
      imageSecretCodec: imageFor(f), stopTimeout: 20, terminateTimeout: 20, exitTimeout: 20,
      forceKill: (owned: unknown) => { forcedChildren.push(owned); }});
    port.postMessage = message => { requests.push(message as Record<string, unknown>); child.emit('message', message); };
    const client = imageBridge.createImageSecretClient({port});
    t.after(async () => {
      clearInterval(probe); client.close(); gate.resolve();
      if (supervisor.child === child) child.emit('exit', 0);
      await supervisor.stop(); await quit;
    });
    await supervisor.start({});
    // This is a JS timer probe, not the production 10-second heartbeat or a
    // renderer/native measurement. It stays armed while the native gate waits.
    probe = setInterval(() => { beats++; if (beats >= beatTarget) beatsReady.resolve(); }, 5);
    const operation = phase === 'status' ? client.refreshStorage() : phase === 'encrypt'
      ? client.encrypt(plaintext) : client.decrypt(ciphertext.toString('base64'));
    const outcome = operation.then((value: unknown) => ({value}), (error: unknown) => ({code: (error as {code?: string}).code})).finally(() => { settled = true; });
    await entered.promise;
    assert.equal(entries, 1); assert.equal(nativeFinished, false); assert.equal(settled, false);
    const target = requests.findLast((message: Record<string, unknown>) => message.type === 'image-secret-codec-request' && message.operation === phase);
    assert.ok(target);
    const beatsAtEntry = beats; beatTarget = beatsAtEntry + 3;
    await beatsReady.promise;
    assert.ok(beats >= beatsAtEntry + 3); assert.equal(nativeFinished, false); assert.equal(settled, false);
    queueMicrotask(() => {
      quitEntered = true;
      quit = stopBackendForQuit({backend: supervisor, onUnconfirmed: () => unconfirmed.resolve(), cleanup: () => {
        cleanup = true; clearInterval(probe);
      }}).then(() => { quitFinished = true; return {ok: true}; }, (error: unknown) => ({code: (error as {code?: string}).code || 'QUIT_FAILED'}));
    });
    await unconfirmed.promise;
    assert.equal(quitEntered, true); assert.equal(quitFinished, false); assert.equal(cleanup, false);
    assert.equal(supervisor.stopFailure.code, 'BACKEND_STOP_UNCONFIRMED');
    assert.equal(supervisor.state, 'stop-unconfirmed'); assert.equal(supervisor.stopping, null);
    assert.equal(supervisor.child, child); assert.equal(kills, 1);
    // An overdue absolute confirmation may precede the nested force timer.
    assert.ok(forcedChildren.length <= 1); assert.ok(forcedChildren.every(owned => owned === child));
    assert.equal(nativeFinished, false); assert.equal(settled, false);
    assert.ok(!replies.some((message: Record<string, unknown>) => message.requestId === target.requestId));
    child.emit('exit', 0); assert.deepEqual(await quit!, {ok: true});
    assert.equal(quitFinished, true); assert.equal(cleanup, true); assert.equal(supervisor.child, null);
    assert.equal(nativeFinished, false, 'Quit cleanup and stop budgets progressed before native settlement');
    client.close();
    assert.deepEqual(await outcome, {code: 'IMAGE_SECRET_CODEC_UNAVAILABLE'});
    gate.resolve(); await turn();
    assert.equal(nativeFinished, true); assert.equal(entries, 1);
    assert.ok(!replies.some((message: Record<string, unknown>) => message.requestId === target.requestId && message.ok));
    assert.equal(client.storage().persistentAvailable, false);
  });
}

test('real codec uses only async APIs, preserves old wrapper and never reencrypts on read', async () => {
  const f = vault(), codec = codecFor(f);
  assert.equal(codec.storage().persistentAvailable, false);
  assert.equal((await codec.refreshStorage()).persistentAvailable, true);
  const old = f.seal(JSON.stringify({version: 1, appId: APP_ID, plaintext: SENTINEL})).toString('base64');
  const before = f.calls.length;
  assert.equal(await codec.decrypt(old), SENTINEL);
  assert.deepEqual(f.calls.slice(before), ['status', 'encrypt', 'decrypt', 'decrypt']);
  const encrypted = await codec.encrypt(SENTINEL);
  assert.deepEqual(JSON.parse(f.open(Buffer.from(encrypted, 'base64'))), {version: 1, appId: APP_ID, plaintext: SENTINEL});
  assert.equal(await codec.decrypt(encrypted), SENTINEL);
  codec.close();
});

test('true status without working crypto latches unavailable across replacement codecs', async () => {
  const f = vault(); f.before = async method => { if (method === 'encrypt') throw Error(SENTINEL); };
  assert.equal((await codecFor(f).refreshStorage()).persistentAvailable, false);
  const count = f.calls.length;
  f.before = async () => {};
  assert.equal((await codecFor(f).refreshStorage()).persistentAvailable, false);
  await assert.rejects(codecFor(f).encrypt(SENTINEL), safeError);
  assert.equal(f.calls.length, count);
});

test('missing async methods, false status and unsupported or weak platforms fail closed', async () => {
  for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    const f = vault(); delete (f.native as unknown as Record<string, unknown>)[name];
    assert.equal((await codecFor(f).refreshStorage()).persistentAvailable, false);
    assert.equal(f.calls.length, 0);
  }
  const missingKey = vault(); missingKey.native.isAsyncEncryptionAvailable = async () => false;
  assert.equal((await codecFor(missingKey).refreshStorage()).persistentAvailable, false);
  for (const platform of ['win32', 'unknown']) for (const backend of ['basic_text', 'unknown', 'gnome_libsecret']) {
    const f = vault(); f.native.getSelectedStorageBackend = () => backend;
    const result = await codecFor(f, {platform}).refreshStorage();
    assert.equal(result.persistentAvailable, false); assert.equal(f.calls.length, 0);
    assert.equal(result.reasonCode, 'OS_SECRET_STORE_UNAVAILABLE');
  }
});

test('bounds, canonical base64, appId and wrapper shape remain enforced', async () => {
  const f = vault(), codec = codecFor(f);
  for (const value of ['', '!', 'Zh==', 'AAAA=', null, 3, 'YWFh'.repeat(22000)]) await assert.rejects(codec.decrypt(value), safeError);
  await assert.rejects(codec.encrypt('x'.repeat(32769)), safeError);
  assert.equal(f.calls.length, 0);
  for (const wrapper of [{version: 1, appId: 'app.starroy.mioon', plaintext: SENTINEL},
    {version: 1, appId: APP_ID, plaintext: SENTINEL, extra: true}, {version: 2, appId: APP_ID, plaintext: SENTINEL}]) {
    await assert.rejects(codec.decrypt(f.seal(JSON.stringify(wrapper)).toString('base64')), {code: 'AGENT_SETTINGS_CORRUPT'});
  }
});

for (const method of ['encrypt', 'decrypt']) {
  test('actual credential ' + method + ' failure is sanitized after a successful probe and preserves committed settings', async t => {
    const f = vault(), codec = codecFor(f), persistence = memory();
    const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
    t.after(() => engine.close());
    const saved = await engine.put(update()), original = persistence.value;
    let failures = 0;
    f.before = async (name, value) => {
      if (name === method && String(method === 'encrypt' ? value : f.open(asBuffer(value))).startsWith('{')) {
        failures++; throw Error(SENTINEL);
      }
    };
    const pending = method === 'encrypt' ? engine.put(update(saved.revision))
      : engine[agent.AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: saved.revision, configuration: saved.configuration});
    await assert.rejects(pending, (error: unknown) => { assert.equal((error as {code?: string}).code, 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'); return safeError(error); });
    assert.equal(failures, 1); assert.deepEqual(persistence.value, original); assert.equal(persistence.saves, 1);
    const after = await engine.get();
    assert.equal(after.revision, saved.revision); assert.deepEqual(after.configuration, saved.configuration); assert.deepEqual(after.secret, saved.secret);
  });
}

test('async native wait leaves the JS loop responsive; timeout and late status never restore availability', async t => {
  const f = vault(), gate = deferred(), entered = deferred();
  f.before = async method => { if (method === 'status') { entered.resolve(); await gate.promise; } };
  const codec = codecFor(f, {timeout: 30});
  t.after(() => { gate.resolve(); codec.close(); });
  const pending = codec.refreshStorage(); await entered.promise;
  let pulse = false; await new Promise<void>(resolve => { setImmediate(() => { pulse = true; resolve(); }); });
  assert.equal(pulse, true); assert.deepEqual(f.calls, ['status']);
  assert.equal((await pending).persistentAvailable, false);
  gate.resolve(); await turn();
  assert.equal(codec.storage().persistentAvailable, false);
  assert.equal((await codecFor(f).refreshStorage()).persistentAvailable, false);
  assert.deepEqual(f.calls, ['status']);
});

test('native capacity survives repeated broker/codec replacement and releases only on real settlement', async t => {
  const f = vault(), gates: Array<Pending<unknown>> = [], pairs: Array<ReturnType<typeof imagePair>> = [];
  f.before = async method => { if (method === 'status') { const gate = deferred(); gates.push(gate); await gate.promise; } };
  t.after(() => { for (const pair of pairs) pair.close(); for (const gate of gates) gate.resolve(); });
  for (let i = 0; i < 16; i++) {
    const pair = imagePair(imageFor(f)); pairs.push(pair);
    const pending = pair.client.refreshStorage().catch((error: unknown) => (error as {code?: string}).code);
    await turn(); pair.close(); await pending; await turn();
  }
  assert.equal(gates.length, 16);
  const overflow = imagePair(imageFor(f)); pairs.push(overflow);
  assert.equal((await overflow.client.refreshStorage()).persistentAvailable, false);
  assert.equal(gates.length, 16);
  gates[0].resolve(); await turn();
  const replacement = imagePair(imageFor(f)); pairs.push(replacement);
  const pending = replacement.client.refreshStorage(); await turn();
  assert.equal(gates.length, 17);
  gates[16].resolve(); assert.equal((await pending).persistentAvailable, true);
});

test('canceling Images status does not invalidate concurrent Agent encryption on the shared vault', async t => {
  const f = vault(), codec = codecFor(f), encryptGate = deferred(), entered = deferred(), statusGate = deferred();
  let holdStatus = false;
  f.before = async (method, value) => {
    if (method === 'status' && holdStatus) await statusGate.promise;
    if (method === 'encrypt' && asString(value).startsWith('{')) { entered.resolve(); await encryptGate.promise; }
  };
  const pending = codec.encrypt(SENTINEL);
  await entered.promise; holdStatus = true;
  const pair = imagePair(imageFor(f));
  t.after(() => { statusGate.resolve(); encryptGate.resolve(); pair.close(); codec.close(); });
  const status = pair.client.refreshStorage().catch((error: unknown) => (error as {code?: string}).code);
  await turn(); pair.close(); await status;
  holdStatus = false; encryptGate.resolve();
  const encrypted = await pending;
  assert.equal(codec.storage().persistentAvailable, true);
  assert.equal(await codec.decrypt(encrypted), SENTINEL);
  statusGate.resolve(); await turn();
  assert.equal((await codecFor(f).refreshStorage()).persistentAvailable, true);
});

for (const phase of ['status', 'probe-encrypt', 'credential-encrypt']) {
  test('stale ' + phase + ' rejection cannot poison a successfully refreshed replacement codec', async t => {
    const f = vault(), codec = codecFor(f), gate = deferred(), entered = deferred();
    let active = true, held = false;
    f.before = async (method, value) => {
      const match = phase === 'status' ? method === 'status' : method === 'encrypt' &&
        (phase === 'probe-encrypt' ? asString(value).startsWith('mioon-vault-probe:') : asString(value).startsWith('{'));
      if (match && !held) { held = true; entered.resolve(); await gate.promise; }
    };
    const pending = codec.encrypt(SENTINEL, {isActive: () => active}).then(() => 'unexpected-success', (error: unknown) => (error as {code?: string}).code);
    t.after(() => { gate.resolve(); codec.close(); });
    await entered.promise; active = false;
    const replacement = codecFor(f); t.after(() => replacement.close());
    assert.equal((await replacement.refreshStorage()).persistentAvailable, true);
    gate.reject(Error(SENTINEL));
    assert.equal(await pending, 'AGENT_SETTINGS_STORAGE_UNAVAILABLE');
    assert.equal(replacement.storage().persistentAvailable, true);
    const encrypted = await replacement.encrypt(SENTINEL);
    assert.equal(await replacement.decrypt(encrypted), SENTINEL);
  });
}

test('broker releases canceled logical requests when a codec ignores options and returns late', async () => {
  const gates: Array<Pending<unknown>> = [], messages: Array<Record<string, unknown>> = [], unavailable = {persistentAvailable: false, sessionScope: 'server', reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'};
  const broker = imageBridge.createImageSecretBroker({imageSecretCodec: {
    storage() { const gate = deferred(); gates.push(gate); return gate.promise; }, encrypt() {}, decrypt() {},
  }, send: (value: Record<string, unknown>) => messages.push(value)});
  for (let i = 0; i < 20; i++) {
    const requestId = randomUUID();
    broker.handle({type: 'image-secret-codec-request', version: 1, namespace: 'images', requestId, operation: 'status'});
    await turn();
    broker.handle({type: 'image-secret-codec-cancel', version: 1, namespace: 'images', requestId});
    gates.at(-1)!.resolve(unavailable); await turn();
  }
  assert.equal(gates.length, 20); assert.equal(messages.length, 0);
  broker.close();
});

test('Images keeps both validator gates and refuses copied non-Images plaintext', async () => {
  const f = vault(), codec = imageFor(f);
  for (const plaintext of imagePlaintexts) assert.equal(await codec.decrypt(await codec.encrypt(plaintext)), plaintext);
  await assert.rejects(codec.encrypt(SENTINEL), {code: 'IMAGE_SETTINGS_VALIDATION'});
  const copied = await codecFor(f).encrypt(SENTINEL);
  await assert.rejects(codec.decrypt(copied), {code: 'IMAGE_SETTINGS_CORRUPT'});
});

for (const boundary of ['timeout', 'client-close', 'broker-close', 'ownership', 'engine-close']) {
  test('Agent late encryption cannot save after ' + boundary, async t => {
    const f = vault(), codec = codecFor(f), persistence = memory();
    const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
    const gate = deferred(), entered = deferred();
    f.before = async (method, value) => { if (method === 'encrypt' && asString(value).startsWith('{')) { entered.resolve(); await gate.promise; } };
    let active = true;
    const pair = agentPair(engine, {timeout: boundary === 'timeout' ? 50 : 1000, isActive: () => active, delayCancel: boundary === 'timeout'});
    t.after(async () => { gate.resolve(); pair.close(); await engine.close(); });
    let clientSettled = false;
    const pending = pair.client.put(update()).then(() => 'unexpected-success', (error: unknown) => (error as {code?: string}).code).finally(() => { clientSettled = true; });
    await entered.promise;
    if (boundary === 'client-close') pair.client.close();
    if (boundary === 'broker-close') pair.broker.close();
    if (boundary === 'ownership') active = false;
    if (boundary === 'engine-close') await engine.close();
    if (boundary === 'broker-close' || boundary === 'ownership') {
      assert.ok(Date.now() < Number(pair.requests[0]!.deadline));
      gate.resolve(); await turn();
      assert.ok(Date.now() < Number(pair.requests[0]!.deadline), 'The late native result arrived before the client deadline');
      assert.equal(clientSettled, false, 'The client timeout has not provided the fence');
      assert.equal(persistence.saves, 0); assert.equal(pair.messages.length, 0);
      pair.client.close();
    }
    const error = await pending;
    assert.notEqual(error, 'unexpected-success');
    if (boundary === 'timeout') assert.ok(pair.delayed.length, 'Cancellation IPC was deliberately withheld');
    gate.resolve(); await turn();
    assert.equal(persistence.saves, 0); assert.equal(persistence.value, null);
    assert.ok(!pair.messages.some(message => message.ok));
    if (boundary !== 'engine-close') assert.equal((await engine.get()).revision, 0);
  });
}

test('Agent checks original client deadline before save even before main cancel/timer dispatch', async t => {
  const f = vault(), codec = codecFor(f), persistence = memory();
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  const gate = deferred(), entered = deferred();
  f.before = async (method, value) => { if (method === 'encrypt' && asString(value).startsWith('{')) { entered.resolve(); await gate.promise; } };
  const pair = agentPair(engine, {timeout: 1000, delayCancel: true});
  t.after(async () => { gate.resolve(); pair.close(); await engine.close(); });
  const pending = pair.client.put(update()).then(() => 'unexpected-success', (error: unknown) => (error as {code?: string}).code);
  await entered.promise;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2000;
    gate.resolve(); await turn();
    assert.equal(persistence.saves, 0);
  } finally { Date.now = realNow; }
  pair.client.close(); await pending;
  assert.equal(persistence.saves, 0);
});

test('Agent queued puts cancel before execution, while an already-started save retains commit consistency', async t => {
  const f = vault(), codec = codecFor(f), persistence = memory(), started = deferred(), finish = deferred();
  const save = persistence.save;
  persistence.save = async value => { started.resolve(); await finish.promise; await save(value); };
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  const pair = agentPair(engine);
  t.after(async () => { finish.resolve(); pair.close(); await engine.close(); });
  const first = pair.client.put(update(0, 'session')).catch((error: unknown) => (error as {code?: string}).code);
  await started.promise;
  const calls = f.calls.length;
  const second = pair.client.put(update(1)).catch((error: unknown) => (error as {code?: string}).code);
  pair.client.close(); await Promise.all([first, second]); finish.resolve(); await turn();
  assert.equal(persistence.saves, 1);
  assert.equal(persistence.value!.revision, 1);
  assert.equal(f.calls.length, calls, 'Canceled queued put never enters the native codec');
  assert.equal((await engine.get()).revision, 1, 'RAM follows the save that already started');
});

test('Agent save completed past the deadline commits consistently without caching or sending late success', async t => {
  const f = vault(), codec = codecFor(f), persistence = memory(), started = deferred(), finish = deferred();
  const save = persistence.save;
  persistence.save = async value => { started.resolve(); await finish.promise; await save(value); };
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  const pair = agentPair(engine);
  t.after(async () => { finish.resolve(); pair.close(); await engine.close(); });
  const pending = pair.client.put(update()).then(() => 'unexpected-success', (error: unknown) => (error as {code?: string}).code);
  await started.promise;
  const original = pair.requests[0], realNow = Date.now;
  try {
    Date.now = () => realNow() + 2000;
    finish.resolve(); await turn();
    assert.equal(persistence.saves, 1); assert.equal(persistence.value!.revision, 1);
    assert.equal(pair.messages.length, 0);
  } finally { Date.now = realNow; }
  assert.equal((await engine.get()).revision, 1);
  pair.broker.handle({...original, deadline: Date.now() + 1000}); await turn();
  assert.equal(pair.messages.at(-1)?.ok, false, 'Expired completion was not cached as successful');
  assert.equal(persistence.saves, 1);
  assert.notEqual(await pending, 'unexpected-success');
});

test('Agent engine close waits for an atomic save that already started', async t => {
  const f = vault(), codec = codecFor(f), persistence = memory(), started = deferred(), finish = deferred();
  const save = persistence.save;
  persistence.save = async value => { started.resolve(); await finish.promise; await save(value); };
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  t.after(async () => { finish.resolve(); await engine.close(); });
  const pending = engine.put(update()); await started.promise;
  let closed = false;
  const closing = engine.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false); assert.equal(persistence.saves, 0);
  finish.resolve(); const saved = await pending; await closing;
  assert.equal(closed, true); assert.equal(persistence.saves, 1);
  assert.equal(persistence.value!.revision, saved.revision); assert.equal(saved.revision, 1);
  await assert.rejects(engine.get(), {code: 'AGENT_SETTINGS_CLOSED'});
});

test('Agent client rejects a response past its deadline before the timeout callback runs', async () => {
  const port = new EventEmitter() as TestPort;
  let request: {deadline: number; requestId: string} | undefined;
  port.postMessage = (value: {type?: string; deadline?: number; requestId?: string}) => { if (value.type === 'agent-settings-request') request = value as {deadline: number; requestId: string}; };
  const client = agentBridge.createAgentSettingsClient({port, timeout: 1000});
  const pending = client.get().catch((error: unknown) => (error as {code?: string}).code), realNow = Date.now;
  try {
    Date.now = () => request!.deadline;
    port.emit('message', {data: {type: 'agent-settings-response', version: 1, requestId: request!.requestId,
      ok: true, data: {revision: 0, configuration: {...DEFAULT_AGENT_CONFIGURATION}, secret: {configured: false, storage: 'none'},
        storage: {persistentAvailable: true, sessionScope: 'app', reasonCode: null}}}});
    assert.equal(await pending, 'AGENT_SETTINGS_TIMEOUT');
  } finally { Date.now = realNow; client.close(); }
});

test('Images client rejects a delayed status response before the timeout callback runs', async () => {
  const port = new EventEmitter() as TestPort;
  let request: {deadline: number; requestId: string} | undefined;
  port.postMessage = (value: {type?: string; deadline?: number; requestId?: string}) => { if (value.type === 'image-secret-codec-request') request = value as {deadline: number; requestId: string}; };
  const client = imageBridge.createImageSecretClient({port, timeout: 1000});
  const pending = client.refreshStorage().catch((error: unknown) => (error as {code?: string}).code), realNow = Date.now;
  try {
    Date.now = () => request!.deadline;
    port.emit('message', {data: {type: 'image-secret-codec-response', version: 1, namespace: 'images', requestId: request!.requestId,
      ok: true, data: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}});
    assert.equal(await pending, 'IMAGE_SECRET_CODEC_TIMEOUT');
    assert.equal(client.storage().persistentAvailable, false);
  } finally { Date.now = realNow; client.close(); }
});

test('initial async status and old-secret decrypt are bounded, preserving old bytes and session-only choice', async t => {
  for (const operation of ['status', 'decrypt']) {
    const f = vault(), codec = codecFor(f, {timeout: 25}), gate = deferred();
    const configuration = {...DEFAULT_AGENT_CONFIGURATION}, binding = agentConfig.agentCredentialBinding(configuration);
    const encrypted = f.seal(JSON.stringify({version: 1, appId: APP_ID, plaintext: JSON.stringify({version: 1, binding, value: SENTINEL})})).toString('base64');
    const original = {version: 2, revision: 4, configuration, secret: {binding, encrypted}}, persistence = memory(original);
    f.before = async (method, value) => {
      if (method === operation && (operation === 'status' || f.open(asBuffer(value)).startsWith('{'))) await gate.promise;
    };
    const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
    t.after(async () => { gate.resolve(); await engine.close(); });
    assert.deepEqual(persistence.value, original); assert.equal(persistence.saves, 0);
    const snapshot = await engine.get();
    assert.equal(snapshot.storage.persistentAvailable, false); assert.equal(snapshot.secret.configured, true);
    gate.resolve(); await turn();
    assert.equal((await engine.get()).storage.persistentAvailable, false);
    const session = await engine.put({expectedRevision: 4, configuration, secret: {action: 'replace', storage: 'session', value: SENTINEL}});
    assert.equal(session.secret.storage, 'session');
  }
});

test('startup abort returns without waiting for the native Promise and never enables a late vault', async t => {
  const f = vault(), codec = codecFor(f), gate = deferred(), entered = deferred(), controller = new AbortController();
  f.before = async method => { if (method === 'status') { entered.resolve(); await gate.promise; } };
  let initialized = false;
  const pending = agent.createAgentSettings({persistence: memory(), secretCodec: codec, storage: codec.storage, signal: controller.signal})
    .then((engine: {close(): Promise<void>}) => { initialized = true; return engine; });
  t.after(async () => { gate.resolve(); await (await pending).close(); });
  await entered.promise; controller.abort(); await turn();
  assert.equal(initialized, true, 'Startup settled in the abort turn, without waiting for the 1500ms native timeout');
  assert.deepEqual(f.calls, ['status']);
  await pending;
  gate.resolve(); await turn();
  assert.equal(codec.storage().persistentAvailable, false);
  assert.match(readFileSync(new URL('apps/desktop/src/main.ts', root), 'utf8'), /appId: identity\.appId, signal: startup\.signal/);
});

test('Agent binding validation rejects copied channel-valid plaintext without changing its stored envelope', async t => {
  const f = vault(), codec = codecFor(f), configuration = {...DEFAULT_AGENT_CONFIGURATION};
  const binding = agentConfig.agentCredentialBinding(configuration);
  const encrypted = f.seal(JSON.stringify({version: 1, appId: APP_ID, plaintext: JSON.stringify({version: 1, binding: 'wrong', value: SENTINEL})})).toString('base64');
  const original = {version: 2, revision: 3, configuration, secret: {binding, encrypted}}, persistence = memory(original);
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  t.after(() => engine.close());
  await assert.rejects(engine[agent.AGENT_CREDENTIAL_ACQUIRE]({expectedRevision: 3, configuration}), {code: 'AGENT_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.deepEqual(persistence.value, original); assert.equal(persistence.saves, 0);
});

test('owned utility replacement cannot save or receive an old Agent encryption result', async t => {
  const f = vault(), codec = codecFor(f), persistence = memory(), gate = deferred(), entered = deferred();
  const engine = await agent.createAgentSettings({persistence, secretCodec: codec, storage: codec.storage});
  f.before = async (method, value) => { if (method === 'encrypt' && asString(value).startsWith('{')) { entered.resolve(); await gate.promise; } };
  function child(): TestChild {
    const value = new EventEmitter() as TestChild; value.messages = [];
    value.postMessage = (message: Record<string, unknown>) => { value.messages.push(message); if (message.type === 'start') queueMicrotask(() => value.emit('message', {type: 'ready', url: 'http://127.0.0.1:43191/'})); if (message.type === 'stop') queueMicrotask(() => value.emit('exit', 0)); };
    value.kill = () => { value.emit('exit', 0); }; return value;
  }
  const first = child(), second = child(); let next = first;
  const supervisor = new BackendSupervisor({fork: () => next, modulePath: 'synthetic-never-executed', environment: {}, agentSettings: engine,
    forceKill() { throw Error('Real process signaling is forbidden'); }});
  t.after(async () => { gate.resolve(); await supervisor.stop(); await engine.close(); });
  await supervisor.start({});
  first.emit('message', {type: 'agent-settings-request', version: 1, requestId: randomUUID(), operation: 'put', input: update(), selfPort: 43191, deadline: Date.now() + 1000});
  await entered.promise; first.emit('exit', 1); next = second; await supervisor.start({});
  gate.resolve(); await turn();
  assert.equal(persistence.saves, 0);
  for (const child of [first, second]) assert.ok(!child.messages.some(message => message.type === 'agent-settings-response' && message.ok));
});
