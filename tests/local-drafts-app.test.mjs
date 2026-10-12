import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';

// Execute the actual App callbacks with the real local-draft controller. Only
// the persistence transport and React state setters are synthetic boundaries.
const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
function section(start, end) {
  const at = app.indexOf(start), until = app.indexOf(end, at + start.length);
  assert.ok(at >= 0 && until > at, `Missing actual App extraction: ${start}`);
  assert.equal(app.indexOf(start, at + start.length), -1, `Ambiguous actual App extraction: ${start}`);
  return app.slice(at, until);
}
const guardSource = section('  async function guardNavigation(', '  async function guardProjectNavigation(');
const registrationSource = section('  const registerClipDraft = useCallback(', '  const [agentPage,');
const mutationSource = section('  async function mutateTimeline(', '  async function selectClip(');
const compile = (source, name, scope) => Function(...Object.keys(scope), `${source}\nreturn ${name};`)(...Object.values(scope));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const id = n => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 90, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } };
const source = { assetId: id(5), assetSha256: 'a'.repeat(64) };
const stamp = '2026-10-12T00:00:00.000Z';

function draftFixture(t) {
  let stored = { supported: true, workspaceScope: 'b'.repeat(64), instanceId: id(6), key, revision: 0, targetStatus: 'matching', draft: null };
  let removeGate = null, removeError = null;
  const writes = [], removals = [], removeEntered = deferred();
  const controller = createClipDraftController({
    context: { ...key, scope: 'project:1:clip:1', restored: false, connected: true, busy: false, visible: true, timelineRevision: 7, source, saved: raw },
    delay: 60_000,
    client: {
      get: async () => structuredClone(stored),
      put: async input => {
        writes.push(structuredClone(input));
        assert.equal(input.expectedRevision, stored.revision);
        stored = { ...stored, revision: stored.revision + 1, draft: { raw: structuredClone(input.raw), source: input.source, baseRevision: input.baseRevision, updatedAt: stamp } };
        return structuredClone(stored);
      },
      remove: async input => {
        removals.push(structuredClone(input)); removeEntered.resolve();
        await removeGate?.promise;
        if (removeError) throw removeError;
        assert.equal(input.expectedRevision, stored.revision);
        stored = { ...stored, revision: stored.revision + 1, draft: null };
        return structuredClone(stored);
      },
    },
  });
  t.after(() => controller.dispose());
  return {
    controller, writes, removals, removeEntered: removeEntered.promise,
    state: () => controller.getState(), stored: () => structuredClone(stored),
    async ready(name = 'Unsent clip') { await controller.load(); controller.edit('name', name); },
    holdRemove() { return removeGate = deferred(); },
    failRemove() { removeError = Error('Draft delete was not acknowledged'); },
  };
}

function appHarness(controller, { confirm = async () => true, dirty = false } = {}) {
  const events = [], resets = [], owner = { projectId: key.projectId, epoch: 1 };
  const clipDraftRef = { current: controller }, dirtyRef = { current: dirty };
  const subtitleState = { text: 'Separate subtitle draft' };
  const scope = {
    shotTextRef: { current: null }, clipDraftRef, dirtyRef, context: () => ({ ...owner }),
    isCurrent: captured => captured.projectId === owner.projectId && captured.epoch === owner.epoch,
    confirm: message => { events.push(['confirm', message]); return confirm(message); },
    subtitlesRef: { current: { controller: { getState: () => subtitleState, hasUnsaved: () => false, discardDraft: () => resets.push(['subtitle']) } } },
    subjectsRef: { current: { state: { scope: 'subject-owner' }, controller: { discardDrafts: captured => resets.push(['subjects', captured]) } } },
    ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, value => resets.push([name, typeof value === 'function' ? value(4) : value])])),
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
  assert.deepEqual(f.removals, []); assert.deepEqual(h.resets, []);
});

for (const editBack of [false, true]) {
  test(`actual App late confirmation rejects newer typing${editBack ? ' even when text changes back' : ''}`, async t => {
    const f = draftFixture(t); await f.ready(); const confirmation = deferred();
    const h = appHarness(f.controller, { confirm: () => confirmation.promise }), leaving = h.guard();
    f.controller.edit('name', 'Newer input');
    if (editBack) f.controller.edit('name', 'Unsent clip');
    confirmation.resolve(true);
    assert.equal(await leaving, false); assert.equal(f.controller.hasUnsaved(), true);
    assert.equal(f.state().raw.name, editBack ? 'Unsent clip' : 'Newer input');
    assert.deepEqual(f.removals, []); assert.deepEqual(h.resets, []);
  });
}

test('actual App late confirmation cannot discard a replacement controller with identical text', async t => {
  const first = draftFixture(t), replacement = draftFixture(t); await first.ready(); await replacement.ready();
  const confirmation = deferred(), h = appHarness(first.controller, { confirm: () => confirmation.promise });
  const leaving = h.guard(); h.clipDraftRef.current = replacement.controller; confirmation.resolve(true);
  assert.equal(await leaving, false);
  for (const f of [first, replacement]) { assert.equal(f.state().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual(f.removals, []); }
  assert.deepEqual(h.resets, []);
});

test('actual App project change while confirmation is open preserves the original clip draft', async t => {
  const f = draftFixture(t); await f.ready(); const confirmation = deferred();
  const h = appHarness(f.controller, { confirm: () => confirmation.promise }), leaving = h.guard();
  h.owner.projectId = id(90); confirmation.resolve(true);
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Unsent clip');
  assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual(f.removals, []); assert.deepEqual(h.resets, []);
});

test('actual App clean registered controller permits navigation without a prompt or draft reset', async t => {
  const f = draftFixture(t); await f.controller.load(); const h = appHarness(f.controller);
  assert.equal(await h.guard(), true); assert.deepEqual(h.events, []); assert.deepEqual(h.resets, []);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.removals, []);
});

test('actual App waits for the exact local-draft CAS delete before resetting other panels', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const saved = f.stored(), remove = f.holdRemove(), h = appHarness(f.controller);
  let settled = false; const leaving = h.guard().then(value => { settled = true; return value; });
  await f.removeEntered;
  assert.equal(settled, false); assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual(h.resets, []);
  assert.deepEqual(f.removals, [{ ...key, workspaceScope: saved.workspaceScope, instanceId: saved.instanceId, expectedRevision: saved.revision }]);
  remove.resolve(); assert.equal(await leaving, true); assert.equal(f.controller.hasUnsaved(), false);
  assert.deepEqual(h.resets, [['subtitle'], ['subjects', 'subject-owner'], ['setShotDirty', false], ['setClipDirty', false], ['setSourceDirty', false], ['setSubjectDirty', false], ['setSubtitleDirty', false], ['setInspectorEpoch', 5]]);
});

test('actual App failed asynchronous discard retains local input and never resets other panels', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const persisted = f.stored(), remove = f.holdRemove(), h = appHarness(f.controller, { dirty: true });
  const leaving = h.guard(); await f.removeEntered; f.failRemove(); remove.resolve();
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  assert.deepEqual(f.stored(), persisted); assert.equal(h.dirtyRef.current, true); assert.deepEqual(h.resets, []);
});

test('actual App typing during CAS discard keeps navigation blocked and the newer input dirty', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const remove = f.holdRemove(), h = appHarness(f.controller), leaving = h.guard();
  await f.removeEntered; f.controller.edit('name', 'Typed during delete'); remove.resolve();
  assert.equal(await leaving, false); assert.equal(f.state().raw.name, 'Typed during delete'); assert.equal(f.controller.hasUnsaved(), true);
  assert.deepEqual(h.resets, []);
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
    remove.resolve(); assert.equal(await leaving, false); assert.deepEqual(h.resets, []);
    assert.equal(replacement.state().raw.name, 'New project input'); assert.equal(replacement.controller.hasUnsaved(), true); assert.deepEqual(replacement.removals, []);
  });
}

test('actual App rechecks subtitle ownership after awaiting local clip discard', async t => {
  const f = draftFixture(t); await f.ready(); await f.controller.flush();
  const remove = f.holdRemove(), h = appHarness(f.controller), leaving = h.guard();
  await f.removeEntered;
  const newerSubtitle = { text: 'Typed while clip deletion was pending' };
  h.scope.subtitlesRef.current.controller.getState = () => newerSubtitle;
  remove.resolve(); assert.equal(await leaving, false); assert.deepEqual(h.resets, []);
  assert.equal(h.scope.subtitlesRef.current.controller.getState(), newerSubtitle);
});

test('actual App registration cleanup releases only its still-registered controller', () => {
  const clipDraftRef = { current: null };
  const register = compile(registrationSource, 'registerClipDraft', { clipDraftRef, useCallback: callback => callback });
  const first = {}, replacement = {}, cleanupFirst = register(first);
  assert.equal(clipDraftRef.current, first);
  const cleanupReplacement = register(replacement); cleanupFirst();
  assert.equal(clipDraftRef.current, replacement, 'Unmounting the old Inspector must not unregister the new one');
  cleanupReplacement(); assert.equal(clipDraftRef.current, null);
  cleanupFirst(); assert.equal(clipDraftRef.current, null);
});

test('actual beforeunload reads synchronous clip state and follows registration ownership', async t => {
  const f = draftFixture(t); await f.controller.load();
  const clipDraftRef = { current: f.controller }, dirtyRef = { current: false };
  const warnSource = app.match(/const warn = e => \{ if \(!dirtyRef\.current[\s\S]*?e\.returnValue = ''; \};/)?.[0];
  assert.ok(warnSource, 'Extract the actual beforeunload warning');
  const warn = compile(warnSource, 'warn', { shotTextRef: { current: null }, dirtyRef, clipDraftRef, timelineFormatRef: { current: null }, deliveryNameRef: { current: null } });
  const check = expected => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; warn(event); assert.equal(event.prevented, expected); assert.equal(event.returnValue, expected ? '' : undefined); };
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
  const tasks = { current: Object.freeze({ operation: 'timeline.clip.update', input: original, status: 'unknown' }) }, calls = [];
  const mutate = compile(mutationSource, 'mutateTimeline', {
    dataRef: { current: { timeline: { revision: 7 } } }, currentProject: { current: key.projectId },
    tasksRef: { current: { blocked: (...args) => { calls.push(['blocked', ...args]); return Boolean(tasks.current); } } },
    timelinePending: false, notify: (...args) => calls.push(['notify', ...args]), setShowJobs: value => calls.push(['jobs', value]),
    requestId: () => assert.fail('No new request ID while the original request is unresolved'), run: () => assert.fail('No automatic retry or changed replacement intent'),
  });
  assert.equal(await mutate('timeline.clip.update', { clipId: key.clipId, patch: { name: 'New draft' } }, 7), null);
  calls.length = 0; assert.equal(await h.guard(), true); assert.deepEqual(calls, []);
  assert.equal(tasks.current.input, original); assert.equal(tasks.current.status, 'unknown');
  assert.equal(await mutate('timeline.clip.update', { clipId: key.clipId, patch: { name: 'Another draft' } }, 7), null);
  assert.deepEqual(calls.map(([type]) => type), ['blocked', 'notify', 'jobs']);
  assert.equal(tasks.current.input, original);
});

test('actual Inspector save binding still routes the exact draft through the existing timeline mutation', async () => {
  const saveSource = app.match(/onSave=\{(\(clipId, patch, revision, draftOptions\) => mutateTimeline\('timeline\.clip\.update',[\s\S]*?\))\} onRemove=/)?.[1];
  assert.ok(saveSource, 'Find the real TimelineInspector save binding');
  const calls = [], saved = { revision: 8 }, patch = { name: 'Explicitly saved' };
  let current = true;
  const canExecute = () => current;
  const save = Function('mutateTimeline', `return (${saveSource});`)((...args) => { calls.push(args); return Promise.resolve(saved); });
  assert.equal(await save(key.clipId, patch, 7, { canExecute }), saved);
  assert.deepEqual(calls, [['timeline.clip.update', { clipId: key.clipId, patch }, 7, { returnAfterNavigation: true, canExecute }]]);
  assert.equal(calls[0][1].patch, patch);
  assert.equal(calls[0][3].canExecute, canExecute, 'Forward the original controller preparation fence by identity');
  assert.equal(calls[0][3].canExecute(), true); current = false; assert.equal(calls[0][3].canExecute(), false);
  assert.match(app, /onDraftController=\{registerClipDraft\}/);
});
