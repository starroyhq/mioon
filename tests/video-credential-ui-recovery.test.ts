import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import type {DesktopSafeStorage} from '../apps/desktop/src/secret-store.ts';
import {createVideoSettingsSession, newVideoConnection, restorableVideoCredentials, videoSettingsDirty} from '../apps/web/src/video-settings.ts';
import type {VideoSettingsClient, VideoSettingsState} from '../apps/web/src/video-settings.ts';

const FIRST_KEY = 'synthetic-ui-original-video-key';
const SECOND_KEY = 'synthetic-ui-replacement-video-key';
const RESTORED_KEY = 'synthetic-ui-restored-video-key';
const replace = (value: string) => ({action: 'replace' as const, storage: 'session' as const, value});

async function fixture(t: {after(callback: () => unknown): void}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-credential-ui-')));
  const options = {directory: path.join(root, 'video-settings'), privateRoot: root};
  let settings = await createVideoSettings(options);
  const configuration = newVideoConnection('minimax');
  configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: replace(FIRST_KEY)});
  const binding = settings.select(configuration.id, 1, configuration.models[0]!.id);
  const states: VideoSettingsState[] = [], actions: string[] = [];
  const client: VideoSettingsClient = {
    read: () => settings.get(),
    write: input => {actions.push(input.action); return settings.put(input);},
  };
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  return {
    root, configuration, binding, states, actions, client,
    get settings() {return settings;},
    async reopen() {await settings.close(); settings = await createVideoSettings(options);},
    ui(clientOverride = client) {return createVideoSettingsSession({client: clientOverride, onChange: state => states.push(state)});},
  };
}

test('the current missing session credential can resume its exact binding after restart through the UI', async t => {
  const f = await fixture(t);
  await f.reopen();
  const ui = f.ui(); t.after(() => ui.dispose());
  await ui.load();
  const saved = ui.getState().snapshot!.connections[0]!;
  assert.equal(saved.secret.configured, false);
  assert.deepEqual(restorableVideoCredentials(saved).map(value => value.ref), [f.binding.credentialRef]);
  assert.equal(ui.restoreCredential(f.binding.credentialRef), true);
  assert.equal(ui.getState().storage, '', 'A missing key requires an explicit storage choice');
  assert.equal(ui.setStorage('session'), true);
  assert.equal(await ui.save(RESTORED_KEY), true);
  assert.equal(await f.settings.acquire(f.binding), RESTORED_KEY);
  const after = ui.getState();
  assert.equal(after.snapshot!.connections[0]!.credentialRef, f.binding.credentialRef);
  assert.equal(after.snapshot!.connections[0]!.revision, 1);
  assert.equal(after.snapshot!.connections[0]!.credentials.length, 1);
  assert.equal(after.storage, 'session');
  assert.equal(after.phase, 'saved');
  assert.equal(after.notice, 'video.providers.credentialRestored');
  assert.equal(videoSettingsDirty(after), false);
  assert.deepEqual(f.actions, ['restoreCredential']);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-ui-(?:original|restored)-video-key/);
  assert.doesNotMatch(await readFile(path.join(f.root, 'video-settings/settings.json'), 'utf8'), /synthetic-ui-(?:original|restored)-video-key/);
});

test('an unavailable OS vault permits explicit session restoration of the same current persistent reference', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-vault-ui-'))), key = randomBytes(32);
  let available = true, encryptions = 0, decryptions = 0;
  const encrypt = (value: string) => {encryptions++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);};
  const decrypt = (value: Buffer) => {decryptions++; const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();};
  const safeStorage: DesktopSafeStorage = {
    isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: encrypt, decryptString: decrypt, isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async value => encrypt(value), decryptStringAsync: async value => ({result: decrypt(value), shouldReEncrypt: false}),
  };
  const main = createDesktopVideoSecretCodec({safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform: 'darwin'});
  let storage = await main.storage();
  const settings = await createVideoSettings({directory: path.join(root, 'video-settings'), privateRoot: root, storage: () => storage,
    secretCodec: {...main, refreshStorage: async () => {storage = await main.storage();}}});
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  const configuration = newVideoConnection('minimax'); configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: {...replace(FIRST_KEY), storage: 'persistent'}});
  const binding = settings.select(configuration.id, 1, configuration.models[0]!.id);
  const availableCalls = {encryptions, decryptions};
  available = false;
  await assert.rejects(settings.acquire(binding), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  const states: VideoSettingsState[] = [], actions: string[] = [];
  const ui = createVideoSettingsSession({client: {read: () => settings.get(), write: input => {actions.push(input.action); return settings.put(input);}}, onChange: state => states.push(state)});
  t.after(() => ui.dispose()); await ui.load();
  const snapshot = ui.getState().snapshot!, saved = snapshot.connections[0]!;
  assert.equal(snapshot.storage.persistentAvailable, false);
  assert.deepEqual(saved.secret, {configured: true, storage: 'persistent'});
  assert.deepEqual(restorableVideoCredentials(saved), [], 'Missing availability metadata must not imply that the OS vault is unavailable');
  assert.deepEqual(restorableVideoCredentials(saved, snapshot.storage).map(value => value.ref), [binding.credentialRef]);
  assert.equal(ui.restoreCredential(binding.credentialRef), true);
  assert.equal(ui.getState().storage, '', 'Unavailable persistent storage cannot silently become session storage');
  assert.equal(ui.setStorage('persistent'), false);
  assert.equal(await ui.save(), false, 'The existing encrypted key must not be reused implicitly');
  assert.equal(ui.setStorage('session'), true);
  assert.equal(await ui.save(), false, 'Explicit session storage still requires re-entering the bound key');
  assert.deepEqual(actions, []);
  assert.equal(await ui.save(RESTORED_KEY), true);
  assert.equal(await settings.acquire(binding), RESTORED_KEY);
  const restored = ui.getState().snapshot!.connections[0]!;
  assert.equal(restored.credentialRef, binding.credentialRef);
  assert.equal(restored.revision, 1);
  assert.equal(restored.credentials.length, 1);
  assert.deepEqual(restored.secret, {configured: true, storage: 'session'});
  assert.deepEqual(actions, ['restoreCredential']);
  assert.deepEqual({encryptions, decryptions}, availableCalls, 'Neither native crypto nor an automatic plaintext fallback runs after the vault becomes unavailable');
  assert.doesNotMatch(JSON.stringify(states), /synthetic-ui-(?:original|restored)-video-key/);
  assert.doesNotMatch(await readFile(path.join(root, 'video-settings/settings.json'), 'utf8'), /synthetic-ui-(?:original|restored)-video-key/);
});

test('restoring a historical credential preserves connection and model drafts until a separate save', async t => {
  const f = await fixture(t);
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: f.configuration, secret: replace(SECOND_KEY)});
  const currentBinding = f.settings.select(f.configuration.id, 2, f.configuration.models[0]!.id);
  assert.notEqual(currentBinding.credentialRef, f.binding.credentialRef, 'Normal replacement creates a new binding');
  const ui = f.ui(); t.after(() => ui.dispose());
  await ui.load();
  const changedModels = f.configuration.models.map(model => ({...model, name: 'Draft model label', modelId: 'future-minimax-model'}));
  assert.equal(ui.update({name: 'Unsaved connection name', models: changedModels}), true);
  assert.equal(ui.restoreCredential(f.binding.credentialRef), true);
  assert.equal(await ui.save(RESTORED_KEY), true);
  const restored = ui.getState();
  assert.equal(restored.draft!.name, 'Unsaved connection name');
  assert.deepEqual(restored.draft!.models, changedModels);
  assert.deepEqual(restored.baseline, f.configuration);
  assert.equal(restored.phase, 'ready');
  assert.equal(restored.notice, 'video.providers.credentialRestoredDraft');
  assert.equal(restored.restoreRef, null);
  assert.equal(restored.storage, 'session');
  assert.equal(videoSettingsDirty(restored), true);
  assert.equal((await f.settings.get()).connections[0]!.configuration.name, f.configuration.name);
  assert.equal(await f.settings.acquire(f.binding), RESTORED_KEY);
  assert.equal(await f.settings.acquire(currentBinding), SECOND_KEY);
  assert.equal(await ui.save(), true);
  const accepted = ui.getState();
  assert.equal(accepted.draft!.name, 'Unsaved connection name');
  assert.deepEqual(accepted.draft!.models, changedModels);
  assert.equal(videoSettingsDirty(accepted), false);
  assert.equal(accepted.notice, 'video.providers.saved');
  assert.equal(accepted.snapshot!.connections[0]!.credentialRef, currentBinding.credentialRef);
  assert.deepEqual(f.actions, ['restoreCredential', 'save']);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-ui-(?:original|replacement|restored)-video-key/);
});

test('credential restoration only accepts eligible references from the selected connection', async t => {
  const f = await fixture(t), second = newVideoConnection('minimax');
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: second, secret: replace(SECOND_KEY)});
  const ui = f.ui(); t.after(() => ui.dispose());
  await ui.load();
  const snapshot = ui.getState().snapshot!;
  assert.deepEqual(restorableVideoCredentials(undefined), []);
  assert.deepEqual(restorableVideoCredentials(snapshot.connections[0]), []);
  assert.equal(ui.restoreCredential(f.binding.credentialRef), false, 'A configured current reference is not a restoration target');
  assert.equal(ui.restoreCredential(snapshot.connections[1]!.credentialRef), false, 'A reference from another connection is rejected');
  assert.equal(ui.restoreCredential(randomUUID()), false);
  assert.equal(ui.restoreCredential(null), true);
  assert.equal(ui.getState().restoreRef, null);
  assert.equal(ui.getState().storage, 'session');
  assert.deepEqual(f.actions, []);
});

for (const code of ['VIDEO_SETTINGS_CONFLICT', 'NETWORK']) test('credential restoration '+code+' preserves drafts and never repeats the write', async t => {
  const f = await fixture(t); await f.reopen();
  let writes = 0;
  const ui = f.ui({...f.client, write: async () => {writes++; throw Object.assign(new Error('Synthetic failure'), {code});}});
  t.after(() => ui.dispose());
  await ui.load(); ui.update({name: 'Retained recovery draft'});
  assert.equal(ui.restoreCredential(f.binding.credentialRef), true); ui.setStorage('session');
  assert.equal(await ui.save(RESTORED_KEY), false);
  assert.equal(writes, 1);
  assert.equal(ui.getState().draft!.name, 'Retained recovery draft');
  assert.equal(ui.getState().phase, 'review');
  assert.equal(ui.getState().recovery, code === 'NETWORK' ? 'unknown' : 'conflict');
  assert.equal(await ui.save(RESTORED_KEY), false);
  assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-ui-restored-video-key/);
});
