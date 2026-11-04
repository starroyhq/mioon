import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConnectionV2} from '../packages/contracts/src/generation-image-settings.ts';
import {createCustomImageSettingsV2, validateCustomImageSettingsV2Envelope} from '../packages/business/src/images/custom-settings-v2.ts';

const configuration = {...structuredClone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2), enabled: true, baseUrl: 'https://images.example.com/v1', model: 'same-model'};
const create = (expectedRevision = 0, name = 'A', value = 'synthetic-key-A', storage = 'session') => ({expectedRevision, name, configuration, secret: {action: 'replace', storage, value}});
const expected = (item: CustomImageConnectionV2) => ({connectionId: item.connectionId, configurationRevision: item.configurationRevision, configuration: item.configuration});
const put = (expectedRevision: number, item: CustomImageConnectionV2, patch: Record<string, unknown> = {}) => ({expectedRevision, connectionId: item.connectionId,
  expectedConfigurationRevision: item.configurationRevision, name: item.name, configuration: item.configuration, secret: {action: 'keep'}, ...patch});
const remove = (expectedRevision: number, item: CustomImageConnectionV2) => ({expectedRevision, connectionId: item.connectionId, expectedConfigurationRevision: item.configurationRevision});
function deferred<T = void>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};
}
function memory() {
  let value: unknown = null, saves = 0;
  return {load: async (): Promise<unknown> => structuredClone(value), save: async (next: unknown): Promise<void> => {saves++; value = structuredClone(next);},
    get value() {return structuredClone(value);}, get saves() {return saves;}};
}
// A synthetic codec with independently identifiable ciphertext, so races can
// hold encryption/decryption without placing a credential into a stored file.
function codec() {
  const values = new Map<string, string>(); let counter = 0;
  return {encrypt(value: string): string {const encrypted = Buffer.from(`synthetic-cipher-${++counter}`).toString('base64'); values.set(encrypted, value); return encrypted;},
    decrypt(value: string): string {const result = values.get(value); assert.ok(result); return result;}};
}
const storage = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};

test('put admission immediately fences only its target, owns caller data and releases only after durable confirmation', async t => {
  const file = memory(), entered = deferred(), release = deferred(); let hold = false;
  const persistence = {load: file.load, save: async (value: unknown): Promise<void> => {if (hold) {entered.resolve(); await release.promise;} await file.save(value);}};
  const settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0], b = (await settings.create(create(1, 'B', 'synthetic-key-B'))).connections[1];
  hold = true;
  const incomingConfiguration = {...configuration, model: 'next-model'}, incomingSecret = {action: 'replace', storage: 'session', value: 'synthetic-next-A'};
  const input = put(2, a, {configuration: incomingConfiguration, secret: incomingSecret});
  const updating = settings.put(input);
  incomingConfiguration.model = 'caller-mutated'; incomingSecret.value = 'caller-mutated';
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => settings.select(a.connectionId), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => settings.readCurrent(), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.equal(settings.assertCurrent(expected(b)), true);
  await assert.rejects(settings.acquire(expected(a)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await entered.promise; assert.equal(file.saves, 2); release.resolve();
  const next = await updating;
  assert.equal(next.connections[0].configuration.model, 'next-model');
  assert.equal((await settings.acquire(expected(next.connections[0]))).apiKey, 'synthetic-next-A');
  assert.equal((await settings.acquire(expected(b))).apiKey, 'synthetic-key-B');
});

test('collection CAS serializes competing saves without losing another connection or rotating the loser revision', async t => {
  const file = memory(), settings = await createCustomImageSettingsV2({persistence: file}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0], b = (await settings.create(create(1, 'B', 'synthetic-key-B'))).connections[1];
  const result = await Promise.allSettled([settings.put(put(2, a, {name: 'A updated'})), settings.put(put(2, b, {name: 'B losing update'}))]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
  assert.equal((result[1] as PromiseRejectedResult).reason.code, 'IMAGE_SETTINGS_CONFLICT');
  const next = await settings.get(); assert.equal(next.revision, 3); assert.equal(file.saves, 3);
  assert.deepEqual(next.connections[1], b); assert.equal(settings.assertCurrent(expected(b)), true);
});

test('delete admission revokes an already-awaiting acquisition and the final dispatch fence without returning its late key', async t => {
  const file = memory(), base = codec(), entered = deferred(), release = deferred(); let hold = false, posts = 0;
  const secretCodec = {...base, decrypt: async (value: string): Promise<string> => {if (hold) {entered.resolve(); await release.promise;} return base.decrypt(value);}};
  const settings = await createCustomImageSettingsV2({persistence: file, secretCodec, storage}); t.after(() => settings.close());
  const a = (await settings.create(create(0, 'A', 'synthetic-persistent', 'persistent'))).connections[0];
  hold = true; const acquiring = settings.acquire(expected(a)); await entered.promise;
  const deletion = settings.remove(remove(1, a));
  assert.throws(() => {settings.assertCurrent(expected(a)); posts++;}, {code: 'IMAGE_SETTINGS_CONFLICT'});
  release.resolve(); await assert.rejects(acquiring, {code: 'IMAGE_SETTINGS_CONFLICT'}); await deletion;
  assert.throws(() => {settings.assertCurrent(expected(a)); posts++;}, {code: 'IMAGE_SETTINGS_NOT_FOUND'});
  assert.equal(posts, 0);
  const retained = validateCustomImageSettingsV2Envelope(file.value);
  assert.deepEqual(retained.connections, []); assert.deepEqual(retained.deletedConnectionIds, [a.connectionId]);
});

test('known failed saves hold the admission fence through read-back then retain exactly the old credential', async t => {
  const file = memory(), readEntered = deferred(), readRelease = deferred(); let failSave = false;
  const persistence = {load: async (): Promise<unknown> => {if (failSave) {readEntered.resolve(); await readRelease.promise;} return file.load();},
    save: async (value: unknown): Promise<void> => {if (failSave) throw Error('synthetic-private-error'); await file.save(value);}};
  const settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0]; failSave = true;
  const saving = settings.put(put(1, a, {secret: {action: 'replace', storage: 'session', value: 'synthetic-replacement'}}));
  await readEntered.promise;
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  readRelease.resolve(); await assert.rejects(saving, {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  failSave = false; assert.equal(settings.assertCurrent(expected(a)), true);
  assert.equal((await settings.acquire(expected(a))).apiKey, 'synthetic-key-A');
  assert.equal(file.saves, 1); assert.equal((await settings.get()).revision, 1);
});

for (const outcome of ['candidate', 'missing', 'foreign', 'unreadable'] as const) test(`unknown ${outcome} save outcome latches closed, clears sessions and never retries`, async t => {
  const file = memory(); let failSave = false;
  const persistence = {load: async (): Promise<unknown> => {
    if (failSave && outcome === 'missing') return null;
    if (failSave && outcome === 'foreign') return {version: 2, namespace: 'mioon.agent.v1'};
    if (failSave && outcome === 'unreadable') throw Error('synthetic-sensitive-storage-error');
    return file.load();
  }, save: async (value: unknown): Promise<void> => {if (failSave) {if (outcome === 'candidate') await file.save(value); throw Error('synthetic-sensitive-save-error');} await file.save(value);}};
  const settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0]; failSave = true;
  await assert.rejects(settings.remove(remove(1, a)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.put(put(1, a)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.acquire(expected(a)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(file.saves, outcome === 'candidate' ? 2 : 1);
  if (outcome === 'candidate') {
    failSave = false; const restarted = await createCustomImageSettingsV2({persistence}); t.after(() => restarted.close());
    assert.deepEqual((await restarted.get()).connections, []);
    assert.deepEqual(validateCustomImageSettingsV2Envelope(file.value).deletedConnectionIds, [a.connectionId]);
  }
});

test('an uncertain create never allocates or saves a second UUID until a fresh owner reads the committed collection', async t => {
  const file = memory(); let saves = 0, allocations = 0;
  const persistence = {load: file.load, save: async (value: unknown): Promise<void> => {saves++; await file.save(value); throw Error('synthetic-lost-ack');}};
  const settings = await createCustomImageSettingsV2({persistence, createConnectionId: () => {allocations++; return '00000000-0000-4000-8000-000000000001';}});
  t.after(() => settings.close());
  await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  await assert.rejects(settings.create(create()), {code: 'IMAGE_SETTINGS_SAVE_FAILED'});
  assert.equal(saves, 1); assert.equal(allocations, 1);
  const restarted = await createCustomImageSettingsV2({persistence: file}); t.after(() => restarted.close());
  const collection = await restarted.get(); assert.equal(collection.revision, 1); assert.equal(collection.connections.length, 1);
  assert.equal((await restarted.acquire(expected(collection.connections[0]))).apiKey, null);
});

test('close while encrypting rejects the late replacement before saving or reviving a session', async () => {
  const file = memory(), base = codec(), entered = deferred(), release = deferred();
  const secretCodec = {...base, encrypt: async (value: string): Promise<string> => {entered.resolve(); await release.promise; return base.encrypt(value);}};
  const settings = await createCustomImageSettingsV2({persistence: file, secretCodec, storage});
  const saving = settings.create(create(0, 'A', 'synthetic-persistent', 'persistent')); await entered.promise;
  const closing = settings.close(); release.resolve();
  await assert.rejects(saving, {code: 'IMAGE_SETTINGS_CLOSED'}); await closing; assert.equal(file.saves, 0);
  await assert.rejects(settings.get(), {code: 'IMAGE_SETTINGS_CLOSED'});
});

test('close during an already-started save retains its durable outcome but cannot republish a session key', async () => {
  const file = memory(), entered = deferred(), release = deferred(); let hold = false;
  const persistence = {load: file.load, save: async (value: unknown): Promise<void> => {if (hold) {entered.resolve(); await release.promise;} await file.save(value);}};
  const settings = await createCustomImageSettingsV2({persistence});
  const a = (await settings.create(create())).connections[0]; hold = true;
  const saving = settings.put(put(1, a, {secret: {action: 'replace', storage: 'session', value: 'synthetic-late-key'}}));
  await entered.promise; const closing = settings.close(); release.resolve();
  const result = await saving; await closing;
  assert.equal(result.revision, 2); assert.equal(result.connections[0].secret.configured, false);
  await assert.rejects(settings.acquire(expected(result.connections[0])), {code: 'IMAGE_SETTINGS_CLOSED'});
  const restarted = await createCustomImageSettingsV2({persistence});
  assert.equal((await restarted.acquire(expected(result.connections[0]))).apiKey, null); await restarted.close();
});

test('close while decrypting never returns its late plaintext or authorizes dispatch', async () => {
  const file = memory(), base = codec(), entered = deferred(), release = deferred();
  const secretCodec = {...base, decrypt: async (value: string): Promise<string> => {entered.resolve(); await release.promise; return base.decrypt(value);}};
  const settings = await createCustomImageSettingsV2({persistence: file, secretCodec, storage});
  const a = (await settings.create(create(0, 'A', 'synthetic-persistent', 'persistent'))).connections[0];
  const acquiring = settings.acquire(expected(a)); await entered.promise;
  const closing = settings.close(); release.resolve();
  await assert.rejects(acquiring, {code: 'IMAGE_SETTINGS_CLOSED'}); await closing;
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_CLOSED'});
});

test('a failed later operation rolls back all earlier session replacements in the same batch', async t => {
  const file = memory(), settings = await createCustomImageSettingsV2({persistence: file}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0], b = (await settings.create(create(1, 'B', 'synthetic-key-B'))).connections[1];
  const {expectedRevision: ignored, ...first} = put(2, a, {secret: {action: 'replace', storage: 'session', value: 'synthetic-uncommitted'}}); void ignored;
  const {expectedRevision: ignored2, ...second} = put(2, b); void ignored2;
  await assert.rejects(settings.batch({expectedRevision: 2, operations: [{...first, action: 'put'}, {...second, action: 'put', expectedConfigurationRevision: 2}]}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.equal(file.saves, 2); assert.equal((await settings.acquire(expected(a))).apiKey, 'synthetic-key-A');
  assert.equal((await settings.acquire(expected(b))).apiKey, 'synthetic-key-B');
});
