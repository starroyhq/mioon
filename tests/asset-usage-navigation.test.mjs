import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectOpenAttempt, canPublishProjectOpen } from '../apps/web/src/project-open-state.ts';
import { deriveTimelineAssetUsage } from '../apps/web/src/timeline-asset-usage.ts';
import { locateTimelineAssetUse, matchesTimelineAssetUse, revealTimelineAssetUse } from '../apps/web/src/timeline-asset-navigation.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id = n => `ce100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const projectId = id(1), assetId = id(2);
  const assets = [{ id: assetId, projectId, name: '原始素材', sha256: 'a'.repeat(64), mimeType: 'video/mp4' }];
  const timeline = { id: id(3), projectId, revision: 3, durationFrames: 150, fps: 30,
    tracks: [{ id: id(4), kind: 'video', orderIndex: 0, name: '画面一', hidden: false, muted: false }],
    clips: [{ id: id(5), assetId, trackId: id(4), name: '片段一', startFrame: 90, sourceInFrame: 15, durationFrames: 60, rect: { x: 0, y: 0, width: 1280, height: 720 }, gain: 1 }] };
  let ready = true;
  const state = { active: true, projectId, projectEpoch: 1, navigationEpoch: 2, panelIntent: 3, attempt: 1, workspaceScope: 'normal' };
  const read = () => ({ ...state, usage: deriveTimelineAssetUsage({ projectId: state.projectId, assets, timeline, ready }) });
  const use = read().usage.usesByAssetId[assetId]?.[0]; assert.ok(use);
  return { assets, timeline, state, read, use, setReady: value => { ready = value; } };
}
const held = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('a chosen saved use passes exact identity, asks once and reveals without changing source snapshots', async () => {
  const f = fixture(), before = JSON.stringify([f.assets, f.timeline]), calls = [];
  assert.equal(await locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => true,
    confirm: async current => { assert.equal(current(), true); calls.push('confirm'); return true; }, reveal: use => calls.push(use) }), true);
  assert.deepEqual(calls, ['confirm', f.use]); assert.equal(JSON.stringify([f.assets, f.timeline]), before);
});
for (const [label, change] of [
  ['project', f => { f.state.projectId = id(9); }], ['project epoch', f => f.state.projectEpoch++],
  ['new selection', f => f.state.navigationEpoch++], ['panel intent', f => f.state.panelIntent++], ['new usage request', f => f.state.attempt++],
  ['workspace', f => { f.state.workspaceScope = 'restored:' + id(9); }], ['unmount', f => { f.state.active = false; }],
  ['unknown refresh', f => f.setReady(false)], ['new timeline', f => { f.timeline.id = id(9); }], ['revision', f => f.timeline.revision++],
  ['deleted clip', f => { f.timeline.clips = []; f.timeline.durationFrames = 0; }],
  ['same-revision moved clip', f => { f.timeline.clips[0].startFrame++; f.timeline.durationFrames++; }],
  ['same-revision asset source hash', f => { f.assets[0].sha256 = 'b'.repeat(64); }],
  ['same-revision name', f => { f.timeline.clips[0].name = '另一个版本'; }],
]) test(`held confirmation rejects changed ${label} before discard and before selection`, async () => {
  const f = fixture(), gate = held(); let predicate, revealed = 0;
  const result = locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => true, confirm: current => { predicate = current; return gate.promise; }, reveal: () => revealed++ });
  assert.equal(predicate(), true); change(f); assert.equal(predicate(), false); gate.resolve(true);
  assert.equal(await result, false); assert.equal(revealed, 0);
});
test('hidden/filtered/unmounted row and declined confirmation never reveal', async () => {
  for (const decline of [false, true]) {
    const f = fixture(), gate = held(); let visible = true, predicate;
    const result = locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => visible, confirm: current => { predicate = current; return gate.promise; }, reveal: () => assert.fail('No stale reveal') });
    if (!decline) visible = false;
    assert.equal(predicate(), decline); gate.resolve(!decline); assert.equal(await result, false);
  }
});
test('stale row, unknown state or missing workspace identity do not even ask to discard', async () => {
  for (const change of [f => f.setReady(false), f => f.timeline.revision++, f => { f.state.workspaceScope = null; }]) {
    const f = fixture(); change(f);
    assert.equal(await locateTimelineAssetUse(f.use, { read: f.read, isVisible: () => true, confirm: () => assert.fail('No confirmation'), reveal: () => assert.fail('No reveal') }), false);
  }
});

test('viewport reveal is bounded to its exact child and both layout callbacks respect a later selection', () => {
  for (const invalidateAt of [0, 1, 2]) {
    let valid = true; const queued = [];
    const clip = { dataset: { testid: 'timeline-clip-' + id(5) }, getBoundingClientRect: () => ({ left: 900, right: 940, top: 700, bottom: 750 }) };
    const viewport = { scrollLeft: 0, scrollTop: 0, querySelectorAll: selector => { assert.equal(selector, '[data-testid]'); return [clip]; }, getBoundingClientRect: () => ({ left: 10, right: 500, top: 50, bottom: 300 }) };
    revealTimelineAssetUse(id(5), () => valid, () => viewport, callback => queued.push(callback));
    if (invalidateAt === 0) valid = false; queued.shift()();
    if (invalidateAt === 1) valid = false; queued.shift()?.();
    assert.equal(viewport.scrollLeft, invalidateAt === 2 ? 722 : 0); assert.equal(viewport.scrollTop, invalidateAt === 2 ? 642 : 0);
  }
});

const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const section = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const readySource = section('  function projectSessionReady()', '  const workbenchReady =');
const bridge = section('  function readAssetUsageNavigation()', '  function timelineFormatContext()');
function appHarness() {
  const f = fixture(), calls = [], gate = held(); let predicate;
  const env = { msg, ...createI18nTestContext(), deriveTimelineAssetUsage, locateTimelineAssetUse, matchesTimelineAssetUse, canPublishProjectOpen,
    openedProject: { current: projectOpenAttempt(f.state.projectId, f.state.projectEpoch, f.state.workspaceScope) },
    revealTimelineAssetUse: (...args) => calls.push(['scroll', ...args]),
    currentProject: { current: f.state.projectId }, dataRef: { current: { project: { id: f.state.projectId }, timeline: f.timeline, assets: f.assets } },
    importSession: { current: { active: true, selection: 0 } }, viewReady: { current: true }, projectEpoch: { current: 1 }, navigationEpoch: { current: 2 }, panelIntent: { current: 3 }, assetUsageAttempt: { current: 0 },
    workspaceRef: { current: { restored: false } }, workspaceOriginScope: value => value.restored ? 'restored:' + value.workspaceOrigin : 'normal', assetUsageAvailability: { current: { ready: true } }, isBusy: () => false,
    guardNavigation: (message, dirty, current) => { assert.match(renderCoreMessage('zh-Hans', message), /定位此素材/); assert.equal(dirty, false); predicate = current; return gate.promise; },
    setPropertiesPage: value => calls.push(['properties', value]), setRightDockTab: value => calls.push(['dock', value]),
    viewRef: { current: { activeMode: 'canvas', editing: {} } },
    updateView: (area, value) => { calls.push(['view', area, value]); if (area === 'activeMode') env.viewRef.current.activeMode = value; else Object.assign(env.viewRef.current[area], value); },
    setPanelOpen: (...args) => { calls.push(['panel', ...args]); env.panelIntent.current++; }, setMobilePanel: value => calls.push(['mobile', value]), geometry: { narrow: false },
    context: () => ({ epoch: env.navigationEpoch.current }), isCurrent: captured => captured.epoch === env.navigationEpoch.current,
    document: {}, requestAnimationFrame: () => assert.fail('Scheduled by dedicated helper'),
  };
  const api = Function(...Object.keys(env), `${readySource}\n${bridge}; return {readAssetUsageNavigation,locateAssetUse};`)(...Object.values(env));
  return { f, env, api, calls, gate, predicate: () => predicate };
}
test('actual App bridge opens the chosen clip in Properties and saved timeline without business calls', async () => {
  const h = appHarness(), before = JSON.stringify(h.env.dataRef.current);
  const pending = h.api.locateAssetUse(h.f.use, () => true); assert.equal(h.predicate()(), true); h.gate.resolve(true); assert.equal(await pending, true);
  assert.equal(h.env.viewRef.current.activeMode, 'editing'); assert.equal(h.env.viewRef.current.editing.selectedClipId, h.f.use.clipId); assert.equal(h.env.viewRef.current.editing.playhead, 90); assert.equal(h.env.viewRef.current.editing.timelineCollapsed, false);
  assert.ok(h.calls.some(call => call[0] === 'dock' && call[1] === 'properties')); assert.ok(h.calls.some(call => call[0] === 'panel' && call[1] === 'inspector' && call[2] === true));
  assert.equal(JSON.stringify(h.env.dataRef.current), before); assert.equal(h.calls.filter(call => call[0] === 'scroll').length, 1);
});
for (const key of ['projectEpoch', 'navigationEpoch', 'panelIntent', 'assetUsageAttempt']) test(`actual App bridge checks live ${key} after dirty confirmation`, async () => {
  const h = appHarness(), pending = h.api.locateAssetUse(h.f.use, () => true); h.env[key].current++; assert.equal(h.predicate()(), false); h.gate.resolve(true);
  assert.equal(await pending, false); assert.deepEqual(h.calls, []);
});
test('actual App bridge refuses an unaccepted home session before or during discard confirmation', async () => {
  for (const timing of ['before', 'during']) {
    const h = appHarness();
    if (timing === 'before') h.env.openedProject.current = null;
    const pending = h.api.locateAssetUse(h.f.use, () => true);
    if (timing === 'during') {
      assert.equal(h.predicate()(), true);
      h.env.openedProject.current = null;
      assert.equal(h.predicate()(), false);
    } else assert.equal(h.predicate(), undefined, 'Home cannot even ask to discard a project draft');
    h.gate.resolve(true);
    assert.equal(await pending, false); assert.deepEqual(h.calls, []);
    assert.equal(h.api.readAssetUsageNavigation().active, false);
  }
});
test('App passes the target fence through the actual clip discard boundary', async () => {
  const guard = section('  async function guardNavigation(', '  async function guardProjectNavigation(');
  let passed, dirty = true;
  const env = { nativeWindow: null, context: () => 'owner', isCurrent: () => true, subtitlesRef: { current: null }, shotTextRef: { current: null },
    clipDraftRef: { current: { capture: () => 'token', hasUnsaved: () => true, isCurrent: () => true, hasPendingComposition: () => false, discard: async (token, fence) => { assert.equal(token, 'token'); passed = fence; return false; } } },
    dirtyRef: { current: true }, confirm: async () => true, subjectsRef: { current: null },
    setShotDirty: () => assert.fail('No clear'), setClipDirty: () => { dirty = false; }, setSourceDirty: () => assert.fail('No clear'), setSubjectDirty: () => assert.fail('No clear'), setSubtitleDirty: () => assert.fail('No clear'), setInspectorEpoch: () => assert.fail('No clear') };
  const run = Function(...Object.keys(env), `${guard}; return guardNavigation;`)(...Object.values(env));
  const current = () => true; assert.equal(await run('Confirm', false, current), false); assert.equal(passed, current); assert.equal(dirty, true);
});
