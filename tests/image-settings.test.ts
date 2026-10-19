import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {DEFAULT_IMAGE_CONFIGURATION, IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_BASE_URL, IMAGE_SETTINGS_LIMITS,
  imageSettingsUpdateSchema, imageSettingsResultSchema, isImageSettingsResult} from '../packages/contracts/src/image-settings.ts';
import {createImageSettings, parseImageConfiguration, parseImageSettingsUpdate, imageSettingsError, sanitizeImageSettingsError,
  sanitizeImageSettingsResult, parseImageCredentialRequest, sanitizeImageCredentialResult, validateImageSettingsEnvelope,
  validateImageSecretPlaintext, IMAGE_CREDENTIAL_ACQUIRE, IMAGE_SETTINGS_ASSERT_CURRENT, IMAGE_SETTINGS_READ_CURRENT} from '../packages/business/src/images/settings.ts';
import {AGENT_CREDENTIAL_ACQUIRE} from '../packages/business/src/agent/settings.ts';
import {errorView} from './helpers/test-error.ts';

type SecretUpdate = {action: 'keep'} | {action: 'remove'} | {action: 'replace'; storage: 'session' | 'persistent'; value: string};
type ConfigurationView = ReturnType<typeof configuration> & {options: Record<string, unknown> & {n?: number}};
type SettingsEnvelope = Record<string, unknown> & {revision: number; configuration: ConfigurationView; secret: null | {configured?: boolean; storage?: string; encrypted?: string}};
type Deferred = {promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (error?: unknown) => void};

const configuration = (enabled = true) => ({...structuredClone(DEFAULT_IMAGE_CONFIGURATION), enabled});
const input = (expectedRevision = 0, secret: SecretUpdate = {action: 'keep'}, config: Record<string, unknown> = configuration()) => ({expectedRevision, configuration: config, secret});
const expected = (snapshot: {revision: number; configuration: unknown}) => ({expectedRevision: snapshot.revision, configuration: snapshot.configuration});
const replace = (value = 'synthetic-image-key-only', storage: 'session' | 'persistent' = 'session'): SecretUpdate => ({action: 'replace', storage, value});
const persistent = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};
function memoryPersistence(initial: SettingsEnvelope | null = null) {
  let value = structuredClone(initial);
  return {load: async () => structuredClone(value), save: async (candidate: SettingsEnvelope | null) => { value = structuredClone(candidate); }, get value() { return structuredClone(value); }};
}
function deferred(): Deferred { let resolve: Deferred['resolve'] = () => {}, reject: Deferred['reject'] = () => {}; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
// Synthetic local cipher only. No real credential, network or OS keychain.
function syntheticCodec() {
  const key = randomBytes(32);
  return {
    encrypt(value: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(value: string) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); },
  };
}

test('image settings are fixed, initially disabled and network-free with a separate trusted namespace', async t => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Settings must not perform a network request');
  t.after(() => { globalThis.fetch = previousFetch; });
  const settings = await createImageSettings({persistence: memoryPersistence()});
  const initial = await settings.get();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.configuration, DEFAULT_IMAGE_CONFIGURATION);
  assert.equal(initial.configuration.enabled, false);
  assert.equal(initial.configuration.baseUrl, IMAGE_SETTINGS_BASE_URL);
  assert.deepEqual(initial.secret, {configured: false, storage: 'none'});
  assert.equal(initial.storage.reasonCode, 'WEB_SESSION_ONLY');
  assert.ok(isImageSettingsResult(initial));
  assert.notEqual(IMAGE_CREDENTIAL_ACQUIRE, AGENT_CREDENTIAL_ACQUIRE);
  assert.equal((settings as unknown as Record<PropertyKey, unknown>)[AGENT_CREDENTIAL_ACQUIRE], undefined);
  assert.deepEqual(Object.keys(settings).sort(), ['close', 'get', 'put']);
  await settings.put(input(0, replace()));
  await settings.close();
});

test('fixed contract rejects custom origin, redirects, other profile/model/options and secret smuggling', () => {
  const valid = input(0, replace());
  assert.ok(imageSettingsUpdateSchema.safeParse(valid).success);
  const invalid = [null, [], {}, {...valid, expectedRevision: -1}, {...valid, expectedRevision: 0.5}, {...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1},
    {...valid, apiKey: 'synthetic-smuggle'}, {...valid, configuration: {...configuration(), value: 'synthetic-smuggle'}},
    {...valid, secret: {action: 'keep', value: 'synthetic-smuggle'}}, {...valid, secret: {action: 'remove', storage: 'session'}},
    {...valid, secret: {...replace(), storage: 'plaintext'}}];
  for (const baseUrl of ['https://api.openai.com/v1/', 'https://API.OPENAI.COM/v1', 'https://api.openai.com:443/v1', 'http://api.openai.com/v1',
    'https://api.openai.com/v1?key=synthetic-smuggle', 'https://api.openai.com/v1#secret', 'https://synthetic:secret@api.openai.com/v1',
    'https://api.openai.com.evil.example/v1', 'https://api.openai.com/v1/../v1', 'http://localhost:4318/v1']) invalid.push({...valid, configuration: {...configuration(), baseUrl}});
  for (const change of [{providerId: 'mock'}, {profileId: 'agent'}, {model: 'gpt-image-1'}, {enabled: 'true'},
    {options: {...configuration().options, quality: 'high'}}, {options: {...configuration().options, n: 2}}, {options: {...configuration().options, seed: 1}}]) invalid.push({...valid, configuration: {...configuration(), ...change}});
  for (const value of ['', ' ', ' leading', 'trailing ', 'contains space', 'a\nb', 'a\0b', 'x\u0085key', '中文', 'x'.repeat(4097)]) invalid.push({...valid, secret: replace(value)});
  for (const value of invalid) assert.throws(() => parseImageSettingsUpdate(value), (error: unknown) => {const failure = errorView(error); return failure.code === 'IMAGE_SETTINGS_VALIDATION' && !failure.message!.includes('synthetic');});
  assert.equal((parseImageSettingsUpdate(input(0, replace('x'.repeat(4096)))).secret as {value: string}).value.length, IMAGE_SETTINGS_LIMITS.secretBytes);
  assert.throws(() => parseImageConfiguration(Object.assign(Object.create({inherited: true}), configuration())), {code: 'IMAGE_SETTINGS_VALIDATION'});
});

test('public allowlist never emits plaintext, ciphertext, fingerprints, hashes or hidden capabilities', async () => {
  const settings = await createImageSettings({persistence: memoryPersistence()});
  const saved = await settings.put(input(0, replace('synthetic-private-sentinel')));
  const clean = sanitizeImageSettingsResult({...saved, apiKey: 'synthetic-private-sentinel', fingerprint: 'secret-derived-hash', encrypted: 'synthetic-cipher',
    secret: {...saved.secret, value: 'synthetic-private-sentinel', hash: 'secret-derived-hash'}, storage: {...saved.storage, key: 'synthetic-private-sentinel'}});
  assert.deepEqual(clean, saved);
  assert.equal(JSON.stringify(clean).includes('synthetic'), false);
  assert.equal(JSON.stringify(clean).includes('hash'), false);
  assert.equal(imageSettingsResultSchema.safeParse({...saved, fingerprint: 'secret-derived-hash'}).success, false);
  for (const code of [undefined, 'toString', '__proto__', 'constructor', 'unknown']) {
    const safe = sanitizeImageSettingsError({code, message: 'synthetic-private-sentinel', stack: 'synthetic-private-sentinel'});
    assert.equal(safe.code, 'IMAGE_SETTINGS_SAVE_FAILED');
    assert.equal(JSON.stringify(safe).includes('synthetic'), false);
  }
  assert.equal(imageSettingsError().code, 'IMAGE_SETTINGS_VALIDATION');
  await settings.close();
});

test('session keys never persist and vanish on backend restart; enable toggle keeps key while revising authorization', async () => {
  const persistence = memoryPersistence(), settings = await createImageSettings({persistence});
  const saved = await settings.put(input(0, replace('synthetic-session-sentinel')));
  assert.deepEqual(saved.secret, {configured: true, storage: 'session'});
  assert.equal(persistence.value!.secret, null);
  assert.equal(JSON.stringify(persistence.value!).includes('synthetic-session-sentinel'), false);
  const acquired = await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved));
  assert.equal(acquired.namespace, IMAGE_SETTINGS_NAMESPACE);
  assert.equal(acquired.apiKey, 'synthetic-session-sentinel');
  assert.equal(settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), true);
  const disabled = await settings.put(input(1, {action: 'keep'}, configuration(false)));
  assert.equal(disabled.secret.configured, true);
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(disabled)), {code: 'IMAGE_SETTINGS_DISABLED'});
  const enabled = await settings.put(input(2));
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(enabled))).apiKey, acquired.apiKey);
  assert.equal(enabled.revision, 3);
  await settings.close();
  await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_CLOSED'});
  assert.throws(() => settings[IMAGE_SETTINGS_READ_CURRENT](), {code: 'IMAGE_SETTINGS_CLOSED'});
  const restarted = await createImageSettings({persistence});
  const current = await restarted.get();
  assert.equal(current.revision, 3);
  assert.equal(current.configuration.enabled, true);
  assert.deepEqual(current.secret, {configured: false, storage: 'none'});
  assert.equal((await restarted[IMAGE_CREDENTIAL_ACQUIRE](expected(current))).apiKey, null);
  assert.throws(() => restarted[IMAGE_SETTINGS_ASSERT_CURRENT](expected(current)), {code: 'IMAGE_SETTINGS_NOT_CONFIGURED'});
  await restarted.close();
});

test('strict CAS serializes concurrent writes and caller mutation cannot alter an admitted update', async () => {
  const settings = await createImageSettings({persistence: memoryPersistence()});
  const update = input(0, replace('synthetic-original'));
  const first = settings.put(update);
  update.configuration.enabled = false; (update.configuration.options as {n?: number}).n = 2; (update.secret as {value?: string}).value = 'synthetic-mutated';
  const results = await Promise.allSettled([first, ...Array.from({length: 11}, (_, i) => settings.put(input(0, replace(`synthetic-racer-${i}`))))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  for (const value of results.filter(value => value.status === 'rejected')) assert.equal(value.reason.code, 'IMAGE_SETTINGS_CONFLICT');
  const current = await settings.get();
  assert.equal(current.revision, 1); assert.equal(current.configuration.enabled, true); assert.equal(current.configuration.options.n, 1);
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(current))).apiKey, 'synthetic-original');
  assert.equal((await settings.put(input(1))).revision, 2);
  await settings.close();
});

test('pending put invalidates sync read and final fence immediately, including failed writes', async () => {
  const persistence = memoryPersistence(), settings = await createImageSettings({persistence});
  const saved = await settings.put(input(0, replace()));
  const waiting = deferred(), entered = deferred(), save = persistence.save;
  persistence.save = async candidate => { entered.resolve(); await waiting.promise; return save(candidate); };
  const changing = settings.put(input(1, {action: 'remove'}));
  assert.throws(() => settings[IMAGE_SETTINGS_READ_CURRENT](), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await entered.promise;
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  waiting.reject(new Error('synthetic-save-failure'));
  await assert.rejects(changing, {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.deepEqual(settings[IMAGE_SETTINGS_READ_CURRENT](), saved);
  assert.equal(settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), true);
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved))).apiKey, (replace() as {value: string}).value);
  await settings.close();
});

test('failed remove/replace preserves previous envelope and key; closed service never acquires', async () => {
  const persistence = memoryPersistence(), settings = await createImageSettings({persistence});
  const saved = await settings.put(input(0, replace('synthetic-before-failure'))), original = persistence.value;
  persistence.save = async () => { throw new Error('synthetic-before-failure'); };
  for (const secret of [{action: 'remove'} as SecretUpdate, replace('synthetic-replacement')]) {
    await assert.rejects(settings.put(input(1, secret)), (error: unknown) => {const failure = errorView(error); return failure.code === 'IMAGE_SETTINGS_SAVE_FAILED' && !failure.message!.includes('synthetic');});
    assert.deepEqual(await settings.get(), saved); assert.deepEqual(persistence.value!, original);
  }
  await settings.close();
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved)), {code: 'IMAGE_SETTINGS_CLOSED'});
  await assert.rejects(settings.put(input(1)), {code: 'IMAGE_SETTINGS_CLOSED'});
});

test('persistent keys are encrypted in one namespace-bound envelope and survive a fresh engine', async () => {
  const persistence = memoryPersistence(), secretCodec = syntheticCodec();
  const settings = await createImageSettings({persistence, secretCodec, storage: persistent});
  const saved = await settings.put(input(0, replace('synthetic-persistent-sentinel', 'persistent')));
  assert.equal(saved.storage.sessionScope, 'server');
  assert.deepEqual(saved.secret, {configured: true, storage: 'persistent'});
  assert.equal(JSON.stringify(persistence.value!).includes('synthetic-persistent-sentinel'), false);
  assert.equal(JSON.stringify(saved).includes(persistence.value!.secret!.encrypted!), false);
  const wrapper = validateImageSecretPlaintext(secretCodec.decrypt(persistence.value!.secret!.encrypted!));
  assert.equal(wrapper.namespace, IMAGE_SETTINGS_NAMESPACE);
  assert.equal(wrapper.value, 'synthetic-persistent-sentinel');
  assert.deepEqual(JSON.parse(wrapper.binding), [IMAGE_SETTINGS_NAMESPACE, 'openai', configuration().profileId, IMAGE_SETTINGS_BASE_URL, configuration().model, configuration().options]);
  await settings.close();
  const restarted = await createImageSettings({persistence, secretCodec, storage: persistent});
  assert.deepEqual(await restarted.get(), saved);
  assert.equal((await restarted[IMAGE_CREDENTIAL_ACQUIRE](expected(saved))).apiKey, wrapper.value);
  assert.equal(restarted[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), true);
  await restarted.put(input(1, {action: 'remove'}));
  assert.equal(persistence.value!.secret, null);
  await restarted.close();
});

test('no codec, unavailable vault and Linux basic_text never silently store a persistent key', async () => {
  for (const options of [{}, {storage: persistent}, {secretCodec: syntheticCodec(), storage: {...persistent, persistentAvailable: false, reasonCode: 'LINUX_BASIC_TEXT'}},
    {secretCodec: syntheticCodec(), storage: {...persistent, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'}}]) {
    const persistence = memoryPersistence(), settings = await createImageSettings({persistence, ...options});
    await assert.rejects(settings.put(input(0, replace('synthetic-do-not-fallback', 'persistent'))), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
    assert.equal(persistence.value, null);
    assert.equal((await settings.get()).revision, 0);
    assert.equal((await settings.put(input(0, replace('synthetic-explicit-session')))).secret.storage, 'session');
    assert.equal(JSON.stringify(persistence.value!).includes('synthetic-explicit-session'), false);
    await settings.close();
  }
});

test('locked vault retains ciphertext and permits explicit session replacement or removal', async () => {
  const persistence = memoryPersistence(), secretCodec = syntheticCodec();
  let available = true;
  const storage = () => available ? persistent : {...persistent, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'};
  let settings = await createImageSettings({persistence, secretCodec, storage});
  const saved = await settings.put(input(0, replace('synthetic-stored', 'persistent'))), original = persistence.value;
  await settings.close(); available = false;
  settings = await createImageSettings({persistence, secretCodec, storage});
  assert.equal((await settings.get()).secret.configured, true);
  assert.deepEqual(persistence.value!, original);
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved)), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await settings.put(input(1, replace('synthetic-explicit')))).secret.storage, 'session');
  assert.equal(persistence.value!.secret, null);
  await settings.put(input(2, {action: 'remove'}));
  assert.equal((await settings.get()).secret.configured, false);
  await settings.close();
});

test('unreadable or foreign decrypted wrapper never leaks a key and can be explicitly replaced', async () => {
  const persistence = memoryPersistence(), secretCodec = syntheticCodec();
  const settings = await createImageSettings({persistence, secretCodec, storage: persistent});
  const saved = await settings.put(input(0, replace('synthetic-old', 'persistent')));
  await settings.close();
  for (const corrupt of [() => { throw new Error('synthetic-secret-error'); }, () => JSON.stringify({version: 1, namespace: 'agent', binding: 'agent', value: 'synthetic-secret-error'})]) {
    const current = await createImageSettings({persistence, secretCodec: {...secretCodec, decrypt: corrupt}, storage: persistent});
    assert.equal((await current.get()).storage.persistentAvailable, false);
    await assert.rejects(current[IMAGE_CREDENTIAL_ACQUIRE](expected(saved)), (error: unknown) => {const failure = errorView(error); return failure.code === 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE' && !failure.message!.includes('synthetic');});
    await current.close();
  }
  const repaired = await createImageSettings({persistence, secretCodec: {...secretCodec, decrypt() { throw new Error('synthetic-unreadable'); }}, storage: persistent});
  assert.equal((await repaired.put(input(1, replace('synthetic-new-session')))).secret.storage, 'session');
  await repaired.close();
});

test('stored wrong origins/profiles, Agent envelope and namespace mismatches fail closed without rewriting', async () => {
  const original = {version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, revision: 7, configuration: configuration(), secret: null};
  for (const invalid of [{...original, namespace: 'agent'}, {...original, version: 2}, {...original, value: 'synthetic-smuggle'},
    {...original, configuration: {...configuration(), baseUrl: 'https://other.example/v1'}},
    {...original, configuration: {...configuration(), profileId: 'agent'}},
    {version: 2, revision: 7, configuration: {presetId: 'openai', platformId: 'global', baseUrl: IMAGE_SETTINGS_BASE_URL, model: 'gpt-5', protocol: 'responses'}, secret: null}]) {
    const persistence = memoryPersistence(invalid as SettingsEnvelope | null), current = await createImageSettings({persistence});
    await assert.rejects(current.get(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(current.put(input(7, {action: 'remove'})), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.throws(() => current[IMAGE_SETTINGS_READ_CURRENT](), {code: 'IMAGE_SETTINGS_CORRUPT'});
    assert.deepEqual(persistence.value, invalid);
    await current.close();
  }
  assert.throws(() => validateImageSettingsEnvelope({...original, secret: {binding: 'agent', encrypted: 'YWJj'}}), {code: 'IMAGE_SETTINGS_CORRUPT'});
});

test('acquisition validates full configuration/revision and refuses other namespaces or hidden fields', async () => {
  const settings = await createImageSettings({persistence: memoryPersistence()});
  const saved = await settings.put(input(0, replace())), request = expected(saved);
  const credential = await settings[IMAGE_CREDENTIAL_ACQUIRE](request);
  assert.deepEqual(sanitizeImageCredentialResult(credential, request), credential);
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE]({...request, expectedRevision: 0}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE]({...request, configuration: configuration(false)}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => parseImageCredentialRequest({...request, namespace: 'agent'}), {code: 'IMAGE_SETTINGS_VALIDATION'});
  for (const altered of [{...credential, namespace: 'agent'}, {...credential, apiKey: credential.apiKey, fingerprint: 'synthetic-hash'}, {...credential, revision: 2}]) {
    assert.throws(() => sanitizeImageCredentialResult(altered, request), {code: 'IMAGE_SETTINGS_CONFLICT'});
  }
  await settings.close();
});

test('aborted or closing acquisition rejects and a pending removal prevents final dispatch', async () => {
  const persistence = memoryPersistence(), codec = syntheticCodec();
  let pendingDecrypt: Deferred | null = null;
  const secretCodec = {...codec, decrypt(value: string) { return pendingDecrypt ? pendingDecrypt.promise : codec.decrypt(value); }};
  const settings = await createImageSettings({persistence, secretCodec, storage: persistent});
  const saved = await settings.put(input(0, replace('synthetic-delayed', 'persistent')));
  const delayedPlaintext = codec.decrypt(persistence.value!.secret!.encrypted!);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved), {signal: aborted.signal}), {code: 'IMAGE_SETTINGS_CLOSED'});
  pendingDecrypt = deferred();
  const controller = new AbortController(), acquiring = settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved), {signal: controller.signal});
  await Promise.resolve();
  const changing = settings.put(input(1, {action: 'remove'}));
  assert.throws(() => settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  controller.abort();
  await assert.rejects(acquiring, (error: unknown) => ['IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_CLOSED'].includes(errorView(error).code ?? ''));
  pendingDecrypt!.resolve(delayedPlaintext);
  await changing;
  assert.equal(settings[IMAGE_SETTINGS_READ_CURRENT]().secret.configured, false);
  await settings.close();
});

test('OS bridge capability refresh is optional, bounded and failure never prevents explicit session settings', async () => {
  const codec = syntheticCodec(), persistence = memoryPersistence();
  let available = false, failRefresh = false, refreshes = 0;
  const secretCodec = {...codec, async refreshStorage() { refreshes++; if (failRefresh) throw new Error('synthetic-bridge-error'); }};
  const storage = () => available ? persistent : {...persistent, persistentAvailable: false, reasonCode: 'OS_SECRET_STORE_UNAVAILABLE'};
  const settings = await createImageSettings({persistence, secretCodec, storage});
  assert.equal((await settings.get()).storage.persistentAvailable, false);
  available = true;
  assert.equal((await settings.get()).storage.persistentAvailable, true);
  const saved = await settings.put(input(0, replace('synthetic-bridge-key', 'persistent')));
  assert.equal((await settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved))).apiKey, 'synthetic-bridge-key');
  const beforeRead = refreshes; settings[IMAGE_SETTINGS_READ_CURRENT](); settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(saved));
  assert.equal(refreshes, beforeRead, 'sync methods never invoke IPC or decryption');
  failRefresh = true;
  assert.equal((await settings.get()).storage.persistentAvailable, false);
  await assert.rejects(settings[IMAGE_CREDENTIAL_ACQUIRE](expected(saved)), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal((await settings.put(input(1, replace('synthetic-session-after-bridge-failure')))).secret.storage, 'session');
  assert.equal(settings[IMAGE_SETTINGS_ASSERT_CURRENT](expected(await settings.get())), true);
  await settings.close();
});

test('malformed encrypted output or revision overflow cannot be saved', async () => {
  for (const encrypted of ['', 'not base64!', 'a', 'Zh==', 'x'.repeat(48 * 1024 + 4)]) {
    const persistence = memoryPersistence(), secretCodec = {encrypt: () => encrypted, decrypt: () => assert.fail('No decrypt')};
    const settings = await createImageSettings({persistence, secretCodec, storage: persistent});
    await assert.rejects(settings.put(input(0, replace('synthetic-malformed-output', 'persistent'))), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
    assert.equal(persistence.value, null); await settings.close();
  }
  const persistence = memoryPersistence({version: 1, namespace: IMAGE_SETTINGS_NAMESPACE, revision: Number.MAX_SAFE_INTEGER, configuration: configuration(), secret: null});
  const settings = await createImageSettings({persistence});
  await assert.rejects(settings.put(input(Number.MAX_SAFE_INTEGER)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(persistence.value!.revision, Number.MAX_SAFE_INTEGER);
  await settings.close();
});
