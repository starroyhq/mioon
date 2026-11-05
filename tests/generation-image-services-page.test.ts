import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerationImageServicesOwner, createGenerationImageServicesClient} from '../apps/web/src/generation-image-services-settings.ts';
import type {GenerationImageServicesClient, GenerationImageDomainState} from '../apps/web/src/generation-image-services-settings.ts';
import {saveGenerationServiceDomains} from '../apps/web/src/generation-services-settings.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';

const flush = async () => {for (let n = 0; n < 30; n++) await Promise.resolve();};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
const error = (code: string) => Object.assign(new Error('synthetic-error-must-not-be-reflected'), {code});
const configured = {enabled: true, baseUrl: 'https://images.example/v1', model: 'model-a'};
async function customFixture() {
  let document: unknown = null, saves = 0, reads = 0, writes = 0;
  const settings = await createCustomImageSettingsV2({persistence: {load: () => structuredClone(document), save: value => {saves++; document = structuredClone(value);}}});
  const states: GenerationImageDomainState[] = [];
  const client: GenerationImageServicesClient = {read: async () => {reads++; return settings.get();}, write: async input => {writes++;
    assert.ok(input && typeof input === 'object' && 'action' in input && input.action === 'batch');
    const {action: _action, ...batch} = input; return settings.batch(batch);
  }};
  const owner = createGenerationImageServicesOwner('custom', {client, onChange: state => states.push(state)}); await owner.load();
  const add = (name: string, value = '') => {
    const id = owner.add(name); assert.ok(id); owner.edit(id, {storage: 'session'}, configured);
    const field = {value}; owner.registerKey(id, field); if (value) owner.keyChanged(id);
    return {id, field};
  };
  return {settings, client, owner, states, add, get saves() {return saves;}, get reads() {return reads;}, get writes() {return writes;}};
}

test('two custom drafts capture separate credentials before dispatch and commit one collection CAS', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();});
  const a = f.add('A', 'synthetic-a-only'), b = f.add('B', 'synthetic-b-only');
  assert.notEqual(a.id, b.id); assert.equal(f.writes, 0);
  const ticket = f.owner.prepareSave(); assert.ok(ticket);
  assert.equal(a.field.value, ''); assert.equal(b.field.value, ''); assert.equal(f.writes, 0);
  f.owner.clearKeys(); assert.equal(await ticket.run(), 'saved'); assert.equal(await ticket.run(), 'blocked'); ticket.dispose();
  assert.equal(f.saves, 1); assert.equal(f.writes, 1); const snapshot = await f.settings.get(); assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.connections.map(item => [item.connectionId, item.configurationRevision, item.secret.storage]), [[a.id, 1, 'session'], [b.id, 1, 'session']]);
  assert.doesNotMatch(JSON.stringify(f.states), /synthetic-[ab]-only/); assert.equal(f.owner.navigation().dirty, false);
});

test('address edit and staged delete clear only their UUID; model edit preserves the other field and deletion waits for Save', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();});
  const a = f.add('A', 'synthetic-initial-a'), b = f.add('B', 'synthetic-initial-b'); const first = f.owner.prepareSave()!; await first.run(); first.dispose();
  a.field.value = 'synthetic-new-a'; f.owner.keyChanged(a.id); b.field.value = 'synthetic-new-b'; f.owner.keyChanged(b.id);
  f.owner.edit(a.id, {}, {baseUrl: 'https://other.example/v1'}); assert.equal(a.field.value, ''); assert.equal(b.field.value, 'synthetic-new-b');
  f.owner.edit(b.id, {}, {model: 'model-b'}); assert.equal(b.field.value, 'synthetic-new-b');
  assert.equal(f.owner.remove(a.id, f.owner.getState().version), true); assert.equal(b.field.value, 'synthetic-new-b'); assert.equal(f.writes, 1);
  const ticket = f.owner.prepareSave()!; assert.equal(b.field.value, ''); assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  assert.equal(f.writes, 2); assert.equal(f.saves, 2); assert.deepEqual((await f.settings.get()).connections.map(item => item.connectionId), [b.id]);
});

test('lost ACK reads once, keeps dirty/closed review and never repeats the write even when readback matches', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();});
  const item = f.add('A', 'synthetic-unknown-only'); const original = f.client.write;
  f.client.write = async input => {await original(input); throw error('NETWORK');};
  const ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'unknown'); ticket.dispose();
  assert.equal(item.field.value, ''); assert.equal(f.reads, 2); assert.equal(f.writes, 1); assert.equal(f.owner.getState().phase, 'review');
  assert.deepEqual([f.owner.navigation().dirty, f.owner.navigation().blocked], [true, true]);
  assert.throws(() => f.owner.prepareSave()); assert.equal(f.writes, 1); assert.doesNotMatch(JSON.stringify(f.states), /synthetic-unknown-only|synthetic-error/);
});

test('page hiding invalidates unsent tickets and late accepted writes without another request', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); f.add('A', 'synthetic-page-only');
  const unsent = f.owner.prepareSave()!; f.owner.setPageVisible(false); assert.equal(await unsent.run(), 'blocked'); assert.equal(f.writes, 0); unsent.dispose();
  f.owner.setPageVisible(true); assert.equal(f.owner.navigation().dirty, true); assert.throws(() => f.owner.prepareSave(), 'cleared replacement must be reentered');
  const item = f.owner.getState().drafts[0]!; const input = {value: 'synthetic-reentered-only'}; f.owner.registerKey(item.id, input); f.owner.keyChanged(item.id);
  const held = deferred<unknown>(), original = f.client.write; f.client.write = async value => {const result = await original(value); await held.promise; return result;};
  const sending = f.owner.prepareSave()!, pending = sending.run(); await flush(); f.owner.setPageVisible(false); const before = f.owner.getState(); held.resolve(null);
  assert.equal(await pending, 'unknown'); sending.dispose(); assert.deepEqual(f.owner.getState(), before); assert.equal(f.writes, 1); assert.equal(f.reads, 1);
  assert.equal(f.owner.navigation().blocked, true);
});

test('all fields clear before the first domain writes; partial save disposes skipped credential tickets and requires reentry', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); const item = f.add('A', 'synthetic-skipped-only');
  let writes = 0;
  const saved = {revision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION}, secret: {configured: false, storage: 'none'}, storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}};
  const official = createGenerationImageServicesOwner('official', {client: {read: async () => saved, write: async () => {writes++; assert.equal(item.field.value, ''); throw error('IMAGE_SETTINGS_VALIDATION');}}});
  t.after(() => official.dispose()); await official.load(); official.edit('image:official', {}, {enabled: true});
  const result = await saveGenerationServiceDomains([{prepareSave: () => ({run: async () => 'saved', dispose() {}}), clearKeys() {}}, official, f.owner]);
  assert.deepEqual(result, {state: 'partial', confirmed: 1}); assert.equal(writes, 1); assert.equal(f.writes, 0); assert.equal(f.owner.navigation().dirty, true);
  assert.throws(() => f.owner.prepareSave()); assert.equal(f.writes, 0); assert.doesNotMatch(JSON.stringify(f.states), /synthetic-skipped-only/);
});

test('Comfy detail cancellation rejects late check evidence; saving local configuration does not check or acquire keys', async () => {
  const held = deferred<unknown>(), calls: string[] = [], snapshot = {revision: 0, configuration: {...DEFAULT_COMFY_IMAGE_CONFIGURATION}, readiness: {checked: false, checkedAt: null}};
  const owner = createGenerationImageServicesOwner('comfy', {client: {read: async () => {calls.push('read'); return snapshot;}, write: async input => {calls.push('write'); assert.ok(input && typeof input === 'object' && 'configuration' in input); return {...snapshot, revision: 1, configuration: input.configuration};},
    readAvailability: async () => ({schemaVersion: 1, connectorId: 'mioon.comfy-local', implementationVersion: '1', state: 'available', reason: 'ready', fixedForSession: true}), check: async () => {calls.push('check'); return held.promise;}}});
  await owner.load(); await flush(); owner.edit('image:comfy', {}, {baseUrl: 'http://127.0.0.1:8188'}); const checking = owner.checkConnection(); owner.cancelCheck(); const before = owner.getState();
  held.resolve({ok: true, baseUrl: 'http://127.0.0.1:8188', comfyVersion: '0.39.0', checkpoints: ['installed.safetensors'], selectedCheckpointAvailable: false, nodeClasses: ['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage']});
  assert.equal(await checking, false); assert.deepEqual(owner.getState(), before); assert.deepEqual(calls, ['read', 'check']);
  owner.edit('image:comfy', {}, {baseUrl: ''}); const ticket = owner.prepareSave(); assert.equal(ticket, null); assert.deepEqual(calls, ['read', 'check']); owner.dispose();
});

test('existing private transport aborts once and never reflects provider error text', async () => {
  const controller = new AbortController(); let calls = 0, signal: AbortSignal | null | undefined;
  const client = createGenerationImageServicesClient('custom', (async (_route, options) => {calls++; signal = options?.signal; return new Promise<Response>(() => {});}) as typeof fetch);
  const writing = client.write({action: 'batch'}, controller.signal); controller.abort(); await assert.rejects(writing, error => error instanceof Error && !error.message.includes('synthetic'));
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
});

test('custom model-only edits keep existing credentials; address keep disconnects only that recipient', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); const a = f.add('A', 'synthetic-recipient-a'), b = f.add('B', 'synthetic-recipient-b');
  let ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  f.owner.edit(a.id, {}, {model: 'model-next'}); ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  let snapshot = await f.settings.get(); assert.equal(snapshot.connections.find(item => item.connectionId === a.id)!.secret.configured, true);
  f.owner.edit(a.id, {}, {baseUrl: 'https://another.example/v1'}); ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  snapshot = await f.settings.get(); assert.equal(snapshot.connections.find(item => item.connectionId === a.id)!.secret.configured, false); assert.equal(snapshot.connections.find(item => item.connectionId === b.id)!.secret.configured, true);
});

test('invalid replacement clears every field and fails before any batch; failed readback never admits a secret echo', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); const a = f.add('A', 'bad whitespace'), b = f.add('B', 'synthetic-valid-b');
  assert.throws(() => f.owner.prepareSave()); assert.equal(a.field.value, ''); assert.equal(b.field.value, ''); assert.equal(f.writes, 0); assert.equal(f.owner.navigation().dirty, true);
  a.field.value = 'synthetic-valid-a'; f.owner.keyChanged(a.id); b.field.value = 'synthetic-valid-b'; f.owner.keyChanged(b.id);
  f.client.write = async () => {throw error('NETWORK');}; f.client.read = async () => ({revision: 0, connections: [], key: 'synthetic-echo-must-not-enter-state'});
  const ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'blocked'); ticket.dispose();
  assert.equal(f.owner.getState().phase, 'blocked'); assert.doesNotMatch(JSON.stringify(f.owner.getState()) + JSON.stringify(f.states), /synthetic-echo|synthetic-valid|bad whitespace/);
});

test('official ticket requires explicit storage and writes its existing fixed profile only once', async () => {
  let writes = 0; const initial = {revision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION}, secret: {configured: false, storage: 'none'}, storage: {persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY'}};
  const owner = createGenerationImageServicesOwner('official', {client: {read: async () => initial, write: async input => {writes++; assert.ok(input && typeof input === 'object' && 'secret' in input && 'configuration' in input); assert.equal(field.value, ''); return {...initial, revision: 1, configuration: input.configuration, secret: {configured: true, storage: 'session'}};}}});
  await owner.load(); const field = {value: 'synthetic-official-only'}; owner.registerKey('image:official', field); owner.keyChanged('image:official');
  assert.throws(() => owner.prepareSave()); assert.equal(writes, 0); assert.equal(field.value, '');
  field.value = 'synthetic-official-only'; owner.keyChanged('image:official'); owner.edit('image:official', {storage: 'session'});
  const ticket = owner.prepareSave()!; assert.equal(field.value, ''); assert.equal(await ticket.run(), 'saved'); ticket.dispose(); assert.equal(writes, 1); assert.equal(owner.navigation().dirty, false); owner.dispose();
});

test('Comfy saves exactly one CAS without checking even when its optional module is unavailable', async () => {
  const calls: string[] = [], initial = {revision: 4, configuration: {...DEFAULT_COMFY_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'http://127.0.0.1:8188', model: 'installed.safetensors'}, readiness: {checked: false, checkedAt: null}};
  const owner = createGenerationImageServicesOwner('comfy', {client: {read: async () => {calls.push('read'); return initial;}, write: async input => {calls.push('write'); assert.ok(input && typeof input === 'object' && 'configuration' in input && 'expectedRevision' in input); assert.equal(input.expectedRevision, 4); assert.deepEqual(Object.keys(input).sort(), ['configuration', 'expectedRevision']); return {...initial, revision: 5, configuration: input.configuration};}, readAvailability: async () => {throw error('COMFY_MODULE_UNAVAILABLE');}, check: async () => {assert.fail('Saving must not check');}}});
  await owner.load(); await flush(); owner.edit('image:comfy', {}, {enabled: false}); const ticket = owner.prepareSave()!; assert.equal(await ticket.run(), 'saved'); ticket.dispose();
  assert.deepEqual(calls, ['read', 'write']); assert.equal(owner.navigation().dirty, false); owner.dispose();
});

test('a well-formed but mismatched ACK is uncertain and performs exactly one strict readback', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); f.add('A', 'synthetic-untrusted-ack');
  const original = f.client.write; f.client.write = async input => {const result = await original(input); assert.ok(result && typeof result === 'object' && 'revision' in result && typeof result.revision === 'number'); return {...result, revision: result.revision + 1};};
  const ticket = f.owner.prepareSave()!; assert.equal(await ticket.run(), 'unknown'); ticket.dispose();
  assert.equal(f.reads, 2); assert.equal(f.writes, 1); assert.equal(f.owner.navigation().blocked, true); assert.equal(f.owner.getState().phase, 'review');
});

test('captured autofill without an input event retains a redacted replacement intent when its ticket is skipped', async t => {
  const f = await customFixture(); t.after(async () => {f.owner.dispose(); await f.settings.close();}); const a = f.add('A'); let ticket = f.owner.prepareSave()!; await ticket.run(); ticket.dispose();
  assert.equal(f.owner.navigation().dirty, false); f.owner.edit(a.id, {storage: 'session'}); a.field.value = 'synthetic-autofill-only'; ticket = f.owner.prepareSave()!; assert.equal(a.field.value, ''); ticket.dispose();
  assert.equal(f.owner.navigation().dirty, true); assert.throws(() => f.owner.prepareSave()); assert.equal(f.writes, 1); assert.doesNotMatch(JSON.stringify(f.states), /synthetic-autofill-only/);
});
