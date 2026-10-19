import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import * as exportDisplay from '../apps/web/src/export-display.ts';
import * as i18n from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, resolveTimelineExportDelivery } from '@mioon/contracts';
import * as settingsState from '../apps/web/src/export-settings-state.ts';
import * as deliveryState from '../apps/web/src/export-delivery-state.ts';
import * as rangeState from '../apps/web/src/export-range-state.ts';
import * as preflightState from '../apps/web/src/export-preflight-state.ts';
import { prepareSubmission, prepareRequestReplay, readPending, reconcilePending } from '../apps/web/src/submissions.ts';
import { isDurableEditOperation } from '../apps/web/src/edit-task-client.ts';

import { lenientFunction } from './helpers/eval-source.mjs';
const Function = lenientFunction;
const id = n => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), hash = 'a'.repeat(64);
const timeline = { id: timelineId, projectId, revision: 4, width: 720, height: 1280, fps: 30, clips: [{ id: id(3) }] };
const settings = patch => ({ ...structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS), ...patch });
const context = patch => ({ scope: 'project:epoch1', projectId, timelineId, revision: 4, connected: true, exportSettings: settings(), settingsVersion: 1, ...patch });
const capability = (selection = settings(), patch = {}) => ({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, exportSettings: selection,
  delivery: resolveTimelineExportDelivery(timeline, selection), checkedAt: '2026-10-11T18:00:00.000Z', status: 'available', issues: [], ...patch });
const report = (selection = settings(), patch = {}) => ({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, snapshotHash: hash, checkedAt: '2026-10-11T18:00:00.000Z', status: 'ready',
  summary: { width: 720, height: 1280, fps: 30, durationFrames: 60, trackCount: 1, clipCount: 1, assetCount: 1, visualClipCount: 1, audibleClipCount: 0, mutedTrackCount: 0, hiddenVideoTrackCount: 0, delivery: resolveTimelineExportDelivery(timeline, selection) },
  checks: { totalAssets: 1, checkedAssets: 1, bytesHashed: 128, fullDecode: false }, issues: [], ...patch });
const incompleteReport = selection => report(selection, { status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
  checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false }, issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'Bounded ownership read incomplete' }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(patch = {}) {
  let live = context(patch); const calls = [], capabilities = [], reads = [], auth = [];
  const controller = preflightState.createExportPreflightController({ getContext: () => live,
    readCapabilities(input, options) { const task = deferred(); capabilities.push(task); calls.push({ operation: 'timeline.export.capabilities', input, options }); return task.promise; },
    read(input, options) { const task = deferred(); reads.push(task); calls.push({ operation: 'timeline.export.preflight', input, options }); return task.promise; }, onUnauthorized: () => auth.push(false) });
  controller.setContext(live); controller.setVisible(true);
  return { controller, calls, capabilities, reads, auth, get live() { return live; }, state: () => controller.getState(),
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    async ready(value = report(live.exportSettings)) { const waiting = controller.check(); capabilities.at(-1).resolve(capability(live.exportSettings)); await Promise.resolve(); assert.equal(calls.at(-1).operation, 'timeline.export.preflight'); reads.at(-1).resolve(value); await waiting; return controller.getState(); } };
}

test('settings use semantic identities, retain legacy omission, and freeze nested values', () => {
  const input = settings(), frozen = settingsState.freezeExportSettings(input);
  input.rateControl.quality = 'high'; assert.equal(frozen.rateControl.quality, 'standard');
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen.rateControl));
  assert.equal(settingsState.exportSettingsKey(settings()), settingsState.exportSettingsKey({ rateControl: { quality: 'standard', mode: 'crf' }, resolution: 'native', profileId: 'mp4_h264_v1' }));
  assert.notEqual(settingsState.exportSettingsKey(undefined), settingsState.exportSettingsKey(settings()));
  assert.equal(settingsState.freezeExportSettings(undefined), undefined);
  assert.equal(settingsState.exportSettingsKey(settings({ width: 1920 })), null);
});

test('ephemeral choices reset by project epoch, never rewrite geometry, and reject disabled or old control closures', () => {
  let live = { scope: 'a:1', enabled: true }; const controller = settingsState.createExportSettingsController({ getContext: () => live });
  controller.setContext(live); const first = controller.getState(), before = structuredClone(timeline);
  assert.equal(controller.choose(settings({ resolution: 'short_360' }), first.scope, first.version), true);
  const middle = controller.getState(); assert.equal(controller.choose(settings(), middle.scope, middle.version), true);
  assert.equal(controller.choose(settings({ resolution: 'short_1080' }), first.scope, first.version), false, 'A→B→A does not revive old settings closures');
  assert.deepEqual(timeline, before);
  live.enabled = false; assert.equal(controller.choose(settings({ resolution: 'short_1080' }), 'a:1', controller.getState().version), false);
  live = { scope: 'b:1', enabled: true }; assert.equal(controller.choose(settings({ resolution: 'short_1080' }), 'a:1'), false);
  assert.deepEqual(controller.getSettings('b:1'), settings());
  live = { scope: 'a:2', enabled: true }; controller.setContext(live); assert.deepEqual(controller.getSettings('a:2'), settings());
});

for (const [width, height, expected] of [[720, 1280, [[720,1280],[360,640],[1080,1920]]], [1280,720,[[1280,720],[640,360],[1920,1080]]], [720,720,[[720,720],[360,360],[1080,1080]]]]) {
  test(`UI describes all output dimensions separately from ${width}×${height} editing geometry`, () => {
    for (const [index, resolution] of ['native', 'short_360', 'short_1080'].entries()) {
      const saved = { ...timeline, width, height }, copy = structuredClone(saved), description = settingsState.selectedExportDelivery(saved, settings({ resolution }));
      assert.deepEqual([description.width, description.height], expected[index]); assert.equal(description.upscale, resolution === 'short_1080'); assert.deepEqual(saved, copy);
    }
  });
}

test('one explicit check sequences capability computation then read-only media preflight with identical settings', async () => {
  const f = fixture({ exportSettings: settings({ resolution: 'short_1080', rateControl: { mode: 'bitrate', targetKbps: 8000 } }) });
  f.controller.setVisible(false); f.controller.setVisible(true); assert.equal(f.calls.length, 0);
  const waiting = f.controller.check(); assert.equal(f.calls.length, 1); assert.equal(f.state().checkingStep, 'capability');
  assert.equal(f.reads.length, 0); assert.equal(f.state().binding, null);
  f.capabilities[0].resolve(capability(f.live.exportSettings)); await Promise.resolve();
  assert.equal(f.state().checkingStep, 'media'); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0].input, f.calls[1].input);
  assert.deepEqual(f.calls[0].input, { projectId, expectedRevision: 4, exportSettings: f.live.exportSettings });
  assert.equal(f.calls[0].options.signal, f.calls[1].options.signal);
  f.reads[0].resolve(report(f.live.exportSettings)); await waiting;
  assert.equal(f.state().phase, 'ready'); assert.equal(f.state().capabilityPhase, 'available'); assert.equal(f.state().attempted, false);
  assert.deepEqual(f.state().binding, { projectId, expectedRevision: 4, preflightSnapshotHash: hash, exportSettings: f.live.exportSettings });
  assert.ok(Object.isFrozen(f.state().binding.exportSettings.rateControl));
});

for (const [status, code] of [['unavailable','EXPORT_CAPABILITY_UNSUPPORTED'],['incomplete','EXPORT_CAPABILITY_TIMEOUT'],['incomplete','EXPORT_CAPABILITY_FAILED'],['incomplete','EXPORT_CAPABILITY_BUSY'],['blocked','INVALID_TIMELINE_SNAPSHOT'],['stale','EXPORT_CAPABILITY_STALE']]) {
  test(`${status}/${code} never runs media preflight or offers an unchecked capability bypass`, async () => {
    const f = fixture(), waiting = f.controller.check();
    f.capabilities[0].resolve(capability(f.live.exportSettings, { status, issues: [{ code, message: '/private/unsafe-output token=secret' }] })); await waiting;
    assert.equal(f.calls.length, 1); assert.equal(f.state().capabilityPhase, status); assert.equal(f.state().binding, null); assert.equal(f.state().uncheckedIntent, null);
    assert.equal(f.controller.takeExportBinding({ projectId, expectedRevision: 4 }), null);
    assert.equal(f.controller.takeUncheckedExportIntent({ projectId, expectedRevision: 4 }), null);
    assert.doesNotMatch(preflightState.exportCapabilityMessage(status), /private|token|secret/);
  });
}

test('capability unknown is distinct from unavailable and transport failures expose no raw paths', async () => {
  const f = fixture(), waiting = f.controller.check(); f.capabilities[0].reject(Error('/private/ffmpeg --token=secret')); await waiting;
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().capabilityPhase, 'incomplete'); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.state().error, /private|token|ffmpeg|secret/);
  assert.match(preflightState.exportCapabilityMessage('incomplete'), /尚未确认/);
  assert.match(preflightState.exportCapabilityMessage('unavailable'), /缺少/);
});

for (const patch of [{ exportSettings: settings({ resolution: 'short_360' }) }, { projectId: id(8) }, { expectedRevision: 99 }, { timelineId: id(9) }, { delivery: null }]) {
  test(`malformed or misbound capability is rejected: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(), waiting = f.controller.check(); f.capabilities[0].resolve(capability(f.live.exportSettings, patch)); await waiting;
    assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null); assert.equal(f.reads.length, 0);
  });
}

test('settings changes abort capability observation and obsolete authorization errors never log out the new owner', async () => {
  const f = fixture(), waiting = f.controller.check(), signal = f.calls[0].options.signal;
  f.set({ exportSettings: settings({ resolution: 'short_360' }), settingsVersion: 2 }); assert.equal(signal.aborted, true);
  f.capabilities[0].reject(Object.assign(Error('Late authorization'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.reads.length, 0); assert.equal(f.auth.length, 0); assert.equal(f.state().binding, null); assert.equal(f.state().error, '');
});

test('same-revision settings changes abort media reads and keep late responses from binding', async () => {
  const f = fixture(), waiting = f.controller.check(); f.capabilities[0].resolve(capability()); await Promise.resolve();
  f.set({ exportSettings: settings({ rateControl: { mode: 'crf', quality: 'high' } }), settingsVersion: 2 });
  assert.equal(f.calls[1].options.signal.aborted, true); f.reads[0].resolve(report()); await waiting;
  assert.equal(f.state().binding, null); assert.equal(f.state().report, null); assert.equal(f.state().attempted, false);
});

for (const step of ['capability', 'media']) {
  test(`hiding the panel aborts ${step} observation; reopening never probes or exports automatically`, async () => {
    const f = fixture(), waiting = f.controller.check();
    if (step === 'media') { f.capabilities[0].resolve(capability()); await Promise.resolve(); }
    const task = step === 'media' ? f.reads[0] : f.capabilities[0], count = f.calls.length;
    f.controller.setVisible(false); assert.equal(f.calls.at(-1).options.signal.aborted, true);
    task.resolve(step === 'media' ? report() : capability()); await waiting; f.controller.setVisible(true);
    assert.equal(f.calls.length, count); assert.equal(f.state().binding, null); assert.equal(f.state().uncheckedIntent, null);
  });
}

for (const unchecked of [false, true]) {
  test(`${unchecked ? 'unchecked' : 'checked'} export is settings-bound, one-use, and synchronously rejects stale live closures`, async () => {
    const f = fixture(); await f.ready(unchecked ? incompleteReport() : report());
    const take = value => unchecked ? f.controller.takeUncheckedExportIntent(value) : f.controller.takeExportBinding(value);
    const old = unchecked ? f.state().uncheckedIntent : f.state().binding; assert.ok(old);
    assert.deepEqual(old.exportSettings, settings()); assert.equal(take({ ...old }), null);
    f.set({ exportSettings: settings({ resolution: 'short_360' }), settingsVersion: 2 }, false);
    assert.equal(take(old), null, 'live settings change fences before React effect');
    await f.ready(unchecked ? incompleteReport(f.live.exportSettings) : report(f.live.exportSettings));
    const current = unchecked ? f.state().uncheckedIntent : f.state().binding;
    assert.equal(take(current), current); assert.equal(take(current), null); assert.equal(f.state().attempted, true);
    assert.equal(Object.hasOwn(current, 'preflightSnapshotHash'), !unchecked);
  });
}

test('A→B→A settings version invalidates late checks and old checked closures even if semantic values match', async () => {
  const f = fixture(); await f.ready(); const old = f.state().binding;
  f.set({ settingsVersion: 3 }, false); assert.equal(f.controller.takeExportBinding(old), null);
  const waiting = f.controller.check(); f.set({ settingsVersion: 5 }, false); f.capabilities.at(-1).resolve(capability()); await waiting;
  assert.equal(f.state().binding, null); assert.equal(f.state().settingsVersion, 5);
});

test('equivalent settings objects do not invalidate a checked binding or issue another read', async () => {
  const f = fixture(); await f.ready(); const binding = f.state().binding;
  f.set({ exportSettings: { rateControl: { quality: 'standard', mode: 'crf' }, resolution: 'native', profileId: 'mp4_h264_v1' } });
  assert.equal(f.state().binding, binding); assert.equal(f.calls.length, 2);
});

const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function appFunction(begin, end, scope) { const start = appSource.indexOf(begin), stop = appSource.indexOf(end, start); assert.ok(start >= 0 && stop > start); return Function(...Object.keys(scope), `return (${appSource.slice(start, stop).trim()});`)(...Object.values(scope)); }
function appHarness(f, { restored = false, localState = { baselineConflict: false, candidate: null } } = {}) {
  const calls = [], panels = [], notices = [], pending = [], submitOptions = []; let ids = 0;
  const environment = { clipDraftRef:{current:null}, markPanelIntent(){}, setShowTasks:value=>panels.push(['tasks',value]), setShowImage:value=>panels.push(['image',value]), setShowDelivery:value=>panels.push(['delivery',value]), msg: i18n.message, t: i18n.i18nTestModule().useI18n().t, panelIntent: { current: 0 }, setDeliveryAttempt() {}, setShowExports() {}, openExportHistory() {}, workspaceRef: { current: { restored } }, deliveryNameRef: { current: null }, exportPreflight: { controller: f.controller }, exportCheckContext: () => f.live, dataRef: { current: { project: { id: projectId }, timeline } }, currentProject: { current: projectId },
    setRightDockTab: value => panels.push(value), setPanelOpen: (...args) => panels.push(args), isBusy: () => false, pendingForProject: () => pending,
    notify: (...args) => notices.push(args), openTasks() {}, setShowExports() {}, updateView() {}, setPreviewKind() {},
    context: () => ({ scope: f.live.scope, projectId: environment.currentProject.current }), isCurrent: captured => captured.scope === f.live.scope && captured.projectId === environment.currentProject.current,
    localDeliveryRef: { current: { controller: { getState: () => localState, canPrepare: () => true, submit: async (input, options) => { calls.push(['local-delivery.submit', input]); submitOptions.push(options); return { id: id(20) }; } } } },
    requestId: () => { ids++; return 'frozen-render-id'; }, run: async (...args) => { calls.push(args); return { id: id(20) }; } };
  return { calls, panels, pending, submitOptions, ids: () => ids,
    open: appFunction('  function openTimelineExport(', '  const historyState', environment),
    // The adjacent passive loudness hook is a separate declaration, not part
    // of the function under test. All original capability/intent assertions stay.
    check: appFunction('  function checkTimelineExport(', '  const exportLoudness =', environment),
    render: appFunction('  async function renderTimeline(', '  async function previewSource(', environment) };
}

test('actual App open is passive, explicit Check performs both operations, and export freezes exactly one selected request', async () => {
  const f = fixture({ exportSettings: settings({ resolution: 'short_360', rateControl: { mode: 'bitrate', targetKbps: 2000 } }) }), h = appHarness(f);
  h.open(); assert.deepEqual(h.panels, [['tasks',false],['image',false],['delivery',true]]); assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  const waiting = h.check(); f.capabilities[0].resolve(capability(f.live.exportSettings)); await Promise.resolve(); f.reads[0].resolve(report(f.live.exportSettings)); await waiting;
  const binding = f.state().binding; await h.render('export', binding); await h.render('export', binding);
  assert.equal(h.ids(), 1); assert.deepEqual(h.calls, [['local-delivery.submit', { ...binding, requestId: 'frozen-render-id', purpose: 'export' }]]);
  assert.equal(h.submitOptions[0].canExecute(), true); assert.equal(h.submitOptions[0].nameCapture, undefined);
  f.set({ exportSettings: settings(), settingsVersion: 2 }); assert.deepEqual(h.calls[0][1].exportSettings, binding.exportSettings);
});

test('actual Check rejects unresolved local candidate and saved-baseline conflict before any preflight work', async () => {
  for (const localState of [{ baselineConflict: true, candidate: null }, { baselineConflict: false, candidate: { raw: { deliveryName: 'Retained draft' } } }]) {
    const f = fixture(), h = appHarness(f, { localState }), before = f.state();
    assert.equal(await h.check(), null);
    assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0); assert.equal(f.state(), before);
    assert.equal(h.submitOptions.length, 0);
  }
});

test('restored export retains exact checked settings on the original session runner', async () => {
  const f = fixture(), h = appHarness(f, { restored: true }); await f.ready(); const binding = f.state().binding;
  await h.render('export', binding);
  assert.deepEqual(h.calls, [['timeline:render:export', 'timeline.render', { ...binding, requestId: 'frozen-render-id', purpose: 'export' }]]);
  assert.equal(h.submitOptions.length, 0); assert.equal(h.ids(), 1);
});

test('actual App pending export cannot be replaced by settings or another confirmation; preview retains omission', async () => {
  const f = fixture(), h = appHarness(f); await f.ready(); h.pending.push({ key: 'timeline:render:export', input: { requestId: 'old' } });
  await h.render('export', f.state().binding); assert.equal(h.calls.length, 0); assert.equal(h.ids(), 0); assert.equal(f.state().attempted, false);
  await h.render('preview'); assert.equal(h.calls.length, 1); assert.equal(Object.hasOwn(h.calls[0][2], 'exportSettings'), false);
  assert.equal(isDurableEditOperation('timeline.render'), false);
});

class Storage { values = new Map(); get length() { return this.values.size; } key(index) { return [...this.values.keys()][index] ?? null; } getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, String(value)); } removeItem(key) { this.values.delete(key); } }
test('session render receipts retain exact bytes and key across new settings, reconciliation and explicit recovery', t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = new Storage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
  const entry = { projectId, key: 'timeline:render:export', operation: 'timeline.render', input: { projectId, expectedRevision: 4, requestId: 'original-id', purpose: 'export', exportSettings: settings({ resolution: 'short_1080' }) } };
  const original = prepareSubmission(entry), before = [...storage.values.entries()];
  prepareSubmission({ ...entry, input: { ...entry.input, requestId: 'replacement-id', exportSettings: settings({ resolution: 'short_360' }) } });
  reconcilePending(projectId, { exports: [{ requestId: 'original-id', snapshot: { delivery: resolveTimelineExportDelivery(timeline, entry.input.exportSettings) } }] });
  assert.deepEqual([...storage.values.entries()], before); assert.deepEqual(readPending(projectId, entry.key), original); assert.deepEqual(prepareRequestReplay(original), original);
  assert.throws(() => prepareRequestReplay({ ...original, input: { ...original.input, exportSettings: settings() } }), { code: 'MUTATION_REPLAY_MISMATCH' });
});

const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree ?? '';
function component(file, extra = {}) {
  const module = { exports: {} }, react = { createElement: element, useRef: current => ({ current }), useEffect() {}, useLayoutEffect() {}, useState: value => [value, () => {}] }; react.default = react;
  const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
  Function('module', 'exports', 'require', 'fetch', transformSync(source, { loader: file.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(module, module.exports, name => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? extra.react || react : name === './creation-i18n.ts' ? creationI18n : name === './export-display.ts' ? exportDisplay : name === './export-settings-state.ts' ? settingsState : name === './export-delivery-state.ts' ? deliveryState : name === './export-range-state.ts' ? rangeState : name === './export-preflight-state.ts' ? preflightState : name === './UiPreferencesProvider.tsx' ? {useUiPreferences:()=>({preferences:{timecodeFormat:'timecode'}})} : name === './api.ts' ? { statusText: String } : extra[name] || { __esModule: true, default: 'Stub', Button: 'Button', WorkbenchButton: 'WorkbenchButton', WorkbenchAlert: 'WorkbenchAlert', Label: 'Label', WorkbenchSelect: 'Select', Badge: 'Badge' }, extra.fetch || globalThis.fetch);
  return module.exports.default;
}

test('actual selectors show separate editing/output dimensions, explicit CRF and bitrate semantics, upscale warning and fixed audio/timebase', () => {
  const View = component('TimelineExportSettings.tsx'), changes = []; const choice = settings({ resolution: 'short_1080' });
  let tree = View({ timeline, value: choice, disabled: false, onChange: value => changes.push(value) });
  const text = textOf(tree); for (const expected of ['720 × 1280','1080 × 1920','CRF 23','30 fps','AAC 128 kb/s','不增加原始画面细节','不更改时间线或编辑预览']) assert.ok(text.includes(expected), expected);
  nodes(tree).find(node => node.props['data-testid'] === 'export-rate-mode').props.onChange({ target: { value: 'bitrate' } });
  assert.deepEqual(changes[0], settings({ resolution: 'short_1080', rateControl: { mode: 'bitrate', targetKbps: 4000 } }));
  tree = View({ timeline, value: changes[0], disabled: true, onChange() {} });
  assert.match(textOf(tree), /单遍编码/); assert.match(textOf(tree), /不保证文件大小/);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'export-bitrate').props.disabled, true);
});

test('actual capability panel labels unknown and unsupported safely and never presents failure as an unchecked export', async () => {
  const View = component('TimelineExportPreflight.tsx');
  for (const capabilityPhase of ['unavailable','incomplete']) {
    const state = { phase: capabilityPhase === 'unavailable' ? 'blocked' : 'incomplete', capabilityPhase, capability: capability(settings(), { status: capabilityPhase, issues: [{ code: 'EXPORT_CAPABILITY_UNSUPPORTED', message: '/private/secret' }] }) };
    const tree = View({ state, exportSettings: settings(), canCheck: true });
    assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export').props.disabled, true);
    assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'preflight-export-unchecked'), false);
    assert.doesNotMatch(textOf(tree), /private|secret/); assert.match(textOf(tree), capabilityPhase === 'unavailable' ? /缺少/ : /尚未确认/);
  }
});

test('history renders the actual frozen settings and output dimensions; old records retain their labels and file URL', () => {
  const View = component('ExportHistoryList.tsx');
  const legacy = { id: id(40), mode: 'timeline', purpose: 'export', timelineRevision: 4, status: 'succeeded', createdAt: '2026-10-11T18:00:00.000Z', url: '/media/original-file', snapshot: { timeline } };
  const custom = { ...legacy, id: id(41), url: '/media/frozen-custom-file', snapshot: { timeline, delivery: resolveTimelineExportDelivery(timeline, settings({ resolution: 'short_1080', rateControl: { mode: 'bitrate', targetKbps: 8000 } })) } };
  assert.equal(settingsState.exportHistoryDelivery(legacy), null);
  const oldTree = View({ orderedExports: [legacy], projectName: '作品', timelineRevision: 4 });
  assert.match(textOf(oldTree), /时间线导出 · 修订版 4 · 当前/); assert.doesNotMatch(textOf(oldTree), /CRF|AAC|1080/);
  const tree = View({ orderedExports: [custom], projectName: '作品', timelineRevision: 4 });
  assert.match(textOf(tree), /1080 × 1920/); assert.match(textOf(tree), /平均目标 8 Mb\/s/); assert.match(textOf(tree), /放大输出，不增加细节/);
  assert.equal(nodes(tree).find(node => node.props.exportId === custom.id && typeof node.props.downloadHref === 'string').props.downloadHref, custom.url);
});

test('successful timeline preview keeps its original download and never probes the export-only recovery endpoint', () => {
  const View = component('ExportHistoryList.tsx');
  const preview = { id: id(42), projectId, mode: 'timeline', purpose: 'preview', timelineRevision: 4, status: 'succeeded', createdAt: '2026-10-11T18:00:00.000Z', url: '/media/original-editing-preview', snapshot: { timeline } };
  const tree = View({ orderedExports: [preview], projectId, projectName: '作品', timelineRevision: 4, fileRecoveryEnabled: true });
  const action = nodes(tree).find(node => node.props.exportId === preview.id && typeof node.props.downloadHref === 'string');
  assert.equal(action.props.disabled, true); assert.equal(action.props.downloadHref, preview.url);
  let reads = 0;
  const react = { createElement: element, useRef: current => ({ current }), useState: value => [value, () => {}], useEffect: run => run(), useLayoutEffect: run => run(), useMemo: run => run() };
  const Actions = component('ExportFileActions.tsx', { react, './workspace-visibility.tsx': {useWorkspaceVisibility: () => true}, fetch: () => { reads++; return Promise.reject(new Error('Preview must not use export recovery')); } });
  const download = Actions(action.props);
  assert.equal(reads, 0); assert.equal(download.props.render.props.href, preview.url); assert.equal(download.props.render.props.download, true);
});


test('actual playback keeps the produced artifact URL and shows its frozen dimensions instead of editor preview dimensions', () => {
  const View = component('Preview.tsx', { './workspace-visibility.tsx': { useWorkspaceVisibility: () => true }, './api.ts': { assetUrl: () => '', statusText: String }, './Timeline.tsx': { assetKind: () => 'video', framesLabel: String }, './source-range-state.ts': { SOURCE_RANGE_FPS: 30 } });
  const delivery = resolveTimelineExportDelivery(timeline, settings({ resolution: 'short_360', rateControl: { mode: 'crf', quality: 'compact' } }));
  const job = { id: id(90), mode: 'timeline', purpose: 'export', timelineRevision: 4, status: 'succeeded', url: '/media/exact-produced-file', snapshot: { timeline, delivery } };
  const tree = View({ kind: 'timeline', timeline: { ...timeline, revision: 5 }, job, playhead: 0 });
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'timeline-preview-video').props.src, job.url);
  const metadata = nodes(tree).find(node => typeof node.props.metadata === 'string').props.metadata;
  assert.match(textOf(tree), new RegExp(i18n.translate('zh-Hans', 'timeline.preview.final'))); assert.match(metadata, /360 × 640/); assert.match(metadata, /CRF 28/); assert.doesNotMatch(metadata, /720 × 1280/);
  const preview = View({ kind: 'timeline', timeline, job: { ...job, purpose: 'preview', snapshot: { timeline } }, playhead: 0 });
  assert.match(textOf(preview), new RegExp(i18n.translate('zh-Hans', 'timeline.preview.editing'))); assert.match(nodes(preview).find(node => typeof node.props.metadata === 'string').props.metadata, /720 × 1280/);
});


test('actual Check control fences the viewed project, saved revision and settings version before capability work', async () => {
  for (const patch of [{ scope: 'new-epoch' }, { projectId: id(99) }, { timelineId: id(98) }, { revision: 5 }, { settingsVersion: 2 }, { rangeVersion: 2 }]) {
    const f = fixture(), h = appHarness(f), viewed = { ...f.live }; f.set(patch, false);
    await h.check(viewed); assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  }
});
