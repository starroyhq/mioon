import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createConfiguredVideoProvider} from '../packages/business/src/video/runtime.ts';
import {createDesktopVideoSecretCodec} from '../apps/desktop/src/video-secret-store.ts';
import desktopIdentity from '../apps/desktop/identity.ts';
import type {DesktopSafeStorage} from '../apps/desktop/src/secret-store.ts';
import {createVideoSettingsSession, newVideoConnection, videoSettingsDirty} from '../apps/web/src/video-settings.ts';
import type {VideoSettingsClient, VideoSettingsState} from '../apps/web/src/video-settings.ts';

const FIRST_KEY = 'synthetic-ui-original-video-key';
const SECOND_KEY = 'synthetic-ui-replacement-video-key';
const replace = (value: string) => ({action: 'replace' as const, storage: 'session' as const, value});

async function fixture(t: {after(callback: () => unknown): void}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-credential-ui-')));
  const options = {directory: path.join(root, 'video-settings'), privateRoot: root};
  let settings = await createVideoSettingsV2(options);
  const configuration = newVideoConnection('minimax'); configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: replace(FIRST_KEY)});
  const binding = settings.select(configuration.id, 1, configuration.models[0]!.id);
  const states: VideoSettingsState[] = [], actions: string[] = [];
  const client: VideoSettingsClient = {read: () => settings.get(), write: input => {actions.push(input.action); return settings.put(input);}};
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  return {
    root, configuration, binding, states, actions, client,
    get settings() {return settings;},
    async reopen() {await settings.close(); settings = await createVideoSettingsV2(options);},
    ui(clientOverride = client) {return createVideoSettingsSession({client: clientOverride, onChange: state => states.push(state)});},
  };
}

test('a session restart cannot restore or rebind a frozen task through the v2 UI and performs zero generation HTTP', async t => {
  const f = await fixture(t); await f.reopen(); let requests = 0;
  const provider = createConfiguredVideoProvider({root: f.root, binding: f.binding, now: () => Date.UTC(2026, 9, 23), acquireCredential: () => f.settings.acquire(f.binding), fetchImpl: async () => {requests++; throw Error('Unexpected generation HTTP');}});
  const ui = f.ui(); t.after(() => ui.dispose()); await ui.load(); const saved = ui.getState().snapshot!.connections[0]!;
  assert.equal(saved.secret.configured, false); assert.equal('restoreCredential' in ui, false); assert.equal('restoreRef' in ui.getState(), false);
  assert.equal('credentials' in saved, false); assert.equal('credentialRef' in saved, false);
  await assert.rejects(provider.poll('existing-task', {}), {code: 'VIDEO_CREDENTIAL_UNAVAILABLE'});
  const snapshot = {providerId: 'minimax', model: f.binding.model.modelId, prompt: 'Synthetic sunset', aspectRatio: '16:9', duration: 4, parameters: {resolution: '2K'}, referenceAssets: []};
  await assert.rejects(provider.submit(snapshot, {requestId: 'frozen-request'}), {code: 'VIDEO_CREDENTIAL_UNAVAILABLE'});
  assert.equal(requests, 0); assert.equal(ui.setStorage('session'), true); assert.equal(await ui.save(FIRST_KEY), true);
  const current = f.settings.select(f.configuration.id, 2, f.configuration.models[0]!.id);
  assert.notEqual(current.credentialRef, f.binding.credentialRef); assert.equal(await f.settings.acquire(current), FIRST_KEY);
  await assert.rejects(f.settings.acquire(f.binding), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  await assert.rejects(provider.poll('existing-task', {}), {code: 'VIDEO_CREDENTIAL_UNAVAILABLE'}); assert.equal(requests, 0);
  assert.deepEqual(f.actions, ['save']); assert.equal(videoSettingsDirty(ui.getState()), false);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-ui-(?:original|replacement)-video-key/);
  assert.doesNotMatch(await readFile(path.join(f.root, 'video-settings/settings.json'), 'utf8'), /synthetic-ui-(?:original|replacement)-video-key/);
});

test('an unavailable OS vault never falls back silently or restores the old persistent reference', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-vault-ui-'))), key = randomBytes(32);
  let available = true, encryptions = 0, decryptions = 0;
  const encrypt = (value: string) => {encryptions++; const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);};
  const decrypt = (value: Buffer) => {decryptions++; const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();};
  const safeStorage: DesktopSafeStorage = {isEncryptionAvailable: () => available, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: encrypt, decryptString: decrypt, isAsyncEncryptionAvailable: async () => available, encryptStringAsync: async value => encrypt(value), decryptStringAsync: async value => {
    if (!available) throw Error('Synthetic vault became unavailable');
    return {result: decrypt(value), shouldReEncrypt: false};
  }};
  const main = createDesktopVideoSecretCodec({safeStorage, appId: desktopIdentity.identityForChannel('development').appId, platform: 'darwin'});
  let storage = await main.storage();
  const settings = await createVideoSettingsV2({directory: path.join(root, 'video-settings'), privateRoot: root, storage: () => storage, secretCodec: {...main, refreshStorage: async () => {storage = await main.storage();}}});
  t.after(async () => {await settings.close(); await rm(root, {recursive: true, force: true});});
  const configuration = newVideoConnection('minimax'); configuration.enabled = true;
  await settings.put({action: 'save', expectedRevision: 0, configuration, secret: {...replace(FIRST_KEY), storage: 'persistent'}});
  const binding = settings.select(configuration.id, 1, configuration.models[0]!.id), availableCalls = {encryptions, decryptions}; available = false;
  await assert.rejects(settings.acquire(binding), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  const states: VideoSettingsState[] = [], actions: string[] = [];
  const ui = createVideoSettingsSession({client: {read: () => settings.get(), write: input => {actions.push(input.action); return settings.put(input);}}, onChange: state => states.push(state)});
  t.after(() => ui.dispose()); await ui.load();
  assert.equal(ui.getState().snapshot!.storage.persistentAvailable, false); assert.equal(ui.setStorage('persistent'), false);
  assert.equal(await ui.save(SECOND_KEY), false); assert.deepEqual(actions, []);
  assert.equal(ui.setStorage('session'), true); assert.equal(await ui.save(), true, 'A keep-only save is a no-op, not a plaintext fallback');
  assert.deepEqual(ui.getState().snapshot!.connections[0]!.secret, {configured: true, storage: 'persistent'});
  assert.equal(ui.getState().snapshot!.revision, 1); await assert.rejects(settings.acquire(binding), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  ui.setStorage('session'); assert.equal(await ui.save(SECOND_KEY), true);
  const current = settings.select(configuration.id, 2, configuration.models[0]!.id);
  assert.notEqual(current.credentialRef, binding.credentialRef); assert.equal(await settings.acquire(current), SECOND_KEY);
  await assert.rejects(settings.acquire(binding), {code: 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE'});
  assert.deepEqual({encryptions, decryptions}, availableCalls); assert.deepEqual(actions, ['save', 'save']);
  assert.doesNotMatch(JSON.stringify(states), /synthetic-ui-(?:original|replacement)-video-key/);
});

test('ordinary model edits keep the selected credential and cannot rewrite historical bindings', async t => {
  const f = await fixture(t);
  await f.settings.put({action: 'save', expectedRevision: 1, configuration: f.configuration, secret: replace(SECOND_KEY)});
  const currentBinding = f.settings.select(f.configuration.id, 2, f.configuration.models[0]!.id), ui = f.ui(); t.after(() => ui.dispose()); await ui.load();
  const changedModels = f.configuration.models.map(model => ({...model, name: 'Draft model label'}));
  assert.equal(ui.update({models: changedModels}), true); assert.equal(await ui.save(SECOND_KEY), true);
  const after = ui.getState(), acceptedBinding = f.settings.select(f.configuration.id, 3, f.configuration.models[0]!.id);
  assert.equal(acceptedBinding.credentialRef, currentBinding.credentialRef); assert.equal(videoSettingsDirty(after), false);
  assert.deepEqual(after.draft!.models, changedModels); assert.equal(after.notice, 'video.providers.saved');
  assert.equal(await f.settings.acquire(f.binding), FIRST_KEY); assert.equal(await f.settings.acquire(currentBinding), SECOND_KEY);
  assert.deepEqual(f.actions, ['save']); assert.equal('restoreCredential' in ui, false);
});

test('multiple custom services retain isolated keys and UI selection never exposes historical refs', async t => {
  const f = await fixture(t), a = newVideoConnection('compatible'), b = newVideoConnection('compatible');
  a.baseUrl = 'https://one.example.com/v1'; b.baseUrl = 'https://two.example.com/v1';
  for (const [index, configuration] of [a, b].entries()) await f.settings.put({action: 'save', expectedRevision: index + 1, configuration, secret: replace(index ? SECOND_KEY : FIRST_KEY)});
  const ui = f.ui(); t.after(() => ui.dispose()); await ui.load(); assert.equal(ui.select(a.id), true); assert.equal(await ui.save(SECOND_KEY), true);
  assert.equal(await f.settings.acquireCompatible(a.id, 2).then(value => value.value), SECOND_KEY);
  assert.equal(await f.settings.acquireCompatible(b.id, 1).then(value => value.value), SECOND_KEY);
  assert.equal('restoreCredential' in ui, false);
  assert.ok(ui.getState().snapshot!.connections.every(view => !Object.hasOwn(view, 'credentialRef') && !Object.hasOwn(view, 'credentials')));
  assert.deepEqual(f.actions, ['save']);
});

for (const code of ['VIDEO_SETTINGS_CONFLICT', 'NETWORK']) test('replacement '+code+' preserves non-secret drafts and never repeats the write', async t => {
  const f = await fixture(t); await f.reopen(); let writes = 0;
  const ui = f.ui({...f.client, write: async () => {writes++; throw Object.assign(new Error('Synthetic raw failure'), {code});}}); t.after(() => ui.dispose()); await ui.load();
  const models = f.configuration.models.map(model => ({...model, name: 'Retained recovery draft'})); ui.update({models}); ui.setStorage('session');
  assert.equal(await ui.save(SECOND_KEY), false); assert.equal(writes, 1); assert.deepEqual(ui.getState().draft!.models, models);
  assert.equal(ui.getState().phase, 'review'); assert.equal(ui.getState().recovery, code === 'NETWORK' ? 'unknown' : 'conflict');
  assert.equal(await ui.save(SECOND_KEY), false); assert.equal(writes, 1); assert.doesNotMatch(JSON.stringify(f.states), /synthetic-ui-replacement-video-key|Synthetic raw failure/);
});
