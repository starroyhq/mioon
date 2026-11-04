import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {VIDEO_PROVIDER_NAMES, VIDEO_SETTINGS_LIMITS, VIDEO_SECRET_NAMESPACE, defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import {VIDEO_BUILTIN_PROVIDER_IDS, videoConnectionConfigurationV2Schema, videoSettingsUpdateV2Schema} from '../packages/contracts/src/generation-video-settings.ts';
import type {VideoConnectionConfigurationV2} from '../packages/contracts/src/generation-video-settings.ts';
import {createVideoSettingsV2, emptyVideoSettingsV2Envelope, validateVideoSettingsV2Envelope} from '../packages/business/src/video/settings-v2.ts';
import type {VideoSettingsV2Options} from '../packages/business/src/video/settings-v2.ts';
import {createVideoSettingsV2File} from '../packages/business/src/video/settings-v2-file.ts';

const KEY = 'synthetic-g1-video-key';
const replace = (value = KEY, storage: 'session' | 'persistent' = 'session') => ({action: 'replace' as const, value, storage});
const keep = {action: 'keep' as const};
function configuration(providerId: VideoConnectionConfigurationV2['providerId'] = 'minimax'): VideoConnectionConfigurationV2 {
  return {id: randomUUID(), providerId, name: VIDEO_PROVIDER_NAMES[providerId], region: providerId === 'compatible' ? 'custom' : providerId === 'ark' || providerId === 'wan' ? 'cn-beijing' : 'global', workspaceId: '', enabled: true, outputHosts: ['output.example.com'], models: defaultVideoModels(providerId), ...(providerId === 'compatible' ? {baseUrl: 'https://api.example.com/v1'} : {})};
}
function codec() {
  const key = randomBytes(32); let encryptions = 0, decryptions = 0;
  return {
    get encryptions() {return encryptions;}, get decryptions() {return decryptions;},
    encrypt(value: string) {encryptions++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');},
    decrypt(value: string) {decryptions++; const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();},
  };
}
async function fixture(t: {after(fn: () => unknown): void}, extra: Partial<VideoSettingsV2Options> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-g1-video-v2-')));
  const options = {directory: path.join(root, 'video-settings'), privateRoot: root, ...extra};
  const settings = await createVideoSettingsV2(options);
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  return {root, options, settings, file: path.join(options.directory, 'settings.json')};
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

test('video v2 shares implemented models but rejects connection archives, retired providers and credential restoration', () => {
  assert.deepEqual(VIDEO_BUILTIN_PROVIDER_IDS, ['ark', 'veo', 'minimax', 'vidu', 'kling', 'wan']);
  const current = configuration(); current.models[0]!.archived = true;
  assert.equal(videoConnectionConfigurationV2Schema.parse(current).models[0]!.archived, true);
  for (const value of [{...current, archived: false}, {...current, providerId: 'runway'}, {...current, name: 'Another account'}]) assert.equal(videoConnectionConfigurationV2Schema.safeParse(value).success, false);
  assert.equal(videoSettingsUpdateV2Schema.safeParse({action: 'restoreCredential', expectedRevision: 0, connectionId: current.id, credentialRef: randomUUID(), secret: replace()}).success, false);
  assert.equal(videoSettingsUpdateV2Schema.safeParse({action: 'archive', expectedRevision: 0, connectionId: current.id}).success, false);
});

test('one atomic batch stores six unique built-ins and independently billed custom connections', async t => {
  const f = await fixture(t), builtins = VIDEO_BUILTIN_PROVIDER_IDS.map(configuration), a = configuration('compatible'), b = configuration('compatible');
  b.name = 'Second custom service';
  const saved = await f.settings.put({action: 'batch', expectedRevision: 0, operations: [...builtins, a, b].map(configuration => ({action: 'save', configuration, secret: replace(configuration.id)}))});
  assert.equal(saved.revision, 1); assert.equal(saved.connections.length, 8);
  assert.ok(saved.connections.every(connection => connection.revision === 1));
  const before = await readFile(f.file, 'utf8'), another = configuration();
  await assert.rejects(f.settings.put({action: 'save', expectedRevision: 1, configuration: another, secret: replace()}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  await assert.rejects(f.settings.put({action: 'delete', expectedRevision: 1, connectionId: builtins[0]!.id}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  assert.equal(await readFile(f.file, 'utf8'), before);
  const selectedA = f.settings.select(a.id, 1, a.models[0]!.id), selectedB = f.settings.select(b.id, 1, b.models[0]!.id);
  assert.equal(await f.settings.acquire(selectedA), a.id); assert.equal(await f.settings.acquire(selectedB), b.id);
  assert.equal(selectedA.version, 1); assert.equal(JSON.parse(before).namespace, VIDEO_SECRET_NAMESPACE);
  const changed = {...configuration('compatible'), id: builtins[0]!.id};
  await assert.rejects(f.settings.put({action: 'save', expectedRevision: 1, configuration: changed, secret: replace()}), {code: 'VIDEO_SETTINGS_VALIDATION'});
});

test('region and workspace changes detach only the current key and preserve exact historical recipients', async t => {
  const f = await fixture(t), current = configuration(), other = configuration('compatible');
  await f.settings.put({action: 'batch', expectedRevision: 0, operations: [current, other].map(configuration => ({action: 'save', configuration, secret: replace()}))});
  const original = f.settings.select(current.id, 1, current.models[0]!.id), untouched = f.settings.select(other.id, 1, other.models[0]!.id);
  const moved = {...current, region: 'cn'};
  const saved = await f.settings.put({action: 'save', expectedRevision: 1, configuration: moved, secret: keep});
  assert.equal(saved.connections.find(entry => entry.configuration.id === current.id)!.secret.configured, false);
  assert.throws(() => f.settings.select(current.id, 2, current.models[0]!.id), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.equal(await f.settings.acquire(original), KEY); assert.equal(await f.settings.acquire(untouched), KEY);
  await f.settings.put({action: 'save', expectedRevision: 2, configuration: moved, secret: replace('synthetic-cn-key')});
  const next = f.settings.select(current.id, 3, current.models[0]!.id);
  assert.notEqual(next.credentialRef, original.credentialRef); assert.notEqual(next.endpoint, original.endpoint);
  assert.equal(await f.settings.acquire(next), 'synthetic-cn-key'); assert.equal(await f.settings.acquire(original), KEY);
  assert.throws(() => f.settings.assertBinding({...original, endpoint: next.endpoint}), {code: 'VIDEO_BINDING_INVALID'});
  const wan = configuration('wan');
  await f.settings.put({action: 'save', expectedRevision: 3, configuration: wan, secret: replace()});
  const oldWan = f.settings.select(wan.id, 1, wan.models[0]!.id);
  await f.settings.put({action: 'save', expectedRevision: 4, configuration: {...wan, workspaceId: 'workspace-b'}, secret: keep});
  assert.equal(await f.settings.acquire(oldWan), KEY);
  assert.throws(() => f.settings.select(wan.id, 2, wan.models[0]!.id), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
});

test('compatible saved checks are revision fenced and an address edit cannot reuse another origin key', async t => {
  const f = await fixture(t), current = configuration('compatible');
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace()});
  const original = f.settings.select(current.id, 1, current.models[0]!.id);
  assert.deepEqual(await f.settings.acquireCompatible(current.id, 1), {endpoint: current.baseUrl, value: KEY});
  const moved = {...current, baseUrl: 'https://other.example.com/api'};
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: moved, secret: keep});
  await assert.rejects(f.settings.acquireCompatible(current.id, 1), {code: 'VIDEO_SETTINGS_CONFLICT'});
  await assert.rejects(f.settings.acquireCompatible(current.id, 2), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.equal(await f.settings.acquire(original), KEY);
});

test('custom deletion removes every historical credential and catalog while leaving only a non-reusable UUID tombstone', async t => {
  const secretCodec = codec(), f = await fixture(t, {secretCodec, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}});
  const custom = configuration('compatible'), other = configuration();
  await f.settings.put({action: 'batch', expectedRevision: 0, operations: [{action: 'save', configuration: custom, secret: replace()}, {action: 'save', configuration: other, secret: replace()}]});
  const old = f.settings.select(custom.id, 1, custom.models[0]!.id), otherBinding = f.settings.select(other.id, 1, other.models[0]!.id);
  const moved = {...custom, baseUrl: 'https://moved.example.com/api'};
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: moved, secret: replace('synthetic-persistent-custom', 'persistent')});
  const current = f.settings.select(custom.id, 2, custom.models[0]!.id), decryptions = secretCodec.decryptions;
  await f.settings.put({action: 'delete', expectedRevision: 2, connectionId: custom.id});
  const envelope = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(envelope.deletedConnectionIds, [custom.id]);
  for (const entries of [envelope.connections, envelope.history, envelope.credentials]) assert.ok(entries.every((entry: {configuration?: {id: string}; connectionId?: string}) => entry.configuration?.id !== custom.id && entry.connectionId !== custom.id));
  assert.doesNotMatch(JSON.stringify(envelope), /api\.example\.com|moved\.example\.com|sora-2|synthetic-persistent-custom/);
  for (const binding of [old, current]) {assert.throws(() => f.settings.assertBinding(binding), {code: 'VIDEO_SETTINGS_DELETED'}); await assert.rejects(f.settings.acquire(binding), {code: 'VIDEO_SETTINGS_DELETED'});}
  await assert.rejects(f.settings.acquireCompatible(custom.id, 2), {code: 'VIDEO_SETTINGS_DELETED'});
  assert.equal(secretCodec.decryptions, decryptions); assert.equal(await f.settings.acquire(otherBinding), KEY);
  await assert.rejects(f.settings.put({action: 'save', expectedRevision: 3, configuration: custom, secret: replace()}), {code: 'VIDEO_SETTINGS_DELETED'});
  await f.settings.close();
  const reopened = await createVideoSettingsV2(f.options); t.after(() => reopened.close());
  await assert.rejects(reopened.acquire(old), {code: 'VIDEO_SETTINGS_DELETED'});
});

test('persistent keys keep the v1 codec envelope and historical tasks survive disable and restart without decrypting on get', async t => {
  const secretCodec = codec(), f = await fixture(t, {secretCodec, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}), current = configuration();
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace(KEY, 'persistent')});
  const old = f.settings.select(current.id, 1, current.models[0]!.id);
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: {...current, enabled: false}, secret: keep});
  assert.throws(() => f.settings.select(current.id, 2, current.models[0]!.id), {code: 'VIDEO_SETTINGS_DISABLED'});
  assert.equal(await f.settings.acquire(old), KEY);
  const disk = await readFile(f.file, 'utf8'); assert.doesNotMatch(disk, /synthetic-g1-video-key/);
  const plaintext = JSON.parse(secretCodec.decrypt(JSON.parse(disk).credentials[0].encrypted));
  assert.equal(plaintext.version, 1); assert.equal(plaintext.namespace, VIDEO_SECRET_NAMESPACE); assert.equal(plaintext.credentialRef, old.credentialRef);
  await f.settings.close(); const decryptions = secretCodec.decryptions;
  const reopened = await createVideoSettingsV2(f.options); t.after(() => reopened.close()); await reopened.get();
  assert.equal(secretCodec.decryptions, decryptions); assert.equal(await reopened.acquire(old), KEY);
});

test('session restart and explicit key removal never heal a frozen reference using a newly saved key', async t => {
  const f = await fixture(t), current = configuration();
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace()});
  const old = f.settings.select(current.id, 1, current.models[0]!.id);
  await f.settings.close(); const reopened = await createVideoSettingsV2(f.options); t.after(() => reopened.close());
  await assert.rejects(reopened.acquire(old), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  await reopened.put({action: 'save', expectedRevision: 1, configuration: current, secret: replace()});
  const next = reopened.select(current.id, 2, current.models[0]!.id);
  assert.notEqual(next.credentialRef, old.credentialRef); await assert.rejects(reopened.acquire(old), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  await reopened.put({action: 'save', expectedRevision: 2, configuration: current, secret: {action: 'remove'}});
  await assert.rejects(reopened.acquire(next), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.equal('restoreCredential' in reopened, false);
});

test('one CAS fences synchronous selection and competing writers, and failed batches never partially publish', async t => {
  const f = await fixture(t), current = configuration(), custom = configuration('compatible');
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace()});
  const binding = f.settings.select(current.id, 1, current.models[0]!.id), before = await readFile(f.file, 'utf8');
  await assert.rejects(f.settings.put({action: 'batch', expectedRevision: 1, operations: [{action: 'save', configuration: custom, secret: replace()}, {action: 'delete', connectionId: current.id}]}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  assert.equal(await readFile(f.file, 'utf8'), before); assert.equal(await f.settings.acquire(binding), KEY);
  const writes = Array.from({length: 4}, () => f.settings.put({action: 'save', expectedRevision: 1, configuration: current, secret: keep}));
  assert.throws(() => f.settings.select(current.id, 1, current.models[0]!.id), {code: 'VIDEO_SETTINGS_CONFLICT'});
  const results = await Promise.allSettled(writes); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'VIDEO_SETTINGS_CONFLICT');
  const snapshot = await f.settings.get(); snapshot.connections[0]!.configuration.enabled = false;
  assert.equal((await f.settings.get()).connections[0]!.configuration.enabled, true);
});

test('a successful batch persists exactly once and a rejected later operation cannot publish its earlier session key', async t => {
  const f = await fixture(t), real = createVideoSettingsV2File(f.options); let saves = 0;
  const persistence = {load: real.load, async save(value: Parameters<typeof real.save>[0], signal?: AbortSignal) {saves++; await real.save(value, signal);}};
  const settings = await createVideoSettingsV2({...f.options, persistence}); t.after(() => settings.close());
  const builtin = configuration(), custom = configuration('compatible');
  await settings.put({action: 'batch', expectedRevision: 0, operations: [builtin, custom].map(configuration => ({action: 'save', configuration, secret: replace()}))});
  assert.equal(saves, 1); const selected = settings.select(custom.id, 1, custom.models[0]!.id), before = await readFile(f.file, 'utf8');
  await assert.rejects(settings.put({action: 'batch', expectedRevision: 1, operations: [{action: 'save', configuration: custom, secret: replace('synthetic-uncommitted-key')}, {action: 'delete', connectionId: builtin.id}]}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  assert.equal(saves, 1); assert.equal(await readFile(f.file, 'utf8'), before); assert.equal(await settings.acquire(selected), KEY);
});

test('a queued deletion fences late decryption for both frozen acquisition and saved compatible checks', async t => {
  for (const check of [false, true]) {
    const base = codec(), started = deferred<void>(), delayed = deferred<string>(); let delay = false;
    const secretCodec = {encrypt: base.encrypt, decrypt: (value: string) => {if (!delay) return base.decrypt(value); started.resolve(); return delayed.promise;}};
    const f = await fixture(t, {secretCodec, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}), custom = configuration('compatible');
    await f.settings.put({action: 'save', expectedRevision: 0, configuration: custom, secret: replace(KEY, 'persistent')});
    const binding = f.settings.select(custom.id, 1, custom.models[0]!.id), disk = JSON.parse(await readFile(f.file, 'utf8')), plaintext = base.decrypt(disk.credentials[0].encrypted); delay = true;
    const acquired = check ? f.settings.acquireCompatible(custom.id, 1) : f.settings.acquire(binding);
    const rejected = assert.rejects(acquired, {code: 'VIDEO_SETTINGS_CONFLICT'}); await started.promise;
    const deletion = f.settings.put({action: 'delete', expectedRevision: 1, connectionId: custom.id}); delayed.resolve(plaintext);
    await rejected; await deletion; await assert.rejects(f.settings.acquire(binding), {code: 'VIDEO_SETTINGS_DELETED'});
  }
});

test('closed and aborted engines reject late encryption without publishing session or durable changes', async t => {
  for (const stop of ['close', 'abort'] as const) {
    const started = deferred<void>(), delayed = deferred<string>(), controller = new AbortController();
    const secretCodec = {encrypt: () => {started.resolve(); return delayed.promise;}, decrypt: () => ''};
    const f = await fixture(t, {secretCodec, signal: controller.signal, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}), current = configuration();
    const write = f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace(KEY, 'persistent')});
    const rejected = assert.rejects(write, {code: 'VIDEO_SETTINGS_CLOSED'}); await started.promise;
    if (stop === 'close') await f.settings.close(); else controller.abort();
    await rejected; delayed.resolve(Buffer.from('synthetic-late-cipher').toString('base64')); await new Promise(resolve => setImmediate(resolve));
    const reopened = await createVideoSettingsV2({directory: f.options.directory, privateRoot: f.root}); t.after(() => reopened.close());
    assert.equal((await reopened.get()).revision, 0);
  }
});

test('closing a pending decryption rejects late plaintext while preserving the durable key', async t => {
  const base = codec(), started = deferred<void>(), delayed = deferred<string>(); let delay = false;
  const secretCodec = {encrypt: base.encrypt, decrypt: (value: string) => {if (!delay) return base.decrypt(value); started.resolve(); return delayed.promise;}};
  const f = await fixture(t, {secretCodec, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}), current = configuration();
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace(KEY, 'persistent')});
  const binding = f.settings.select(current.id, 1, current.models[0]!.id), before = await readFile(f.file, 'utf8'); delay = true;
  const acquired = f.settings.acquire(binding), rejected = assert.rejects(acquired, {code: 'VIDEO_SETTINGS_CLOSED'}); await started.promise;
  await f.settings.close(); await rejected; delayed.resolve(KEY); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('a failed atomic save preserves the old state; an ambiguous committed save faults instead of retrying or returning keys', async t => {
  for (const committed of [false, true]) {
    const f = await fixture(t), real = createVideoSettingsV2File(f.options); let fail = false, saves = 0;
    const persistence = {load: real.load, async save(value: Parameters<typeof real.save>[0], signal?: AbortSignal) {saves++; if (!fail || committed) await real.save(value, signal); if (fail) throw Error('Synthetic unavailable save');}};
    const settings = await createVideoSettingsV2({...f.options, persistence}); t.after(() => settings.close()); const current = configuration();
    await settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace()}); const original = settings.select(current.id, 1, current.models[0]!.id); fail = true;
    await assert.rejects(settings.put({action: 'save', expectedRevision: 1, configuration: current, secret: replace('synthetic-new-key')}), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});
    assert.equal(saves, 2);
    if (committed) {await assert.rejects(settings.get(), {code: 'VIDEO_SETTINGS_SAVE_FAILED'}); await assert.rejects(settings.acquire(original), {code: 'VIDEO_SETTINGS_SAVE_FAILED'});}
    else {assert.equal((await settings.get()).revision, 1); assert.equal(await settings.acquire(original), KEY);}
  }
});

test('video v2 keeps update, model, connection, credential and envelope budgets and rejects duplicate batch identities', async t => {
  const f = await fixture(t), current = configuration();
  await assert.rejects(f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace(), padding: 'x'.repeat(VIDEO_SETTINGS_LIMITS.updateBytes)}), {code: 'VIDEO_SETTINGS_VALIDATION'});
  assert.equal(videoSettingsUpdateV2Schema.safeParse({action: 'batch', expectedRevision: 0, operations: Array.from({length: 2}, () => ({action: 'save', configuration: current, secret: keep}))}).success, false);
  assert.equal(videoConnectionConfigurationV2Schema.safeParse({...current, models: Array.from({length: VIDEO_SETTINGS_LIMITS.models + 1}, () => ({...current.models[0]!, id: randomUUID()}))}).success, false);
  for (const value of [{...emptyVideoSettingsV2Envelope(), connections: Array(VIDEO_SETTINGS_LIMITS.connections + 1).fill({})}, {...emptyVideoSettingsV2Envelope(), credentials: Array(VIDEO_SETTINGS_LIMITS.credentials + 1).fill({})}, {...emptyVideoSettingsV2Envelope(), deletedConnectionIds: Array.from({length: 110000}, () => randomUUID())}]) assert.throws(() => validateVideoSettingsV2Envelope(value), {code: 'VIDEO_SETTINGS_CORRUPT'});
  assert.equal((await f.settings.get()).revision, 0);
});

test('copied encrypted credentials cannot be replayed under another frozen reference', async t => {
  const secretCodec = codec(), f = await fixture(t, {secretCodec, storage: {persistentAvailable: true, sessionScope: 'server', reasonCode: null}}), current = configuration();
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: current, secret: replace(KEY, 'persistent')});
  const binding = f.settings.select(current.id, 1, current.models[0]!.id), envelope = JSON.parse(await readFile(f.file, 'utf8')); await f.settings.close();
  const plaintext = JSON.parse(secretCodec.decrypt(envelope.credentials[0].encrypted)); plaintext.credentialRef = randomUUID();
  envelope.credentials[0].encrypted = secretCodec.encrypt(JSON.stringify(plaintext)); await writeFile(f.file, JSON.stringify(envelope), {mode: 0o600});
  const reopened = await createVideoSettingsV2(f.options); t.after(() => reopened.close()); await assert.rejects(reopened.acquire(binding), {code: 'VIDEO_SETTINGS_CORRUPT'});
});
