import type {ClipDraftController,ClipDraftClient,ClipDraftWrite} from '../apps/web/src/clip-draft-state.ts';
type DraftCompile<N extends string>=N extends 'guardNavigation'?(message?:string)=>Promise<boolean>:N extends 'registerClipDraft'?(controller:object)=>()=>void:(operation:string,input:Record<string,unknown>,revision?:number)=>Promise<unknown>;
interface StoredDraft{supported:boolean;workspaceScope:string;instanceId:string;key:typeof key;revision:number;targetStatus:string;draft:{raw:ClipDraftRaw;source:ClipDraftWrite['source'];baseRevision:number;updatedAt:string}|null}
import { message as msg } from '../packages/i18n/src/index.ts';
import { actualAppCloseWarning } from './fixtures/native-close-app-warning.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClipDraftController, type ClipDraftCapture, type ClipDraftContext, type ClipDraftRaw, type ClipDraftState, type ClipVolumeCompositionToken } from '../apps/web/src/clip-draft-state.ts';
import { touchesLockedTrack } from '../apps/web/src/timeline-track-locks.ts';

import { lenientFunction, stripSourceTypes } from './helpers/eval-source.ts';
import type { OpacityEnvelopeComposition,RawOpacityEnvelope } from '../apps/web/src/clip-opacity-envelope-state.ts';
import type { VolumeEnvelopeComposition,RawVolumeEnvelope } from '../apps/web/src/clip-volume-envelope-state.ts';
import type { EditorCloseOwnerSnapshot } from '../apps/web/src/editor-window-close.ts';
const Function = lenientFunction;
// Execute the actual App callbacks with the real local-draft controller. Only
// the persistence transport and React state setters are synthetic boundaries.
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function section(start:string, end: string) {
  const at = app.indexOf(start), until = app.indexOf(end, at + start.length);
  assert.ok(at >= 0 && until > at, `Missing actual App extraction: ${start}`);
  assert.equal(app.indexOf(start, at + start.length), -1, `Ambiguous actual App extraction: ${start}`);
  return app.slice(at, until);
}
const guardSource = section('  async function guardNavigation(', '  async function guardProjectNavigation(');
const registrationSource = section('  const registerClipDraft = useCallback(', '  const [agentPage,');
const mutationSource = section('  async function mutateTimeline(', '  async function selectClip(');
const compile = <N extends string>(source:string,name:N,scope: { [s: string]: unknown; }|ArrayLike<unknown>) => Function('msg', ...Object.keys(scope), `${source}\nreturn ${name};`)(msg,...Object.values(scope)) as DraftCompile<N>;
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = (yes as (value?: T | PromiseLike<T>) => void); reject = no; }); return { promise, resolve, reject }; };
const id = (n: number) => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 90, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } };
const source = { assetId: id(5), assetSha256: 'a'.repeat(64) };
const stamp = '2026-10-12T00:00:00.000Z';

function draftFixture(t: test.TestContext) {
  let stored:StoredDraft = { supported: true, workspaceScope: 'b'.repeat(64), instanceId: id(6), key, revision: 0, targetStatus: 'matching', draft: null };
  let removeGate:ReturnType<typeof deferred>|null = null, removeError: Error|null = null;
  const writes: Parameters<ClipDraftClient["put"]>[0][] = [], removals: { projectId: string; timelineId: string; clipId: string; workspaceScope: string; instanceId: string; expectedRevision: number; }[] = [], removeEntered = deferred();
  const controller = createClipDraftController(({
    context: { ...key, scope: 'project:1:clip:1', restored: false, connected: true, busy: false, visible: true, timelineRevision: 7, source, saved: raw },
    delay: 60_000,
    client: {
      get: async () => structuredClone(stored),
      put:async(input:Parameters<ClipDraftClient["put"]>[0])=> {
        writes.push(structuredClone(input));
        assert.equal(input.expectedRevision, stored.revision);
        stored = { ...stored, revision: stored.revision + 1, draft: { raw: structuredClone(input.raw), source: input.source, baseRevision: input.baseRevision, updatedAt: stamp } };
        return structuredClone(stored);
      },
      remove:async(input:Parameters<ClipDraftClient["remove"]>[0])=> {
        removals.push(structuredClone(input)); removeEntered.resolve!();
        await removeGate?.promise;
        if (removeError) throw removeError;
        assert.equal(input.expectedRevision, stored.revision);
        stored = { ...stored, revision: stored.revision + 1, draft: null };
        return structuredClone(stored);
      },
    },
  } as unknown as Parameters<typeof createClipDraftController>[0]));
  t.after(() => controller.dispose());
  return {
    controller, writes, removals, removeEntered: removeEntered.promise,
    state: () => controller.getState(), stored: () => structuredClone(stored),
    async ready(name = 'Unsent clip') { await controller.load(); controller.edit('name', name); },
    holdRemove() { return removeGate = deferred(); },
    failRemove() { removeError = Error('Draft delete was not acknowledged'); },
  };
}

function appHarness(controller: ClipDraftController, { confirm = async () => true, dirty = false }: {confirm?:(message?:unknown)=>Promise<unknown>;dirty?:boolean} = {}) {
  const events: unknown[][] = [], resets: unknown[][] = [], owner = { projectId: key.projectId, epoch: 1 };
  const clipDraftRef:{current:ClipDraftController|null}={current:controller}, dirtyRef = { current: dirty };
  const subtitleState = { text: 'Separate subtitle draft' };
  const scope = {
    nativeWindow: null,
    shotTextRef: { current: null }, clipDraftRef, dirtyRef, context: () => ({ ...owner }),
    isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === owner.projectId && captured.epoch === owner.epoch,
    confirm: (message: unknown) => { events.push(['confirm', message]); return confirm(message); },
    subtitlesRef: { current: { controller: { getState: () => subtitleState, hasUnsaved: () => false, discardDraft: () => resets.push(['subtitle']) } } },
    subjectsRef: { current: { state: { scope: 'subject-owner' }, controller: { discardDrafts: (captured: unknown) => resets.push(['subjects', captured]) } } },
    ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, (value: (arg0: number) => unknown) => resets.push([name, typeof value === 'function' ? value(4) : value])])),
  };
  return { owner, scope, clipDraftRef, dirtyRef, events, resets, guard: compile(guardSource, 'guardNavigation', scope) };
}

test('actual App Cancel sees a synchronous clip edit before React rerender and preserves every draft', async t => {
  const f = draftFixture(t); await f.ready();
  const h = appHarness(f.controller, { confirm: async () => false });
  assert.equal(h.dirtyRef.current, false, 'React dirty state has not rerendered');
  assert.equal(await h.guard('Leave this clip?'), false);
  assert.deepEqual(h.events, [['confirm', 'Leave this clip?']]);
  assert.equal(f.state().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  assert.deepEqual((f.removals as unknown), []); assert.deepEqual((h.resets as unknown), []);
});

for (const editBack of [false, true]) {
  test(`actual App late confirmation rejects newer typing${editBack ? ' even when text changes back' : ''}`, async t => {
    const f = draftFixture(t); await f.ready(); const confirmation = deferred();
    const h = appHarness(f.controller, { confirm: () => confirmation.promise }), leaving = h.guard();
    f.controller.edit('name', 'Newer input');
    if (editBack) f.controller.edit('name', 'Unsent clip');
    confirmation.resolve!(true);
    assert.equal(await leaving, false); assert.equal(f.controller.hasUnsaved(), true);
    assert.equal(f.state().raw.name, editBack ? 'Unsent clip' : 'Newer input');
    assert.deepEqual((f.removals as unknown), []); assert.deepEqual((h.resets as unknown), []);
  });
}

test('actual App late confirmation cannot discard a replacement controller with identical text', async t => {
  const first = draftFixture(t), replacement = draftFixture(t); await first.ready(); await replacement.ready();
  const confirmation = deferred(), h = appHarness(first.controller, { confirm: () => confirmation.promise });
  const leaving = h.guard(); h.clipDraftRef.current = replacement.controller; confirmation.resolve!(true);
  assert.equal(await leaving, false);
  for (const f of [first, replacement]) { assert.equal(f.state().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual((f.removals as unknown), []); }
  assert.deepEqual((h.resets as unknown), []);
});

test('actual App project change while confirmation is open preserves the original clip draft', async t => {
  const f = draftFixture(t); await f.ready(); const confirmation = deferred();
  const h = appHarness(f.controller, { confirm: () => confirmation.promise }), leaving = h.guard();
  h.owner.projectId = id(90); confirmation.resolve!(true);
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Unsent clip');
  assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual((f.removals as unknown), []); assert.deepEqual((h.resets as unknown), []);
});

test('actual App clean registered controller permits navigation without a prompt or draft reset', async t => {
  const f = draftFixture(t); await f.controller.load(); const h = appHarness(f.controller);
  assert.equal(await h.guard(), true); assert.deepEqual((h.events as unknown), []); assert.deepEqual((h.resets as unknown), []);
  assert.deepEqual((f.writes as unknown), []); assert.deepEqual((f.removals as unknown), []);
});

test('actual App waits for the exact local-draft CAS delete before resetting other panels', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const saved = f.stored(), remove = f.holdRemove(), h = appHarness(f.controller);
  let settled = false; const leaving = h.guard().then((value: unknown) => { settled = true; return value; });
  await f.removeEntered;
  assert.equal(settled, false); assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual((h.resets as unknown), []);
  assert.deepEqual(f.removals, [{ ...key, workspaceScope: saved.workspaceScope, instanceId: saved.instanceId, expectedRevision: saved.revision }]);
  remove.resolve!(); assert.equal(await leaving, true); assert.equal(f.controller.hasUnsaved(), false);
  assert.deepEqual(h.resets, [['subtitle'], ['subjects', 'subject-owner'], ['setShotDirty', false], ['setClipDirty', false], ['setSourceDirty', false], ['setSubjectDirty', false], ['setSubtitleDirty', false], ['setInspectorEpoch', 5]]);
});

test('actual App failed asynchronous discard retains local input and never resets other panels', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const persisted = f.stored(), remove = f.holdRemove(), h = appHarness(f.controller, { dirty: true });
  const leaving = h.guard(); await f.removeEntered; f.failRemove(); remove.resolve!();
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  assert.deepEqual(f.stored(), persisted); assert.equal(h.dirtyRef.current, true); assert.deepEqual((h.resets as unknown), []);
});

test('actual App typing during CAS discard keeps navigation blocked and the newer input dirty', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const remove = f.holdRemove(), h = appHarness(f.controller), leaving = h.guard();
  await f.removeEntered; f.controller.edit('name', 'Typed during delete'); remove.resolve!();
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Typed during delete'); assert.equal(f.controller.hasUnsaved(), true);
  assert.deepEqual((h.resets as unknown), []);
});

for (const change of ['project', 'navigation epoch', 'controller']) {
  test(`actual App ${change} change while awaiting discard cannot reset the newer panel`, async t => {
    const f = draftFixture(t); await f.ready(); await f.controller.flush();
    const remove = f.holdRemove(), h = appHarness(f.controller), leaving = h.guard();
    await f.removeEntered;
    const replacement = draftFixture(t); await replacement.ready('New project input');
    if (change === 'project') h.owner.projectId = id(90);
    if (change === 'navigation epoch') h.owner.epoch++;
    if (change === 'controller') h.clipDraftRef.current = replacement.controller;
    remove.resolve!(); assert.equal(await leaving, false); assert.deepEqual((h.resets as unknown), []);
    assert.equal(replacement.state().raw.name, 'New project input'); assert.equal(replacement.controller.hasUnsaved(), true); assert.deepEqual((replacement.removals as unknown), []);
  });
}

test('actual App rechecks subtitle ownership after awaiting local clip discard', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const remove = f.holdRemove(), h = appHarness(f.controller), leaving = h.guard();
  await f.removeEntered;
  const newerSubtitle = { text: 'Typed while clip deletion was pending' };
  h.scope.subtitlesRef.current.controller.getState = () => newerSubtitle;
  remove.resolve!(); assert.equal(await leaving, false); assert.deepEqual((h.resets as unknown), []);
  assert.equal(h.scope.subtitlesRef.current.controller.getState(), newerSubtitle);
});

test('actual App registration cleanup releases only its still-registered controller', () => {
  const clipDraftRef = { current: null };
  const register = compile(registrationSource, 'registerClipDraft', { clipDraftRef, useCallback: (callback: unknown) => callback });
  const first = {}, replacement = {}, cleanupFirst = register(first);
  assert.equal(clipDraftRef.current, first);
  const cleanupReplacement = register(replacement); cleanupFirst();
  assert.equal(clipDraftRef.current, replacement, 'Unmounting the old Inspector must not unregister the new one');
  cleanupReplacement(); assert.equal(clipDraftRef.current, null);
  cleanupFirst(); assert.equal(clipDraftRef.current, null);
});

test('actual beforeunload reads synchronous clip state and follows registration ownership', async t => {
  const f = draftFixture(t); await f.controller.load();
  const clipDraftRef:{current:ClipDraftController|null}={current:f.controller}, dirtyRef = { current: false };
  const warn = actualAppCloseWarning(app, { shotTextRef: { current: null }, dirtyRef, clipDraftRef, timelineFormatRef: { current: null }, deliveryNameRef: { current: null } });
  const check = (expected: boolean) => { const event:{prevented:boolean;returnValue?:string;preventDefault():void}={prevented:false,preventDefault() { this.prevented = true; } }; warn(event); assert.equal(event.prevented, expected); assert.equal(event.returnValue, expected ? '' : undefined); };
  check(false); f.controller.edit('name', 'Same-tick input'); check(true);
  assert.equal(dirtyRef.current, false);
  const replacement = draftFixture(t); await replacement.controller.load(); clipDraftRef.current = replacement.controller; check(false);
  clipDraftRef.current = f.controller; check(true);
  assert.equal(await f.controller.discard(f.controller.capture()), true); check(false);
  clipDraftRef.current = null; dirtyRef.current = true; check(true);
});

test('actual App draft discard leaves the original pending timeline request and its blocking path untouched', async t => {
  const f = draftFixture(t); await f.ready(); const h = appHarness(f.controller);
  const original = Object.freeze({ requestId: 'original-request', expectedRevision: 7, clipId: key.clipId, patch: Object.freeze({ name: 'Previously submitted' }) });
  const tasks = { current: Object.freeze({ operation: 'timeline.clip.update', input: original, status: 'unknown' }) }, calls: (unknown[] | (string | boolean)[])[] = [];
  const mutate = compile(mutationSource, 'mutateTimeline', {
    application: null, // The ordinary App entry has no candidate application capability.
    clipDraftRef: { current: f.controller },
    dataRef: { current: { timeline: { revision: 7 } } }, currentProject: { current: key.projectId },
    touchesLockedTrack,trackLocksRef:{current:{}},
    tasksRef: { current: { blocked: (...args: unknown[]) => { calls.push(['blocked', ...args]); return Boolean(tasks.current); } } },
    timelinePending: false, notify: (...args: unknown[]) => calls.push(['notify', ...args]), openTasks: (canReveal = () => true) => { if (canReveal()) calls.push(['jobs', true]); },
    requestId: () => assert.fail('No new request ID while the original request is unresolved'), run: () => assert.fail('No automatic retry or changed replacement intent'),
  });
  assert.equal(await mutate('timeline.clip.update', { clipId: key.clipId, patch: { name: 'New draft' } }, 7), null);
  calls.length = 0; assert.equal(await h.guard(), true); assert.deepEqual((calls as unknown), []);
  assert.equal(tasks.current.input, original); assert.equal(tasks.current.status, 'unknown');
  assert.equal(await mutate('timeline.clip.update', { clipId: key.clipId, patch: { name: 'Another draft' } }, 7), null);
  assert.deepEqual(calls.map(([type]) => type), ['blocked', 'notify', 'jobs']);
  assert.equal(tasks.current.input, original);
});

test('actual Inspector save binding still routes the exact draft through the existing timeline mutation', async () => {
  const saveStart = app.indexOf('onSave={((clipId: string'), saveEnd = app.indexOf(')) as never}', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'Find the real TimelineInspector save binding');
  const saveSource = app.slice(saveStart + 'onSave={'.length, saveEnd + ')) as never'.length);
  assert.ok(saveSource, 'Find the real TimelineInspector save binding');
  const calls:[string,{clipId:string;patch:Record<string,unknown>},number,{returnAfterNavigation:boolean;canExecute:()=>boolean}][] = [],saved = { revision: 8 }, patch = { name: 'Explicitly saved' };
  let current = true;
  const canExecute = () => current;
  const save = (Function('mutateTimeline', `return (${stripSourceTypes(saveSource,{loader:'tsx'}).trim().replace(/;$/,'')});`)((...args: unknown[]) => { calls.push(args as [string,{clipId:string;patch:Record<string,unknown>},number,{returnAfterNavigation:boolean;canExecute:()=>boolean}]);return Promise.resolve(saved); }) as Parameters<ClipDraftController["save"]>[0]);
  assert.equal(await save(key.clipId, patch, 7, { canExecute }), saved);
  assert.deepEqual(calls, [['timeline.clip.update', { clipId: key.clipId, patch }, 7, { returnAfterNavigation: true, canExecute }]]);
  assert.equal(calls[0][1].patch, patch);
  assert.equal(calls[0][3].canExecute, canExecute, 'Forward the original controller preparation fence by identity');
  assert.equal(calls[0][3].canExecute(), true); current = false; assert.equal(calls[0][3].canExecute(), false);
  assert.match(app, /onDraftController=\{registerClipDraft\}/);
});
