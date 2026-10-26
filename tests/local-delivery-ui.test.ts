import type {LocalDeliveryClient} from '../apps/web/src/local-delivery-client.ts';
import type {LocalDeliverySupported, LocalDeliveryContext} from '../apps/web/src/local-delivery-state.ts';
import type {LocalDeliveryRenderInput, LocalDeliveryDraftPut, LocalDeliveryDraftDelete, LocalDeliveryPrepare, LocalDeliveryExecute} from '@mioon/contracts/local-delivery';
type DeliveryOverrides = {[K in keyof LocalDeliveryClient]?: (input: Parameters<LocalDeliveryClient[K]>[0]) => unknown};
type DeliveryCall = {[K in keyof LocalDeliveryClient]: {method: K; input: Parameters<LocalDeliveryClient[K]>[0]}}[keyof LocalDeliveryClient];
type ReadyDeliveryContext = LocalDeliveryContext & {projectId: string; timelineId: string; timelineRevision: number};
import type {LocalDeliveryAccepted} from '../apps/web/src/local-delivery-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, isTimelineMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import { LOCAL_DELIVERY_LIMITS } from '@mioon/contracts/local-delivery';
import { createTimelineDeliveryNameController } from '../apps/web/src/export-delivery-state.ts';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import { createLocalDeliveryClient, LocalDeliveryRequestError, localDeliveryFailure } from '../apps/web/src/local-delivery-client.ts';

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), stamp = '2026-10-12T00:00:00.000Z';
const inputValid = (value: unknown) => schemas['timeline.render'].safeParse(value).success;
const copy = <T>(value: T): T => structuredClone(value);
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = (yes as (value?: T | PromiseLike<T>) => void); reject = no; }); return { promise, resolve, reject }; };
const empty = (): LocalDeliverySupported => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset' });
function receipt(input: LocalDeliveryRenderInput) {
  const assetId = id(10), trackId = id(11);
  return { id: id(15), projectId, requestId: input.requestId, mode: 'timeline', purpose: 'export', timelineRevision: input.expectedRevision,
    snapshot: { timeline: { id: timelineId, projectId, revision: input.expectedRevision, fps: 30, width: 720, height: 1280, durationFrames: 30,
      tracks: [{ id: trackId, kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }],
      clips: [{ id: id(12), trackId, assetId, name: 'Image', startFrame: 0, durationFrames: 30, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } }], createdAt: stamp, updatedAt: stamp },
      assets: [{ id: assetId, sha256: 'b'.repeat(64), mimeType: 'image/png', duration: 0, width: 1, height: 1 }], ...(Object.hasOwn(input, 'deliveryName') ? { deliveryName: input.deliveryName } : {}) },
    status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp };
}
function fixture(t: test.TestContext, options: {context?: Partial<ReadyDeliveryContext>; stored?: LocalDeliverySupported} = {}) {
  let context: ReadyDeliveryContext = { scope: 'project:1', projectId, timelineId, timelineRevision: 4, restored: false, connected: true, visible: true, busy: false, deliveryName: '', nameVersion: 1, dirty: false, ...options.context };
  let stored: LocalDeliverySupported = copy(options.stored ?? empty()), nextId = 100;
  const calls: DeliveryCall[] = [], accepted: (LocalDeliveryAccepted)[] = [], overrides: DeliveryOverrides = {};
  const client = {
    async get(value: Parameters<LocalDeliveryClient['get']>[0]) { calls.push({ method: 'get', input: value }); return overrides.get ? overrides.get(value) : copy(stored); },
    async put(input: Parameters<LocalDeliveryClient['put']>[0]) { calls.push({ method: 'put', input: copy(input) }); if (overrides.put) return overrides.put(input);
      if (stored.draftRevision === input.expectedDraftRevision + 1 && stored.draft && stored.draft.draftId === input.draftId && stored.draft.timelineId === input.timelineId && stored.draft.baseRevision === input.baseRevision && JSON.stringify(stored.draft.raw) === JSON.stringify(input.raw)) return copy(stored);
      if (stored.draftRevision !== input.expectedDraftRevision) throw new LocalDeliveryRequestError('conflict', 'LOCAL_DELIVERY_CONFLICT', 409);
      if (stored.draft && (stored.draft.draftId !== input.draftId || stored.draft.timelineId !== input.timelineId || stored.draft.baseRevision !== input.baseRevision)) throw new LocalDeliveryRequestError('conflict', 'LOCAL_DELIVERY_CONFLICT', 409);
      stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: { draftId: input.draftId, timelineId: input.timelineId, baseRevision: input.baseRevision, raw: copy(input.raw), updatedAt: stamp }, draftTargetStatus: input.baseRevision === context.timelineRevision && input.timelineId === context.timelineId ? 'matching' : 'changed' }; return copy(stored); },
    async discard(input: Parameters<LocalDeliveryClient['discard']>[0]) { calls.push({ method: 'discard', input: copy(input) }); if (overrides.discard) return overrides.discard(input); stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' }; return copy(stored); },
    async prepare(input: Parameters<LocalDeliveryClient['prepare']>[0]) { calls.push({ method: 'prepare', input: copy(input) }); if (overrides.prepare) return overrides.prepare(input);
      stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { intentId: input.intentId, timelineId: input.timelineId, baseRevision: input.baseRevision, draft: copy(input.draft), input: copy(input.input), createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching' }; return copy(stored); },
    async execute(input: Parameters<LocalDeliveryClient['execute']>[0]) { calls.push({ method: 'execute', input: copy(input) }); return overrides.execute ? overrides.execute(input) : settle(); },
    async recover(input: Parameters<LocalDeliveryClient['recover']>[0]) { calls.push({ method: 'recover', input: copy(input) }); return overrides.recover ? overrides.recover(input) : settle(); },
  };
  function settle() { const response = receipt(stored.intent!.input); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent!, outcome: { status: 'accepted', exportId: response.id, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, ...(stored.draft ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalDeliveryController({ context, getContext: () => context, client: client as LocalDeliveryClient, isRenderInput: inputValid, validateResponse: (input, result) => isTimelineMutationResponse('timeline.render', input, result),
    validateNotApplied: (input, code) => hasRequestNotAppliedProof({ code, status: 409, details: { mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: input.projectId, requestId: input.requestId } }, input, { operation: 'timeline.render' }),
    createId: () => id(nextId++), delay: 60000, onRestore(draft, capture) { if (context.nameVersion !== capture.nameVersion) return false; context = { ...context, deliveryName: draft.raw.deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; return true; }, onAccepted: (value => accepted.push(value)) as (value: LocalDeliveryAccepted) => void });
  t.after(() => controller.dispose());
  return { controller, calls, accepted, overrides, state: () => controller.getState(), stored: () => copy(stored), write(value: unknown) { stored = (copy(value) as LocalDeliverySupported); }, set(patch: { connected?: boolean; visible?: boolean; timelineRevision?: number; scope?: string; projectId?: string; timelineId?: string; dirty?: boolean; deliveryName?: string; nameVersion?: number; executionEpoch?: string | number; }, notify = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(deliveryName: string) { context = { ...context, deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; controller.setContext(context); }, input: () => ({ projectId: context.projectId, expectedRevision: context.timelineRevision, requestId: 'original-request', purpose: 'export' as const, ...(context.deliveryName === '' ? {} : { deliveryName: context.deliveryName }) }) };
}
const storedDraft = (raw = '  Saved draft  ', patch: Partial<NonNullable<LocalDeliverySupported['draft']>> = {}): LocalDeliverySupported => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), timelineId, baseRevision: 4, raw: { deliveryName: raw }, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
const tickUntil = async (condition: { (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): unknown; }) => { for (let i = 0; i < 30 && !condition(); i++) await Promise.resolve(); assert.ok(condition()); };

test('load and reconnect discover drafts without restoring, writing or exporting', async t => {
  const f = fixture(t, { stored: storedDraft('bad\nname') }); await f.controller.load();
  assert.equal(f.state().deliveryName, ''); assert.equal(f.state().candidate!.raw.deliveryName, 'bad\nname'); assert.deepEqual(f.calls.map(call => call.method), ['get']);
  f.set({ connected: false, visible: false }); f.set({ connected: true, visible: true }); assert.equal(f.calls.length, 1);
  assert.equal(f.controller.restore(), true); assert.equal(f.state().deliveryName, 'bad\nname'); assert.deepEqual(f.state().baseline, { timelineId, baseRevision: 4 }); assert.equal(f.calls.length, 1);
});

test('restore replaces only explicitly selected raw input and retains original timeline baseline', async t => {
  const f = fixture(t, { stored: storedDraft('x'.repeat(121), { timelineId: id(55), baseRevision: 2 }) }); await f.controller.load(); f.edit('Newer text');
  const old = f.controller.capture(); f.edit('Even newer'); assert.equal(f.controller.restore(old), false);
  assert.equal(f.controller.restore(), true); assert.equal(f.state().deliveryName, 'x'.repeat(121)); assert.equal(f.state().baseline!.timelineId, id(55)); assert.equal(f.state().baseline!.baseRevision, 2); assert.equal(f.state().baselineConflict, true); assert.equal(f.controller.canPrepare(), false);
});

test('keep current is explicit CAS overwrite and explicit baseline change', async t => {
  const f = fixture(t, { stored: storedDraft('Stored', { baseRevision: 2 }) }); await f.controller.load(); f.edit('  Current\nraw  '); assert.equal(await f.controller.keepCurrent(), true);
  const put = f.calls.find(call => call.method === 'put')!.input; assert.equal(put.expectedDraftRevision, 2); assert.notEqual(put.draftId, id(4)); assert.deepEqual(f.calls.map(c => c.method), ['get', 'discard', 'put']); assert.equal(put.raw.deliveryName, '  Current\nraw  '); assert.equal(put.baseRevision, 4); assert.equal(f.state().candidate, null);
  f.set({ timelineRevision: 5 }); assert.equal(f.state().baselineConflict, true); assert.equal(await f.controller.keepCurrent(), true); assert.equal(f.state().baseline!.baseRevision, 5);
});

test('blank, invalid and over-render-limit names save exactly, over storage limit does not truncate', async t => {
  const f = fixture(t); await f.controller.load();
  for (const raw of ['  ', 'bad\n\0text', 'x'.repeat(512), '']) { f.edit(raw); assert.equal(await f.controller.flush(), true); assert.equal(f.stored().draft!.raw.deliveryName, raw); }
  f.edit('x'.repeat(513)); const before = f.calls.length; assert.equal(await f.controller.flush(), false); assert.equal(f.calls.length, before); assert.equal(f.state().deliveryName.length, 513); assert.equal(f.state().autosavePaused, true);
});

test('saved title is durable unsent input; it does not trap quit as unsaved persistence', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Title'); assert.equal(f.controller.hasUnsaved(), true); await f.controller.flush(); assert.equal(f.controller.hasUnsaved(), false); assert.equal(f.state().dirty, true);
});

test('draft capacity refusal is distinct from unknown and explicit leave never cancels intent', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Title'); f.overrides.put = () => { throw new LocalDeliveryRequestError('full', 'LOCAL_DELIVERY_CAPACITY', 507); };
  assert.equal(await f.controller.flush(), false); assert.equal(f.state().draftFailure!.kind, 'refused'); assert.equal(f.controller.allowLeaveWithoutSaving(), true); assert.equal(f.state().deliveryName, 'Title'); assert.equal(f.controller.hasUnsaved(), false); assert.equal(f.state().autosavePaused, true);
});

test('lost draft write ACK plus empty reread cannot resume autosave or discard uncertainty', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Title'); f.overrides.put = () => { throw new Error('network'); }; await f.controller.flush(); await f.controller.load();
  assert.equal(f.state().draftFailure!.kind, 'unknown'); assert.equal(f.state().autosavePaused, true); assert.equal(f.controller.allowLeaveWithoutSaving(), false); assert.equal(f.controller.canPrepare(), false); assert.equal(f.state().deliveryName, 'Title'); assert.equal(f.calls.filter(c => c.method === 'put').length, 1);
});

test('fresh export is durably prepared before execute; strict ACK preserves exact blank omission', async t => {
  const f = fixture(t); await f.controller.load(); const result = await f.controller.submit(f.input());
  assert.ok(result); assert.deepEqual(f.calls.map(c => c.method), ['get', 'prepare', 'execute']); assert.equal(Object.hasOwn((f.calls[1].input as LocalDeliveryPrepare).input, 'deliveryName'), false); assert.equal(f.accepted.length, 1); assert.equal(f.accepted[0].recovered, false); assert.equal(f.state().pending, false);
});

test('named request binds exact durable raw and accepted response cleans only exact current field', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('  Original  '); const nameCapture = Object.freeze({ original: true }); const response = await f.controller.submit(f.input(), { nameCapture });
  assert.ok(response); assert.deepEqual(f.calls.map(c => c.method), ['get', 'put', 'prepare', 'execute']); const prepared = f.calls[2].input as LocalDeliveryPrepare;
  assert.equal(prepared.input.deliveryName, '  Original  '); assert.equal(prepared.draft!.raw.deliveryName, '  Original  '); assert.equal(prepared.draft!.revision, 1); assert.equal(f.state().dirty, false); assert.equal(f.state().deliveryName, '  Original  '); assert.equal(f.accepted[0].nameCapture, nameCapture);
});

test('lost prepare ACK forbids dispatch and later empty GET cannot erase reservation uncertainty', async t => {
  const f = fixture(t); await f.controller.load(); f.overrides.prepare = () => { throw new Error('lost'); }; assert.equal(await f.controller.submit(f.input()), null);
  assert.equal(f.state().intentUncertain, true); assert.equal(f.state().pending, true); assert.equal(f.calls.some(c => c.method === 'execute'), false);
  await f.controller.load(); assert.equal(f.state().pending, true); assert.equal(f.controller.canPrepare(), false); await f.controller.submit(f.input()); assert.equal(f.calls.filter(c => c.method === 'prepare').length, 1);
  f.set({ scope: 'project:2', projectId: id(20), timelineId: id(21) }); f.set({ scope: 'project:3', projectId, timelineId }); await f.controller.load(); assert.equal(f.state().intentUncertain, true);
});

test('confirmed prepare capacity rejection releases only this unaccepted reservation', async t => {
  const f = fixture(t); await f.controller.load(); f.overrides.prepare = () => { throw new LocalDeliveryRequestError('full', 'LOCAL_DELIVERY_CAPACITY', 507); }; await f.controller.submit(f.input());
  assert.equal(f.state().intentFailure!.kind, 'refused'); assert.equal(f.state().intentUncertain, false); assert.equal(f.state().pending, false); assert.equal(f.controller.canPrepare(), true); assert.equal(f.calls.some(c => c.method === 'execute'), false);
});

test('newer name, timeline, hidden tab, or parent navigation during prepare wins over late ACK', async t => {
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => f.edit('New'), (f: Awaited<ReturnType<typeof fixture>>) => f.set({ timelineRevision: 5 }), (f: Awaited<ReturnType<typeof fixture>>) => f.set({ visible: false }), (f: Awaited<ReturnType<typeof fixture>>) => f.set({ executionEpoch: 'new-selection-or-settings' })]) {
    const f = fixture(t); await f.controller.load(); const pending = deferred(); f.overrides.prepare = (value: { intentId: unknown; draft: unknown; input: unknown; }) => pending.promise.then(() => { const current = f.stored(); const next = { ...current, intentRevision: 1, intent: { intentId: value.intentId, timelineId, baseRevision: 4, draft: value.draft, input: value.input, createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching' }; f.write(next); return next; });
    const work = f.controller.submit(f.input()); await tickUntil(() => f.calls.some(c => c.method === 'prepare')); change(f); pending.resolve!(); await work;
    assert.equal(f.calls.some(c => c.method === 'execute'), false); assert.equal(f.state().pending, true);
  }
  const f = fixture(t); await f.controller.load(); await f.controller.submit(f.input(), { canExecute: () => false }); assert.equal(f.calls.some(c => c.method === 'execute'), false);
});

test('late execution ACK cannot clean newer name or restore old context', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); const pending = deferred(); f.overrides.execute = () => pending.promise;
  const work = f.controller.submit(f.input()); await tickUntil(() => f.calls.some(c => c.method === 'execute')); const original = f.stored(), response = receipt(original.intent!.input); f.edit('New name');
  pending.resolve!({ envelope: { ...original, intentRevision: 2, intent: { ...original.intent, outcome: { status: 'accepted', exportId: response.id, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, draftRevision: 2, draft: null, draftTargetStatus: 'unset' }, response }); await work;
  assert.equal(f.state().deliveryName, 'New name'); assert.equal(f.state().dirty, true); assert.equal(f.state().baseline!.baseRevision, 4);
});

test('a malformed accepted response remains pending and cannot acknowledge the current name', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.execute = () => { const original = f.stored(); return { envelope: { ...original, intentRevision: 2, intent: { ...original.intent, outcome: { status: 'accepted', exportId: id(15), responseSha256: 'd'.repeat(64), resolvedAt: stamp } } }, response: { id: id(15), projectId } }; };
  assert.equal(await f.controller.submit(f.input()), null); assert.equal(f.state().dirty, true); assert.equal(f.state().pending, true); assert.equal(f.accepted.length, 0);
});

test('explicit recover after restart executes exactly saved identity without cleaning current draft', async t => {
  const first = fixture(t); await first.controller.load(); await first.controller.submit(first.input(), { canExecute: () => false });
  const saved = first.stored(), f = fixture(t, { stored: { ...saved, instanceId: id(88) }, context: { timelineRevision: 9 } }); await f.controller.load(); f.edit('New current title');
  assert.equal(f.calls.some(c => ['execute', 'recover'].includes(c.method)), false); const result = await f.controller.recover(); assert.ok(result);
  const recovered = f.calls.find(c => c.method === 'recover')!.input; assert.equal(recovered.intentId, saved.intent!.intentId); assert.equal(recovered.instanceId, id(88)); assert.equal(Object.hasOwn(recovered, 'input'), false); assert.equal(f.accepted[0].recovered, true); assert.equal(f.accepted[0].nameCapture, null); assert.equal(f.state().deliveryName, 'New current title'); assert.equal(f.state().dirty, true);
});

test('discard stored title neither resets newer text nor mutates pending intent', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load(); f.edit('Current'); const before = f.state().deliveryName; assert.equal(await f.controller.discardStored(), true);
  assert.equal(f.state().deliveryName, before); assert.equal(f.state().dirty, true); assert.deepEqual(f.calls.map(c => c.method), ['get', 'discard']);
});

test('navigation abandonment suppresses autosaving the parent reset', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Title'); const captured = f.controller.capture(); assert.equal(f.controller.abandonCurrentInput(captured), true); f.edit('');
  assert.equal(f.state().dirty, false); assert.equal(f.state().autosavePaused, true); assert.equal(f.calls.some(c => c.method === 'put'), false);
});

test('restored branch stays unsupported while controller makes no sidecar writes or execute calls', async t => {
  const f = fixture(t, { context: { restored: true } }); await f.controller.load(); assert.equal(f.state().phase, 'unsupported'); assert.equal(await f.controller.submit(f.input()), null); assert.equal(await f.controller.recover(), null); assert.equal(f.calls.length, 0);
});

test('client uses fixed same-origin endpoints and classifies only exact refusal code/status pairs', async () => {
  const calls: {url: RequestInfo | URL; init: RequestInit | undefined}[] = [], client = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async (url: string, init: RequestInit | undefined) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: empty() }), { status: 200 }); }) as unknown as typeof fetch });
  await client.get(projectId); assert.equal(calls[0].url, `/api/local-delivery?projectId=${projectId}`); assert.equal(calls[0].init!.method, 'GET'); assert.equal(calls[0].init!.credentials, 'same-origin'); assert.equal(calls[0].init!.cache, 'no-store');
  assert.equal(localDeliveryFailure(new LocalDeliveryRequestError('full', 'LOCAL_DELIVERY_CAPACITY', 507)).kind, 'refused'); assert.equal(localDeliveryFailure(new LocalDeliveryRequestError('full', 'LOCAL_DELIVERY_CAPACITY', 500)).kind, 'unknown');
  assert.equal(localDeliveryFailure(new LocalDeliveryRequestError('stale', 'LOCAL_DELIVERY_STALE_INSTANCE', 409)).kind, 'conflict');
  const invalid = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(JSON.stringify({ ok: true, data: empty(), extra: true }), { status: 200 })) as unknown as typeof fetch }); await assert.rejects(invalid.get(projectId), { code: 'LOCAL_DELIVERY_PROTOCOL_UNKNOWN' });
});


test('explicit recovery retries only the retained unacknowledged preparation then recovers the same input', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.prepare = () => { throw new Error('lost before publication'); };
  await f.controller.submit(f.input()); const original = f.calls.find(c => c.method === 'prepare')!.input;
  await f.controller.load(); assert.equal(f.state().intent, null); assert.equal(f.state().retainedPreparation!.intentId, original.intentId); f.edit('New title');
  delete f.overrides.prepare; const result = await f.controller.recover(); assert.ok(result);
  const prepares = f.calls.filter(c => c.method === 'prepare'); assert.deepEqual(prepares[1].input, original); assert.equal(f.calls.filter(c => c.method === 'recover').length, 1); assert.equal(f.calls.filter(c => c.method === 'execute').length, 0);
  assert.equal(f.state().deliveryName, 'New title'); assert.equal(f.state().dirty, true); assert.equal(f.accepted[0].recovered, true);
});

test('newer edit during explicit prepare recovery keeps the pending original without dispatch', async t => {
  const f = fixture(t); await f.controller.load(); f.overrides.prepare = () => { throw new Error('lost'); }; await f.controller.submit(f.input()); await f.controller.load();
  const deferredPrepare = deferred(); f.overrides.prepare = (input: Parameters<LocalDeliveryClient['prepare']>[0]) => deferredPrepare.promise.then(() => ({ ...f.stored(), intentRevision: 1, intent: { intentId: input.intentId, timelineId, baseRevision: 4, draft: input.draft, input: input.input, createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching' }));
  const work = f.controller.recover(); await tickUntil(() => f.calls.filter(c => c.method === 'prepare').length === 2); f.edit('Newer'); deferredPrepare.resolve!(); await work;
  assert.equal(f.calls.some(c => c.method === 'recover'), false); assert.equal(f.state().pending, true);
});

test('a later refused retry cannot erase evidence of the earlier unknown preparation', async t => {
  const f = fixture(t); await f.controller.load(); f.overrides.prepare = () => { throw new Error('lost'); }; await f.controller.submit(f.input()); await f.controller.load();
  f.overrides.prepare = () => { throw new LocalDeliveryRequestError('full', 'LOCAL_DELIVERY_CAPACITY', 507); }; await f.controller.recover(); assert.equal(f.state().intentUncertain, true); assert.equal(f.state().pending, true); assert.equal(f.controller.canPrepare(), false);
});

test('retained uncertain preparation cannot adopt another workspace with coincident project UUID', async t => {
  const f = fixture(t); await f.controller.load(); f.overrides.prepare = () => { throw new Error('lost'); }; await f.controller.submit(f.input()); const original = f.state().retainedPreparation;
  f.set({ scope: 'another-workspace:1' }); f.write({ ...empty(), workspaceScope: 'b'.repeat(64), instanceId: id(88), intentRevision: 1, intent: { intentId: original!.intentId, timelineId, baseRevision: 4, draft: null, input: original!.input, createdAt: stamp, outcome: { status: 'accepted', exportId: id(15), responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, intentTargetStatus: 'matching' });
  await f.controller.load(); assert.equal(f.state().intentUncertain, true); assert.equal(f.state().pending, true); assert.equal(await f.controller.recover(), null); assert.equal(f.calls.filter(c => c.method === 'prepare').length, 1);
});

test('late discard during explicit baseline replacement cannot replace newer current input', async t => {
  const f = fixture(t, { stored: storedDraft('Old', { baseRevision: 2 }) }); await f.controller.load(); f.edit('Current'); const pending = deferred(); f.overrides.discard = () => pending.promise;
  const work = f.controller.keepCurrent(); await tickUntil(() => f.calls.some(c => c.method === 'discard')); f.edit('Newer'); pending.resolve!({ ...empty(), draftRevision: 2 }); assert.equal(await work, false);
  assert.equal(f.state().deliveryName, 'Newer'); assert.equal(f.calls.some(c => c.method === 'put'), false);
});

test('accepted fresh title remains clean through parent refresh and later name acknowledgement', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Accepted'); await f.controller.submit(f.input()); const calls = f.calls.length;
  f.set({ timelineRevision: 5, dirty: true }); assert.equal(f.state().dirty, false); f.set({ dirty: false }); assert.equal(f.state().dirty, false); assert.equal(await f.controller.flush(), true); assert.equal(f.calls.length, calls); assert.equal(f.stored().draft, null);
  f.edit('New keystroke'); assert.equal(f.controller.hasUnsaved(), true); await f.controller.flush(); assert.equal(f.controller.hasUnsaved(), false);
});


test('explicit recovery accepts terminal outcome revealed at the masked pending revision', async t => {
  const f = fixture(t); await f.controller.load(); await f.controller.submit(f.input(), { canExecute: () => false }); const original = f.stored();
  const masked = { ...original, intentRevision: 2 }; f.write(masked); await f.controller.load(); const response = receipt(original.intent!.input);
  f.overrides.recover = () => ({ envelope: { ...masked, intent: { ...masked.intent, outcome: { status: 'accepted', exportId: response.id, responseSha256: 'd'.repeat(64), resolvedAt: stamp } } }, response });
  assert.ok(await f.controller.recover()); assert.equal(f.state().intent!.outcome.status, 'accepted'); assert.equal(f.state().pending, false);
});

test('restart can reveal same-revision terminal metadata read-only without acknowledging newer title', async t => {
  const f = fixture(t); await f.controller.load(); await f.controller.submit(f.input(), { canExecute: () => false }); const original = f.stored();
  f.write({ ...original, intentRevision: 2 }); await f.controller.load(); f.edit('Newer');
  f.write({ ...f.stored(), instanceId: id(88), intent: { ...original.intent, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT', resolvedAt: stamp } } }); await f.controller.load();
  assert.equal(f.state().intent!.outcome.status, 'not_applied'); assert.equal(f.state().deliveryName, 'Newer'); assert.equal(f.state().dirty, true); assert.equal(f.accepted.length, 0); assert.equal(f.calls.some(c => c.method === 'execute' || c.method === 'recover'), false);
});


test('unconfirmed preparation fences newer title persistence without changing original draft CAS', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.prepare = () => { throw new Error('lost before publication'); }; await f.controller.submit(f.input());
  const retained = f.state().retainedPreparation, originalDraft = f.stored().draft; f.edit('New title'); assert.equal(await f.controller.flush(), false); assert.equal(await f.controller.keepCurrent(), false); assert.equal(await f.controller.discardStored(), false);
  assert.deepEqual(f.stored().draft, originalDraft); assert.equal(f.state().deliveryName, 'New title'); assert.equal(f.controller.hasUnsaved(), true);
  delete f.overrides.prepare; assert.ok(await f.controller.recover()); assert.deepEqual(f.calls.filter(c => c.method === 'prepare')[1].input, retained); assert.equal(f.state().dirty, true);
});

test('malformed not-applied code from a read or execution cannot release pending original', async t => {
  const f = fixture(t); await f.controller.load(); await f.controller.submit(f.input(), { canExecute: () => false }); const original = f.stored();
  f.write({ ...original, intentRevision: 2, intent: { ...original.intent, outcome: { status: 'not_applied', code: 'MADE_UP_REJECTION', resolvedAt: stamp } } }); await f.controller.load(); assert.equal(f.state().pending, true); assert.equal(f.state().intent!.outcome.status, 'pending');
  const g = fixture(t); await g.controller.load(); g.overrides.execute = () => { const pending = g.stored(); return { envelope: { ...pending, intentRevision: 2, intent: { ...pending.intent, outcome: { status: 'not_applied', code: 'MADE_UP_REJECTION', resolvedAt: stamp } } }, response: null }; };
  assert.equal(await g.controller.submit(g.input()), null); assert.equal(g.state().pending, true); assert.equal(g.state().intent!.outcome.status, 'pending');
});


test('invalid local title can be corrected and explicitly saved without sending invalid input or exporting', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('x'.repeat(513)); assert.equal(await f.controller.flush(), false);
  assert.equal(f.state().draftFailure!.code, 'LOCAL_DELIVERY_LOCAL_VALIDATION'); assert.equal(f.state().draftFailure!.kind, 'refused'); assert.equal(f.state().draftRetry, 'current'); assert.equal(f.calls.filter(c => c.method === 'put').length, 0);
  f.edit('Corrected'); assert.equal(await f.controller.flush(), false); assert.equal(await f.controller.retryDraftSave(), true); assert.equal(f.stored().draft!.raw.deliveryName, 'Corrected'); assert.equal(f.state().autosavePaused, false); assert.equal(f.state().draftRetry, null);
  assert.equal(f.calls.some(c => ['prepare', 'execute', 'recover'].includes(c.method)), false);
});

test('corrected title retries against the unchanged known row without another candidate overwrite prompt', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Before'); await f.controller.flush(); f.edit('x'.repeat(513)); await f.controller.flush(); f.edit('Corrected');
  assert.equal(await f.controller.retryDraftSave(), true); assert.equal(f.stored().draft!.raw.deliveryName, 'Corrected'); assert.equal(f.state().candidate, null);
});

test('timeout after PUT publication and later GET-null retain exact PUT until explicit idempotent retry', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = (input: Parameters<LocalDeliveryClient['put']>[0]) => {
    f.write({ ...f.stored(), draftRevision: input.expectedDraftRevision + 1, draft: { draftId: input.draftId, timelineId: input.timelineId, baseRevision: input.baseRevision, raw: input.raw, updatedAt: stamp }, draftTargetStatus: 'matching' });
    throw new LocalDeliveryRequestError('timed out', 'LOCAL_DELIVERY_TIMEOUT_UNKNOWN');
  };
  await f.controller.flush(); const original = f.state().retainedDraftWrite; assert.ok(original); f.overrides.get = () => empty(); await f.controller.load(); assert.deepEqual(f.state().retainedDraftWrite, original); assert.equal(f.state().autosavePaused, true);
  delete f.overrides.put; assert.equal(await f.controller.retryDraftSave(), true); const puts = f.calls.filter(c => c.method === 'put'); assert.deepEqual(puts[1].input, original); assert.equal(f.stored().draftRevision, 1); assert.equal(f.state().retainedDraftWrite, null); assert.equal(f.state().autosavePaused, false); assert.equal(f.calls.some(c => ['prepare', 'execute', 'recover'].includes(c.method)), false);
});

test('retry confirms original raw while preserving newer input until a second explicit current save', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = () => { throw new Error('lost before write'); }; await f.controller.flush(); const original = f.state().retainedDraftWrite;
  f.edit('Newer'); delete f.overrides.put; assert.equal(await f.controller.retryDraftSave(), false); assert.equal(f.stored().draft!.raw.deliveryName, 'Original'); assert.equal(f.state().deliveryName, 'Newer'); assert.equal(f.state().dirty, true); assert.equal(f.state().autosavePaused, true); assert.equal(f.state().draftRetry, 'current'); assert.equal(f.state().retainedDraftWrite, null);
  assert.deepEqual(f.calls.filter(c => c.method === 'put')[1].input, original); f.set({ visible: false }); f.set({ visible: true }); assert.equal(f.calls.filter(c => c.method === 'put').length, 2);
  assert.equal(await f.controller.retryDraftSave(), true); assert.equal(f.stored().draft!.raw.deliveryName, 'Newer'); assert.equal(f.calls.some(c => ['prepare', 'execute', 'recover'].includes(c.method)), false);
});

test('newer edit during PUT retry cannot be replaced or automatically saved by old ACK', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = () => { throw new Error('lost'); }; await f.controller.flush();
  const delayed = deferred(); f.overrides.put = (input: Parameters<LocalDeliveryClient['put']>[0]) => delayed.promise.then(() => ({ ...empty(), draftRevision: input.expectedDraftRevision + 1, draft: { draftId: input.draftId, timelineId, baseRevision: 4, raw: input.raw, updatedAt: stamp }, draftTargetStatus: 'matching' }));
  const work = f.controller.retryDraftSave(); await tickUntil(() => f.calls.filter(c => c.method === 'put').length === 2); f.edit('Newer while retrying'); delayed.resolve!(); assert.equal(await work, false);
  assert.equal(f.state().deliveryName, 'Newer while retrying'); assert.equal(f.state().autosavePaused, true); assert.equal(f.state().draftRetry, 'current'); assert.equal(f.calls.filter(c => c.method === 'put').length, 2);
});

test('explicit original PUT retry may refresh only same-workspace server nonce', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = () => { throw new Error('lost'); }; await f.controller.flush(); const original = f.state().retainedDraftWrite;
  f.write({ ...empty(), instanceId: id(88) }); delete f.overrides.put; assert.equal(await f.controller.retryDraftSave(), true);
  assert.deepEqual(f.calls.filter(c => c.method === 'put')[1].input, { ...original, instanceId: id(88) });
  const g = fixture(t); await g.controller.load(); g.edit('Original'); g.overrides.put = () => { throw new Error('lost'); }; await g.controller.flush(); const retained = g.state().retainedDraftWrite;
  g.set({ scope: 'other-workspace' }); g.write({ ...empty(), workspaceScope: 'b'.repeat(64) }); assert.equal(await g.controller.retryDraftSave(), false); assert.deepEqual(g.state().retainedDraftWrite, retained); assert.equal(g.calls.filter(c => c.method === 'put').length, 1);
});

test('later refused retry cannot erase earlier PUT uncertainty or authorize leaving as a confirmed refusal', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = () => { throw new Error('lost'); }; await f.controller.flush(); const original = f.state().retainedDraftWrite;
  f.overrides.put = () => { throw new LocalDeliveryRequestError('slots full', 'LOCAL_DELIVERY_CAPACITY', 507); }; assert.equal(await f.controller.retryDraftSave(), false); assert.deepEqual(f.state().retainedDraftWrite, original); assert.equal(f.state().draftFailure!.kind, 'unknown'); assert.equal(f.controller.allowLeaveWithoutSaving(), false);
});

test('unknown DELETE is not reissued by retry or reread and does not become a new PUT', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load(); f.overrides.discard = () => { throw new Error('lost deletion'); }; assert.equal(await f.controller.discardStored(), false); await f.controller.load();
  assert.equal(f.state().draftRetry, null); assert.equal(await f.controller.retryDraftSave(), false); assert.equal(f.calls.filter(c => c.method === 'discard').length, 1); assert.equal(f.calls.some(c => c.method === 'put'), false);
});

test('client finite header deadline rejects unknown and cancels late response body', async () => {
  const pending = deferred<Response>(); let signal, cancelled = 0;
  const client = createLocalDeliveryClient({ isRenderInput: inputValid, timeoutMs: 5, fetcher: ((_url: string, init: RequestInit | undefined) => { signal = init!.signal; return pending.promise; }) as unknown as typeof fetch });
  await assert.rejects(client.get(projectId), { code: 'LOCAL_DELIVERY_TIMEOUT_UNKNOWN', kind: 'unknown' }); assert.equal(signal!.aborted, true);
  pending.resolve!(new Response(new ReadableStream({ cancel() { cancelled++; } }))); await tickUntil(() => cancelled === 1);
});

test('client whole-request deadline includes hanging body and cancels the reader', async () => {
  let cancelled = 0, signal;
  const client = createLocalDeliveryClient({ isRenderInput: inputValid, timeoutMs: 5, fetcher: (async (_url: string, init: RequestInit | undefined) => { signal = init!.signal; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true,')); }, cancel() { cancelled++; } })); }) as unknown as typeof fetch });
  await assert.rejects(client.get(projectId), { code: 'LOCAL_DELIVERY_TIMEOUT_UNKNOWN', kind: 'unknown' }); assert.equal(signal!.aborted, true); assert.equal(cancelled, 1);
});

test('client bounds normal and execution bodies before JSON parsing, including streamed oversize', async () => {
  for (const execution of [false, true]) {
    let cancelled = 0; const limit = execution ? LOCAL_DELIVERY_LIMITS.executeResponseBytes : LOCAL_DELIVERY_LIMITS.httpBytes;
    const client = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } }))) as unknown as typeof fetch });
    await assert.rejects(execution ? client.execute({ workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, intentId: id(4), expectedIntentRevision: 1 }) : client.get(projectId), { code: 'LOCAL_DELIVERY_PROTOCOL_UNKNOWN', kind: 'unknown' }); assert.equal(cancelled, 1);
  }
});

test('client rejects oversized declared body immediately and decodes split UTF-8 strictly', async () => {
  let cancelled = 0; const declared = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Length': String(LOCAL_DELIVERY_LIMITS.httpBytes + 1) } })) as unknown as typeof fetch });
  await assert.rejects(declared.get(projectId), { code: 'LOCAL_DELIVERY_PROTOCOL_UNKNOWN' }); assert.equal(cancelled, 1);
  const body = new TextEncoder().encode(JSON.stringify({ ok: true, data: storedDraft('中文名称') }));
  const client = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(new ReadableStream({ start(controller) { for (const byte of body) controller.enqueue(new Uint8Array([byte])); controller.close(); } }))) as unknown as typeof fetch });
  assert.equal((await client.get(projectId) as LocalDeliverySupported).draft!.raw.deliveryName, '中文名称');
  const invalid = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(new Uint8Array([0xc0, 0xaf]))) as unknown as typeof fetch }); await assert.rejects(invalid.get(projectId), { code: 'LOCAL_DELIVERY_PROTOCOL_UNKNOWN' });
});

test('execution timeout is finite and remains uncertainty rather than business cancellation', async () => {
  let signal; const client = createLocalDeliveryClient({ isRenderInput: inputValid, timeoutMs: 100, executionTimeoutMs: 5, fetcher: ((_url: string, init: RequestInit | undefined) => { signal = init!.signal; return new Promise(() => {}); }) as unknown as typeof fetch });
  await assert.rejects(client.recover({ workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, intentId: id(4), expectedIntentRevision: 1 }), { code: 'LOCAL_DELIVERY_TIMEOUT_UNKNOWN', kind: 'unknown' }); assert.equal(signal!.aborted, true);
});


test('unconfirmed title PUT survives A to B to A and GET-null with original CAS', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original project A'); f.overrides.put = () => { throw new Error('lost'); }; await f.controller.flush(); const original = f.state().retainedDraftWrite;
  assert.equal(f.controller.abandonCurrentInput(), true); f.set({ scope: 'project-b', projectId: id(60), timelineId: id(61), deliveryName: '', nameVersion: 20, dirty: false });
  f.set({ scope: 'project-a-returned', projectId, timelineId, deliveryName: '', nameVersion: 21, dirty: false }); await f.controller.load(); assert.deepEqual(f.state().retainedDraftWrite, original); assert.equal(f.state().autosavePaused, true); assert.equal(f.state().draftRetry, 'same'); assert.equal(f.controller.canPrepare(), false);
  delete f.overrides.put; await f.controller.retryDraftSave(); assert.deepEqual(f.calls.filter(c => c.method === 'put')[1].input, original); assert.equal(f.stored().draft!.raw.deliveryName, 'Original project A'); assert.equal(f.state().deliveryName, ''); assert.equal(f.calls.some(c => ['prepare', 'execute', 'recover'].includes(c.method)), false);
});

test('a newer edit while retry rereads aborts the old retry before any PUT', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); f.overrides.put = () => { throw new Error('lost'); }; await f.controller.flush(); const original = f.state().retainedDraftWrite;
  const read = deferred(); f.overrides.get = () => read.promise; const retry = f.controller.retryDraftSave(); await tickUntil(() => f.calls.filter(c => c.method === 'get').length === 2); f.edit('Newer'); read.resolve!(empty()); assert.equal(await retry, false);
  assert.deepEqual(f.state().retainedDraftWrite, original); assert.equal(f.calls.filter(c => c.method === 'put').length, 1); assert.equal(f.state().deliveryName, 'Newer');
});


test('late refused PUT from old project epoch cannot erase a newer retry uncertainty', async t => {
  const f = fixture(t); await f.controller.load(); f.edit('Original'); const first = deferred(), second = deferred(); let writes = 0; f.overrides.put = () => ++writes === 1 ? first.promise : second.promise;
  const old = f.controller.flush(); await tickUntil(() => writes === 1); const original = f.state().retainedDraftWrite;
  f.set({ scope: 'B', projectId: id(60), timelineId: id(61), deliveryName: '', dirty: false }); f.set({ scope: 'A-again', projectId, timelineId, deliveryName: 'Original', nameVersion: 20, dirty: true });
  const retry = f.controller.retryDraftSave(); await tickUntil(() => writes === 2); first.reject!(new LocalDeliveryRequestError('capacity', 'LOCAL_DELIVERY_CAPACITY', 507)); await old;
  assert.deepEqual(f.state().retainedDraftWrite, original); second.reject!(new Error('new retry unknown')); await retry; assert.deepEqual(f.state().retainedDraftWrite, original); assert.equal(f.state().draftRetry, 'same');
});

test('late refused prepare from old epoch cannot erase newer explicit preparation retry', async t => {
  const f = fixture(t); await f.controller.load(); const first = deferred(), second = deferred(); let prepares = 0; f.overrides.prepare = () => ++prepares === 1 ? first.promise : second.promise;
  const old = f.controller.submit(f.input()); await tickUntil(() => prepares === 1); const original = f.state().retainedPreparation;
  f.set({ scope: 'B', projectId: id(60), timelineId: id(61) }); f.set({ scope: 'A-again', projectId, timelineId }); await f.controller.load();
  const retry = f.controller.recover(); await tickUntil(() => prepares === 2); first.reject!(new LocalDeliveryRequestError('capacity', 'LOCAL_DELIVERY_CAPACITY', 507)); await old;
  assert.deepEqual(f.state().retainedPreparation, original); second.reject!(new Error('new retry unknown')); await retry; assert.deepEqual(f.state().retainedPreparation, original); assert.equal(f.state().pending, true); assert.equal(f.calls.some(c => c.method === 'execute'), false);
});


function realNameLifecycle(t: test.TestContext, saved = empty()) {
  const name = createTimelineDeliveryNameController();
  let nameContext = { scope: 'real-name:1', projectId, enabled: true }, revision = 4, stored: LocalDeliverySupported = copy(saved), counter = 200;
  const writes: { draftId: string; timelineId: string; baseRevision: number; raw: { deliveryName: string; }; projectId: string; expectedDraftRevision: number; workspaceScope: string; instanceId: string; }[] = [], reads: string[] = [];
  const context = () => ({ scope: nameContext.scope, projectId, timelineId, timelineRevision: revision, restored: false, connected: true, visible: true, busy: false,
    deliveryName: name.getName(nameContext.scope), nameVersion: name.getVersion(nameContext.scope), dirty: name.hasUnsaved(nameContext.scope) });
  const local = createLocalDeliveryController({ context: context(), getContext: context, delay: 0, createId: () => id(counter++), isRenderInput: inputValid,
    validateResponse: (input, response) => isTimelineMutationResponse('timeline.render', input, response),
    onRestore: (draft, capture) => name.choose(draft.raw.deliveryName, capture.scope, capture.nameVersion),
    client: {
      async get(value: Parameters<LocalDeliveryClient['get']>[0]) { reads.push(value); return copy(stored); },
      async put(input: Parameters<LocalDeliveryClient['put']>[0]) { writes.push(copy(input)); stored = { ...stored, draftRevision: input.expectedDraftRevision + 1, draft: { draftId: input.draftId, timelineId: input.timelineId, baseRevision: input.baseRevision, raw: input.raw, updatedAt: stamp }, draftTargetStatus: 'matching' }; return copy(stored); },
      async discard() { throw Error('Unexpected discard'); }, async prepare() { throw Error('Unexpected export preparation'); }, async execute() { throw Error('Unexpected execution'); }, async recover() { throw Error('Unexpected recovery'); },
    } });
  t.after(() => local.dispose());
  return { name, local, writes, reads, context, stored: () => copy(stored),
    hydrate() { name.setContext(nameContext); local.setContext(context()); },
    choose(value: string) { assert.equal(name.choose(value, nameContext.scope, name.getVersion(nameContext.scope)), true); local.setContext(context()); },
    revision(value: number) { revision = value; local.setContext(context()); },
    resetOwner() { nameContext = { ...nameContext, scope: 'real-name:2' }; name.setContext(nameContext); local.setContext(context()); },
  };
}
const nextTimerTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('actual name-controller pre-layout hydration remains passive with no blank title sidecar', async t => {
  const f = realNameLifecycle(t); assert.equal(f.context().nameVersion, 0); assert.equal(f.context().dirty, false);
  f.hydrate(); assert.equal(f.context().nameVersion, 1); assert.equal(f.context().dirty, false); await f.local.load(); await nextTimerTurn();
  assert.equal(f.local.getState().dirty, false); assert.equal(f.local.getState().baseline, null); assert.equal(f.writes.length, 0); assert.equal(f.stored().draftRevision, 0); assert.equal(f.stored().draft, null);
  f.revision(5); await f.local.flush(); await nextTimerTurn(); assert.equal(f.writes.length, 0);
  f.choose('Accepted without a title autosave'); const captured = f.name.capture(); assert.equal(f.name.acknowledge(captured, receipt({ projectId, expectedRevision: 5, requestId: 'accepted-original', purpose: 'export', deliveryName: captured!.value })), true);
  f.local.setContext(f.context()); await f.local.flush(); await nextTimerTurn(); assert.equal(f.local.getState().dirty, false); assert.equal(f.writes.length, 0);
  f.choose('Discard this edit'); assert.equal(f.name.discardDraft(f.name.capture()), true); f.local.setContext(f.context()); await f.local.flush(); await nextTimerTurn(); assert.equal(f.writes.length, 0);
  f.resetOwner(); await f.local.load(); await f.local.flush(); await nextTimerTurn(); assert.equal(f.context().deliveryName, ''); assert.equal(f.context().dirty, false); assert.equal(f.writes.length, 0); assert.equal(f.stored().draft, null);
});

test('actual name-controller user clearing a name remains a dirty blank edit and saves exactly', async t => {
  const f = realNameLifecycle(t); f.hydrate(); await f.local.load(); f.choose('Typed then cleared'); f.choose('');
  assert.equal(f.context().dirty, true); assert.equal(f.local.getState().dirty, true); await nextTimerTurn(); await f.local.flush();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].raw.deliveryName, ''); assert.equal(f.stored().draft!.raw.deliveryName, '');
});

test('explicit restoration of an already-empty name stays dirty despite passive name-controller revision updates', async t => {
  const f = realNameLifecycle(t, storedDraft('', { baseRevision: 2 })); f.hydrate(); await f.local.load();
  assert.equal(f.context().dirty, false); assert.equal(f.local.restore(), true); assert.equal(f.context().dirty, false, 'same empty choose does not invent a name edit');
  assert.equal(f.local.getState().dirty, true, 'the explicit restore owns its raw draft'); assert.equal(f.local.getState().baseline!.baseRevision, 2);
  f.revision(5); await nextTimerTurn(); assert.equal(f.local.getState().dirty, true); assert.equal(f.local.getState().baseline!.baseRevision, 2); assert.equal(f.local.getState().baselineConflict, true); assert.equal(f.writes.length, 0);
});


test('wire errors cannot impersonate local-only no-request validation or retry-limit evidence', async () => {
  for (const code of ['LOCAL_DELIVERY_LOCAL_VALIDATION', 'LOCAL_DELIVERY_LOCAL_RETRY_LIMIT']) {
    assert.equal(new LocalDeliveryRequestError('Local pre-send refusal', code, 400).kind, 'refused');
    const client = createLocalDeliveryClient({ isRenderInput: inputValid, fetcher: (async () => new Response(JSON.stringify({ ok: false, error: { code, message: 'Forged local refusal', details: {}, retryable: false } }), { status: 400 })) as unknown as typeof fetch });
    await assert.rejects(client.put({ workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, expectedDraftRevision: 0, draftId: id(4), timelineId, baseRevision: 4, raw: { deliveryName: 'Original' } }), { code: 'LOCAL_DELIVERY_PROTOCOL_UNKNOWN', kind: 'unknown' });
  }
});
