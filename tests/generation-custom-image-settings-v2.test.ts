import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, CUSTOM_IMAGE_SETTINGS_V2_LIMITS, DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,
  customImageSettingsV2ResultSchema, customImageBatchV2Schema} from '../packages/contracts/src/generation-image-settings.ts';
import type {CustomImageConnectionV2, CustomImageConfigurationV2} from '../packages/contracts/src/generation-image-settings.ts';
import {CUSTOM_IMAGE_SETTINGS_NAMESPACE, DEFAULT_CUSTOM_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {createCustomImageSettingsV2, validateCustomImageSettingsV2Envelope, validateCustomImageSettingsV2Stored,
  validateCustomImageSecretPlaintextV2, customImageCredentialBindingV2, sanitizeCustomImageSettingsV2Error} from '../packages/business/src/images/custom-settings-v2.ts';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const configuration = (patch: Partial<CustomImageConfigurationV2> = {}): CustomImageConfigurationV2 => ({...structuredClone(DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2),
  enabled: true, baseUrl: 'https://images.example.com/v1', model: 'same-model', ...patch});
const replace = (value: string, storage: 'session' | 'persistent' = 'session') => ({action: 'replace', storage, value});
const create = (expectedRevision = 0, name = 'A', secret: unknown = replace('synthetic-key-A'), config = configuration(), connectionId: string = randomUUID()) => ({expectedRevision, connectionId, name, configuration: config, secret});
const expected = (item: CustomImageConnectionV2) => ({connectionId: item.connectionId, configurationRevision: item.configurationRevision, configuration: item.configuration});
const put = (expectedRevision: number, item: CustomImageConnectionV2, patch: Record<string, unknown> = {}) => ({expectedRevision,
  connectionId: item.connectionId, expectedConfigurationRevision: item.configurationRevision, name: item.name,
  configuration: item.configuration, secret: {action: 'keep'}, ...patch});
const remove = (expectedRevision: number, item: CustomImageConnectionV2) => ({expectedRevision, connectionId: item.connectionId,
  expectedConfigurationRevision: item.configurationRevision});
function memory(initial: unknown = null) {
  let value = structuredClone(initial), saves = 0;
  return {load: async (): Promise<unknown> => structuredClone(value), save: async (next: unknown): Promise<void> => {saves++; value = structuredClone(next);},
    get value() {return structuredClone(value);}, get saves() {return saves;}};
}
function cipher() {
  const key = randomBytes(32);
  return {encrypt(value: string): string {validateCustomImageSecretPlaintextV2(value); const iv = randomBytes(12), encoder = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, encoder.update(value), encoder.final(), encoder.getAuthTag()]).toString('base64');},
  decrypt(value: string): string {const bytes = Buffer.from(value, 'base64'), decoder = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decoder.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decoder.update(bytes.subarray(12, -16)), decoder.final()]).toString();}};
}
const persistent = {persistentAvailable: true, sessionScope: 'server', reasonCode: null};

test('independent v2 defaults are inert and strict; public metadata never contains credentials or tombstones', async t => {
  const persistence = memory(), settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  assert.deepEqual(await settings.get(), {revision: 0, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null});
  assert.equal(persistence.saves, 0); assert.equal(persistence.value, null);
  assert.throws(() => settings.select(), {code: 'IMAGE_SETTINGS_NOT_CONFIGURED'});
  assert.equal('reset' in settings, false);
  const saved = await settings.create(create()), item = saved.connections[0];
  assert.match(item.connectionId, /^[0-9a-f-]{36}$/); assert.equal(item.configurationRevision, 1);
  assert.ok(customImageSettingsV2ResultSchema.safeParse(saved).success);
  assert.equal(customImageSettingsV2ResultSchema.safeParse({...saved, revision: 0}).success, false);
  assert.equal(JSON.stringify(saved).includes('synthetic-key'), false);
  assert.equal(JSON.stringify(persistence.value).includes('synthetic-key'), false);
  assert.equal('deletedConnectionIds' in saved, false);
  for (const invalid of [{...create(1), connectionId: undefined}, {...create(1), connectionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}, {...create(1), apiKey: 'synthetic-smuggled'},
    create(1, ' padded '), create(1, 'A', replace('two words')), create(1, 'A', replace('x'.repeat(4097))),
    create(1, 'A', replace('synthetic-key'), configuration({baseUrl: 'https://images.example.com/v1/'})),
    create(1, 'A', replace('synthetic-key'), DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2)]) {
    await assert.rejects(settings.create(invalid), {code: 'IMAGE_SETTINGS_VALIDATION'});
  }
  assert.equal(persistence.saves, 1);
  assert.equal(JSON.stringify(sanitizeCustomImageSettingsV2Error({code: 'unknown', message: 'synthetic-key'})).includes('synthetic-key'), false);
});

test('same-model same-revision A/B credentials stay isolated and B saves never invalidate A', async t => {
  const persistence = memory(), settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0];
  const b = (await settings.create(create(1, 'B', replace('synthetic-key-B')))).connections[1];
  assert.equal(a.configurationRevision, b.configurationRevision); assert.deepEqual(a.configuration, b.configuration);
  assert.throws(() => settings.select(), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  assert.deepEqual(settings.select(a.connectionId), a);
  assert.equal((await settings.acquire(expected(a))).apiKey, 'synthetic-key-A');
  assert.equal((await settings.acquire(expected(b))).apiKey, 'synthetic-key-B');
  const next = await settings.put(put(2, b, {configuration: configuration({enabled: false})}));
  assert.deepEqual(next.connections[0], a); assert.equal(settings.assertCurrent(expected(a)), true);
  assert.throws(() => settings.select(), {code: 'IMAGE_SETTINGS_SELECTION_REQUIRED'});
  await assert.rejects(settings.acquire(expected(b)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.equal((await settings.acquire(expected(next.connections[1]))).apiKey, 'synthetic-key-B');
  assert.throws(() => settings.assertCurrent(expected(next.connections[1])), {code: 'IMAGE_SETTINGS_DISABLED'});
  await assert.rejects(settings.acquire({...expected(a), namespace: 'mioon.agent.v1'}), {code: 'IMAGE_SETTINGS_VALIDATION'});
});

test('one bounded batch publishes all changes once with one collection CAS and per-connection revisions', async t => {
  const persistence = memory(), settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const {expectedRevision: ignored, ...operation} = create(); void ignored;
  const first = await settings.batch({expectedRevision: 0, operations: [{...operation, action: 'create'}, {...operation, action: 'create', connectionId: randomUUID(), name: 'B', secret: replace('synthetic-key-B')}]});
  assert.equal(persistence.saves, 1); assert.equal(first.revision, 1); assert.equal(first.connections.length, 2);
  const [a, b] = first.connections;
  const edit = (item: CustomImageConnectionV2) => {const {expectedRevision, ...value} = put(1, item); void expectedRevision; return {...value, action: 'put'};};
  const next = await settings.batch({expectedRevision: 1, operations: [{...edit(a), name: 'Renamed A'}, {...edit(b), secret: {action: 'remove'}}]});
  assert.equal(persistence.saves, 2); assert.equal(next.revision, 2);
  assert.deepEqual(next.connections.map(item => item.configurationRevision), [2, 2]);
  assert.equal((await settings.acquire(expected(next.connections[0]))).apiKey, 'synthetic-key-A');
  assert.equal((await settings.acquire(expected(next.connections[1]))).apiKey, null);
  await assert.rejects(settings.batch({expectedRevision: 2, operations: [{...edit(next.connections[0]), name: 'Must not persist'},
    {...edit(next.connections[1]), expectedConfigurationRevision: 1}]}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.equal(persistence.saves, 2); assert.deepEqual(await settings.get(), next);
  assert.equal(customImageBatchV2Schema.safeParse({expectedRevision: 2, operations: [edit(a), edit(a)]}).success, false);
  await assert.rejects(settings.put(put(1, next.connections[0])), {code: 'IMAGE_SETTINGS_CONFLICT'});
});

for (const storageKind of ['session', 'persistent'] as const) test(`${storageKind}: model changes keep the recipient key while full configuration and revision fences invalidate the old review`, async t => {
  const persistence = memory(), secretCodec = cipher(), settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent}); t.after(() => settings.close());
  const a = (await settings.create(create(0, 'A', replace('synthetic-key-A', storageKind)))).connections[0];
  const oldSecret = validateCustomImageSettingsV2Envelope(persistence.value).connections[0].secret;
  const changed = (await settings.put(put(1, a, {configuration: configuration({model: 'different-model'})}))).connections[0];
  assert.equal(changed.configurationRevision, 2); assert.equal(changed.secret.configured, true);
  assert.deepEqual(validateCustomImageSettingsV2Envelope(persistence.value).connections[0].secret, oldSecret);
  assert.equal(customImageCredentialBindingV2(a.connectionId, a.configuration), customImageCredentialBindingV2(changed.connectionId, changed.configuration));
  assert.equal((await settings.acquire(expected(changed))).apiKey, 'synthetic-key-A');
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  assert.throws(() => settings.assertCurrent({...expected(changed), configuration: a.configuration}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  await assert.rejects(settings.acquire(expected(a)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  const renamed = (await settings.put(put(2, changed, {name: 'A renamed'}))).connections[0];
  assert.equal((await settings.acquire(expected(renamed))).apiKey, 'synthetic-key-A');
});

for (const storageKind of ['session', 'persistent'] as const) test(`${storageKind}: changing an address with keep saves and clears only that service's key`, async t => {
  const persistence = memory(), secretCodec = cipher(), settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent}); t.after(() => settings.close());
  const a = (await settings.create(create(0, 'A', replace('synthetic-key-A', storageKind)))).connections[0];
  const b = (await settings.create(create(1, 'B', replace('synthetic-key-B', storageKind)))).connections[1];
  const oldSecret = validateCustomImageSettingsV2Envelope(persistence.value).connections[0].secret;
  const changed = await settings.put(put(2, a, {configuration: configuration({baseUrl: 'https://other.example.com/v2'})}));
  const next = changed.connections[0];
  assert.equal(changed.revision, 3); assert.equal(next.configurationRevision, 2);
  assert.deepEqual(next.secret, {configured: false, storage: 'none'});
  assert.equal(validateCustomImageSettingsV2Envelope(persistence.value).connections[0].secret, null);
  if (oldSecret) assert.equal(JSON.stringify(persistence.value).includes(oldSecret.encrypted), false);
  assert.equal((await settings.acquire(expected(next))).apiKey, null);
  assert.throws(() => settings.assertCurrent(expected(next)), {code: 'IMAGE_SETTINGS_NOT_CONFIGURED'});
  assert.deepEqual(changed.connections[1], b); assert.equal(settings.assertCurrent(expected(b)), true);
  assert.equal((await settings.acquire(expected(b))).apiKey, 'synthetic-key-B');
  const replaced = (await settings.put(put(3, next, {secret: replace('synthetic-new-recipient-key', storageKind)}))).connections[0];
  assert.equal((await settings.acquire(expected(replaced))).apiKey, 'synthetic-new-recipient-key');
});

test('persistent credentials bind v2 namespace, provider, UUID, profile and canonical address and survive a fresh owner', async t => {
  const persistence = memory(), secretCodec = cipher();
  let settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent}); t.after(() => settings.close());
  const a = (await settings.create(create(0, 'A', replace('synthetic-persistent-A', 'persistent')))).connections[0];
  const b = (await settings.create(create(1, 'B', replace('synthetic-persistent-B', 'persistent')))).connections[1];
  const stored = validateCustomImageSettingsV2Envelope(persistence.value);
  assert.equal(stored.namespace, CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE);
  assert.equal(stored.connections[0].secret!.binding, customImageCredentialBindingV2(a.connectionId, a.configuration));
  assert.equal(JSON.stringify(stored).includes('synthetic-persistent'), false);
  const plaintext = validateCustomImageSecretPlaintextV2(secretCodec.decrypt(stored.connections[0].secret!.encrypted));
  assert.equal(plaintext.connectionId, a.connectionId);
  const recipient = JSON.parse(plaintext.binding) as unknown[];
  assert.deepEqual(recipient, [CUSTOM_IMAGE_SETTINGS_V2_NAMESPACE, 'openai-compatible', a.connectionId, a.configuration.profileId, a.configuration.baseUrl]);
  for (const binding of [[...recipient, a.configuration.model, a.configuration.options],
    [recipient[0], 'openai', ...recipient.slice(2)], [...recipient.slice(0, 3), 'foreign-profile', recipient[4]],
    [...recipient.slice(0, 4), 'https://IMAGES.example.com/v1'], [...recipient.slice(0, 4), 'https://images.example.com/v1/']])
    assert.throws(() => validateCustomImageSecretPlaintextV2(JSON.stringify({...plaintext, binding: JSON.stringify(binding)})), {code: 'IMAGE_SETTINGS_CORRUPT'});
  for (const patch of [{namespace: 'mioon.agent.v1'}, {namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE}, {version: 1}, {connectionId: b.connectionId}, {apiKey: 'synthetic-smuggle'}])
    assert.throws(() => validateCustomImageSecretPlaintextV2(JSON.stringify({...plaintext, ...patch})), {code: 'IMAGE_SETTINGS_CORRUPT'});
  await settings.close(); settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent});
  assert.equal((await settings.acquire(expected(a))).apiKey, 'synthetic-persistent-A');
  assert.equal((await settings.acquire(expected(b))).apiKey, 'synthetic-persistent-B');
  const swapped = structuredClone(stored); swapped.connections[1].secret!.encrypted = stored.connections[0].secret!.encrypted;
  const foreign = await createCustomImageSettingsV2({persistence: memory(swapped), secretCodec, storage: persistent}); t.after(() => foreign.close());
  await assert.rejects(foreign.acquire(expected(b)), {code: 'IMAGE_SETTINGS_CORRUPT'});
  assert.equal((await foreign.acquire(expected(a))).apiKey, 'synthetic-persistent-A');
});

test('delete removes persistent ciphertext and sessions, only UUID tombstones remain and deleted UUIDs cannot be reused', async t => {
  const persistence = memory(), secretCodec = cipher();
  let settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent}); t.after(() => settings.close());
  const a = (await settings.create(create(0, 'A', replace('synthetic-persistent-A', 'persistent'), configuration(), id(1)))).connections[0];
  const b = (await settings.create(create(1, 'B', replace('synthetic-key-B'), configuration(), id(2)))).connections[1];
  const ciphertext = validateCustomImageSettingsV2Envelope(persistence.value).connections[0].secret!.encrypted;
  const deleted = await settings.remove(remove(2, a));
  const stored = validateCustomImageSettingsV2Envelope(persistence.value);
  assert.deepEqual(stored.deletedConnectionIds, [a.connectionId]);
  assert.equal(JSON.stringify(stored).includes(ciphertext), false); assert.deepEqual(settings.select(), b);
  await assert.rejects(settings.acquire(expected(a)), {code: 'IMAGE_SETTINGS_NOT_FOUND'});
  assert.throws(() => settings.assertCurrent(expected(a)), {code: 'IMAGE_SETTINGS_NOT_FOUND'});
  await assert.rejects(settings.create(create(deleted.revision, 'A again', replace('synthetic-new-key'), configuration(), a.connectionId)), {code: 'IMAGE_SETTINGS_CONFLICT'});
  const created = await settings.create(create(deleted.revision, 'C', replace('synthetic-key-C'), configuration(), id(3)));
  assert.equal(created.connections[1].connectionId, id(3));
  await settings.remove(remove(created.revision, b));
  await settings.close(); settings = await createCustomImageSettingsV2({persistence, secretCodec, storage: persistent});
  assert.equal((await settings.get()).connections.length, 1);
  assert.equal((await settings.acquire(expected(created.connections[1]))).apiKey, null);
  assert.equal(validateCustomImageSettingsV2Envelope(persistence.value).deletedConnectionIds.includes(b.connectionId), true);
});

test('page draft UUIDs are preserved and duplicate create IDs are rejected without renaming or writing', async t => {
  const persistence = memory(), settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const request = create(0, 'Page draft A', {action: 'keep'}, configuration(), id(31));
  const a = (await settings.create(request)).connections[0]; assert.equal(a.connectionId, request.connectionId);
  await assert.rejects(settings.create({...request, expectedRevision: 1, name: 'Duplicate'}), {code: 'IMAGE_SETTINGS_CONFLICT'});
  const {expectedRevision, ...operation} = create(1, 'New B', {action: 'keep'}, configuration(), id(32)); void expectedRevision;
  await assert.rejects(settings.batch({expectedRevision: 1, operations: [{...operation, action: 'create'}, {...operation, action: 'create', name: 'Duplicate B'}]}), {code: 'IMAGE_SETTINGS_VALIDATION'});
  await assert.rejects(settings.batch({expectedRevision: 1, operations: [{...operation, action: 'create', connectionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}]}), {code: 'IMAGE_SETTINGS_VALIDATION'});
  assert.equal(persistence.saves, 1); assert.deepEqual((await settings.get()).connections, [a]);
});

test('strict recognized legacy v1 becomes empty v2 plus stable notice without decryption or writes; explicit save replaces it', async t => {
  const legacyConfig = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://legacy.example.com/v1', model: 'legacy-model'};
  const binding = JSON.stringify([CUSTOM_IMAGE_SETTINGS_NAMESPACE, legacyConfig.providerId, 'custom', legacyConfig.profileId, legacyConfig.baseUrl, legacyConfig.model, legacyConfig.options]);
  const old = {version: 1, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE, revision: 83, configuration: legacyConfig, secret: {binding, encrypted: Buffer.from('synthetic-legacy-ciphertext').toString('base64')}};
  const persistence = memory(old), settings = await createCustomImageSettingsV2({persistence, secretCodec: {decrypt() {assert.fail('Legacy key must not be decrypted');}, encrypt() {assert.fail('Legacy key must not be copied');}}}); t.after(() => settings.close());
  for (let i = 0; i < 2; i++) {const result = await settings.get(); assert.equal(result.revision, 0); assert.deepEqual(result.connections, []); assert.equal(result.notice, 'LEGACY_CUSTOM_IMAGE_SETTINGS_RESET');}
  assert.equal(persistence.saves, 0); assert.deepEqual(persistence.value, old);
  const next = await settings.create(create(0, 'Fresh', {action: 'keep'})); assert.equal(next.notice, null);
  assert.equal(validateCustomImageSettingsV2Envelope(persistence.value).revision, 1);
  assert.equal(JSON.stringify(persistence.value).includes('legacy'), false);
  for (const invalid of [{...old, version: 3}, {...old, namespace: 'mioon.agent.v1'}, {...old, hidden: true},
    {...old, secret: {binding, encrypted: 'bad base64'}}, {...old, configuration: {...legacyConfig, connectionId: id(1)}}]) {
    assert.throws(() => validateCustomImageSettingsV2Stored(invalid), {code: 'IMAGE_SETTINGS_CORRUPT'});
    const owner = await createCustomImageSettingsV2({persistence: memory(invalid)}); t.after(() => owner.close());
    await assert.rejects(owner.get(), {code: 'IMAGE_SETTINGS_CORRUPT'});
    await assert.rejects(owner.create(create()), {code: 'IMAGE_SETTINGS_CORRUPT'});
  }
});

test('session-only restart, unavailable codecs and malformed ciphertext never adopt or silently persist another key', async t => {
  const persistence = memory(); let settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  const a = (await settings.create(create())).connections[0]; await settings.close();
  settings = await createCustomImageSettingsV2({persistence});
  assert.equal((await settings.acquire(expected(a))).apiKey, null);
  await assert.rejects(settings.put(put(1, a, {secret: replace('synthetic-persistent', 'persistent')})), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.equal(persistence.saves, 1);
  for (const secretCodec of [{encrypt: () => 'not base64', decrypt: () => ''}, {encrypt: () => 'AB==', decrypt: () => ''}]) {
    const owner = await createCustomImageSettingsV2({persistence: memory(), secretCodec, storage: persistent}); t.after(() => owner.close());
    await assert.rejects(owner.create(create(0, 'A', replace('synthetic-persistent', 'persistent'))), {code: 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE'});
  }
});

test('bounded collections and envelopes reject duplicate identities, impossible revisions and resource overflow', async t => {
  const persistence = memory(), settings = await createCustomImageSettingsV2({persistence}); t.after(() => settings.close());
  for (let i = 0; i < CUSTOM_IMAGE_SETTINGS_V2_LIMITS.connections; i++) await settings.create(create(i, `Service ${i}`, {action: 'keep'}));
  await assert.rejects(settings.create(create(10)), {code: 'IMAGE_SETTINGS_CAPACITY'});
  const value = validateCustomImageSettingsV2Envelope(persistence.value), a = value.connections[0];
  for (const invalid of [{...value, revision: 0}, {...value, connections: [{...a, configurationRevision: value.revision + 1}]},
    {...value, deletedConnectionIds: [a.connectionId]}, {...value, connections: [a, a]},
    {...value, deletedConnectionIds: [id(300), id(300)]}, {...value, connections: [{...a, apiKey: 'synthetic-smuggle'}]},
    {...value, namespace: CUSTOM_IMAGE_SETTINGS_NAMESPACE}]) assert.throws(() => validateCustomImageSettingsV2Envelope(invalid), {code: 'IMAGE_SETTINGS_CORRUPT'});
  const inherited = Object.assign(Object.create({foreign: true}), create(10));
  await assert.rejects(settings.create(inherited), {code: 'IMAGE_SETTINGS_VALIDATION'});
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => validateCustomImageSettingsV2Envelope(cycle), {code: 'IMAGE_SETTINGS_CORRUPT'});
});
