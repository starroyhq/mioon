import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, resolveTimelineExportDelivery } from '@mioon/contracts';
import { createTimelineDeliveryNameController, deliveryNameContextFields, deliveryNameRequestFields, namedTimelineDeliveryHistory } from '../apps/web/src/export-delivery-state.ts';
import { createExportPreflightController } from '../apps/web/src/export-preflight-state.js';
import { prepareSubmission, prepareRequestReplay, readPending } from '../apps/web/src/submissions.js';

const id = n => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), hash = 'a'.repeat(64);
const timeline = { id: timelineId, projectId, revision: 4, width: 720, height: 1280, fps: 30 };
const settings = structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS);
const report = (name = '第一版', patch = {}) => ({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, snapshotHash: hash, checkedAt: '2026-10-12T06:00:00.000Z', status: 'ready',
  summary: { ...(name === undefined ? {} : { deliveryName: name }), width: 720, height: 1280, fps: 30, durationFrames: 90, trackCount: 1, clipCount: 1, assetCount: 1, visualClipCount: 1, audibleClipCount: 0, mutedTrackCount: 0, hiddenVideoTrackCount: 0, delivery: resolveTimelineExportDelivery(timeline, settings) },
  checks: { totalAssets: 1, checkedAssets: 1, bytesHashed: 128, fullDecode: false }, issues: [], ...patch });
const capability = () => ({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, exportSettings: settings, delivery: resolveTimelineExportDelivery(timeline, settings), checkedAt: '2026-10-12T06:00:00.000Z', status: 'available', issues: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(patch = {}) {
  let live = { scope: 'project:1', projectId, timelineId, revision: 4, connected: true, exportSettings: settings, settingsVersion: 1, deliveryName: '第一版', deliveryNameVersion: 1, ...patch };
  const calls = [], capabilities = [], reads = [], auth = [];
  const controller = createExportPreflightController({ getContext: () => live,
    readCapabilities(input, options) { const pending = deferred(); calls.push({ operation: 'capability', input, options }); capabilities.push(pending); return pending.promise; },
    read(input, options) { const pending = deferred(); calls.push({ operation: 'preflight', input, options }); reads.push(pending); return pending.promise; }, onUnauthorized: () => auth.push(false) });
  controller.setContext(live); controller.setVisible(true);
  return { controller, calls, capabilities, reads, auth, state: () => controller.getState(),
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    async ready(value = report(live.deliveryName)) { const waiting = controller.check(); capabilities.at(-1).resolve(capability()); await Promise.resolve(); reads.at(-1).resolve(value); await waiting; return controller.getState(); } };
}
function nameFixture() {
  let live = { scope: 'a:1', projectId, enabled: true };
  const controller = createTimelineDeliveryNameController({ getContext: () => live }); controller.setContext(live);
  return { controller, set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); }, choose(value) { const state = controller.getState(); return controller.choose(value, state.scope, state.version); } };
}
const accepted = (name, patch = {}) => ({ id: id(3), projectId, mode: 'timeline', purpose: 'export', status: 'queued', snapshot: { timeline, ...(name === undefined ? {} : { deliveryName: name }) }, ...patch });

test('blank means own-property omission, exact nonempty text is never trimmed or renamed', () => {
  assert.deepEqual(deliveryNameRequestFields({ deliveryName: '' }), {});
  assert.deepEqual(deliveryNameRequestFields({}), {});
  assert.deepEqual(deliveryNameRequestFields({ deliveryName: '  中文 <v1> & final  ' }), { deliveryName: '  中文 <v1> & final  ' });
  for (const value of ['   ', 'bad\nname', 'name\n', 'name\r', 'name\r\n', 'name\u2028', 'a'.repeat(121), '\uD800']) {
    assert.equal(deliveryNameContextFields({ deliveryName: value }).deliveryNameKey, null);
    assert.throws(() => deliveryNameRequestFields({ deliveryName: value }));
  }
});

test('per-project epoch draft retains exact invalid input, blanks are dirty edits, old closures fail', () => {
  const f = nameFixture(), first = f.controller.getState();
  assert.equal(first.value, ''); assert.equal(first.dirty, false);
  assert.equal(f.choose('中文'), true); assert.equal(f.controller.hasUnsaved(), true);
  assert.equal(f.choose(''), true); assert.equal(f.controller.hasUnsaved(), true);
  assert.equal(f.choose('bad\nname'), true); assert.match(f.controller.getState().error, /换行/);
  assert.equal(f.controller.getState().value, 'bad\nname');
  assert.equal(f.controller.choose('stale', first.scope, first.version), false);
  f.set({ enabled: false }); assert.equal(f.choose('blocked'), false);
  f.set({ enabled: true }); assert.equal(f.controller.getState().value, 'bad\nname', 'visibility/enabled state does not discard the field');
  f.set({ scope: 'b:1', projectId: id(99) }, false);
  assert.equal(f.controller.choose('wrong project', 'a:1', f.controller.getState().version), false);
  assert.equal(f.controller.getName('b:1'), ''); assert.equal(f.controller.hasUnsaved(), false);
  f.set({ scope: 'a:2', projectId }); assert.equal(f.controller.getState().value, '');
});

test('matching accepted snapshot marks only the exact draft clean without clearing the field', () => {
  const f = nameFixture(); f.choose('  已接受的名称  '); const capture = f.controller.capture();
  assert.ok(Object.isFrozen(capture));
  for (const response of [null, accepted('different'), accepted(undefined), accepted('  已接受的名称  ', { projectId: id(9) }), accepted('  已接受的名称  ', { status: 'failed' }), accepted('  已接受的名称  ', { status: 'submission_unknown' })]) {
    assert.equal(f.controller.acknowledge(capture, response), false); assert.equal(f.controller.hasUnsaved(), true);
  }
  assert.equal(f.controller.acknowledge(capture, accepted('  已接受的名称  ')), true);
  assert.equal(f.controller.getState().value, '  已接受的名称  '); assert.equal(f.controller.hasUnsaved(), false);
  f.choose(''); assert.equal(f.controller.hasUnsaved(), true); const omitted = f.controller.capture();
  assert.equal(f.controller.acknowledge(omitted, accepted(undefined)), true);
  assert.equal(f.controller.getState().value, ''); assert.equal(f.controller.hasUnsaved(), false);
});

test('late acknowledgements and navigation confirmations never clear a newer or different project draft', () => {
  const f = nameFixture(); f.choose('A'); const old = f.controller.capture();
  f.choose('B'); f.choose('A'); assert.equal(f.controller.acknowledge(old, accepted('A')), false);
  assert.equal(f.controller.discardDraft(old), false); assert.equal(f.controller.hasUnsaved(), true);
  const same = f.controller.capture(); assert.equal(f.controller.discardDraft(same), true);
  assert.equal(f.controller.getState().value, '');
  f.choose('A'); const previousProject = f.controller.capture(); f.set({ scope: 'b:2', projectId: id(9) }, false);
  assert.equal(f.controller.acknowledge(previousProject, accepted('A')), false);
  assert.equal(f.controller.discardDraft(previousProject), false); assert.equal(f.controller.getState().scope, 'b:2');
  f.choose('bad\nname'); const invalid = f.controller.capture(); assert.ok(invalid);
  assert.equal(f.controller.acknowledge(invalid, accepted('bad\nname')), false); assert.equal(f.controller.discardDraft(invalid), true);
});

test('initial no-project navigation is allowed and cancelled navigation never replaces an in-flight capture', () => {
  const initial = createTimelineDeliveryNameController(); initial.setContext({ scope: 'none:1', projectId: null, enabled: false });
  assert.equal(initial.capture(), null); assert.equal(initial.discardDraft(null), true);
  initial.setContext({ scope: 'a:1', projectId, enabled: true }); assert.equal(initial.discardDraft(null), false);
  const f = nameFixture(); f.choose('A'); const rendering = f.controller.capture();
  const cancelledNavigation = f.controller.capture(); assert.notEqual(cancelledNavigation, rendering);
  assert.equal(f.controller.acknowledge(rendering, accepted('A')), true); assert.equal(f.controller.hasUnsaved(), false);
  assert.equal(f.controller.acknowledge(rendering, accepted('A')), false, 'each acknowledgement capture is consumed once');
  assert.equal(f.controller.discardDraft({ ...cancelledNavigation }), false, 'fabricated captures are rejected');
});

test('capability payload remains name-free; checked render binding freezes exact displayed name and quality', async () => {
  const name = '  中文 <第一版>  ', f = fixture({ deliveryName: name });
  const state = await f.ready(report(name));
  assert.deepEqual(f.calls[0].input, { projectId, expectedRevision: 4, exportSettings: settings });
  assert.deepEqual(f.calls[1].input, { ...f.calls[0].input, deliveryName: name });
  assert.equal(Object.hasOwn(f.calls[0].input, 'deliveryName'), false);
  assert.equal(state.binding.deliveryName, name); assert.deepEqual(state.binding.exportSettings, settings);
  assert.ok(Object.isFrozen(state.binding)); assert.ok(Object.isFrozen(state.binding.exportSettings.rateControl));
  const binding = state.binding; assert.equal(f.controller.takeExportBinding(binding), binding); assert.equal(f.controller.takeExportBinding(binding), null);
});

test('blank field omits name from preflight and checked binding, while mismatched own presence fails closed', async () => {
  const f = fixture({ deliveryName: '' }); const unnamed = report(); delete unnamed.summary.deliveryName;
  await f.ready(unnamed);
  assert.equal(Object.hasOwn(f.calls[1].input, 'deliveryName'), false); assert.equal(Object.hasOwn(f.state().binding, 'deliveryName'), false);
  for (const response of [report('invented'), { ...unnamed, summary: { ...unnamed.summary, deliveryName: undefined } }]) { await f.ready(response); assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null); }
  const named = fixture(); await named.ready(unnamed); assert.equal(named.state().binding, null);
});

for (const patch of [{ deliveryName: '第二版' }, { deliveryNameVersion: 3 }, { scope: 'project:2' }, { projectId: id(9) }, { revision: 5 }, { settingsVersion: 2 }, { connected: false }]) {
  test(`live context change fences late check and old clicks: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); const binding = (await f.ready()).binding;
    f.set(patch, false); assert.equal(f.controller.takeExportBinding(binding), null);
    const g = fixture(); const waiting = g.controller.check(); g.set(patch, false);
    g.capabilities[0].resolve(capability()); await waiting;
    assert.equal(g.reads.length, 0); assert.equal(g.state().binding, null);
  });
}

test('late media/auth response is ignored after A→B→A; invalid input does no capability or media work', async () => {
  const f = fixture(); const waiting = f.controller.check(); f.capabilities[0].resolve(capability()); await Promise.resolve();
  f.set({ deliveryName: 'B', deliveryNameVersion: 2 }); f.set({ deliveryName: '第一版', deliveryNameVersion: 3 });
  f.reads[0].reject(Object.assign(Error('late'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.auth.length, 0); assert.equal(f.state().binding, null);
  const invalid = fixture({ deliveryName: 'bad\nname' }); assert.equal(await invalid.controller.check(), null); assert.equal(invalid.calls.length, 0);
});

test('unchecked intent includes exact name, respects live name fences, and is single-use', async () => {
  const incomplete = report('第一版', { status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null, checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false }, issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'bounded' }] });
  const f = fixture(); const intent = (await f.ready(incomplete)).uncheckedIntent;
  assert.equal(intent.deliveryName, '第一版'); assert.equal(Object.hasOwn(intent, 'preflightSnapshotHash'), false);
  f.set({ deliveryName: 'B', deliveryNameVersion: 2 }, false); assert.equal(f.controller.takeUncheckedExportIntent(intent), null);
  const g = fixture(); const current = (await g.ready(incomplete)).uncheckedIntent;
  assert.equal(g.controller.takeUncheckedExportIntent(current), current); assert.equal(g.controller.takeUncheckedExportIntent(current), null);
});

test('completed check survives hide/show without automatic work, in-progress hide cannot publish', async () => {
  const f = fixture(); const binding = (await f.ready()).binding;
  f.controller.setVisible(false); f.controller.setVisible(true); assert.equal(f.state().binding, binding); assert.equal(f.calls.length, 2);
  const waiting = f.controller.check(); f.controller.setVisible(false); f.capabilities.at(-1).resolve(capability()); await waiting;
  assert.equal(f.state().binding, null); assert.equal(f.reads.length, 1);
});

test('pending exact key/input and retry preserve prior name when another draft is prepared', t => {
  class Storage { values = new Map(); get length() { return this.values.size; } key(index) { return [...this.values.keys()][index]; } getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, String(value)); } removeItem(key) { this.values.delete(key); } }
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = new Storage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
  const entry = { projectId, key: 'timeline:render:export', operation: 'timeline.render', input: { projectId, expectedRevision: 4, requestId: 'named-request-original', purpose: 'export', deliveryName: 'original', exportSettings: settings } };
  const original = prepareSubmission(entry), stored = [...storage.values.entries()];
  prepareSubmission({ ...entry, input: { ...entry.input, requestId: 'another-request-id', deliveryName: 'new draft' } });
  assert.deepEqual([...storage.values.entries()], stored); assert.deepEqual(readPending(projectId, entry.key), original); assert.deepEqual(prepareRequestReplay(original), original);
  assert.throws(() => prepareRequestReplay({ ...original, input: { ...original.input, deliveryName: 'changed retry' } }), { code: 'MUTATION_REPLAY_MISMATCH' });
});

test('named projection rejects malformed own name, path-shaped IDs and legacy status aliases', () => {
  const base = { id: id(7), assetId: id(8), mode: 'timeline', purpose: 'export', status: 'succeeded', timelineRevision: 4, createdAt: '2026-10-12T06:00:00.000Z', snapshot: { timeline, deliveryName: 'frozen' } };
  assert.equal(namedTimelineDeliveryHistory(base).downloadHref, `/media/${id(8)}?download=1&exportId=${id(7)}`);
  for (const patch of [{ id: '../path' }, { status: 'completed' }, { status: 'ready' }, { snapshot: { ...base.snapshot, deliveryName: undefined } }, { snapshot: { timeline } }]) assert.equal(namedTimelineDeliveryHistory({ ...base, ...patch }), null);
  assert.equal(namedTimelineDeliveryHistory({ ...base, assetId: '../file', url: 'https://bad.example/name.mp4' }).downloadHref, null);
});
