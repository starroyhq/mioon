import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExportRangeController, exportRangeContextFields, rangeFields } from '../apps/web/src/export-range-state.ts';
import { createExportPreflightController } from '../apps/web/src/export-preflight-state.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, resolveTimelineExportDelivery } from '@mioon/contracts';
import { component, nodes, textOf } from './fixtures/export-range-ui-harness.mjs';

const id = n => `db000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), hash = 'a'.repeat(64), stamp = '2026-10-13T00:00:00.000Z';
const range = { startFrame: 30, endFrame: 90 };
const draft = (startText = '30', endText = '90') => ({ mode: 'selected', startText, endText });
const context = patch => ({ scope: 'project:1', projectId, timelineId, revision: 4, durationFrames: 120, enabled: true, ...patch });
const summary = exportRange => ({ width: 720, height: 1280, fps: 30, durationFrames: 120, trackCount: 1, clipCount: 1, assetCount: 1, visualClipCount: 1, audibleClipCount: 0, mutedTrackCount: 0, hiddenVideoTrackCount: 0, ...(exportRange === undefined ? {} : { exportRange }) });
const report = (exportRange, patch = {}) => ({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, snapshotHash: hash, checkedAt: stamp, status: 'ready', summary: summary(exportRange), checks: { totalAssets: 1, checkedAssets: 1, bytesHashed: 1, fullDecode: false }, issues: [], ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function rangeFixture() {
  let live = context(); const controller = createExportRangeController({ getContext: () => live }); controller.setContext(live);
  return { controller, set(patch, sync = true) { live = { ...live, ...patch }; if (sync) controller.setContext(live); }, choose(value) { return controller.chooseRange(value, live.scope, controller.getVersion(live.scope)); } };
}
function preflightFixture(patch = {}) {
  let live = { ...context(), connected: true, exportRange: range, rangeVersion: 1, ...patch }; const reads = [], calls = [], capabilities = [], auth = [];
  const controller = createExportPreflightController({ getContext: () => live,
    read(input, options) { const pending = deferred(); calls.push({ operation: 'preflight', input, options }); reads.push(pending); return pending.promise; },
    readCapabilities(input, options) { const pending = deferred(); calls.push({ operation: 'capability', input, options }); capabilities.push(pending); return pending.promise; }, onUnauthorized: () => auth.push(true) });
  controller.setContext(live); controller.setVisible(true);
  return { controller, reads, calls, capabilities, auth, set(patch, sync = true) { live = { ...live, ...patch }; if (sync) controller.setContext(live); }, async ready(value = report(live.exportRange)) { const promise = controller.check(); reads.at(-1).resolve(value); await promise; return controller.getState(); } };
}

test('whole selection omits range, while explicit full span and one frame remain distinct frozen selections', () => {
  const f = rangeFixture(); assert.equal(f.controller.getRange('project:1'), undefined); assert.deepEqual(rangeFields({}), {});
  assert.equal(Object.hasOwn(rangeFields({ exportRange: undefined }), 'exportRange'), false);
  for (const [start, end] of [['0', '120'], ['0', '1'], ['119', '120']]) {
    assert.equal(f.choose(draft(start, end)), true); const value = f.controller.getRange('project:1');
    assert.deepEqual(value, { startFrame: Number(start), endFrame: Number(end) }); assert.ok(Object.isFrozen(value));
    const projected = rangeFields({ exportRange: value }); assert.equal(Object.hasOwn(projected, 'exportRange'), true); assert.ok(Object.isFrozen(projected.exportRange));
  }
  f.choose({ ...draft(), mode: 'whole' }); assert.equal(f.controller.getRange('project:1'), undefined);
});

test('invalid raw selected fields survive unchanged and never become omitted whole timeline', () => {
  const f = rangeFixture();
  for (const [start, end] of [['', '90'], ['0', ''], ['1.5', '90'], ['-1', '90'], ['30', '30'], ['31', '30'], ['0', '121'], ['0', '18001'], ['1e1', '90'], [' ', '90'], ['0', '9007199254740992']]) {
    const raw = draft(start, end); assert.equal(f.choose(raw), true); assert.deepEqual(f.controller.getState().draft, raw);
    assert.equal(f.controller.getRange('project:1'), null); assert.ok(f.controller.getState().error);
    assert.equal(exportRangeContextFields({ exportRange: f.controller.getRange('project:1') }).exportRangeKey, null);
    assert.throws(() => rangeFields({ exportRange: null }));
  }
});

test('session selection retains through visibility and reconnect, resets on project epoch and fences stale callbacks', () => {
  const f = rangeFixture(); f.choose(draft()); const first = f.controller.getState();
  f.set({ enabled: false }); assert.equal(f.choose(draft('0', '1')), false); assert.deepEqual(f.controller.getRange('project:1'), range);
  f.set({ enabled: true }); assert.deepEqual(f.controller.getRange('project:1'), range);
  f.choose(draft('0', '1')); f.choose(draft()); assert.equal(f.controller.chooseRange(draft('0', '1'), first.scope, first.version), false);
  f.set({ scope: 'project:2' }, false); assert.equal(f.controller.chooseRange(draft(), first.scope, f.controller.getVersion(first.scope)), false);
  assert.equal(f.controller.getRange('project:2'), undefined);
});

test('saved duration changes revalidate without clamping even before the next effect, while old revision controls are fenced', () => {
  const f = rangeFixture(); f.choose(draft()); const viewed = f.controller.getState();
  f.set({ revision: 5, durationFrames: 60 }, false); assert.equal(f.controller.getRange('project:1'), null);
  assert.equal(f.controller.chooseRange(draft('0', '30'), viewed.scope, viewed.version), false);
  assert.deepEqual(f.controller.getState().draft, draft()); assert.ok(f.controller.getState().error);
  f.set({ revision: 6, durationFrames: 120 }); assert.deepEqual(f.controller.getRange('project:1'), range);
});

test('explicit media check freezes exact range and consumes each checked binding once', async () => {
  const f = preflightFixture(), state = await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, expectedRevision: 4, exportRange: range });
  assert.deepEqual(state.binding, { projectId, expectedRevision: 4, preflightSnapshotHash: hash, exportRange: range });
  assert.ok(Object.isFrozen(state.binding.exportRange)); const binding = state.binding;
  assert.equal(f.controller.takeExportBinding(binding), binding); assert.equal(f.controller.takeExportBinding(binding), null);
  const legacy = preflightFixture({ exportRange: undefined }); const old = await legacy.ready(report(undefined));
  assert.deepEqual(legacy.calls[0].input, { projectId, expectedRevision: 4 }); assert.equal(Object.hasOwn(old.binding, 'exportRange'), false);
});

test('invalid selection blocks checks and range mismatches never produce a ready binding', async () => {
  const invalid = preflightFixture({ exportRange: null }); assert.equal(await invalid.controller.check(), null); assert.equal(invalid.calls.length, 0);
  for (const value of [report(undefined), report({ startFrame: 0, endFrame: 90 }), report(null), report({ startFrame: 30, endFrame: 121 })]) {
    const f = preflightFixture(); await f.ready(value); assert.equal(f.controller.getState().binding, null); assert.equal(f.controller.getState().phase, 'error');
  }
});

test('range edits fence late media results, obsolete auth and A to B to A old confirmations', async () => {
  const f = preflightFixture(), original = (await f.ready()).binding;
  f.set({ exportRange: { startFrame: 0, endFrame: 60 }, rangeVersion: 2 }); f.set({ exportRange: range, rangeVersion: 3 });
  assert.equal(f.controller.takeExportBinding(original), null);
  for (const fail of [false, true]) {
    const g = preflightFixture(), waiting = g.controller.check(); g.set({ rangeVersion: 2 }, false);
    if (fail) g.reads[0].reject(Object.assign(Error('private'), { code: 'UNAUTHORIZED' })); else g.reads[0].resolve(report(range));
    await waiting; assert.equal(g.controller.getState().binding, null); assert.equal(g.auth.length, 0);
  }
});

test('capability requests stay range-free but range changes stop the late capability from launching media work', async () => {
  const settings = structuredClone(TIMELINE_EXPORT_DEFAULT_SETTINGS), f = preflightFixture({ exportSettings: settings, settingsVersion: 1 });
  const waiting = f.controller.check(); assert.equal(f.calls[0].operation, 'capability'); assert.equal(Object.hasOwn(f.calls[0].input, 'exportRange'), false);
  f.set({ rangeVersion: 2 }, false);
  f.capabilities[0].resolve({ projectId, timelineId, expectedRevision: 4, timelineRevision: 4, checkedAt: stamp, status: 'available', exportSettings: settings, delivery: resolveTimelineExportDelivery({ width: 720, height: 1280, fps: 30 }, settings), issues: [] });
  await waiting; assert.equal(f.reads.length, 0); assert.equal(f.controller.getState().binding, null);
});

test('incomplete unchecked intent preserves exact range and opening or hiding never submits', async () => {
  const f = preflightFixture(); f.controller.setVisible(false); f.controller.setVisible(true); assert.equal(f.calls.length, 0);
  const state = await f.ready(report(range, { status: 'incomplete', snapshotHash: null, summary: null, timelineId: null, timelineRevision: null, checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false }, issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'Incomplete' }] }));
  assert.deepEqual(state.uncheckedIntent, { projectId, expectedRevision: 4, exportRange: range });
  assert.equal(f.controller.takeUncheckedExportIntent(state.uncheckedIntent), state.uncheckedIntent);
});

test('range controls use labelled shared inputs, half-open semantics, session disclosure and disabled actions', () => {
  const View = component('ExportRangeControls.tsx').default, changes = [];
  let tree = View({ draft: { mode: 'whole', startText: '', endText: '' }, durationFrames: 120, onChange: value => changes.push(value) });
  nodes(tree).find(node => node.props['data-testid'] === 'export-range-selected').props.onClick(); assert.deepEqual(changes, [draft('0', '120')]);
  tree = View({ draft: draft(), value: range, durationFrames: 120, disabled: true });
  assert.match(textOf(tree), /30 fps|60 帧/); assert.match(textOf(tree), /重启或重新打开项目后请重新选择/); assert.match(textOf(tree), /结束帧（不包含）/);
  for (const key of ['export-range-whole', 'export-range-selected', 'export-range-start', 'export-range-end']) assert.equal(nodes(tree).find(node => node.props['data-testid'] === key).props.disabled, true);
  const broken = View({ draft: draft('', '90'), value: null, error: 'Invalid range' }); assert.equal(nodes(broken).find(node => node.props['data-testid'] === 'export-range-start').props['aria-invalid'], true);
  assert.ok(nodes(broken).some(node => node.props.role === 'alert'));
});

test('preflight shows frozen selected duration separately from full composition and checks all source scope', () => {
  const View = component('TimelineExportPreflight.jsx').default;
  const tree = View({ state: { phase: 'ready', report: report(range), binding: {} }, exportRange: { startFrame: 0, endFrame: 1 }, rangeDraft: draft('0', '1'), canCheck: true });
  const frozen = nodes(tree).find(node => node.props['data-testid'] === 'preflight-export-range'); assert.match(textOf(frozen), /第 30 帧.*第 90 帧.*60 帧.*2.00 秒/);
  assert.match(textOf(tree), /完整时间线时长.*120 帧/); assert.match(textOf(tree), /范围外素材/);
  const invalid = View({ rangeError: 'Invalid range', canCheck: true }); assert.equal(nodes(invalid).find(node => node.props['data-testid'] === 'preflight-check').props.disabled, true);
});

test('named and unnamed export history display immutable range while absent and preview rows remain unchanged', () => {
  const View = component('ExportHistoryList.jsx').default;
  const timeline = { width: 720, height: 1280, fps: 30, durationFrames: 120 };
  const base = { id: id(10), mode: 'timeline', purpose: 'export', timelineRevision: 4, createdAt: stamp, status: 'succeeded', assetId: id(11), snapshot: { timeline, exportRange: range } };
  for (const named of [false, true]) {
    const item = { ...base, snapshot: { ...base.snapshot, ...(named ? { deliveryName: 'Frozen title' } : {}) } };
    const tree = View({ orderedExports: [item], projectName: 'Current name', timelineRevision: 99 });
    assert.match(textOf(nodes(tree).find(node => node.props['data-testid'] === 'export-history-range')), /第 30 帧.*第 90 帧.*60 帧/);
  }
  for (const item of [{ ...base, snapshot: { timeline } }, { ...base, purpose: 'preview' }]) {
    const tree = View({ orderedExports: [item], projectName: 'Current name', timelineRevision: 99 });
    assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'export-history-range'), false);
  }
});

const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function actualAppFunction(start, end, env) {
  const first = appSource.indexOf(start), last = appSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return Function(...Object.keys(env), `return (${appSource.slice(first, last).trim()});`)(...Object.values(env));
}

test('actual App range context rejects hidden dialog, offline, busy and pending callbacks but preserves independent and restored export', () => {
  let base = { scope: 'project:1', enabled: true }, local = { scope: 'project:1', busy: false, pending: false };
  const env = { exportSettingsContext: () => base, localDeliveryRef: { current: { controller: { getState: () => local } } },
    projectSessionReady: () => true,
    rightDockTab: 'properties', showDelivery: true, showExports: false, panelVisible: () => false,
    dataRef: { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4, durationFrames: 120 } } }, currentProject: { current: projectId } };
  const getContext = () => actualAppFunction('  function exportRangeContext(', '  const exportRange = useExportRange(', env)();
  const controller = createExportRangeController({ getContext }); controller.setContext(getContext());
  const choose = value => controller.chooseRange(value, 'project:1', controller.getVersion('project:1'));
  assert.equal(choose(draft()), true);
  assert.equal(getContext().enabled, true, 'The export dialog is independent of the collapsed inspector and its selected tab');
  for (const block of ['hidden dialog', 'history page', 'offline', 'busy', 'pending']) {
    env.showDelivery = block !== 'hidden dialog'; env.showExports = block === 'history page';
    base = { ...base, enabled: block !== 'offline' }; local = { ...local, busy: block === 'busy', pending: block === 'pending' };
    assert.equal(getContext().enabled, false, block); assert.equal(choose(draft('0', '1')), false, block); assert.deepEqual(controller.getRange('project:1'), range);
  }
  env.showDelivery = true; env.showExports = false; base = { ...base, enabled: true };
  local = { scope: 'other-project:1', busy: true, pending: true }; assert.equal(getContext().enabled, true, 'another project coordinator cannot block this scope');
  local = { scope: 'project:1', busy: false, pending: false, phase: 'unsupported' }; assert.equal(getContext().enabled, true, 'restored unsupported sidecar does not disable explicit export');
  assert.equal(choose(draft('0', '1')), true);
  env.projectSessionReady = () => false; base = { ...base, enabled: false };
  assert.equal(getContext().projectId, null, 'Unaccepted project data cannot identify an export range');
  assert.equal(choose(draft('0', '2')), false);
});

test('actual local-delivery execution epoch includes range version even after changing back to the original endpoints', () => {
  const f = rangeFixture(); f.choose(draft());
  const env = { currentProject: { current: projectId }, projectEpoch: { current: 1 }, dataRef: { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4 } } }, workspaceRef: { current: { restored: false } },
    projectSessionReady: () => true, workbenchReady: true,
    online: true, auth: true, loading: false, showDelivery: true, showExports: false, isBusy: () => false,
    navigationEpoch: { current: 1 }, panelIntent: { current: 1 }, exportSettings: { controller: { getVersion: () => 1 } }, exportRange: { controller: { getVersion: () => f.controller.getVersion('project:1') } },
    deliveryName: { controller: { getName: () => '', getVersion: () => 1, hasUnsaved: () => false } } };
  const getContext = () => actualAppFunction('  function localDeliveryContext(', '  const localDelivery = useLocalDelivery(', env)();
  const before = getContext(); f.choose(draft('0', '1')); f.choose(draft()); const after = getContext();
  assert.deepEqual(f.controller.getRange('project:1'), range); assert.notEqual(after.executionEpoch, before.executionEpoch);
  assert.deepEqual({ ...after, executionEpoch: before.executionEpoch }, before);
  env.showDelivery = false; assert.equal(getContext().visible, false);
  env.showDelivery = true; env.showExports = true; assert.equal(getContext().visible, false);
  env.showExports = false; assert.equal(getContext().visible, true);
  env.projectSessionReady = () => false; env.workbenchReady = false;
  const unopened = getContext(); assert.equal(unopened.projectId, null); assert.equal(unopened.connected, false); assert.equal(unopened.visible, false);
});


test('only malformed range-present rows suppress file actions; valid selected and absent history retain exact inspection inputs', () => {
  const View = component('ExportHistoryList.jsx').default;
  const timeline = { width: 720, height: 1280, fps: 30, durationFrames: 120 };
  const base = { id: id(10), projectId, mode: 'timeline', purpose: 'export', timelineRevision: 4, createdAt: stamp, status: 'succeeded', url: '/media/original-file', assetId: id(11), snapshot: { timeline, exportRange: range } };
  const actions = tree => nodes(tree).filter(node => node.type === 'ExportFileActions');
  for (const named of [false, true]) {
    const name = named ? { deliveryName: 'Frozen title' } : {};
    for (const snapshot of [{ timeline, exportRange: range, ...name }, { timeline, ...name }]) {
      const tree = View({ orderedExports: [{ ...base, snapshot }], projectName: 'Current name', timelineRevision: 99 });
      assert.equal(actions(tree).length, 1);
      assert.deepEqual(actions(tree)[0].props, {projectId, exportId:id(10), downloadHref:named ? `/media/${id(11)}?download=1&exportId=${id(10)}` : base.url, disabled:false, children:[]});
      assert.equal(nodes(tree).some(node => node.props['data-testid'] === 'download-export'), false, 'Composition cannot claim an asynchronous file check has succeeded');
    }
    for (const patch of [
      { snapshot: { timeline, exportRange: null, ...name } }, { snapshot: { timeline, exportRange: undefined, ...name } },
      { snapshot: { timeline, exportRange: { startFrame: 30, endFrame: 121 }, ...name } },
      { snapshot: { timeline: { ...timeline, fps: 24 }, exportRange: range, ...name } },
      { purpose: 'preview', snapshot: { timeline, exportRange: range, ...name } },
      { mode: 'storyboard', snapshot: { timeline, exportRange: range, ...name } },
    ]) {
      const tree = View({ orderedExports: [{ ...base, ...patch }], projectName: 'Current name', timelineRevision: 99 });
      assert.equal(actions(tree).length, 0); assert.match(textOf(tree), /暂时不能下载/);
    }
  }
});


test('hidden checked and unchecked confirmations preserve their intent without consuming it and require an explicit reopened action', async () => {
  for (const unchecked of [false, true]) {
    const f = preflightFixture();
    const incomplete = report(range, { status: 'incomplete', snapshotHash: null, summary: null, timelineId: null, timelineRevision: null,
      checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false }, issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'Incomplete' }] });
    const state = await f.ready(unchecked ? incomplete : report(range));
    const intent = unchecked ? state.uncheckedIntent : state.binding;
    const take = () => unchecked ? f.controller.takeUncheckedExportIntent(intent) : f.controller.takeExportBinding(intent);
    f.controller.setVisible(false); const before = f.controller.getState();
    assert.equal(take(), null); assert.equal(f.controller.getState(), before); assert.equal(before.attempted, false);
    assert.equal(unchecked ? before.uncheckedIntent : before.binding, intent);
    f.controller.setVisible(true); assert.equal(f.controller.getState(), before); assert.equal(f.calls.length, 1);
    assert.equal(take(), intent); assert.equal(take(), null); assert.equal(f.controller.getState().attempted, true);
  }
});
