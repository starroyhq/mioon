import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClipDraftController } from '../apps/web/src/clip-draft-state.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.js';

// Run the actual selection callbacks, navigation guard, and clip draft controller.
// Only React state setters, confirmation, and the local-draft transport are fixtures.
const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
function section(start, end) {
  const at = app.indexOf(start), until = app.indexOf(end, at + start.length);
  assert.ok(at >= 0 && until > at, `Missing actual App extraction: ${start}`);
  assert.equal(app.indexOf(start, at + start.length), -1, `Ambiguous actual App extraction: ${start}`);
  return app.slice(at, until);
}
const source = [
  section('  const context = () =>', '  taskWorkspaceState.current ='),
  section('  async function guardNavigation(', '  async function guardProjectNavigation('),
  section('  function leaveReferencePage()', '  function checkGeneration('),
  section('  async function selectClip(', '  async function addTimelineAsset('),
].join('\n');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const id = n => `85000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const raw = { name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 90, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 } };
const clipSource = { assetId: id(5), assetSha256: 'a'.repeat(64) };
const targetClipId = id(7), targetShotId = id(8), targetNodeId = id(9), selectedShotId = id(10);
const rejectUnexpected = name => () => assert.fail(`Unexpected dependency: ${name}`);

function harness({ dock = 'tasks', page = 'format', mode = 'editing', dirty = false, confirm = async () => true, controller = null, quickAssetId = null, narrow = false } = {}) {
  const events = [], resets = [], confirmations = [];
  const formatDraft = Object.freeze({ width: '1280', height: '', dirty: true });
  const state = { dock, page, mobile: 'canvas', view: { activeMode: mode,
    canvas: { selectedId: selectedShotId, inspectorTab: 'settings', highlightedVersionId: null },
    editing: { selectedClipId: key.clipId, quickAssetId, playhead: 12, previewKind: 'timeline' } } };
  const env = {
    selectedId: selectedShotId, selectedClipId: key.clipId, workspaceMode: mode, quickAssetId,
    currentProject: { current: key.projectId }, navigationEpoch: { current: 5 }, panelIntent: { current: 2 },
    workspaceRef: { current: { restored: false } }, workspaceOriginScope,
    dataRef: { current: { shots: [{ id: selectedShotId }, { id: targetShotId }], nodes: [{ id: targetNodeId }],
      timeline: { id: key.timelineId, projectId: key.projectId, revision: 7, clips: [
        { ...raw, id: key.clipId, ...clipSource }, { ...raw, id: targetClipId, ...clipSource, startFrame: 90 },
      ] } } },
    dirtyRef: { current: dirty }, clipDraftRef: { current: controller }, shotTextRef: { current: null }, subtitlesRef: { current: null },
    subjectsRef: { current: { state: { scope: 'subject-owner' }, controller: { discardDrafts: scope => { assert.equal(scope, 'subject-owner'); resets.push(['subjects']); } } } },
    timelineFormatRef: { current: { controller: { getState: () => formatDraft, hasUnsaved: () => true, discardDraft: rejectUnexpected('format draft discard') } } },
    confirm: message => { confirmations.push(message); return confirm(message); },
    setRightDockTab: value => { state.dock = typeof value === 'function' ? value(state.dock) : value; events.push(['dock', state.dock]); },
    setPropertiesPage: value => { assert.equal(value, 'inspector'); state.page = value; events.push(['page', value]); },
    updateView: (area, value) => {
      assert.ok(['canvas', 'editing', 'activeMode'].includes(area));
      if (area === 'activeMode') state.view.activeMode = value; else Object.assign(state.view[area], value);
      events.push(['view', area, value]);
    },
    setPanelOpen: (...args) => { assert.deepEqual(args, ['inspector', true, 'canvas']); env.panelIntent.current++; events.push(['panel', ...args]); },
    setMobilePanel: value => { assert.ok(['canvas', 'inspector'].includes(value)); state.mobile = value; events.push(['mobile', value]); },
    geometry: { narrow },
    ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, value => resets.push([name, typeof value === 'function' ? value(3) : value])])),
    run: rejectUnexpected('business mutation'), rpc: rejectUnexpected('RPC'),
  };
  const api = Function(...Object.keys(env), `${source}\nreturn { inspect, selectClip };`)(...Object.values(env));
  return { env, api, state, events, resets, confirmations, formatDraft,
    chooseDock(value) { env.panelIntent.current++; state.dock = value; },
  };
}

function draftFixture(t) {
  let stored = { supported: true, workspaceScope: 'b'.repeat(64), instanceId: id(6), key, revision: 0, targetStatus: 'matching', draft: null };
  let removeGate = null;
  const writes = [], removals = [], removeEntered = deferred();
  const context = { ...key, scope: 'project:1:clip:1', restored: false, connected: true, busy: false, visible: true, timelineRevision: 7, source: clipSource, saved: raw };
  const controller = createClipDraftController({
    context,
    delay: 60_000,
    client: {
      get: async input => { assert.deepEqual(input, key); return structuredClone(stored); },
      put: async input => {
        assert.deepEqual({ projectId: input.projectId, timelineId: input.timelineId, clipId: input.clipId }, key);
        assert.equal(input.workspaceScope, stored.workspaceScope); assert.equal(input.instanceId, stored.instanceId); assert.equal(input.expectedRevision, stored.revision);
        writes.push(structuredClone(input));
        stored = { ...stored, revision: stored.revision + 1, draft: { raw: structuredClone(input.raw), source: input.source, baseRevision: input.baseRevision, updatedAt: '2026-10-13T00:00:00.000Z' } };
        return structuredClone(stored);
      },
      remove: async input => {
        assert.deepEqual(input, { ...key, workspaceScope: stored.workspaceScope, instanceId: stored.instanceId, expectedRevision: stored.revision });
        removals.push(structuredClone(input)); removeEntered.resolve(); await removeGate?.promise;
        assert.equal(input.expectedRevision, stored.revision);
        stored = { ...stored, revision: stored.revision + 1, draft: null }; return structuredClone(stored);
      },
    },
  });
  t.after(() => controller.dispose());
  return { controller, context, writes, removals, removeEntered: removeEntered.promise, stored: () => structuredClone(stored),
    async ready(name = 'Unsent clip') { await controller.load(); assert.equal(controller.edit('name', name), true); await controller.flush(); },
    holdRemove() { return removeGate = deferred(); },
  };
}

const actions = [
  { name: 'inspect shot', invoke: h => h.api.inspect(targetShotId), target: targetShotId },
  { name: 'select clip', invoke: h => h.api.selectClip(targetClipId), target: targetClipId },
];
function unchanged(h, before) { assert.deepEqual(h.state, before); assert.deepEqual(h.events, []); }

for (const dock of ['tasks', 'delivery']) {
  for (const target of [targetShotId, targetNodeId]) test(`actual inspect reveals ${target === targetShotId ? 'shot' : 'node'} inspector from ${dock} over a retained format draft`, async () => {
    const h = harness({ dock }), data = structuredClone(h.env.dataRef.current), epoch = h.env.navigationEpoch.current;
    assert.equal(await h.api.inspect(target, 'versions', id(20), { reveal: true }), true);
    assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector'); assert.equal(h.state.view.activeMode, 'canvas');
    assert.deepEqual(h.state.view.canvas, { selectedId: target, inspectorTab: 'versions', highlightedVersionId: id(20) });
    assert.equal(h.env.navigationEpoch.current, epoch + 1); assert.ok(h.events.some(event => event[0] === 'panel'));
    assert.equal(h.env.timelineFormatRef.current.controller.getState(), h.formatDraft); assert.equal(h.formatDraft.height, '');
    assert.deepEqual(h.env.dataRef.current, data); assert.deepEqual(h.resets, []); assert.deepEqual(h.confirmations, []);
  });
  test(`actual selectClip reveals Properties from ${dock} and preserves preview when requested`, async () => {
    const h = harness({ dock }), data = structuredClone(h.env.dataRef.current);
    await h.api.selectClip(targetClipId, false);
    assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector'); assert.equal(h.state.view.activeMode, 'editing');
    assert.deepEqual(h.state.view.editing, { selectedClipId: targetClipId, quickAssetId: null, playhead: 90, previewKind: 'timeline' });
    assert.deepEqual(h.env.dataRef.current, data); assert.deepEqual(h.resets, []); assert.deepEqual(h.confirmations, []);
  });
}
for (const dock of ['agent', 'image', 'properties']) for (const action of actions) test(`actual ${action.name} preserves the chosen ${dock} dock`, async () => {
  const h = harness({ dock }); await action.invoke(h);
  assert.equal(h.state.dock, dock); assert.equal(h.state.page, 'inspector');
  assert.equal(h.state.view.activeMode, action.name === 'inspect shot' ? 'canvas' : 'editing');
  assert.deepEqual(h.resets, []); assert.deepEqual(h.confirmations, []);
});

test('same shot selection keeps the current draft and supports explicit narrow-screen reveal', async () => {
  const h = harness({ mode: 'canvas', dirty: true, narrow: true });
  assert.equal(await h.api.inspect(selectedShotId, 'versions', id(20), { reveal: true }), true);
  assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector'); assert.equal(h.state.mobile, 'inspector');
  assert.equal(h.state.view.canvas.selectedId, selectedShotId); assert.equal(h.state.view.canvas.highlightedVersionId, id(20));
  assert.equal(h.env.dirtyRef.current, true); assert.deepEqual(h.confirmations, []); assert.deepEqual(h.resets, []);
});
test('same clip selection keeps the current draft and restores the source preview', async () => {
  const h = harness({ dirty: true }); await h.api.selectClip(key.clipId);
  assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector');
  assert.deepEqual(h.state.view.editing, { selectedClipId: key.clipId, quickAssetId: null, playhead: 0, previewKind: 'source' });
  assert.equal(h.env.dirtyRef.current, true); assert.deepEqual(h.confirmations, []); assert.deepEqual(h.resets, []);
});
for (const options of [{ quickAssetId: id(30) }, { mode: 'canvas' }]) test(`same clip still checks unsaved input when ${options.quickAssetId ? 'an asset is open' : 'leaving canvas'}`, async () => {
  const h = harness({ ...options, dirty: true, confirm: async () => false }), before = structuredClone(h.state);
  await h.api.selectClip(key.clipId); unchanged(h, before); assert.equal(h.confirmations.length, 1); assert.deepEqual(h.resets, []);
});
test('same clip selection still guards a dirty subtitle controller', async () => {
  const h = harness({ confirm: async () => false }), before = structuredClone(h.state), subtitle = { text: 'Unsent subtitle' };
  h.env.subtitlesRef.current = { controller: { getState: () => subtitle, hasUnsaved: () => true, discardDraft: rejectUnexpected('declined subtitle discard') } };
  await h.api.selectClip(key.clipId); unchanged(h, before); assert.equal(h.confirmations.length, 1); assert.deepEqual(h.resets, []);
});

for (const action of actions) {
  test(`actual ${action.name} decline retains the dock, format page, selection and dirty clip`, async t => {
    const f = draftFixture(t); await f.ready();
    const h = harness({ controller: f.controller, dirty: true, confirm: async () => false }), before = structuredClone(h.state);
    await action.invoke(h); unchanged(h, before); assert.equal(h.confirmations.length, 1); assert.deepEqual(h.resets, []);
    assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true); assert.deepEqual(f.removals, []);
  });
  test(`actual ${action.name} missing target never changes the dock or Properties page`, async () => {
    const h = harness(), before = structuredClone(h.state), epoch = h.env.navigationEpoch.current;
    if (action.name === 'inspect shot') assert.equal(await h.api.inspect(id(99)), false); else await h.api.selectClip(id(99));
    unchanged(h, before); assert.equal(h.env.navigationEpoch.current, epoch); assert.deepEqual(h.resets, []);
  });
  test(`actual ${action.name} target removed during confirmation preserves the real dirty clip without DELETE`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), before = structuredClone(h.state);
    const pending = action.invoke(h);
    h.env.dataRef.current.shots = []; h.env.dataRef.current.timeline.clips = [];
    gate.resolve(true); await pending; unchanged(h, before);
    assert.deepEqual(f.removals, []); assert.deepEqual(h.resets, []); assert.equal(h.env.dirtyRef.current, true);
    assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  });
  test(`actual ${action.name} source replacement during confirmation blocks navigation while the clip capture remains current`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), before = structuredClone(h.state);
    const capture = f.controller.capture(), pending = action.invoke(h);
    assert.equal(h.confirmations.length, 1); assert.equal(f.controller.isCurrent(capture), true);
    const replacementSource = { ...clipSource, assetId: id(31), assetSha256: 'c'.repeat(64) };
    h.env.dataRef.current.timeline.revision = 8;
    Object.assign(h.env.dataRef.current.timeline.clips[0], replacementSource);
    f.controller.setContext({ ...f.context, source: replacementSource, timelineRevision: 8 });
    const afterReplacement = { captureCurrent: f.controller.isCurrent(capture), input: f.controller.getState().raw.name, conflict: f.controller.getState().conflict };
    gate.resolve(true); await pending;
    assert.deepEqual({ afterReplacement, input: f.controller.getState().raw.name, dirty: f.controller.hasUnsaved(), removals: f.removals, events: h.events, resets: h.resets, view: h.state },
      { afterReplacement: { captureCurrent: true, input: 'Unsent clip', conflict: true }, input: 'Unsent clip', dirty: true, removals: [], events: [], resets: [], view: before });
  });
  test(`actual ${action.name} permits equivalent same-revision polling objects during confirmation`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise });
    const original = h.env.dataRef.current, pending = action.invoke(h);
    h.env.dataRef.current = structuredClone(original); f.controller.setContext(structuredClone(f.context));
    assert.notEqual(h.env.dataRef.current, original); assert.notEqual(h.env.dataRef.current.timeline, original.timeline);
    gate.resolve(true); await pending;
    assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector');
    assert.equal(h.state.view.activeMode, action.name === 'inspect shot' ? 'canvas' : 'editing');
    assert.equal(f.removals.length, 1); assert.equal(f.controller.hasUnsaved(), false);
    assert.deepEqual(h.env.dataRef.current, original);
  });
  test(`actual ${action.name} replacement timeline with the same revision cannot discard an old dirty owner`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), before = structuredClone(h.state);
    const pending = action.invoke(h);
    h.env.dataRef.current.timeline = { ...structuredClone(h.env.dataRef.current.timeline), id: id(32) };
    gate.resolve(true); await pending; unchanged(h, before); assert.deepEqual(h.resets, []); assert.deepEqual(f.removals, []);
    assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  });
  test(`actual ${action.name} source replacement during pending DELETE preserves input without pretending to roll back its ACK`, async t => {
    const f = draftFixture(t); await f.ready(); const remove = f.holdRemove();
    const h = harness({ controller: f.controller, dirty: true }), before = structuredClone(h.state);
    const capture = f.controller.capture(), pending = action.invoke(h);
    await f.removeEntered; assert.deepEqual(h.events, []); assert.deepEqual(h.resets, []);
    const replacementSource = { ...clipSource, assetId: id(31), assetSha256: 'c'.repeat(64) };
    h.env.dataRef.current.timeline.revision = 8;
    Object.assign(h.env.dataRef.current.timeline.clips[0], replacementSource);
    f.controller.setContext({ ...f.context, source: replacementSource, timelineRevision: 8 });
    assert.equal(f.controller.isCurrent(capture), true); assert.equal(f.controller.getState().conflict, true);
    remove.resolve(); await pending; unchanged(h, before); assert.deepEqual(h.resets, []);
    assert.equal(h.env.dirtyRef.current, true); assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
    assert.equal(f.removals.length, 1); assert.equal(f.stored().draft, null, 'The already-issued DELETE is acknowledged, not rolled back');
  });
  for (const change of ['project', 'selection', 'workspace']) test(`actual ${action.name} rejects changed ${change} during confirmation before discarding`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), before = structuredClone(h.state), pending = action.invoke(h);
    if (change === 'project') h.env.currentProject.current = id(90);
    if (change === 'selection') h.env.navigationEpoch.current++;
    if (change === 'workspace') h.env.workspaceRef.current = { restored: true, workspaceOrigin: id(90) };
    gate.resolve(true); await pending; unchanged(h, before); assert.deepEqual(h.resets, []); assert.deepEqual(f.removals, []);
    assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  });
  for (const dock of ['tasks', 'delivery', 'agent', 'image']) test(`actual ${action.name} rejects newer ${dock} panel choice during confirmation before discarding`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), pending = action.invoke(h);
    h.chooseDock(dock); const before = structuredClone(h.state);
    gate.resolve(true); await pending; unchanged(h, before); assert.deepEqual(h.resets, []); assert.deepEqual(f.removals, []);
    assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
  });
  test(`actual ${action.name} rechecks panel choice after a clean guard resolves`, async () => {
    const h = harness(), pending = action.invoke(h);
    h.chooseDock('delivery'); const before = structuredClone(h.state);
    await pending; unchanged(h, before); assert.deepEqual(h.resets, []); assert.deepEqual(h.confirmations, []);
  });
  for (const dock of ['tasks', 'delivery']) test(`actual ${action.name} late DELETE ACK cannot steal newer ${dock} panel or clear its input`, async t => {
    const f = draftFixture(t); await f.ready(); const remove = f.holdRemove();
    const h = harness({ controller: f.controller, dirty: true }), pending = action.invoke(h);
    await f.removeEntered; assert.deepEqual(h.events, []); assert.deepEqual(h.resets, []);
    h.chooseDock(dock); const before = structuredClone(h.state);
    remove.resolve(); await pending; unchanged(h, before); assert.deepEqual(h.resets, []);
    assert.equal(h.env.dirtyRef.current, true); assert.equal(f.controller.getState().raw.name, 'Unsent clip'); assert.equal(f.controller.hasUnsaved(), true);
    assert.equal(f.removals.length, 1); assert.equal(f.stored().draft, null, 'The already-issued DELETE is acknowledged, not rolled back');
  });
  test(`actual ${action.name} preserves newer clip input typed while DELETE is pending`, async t => {
    const f = draftFixture(t); await f.ready(); const remove = f.holdRemove();
    const h = harness({ controller: f.controller, dirty: true }), before = structuredClone(h.state), pending = action.invoke(h);
    await f.removeEntered; f.controller.edit('name', 'Newer input'); remove.resolve(); await pending;
    unchanged(h, before); assert.deepEqual(h.resets, []); assert.equal(f.controller.getState().raw.name, 'Newer input'); assert.equal(f.controller.hasUnsaved(), true);
  });
  test(`actual ${action.name} accepted unchanged dirty clip waits for DELETE before updating view`, async t => {
    const f = draftFixture(t); await f.ready(); const remove = f.holdRemove();
    const h = harness({ controller: f.controller, dirty: true }), pending = action.invoke(h);
    await f.removeEntered; assert.deepEqual(h.events, []); assert.deepEqual(h.resets, []);
    remove.resolve(); await pending;
    assert.equal(h.state.dock, 'properties'); assert.equal(h.state.page, 'inspector'); assert.equal(f.controller.hasUnsaved(), false);
    assert.equal(h.env.dirtyRef.current, false); assert.equal(h.confirmations.length, 1);
    assert.deepEqual(h.resets.map(([name]) => name), ['subjects', 'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch']);
  });
  for (const change of ['clip controller', 'shot capture', 'subtitle draft']) test(`actual ${action.name} preserves the existing ${change} ownership guard`, async t => {
    const f = draftFixture(t); await f.ready(); const gate = deferred();
    const h = harness({ controller: f.controller, dirty: true, confirm: () => gate.promise }), before = structuredClone(h.state);
    const shotCapture = {}, subtitle = { text: 'Original subtitle' }; let shotCurrent = true, subtitleState = subtitle;
    h.env.shotTextRef.current = { capture: () => shotCapture, isCurrent: token => token === shotCapture && shotCurrent, hasUnsaved: () => true, abandonCurrentInput: rejectUnexpected('stale shot discard') };
    h.env.subtitlesRef.current = { controller: { getState: () => subtitleState, hasUnsaved: () => true, discardDraft: rejectUnexpected('stale subtitle discard') } };
    const pending = action.invoke(h);
    if (change === 'clip controller') { const replacement = draftFixture(t); await replacement.ready('Replacement input'); h.env.clipDraftRef.current = replacement.controller; }
    if (change === 'shot capture') shotCurrent = false;
    if (change === 'subtitle draft') subtitleState = { text: 'Newer subtitle' };
    gate.resolve(true); await pending; unchanged(h, before); assert.deepEqual(h.resets, []); assert.deepEqual(f.removals, []);
    assert.equal(f.controller.hasUnsaved(), true);
  });
}
