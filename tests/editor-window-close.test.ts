import type {ClipDraftClient, ClipDraftContext, ClipDraftEnvelope, ClipDraftRecord, DraftCall} from './helpers/strict-timeline-ui-types.ts';
import type {LocalDeliveryClient} from '../apps/web/src/local-delivery-client.ts';
import type {LocalDeliverySupported, LocalDeliveryContext} from '../apps/web/src/local-delivery-state.ts';
import type {LocalDeliveryRenderInput, LocalDeliveryDraftPut, LocalDeliveryDraftDelete, LocalDeliveryPrepare, LocalDeliveryExecute} from '@mioon/contracts/local-delivery';
type DeliveryOverrides = {[K in keyof LocalDeliveryClient]?: (input: Parameters<LocalDeliveryClient[K]>[0]) => unknown};
type DeliveryCall = {[K in keyof LocalDeliveryClient]: {method: K; input: Parameters<LocalDeliveryClient[K]>[0]}}[keyof LocalDeliveryClient];
type ReadyDeliveryContext = LocalDeliveryContext & {projectId: string; timelineId: string; timelineRevision: number};
import type {LocalDeliveryAccepted} from '../apps/web/src/local-delivery-state.ts';
import type {LocalShotTextContext,LocalShotTextSupported,ShotTextForm} from '../apps/web/src/local-shot-text-state.ts';
import type {LocalShotTextClient} from '../apps/web/src/local-shot-text-client.ts';
import type {LocalShotTextDraftPut,LocalShotTextDraftDelete,LocalShotTextPrepare,LocalShotTextExecute,LocalShotTextResponseTarget,LocalShotTextDraftRaw,LocalShotTextDraftValue} from '../packages/contracts/src/local-shot-text.ts';
type TextOverrides=Partial<{[K in keyof LocalShotTextClient]:(...args:Parameters<LocalShotTextClient[K]>)=>unknown}>;
type TextCall={method:'get';projectId:string;shotId:string}|{method:'put';input:LocalShotTextDraftPut}|{method:'discard';input:LocalShotTextDraftDelete}|{method:'prepare';input:LocalShotTextPrepare}|{method:'execute'|'recover';input:LocalShotTextExecute};
import type {LocalShotTextAccepted} from '../apps/web/src/local-shot-text-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, isTimelineMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import { LocalDeliveryRequestError } from '../apps/web/src/local-delivery-client.ts';
import { createLocalShotTextController, createLocalShotTextRetention } from '../apps/web/src/local-shot-text-state.ts';
import { LocalShotTextRequestError } from '../apps/web/src/local-shot-text-client.ts';
import { createClipDraftController, type ClipDraftState } from '../apps/web/src/clip-draft-state.ts';
import { createExportSettingsController } from '../apps/web/src/export-settings-state.ts';
import { createExportRangeController } from '../apps/web/src/export-range-state.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS } from '@mioon/contracts';
import { readEditorWindowClose, type EditorWindowCloseSnapshot } from '../apps/web/src/editor-window-close.ts';

const sameIdentity = (a: EditorWindowCloseSnapshot, b: EditorWindowCloseSnapshot) => a.identity.length === b.identity.length && a.identity.every((value, index) => Object.is(value, b.identity[index]));
const deferred = <T = unknown>() => { let resolve!: (value?: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes as (value?: T) => void; reject = no; }); return { promise, resolve, reject }; };
const until = async (predicate: () => unknown) => { for (let index = 0; index < 60 && !predicate(); index++) await Promise.resolve(); assert.ok(predicate()); };

// Real controller fixtures with strict matching ACKs; no controller substitute.
const deliveryFixtures = (() => {
const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), stamp = '2026-10-12T00:00:00.000Z';
const inputValid = (value: unknown) => schemas['timeline.render'].safeParse(value).success;
const copy = <T>(value: T): T => structuredClone(value);
const deferred = <T = unknown>() => { let resolve!: (value?: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes as (value?: T) => void; reject = no; }); return { promise, resolve, reject }; };
const empty = () : LocalDeliverySupported => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset' });
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
  function settle() { const response = receipt((stored.intent)!.input); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent!, outcome: { status: 'accepted', exportId: response.id, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, ...(stored.draft ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalDeliveryController({ context, getContext: () => context, client: client as LocalDeliveryClient, isRenderInput: inputValid, validateResponse: (input, result) => isTimelineMutationResponse('timeline.render', input, result),
    validateNotApplied: (input, code) => hasRequestNotAppliedProof({ code, status: 409, details: { mutationOutcome: 'not_applied', operation: 'timeline.render', projectId: input.projectId, requestId: input.requestId } }, input, { operation: 'timeline.render' }),
    createId: () => id(nextId++), delay: 60000, onRestore(draft, capture) { if (context.nameVersion !== capture.nameVersion) return false; context = { ...context, deliveryName: draft.raw.deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; return true; }, onAccepted: (value => accepted.push(value)) as (value: LocalDeliveryAccepted) => void });
  t.after(() : void => controller.dispose());
  return { controller, calls, accepted, overrides, state: () => controller.getState(), stored: () => copy(stored), write(value: unknown) { stored = copy(value) as typeof stored; }, set(patch: { connected?: boolean; visible?: boolean; timelineRevision?: number; scope?: string; projectId?: string; timelineId?: string; dirty?: boolean; deliveryName?: string; nameVersion?: number; }, notify: boolean = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(deliveryName: string) { context = { ...context, deliveryName, nameVersion: context.nameVersion + 1, dirty: true }; controller.setContext(context); }, input: () => ({ projectId: context.projectId, expectedRevision: context.timelineRevision, requestId: 'original-request', purpose: 'export' as const, ...(context.deliveryName === '' ? {} : { deliveryName: context.deliveryName }) }) };
}
const storedDraft = (raw: string = '  Saved draft  ', patch: Partial<NonNullable<LocalDeliverySupported['draft']>> = {}) : LocalDeliverySupported => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), timelineId, baseRevision: 4, raw: { deliveryName: raw }, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
const tickUntil = async (condition: { (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): boolean; (): unknown; }) => { for (let i = 0; i < 30 && !condition(); i++) await Promise.resolve(); assert.ok(condition()); };

return { fixture, empty, storedDraft, id, projectId, timelineId };
})();

// Real controller fixtures with strict matching ACKs; no controller substitute.
const shotFixtures = (() => {
const id = (n: number) => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), stamp = '2026-10-12T00:00:00.000Z', baseText = { title: 'Saved title', prompt: 'Saved prompt' };
const valid = (value: unknown) => schemas['shot.update'].safeParse(value).success;
const copy = <T>(value: T): T => structuredClone(value);
const deferred = <T = unknown>() => { let resolve!: (value?: T) => void; const promise = new Promise<T>(done => { resolve = done as (value?: T) => void; }); return { promise, resolve }; };
const empty = () : LocalShotTextSupported => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, shotId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset', projectPendingIntent: null });
const storedDraft = (raw: unknown = { title: 'Draft title', prompt: '' }, patch: Record<string, unknown> = {}) => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), baseRevision: 4, baseText, raw, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
function receipt(intent: LocalShotTextResponseTarget) { return { id: shotId, projectId, revision: intent.baseRevision + 1, ...intent.baseText, ...intent.input.patch, duration: 7, aspectRatio: '16:9', parameters: { seed: 42 }, referenceAssetIds: [] }; }
const until = async (predicate: { (): boolean; (): boolean; (): boolean; (): unknown; }) => { for (let i = 0; i < 40 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate()); };
function fixture(t: test.TestContext, options: {context?:Partial<LocalShotTextContext>;stored?:unknown;retention?:ReturnType<typeof createLocalShotTextRetention>;acknowledge?:boolean} = {}) {
  let context: LocalShotTextContext = { scope: 'project:1', projectId, shotId, revision: 4, baseRevision: 4, baseText, savedText: baseText, restored: false, connected: true, visible: true, busy: false,
    raw: copy(baseText), textVersion: 1, formSerial: 0, textDirty: false, formDirty: false, executionEpoch: 'owner-action', ...options.context };
  let stored: LocalShotTextSupported = copy(options.stored ?? empty()) as LocalShotTextSupported, nextId = 100;
  const calls: TextCall[] = [], accepted: (LocalShotTextAccepted)[] = [], overrides: TextOverrides = {};
  const client = {
    async get(project: string, shot: string) { calls.push({ method: 'get', projectId: project, shotId: shot }); return overrides.get ? overrides.get(project, shot) : copy(stored); },
    async put(input: LocalShotTextDraftPut) {
      calls.push({ method: 'put', input: copy(input) }); if (overrides.put) return overrides.put(input);
      const expected = { draftId: input.draftId, baseRevision: input.baseRevision, baseText: copy(input.baseText), raw: copy(input.raw), updatedAt: stamp };
      if (stored.draftRevision === input.expectedDraftRevision + 1 && JSON.stringify(stored.draft) === JSON.stringify(expected)) return copy(stored);
      if (stored.draftRevision !== input.expectedDraftRevision || stored.draft && (stored.draft.draftId !== input.draftId || stored.draft.baseRevision !== input.baseRevision || JSON.stringify(stored.draft.baseText) !== JSON.stringify(input.baseText))) throw new LocalShotTextRequestError('conflict', 'LOCAL_SHOT_TEXT_CONFLICT', 409);
      stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: expected, draftTargetStatus: input.baseRevision === context.revision ? 'matching' : 'changed' }; return copy(stored);
    },
    async discard(input: LocalShotTextDraftDelete) { calls.push({ method: 'discard', input: copy(input) }); if (overrides.discard) return overrides.discard(input); stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' }; return copy(stored); },
    async prepare(input: LocalShotTextPrepare) { calls.push({ method: 'prepare', input: copy(input) }); if (overrides.prepare) return overrides.prepare(input); return prepare(input); },
    async execute(input: LocalShotTextExecute) { calls.push({ method: 'execute', input: copy(input) }); return overrides.execute ? overrides.execute(input) : settle(); },
    async recover(input: LocalShotTextExecute) { calls.push({ method: 'recover', input: copy(input) }); return overrides.recover ? overrides.recover(input) : settle(); },
  };
  function prepare(input: LocalShotTextPrepare) { stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { intentId: input.intentId, baseRevision: input.baseRevision, baseText: copy(input.baseText), draft: copy(input.draft), input: copy(input.input), createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching', projectPendingIntent: { shotId, intentId: input.intentId } }; return copy(stored); }
  function settle() { const response = receipt(stored.intent!); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent!, outcome: { status: 'applied', shotRevision: response.revision, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, projectPendingIntent: null,
    ...(stored.draft && stored.draftRevision === stored.intent!.draft.revision && JSON.stringify(stored.draft.raw) === JSON.stringify(stored.intent!.draft.raw) ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalShotTextController({ context, getContext: () => context, retention: options.retention, client: client as LocalShotTextClient, isShotUpdateInput: valid, delay: 60000, createId: () => id(nextId++),
    onRestore(draft, token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, raw: copy(draft.raw), baseRevision: draft.baseRevision, baseText: copy(draft.baseText), textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; return true; },
    onRebase(token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, baseRevision: context.revision, baseText: copy(context.savedText) }; return true; },
    onAccepted(value) { accepted.push(value); return options.acknowledge !== false; } });
  t.after(() => controller.dispose());
  return { controller, calls, accepted, overrides, client, prepare, settle, state: () => controller.getState(), context: () => copy(context), stored: () => copy(stored), write(value: unknown) { stored = copy(value) as typeof stored; },
    set(patch: Partial<LocalShotTextContext>, notify: boolean = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(patch: { title?: string; prompt?: string; }) { context = { ...context, raw: { ...context.raw, ...patch }, textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; controller.setContext(context); } };
}

return { fixture, empty, storedDraft, id, projectId, shotId };
})();

// Real controller fixtures with strict matching ACKs; no controller substitute.
const clipFixtures = (() => {
const id = (n: number) => `d2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T21:00:00.000Z';
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const source = { assetId: id(5), assetSha256: 'b'.repeat(64), versionId: id(8) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 120, sourceInFrame: 0,
  rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
const context = () => ({ ...key, scope: 'project:1:inspector:1', restored: false, connected: true, visible: true,
  busy: false, timelineRevision: 7, source: structuredClone(source), saved: structuredClone(raw) });
const record = (patch: Partial<ClipDraftRecord> = {}): ClipDraftRecord => ({ baseRevision: 7, source: structuredClone(source), raw: { ...structuredClone(raw), name: 'Recovered' }, updatedAt: stamp, ...patch });
const row = (draft: ClipDraftRecord | null = null): ClipDraftEnvelope => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(6), key,
  revision: draft ? 1 : 0, targetStatus: 'matching', draft });
const deferred = <T = unknown>() => { let resolve!: (value?: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes as (value?: T) => void; reject = no; }); return { promise, resolve, reject }; };
const turn = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const ack = (input: Parameters<ClipDraftClient['put']>[0]): ClipDraftEnvelope => ({ ...row(), revision: input.expectedRevision + 1,
  draft: record({ raw: structuredClone(input.raw), source: structuredClone(input.source), baseRevision: input.baseRevision }) });

function harness(t: { after: (arg0: () => void) => void; }, { draft = null, ctx = context(), hooks = {} }: {draft?: ClipDraftRecord | null; ctx?: ClipDraftContext; hooks?: {[K in keyof ClipDraftClient]?: (input: Parameters<ClipDraftClient[K]>[0], current: ClipDraftEnvelope) => unknown}} = {}) {
  let saved = row(draft);
  const calls: DraftCall[] = [], changes: ClipDraftState[] = [];
  const client = {
    async get(input: Parameters<ClipDraftClient['get']>[0]) { calls.push(['get', structuredClone(input)]); return hooks.get ? hooks.get(input, structuredClone(saved)) : structuredClone(saved); },
    async put(input: Parameters<ClipDraftClient['put']>[0]) {
      calls.push(['put', structuredClone(input)]);
      if (hooks.put) return hooks.put(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision); assert.equal(input.instanceId, saved.instanceId); assert.equal(input.workspaceScope, saved.workspaceScope);
      saved = ack(input); return structuredClone(saved);
    },
    async remove(input: Parameters<ClipDraftClient['remove']>[0]) {
      calls.push(['delete', structuredClone(input)]);
      if (hooks.remove) return hooks.remove(input, structuredClone(saved));
      assert.equal(input.expectedRevision, saved.revision);
      saved = { ...saved, revision: input.expectedRevision + 1, draft: null }; return structuredClone(saved);
    },
  };
  const controller = createClipDraftController({ context: ctx, client: client as ClipDraftClient, delay: 60000, onChange: next => changes.push(structuredClone(next)) });
  t.after(() => controller.dispose());
  return { controller, calls, changes, ctx, current: () => structuredClone(saved), replace: (next: ClipDraftEnvelope) => { saved = structuredClone(next); },
    puts: () => calls.filter(([method]) => method === 'put').map(([, input]) => input as Parameters<ClipDraftClient['put']>[0]) };
}

return { harness, row, record, ack, context };
})();

for (const lane of ['clip', 'shot', 'delivery']) test(`${lane} pure close reads have no sync, callbacks, transport or timer effects`, async t => {
  const f = lane === 'clip' ? clipFixtures.harness(t) : lane === 'shot' ? shotFixtures.fixture(t) : deliveryFixtures.fixture(t);
  await f.controller.load();
  if (lane === 'clip') (f as ReturnType<typeof clipFixtures.harness>).controller.edit('name', 'Private name'); else if (lane === 'shot') (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'Private title', prompt: 'Private prompt' }); else (f as ReturnType<typeof deliveryFixtures.fixture>).edit('Private delivery');
  const before = readEditorWindowClose({ [lane]: f.controller }), state = f.controller.getState(), calls = f.calls.length;
  for (const name of ['hasUnsaved', 'hasUnpersisted', 'capture', 'isCurrent', 'setContext', 'flush', 'flushForClose']) {
    if (typeof (f.controller as Record<string, unknown>)[name] === 'function') t.mock.method(f.controller as unknown as Record<string, () => unknown>, name, () => assert.fail(`Close called ${name}`));
  }
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout; let timers = 0;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof set>) => { timers++; return set(...args); });
  t.mock.method(globalThis, 'clearTimeout', (...args: Parameters<typeof clear>) => { timers++; return clear(...args); });
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
  const edit = (value: string) => lane === 'clip' ? (f as ReturnType<typeof clipFixtures.harness>).controller.edit('name', value) : lane === 'shot' ? (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: value }) : (f as ReturnType<typeof deliveryFixtures.fixture>).edit(value);
  edit('A'); const a = readEditorWindowClose({ [lane]: f.controller }); edit('B'); const b = readEditorWindowClose({ [lane]: f.controller });
  assert.equal(a.dirty, true); assert.equal(b.dirty, true); assert.equal(sameIdentity(a, b), false);
  const replacement = make(); assert.equal(sameIdentity(b, readEditorWindowClose({ [lane]: replacement.controller })), false);
});

for (const lane of ['clip', 'shot', 'delivery']) test(`${lane} exact sidecar ACK permits stable input identity but does not waive dirty confirmation`, async t => {
  const f = lane === 'clip' ? clipFixtures.harness(t) : lane === 'shot' ? shotFixtures.fixture(t) : deliveryFixtures.fixture(t);
  await f.controller.load();
  if (lane === 'clip') (f as ReturnType<typeof clipFixtures.harness>).controller.edit('name', 'A'); else if (lane === 'shot') (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'A' }); else (f as ReturnType<typeof deliveryFixtures.fixture>).edit('A');
  const before = readEditorWindowClose({ [lane]: f.controller });
  await (lane === 'clip' ? (f as ReturnType<typeof clipFixtures.harness>).controller.flushForClose() : f.controller.flush());
  const after = readEditorWindowClose({ [lane]: f.controller });
  assert.equal(after.blocked, false); assert.equal(after.dirty, true); assert.equal(sameIdentity(before, after), true);
  assert.equal(f.calls.some(call => ['prepare', 'execute', 'recover'].includes((call as {method?: string}).method!)), false);
});

test('delivery lost preparation blocks even when legacy hasUnsaved is false, and explicit recovery releases it', async t => {
  const f = deliveryFixtures.fixture(t); await f.controller.load();
  f.overrides.prepare = () => { throw Error('Lost preparation'); }; assert.equal(await f.controller.submit(f.input()), null);
  assert.equal(f.controller.hasUnsaved(), false); assert.equal(f.state().intentUncertain, true);
  assert.deepEqual(readEditorWindowClose({ delivery: f.controller }).reasons, ['delivery-unknown']);
  assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(readEditorWindowClose({ delivery: f.controller }).blocked, true);
  delete f.overrides.prepare; assert.ok(await f.controller.recover());
  assert.equal((f.state().intent)!.outcome.status, 'accepted'); assert.equal((f.accepted[0].response as {status: string}).status, 'queued');
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
  (held.reject)!(Error('Lost delete')); assert.equal(await deleting, false);
  assert.equal((f.state().draftFailure)!.kind, 'unknown'); assert.equal(f.state().draftRetry, null);
  assert.equal(f.controller.abandonCurrentInput(), true); assert.deepEqual(readEditorWindowClose({ delivery: f.controller }).reasons, ['delivery-unknown']);
  // The existing controller has no retained delete CAS/reconciliation API.
  // The guard must expose this limitation rather than invent an ACK or clear.
});

test('shot retained hidden-slot identity catches one-for-one replacement and never contains draft text', async t => {
  const retention = createLocalShotTextRetention(), f = shotFixtures.fixture(t, { retention }); await f.controller.load(); (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'Secret title' });
  f.overrides.put = () => { throw Error('Lost write'); }; await f.controller.flush();
  assert.equal(retention.writes.size, 1); const [key, request] = [...retention.writes][0];
  f.set({ shotId: shotFixtures.id(88), scope: 'other-shot', textDirty: false, formDirty: false });
  assert.equal(f.state().retainedDraftWrite, null); const before = readEditorWindowClose({ shot: f.controller }); assert.equal(before.blocked, true);
  retention.writes.set(key, { ...request, draftId: shotFixtures.id(99) });
  const after = readEditorWindowClose({ shot: f.controller }); assert.equal(after.blocked, true); assert.equal(retention.writes.size, 1);
  assert.equal(sameIdentity(before, after), false); assert.doesNotMatch(JSON.stringify(after.identity), /Secret title/);
});

test('shot lost preparation remains blocked after abandonment and resolves only through exact recovery', async t => {
  const f = shotFixtures.fixture(t); await f.controller.load(); (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'Edited' });
  f.overrides.prepare = () => { throw Error('Lost prepare'); }; await f.controller.submit();
  assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(f.controller.hasUnsaved(), false);
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true);
  delete f.overrides.prepare; assert.ok(await f.controller.recover());
  assert.equal((f.state().intent)!.outcome.status, 'applied'); assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, false);
});

test('shot pending deletion survives abandonment; exact deletion retry releases retained owner', async t => {
  const f = shotFixtures.fixture(t, { stored: shotFixtures.storedDraft() }); await f.controller.load();
  const held = deferred(); f.overrides.discard = () => held.promise;
  const deleting = f.controller.discardStored(); assert.ok(readEditorWindowClose({ shot: f.controller }).reasons.includes('shot-inflight'));
  (held.reject)!(Error('Lost delete')); await deleting; assert.equal(f.controller.abandonCurrentInput(), true);
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true); delete f.overrides.discard;
  assert.equal(await f.controller.retryDraftDeletion(), true); assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, false);
});

test('late shot PUT ACK cannot acknowledge a newer same-dirty programmatic edit', async t => {
  const f = shotFixtures.fixture(t); await f.controller.load(); (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'A' });
  const original = readEditorWindowClose({ shot: f.controller }), held = deferred(); let input: LocalShotTextDraftPut | undefined;
  f.overrides.put = value => { input = value; return held.promise; }; const writing = f.controller.flush();
  assert.equal(readEditorWindowClose({ shot: f.controller }).blocked, true); (f as ReturnType<typeof shotFixtures.fixture>).edit({ title: 'B' });
  (held.resolve)!({ ...shotFixtures.empty(), draftRevision: (input)!.expectedDraftRevision + 1,
    draft: { draftId: (input)!.draftId, baseRevision: (input)!.baseRevision, baseText: (input)!.baseText, raw: (input)!.raw, updatedAt: '2026-10-12T00:00:00.000Z' }, draftTargetStatus: 'matching' });
  assert.equal(await writing, false); const current = readEditorWindowClose({ shot: f.controller });
  assert.equal(current.blocked, false); assert.equal(current.dirty, true); assert.equal(f.state().raw.title, 'B'); assert.equal(sameIdentity(original, current), false);
});

test('clip live write, deletion and uncertain deletion survive dirty-false abandonment', async t => {
  const held = deferred(), h = clipFixtures.harness(t, { hooks: { put: () => held.promise } }); await h.controller.load(); h.controller.edit('name', 'A');
  const writing = h.controller.flush(); assert.ok(readEditorWindowClose({ clip: h.controller }).reasons.includes('clip-inflight'));
  (held.reject)!(Error('Lost write')); await writing; assert.equal(h.controller.abandonCurrentInput(h.controller.capture()), true);
  assert.equal(h.controller.hasUnsaved(), false); assert.equal(readEditorWindowClose({ clip: h.controller }).blocked, true);
  const deletion = deferred(), d = clipFixtures.harness(t, { draft: clipFixtures.record(), hooks: { remove: () => deletion.promise } }); await d.controller.load();
  const deleting = d.controller.discardStored(); assert.equal(d.controller.hasUnsaved(), false);
  assert.ok(readEditorWindowClose({ clip: d.controller }).reasons.includes('clip-inflight'));
  (deletion.reject)!(Error('Lost delete')); await deleting; assert.equal(readEditorWindowClose({ clip: d.controller }).blocked, true);
});

test('read-only transport failure without local owner does not invent an unresolved mutation', async t => {
  const delivery = deliveryFixtures.fixture(t), shot = shotFixtures.fixture(t);
  delivery.overrides.get = shot.overrides.get = () => { throw Error('Offline'); };
  const clip = clipFixtures.harness(t, { hooks: { get: () => { throw Error('Offline'); } } });
  await Promise.all([delivery.controller.load(), shot.controller.load(), clip.controller.load()]);
  assert.equal(readEditorWindowClose({ delivery: delivery.controller, shot: shot.controller, clip: clip.controller }).blocked, false);
});

test('App-injected import and mutation identities block create/update/delete uncertainty independently of dirty', () => {
  const owner = {}, external = (request: string, inflight: boolean, unknown: boolean) => ({ owner, dirty: false, inflight, unknown, identity: ['project:1', request] });
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
