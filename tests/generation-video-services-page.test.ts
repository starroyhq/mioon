import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVideoSettingsV2} from '../packages/business/src/video/settings-v2.ts';
import {VIDEO_BUILTIN_PROVIDER_IDS, videoConnectionConfigurationV2Schema} from '../packages/contracts/src/generation-video-settings.ts';
import type {VideoSettingsSnapshotV2, VideoSettingsUpdateV2} from '../packages/contracts/src/generation-video-settings.ts';
import {VIDEO_SETTINGS_LIMITS} from '../packages/contracts/src/video-providers.ts';
import type {VideoSettingsClient} from '../apps/web/src/video-settings.ts';
import {newVideoConnection, videoSettingsEndpoint, videoSettingsRequestEndpoint} from '../apps/web/src/video-settings.ts';
import {createGenerationVideoServicesSession, generationVideoAvailable, generationVideoDirty} from '../apps/web/src/generation-video-services.ts';
import type {GenerationVideoState} from '../apps/web/src/generation-video-services.ts';

function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function fixture(t: {after(fn: () => unknown): void}, override: Partial<VideoSettingsClient> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-generation-video-page-')));
  const settings = await createVideoSettingsV2({directory: path.join(root, 'video-settings'), privateRoot: root});
  const states: GenerationVideoState[] = [], writes: VideoSettingsUpdateV2[] = [], keys = new Map<string, string>(); let reads = 0, clears = 0;
  const client: VideoSettingsClient = {read: async () => {reads++; return override.read ? override.read() : settings.get();}, write: async input => {assert.ok([...keys.values()].every(value => value === ''), 'All key DOMs are cleared before transport begins'); writes.push(structuredClone(input)); return override.write ? override.write(input) : settings.put(input);}};
  const session = createGenerationVideoServicesSession({client, onChange: state => states.push(state)});
  const clear = (key?: string) => {clears++; for (const owner of keys.keys()) if (!key || owner === key) keys.set(owner, ''); session.keysCleared(key);};
  const type = (key: string, value: string) => {keys.set(key, value); session.keyEdited(key, Boolean(value));};
  const prepare = () => session.prepareSave(key => keys.get(key) ?? '', clear);
  t.after(async () => {session.dispose(); await settings.close(); await rm(root, {recursive: true, force: true});});
  await session.load(); return {session, settings, states, writes, keys, client, clear, type, prepare, get reads() {return reads;}, get clears() {return clears;}};
}
function custom(f: Awaited<ReturnType<typeof fixture>>, name: string) {const key = f.session.add()!; f.session.update(key, {name, baseUrl: 'https://api.example.com/v1', enabled: true}); f.session.setStorage(key, 'session'); return key;}

test('the request display alone adds the implemented compatible create route while the binding endpoint stays the base URL', () => {
  const draft = newVideoConnection('compatible'); draft.baseUrl = 'https://api.example.com/v1';
  assert.equal(videoSettingsRequestEndpoint(draft), 'https://api.example.com/v1/videos'); assert.equal(videoSettingsEndpoint(draft), 'https://api.example.com/v1');
  draft.baseUrl = 'https://API.Example.com/v2/'; assert.equal(videoSettingsRequestEndpoint(draft), 'https://api.example.com/v2/videos');
  for (const baseUrl of ['', 'http://api.example.com/v1', 'https://user:pass@api.example.com/v1', 'https://api.example.com:8443/v1', 'https://api.example.com/v1?key=hidden']) {draft.baseUrl = baseUrl; assert.equal(videoSettingsRequestEndpoint(draft), '');}
  for (const provider of VIDEO_BUILTIN_PROVIDER_IDS) {const builtin = newVideoConnection(provider); assert.equal(videoSettingsRequestEndpoint(builtin), videoSettingsEndpoint(builtin));}
  assert.equal(videoSettingsRequestEndpoint(null), '');
});

test('six stable built-in drafts and clean preparation never create settings records', async t => {
  const f = await fixture(t), state = f.session.getState();
  assert.deepEqual(state.drafts.map(draft => draft.key), VIDEO_BUILTIN_PROVIDER_IDS.map(provider => `video:${provider}`));
  assert.equal(state.snapshot!.revision, 0); assert.deepEqual(state.snapshot!.connections, []); assert.equal(generationVideoDirty(state), false);
  assert.equal(f.prepare(), null); assert.equal(f.clears, 1); assert.equal(f.writes.length, 0);
  f.session.update('video:wan', {workspaceId: 'draft-workspace'}); const id = f.session.getState().drafts.find(draft => draft.key === 'video:wan')!.configuration.id;
  assert.equal(f.session.discard(), true); assert.equal(f.session.getState().drafts.find(draft => draft.key === 'video:wan')!.configuration.workspaceId, '');
  assert.equal(f.session.getState().drafts.find(draft => draft.key === 'video:wan')!.configuration.id, id);
});

test('selected listed video models are appended enabled without changing existing models or writing before save', async t => {
  const f = await fixture(t);
  const key = 'video:ark';
  const template = f.session.getState().drafts.find(draft => draft.key === key)!.configuration.models[0]!;
  assert.equal(f.session.update(key, {models: [
    {...template, enabled: false},
    {...template, id: crypto.randomUUID(), modelId: 'doubao-seedance-2-0-existing', inputModes: ['text']},
  ]}), true);
  const before = f.session.getState();
  const existing = before.drafts.find(draft => draft.key === key)!.configuration.models;
  const added = 'doubao-seedance-2-0-synthetic';
  assert.equal(f.session.stageModels(key, before.version, [existing[0]!.modelId, added, added]), true);
  const after = f.session.getState();
  const configuration = after.drafts.find(draft => draft.key === key)!.configuration;
  assert.deepEqual(configuration.models.slice(0, -1), existing);
  assert.equal(configuration.models.length, existing.length + 1);
  const entry = configuration.models.at(-1)!;
  assert.deepEqual([entry.modelId, entry.name, entry.enabled, entry.inputModes], [added, added, true, ['text', 'image', 'frames']]);
  assert.equal(videoConnectionConfigurationV2Schema.safeParse(configuration).success, true);
  assert.deepEqual(after.drafts.filter(draft => draft.key !== key), before.drafts.filter(draft => draft.key !== key));
  assert.equal(generationVideoDirty(after), true);
  assert.deepEqual((await f.settings.get()).connections, []);
  assert.equal(f.writes.length, 0);
  const ticket = f.prepare()!;
  assert.equal(await ticket.run(), 'saved');
  ticket.dispose();
  assert.deepEqual((await f.settings.get()).connections[0]!.configuration.models, configuration.models);
});

test('listed video selections reject stale, unsupported, invalid and over-capacity batches without changing the draft', async t => {
  const f = await fixture(t), key = 'video:veo';
  const before = f.session.getState();
  assert.equal(f.session.stageModels('video:kling', before.version, ['synthetic-kling']), false);
  assert.equal(f.session.stageModels(key, before.version, ['veo-synthetic', 'models/invalid']), false);
  assert.deepEqual(f.session.getState(), before);
  const template = before.drafts.find(draft => draft.key === key)!.configuration.models[0]!;
  const almostFull = Array.from({length: VIDEO_SETTINGS_LIMITS.models - 1}, (_, index) => ({
    ...template, id: crypto.randomUUID(), modelId: `veo-synthetic-${index}`,
  }));
  assert.equal(f.session.update(key, {models: almostFull}), true);
  const changed = f.session.getState();
  assert.equal(f.session.stageModels(key, before.version, ['veo-stale']), false);
  assert.equal(f.session.stageModels(key, changed.version, ['veo-one', 'veo-two']), false);
  assert.deepEqual(f.session.getState(), changed);
  assert.equal(f.session.stageModels(key, changed.version, ['veo-one']), true);
  assert.equal(f.session.getState().drafts.find(draft => draft.key === key)!.configuration.models.length, VIDEO_SETTINGS_LIMITS.models);
  assert.equal(f.writes.length, 0);
});

test('two independent service keys become one CAS batch, with no key in draft events or accepted state', async t => {
  const f = await fixture(t), a = custom(f, 'A'), b = custom(f, 'B');
  f.type(a, 'synthetic-video-page-A'); f.type(b, 'synthetic-video-page-B');
  const draftIds = f.session.getState().drafts.filter(draft => !draft.configuration.providerId.includes('compatible')).map(draft => draft.configuration.id);
  const ticket = f.prepare()!; assert.ok([...f.keys.values()].every(value => value === '')); assert.equal(f.writes.length, 0);
  f.clear(); assert.equal(await ticket.run(), 'saved'); assert.equal(await ticket.run(), 'blocked'); ticket.dispose();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.action, 'batch'); assert.equal(f.writes[0]!.expectedRevision, 0);
  const update = f.writes[0]!; if (update.action !== 'batch') assert.fail(); assert.equal(update.operations.length, 2);
  assert.deepEqual(update.operations.map(operation => operation.action === 'save' && [operation.configuration.name, operation.secret.action === 'replace' && operation.secret.value]), [['A', 'synthetic-video-page-A'], ['B', 'synthetic-video-page-B']]);
  assert.equal(f.session.getState().snapshot!.revision, 1); assert.equal(generationVideoDirty(f.session.getState()), false);
  assert.deepEqual(f.session.getState().drafts.filter(draft => draft.configuration.providerId !== 'compatible').map(draft => draft.configuration.id), draftIds);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-video-page-[AB]/);
});

test('one invalid draft clears every captured key synchronously and sends no part of a batch', async t => {
  const f = await fixture(t), a = custom(f, 'A'), b = custom(f, 'B'); f.type(a, 'synthetic-valid-key'); f.type(b, 'synthetic-invalid-key');
  f.session.update(b, {baseUrl: 'http://private.invalid'});
  assert.throws(f.prepare, {code: 'VIDEO_SETTINGS_VALIDATION'}); assert.ok([...f.keys.values()].every(value => value === '')); assert.equal(f.writes.length, 0);
  assert.equal(generationVideoDirty(f.session.getState()), true); assert.equal(f.session.getState().drafts.find(draft => draft.key === a)!.secretAction, 'replace');
  f.session.update(b, {baseUrl: 'https://api.example.com/v1'}); assert.throws(f.prepare, {code: 'VIDEO_SETTINGS_VALIDATION'}); assert.equal(f.writes.length, 0);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-valid-key|synthetic-invalid-key/);
});

test('batch payload budget is rejected locally rather than split into separate writes', async t => {
  const f = await fixture(t);
  for (const draft of f.session.getState().drafts) {
    const base = draft.configuration.models[0]!;
    f.session.update(draft.key, {models: Array.from({length: 64}, () => ({...structuredClone(base), id: crypto.randomUUID(), name: '名'.repeat(120)}))});
  }
  assert.ok(f.session.getState().drafts.every(draft => videoConnectionConfigurationV2Schema.safeParse(draft.configuration).success));
  assert.throws(f.prepare, {code: 'VIDEO_SETTINGS_VALIDATION'}); assert.equal(f.writes.length, 0); assert.equal(f.clears, 1);
});

test('unknown accepted writes read once but cannot prove a credential, replay, or clear dirty drafts', async t => {
  let settings: Awaited<ReturnType<typeof createVideoSettingsV2>>;
  const f = await fixture(t, {write: async input => {await settings.put(input); throw Object.assign(Error('untrusted raw secret'), {code: 'NETWORK'});}}); settings = f.settings;
  const a = custom(f, 'A'); f.type(a, 'synthetic-unknown-key');
  const ticket = f.prepare()!; assert.equal(await ticket.run(), 'unknown'); ticket.dispose();
  assert.equal(f.reads, 2); assert.equal(f.writes.length, 1); assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().recovery, 'unknown'); assert.equal(generationVideoDirty(f.session.getState()), true);
  assert.equal(f.session.getState().snapshot!.connections.length, 1); assert.throws(f.prepare); assert.equal(f.writes.length, 1);
  assert.equal(f.session.useLatest(), true); assert.equal(generationVideoDirty(f.session.getState()), false); assert.equal(f.prepare(), null);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-unknown-key|untrusted raw/);
});

for (const code of ['VIDEO_SETTINGS_CONFLICT', 'VIDEO_SETTINGS_DELETED']) test(`${code} reconciles once and deliberate review still requires re-entering cleared keys`, async t => {
  const f = await fixture(t, {write: async () => {throw Object.assign(Error('untrusted'), {code});}}), a = custom(f, 'A'); f.type(a, 'synthetic-conflict-key');
  const ticket = f.prepare()!; assert.equal(await ticket.run(), 'blocked'); ticket.dispose(); assert.equal(f.reads, 2); assert.equal(f.writes.length, 1);
  assert.equal(f.session.acknowledge(), true); assert.throws(f.prepare); assert.equal(f.writes.length, 1);
});

test('unreadable unknown readback remains blocked with exactly one write and one recovery GET', async t => {
  let recovering = false;
  const f = await fixture(t, {write: async () => {recovering = true; throw Error('Lost ACK');}, read: async () => {if (recovering) throw Error('Read unavailable'); return {revision: 0, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null};}});
  const a = custom(f, 'A'), ticket = f.prepare()!; assert.equal(await ticket.run(), 'unknown'); ticket.dispose();
  assert.equal(f.reads, 2); assert.equal(f.writes.length, 1); assert.equal(f.session.getState().phase, 'blocked'); assert.equal(f.session.useLatest(), false); assert.throws(f.prepare); assert.equal(f.session.getState().drafts.find(draft => draft.key === a)!.configuration.name, 'A');
});

test('capacity and validation failures preserve drafts and are never retried or read back', async t => {
  for (const code of ['VIDEO_SETTINGS_CAPACITY', 'VIDEO_SETTINGS_VALIDATION', 'VIDEO_SETTINGS_STORAGE_UNAVAILABLE']) {
    const f = await fixture(t, {write: async () => {throw Object.assign(Error('untrusted key and path'), {code});}}); custom(f, 'A');
    const ticket = f.prepare()!; assert.equal(await ticket.run(), 'error'); ticket.dispose(); assert.equal(f.reads, 1); assert.equal(f.writes.length, 1); assert.equal(generationVideoDirty(f.session.getState()), true); assert.equal(f.session.getState().recovery, null);
  }
});

test('deletion is staged; it clears only its key and is persisted with the remaining dirty service in one batch', async t => {
  const f = await fixture(t), a = custom(f, 'A'), b = custom(f, 'B');
  const first = f.prepare()!; assert.equal(await first.run(), 'saved'); first.dispose();
  f.session.setStorage(a, 'session'); f.session.setStorage(b, 'session'); f.type(a, 'synthetic-delete-A'); f.type(b, 'synthetic-keep-B'); f.clear(a); assert.equal(f.session.stageDelete(a), true);
  assert.equal(f.keys.get(a), ''); assert.equal(f.keys.get(b), 'synthetic-keep-B'); assert.equal(f.writes.length, 1); assert.equal((await f.settings.get()).connections.length, 2);
  const ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  assert.equal(f.writes.length, 2); const update = f.writes[1]!; if (update.action !== 'batch') assert.fail(); assert.equal(update.operations.length, 2); assert.equal(update.operations.filter(operation => operation.action === 'delete').length, 1); assert.equal((await f.settings.get()).connections.length, 1);
  assert.equal(f.session.stageDelete('video:wan'), false); assert.equal(f.session.getState().drafts.some(draft => draft.key === a), false);
});

test('deleting a never-saved custom draft is local and creates no tombstone or network update', async t => {
  const f = await fixture(t), a = custom(f, 'A'); assert.equal(f.session.stageDelete(a), true); assert.equal(generationVideoDirty(f.session.getState()), false); assert.equal(f.prepare(), null); assert.equal(f.writes.length, 0);
});

test('replacing a custom at the full service limit removes first inside one atomic batch', async t => {
  const f = await fixture(t), customKeys = Array.from({length: 26}, (_, index) => custom(f, `Service ${index}`));
  for (const provider of VIDEO_BUILTIN_PROVIDER_IDS) f.session.update(`video:${provider}`, {enabled: false});
  assert.equal(f.session.add(), null); let ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose(); assert.equal(f.session.getState().snapshot!.connections.length, 32);
  assert.equal(f.session.stageDelete(customKeys[0]!), true); custom(f, 'Replacement'); ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  const last = f.writes.at(-1)!; if (last.action !== 'batch') assert.fail(); assert.equal(last.operations[0]!.action, 'delete'); assert.equal(f.session.getState().snapshot!.connections.length, 32); assert.equal(f.writes.length, 2);
});

test('a proven same-key no-op batch accepts an unchanged collection revision and clears only confirmed dirty markers', async t => {
  const f = await fixture(t), a = custom(f, 'A'); f.type(a, 'synthetic-noop-key'); let ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  const revision = f.session.getState().snapshot!.revision; f.type(a, 'synthetic-noop-key'); ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  assert.equal(f.session.getState().snapshot!.revision, revision); assert.equal(generationVideoDirty(f.session.getState()), false); assert.equal(f.writes.length, 2); assert.equal(f.prepare(), null);
});

test('prepared tickets are single-use, freeze request state, and release skipped credentials on dispose', async t => {
  const f = await fixture(t), a = custom(f, 'A'); f.type(a, 'synthetic-ticket-key'); const ticket = f.prepare()!;
  assert.equal(f.session.update(a, {name: 'Late mutation'}), false); const copy = f.session.getState(); copy.drafts.find(draft => draft.key === a)!.configuration.name = 'Caller mutation';
  assert.equal(await ticket.run(), 'saved'); assert.equal(f.session.getState().snapshot!.connections[0]!.configuration.name, 'A'); assert.equal(await ticket.run(), 'blocked'); ticket.dispose();
  f.type(a, 'synthetic-skipped-key'); const skipped = f.prepare()!; skipped.dispose(); assert.equal(await skipped.run(), 'blocked'); assert.equal(f.writes.length, 1); assert.equal(f.session.getState().phase, 'ready'); assert.throws(f.prepare);
});

test('hiding the page before a prepared ticket runs admits zero writes', async t => {
  const f = await fixture(t); custom(f, 'A'); const ticket = f.prepare()!; f.session.setVisible(false); assert.equal(await ticket.run(), 'blocked'); ticket.dispose(); assert.equal(f.writes.length, 0);
});

test('page hide and owner disposal reject late accepted write publication without repeating it', async t => {
  for (const action of ['hide', 'dispose']) {
    const held = deferred<VideoSettingsSnapshotV2>(), f = await fixture(t, {write: () => held.promise}); custom(f, 'A'); const ticket = f.prepare()!, running = ticket.run();
    if (action === 'hide') f.session.setVisible(false); else f.session.dispose(); const count = f.states.length;
    held.resolve({revision: 1, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null}); assert.equal(await running, 'blocked'); ticket.dispose(); assert.equal(f.states.length, count); assert.equal(f.writes.length, 1);
  }
});

test('invalid success receipts trigger readback and unknown rather than claiming a known no-effect validation error', async t => {
  const f = await fixture(t, {write: async () => ({revision: 1, connections: [], storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}, notice: null})}); custom(f, 'A');
  const ticket = f.prepare()!; assert.equal(await ticket.run(), 'unknown'); ticket.dispose(); assert.equal(f.reads, 2); assert.equal(f.writes.length, 1); assert.equal(f.session.getState().recovery, 'unknown');
});

test('configured and available facts differ; disabled models and unavailable vaults do not count a service', async t => {
  const f = await fixture(t); f.session.update('video:wan', {enabled: true, outputHosts: ['video.example.com']}); f.session.setStorage('video:wan', 'session'); f.type('video:wan', 'synthetic-readiness-key'); const ticket = f.prepare()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  const snapshot = f.session.getState().snapshot!, view = snapshot.connections[0]!;
  assert.equal(generationVideoAvailable(snapshot, view.configuration), true);
  assert.equal(generationVideoAvailable(null, view.configuration), null);
  const disabled = structuredClone(snapshot); disabled.connections[0]!.configuration.models.forEach(model => {model.enabled = false;}); assert.equal(generationVideoAvailable(disabled, view.configuration), false);
  const persistent = structuredClone(snapshot); persistent.connections[0]!.secret.storage = 'persistent'; assert.equal(generationVideoAvailable(persistent, view.configuration), false);
  const multi = structuredClone(snapshot); multi.connections[0]!.configuration.models[0]!.enabled = false; assert.equal(generationVideoAvailable(multi, view.configuration), true, 'Any eligible model may make the service ready');
});
