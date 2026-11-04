import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createVideoSettingsClient, createVideoSettingsSession, newVideoConnection, videoSettingsDirty} from '../apps/web/src/video-settings.ts';
import type {VideoSettingsClient, VideoSettingsState} from '../apps/web/src/video-settings.ts';
import type {VideoSettingsSnapshotV2, VideoSettingsUpdateV2} from '../packages/contracts/src/generation-video-settings.ts';

async function fixture(t: {after(fn: () => unknown): void}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-video-v2-client-'))), options = {directory: path.join(root, 'video-settings'), privateRoot: root};
  const settings = await createVideoSettingsV2(options), actions: string[] = [], states: VideoSettingsState[] = []; let reads = 0;
  const client: VideoSettingsClient = {read: async () => {reads++; return settings.get();}, write: input => {actions.push(input.action); return settings.put(input);}};
  const session = createVideoSettingsSession({client, onChange: state => states.push(state)});
  t.after(async () => {session.dispose(); await settings.close(); await rm(root, {recursive: true, force: true});});
  return {root, options, settings, session, client, actions, states, get reads() {return reads;}};
}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

test('real v2 controller accepts no-op saves, reselects built-ins and keeps the stable connection identity', async t => {
  const f = await fixture(t); await f.session.load(); assert.equal(f.session.add('minimax'), true); assert.equal(await f.session.save(), true);
  const id = f.session.getState().draft!.id, file = path.join(f.options.directory, 'settings.json'), before = await readFile(file, 'utf8');
  assert.equal(f.session.add('minimax'), true); assert.equal(f.session.getState().draft!.id, id); assert.equal(videoSettingsDirty(f.session.getState()), false);
  assert.equal(await f.session.save(), true); assert.equal(f.session.getState().snapshot!.revision, 1); assert.equal(await readFile(file, 'utf8'), before);
  f.session.setStorage('session'); assert.equal(await f.session.save('synthetic-v2-ui-key'), true); assert.equal(await f.session.save('synthetic-v2-ui-key'), true);
  assert.equal(f.session.getState().snapshot!.revision, 2); assert.equal(f.session.getState().snapshot!.connections.length, 1);
  assert.equal(f.session.getState().notice, 'video.providers.saved'); assert.doesNotMatch(JSON.stringify(f.states), /synthetic-v2-ui-key/);
});

test('real v2 deletion removes a saved custom service, refuses built-in deletion and never retries a deleted identity', async t => {
  const f = await fixture(t); await f.session.load(); f.session.add('minimax'); await f.session.save(); assert.equal(await f.session.remove(), false);
  f.session.add('compatible'); f.session.update({baseUrl: 'https://Custom.Example.com/api/'}); f.session.setStorage('session'); assert.equal(await f.session.save('synthetic-delete-key'), true);
  const customId = f.session.getState().draft!.id; assert.equal(f.session.getState().draft!.baseUrl, 'https://custom.example.com/api');
  assert.equal(await f.session.remove(), true); assert.equal(f.session.getState().snapshot!.connections.length, 1); assert.equal(f.session.getState().draft!.providerId, 'minimax');
  assert.equal(f.session.getState().notice, 'video.providers.deleted'); assert.equal(f.session.select(customId), false);
  assert.deepEqual(f.actions, ['save', 'save', 'delete']);
  const disk = await readFile(path.join(f.options.directory, 'settings.json'), 'utf8'); assert.doesNotMatch(disk, /custom\.example\.com|synthetic-delete-key/);
});

test('legacy reset notices survive controller reads and selection until the first explicit successful save', async t => {
  const f = await fixture(t); await f.settings.close();
  const legacy = await createVideoSettings(f.options), configuration = {...newVideoConnection('minimax'), archived: false};
  await legacy.put({action: 'save', expectedRevision: 0, configuration, secret: {action: 'keep'}}); await legacy.close();
  const settings = await createVideoSettingsV2(f.options); t.after(() => settings.close());
  const session = createVideoSettingsSession({client: {read: () => settings.get(), write: input => settings.put(input)}}); t.after(() => session.dispose());
  await session.load(); assert.equal(session.getState().snapshot!.notice, 'VIDEO_SETTINGS_V1_RESET'); session.add('minimax');
  assert.equal(session.getState().snapshot!.notice, 'VIDEO_SETTINGS_V1_RESET'); assert.equal(await session.save(), true); assert.equal(session.getState().snapshot!.notice, null);
});

test('capacity rejection retains drafts without treating a known no-effect save as ambiguous', async t => {
  const f = await fixture(t); const session = createVideoSettingsSession({client: {...f.client, write: async () => {throw Object.assign(Error('untrusted path and key'), {code: 'VIDEO_SETTINGS_CAPACITY', status: 507});}}}); t.after(() => session.dispose());
  await session.load(); session.add('minimax'); session.update({enabled: true}); session.setStorage('session');
  assert.equal(await session.save('synthetic-capacity-key'), false); assert.equal(session.getState().draft!.enabled, true);
  assert.equal(session.getState().phase, 'error'); assert.equal(session.getState().notice, 'video.providers.capacity'); assert.equal(session.getState().recovery, null); assert.equal(f.reads, 1);
});

test('an ambiguous accepted deletion reconciles once and cannot replay its write', async t => {
  const f = await fixture(t), custom = newVideoConnection('compatible'); custom.baseUrl = 'https://ambiguous.example.com/v1';
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: custom, secret: {action: 'keep'}}); let writes = 0;
  const session = createVideoSettingsSession({client: {...f.client, write: async input => {writes++; await f.settings.put(input); throw Object.assign(Error('Unknown transport outcome'), {code: 'NETWORK'});}}}); t.after(() => session.dispose()); await session.load();
  assert.equal(await session.remove(), false); assert.equal(writes, 1); assert.equal(f.reads, 2); assert.equal(session.getState().phase, 'review');
  assert.deepEqual(session.getState().snapshot!.connections, []); assert.equal(session.getState().draft!.id, custom.id); assert.equal(await session.remove(), false); assert.equal(writes, 1);
  assert.equal(session.useLatest(), true); assert.equal(session.getState().draft, null);
});

test('a disposed controller ignores late deletion responses', async t => {
  const f = await fixture(t), custom = newVideoConnection('compatible'); custom.baseUrl = 'https://late.example.com/v1';
  await f.settings.put({action: 'save', expectedRevision: 0, configuration: custom, secret: {action: 'keep'}});
  const pending = deferred<VideoSettingsSnapshotV2>(), states: VideoSettingsState[] = [];
  const session = createVideoSettingsSession({client: {...f.client, write: () => pending.promise}, onChange: state => states.push(state)}); await session.load();
  const deleting = session.remove(), count = states.length; session.dispose();
  pending.resolve({...(await f.settings.get()), revision: 2, connections: []}); assert.equal(await deleting, false); assert.equal(states.length, count);
});

test('v2 transport rejects legacy restoration and uppercase saved check identities before sending HTTP', async () => {
  let requests = 0;
  const client = createVideoSettingsClient({fetchImpl: async () => {requests++; throw Error('Must reject before HTTP');}});
  const invalid = {action: 'restoreCredential', expectedRevision: 0, connectionId: 'abcdef12-0000-4000-8000-000000000001'};
  await assert.rejects(client.write(invalid as unknown as VideoSettingsUpdateV2), {code: 'VIDEO_SETTINGS_VALIDATION'});
  await assert.rejects(client.check!({source: 'saved', connectionId: 'ABCDEF12-0000-4000-8000-000000000001', configurationRevision: 1}), {code: 'VIDEO_SETTINGS_VALIDATION'}); assert.equal(requests, 0);
});
