import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoSettingsClient, createVideoSettingsSession, newVideoConnection, safeVideoSettings, videoSettingsCanSave, videoSettingsDirty, videoModelPairMap } from '../apps/web/src/video-settings.ts';
import type { VideoSettingsClient } from '../apps/web/src/video-settings.ts';
import { VIDEO_TEMPLATES, VIDEO_CATALOG_PROVIDER_IDS, defaultVideoModels, videoConnectionConfigurationSchema } from '../packages/contracts/src/video-providers.ts';
import type { VideoSettingsSnapshot, VideoSettingsUpdate } from '../packages/contracts/src/video-providers.ts';
import { validateCatalogs, catalogs } from '../packages/i18n/src/index.ts';

const initial = (): VideoSettingsSnapshot => ({ revision: 0, connections: [], storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' } });
function fixture(overrides: Partial<VideoSettingsClient> = {}) {
  let snapshot = initial(); const writes: VideoSettingsUpdate[] = [], states: unknown[] = []; let reads = 0;
  const client: VideoSettingsClient = {
    read: async () => { reads++; return overrides.read ? overrides.read() : structuredClone(snapshot); },
    write: async input => {
      writes.push(input); if (overrides.write) return overrides.write(input);
      assert.equal(input.action, 'save'); if (input.action !== 'save') throw Error('Unexpected action');
      snapshot = { ...snapshot, revision: input.expectedRevision + 1, connections: [{ configuration: structuredClone(input.configuration), revision: 1, credentialRef: '00000000-0000-4000-8000-000000000001', secret: input.secret.action === 'replace' ? { configured: true, storage: input.secret.storage } : { configured: false, storage: 'none' }, credentials: [] }] };
      return structuredClone(snapshot);
    },
  };
  const session = createVideoSettingsSession({ client, onChange: state => states.push(state) });
  return { session, writes, states, get reads() { return reads; } };
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('settings exclude Runway from new choices and default drafts without removing stored history', async () => {
  assert.deepEqual(VIDEO_CATALOG_PROVIDER_IDS, ['ark', 'veo', 'minimax', 'vidu', 'kling', 'wan', 'compatible']);
  const current = newVideoConnection('ark');
  const retired = { ...newVideoConnection('ark'), providerId: 'runway' as const, name: 'Previous Runway connection', region: 'global', models: defaultVideoModels('runway') };
  const row = (configuration: typeof current) => ({ configuration, revision: 1, credentialRef: null, secret: { configured: false, storage: 'none' as const }, credentials: [] });
  const snapshot: VideoSettingsSnapshot = { ...initial(), revision: 2, connections: [row(retired), row(current)] };
  const f = fixture({ read: async () => structuredClone(snapshot) });
  await f.session.load();
  assert.equal(f.session.getState().draft?.id, current.id);
  assert.equal(f.session.getState().snapshot?.connections.length, 2);
  assert.equal(f.session.select(retired.id), false); assert.equal(f.session.add('runway'), false);
  assert.throws(() => newVideoConnection('runway'), { code: 'VIDEO_SETTINGS_VALIDATION' });
  assert.equal(f.writes.length, 0);
});

test('video settings transport uses private no-store GET/PUT and rejects secret echoes', async () => {
  const calls: RequestInit[] = [];
  const client = createVideoSettingsClient({ fetchImpl: (async (url, options) => { assert.equal(url, '/api/video-providers/settings'); calls.push(options!); return Response.json({ ok: true, data: initial() }); }) as typeof fetch });
  await client.read();
  await client.write({ action: 'save', expectedRevision: 0, configuration: newVideoConnection('wan'), secret: { action: 'replace', value: 'synthetic-video-key', storage: 'session' } });
  assert.deepEqual(calls.map(call => [call.method, call.cache, call.credentials]), [['GET', 'no-store', 'same-origin'], ['PUT', 'no-store', 'same-origin']]);
  assert.throws(() => safeVideoSettings({ ...initial(), apiKey: 'synthetic-video-key' }));
  const connection = { configuration: newVideoConnection('wan'), revision: 1, credentialRef: null, secret: { configured: true, storage: 'session', value: 'synthetic-video-key' }, credentials: [] };
  assert.throws(() => safeVideoSettings({ ...initial(), connections: [connection] }));
});

test('video credentials require explicit storage and never enter session state', async () => {
  const f = fixture(); await f.session.load(); f.session.add('wan');
  assert.equal(videoSettingsDirty(f.session.getState()), true);
  assert.equal(await f.session.save('synthetic-video-key'), false); assert.equal(f.writes.length, 0);
  assert.equal(f.session.setStorage('persistent'), false); f.session.setStorage('session');
  assert.equal(await f.session.save('synthetic-video-key'), true);
  assert.equal(f.writes.length, 1); assert.equal(f.session.getState().snapshot?.connections[0]?.secret.configured, true);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-video-key/);
  assert.equal(videoSettingsDirty(f.session.getState()), false);
  assert.equal(await f.session.save('synthetic-key-replacement-only'), true);
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1]?.action, 'save');
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-key-replacement-only/);
  f.session.dispose();
});

test('dirty connection switching, hidden saves and template mismatches fail closed', async () => {
  const f = fixture(); await f.session.load(); f.session.add('wan');
  const draft = f.session.getState().draft!;
  assert.equal(f.session.add('kling'), false); assert.equal(f.session.getState().draft?.id, draft.id);
  f.session.setVisible(false); assert.equal(f.session.update({ name: 'hidden' }), false); assert.equal(await f.session.save(), false);
  f.session.setVisible(true); f.session.update({ models: draft.models.map(model => ({ ...model, durationResolutionMap: [{ duration: [99], resolution: ['unsupported'] }] })) });
  assert.equal(await f.session.save(), false); assert.equal(f.writes.length, 0);
  f.session.dispose();
});

test('CAS conflicts and ambiguous saves reconcile once, retain drafts and never retry', async () => {
  for (const code of ['VIDEO_SETTINGS_CONFLICT', 'NETWORK']) {
    const f = fixture({ write: async () => { throw Object.assign(Error('never-reflect-raw-error'), { code }); } });
    await f.session.load(); f.session.add('wan'); f.session.update({ name: 'Retained draft' }); f.session.setStorage('session');
    assert.equal(await f.session.save('synthetic-video-key'), false);
    const state = f.session.getState(); assert.equal(state.phase, 'review'); assert.equal(state.draft?.name, 'Retained draft');
    assert.equal(state.recovery, code === 'NETWORK' ? 'unknown' : 'conflict'); assert.equal(videoSettingsCanSave(state), false);
    assert.equal(f.reads, 2); assert.equal(f.writes.length, 1); assert.equal(await f.session.save('no-repeat'), false);
    assert.doesNotMatch(JSON.stringify(f.states), /synthetic-video-key|never-reflect/);
    assert.equal(f.session.acknowledge(), true); assert.equal(videoSettingsCanSave(f.session.getState()), true); f.session.dispose();
  }
});

test('duplicate writes and disposed late responses cannot publish', async () => {
  const held = deferred<VideoSettingsSnapshot>(); const f = fixture({ write: () => held.promise });
  await f.session.load(); f.session.add('wan'); const saving = f.session.save();
  assert.equal(await f.session.save(), false); assert.equal(f.session.update({ enabled: true }), false);
  const count = f.states.length; f.session.dispose(); held.resolve({ ...initial(), revision: 1 });
  assert.equal(await saving, false); assert.equal(f.states.length, count); assert.equal(f.writes.length, 1);
});

test('video settings messages have four complete catalogs with consistent parameters', () => {
  assert.deepEqual(validateCatalogs(), []);
  assert.ok(Object.keys(catalogs).filter(key => key.startsWith('video.providers.')).length > 50);
});


test('editing every supported Kling and Wan pair keeps bounded configuration groups', () => {
  for (const provider of ['kling', 'wan'] as const) {
    const configuration = newVideoConnection(provider);
    for (const model of configuration.models) {
      const template = VIDEO_TEMPLATES.find(item => item.id === model.templateId)!;
      const all = template.durations.flatMap(duration => template.resolutions.map(resolution => `${duration}:${resolution}`)).join('\n');
      model.durationResolutionMap = videoModelPairMap(all);
      assert.ok(model.durationResolutionMap.length <= 3);
    }
    assert.equal(videoConnectionConfigurationSchema.safeParse(configuration).success, true);
  }
});
