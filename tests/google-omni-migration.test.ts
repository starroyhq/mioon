import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVideoSettingsV2, validateVideoSettingsV2Envelope} from '../packages/business/src/video/settings-v2.ts';
import {parseVideoBinding} from '../packages/contracts/src/video-providers.ts';
import {createTestSecretCodec, testSecretStorage} from './helpers/secret-codec.ts';

// Frozen output from v0.2.0 (94a142cb231176e8d08d088fa3b414a05f389705):
// createVideoSettingsV2 + defaultVideoModels + select. Both keys and the AES
// codec are synthetic, using the same format as helpers/secret-codec.ts.
const source = new URL('./fixtures/google-omni-v020/', import.meta.url);
const sourceBytes = await readFile(new URL('settings.json', source));
const original = validateVideoSettingsV2Envelope(JSON.parse(sourceBytes.toString('utf8')));
const oldBinding = parseVideoBinding(JSON.parse(await readFile(new URL('veo-task-binding.json', source), 'utf8')));
const oldGoogle = original.connections.find(entry => entry.configuration.id === oldBinding.connectionId)!;
const oldCompatible = original.connections.find(entry => entry.configuration.providerId === 'compatible')!;
const originalKey = 'mioon-go-synthetic-gemini-key';
const keep = {action: 'keep'} as const;

async function fixture(t: test.TestContext, bytes = sourceBytes) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-google-migration-')));
  const directory = path.join(root, 'video-settings'), file = path.join(directory, 'settings.json');
  await mkdir(directory, {mode: 0o700});
  await writeFile(file, bytes, {mode: 0o600});
  const codec = createTestSecretCodec();
  let encryptions = 0, decryptions = 0;
  const options = {directory, privateRoot: root, storage: testSecretStorage, secretCodec: {
    ...codec,
    encrypt(value: string) {encryptions++; return codec.encrypt(value);},
    decrypt(value: string) {decryptions++; return codec.decrypt(value);},
  }};
  let settings = await createVideoSettingsV2(options);
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  return {file, options, get settings() {return settings;}, counts: () => ({encryptions, decryptions}), async reopen() {
    await settings.close(); settings = await createVideoSettingsV2(options); return settings;
  }};
}

test('actual 0.2.0 Google settings project Omni without changing identity, revisions, ciphertext or the file on reads and unchanged saves', async t => {
  const f = await fixture(t), info = await stat(f.file);
  const snapshot = await f.settings.get(), google = snapshot.connections.find(view => view.configuration.id === oldBinding.connectionId)!;
  assert.equal(snapshot.revision, original.revision);
  assert.equal(google.revision, oldGoogle.revision);
  assert.deepEqual(google.secret, {configured: true, storage: 'persistent'});
  assert.deepEqual(google.configuration, {...oldGoogle.configuration, models: [{
    ...oldBinding.model, name: 'gemini-omni-1.2-flash', modelId: 'gemini-omni-1.2-flash', templateId: 'gemini-omni-v1',
  }]});
  assert.deepEqual(f.settings.list(), snapshot.connections);
  const selected = f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision, oldBinding.model.id);
  assert.deepEqual(selected, {...oldBinding, model: google.configuration.models[0]});
  f.settings.assertBinding(oldBinding);
  f.settings.assertBinding(selected);
  assert.deepEqual(f.counts(), {encryptions: 0, decryptions: 0});
  assert.equal(await f.settings.acquire(oldBinding), originalKey);
  assert.equal(await f.settings.acquire(selected), originalKey);
  const compatible = snapshot.connections.find(view => view.configuration.id === oldCompatible.configuration.id)!;
  assert.deepEqual(compatible.configuration, oldCompatible.configuration);
  assert.equal(compatible.configuration.models[0]!.modelId, 'sora-2');
  assert.equal(await f.settings.acquire(f.settings.select(compatible.configuration.id, compatible.revision, compatible.configuration.models[0]!.id)), 'mioon-go-synthetic-gateway-key');
  for (const configuration of [google.configuration, oldGoogle.configuration]) {
    const saved = await f.settings.put({action: 'save', expectedRevision: original.revision, configuration, secret: keep});
    assert.deepEqual(saved, snapshot);
    assert.deepEqual(await readFile(f.file), sourceBytes);
    const actual = await stat(f.file);
    assert.equal(actual.ino, info.ino);
    assert.equal(actual.mtimeMs, info.mtimeMs);
  }
  assert.equal(f.counts().encryptions, 0);
  await f.reopen();
  assert.deepEqual(await f.settings.get(), snapshot);
  assert.equal(await f.settings.acquire(oldBinding), originalKey);
  assert.equal(await f.settings.acquire(selected), originalKey);
  assert.deepEqual(await readFile(f.file), sourceBytes);
});

test('an explicit later change retains original Veo and derived Omni bindings across publication and reopen', async t => {
  const f = await fixture(t), initial = await f.settings.get(), google = initial.connections.find(view => view.configuration.id === oldBinding.connectionId)!;
  const omniBinding = f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision, oldBinding.model.id);
  const saved = await f.settings.put({action: 'save', expectedRevision: initial.revision, configuration: {...google.configuration, enabled: false}, secret: keep});
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal(saved.connections.find(view => view.configuration.id === oldBinding.connectionId)!.revision, oldBinding.configurationRevision + 1);
  const persisted = validateVideoSettingsV2Envelope(JSON.parse(await readFile(f.file, 'utf8')));
  assert.deepEqual(persisted.history.slice(0, original.history.length), original.history);
  assert.deepEqual(persisted.credentials, original.credentials);
  assert.equal(persisted.connections.find(entry => entry.configuration.id === oldBinding.connectionId)!.configuration.models[0]!.modelId, 'gemini-omni-1.2-flash');
  for (let pass = 0; pass < 2; pass++) {
    f.settings.assertBinding(oldBinding);
    f.settings.assertBinding(omniBinding);
    assert.equal(await f.settings.acquire(oldBinding), originalKey);
    assert.equal(await f.settings.acquire(omniBinding), originalKey);
    assert.throws(() => f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision, oldBinding.model.id), {code: 'VIDEO_SETTINGS_CONFLICT'});
    assert.throws(() => f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision + 1, oldBinding.model.id), {code: 'VIDEO_SETTINGS_DISABLED'});
    if (!pass) await f.reopen();
  }
  assert.equal(f.counts().encryptions, 0);
});

test('rotating the shared Google key retains old credentials and offers the same result-only replacement to Veo and Omni tasks', async t => {
  const f = await fixture(t), snapshot = await f.settings.get(), google = snapshot.connections.find(view => view.configuration.id === oldBinding.connectionId)!;
  const omniBinding = f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision, oldBinding.model.id);
  const replacementKey = 'mioon-go-synthetic-replacement-key';
  const saved = await f.settings.put({action: 'save', expectedRevision: snapshot.revision, configuration: google.configuration, secret: {action: 'replace', storage: 'persistent', value: replacementKey}});
  const current = saved.connections.find(view => view.configuration.id === oldBinding.connectionId)!;
  const selected = f.settings.select(current.configuration.id, current.revision, oldBinding.model.id);
  assert.notEqual(selected.credentialRef, oldBinding.credentialRef);
  const replacement = {credentialRef: selected.credentialRef, connectionRevision: current.revision};
  for (let pass = 0; pass < 2; pass++) {
    for (const frozen of [oldBinding, omniBinding]) {
      assert.equal(await f.settings.acquire(frozen), originalKey);
      assert.deepEqual(f.settings.replacementForResult(frozen), replacement);
      assert.equal(await f.settings.acquireResultCredential(frozen, replacement), replacementKey);
    }
    assert.equal(await f.settings.acquire(selected), replacementKey);
    if (!pass) await f.reopen();
  }
});

test('the projected history permits only the exact derived Omni binding and never another recipient or edited model capability', async t => {
  const f = await fixture(t), derived = f.settings.select(oldBinding.connectionId, oldBinding.configurationRevision, oldBinding.model.id);
  for (const invalid of [
    {...derived, credentialRef: randomUUID()},
    {...derived, endpoint: 'https://attacker.example/v1beta'},
    {...derived, outputHosts: ['attacker.example']},
    {...derived, configurationRevision: derived.configurationRevision + 1},
    {...derived, model: {...derived.model, name: 'Another model'}},
    {...derived, model: {...derived.model, modelId: 'gemini-omni-1.1-flash'}},
    {...derived, model: {...derived.model, durationResolutionMap: [{duration: [3], resolution: ['720p']}] }},
    {...oldBinding, model: {...oldBinding.model, modelId: 'gemini-omni-1.2-flash'}},
  ]) {
    assert.throws(() => f.settings.assertBinding(invalid), {code: 'VIDEO_BINDING_INVALID'});
    await assert.rejects(f.settings.acquire(invalid), {code: 'VIDEO_BINDING_INVALID'});
    assert.throws(() => f.settings.replacementForResult(invalid), {code: 'VIDEO_BINDING_INVALID'});
  }
  assert.deepEqual(f.counts(), {encryptions: 0, decryptions: 0});
  assert.deepEqual(await readFile(f.file), sourceBytes);
});

test('unavailable old in-memory Google keys still migrate only metadata and reject acquisition', async t => {
  const envelope = structuredClone(original);
  envelope.credentials.find(credential => credential.ref === oldBinding.credentialRef)!.encrypted = null;
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n'), f = await fixture(t, bytes);
  const snapshot = await f.settings.get(), google = snapshot.connections.find(view => view.configuration.id === oldBinding.connectionId)!;
  assert.equal(google.configuration.models[0]!.modelId, 'gemini-omni-1.2-flash');
  assert.equal(google.revision, oldGoogle.revision);
  assert.deepEqual(google.secret, {configured: false, storage: 'none'});
  await assert.rejects(f.settings.acquire(oldBinding), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.throws(() => f.settings.select(google.configuration.id, google.revision, oldBinding.model.id), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  assert.deepEqual(f.counts(), {encryptions: 0, decryptions: 0});
  assert.deepEqual(await readFile(f.file), bytes);
});

test('Google migration cannot repair corrupt, mismatched or unknown-version source settings', async t => {
  for (const envelope of [
    {...original, version: 3},
    {...original, history: []},
    {...original, credentials: original.credentials.map(credential => credential.ref === oldBinding.credentialRef
      ? {...credential, endpoint: 'https://attacker.example/v1beta'} : credential)},
    {...original, connections: original.connections.map(entry => entry.configuration.id === oldBinding.connectionId
      ? {...entry, configuration: {...entry.configuration, outputHosts: ['attacker.example']}} : entry)},
  ]) {
    const bytes = Buffer.from(JSON.stringify(envelope) + '\n'), f = await fixture(t, bytes);
    await assert.rejects(f.settings.get(), {code: 'VIDEO_SETTINGS_CORRUPT'});
    await assert.rejects(f.settings.put({action: 'save', expectedRevision: original.revision, configuration: oldGoogle.configuration, secret: keep}), {code: 'VIDEO_SETTINGS_CORRUPT'});
    assert.deepEqual(f.counts(), {encryptions: 0, decryptions: 0});
    assert.deepEqual(await readFile(f.file), bytes);
  }
});
