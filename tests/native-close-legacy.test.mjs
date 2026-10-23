import { message as msg } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { schemas } from '@mioon/contracts';
import { getWan30Capability } from '../packages/contracts/src/wan-video.ts';
import * as shotContracts from '@mioon/contracts/local-shot-text';
import * as shotClient from '../apps/web/src/local-shot-text-client.ts';
import * as shotModule from '../apps/web/src/local-shot-text-state.ts';
import { createTimelineDeliveryNameController } from '../apps/web/src/export-delivery-state.ts';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { createTimelineFormatController } from '../apps/web/src/timeline-format-state.ts';
import { createSubjectController, subjectDraftDirty } from '../apps/web/src/subject-state.ts';
import { createSubtitleController } from '../apps/web/src/subtitle-state.ts';
import { readNativeLegacyClose } from '../apps/web/src/native-close-legacy.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
// The negative control loads the original real controller, with its original
// dependencies. A missing pure close getter must fail rather than fall back to
// mutating hasUnsaved/capture. No clean-state controller is substituted.
let createShot = shotModule.createLocalShotTextController;
if (process.env.MIOON_NATIVE_CLOSE_SHOT_SOURCE) {
  const module = { exports: {} }, localRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
  Function('module', 'exports', 'require', transformSync(readFileSync(process.env.MIOON_NATIVE_CLOSE_SHOT_SOURCE, 'utf8'), { loader: 'ts', format: 'cjs' }).code)(module, module.exports, name => {
    if (name === 'react') return localRequire('react');
    if (name === '@mioon/contracts/local-shot-text') return shotContracts;
    if (name === './local-shot-text-client.ts') return shotClient;
    throw Error(`Unexpected legacy-shot dependency: ${name}`);
  });
  createShot = module.exports.createLocalShotTextController;
}
const id = n => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), timelineId = id(3), clipId = id(4), trackId = id(5), assetId = id(6), stamp = '2026-10-13T18:00:00.000Z';
const baseText = { title: 'Saved', prompt: 'Saved prompt' }, copy = value => structuredClone(value);
const sameIdentity = (left, right) => left.identity.length === right.identity.length && left.identity.every((value, index) => Object.is(value, right.identity[index]));
const emptyShot = () => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(7), projectId, shotId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset', projectPendingIntent: null });
function shotFixture(t, options = {}) {
  let context = { scope: 'project:1', projectId, shotId, revision: 4, baseRevision: 4, baseText: copy(baseText), savedText: copy(baseText),
    restored: false, connected: true, visible: true, busy: false, raw: copy(baseText), textVersion: 1, formSerial: 0, textDirty: false, formDirty: false, executionEpoch: 'execution:1', ...options.context };
  let stored = emptyShot(), sequence = 10;
  const counts = { context: 0, change: 0, transport: 0, schedule: 0, clear: 0 }, calls = [];
  const client = {
    async get() { counts.transport++; calls.push('get'); return copy(stored); },
    async put(input) { counts.transport++; calls.push('put'); if (options.put) return options.put(input); stored = { ...stored, draftRevision: input.expectedDraftRevision + 1,
      draft: { draftId: input.draftId, baseRevision: input.baseRevision, baseText: copy(input.baseText), raw: copy(input.raw), updatedAt: stamp }, draftTargetStatus: 'matching' }; return copy(stored); },
    async discard() { counts.transport++; calls.push('discard'); throw Error('Unknown deletion'); },
    async prepare() { counts.transport++; calls.push('prepare'); throw Error('No unexpected preparation'); },
    async execute() { counts.transport++; calls.push('execute'); throw Error('No unexpected execution'); },
    async recover() { counts.transport++; calls.push('recover'); throw Error('No unexpected recovery'); },
  };
  const controller = createShot({ context, getContext: () => { counts.context++; return context; }, client,
    retention: options.retention, isShotUpdateInput: value => schemas['shot.update'].safeParse(value).success,
    onChange: () => counts.change++, delay: 60000, createId: () => id(sequence++) });
  t.after(() => controller.dispose());
  return { controller, counts, calls, state: () => controller.getState(),
    set(patch) { context = { ...context, ...patch }; controller.setContext(context); },
    edit(title, formDirty = true) { context = { ...context, raw: { ...context.raw, title }, textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty }; controller.setContext(context); },
  };
}

test('real delivery A-to-B edits and owner replacement invalidate an unchanged dirty decision', () => {
  let contextReads = 0, changes = 0;
  const context = { scope: 'delivery:1', projectId, enabled: true }, delivery = createTimelineDeliveryNameController({ getContext: () => { contextReads++; return context; }, onChange: () => changes++ });
  delivery.setContext(context); assert.equal(delivery.choose('A', context.scope), true);
  const beforeCounts = [contextReads, changes], first = readNativeLegacyClose({ delivery });
  assert.equal(first.dirty, true); assert.deepEqual([contextReads, changes], beforeCounts);
  assert.equal(delivery.choose('B', context.scope), true); const second = readNativeLegacyClose({ delivery });
  assert.equal(second.dirty, true); assert.equal(sameIdentity(first, second), false);
  const replacement = createTimelineDeliveryNameController(); replacement.setContext(context); replacement.choose('B', context.scope);
  assert.equal(sameIdentity(second, readNativeLegacyClose({ delivery: replacement })), false);
});

test('shot close snapshot is read-only: no getContext, timer, change callback or transport', async t => {
  const f = shotFixture(t); await f.controller.load(); f.edit('Draft A');
  assert.equal(typeof f.controller.getNativeCloseSnapshot, 'function', 'Original mutating hasUnsaved is not a close getter');
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { f.counts.schedule++; return originalSet(...args); });
  t.mock.method(globalThis, 'clearTimeout', (...args) => { f.counts.clear++; return originalClear(...args); });
  const before = { ...f.counts }, state = f.state(), first = readNativeLegacyClose({ shot: f.controller });
  for (let count = 0; count < 10; count++) {
    const direct = f.controller.getNativeCloseSnapshot(); assert.equal(direct.dirty, true);
    assert.equal(Object.isFrozen(direct), true); assert.equal(sameIdentity(first, readNativeLegacyClose({ shot: f.controller })), true);
  }
  assert.deepEqual(f.counts, before); assert.equal(f.state(), state);
  f.edit('Draft B'); const second = readNativeLegacyClose({ shot: f.controller }); assert.equal(second.dirty, true); assert.equal(sameIdentity(first, second), false);
  const identity = second.identity; f.set({ formSerial: 500, formDirty: true }); assert.notDeepEqual(readNativeLegacyClose({ shot: f.controller }).identity, identity);
});

test('shot pure predicate preserves matching persisted draft, abandoned input, and retained deletion semantics', async t => {
  const f = shotFixture(t); await f.controller.load(); f.edit('Text only', false);
  assert.equal(f.controller.getNativeCloseSnapshot().dirty, f.controller.hasUnsaved()); assert.equal(f.controller.getNativeCloseSnapshot().dirty, true);
  const before = readNativeLegacyClose({ shot: f.controller }); assert.equal(await f.controller.flush(), true);
  assert.equal(f.state().dirty, true, 'Sidecar saving does not acknowledge the business form');
  assert.equal(f.controller.getNativeCloseSnapshot().dirty, false, 'Exact persisted raw/base text matches the original predicate');
  assert.equal(f.controller.getNativeCloseSnapshot().dirty, f.controller.hasUnsaved()); assert.equal(sameIdentity(before, readNativeLegacyClose({ shot: f.controller })), true);
  f.edit('Abandoned', true); assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(f.controller.getNativeCloseSnapshot().dirty, false); assert.equal(f.controller.hasUnsaved(), false);
  const retention = shotModule.createLocalShotTextRetention();
  retention.deletions.set(`:${projectId}:${shotId}`, { workspaceScope: 'a'.repeat(64), instanceId: id(7), projectId, shotId, expectedDraftRevision: 1, draftId: id(8) });
  const retained = shotFixture(t, { retention }); assert.ok(retained.state().retainedDeletion); assert.equal(retained.controller.getNativeCloseSnapshot().dirty, true);
  assert.equal(retained.controller.abandonCurrentInput(), true); assert.equal(retained.controller.getNativeCloseSnapshot().dirty, true, 'A retained deletion remains dirty even when form input is abandoned');
  assert.equal(retained.controller.getNativeCloseSnapshot().dirty, retained.controller.hasUnsaved());
});

test('shot local save/saved ACK changes no semantic close identity and performs no business request', async t => {
  let resolvePut; const held = new Promise(resolve => { resolvePut = resolve; }); let input;
  const f = shotFixture(t, { put: value => { input = value; return held; } }); await f.controller.load(); f.edit('Draft A');
  const before = readNativeLegacyClose({ shot: f.controller }), writing = f.controller.flush();
  assert.equal(f.state().phase, 'saving'); assert.equal(sameIdentity(before, readNativeLegacyClose({ shot: f.controller })), true);
  resolvePut({ ...emptyShot(), draftRevision: input.expectedDraftRevision + 1, draft: { draftId: input.draftId, baseRevision: input.baseRevision, baseText: input.baseText, raw: input.raw, updatedAt: stamp }, draftTargetStatus: 'matching' });
  assert.equal(await writing, true); assert.equal(f.state().phase, 'saved'); assert.equal(sameIdentity(before, readNativeLegacyClose({ shot: f.controller })), true);
  assert.deepEqual(f.calls, ['get', 'put']);
});

test('real clip sidecar ACK keeps raw/base/source identity while edit and owner changes invalidate', async t => {
  const key = { projectId, timelineId, clipId }, source = { assetId, assetSha256: 'b'.repeat(64) }, raw = { name: 'Saved clip', trackId, startFrame: 0, durationFrames: 60, sourceInFrame: 0, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
  const context = { ...key, scope: 'clip:1', restored: false, connected: true, visible: true, busy: false, timelineRevision: 7, source, saved: raw };
  let stored = { supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(7), key, revision: 0, targetStatus: 'matching', draft: null }, calls = 0;
  const client = { get: async () => { calls++; return copy(stored); }, put: async input => { calls++; stored = { ...stored, revision: input.expectedRevision + 1,
    draft: { baseRevision: input.baseRevision, source: copy(input.source), raw: copy(input.raw), updatedAt: stamp } }; return copy(stored); }, remove: async () => { throw Error('No delete'); } };
  const clip = createClipDraftController({ context, client, delay: 60000 }); t.after(() => clip.dispose()); await clip.load(); clip.edit('name', 'A');
  const before = readNativeLegacyClose({ clip }); assert.equal(before.dirty, true); assert.equal(await clip.flushForClose(), true);
  const saved = readNativeLegacyClose({ clip }); assert.equal(saved.dirty, true); assert.equal(sameIdentity(before, saved), true); assert.equal(calls, 2);
  clip.edit('name', 'B'); assert.equal(sameIdentity(saved, readNativeLegacyClose({ clip })), false);
  const replacement = createClipDraftController({ context, client, delay: 60000 }); t.after(() => replacement.dispose()); assert.equal(sameIdentity(saved, readNativeLegacyClose({ clip: replacement })), false);
});

test('real format draft/base inputs are read-only and independent of loading or copied saved metadata', async () => {
  let contextReads = 0, reads = 0;
  const context = { scope: 'format:1', projectId, connected: true, pending: false };
  const format = createTimelineFormatController({ getContext: () => { contextReads++; return context; }, read: async () => { reads++; return { projectId, projectRevision: 1, timelineId, timelineRevision: 1, presetId: 'portrait_720', fps: 30, width: 720, height: 1280, eligible: true, blockedReasons: [] }; }, submit: () => { throw Error('No business submit'); }, createRequestId: () => id(10) });
  format.setContext(context); format.setVisible(true); await format.load(); format.choose('landscape_720');
  const beforeCounts = [contextReads, reads], first = readNativeLegacyClose({ format }); assert.equal(first.dirty, true); assert.deepEqual([contextReads, reads], beforeCounts);
  await format.load(); assert.equal(sameIdentity(first, readNativeLegacyClose({ format })), true);
  format.choose('square_720'); assert.equal(sameIdentity(first, readNativeLegacyClose({ format })), false);
});

test('adapter preserves exactly legacy dirty/submitting predicates and optional inspector input identity only', () => {
  let clipState = { dirty: false, submitting: false, raw: {}, source: {}, baseRevision: 1 }, formatState = { dirty: false, submitting: false, scope: null, projectId: null, base: null, draftPresetId: null };
  const clip = { getState: () => clipState, hasUnsaved: () => { throw Error('Do not invoke legacy methods'); } }, format = { getState: () => formatState };
  let otherState = { pending: true, busy: true, dirty: true }, subjectState = { scope: 'subject:1', projectId, createDraft: {}, versionDrafts: {}, bindingDrafts: {}, selectedSubjectId: '', activeShotId: null, saving: null, uncertain: true };
  const subtitle = { getState: () => otherState }, subject = { getState: () => subjectState };
  const clean = readNativeLegacyClose({ clip, format, subtitle, subject }); assert.equal(clean.dirty, false, 'Optional state evidence does not broaden the existing predicate');
  subjectState = { ...subjectState, createDraft: { name: 'New draft' } }; assert.equal(sameIdentity(clean, readNativeLegacyClose({ clip, format, subtitle, subject })), false);
  clipState = { ...clipState, submitting: true }; assert.equal(readNativeLegacyClose({ clip, format }).dirty, true);
  clipState = { ...clipState, submitting: false }; formatState = { ...formatState, submitting: true }; assert.equal(readNativeLegacyClose({ clip, format }).dirty, true);
  assert.equal(readNativeLegacyClose({ inspectorDirty: true }).dirty, true); assert.equal(readNativeLegacyClose().dirty, false);
});

const subjectHookSource = readFileSync(new URL('../apps/web/src/use-subjects.ts', import.meta.url), 'utf8');
const settleSubjectReads = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
async function subjectCloseFixture(t) {
  const subjectId = id(30), otherSubjectId = id(32), otherShotId = id(33);
  const version = (owner, versionId) => ({ id: versionId, projectId, subjectId: owner, number: 1, assetId, sha256: 'a'.repeat(64), mimeType: 'image/png', width: 64, height: 64,
    provenance: { kind: 'user-import', versionId: null, shotId: null, jobId: null }, createdAt: stamp });
  const row = (owner, versionId) => ({ id: owner, projectId, kind: 'character', name: 'Hero', revision: 1, headVersionId: versionId, headVersion: version(owner, versionId), createdAt: stamp, updatedAt: stamp });
  const rows = [row(subjectId, id(31)), row(otherSubjectId, id(34))], counts = { read: 0, save: 0, pending: 0, change: 0 };
  let pending = false;
  const subject = createSubjectController({ read: async (operation, input) => { counts.read++; return { projectId: input.projectId, items: copy(operation === 'subject.list' ? rows : operation === 'subject.version.list' ? rows.filter(row => row.id === input.subjectId).map(row => row.headVersion) : []), nextCursor: null }; },
    save: () => { counts.save++; return new Promise(() => {}); }, hasPending: () => { counts.pending++; return pending; }, onChange: () => counts.change++ });
  const context = { scope: 'subject:1', projectId, assets: [{ id: assetId, projectId, mimeType: 'image/png' }], shotIds: [shotId, otherShotId] };
  subject.setContext(context); await settleSubjectReads(); subject.selectSubject(subjectId); await subject.readBindings(shotId); await settleSubjectReads();
  const refreshMatch = subjectHookSource.match(/const refresh = \(\)(?:: [^=]+)? => \{[^\n]+\};/); assert.ok(refreshMatch, 'Use the real focus/visibility refresh callback');
  const focus = Function('controller', 'document', `${refreshMatch[0]} return refresh;`)({ current: subject }, { visibilityState: 'visible' });
  const read = () => readNativeLegacyClose({ inspectorDirty: subjectDraftDirty(subject.getState()), subject });
  const url = 'http://127.0.0.1:4317/?project=test';
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(), readScope: () => 'workspace:1', readDocumentURL: () => url, readLegacySnapshot: read, now: () => 1000, newToken: () => 'subject_token' });
  const commit = token => admission.commit(token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1500, action: 'reload', targetUrl: url });
  t.after(() => { subject.dispose(); admission.dispose(); });
  return { subject, read, admission, commit, focus, counts, context, subjectId, otherSubjectId, otherShotId,
    inspect: () => admission.inspect('reload', url), pending: value => { pending = value; } };
}

for (const dirty of [false, true]) for (const stage of ['commit', 'unload']) test(`real subject focus refresh preserves ${dirty ? 'dirty' : 'clean'} reload ${stage} without input changes`, async t => {
  const f = await subjectCloseFixture(t);
  if (dirty) { f.subject.updateCreate({ name: 'Draft A' }); f.subject.updateVersion(f.subjectId, assetId); f.subject.chooseBinding(shotId, f.subjectId, id(31)); }
  const state = f.subject.getState(), before = f.read(), capture = f.inspect();
  assert.equal(capture.disposition, dirty ? 'dirty' : 'clean');
  if (stage === 'unload') assert.equal(f.commit(capture.token), true);
  f.focus(); assert.equal(f.subject.getState().list.phase, 'loading');
  assert.equal(sameIdentity(before, f.read()), true, 'Readonly focus loading must not replace close input identity');
  await settleSubjectReads();
  const refreshed = f.subject.getState(); assert.equal(refreshed.list.phase, 'ready'); assert.notEqual(refreshed, state); assert.notEqual(refreshed.list, state.list); assert.notEqual(refreshed.subjects, state.subjects);
  for (const key of ['createDraft', 'versionDrafts', 'bindingDrafts']) assert.equal(refreshed[key], state[key], `${key} remains the original local input`);
  assert.equal(sameIdentity(before, f.read()), true);
  const counts = { ...f.counts }; assert.equal(f.counts.save, 0);
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout; let timers = 0;
  t.mock.method(globalThis, 'setTimeout', (...args) => { timers++; return originalSet(...args); }); t.mock.method(globalThis, 'clearTimeout', (...args) => { timers++; return originalClear(...args); });
  for (let i = 0; i < 3; i++) assert.equal(sameIdentity(before, f.read()), true);
  if (stage === 'commit') assert.equal(f.commit(capture.token), true);
  let prevented = false; assert.equal(f.admission.beforeUnload({ preventDefault: () => { prevented = true; }, returnValue: '' }), true); assert.equal(prevented, false);
  assert.deepEqual(f.counts, counts, 'Final reads never refresh, sync pending, emit or submit'); assert.equal(timers, 0);
});

test('real subject draft, owner and target changes still invalidate captured reload decisions', async t => {
  for (const change of ['create', 'version', 'binding', 'selected subject', 'active shot', 'scope', 'project', 'owner']) {
    const f = await subjectCloseFixture(t); f.subject.updateCreate({ name: 'Draft A' });
    const before = f.read(), capture = f.inspect();
    if (change === 'create') f.subject.updateCreate({ name: 'Draft B' });
    if (change === 'version') f.subject.updateVersion(f.subjectId, assetId);
    if (change === 'binding') f.subject.chooseBinding(shotId, f.subjectId, id(31));
    if (change === 'selected subject') f.subject.selectSubject(f.otherSubjectId);
    if (change === 'active shot') await f.subject.readBindings(f.otherShotId);
    if (change === 'scope') f.subject.setContext({ ...f.context, scope: 'subject:2' });
    if (change === 'project') f.subject.setContext({ ...f.context, projectId: id(90) });
    if (change === 'owner') {
      const replacement = { getState: () => f.subject.getState() };
      assert.equal(sameIdentity(before, readNativeLegacyClose({ inspectorDirty: true, subject: replacement })), false, change);
    } else {
      assert.equal(sameIdentity(before, f.read()), false, change); assert.equal(f.commit(capture.token), false, change);
    }
  }
});

test('subject refresh cannot hide a new saving or uncertain state from close identity', async t => {
  const f = await subjectCloseFixture(t); f.subject.updateCreate({ name: 'Draft A', assetId });
  const before = f.read(), capture = f.inspect(); f.pending(true); await f.subject.read();
  assert.equal(f.subject.getState().uncertain, true); assert.equal(sameIdentity(before, f.read()), false); assert.equal(f.commit(capture.token), false);
  f.pending(false); f.subject.syncPending(); const beforeSave = f.read(), saveCapture = f.inspect(); void f.subject.create();
  assert.equal(f.subject.getState().saving, 'subject.create'); assert.equal(sameIdentity(beforeSave, f.read()), false); assert.equal(f.commit(saveCapture.token), false); assert.equal(f.counts.save, 1);
});

test('real subtitle equal-revision refresh already preserves identity while selection and edits invalidate', t => {
  const cueId = id(40), otherCueId = id(41), timeline = { id: timelineId, projectId, revision: 7, durationFrames: 180,
    subtitles: { profileId: 'bottom_cjk_v1', cues: [{ id: cueId, text: 'Saved', startFrame: 0, durationFrames: 30 }, { id: otherCueId, text: 'Second', startFrame: 60, durationFrames: 30 }] } };
  const context = { scope: 'subtitle:1', projectId, timeline, connected: true, pending: false };
  let changes = 0;
  const subtitle = createSubtitleController({ submit: () => { throw Error('No save'); }, createRequestId: () => 'request', onChange: () => changes++ });
  t.after(() => subtitle.dispose()); subtitle.setContext(context); subtitle.setVisible(true); subtitle.select(cueId);
  const before = readNativeLegacyClose({ subtitle }), state = subtitle.getState(), count = changes;
  subtitle.setContext({ ...context, timeline: copy(timeline) }); assert.equal(subtitle.getState(), state); assert.equal(changes, count); assert.equal(sameIdentity(before, readNativeLegacyClose({ subtitle })), true);
  subtitle.select(otherCueId); assert.equal(sameIdentity(before, readNativeLegacyClose({ subtitle })), false);
  const selected = readNativeLegacyClose({ subtitle }); subtitle.edit('text', 'Draft'); assert.equal(sameIdentity(selected, readNativeLegacyClose({ subtitle })), false);
  const draft = readNativeLegacyClose({ subtitle }); subtitle.setContext({ ...context, timeline: copy(timeline) }); assert.equal(sameIdentity(draft, readNativeLegacyClose({ subtitle })), true);
});

const inspectorSource = readFileSync(process.env.MIOON_NATIVE_CLOSE_INSPECTOR_SOURCE || new URL('../apps/web/src/Inspector.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const between = (source, start, end) => { const from = source.indexOf(start), to = source.indexOf(end, from + start.length); assert.ok(from >= 0 && to > from, start); return source.slice(from, to); };
function actualShotRegistration(shotTextRef, shotCloseRef) {
  return Function('useCallback', 'shotTextRef', 'shotCloseRef', `${between(appSource, '  const registerShotText =', '  const registerClipDraft =')} return registerShotText;`)(callback => callback, shotTextRef, shotCloseRef);
}
async function inspectorContinuation(t, { wan = false, videoInput, referenceLocked = false } = {}) {
  const refs = { mounted: { current: true }, editSerial: { current: 0 }, textVersion: { current: 0 }, dirtyRef: { current: false }, baseRevisionRef: { current: 4 },
    baseline: { current: { ...baseText, referenceAssetIds: [id(20)], lastFrameAssetId: id(21) } }, draftRef: { current: { ...baseText, referenceAssetIds: [id(20)], lastFrameAssetId: id(21) } } };
  const counts = { getCurrent: 0, onChange: 0, transport: 0, timer: 0, clearTimer: 0 }, queuedState = {}, shotText = {}, appShot = { current: null }, appLocal = { current: null };
  let resolveConfirmation, unregister; const confirmation = new Promise(resolve => { resolveConfirmation = resolve; });
  const scope = { scope: 'inspector:1', connected: true, restored: false, busy: false, executionEpoch: 'execution:1' };
  const register = actualShotRegistration(appShot, appLocal);
  const env = { msg, ...refs, shotText, shot: { id: shotId, revision: 4, ...baseText }, project: { id: projectId }, draft: refs.draftRef.current,
    shotTextContext: { ...scope, getCurrent: () => { counts.getCurrent++; return scope; } }, actionScope: 'action:1', actionEpoch: { current: 0 }, frameEpoch: { current: 0 },
    renderedAction: { frameEpoch: 0 }, renderSerial: 0, actionState: { current: { actionScope: 'action:1', referenceBlocked: false, referenceLocked } },
    visibleRef: { current: true }, tab: 'settings', referenceBusy: false, referencePending: false, busy: {}, generationOptionsKey: 'options:1',
    wanCapabilities: wan ? getWan30Capability('wan3.0-video', 'cn-beijing', 'wan30-v1') : null, videoInput,
    confirm: () => confirmation, setDraft: value => { queuedState.draft = value; }, setDirty: value => { queuedState.dirty = value; }, updateGeneration: value => { queuedState.generation = value; },
  };
  const realBoundaries = between(inspectorSource, '  const actionCurrent =', '  const shotText = useLocalShotText(') +
    between(inspectorSource, '  function updateVideoInput(', '  function updateWanParameter(') +
    between(inspectorSource, '  async function changeInputMode(', '  function chooseLastFrame(') +
    between(inspectorSource, '  async function clearLastFrame(', '  async function save(');
  const handlers = Function(...Object.keys(env), `${realBoundaries}; return { currentTextContext, changeInputMode, clearLastFrame };`)(...Object.values(env));
  const client = { get: async () => { counts.transport++; return emptyShot(); }, put: async () => { counts.transport++; throw Error('No persistence from close'); }, discard: async () => { counts.transport++; throw Error('No discard'); }, prepare: async () => { counts.transport++; throw Error('No prepare'); }, execute: async () => { counts.transport++; throw Error('No execute'); }, recover: async () => { counts.transport++; throw Error('No recovery'); } };
  shotText.controller = createShot({ context: handlers.currentTextContext(), getContext: handlers.currentTextContext, client, isShotUpdateInput: value => schemas['shot.update'].safeParse(value).success, onChange: () => counts.onChange++, delay: 60000 });
  await shotText.controller.load();
  const registrationSource = between(inspectorSource, '  useLayoutEffect(() => { if (!shot || !onShotTextController)', '  const textBlocksLegacy =');
  Function(...Object.keys(env), 'onShotTextController', 'useLayoutEffect', registrationSource)(...Object.values(env), register, callback => { unregister = callback(); });
  const expression = appSource.match(/readLegacySnapshot: \(\) => readNativeLegacyClose\((\{[\s\S]*?\})\),/)?.[1]; assert.ok(expression);
  const bindings = { readNativeLegacyClose, shotTextRef: appShot, shotCloseRef: appLocal, dirtyRef: { current: false }, clipDraftRef: { current: null }, timelineFormatRef: { current: null }, deliveryNameRef: { current: null }, subtitlesRef: { current: null }, subjectsRef: { current: null } };
  const read = Function('env', `with(env) { return () => readNativeLegacyClose(${expression}); }`)(bindings);
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(), readScope: () => 'scope:1', readLegacySnapshot: read, now: () => 1000, newToken: () => 'token' });
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { counts.timer++; return originalSet(...args); });
  t.mock.method(globalThis, 'clearTimeout', (...args) => { counts.clearTimer++; return originalClear(...args); });
  t.after(() => { unregister?.(); shotText.controller.dispose(); admission.dispose(); });
  return { ...handlers, refs, queuedState, counts, appShot, appLocal, register, read, admission, controller: shotText.controller, resolveConfirmation,
    resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; },
    commit: token => admission.commit(token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1500 }),
    unload() { let prevented = false; const result = admission.beforeUnload({ preventDefault: () => { prevented = true; }, returnValue: '' }); return { result, prevented }; },
  };
}

for (const stage of ['commit', 'unload']) test(`deferred Inspector input-mode continuation invalidates ${stage} before layout, without final-reader effects`, async t => {
  const f = await inspectorContinuation(t), pending = f.changeInputMode('text');
  // The originating DOM event has already happened before this inspection.
  // Only its later confirmation continuation runs after capture; ordinary DOM
  // events retain their separate admission interaction-counter protection.
  const capture = f.admission.inspect(); assert.equal(capture.disposition, 'clean');
  if (stage === 'unload') assert.equal(f.commit(capture.token), true);
  f.resetCounts(); f.resolveConfirmation(true); await pending;
  assert.equal(f.refs.editSerial.current, 1); assert.equal(f.queuedState.dirty, true);
  assert.equal(f.controller.getNativeCloseSnapshot().formSerial, 0, 'React layout synchronization is deliberately deferred');
  assert.equal(f.controller.getNativeCloseSnapshot().dirty, false, 'The old controller alone does not yet know the nontext edit');
  assert.equal(f.read().dirty, true, 'The actual registered local reader observes the continuation');
  if (stage === 'commit') assert.equal(f.commit(capture.token), false); else assert.deepEqual(f.unload(), { result: false, prevented: true });
  assert.deepEqual(f.counts, { getCurrent: 0, onChange: 0, transport: 0, timer: 0, clearTimer: 0 });
});

test('Inspector Wan input-mode changes preserve saved references and only update session generation input', async t => {
  for (const [mode, expectedMode, keepImages] of [['image', 'first_frame', true], ['frames', 'first_last_frame', true], ['reference', 'reference_images', false], ['text', 'text', false]]) {
    const videoInput = { version: 1, mode: 'first_frame', images: [{ role: 'first_frame', assetId: id(25) }], prompt: 'Session prompt' };
    const f = await inspectorContinuation(t, { wan: true, videoInput, referenceLocked: true });
    const originalDraft = f.refs.draftRef.current;
    f.resetCounts();
    // An unresolved confirmation would leave this pending if Wan used the legacy
    // saved-reference deletion path instead of its session-only input controls.
    await f.changeInputMode(mode);
    assert.deepEqual(f.queuedState.generation, { videoInput: { ...videoInput, mode: expectedMode, images: keepImages ? videoInput.images : [] } });
    assert.equal(f.refs.draftRef.current, originalDraft); assert.equal(f.refs.editSerial.current, 0); assert.equal(f.refs.dirtyRef.current, false);
    assert.equal(f.controller.getNativeCloseSnapshot().dirty, false); assert.equal(f.read().dirty, false);
    assert.deepEqual(f.counts, { getCurrent: 0, onChange: 0, transport: 0, timer: 0, clearTimer: 0 });
  }
});

test('Inspector clearLastFrame control already synchronizes through edit; final close still reads purely', async t => {
  const f = await inspectorContinuation(t), pending = f.clearLastFrame(), capture = f.admission.inspect();
  f.resolveConfirmation(true); await pending;
  assert.equal(f.refs.draftRef.current.lastFrameAssetId, null); assert.equal(f.controller.getNativeCloseSnapshot().formSerial, 1);
  assert.ok(f.counts.getCurrent > 0, 'Existing edit path synchronizes, unlike the deferred input-mode continuation');
  f.resetCounts(); assert.equal(f.read().dirty, true); assert.equal(f.commit(capture.token), false); assert.deepEqual(f.unload(), { result: false, prevented: true });
  assert.deepEqual(f.counts, { getCurrent: 0, onChange: 0, transport: 0, timer: 0, clearTimer: 0 });
});

test('equal/older local dirty references do not revive controller-abandoned input', async t => {
  const f = await inspectorContinuation(t), pending = f.clearLastFrame(); f.resolveConfirmation(true); await pending;
  assert.equal(f.controller.abandonCurrentInput(), true); assert.equal(f.refs.dirtyRef.current, true, 'Local React state has not yet rerendered');
  f.resetCounts(); assert.equal(f.controller.getNativeCloseSnapshot().dirty, false); assert.equal(f.read().dirty, false);
  assert.deepEqual(f.counts, { getCurrent: 0, onChange: 0, transport: 0, timer: 0, clearTimer: 0 });
});

test('actual App same-controller replacement owns its close reader and ignores stale unregister', async t => {
  const f = await inspectorContinuation(t), oldRead = f.appLocal.current.readLocalClose;
  const releaseOld = f.register(f.controller, oldRead), newest = () => ({ ...oldRead(), formSerial: 20, dirty: true });
  const releaseNew = f.register(f.controller, newest); releaseOld();
  assert.equal(f.appShot.current, f.controller); assert.equal(f.appLocal.current.readLocalClose, newest); assert.equal(f.read().dirty, true);
  releaseNew(); assert.equal(f.appShot.current, null); assert.equal(f.appLocal.current, null);
});
