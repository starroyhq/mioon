import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, isTimelineMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import { LocalDeliveryRequestError } from '../apps/web/src/local-delivery-client.ts';
import { createLocalShotTextController, createLocalShotTextRetention } from '../apps/web/src/local-shot-text-state.ts';
import { LocalShotTextRequestError } from '../apps/web/src/local-shot-text-client.ts';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { createExportSettingsController } from '../apps/web/src/export-settings-state.ts';
import { createExportRangeController } from '../apps/web/src/export-range-state.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS } from '@mioon/contracts';
import { readEditorWindowClose } from '../apps/web/src/editor-window-close.ts';

const sameIdentity = (a, b) => a.identity.length === b.identity.length && a.identity.every((value, index) => Object.is(value, b.identity[index]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const until = async predicate => { for (let index = 0; index < 60 && !predicate(); index++) await Promise.resolve(); assert.ok(predicate()); };

// Real controller fixtures with strict matching ACKs; no controller substitute.
const deliveryFixtures = (() => {
const id = n => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), stamp = '2026-10-12T00:00:00.000Z';
const inputValid = value => schemas['timeline.render'].safeParse(value).success;
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const empty = () => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset' });
function receipt(input) {
  const assetId = id(10), trackId = id(11);
  return { id: id(15), projectId, requestId: input.requestId, mode: 'timeline', purpose: 'export', timelineRevision: input.expectedRevision,
    snapshot: { timeline: { id: timelineId, projectId, revision: input.expectedRevision, fps: 30, width: 720, height: 1280, durationFrames: 30,
      tracks: [{ id: trackId, kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }],
      clips: [{ id: id(12), trackId, assetId, name: 'Image', startFrame: 0, durationFrames: 30, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } }], createdAt: stamp, updatedAt: stamp },
      assets: [{ id: assetId, sha256: 'b'.repeat(64), mimeType: 'image/png', duration: 0, width: 1, height: 1 }], ...(Object.hasOwn(input, 'deliveryName') ? { deliveryName: input.deliveryName } : {}) },
    status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp };
}
function fixture(t, options = {}) {
  let context = { scope: 'project:1', projectId, timelineId, timelineRevision: 4, restored: false, connected: true, visible: true, busy: false, deliveryName: '', nameVersion: 1, dirty: false, ...options.context };
  let stored = copy(options.stored ?? empty()), nextId = 100;
  const calls = [], accepted = [], overrides = {};
  const client = {
    async get(value) { calls.push({ method: 'get', input: value }); return overrides.get ? overrides.get(value) : copy(stored); },
    async put(input) { calls.push({ method: 'put', input: copy(input) }); if (overrides.put) return overrides.put(input);
      if (stored.draftRevision === input.expectedDraftRevision + 1 && stored.draft && stored.draft.draftId === input.draftId && stored.draft.timelineId === input.timelineId && stored.draft.baseRevision === input.baseRevision && JSON.stringify(stored.draft.raw) === JSON.stringify(input.raw)) return copy(stored);
      if (stored.draftRevision !== input.expectedDraftRevision) throw new LocalDeliveryRequestError('conflict', 'LOCAL_DELIVERY_CONFLICT', 409);
      if (stored.draft && (stored.draft.draftId !== input.draftId || stored.draft.timelineId !== input.timelineId || stored.draft.baseRevision !== input.baseRevision)) throw new LocalDeliveryRequestError('conflict', 'LOCAL_DELIVERY_CONFLICT', 409);
      stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: { draftId: input.draftId, timelineId: input.timelineId, baseRevision: input.baseRevision, raw: copy(input.raw), updatedAt: stamp }, draftTargetStatus: input.baseRevision === context.timelineRevision && input.timelineId === context.timelineId ? 'matching' : 'changed' }; return copy(stored); },
    async discard(input) { calls.push({ method: 'discard', input: copy(input) }); if (overrides.discard) return overrides.discard(input); stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' }; return copy(stored); },
    async prepare(input) { calls.push({ method: 'prepare', input: copy(input) }); if (overrides.prepare) return overrides.prepare(input);
      stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { intentId: input.intentId, timelineId: input.timelineId, baseRevision: input.baseRevision, draft: copy(input.draft), input: copy(input.input), createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching' }; return copy(stored); },
    async execute(input) { calls.push({ method: 'execute', input: copy(input) }); return overrides.execute ? overrides.execute(input) : settle(); },
    async recover(input) { calls.push({ method: 'recover', input: copy(input) }); return overrides.recover ? overrides.recover(input) : settle(); },
  };
  function settle() { const response = receipt(stored.intent.input); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent, outcome: { status: 'accepted', exportId: response.id, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, ...(stored.draft ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalDeliveryController({ context, getContext: () => context, client, isRenderInput: inputValid, validateResponse: (input, result) => isTimelineMutationResponse('timeline.render', input, result),
    validateNotApplied: (input, code) => hasRequestNotAppliedProof({ code, status: 409, details: { mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: input.projectId, requestId: input.requestId } }, input, { operation: 'timeline.render' }),
    createId: () => id(nextId++), delay: 60000, onRestore(draft, capture) { if (context.nameVersion !== capture.nameVersion) return false; context = { ...context, deliveryName: draft.raw.deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; return true; }, onAccepted: value => accepted.push(value) });
  t.after(() => controller.dispose());
  return { controller, calls, accepted, overrides, state: () => controller.getState(), stored: () => copy(stored), write(value) { stored = copy(value); }, set(patch, notify = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(deliveryName) { context = { ...context, deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; controller.setContext(context); }, input: () => ({ projectId: context.projectId, expectedRevision: context.timelineRevision, requestId: 'original-request', purpose: 'export', ...(context.deliveryName === '' ? {} : { deliveryName: context.deliveryName }) }) };
}
const storedDraft = (raw = '  Saved draft  ', patch = {}) => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), timelineId, baseRevision: 4, raw: { deliveryName: raw }, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
const tickUntil = async condition => { for (let i = 0; i < 30 && !condition(); i++) await Promise.resolve(); assert.ok(condition()); };

return { fixture, empty, storedDraft, id, projectId, timelineId };
})();

// Real controller fixtures with strict matching ACKs; no controller substitute.
const shotFixtures = (() => {
const id = n => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), stamp = '2026-10-12T00:00:00.000Z', baseText = { title: 'Saved title', prompt: 'Saved prompt' };
const valid = value => schemas['shot.update'].safeParse(value).success;
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const empty = () => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, shotId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset', projectPendingIntent: null });
const storedDraft = (raw = { title: 'Draft title', prompt: '' }, patch = {}) => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), baseRevision: 4, baseText, raw, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
function receipt(intent) { return { id: shotId, projectId, revision: intent.baseRevision + 1, ...intent.baseText, ...intent.input.patch, duration: 7, aspectRatio: '16:9', parameters: { seed: 42 }, referenceAssetIds: [] }; }
const until = async predicate => { for (let i = 0; i < 40 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate()); };
function fixture(t, options = {}) {
  let context = { scope: 'project:1', projectId, shotId, revision: 4, baseRevision: 4, baseText, savedText: baseText, restored: false, connected: true, visible: true, busy: false,
    raw: copy(baseText), textVersion: 1, formSerial: 0, textDirty: false, formDirty: false, executionEpoch: 'owner-action', ...options.context };
  let stored = copy(options.stored ?? empty()), nextId = 100;
  const calls = [], accepted = [], overrides = {};
  const client = {
    async get(project, shot) { calls.push({ method: 'get', projectId: project, shotId: shot }); return overrides.get ? overrides.get(project, shot) : copy(stored); },
    async put(input) {
      calls.push({ method: 'put', input: copy(input) }); if (overrides.put) return overrides.put(input);
      const expected = { draftId: input.draftId, baseRevision: input.baseRevision, baseText: copy(input.baseText), raw: copy(input.raw), updatedAt: stamp };
      if (stored.draftRevision === input.expectedDraftRevision + 1 && JSON.stringify(stored.draft) === JSON.stringify(expected)) return copy(stored);
      if (stored.draftRevision !== input.expectedDraftRevision || stored.draft && (stored.draft.draftId !== input.draftId || stored.draft.baseRevision !== input.baseRevision || JSON.stringify(stored.draft.baseText) !== JSON.stringify(input.baseText))) throw new LocalShotTextRequestError('conflict', 'LOCAL_SHOT_TEXT_CONFLICT', 409);
      stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: expected, draftTargetStatus: input.baseRevision === context.revision ? 'matching' : 'changed' }; return copy(stored);
    },
    async discard(input) { calls.push({ method: 'discard', input: copy(input) }); if (overrides.discard) return overrides.discard(input); stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' }; return copy(stored); },
    async prepare(input) { calls.push({ method: 'prepare', input: copy(input) }); if (overrides.prepare) return overrides.prepare(input); return prepare(input); },
    async execute(input) { calls.push({ method: 'execute', input: copy(input) }); return overrides.execute ? overrides.execute(input) : settle(); },
    async recover(input) { calls.push({ method: 'recover', input: copy(input) }); return overrides.recover ? overrides.recover(input) : settle(); },
  };
  function prepare(input) { stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { intentId: input.intentId, baseRevision: input.baseRevision, baseText: copy(input.baseText), draft: copy(input.draft), input: copy(input.input), createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching', projectPendingIntent: { shotId, intentId: input.intentId } }; return copy(stored); }
  function settle() { const response = receipt(stored.intent); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent, outcome: { status: 'applied', shotRevision: response.revision, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, projectPendingIntent: null,
    ...(stored.draft && stored.draftRevision === stored.intent.draft.revision && JSON.stringify(stored.draft.raw) === JSON.stringify(stored.intent.draft.raw) ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalShotTextController({ context, getContext: () => context, retention: options.retention, client, isShotUpdateInput: valid, delay: 60000, createId: () => id(nextId++),
    onRestore(draft, token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, raw: copy(draft.raw), baseRevision: draft.baseRevision, baseText: copy(draft.baseText), textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; return true; },
    onRebase(token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, baseRevision: context.revision, baseText: copy(context.savedText) }; return true; },
    onAccepted(value) { accepted.push(value); return options.acknowledge !== false; } });
  t.after(() => controller.dispose());
  return { controller, calls, accepted, overrides, client, prepare, settle, state: () => controller.getState(), context: () => copy(context), stored: () => copy(stored), write(value) { stored = copy(value); },
    set(patch, notify = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(patch) { context = { ...context, raw: { ...context.raw, ...patch }, textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; controller.setContext(context); } };
}

return { fixture, empty, storedDraft, id, projectId, shotId };
})();

// Real controller fixtures with strict matching ACKs; no controller substitute.
const clipFixtures = (() => {
const id = n => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T21:00:00.000Z';
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const source = { assetId: id(5), assetSha256: 'b'.repeat(64), versionId: id(8) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 120, sourceInFrame: 0,
  rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
const context = () => ({ ...key, scope: 'project:1:inspector:1', restored: false, connected: true, visible: true,
  busy: false, timelineRevision: 7, source: structuredClone(source), saved: structuredClone(raw) });
const record = (patch = {}) => ({ baseRevision: 7, source: structuredClone(source), raw: { ...structuredClone(raw), name: 'Recovered' }, updatedAt: stamp, ...patch });
const row = (draft = null) => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(6), key,
  revision: draft ? 1 : 0, targetStatus: 'matching', draft });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ack = input => ({ ...row(), revision: input.expectedRevision + 1,
  draft: record({ raw: structuredClone(input.raw), source: structuredClone(input.source), baseRevision: input.baseRevision }) });

function harness(t, { draft = null, ctx = context(), hooks = {} } = {}) {
  let saved = row(draft);
  const calls = [], changes = [];
  const client = {
    async get(input) { calls.push(['get', structuredClone(input)]); return hooks.get ? hooks.get(input, structuredClone(saved)) : structuredClone(saved); },
    async put(input) {
      calls.push(['put', structuredClone(input)]);
      if (hooks.put) return hooks.put(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision); assert.equal(input.instanceId, saved.instanceId); assert.equal(input.workspaceScope, saved.workspaceScope);
      saved = ack(input); return structuredClone(saved);
    },
    async remove(input) {
      calls.push(['delete', structuredClone(input)]);
      if (hooks.remove) return hooks.remove(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision);
      saved = { ...saved, revision: input.expectedRevision + 1, draft: null }; return structuredClone(saved);
    },
  };
  const controller = createClipDraftController({ context: ctx, client, delay: 60000, onChange: next => changes.push(structuredClone(next)) });
  t.after(() => controller.dispose());
  return { controller, calls, changes, ctx, current: () => structuredClone(saved), replace: next => { saved = structuredClone(next); },
    puts: () => calls.filter(([method]) => method === 'put').map(([, input]) => input) };
}

return { harness, row, record, ack, context };
})();

for (const lane of ['clip', 'shot', 'delivery']) test(`${lane} pure close reads have no sync, callbacks, transport or timer effects`, async t => {
  const f = lane === 'clip' ? clipFixtures.harness(t) : lane === 'shot' ? shotFixtures.fixture(t) : deliveryFixtures.fixture(t);
  await f.controller.load();
  if (lane === 'clip') f.controller.edit('name', 'Private name'); else if (lane === 'shot') f.edit({ title: 'Private title', prompt: 'Private prompt' }); else f.edit('Private delivery');
  const before = readEditorWindowClose({ [lane]: f.controller }), state = f.controller.getState(), calls = f.calls.length;
  for (const name of ['hasUnsaved', 'hasUnpersisted', 'capture', 'isCurrent', 'setContext', 'flush', 'flushForClose']) {
    if (typeof f.controller[name] === 'function') t.mock.method(f.controller, name, () => assert.fail(`Close called ${name}`));
  }
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout; let timers = 0;
  t.mock.method(globalThis, 'setTimeout', (...args) => { timers++; return set(...args); });
  t.mock.method(globalThis, 'clearTimeout', (...args) => { timers++; return clear(...args); });
  for (let index = 0; index < 10; index++) {
    const current = readEditorWindowClose({ [lane]: f.controller });
    assert.equal(sameIdentity(before, current), true); assert.equal(current.dirty, true); assert.equal(current.blocked, false);
    assert.equal(Object.isFrozen(current), true); assert.equal(Object.isFrozen(current.identity), true);
    const projection = f.controller.getEditorCloseSnapshot();
    assert.equal(projection.identity.every(value => value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)), true);
    assert.doesNotMatch(JSON.stringify(projection), /Private name|Private title|Private prompt|Private delivery/);
  }
  assert.equal(f.calls.length, calls); assert.equal(f.controller.getState(), state); assert.equal(timers, 0);
});

for (const lane of ['clip', 'shot', 'delivery']) test(`${lane} same-dirty programmatic input and owner replacement invalidate identity`, async t => {
  const make = () => lane === 'clip' ? clipFixtures.harness(t) : lane === 'shot' ? shotFixtures.fixture(t) : deliveryFixtures.fixture(t);
  const f = make(); await f.controller.load();
  const edit = value => lane === 'clip' ? f.controller.edit('name', value) : lane === 'shot' ? f.edit({ title: value }) : f.edit(value);
  edit('A'); const a = readEditorWindowClose({ [lane]: f.controller }); edit('B'); const b = readEditorWindowClose({ [lane]: f.controller });
  assert.equal(a.dirty, true); assert.equal(b.dirty, true); assert.equal(sameIdentity(a, b), false);
  const replacement = make(); assert.equal(sameIdentity(b, readEditorWindowClose({ [lane]: replacement.controller })), false);
});

for (const lane of ['clip', 'shot', 'delivery']) test(`${lane} exact sidecar ACK permits stable input identity but does not waive dirty confirmation`, async t => {
  const f = lane === 'clip' ? clipFixtures.harness(t) : lane === 'shot' ? shotFixtures.fixture(t) : deliveryFixtures.fixture(t);
  await f.controller.load();
  if (lane === 'clip') f.controller.edit('name', 'A'); else if (lane === 'shot') f.edit({ title: 'A' }); else f.edit('A');
  const before = readEditorWindowClose({ [lane]: f.controller });
  await (lane === 'clip' ? f.controller.flushForClose() : f.controller.flush());
  const after = readEditorWindowClose({ [lane]: f.controller });
  assert.equal(after.blocked, false); assert.equal(after.dirty, true); assert.equal(sameIdentity(before, after), true);
  assert.equal(f.calls.some(call => ['prepare', 'execute', 'recover'].includes(call.method)), false);
});

test('delivery lost preparation blocks even when legacy hasUnsaved is false, and explicit recovery releases it', async t => {
  const f = deliveryFixtures.fixture(t); await f.controller.load();
  f.overrides.prepare = () => { throw Error('Lost preparation'); }; assert.equal(await f.controller.submit(f.input()), null);
  assert.equal(f.controller.hasUnsaved(), false); assert.equal(f.state().intentUncertain, true);
  assert.deepEqual(readEditorWindowClose({ delivery: f.controller }).reasons, ['delivery-unknown']);
  assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(readEditorWindowClose({ delivery: f.controller }).blocked, true);
  delete f.overrides.prepare; assert.ok(await f.controller.recover());
  assert.equal(f.state().intent.outcome.status, 'accepted'); assert.equal(f.accepted[0].response.status, 'queued');
  assert.equal(readEditorWindowClose({ delivery: f.controller }).blocked, false, 'An accepted backend render job is not a local owner');
});

test('delivery hidden project retained write remains blocked and same-request retry supplies the existing clear path', async t => {
  const f = deliveryFixtures.fixture(t); await f.controller.load(); f.edit('Secret title');
  f.overrides.put = () => { throw Error('Lost write'); }; assert.equal(await f.controller.flush(), false);
  const original = readEditorWindowClose({ delivery: f.controller });
  f.set({ projectId: deliveryFixtures.id(80), scope: 'project:80', deliveryName: '', nameVersion: 99, dirty: false });
  assert.equal(f.state().retainedDraftWrite, null); assert.equal(f.state().dirty, false);
  assert.equal(readEditorWindowClose({ delivery: f.controller }).blocked, true, 'Read all retained owners, not just selected project');
  assert.equal(sameIdentity(original, readEditorWindowClose({ delivery: f.controller })), false);
  f.set({ projectId: deliveryFixtures.projectId, scope: 'project:1', deliveryName: 'Secret title', nameVersion: 100, dirty: true });
  await f.controller.load(); delete f.overrides.put; assert.equal(await f.controller.retryDraftSave(), true);
  assert.equal(readEditorWindowClose({ delivery: f.controller }).blocked, false);
});

test('delivery active delete is blocked and unknown delete is not erased by input abandonment', async t => {
  const f = deliveryFixtures.fixture(t, { stored: deliveryFixtures.storedDraft() }); await f.controller.load();
  const held = deferred(); f.overrides.discard = () => held.promise;
  const deleting = f.controller.discardStored(); assert.ok(readEditorWindowClose({ delivery: f.controller }).reasons.includes('delivery-inflight'));
  held.reject(Error('Lost delete')); assert.equal(await deleting, false);
  assert.equal(f.state().draftFailure.kind, 'unknown'); assert.equal(f.state().draftRetry, null);
  assert.equal(f.controller.abandonCurrentInput(), true); assert.deepEqual(readEditorWindowClose({ delivery: f.controller }).reasons, ['delivery-unknown']);
  // The existing controller has no retained delete CAS/reconciliation API.
  // The guard must expose this limitation rather than invent an ACK or clear.
});

test('shot retained hidden-slot identity catches one-for-one replacement and never contains draft text', async t => {
  const retention = createLocalShotTextRetention(), f = shotFixtures.fixture(t, { retention }); await f.controller.load(); f.edit({ title: 'Secret title' });
  f.overrides.put = () => { throw Error('Lost write'); }; await f.controller.flush();
  assert.equal(retention.writes.size, 1); const [key, request] = [...retention.writes][0];
  f.set({ shotId: shotFixtures.id(88), scope: 'other-shot', textDirty: false, formDirty: false });
  assert.equal(f.state().retainedDraftWrite, null); const before = readEditorWindowClose({ shot: f.controller }); assert.equal(before.blocked, true);
  retention.writes.set(key, { ...request, draftId: shotFixtures.id(99) });
  const after = readEditorWindowClose({ shot: f.controller }); assert.equal(after.blocked, true); assert.equal(retention.writes.size, 1);
  assert.equal(sameIdentity(before, after), false); assert.doesNotMatch(JSON.stringify(after.identity), /Secret title/);
});

test('shot lost preparation remains blocked after abandonment and resolves only through exact recovery', async t => {
  const f = shotFixtures.fixture(t); await f.controller.load(); f.edit({ title: 'Edited' });
  f.overrides.prepare = () => { throw Error('Lost prepare'); }; await f.controller.submit();
  assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(f.controller.hasUnsaved(), false);
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true);
  delete f.overrides.prepare; assert.ok(await f.controller.recover());
  assert.equal(f.state().intent.outcome.status, 'applied'); assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, false);
});

test('shot pending deletion survives abandonment; exact deletion retry releases retained owner', async t => {
  const f = shotFixtures.fixture(t, { stored: shotFixtures.storedDraft() }); await f.controller.load();
  const held = deferred(); f.overrides.discard = () => held.promise;
  const deleting = f.controller.discardStored(); assert.ok(readEditorWindowClose({ shot: f.controller }).reasons.includes('shot-inflight'));
  held.reject(Error('Lost delete')); await deleting; assert.equal(f.controller.abandonCurrentInput(), true);
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true); delete f.overrides.discard;
  assert.equal(await f.controller.retryDraftDeletion(), true); assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, false);
});

test('late shot PUT ACK cannot acknowledge a newer same-dirty programmatic edit', async t => {
  const f = shotFixtures.fixture(t); await f.controller.load(); f.edit({ title: 'A' });
  const original = readEditorWindowClose({ shot: f.controller }), held = deferred(); let input;
  f.overrides.put = value => { input = value; return held.promise; }; const writing = f.controller.flush();
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true); f.edit({ title: 'B' });
  held.resolve({ ...shotFixtures.empty(), draftRevision: input.expectedDraftRevision + 1,
    draft: { draftId: input.draftId, baseRevision: input.baseRevision, baseText: input.baseText, raw: input.raw, updatedAt: '2026-10-12T00:00:00.000Z' }, draftTargetStatus: 'matching' });
  assert.equal(await writing, false); const current = readEditorWindowClose({ shot: f.controller });
  assert.equal(current.blocked, false); assert.equal(current.dirty, true); assert.equal(f.state().raw.title, 'B'); assert.equal(sameIdentity(original, current), false);
});

test('clip live write, deletion and uncertain deletion survive dirty-false abandonment', async t => {
  const held = deferred(), h = clipFixtures.harness(t, { hooks: { put: () => held.promise } }); await h.controller.load(); h.controller.edit('name', 'A');
  const writing = h.controller.flush(); assert.ok(readEditorWindowClose({ clip: h.controller }).reasons.includes('clip-inflight'));
  held.reject(Error('Lost write')); await writing; assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  assert.equal(h.controller.hasUnsaved(), false); assert.equal(readEditorWindowClose({ clip: h.controller }).blocked, true);
  const deletion = deferred(), d = clipFixtures.harness(t, { draft: clipFixtures.record(), hooks: { remove: () => deletion.promise } }); await d.controller.load();
  const deleting = d.controller.discardStored(); assert.equal(d.controller.hasUnsaved(), false);
  assert.ok(readEditorWindowClose({ clip: d.controller }).reasons.includes('clip-inflight'));
  deletion.reject(Error('Lost delete')); await deleting; assert.equal(readEditorWindowClose({ clip: d.controller }).blocked, true);
});

test('read-only transport failure without local owner does not invent an unresolved mutation', async t => {
  const delivery = deliveryFixtures.fixture(t), shot = shotFixtures.fixture(t);
  delivery.overrides.get = shot.overrides.get = () => { throw Error('Offline'); };
  const clip = clipFixtures.harness(t, { hooks: { get: () => { throw Error('Offline'); } } });
  await Promise.all([delivery.controller.load(), shot.controller.load(), clip.controller.load()]);
  assert.equal(readEditorWindowClose({ delivery: delivery.controller, shot: shot.controller, clip: clip.controller }).blocked, false);
});

test('App-injected import and mutation identities block create/update/delete uncertainty independently of dirty', () => {
  const owner = {}, external = (request, inflight, unknown) => ({ owner, dirty: false, inflight, unknown, identity: ['project:1', request] });
  for (const operation of ['create', 'update', 'delete']) {
    const first = readEditorWindowClose({ mutationState: external(`${operation}:1`, true, false) });
    assert.equal(first.dirty, false); assert.deepEqual(first.reasons, ['mutation-inflight']);
    const unknown = readEditorWindowClose({ mutationState: external(`${operation}:1`, false, true) });
    assert.deepEqual(unknown.reasons, ['mutation-unknown']);
    assert.equal(sameIdentity(unknown, readEditorWindowClose({ mutationState: external(`${operation}:2`, false, true) })), false);
    assert.equal(readEditorWindowClose({ mutationState: external(`${operation}:1`, false, false) }).blocked, false);
  }
  assert.deepEqual(readEditorWindowClose({ importState: external('import:1', false, true) }).reasons, ['import-unknown']);
});

test('real export settings and range retain ephemeral edits and exact version while accepted jobs are absent', () => {
  const settings = createExportSettingsController(), range = createExportRangeController();
  settings.setContext({ scope: 'project:1', enabled: true }); range.setContext({ scope: 'project:1', projectId: deliveryFixtures.projectId,
    timelineId: deliveryFixtures.timelineId, revision: 4, durationFrames: 30, enabled: true });
  const read = () => { const s = settings.getState(), r = range.getState(); return readEditorWindowClose({
    exportSettings: { owner: settings, dirty: s.exportSettings !== TIMELINE_EXPORT_DEFAULT_SETTINGS, inflight: false, unknown: false, identity: [s.scope, s.version] },
    exportRange: { owner: range, dirty: r.draft.mode !== 'whole', inflight: false, unknown: false, identity: [r.scope, r.version] },
  }); };
  const initial = read(); assert.equal(initial.dirty, false);
  range.chooseRange({ mode: 'selected', startText: '', endText: '30' }, 'project:1'); const first = read();
  assert.equal(first.dirty, true); assert.equal(first.blocked, false); assert.equal(sameIdentity(initial, first), false);
  range.chooseRange({ mode: 'selected', startText: '1', endText: '30' }, 'project:1'); const second = read();
  assert.equal(second.dirty, true); assert.equal(sameIdentity(first, second), false);
  settings.choose({ ...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_1080' }, 'project:1');
  assert.notEqual(settings.getState().exportSettings, TIMELINE_EXPORT_DEFAULT_SETTINGS); assert.equal(sameIdentity(second, read()), false);
});

test('retained identity is bounded at contract slot limit while overflow stays blocked', t => {
  const retention = createLocalShotTextRetention();
  for (let index = 0; index < 140; index++) retention.writes.set(`hidden:${index}`, {
    workspaceScope: 'a'.repeat(64), instanceId: shotFixtures.id(3), projectId: shotFixtures.projectId,
    shotId: shotFixtures.id(index + 100), draftId: shotFixtures.id(index + 300), expectedDraftRevision: index, baseRevision: 4,
    baseText: { title: 'Private baseline', prompt: 'Private prompt' }, raw: { title: 'Private title', prompt: 'Private prompt' },
  });
  const f = shotFixtures.fixture(t, { retention }), snapshot = readEditorWindowClose({ shot: f.controller });
  assert.equal(snapshot.blocked, true); assert.ok(snapshot.identity.length < 1500); assert.doesNotMatch(JSON.stringify(snapshot.identity), /Private/);
});

test('known refusal is an ordinary dirty decision, but a later refusal cannot erase an earlier unknown write', async t => {
  const known = deliveryFixtures.fixture(t); await known.controller.load(); known.edit('Current');
  known.overrides.put = () => { throw new LocalDeliveryRequestError('Full', 'LOCAL_DELIVERY_CAPACITY', 507); }; await known.controller.flush();
  assert.equal(readEditorWindowClose({ delivery: known.controller }).blocked, false); assert.equal(readEditorWindowClose({ delivery: known.controller }).dirty, true);
  const unknown = deliveryFixtures.fixture(t); await unknown.controller.load(); unknown.edit('Original');
  unknown.overrides.put = () => { throw Error('Lost ACK'); }; await unknown.controller.flush();
  unknown.overrides.put = known.overrides.put; assert.equal(await unknown.controller.retryDraftSave(), false);
  assert.equal(readEditorWindowClose({ delivery: unknown.controller }).blocked, true);
});
