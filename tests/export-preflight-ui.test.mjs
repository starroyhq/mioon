import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createExportPreflightController, preflightErrorMessage, preflightIssueMessage } from '../apps/web/src/export-preflight-state.js';
import { rpc } from '../apps/web/src/api.js';

const id = n => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), hash = 'a'.repeat(64);
const context = patch => ({ scope: `${projectId}:1`, projectId, timelineId, revision: 4, connected: true, ...patch });
const report = patch => ({ projectId, timelineId, timelineRevision: 4, expectedRevision: 4, snapshotHash: hash,
  checkedAt: '2026-10-10T04:00:00.000Z', status: 'ready', summary: { fps: 30, width: 720, height: 1280, durationFrames: 90, trackCount: 2, clipCount: 2, assetCount: 2, visualClipCount: 1, audibleClipCount: 1, mutedTrackCount: 0, hiddenVideoTrackCount: 0 },
  checks: { totalAssets: 2, checkedAssets: 2, bytesHashed: 256, fullDecode: false }, issues: [], ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const calls = [], reads = [], changes = [], auth = [];
  const controller = createExportPreflightController({ read: (input, options) => { calls.push({ input, options }); const read = deferred(); reads.push(read); return read.promise; }, onChange: state => changes.push(state), onUnauthorized: () => auth.push(false) });
  controller.setContext(context());
  return { controller, calls, reads, changes, auth, state: () => controller.getState(), async ready(value = report()) { const waiting = controller.check(); reads.at(-1).resolve(value); await waiting; return controller.getState(); } };
}

test('mount, context, visibility and reconnect never check automatically; recreation holds no report', async () => {
  const f = fixture(); f.controller.setVisible(true); f.controller.setVisible(false);
  f.controller.setContext(context({ connected: false })); f.controller.setContext(context());
  assert.equal(f.calls.length, 0); assert.equal(f.state().report, null);
  await f.ready(); assert.equal(f.calls.length, 1);
  f.controller.dispose(); assert.equal(f.state().report, null);
  const next = fixture(); assert.equal(next.state().report, null); assert.equal(next.calls.length, 0);
});

test('explicit check reads only saved project/revision; report is not an export or application acknowledgement', async () => {
  const f = fixture(), draft = { shot: 'unsaved prompt', clip: { startFrame: 99 }, source: { inFrame: 22 } };
  const before = structuredClone(draft), state = await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, expectedRevision: 4 });
  assert.ok(f.calls[0].options.signal instanceof AbortSignal); assert.equal(f.calls.length, 1);
  assert.equal(state.phase, 'ready'); assert.equal(state.attempted, false); assert.deepEqual(draft, before);
  assert.deepEqual(state.binding, { projectId, expectedRevision: 4, preflightSnapshotHash: hash });
  assert.equal('applied' in state, false); assert.equal('requestId' in f.calls[0].input, false);
});

test('newer check invalidates old report immediately and fences late success, error and old confirmation', async () => {
  const f = fixture(), old = (await f.ready()).binding;
  const first = f.controller.check(), firstRead = f.reads.at(-1), firstSignal = f.calls.at(-1).options.signal;
  assert.equal(f.state().binding, null); assert.equal(f.state().phase, 'checking');
  const second = f.controller.check(), secondRead = f.reads.at(-1);
  assert.equal(firstSignal.aborted, true); secondRead.resolve(report({ snapshotHash: 'b'.repeat(64) })); await second;
  firstRead.reject(Object.assign(Error('/private/late-auth'), { code: 'UNAUTHORIZED' })); await first;
  assert.equal(f.state().binding.preflightSnapshotHash, 'b'.repeat(64)); assert.equal(f.auth.length, 0);
  assert.equal(f.controller.takeExportBinding(old), null);
  const third = f.controller.check(), thirdRead = f.reads.at(-1);
  const fourth = f.controller.check(), fourthRead = f.reads.at(-1);
  fourthRead.resolve(report()); await fourth; thirdRead.resolve(report({ snapshotHash: 'c'.repeat(64) })); await third;
  assert.equal(f.state().binding.preflightSnapshotHash, hash);
});

for (const patch of [{ revision: 5 }, { timelineId: id(3) }, { projectId: id(4), scope: 'other:1' }, { scope: `${projectId}:2` }, { connected: false }]) {
  test(`context fence aborts pending response for ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await f.ready(); const waiting = f.controller.check(), latest = f.reads.at(-1);
    f.controller.setContext(context(patch)); assert.equal(f.calls.at(-1).options.signal.aborted, true);
    const before = f.state(); latest.resolve(report()); await waiting;
    assert.equal(f.state(), before); assert.equal(f.state().binding, null);
    if (patch.projectId || patch.scope) assert.equal(f.state().report, null);
    else assert.equal(f.state().phase, 'stale');
  });
}

test('a saved timeline draft invalidates the report; disconnect/reconnect cannot revive it', async () => {
  const f = fixture(), first = (await f.ready()).binding;
  f.controller.setContext(context({ revision: 5 })); assert.equal(f.state().phase, 'stale');
  assert.equal(f.controller.takeExportBinding(first), null); assert.equal(f.calls.length, 1);
  f.controller.setContext(context({ revision: 5, connected: false })); f.controller.setContext(context({ revision: 5 }));
  assert.equal(f.state().phase, 'stale'); assert.equal(f.state().binding, null); assert.equal(f.calls.length, 1);
});

test('same-revision newer check rejects previous binding identity and allows each report exactly once', async () => {
  const f = fixture(), before = (await f.ready()).binding, after = (await f.ready()).binding;
  assert.deepEqual(before, after); assert.notEqual(before, after);
  assert.equal(f.controller.takeExportBinding(before), null);
  assert.equal(f.controller.takeExportBinding({ ...after }), null);
  assert.equal(f.controller.takeExportBinding(after), after); assert.equal(f.state().attempted, true);
  assert.equal(f.controller.takeExportBinding(after), null); assert.equal(f.calls.length, 2);
});

for (const [label, value] of [
  ['wrong project', report({ projectId: id(9) })], ['wrong expected revision', report({ expectedRevision: 5 })],
  ['wrong actual revision', report({ timelineRevision: 5 })], ['wrong timeline', report({ timelineId: id(9) })],
  ['malformed hash', report({ snapshotHash: 'bad' })], ['missing summary', report({ summary: null })],
  ['unknown field', { ...report(), path: '/private/source.mp4' }], ['full decode claim', report({ checks: { ...report().checks, fullDecode: true } })],
  ['ready with error', report({ issues: [{ code: 'MISSING_ASSET', severity: 'error', message: '素材不可用' }] })],
  ['ready missing checks', report({ checks: { ...report().checks, checkedAssets: 1 } })],
]) test(`malformed or misbound ${label} fails closed`, async () => {
  const f = fixture(); await f.ready(value); assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null);
  assert.match(f.state().error, /不完整或与当前快照不匹配/);
});

test('incomplete report is distinct, permits only bound warning-only explicit attempts; blocked/stale never bind', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete', checks: { ...report().checks, checkedAssets: 1 }, issues: [{ code: 'CHECK_BUDGET_EXCEEDED', severity: 'warning', message: '检查达到限额' }] }));
  assert.equal(f.state().phase, 'incomplete'); assert.ok(f.state().binding);
  for (const value of [report({ status: 'blocked' }), report({ status: 'stale' }), report({ status: 'incomplete', snapshotHash: null }), report({ status: 'incomplete', issues: [{ code: 'ASSET_MISSING', severity: 'error', message: '素材缺失' }] })]) {
    await f.ready(value); assert.equal(f.state().binding, null);
  }
});

test('hidden observer aborts late reads but completed report survives tab/mode visibility; no automatic export', async () => {
  const f = fixture(); f.controller.setVisible(true); await f.ready(); const binding = f.state().binding;
  f.controller.setVisible(false); f.controller.setVisible(true); assert.equal(f.state().binding, binding); assert.equal(f.calls.length, 1);
  const waiting = f.controller.check(), read = f.reads.at(-1); f.controller.setVisible(false);
  assert.equal(f.calls.at(-1).options.signal.aborted, true); read.resolve(report()); await waiting;
  assert.equal(f.state().binding, null); assert.equal(f.state().phase, 'stale'); f.controller.setVisible(true);
  assert.equal(f.calls.length, 2); assert.equal(f.state().attempted, false);
});

test('current auth and RPC errors are readable, path-free, fail closed; obsolete auth never logs out new project', async () => {
  const f = fixture(); let waiting = f.controller.check(); f.reads.at(-1).reject(Object.assign(Error('/private/password=bad'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.match(f.state().error, /会话已过期/); assert.equal(f.auth.length, 1);
  waiting = f.controller.check(); f.controller.setContext(context({ projectId: id(8), scope: 'new:1' })); f.reads.at(-1).reject(Object.assign(Error('Old auth'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.auth.length, 1); assert.equal(f.state().error, '');
  for (const error of [Error('/private/secret.mp4'), { message: 'ffprobe C:\\secret\\video.mp4' }, { code: 'BACKEND_PROTOCOL_ERROR' }, { code: 'REVISION_CONFLICT' }]) assert.doesNotMatch(preflightErrorMessage(error), /private|secret|ffprobe|C:/);
  for (const message of ['/private/source.mp4', 'C:\\Users\\file.mp4', 'https://private.example/video', 'token=secret']) assert.doesNotMatch(preflightIssueMessage({ severity: 'error', message }), /private|Users|secret|token/);
});

const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
function appFunction(begin, end, scope) {
  const start = appSource.indexOf(begin), stop = appSource.indexOf(end, start); assert.ok(start >= 0 && stop > start);
  return Function(...Object.keys(scope), `return (${appSource.slice(start, stop).trim()});`)(...Object.values(scope));
}
function appHarness(f, { restored = false, localState = { baselineConflict: false, candidate: null } } = {}) {
  const calls = [], notices = [], views = [], panels = [], pending = [], jobs = [], exports = [], submitOptions = [];
  const owner = context(), currentProject = { current: projectId }, dataRef = { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4, clips: [{ id: id(20) }] } } };
  const env = { panelIntent: { current: 0 }, openExportHistory: () => exports.push(true), workspaceRef: { current: { restored } }, deliveryNameRef: { current: null }, dataRef, currentProject, exportPreflight: { controller: f.controller }, exportCheckContext: () => ({ ...owner, projectId: currentProject.current, timelineId: dataRef.current.timeline.id, revision: dataRef.current.timeline.revision }),
    isBusy: () => false, pendingForProject: () => pending, notify: (...args) => notices.push(args), openTasks: (canReveal = () => true) => { if (canReveal()) jobs.push(true); }, setShowExports: value => exports.push(value),
    context: () => ({ projectId: currentProject.current, scope: owner.scope }), isCurrent: captured => captured.projectId === currentProject.current && captured.scope === owner.scope,
    localDeliveryRef: { current: { controller: { getState: () => localState, canPrepare: () => true, submit: async (input, options) => { calls.push(['local-delivery.submit', input]); submitOptions.push(options); return { id: id(30), status: 'queued' }; } } } },
    run: async (...args) => { calls.push(args); return { id: id(30), status: 'queued' }; }, requestId: () => 'stable-test-request',
    updateView: (...args) => views.push(args), setPreviewKind: value => views.push(['previewKind', value]),
    setRightDockTab: value => panels.push(['tab', value]), setPanelOpen: (...args) => panels.push(args),
  };
  const render = appFunction('  async function renderTimeline(', '  async function previewSource(', env);
  const check = appFunction('  function checkTimelineExport(', '  function openTimelineExport(', env);
  const open = appFunction('  function openTimelineExport(', '  const historyState', { ...env, checkTimelineExport: check });
  const renderUnchecked = appFunction('  function renderUncheckedTimeline(', '  async function renderTimeline(', { renderTimeline: render });
  return { calls, notices, views, panels, pending, jobs, exports, submitOptions, env, render, renderUnchecked, check, open };
}

test('actual topbar action opens the delivery dock without probing; explicit check reads once without rendering or changing drafts', async () => {
  const f = fixture(), h = appHarness(f); h.open();
  assert.deepEqual(h.panels, [['tab', 'delivery'], ['inspector', true]]); assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  const waiting = h.check(); assert.equal(f.calls.length, 1);
  f.reads.at(-1).resolve(report()); await waiting; assert.equal(h.calls.length, 0); assert.equal(h.views.length, 0);
});

test('actual export path pins exact checked tuple and request once; preview path retains original input', async () => {
  const f = fixture(), binding = (await f.ready()).binding, h = appHarness(f);
  await h.render('export', binding); await h.render('export', binding);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], ['local-delivery.submit', { projectId, expectedRevision: 4, preflightSnapshotHash: hash, requestId: 'stable-test-request', purpose: 'export' }]);
  assert.equal(h.submitOptions[0].canExecute(), true); assert.equal(h.submitOptions[0].nameCapture, undefined);
  assert.deepEqual(h.exports, [true]); assert.equal(h.views.length, 0);
  await h.render('preview'); assert.deepEqual(h.calls[1], ['timeline:render:preview', 'timeline.render', { projectId, expectedRevision: 4, requestId: 'stable-test-request', purpose: 'preview' }]);
  assert.deepEqual(h.views, [['activeMode', 'editing'], ['previewKind', 'timeline']]);
});

test('actual Check rejects unresolved local candidate and saved-baseline conflict before any preflight work', async () => {
  for (const localState of [{ baselineConflict: true, candidate: null }, { baselineConflict: false, candidate: { raw: { deliveryName: 'Retained draft' } } }]) {
    const f = fixture(), h = appHarness(f, { localState }), before = f.state();
    assert.equal(await h.check(), null);
    assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0); assert.equal(f.state(), before);
    assert.equal(h.submitOptions.length, 0);
  }
});

test('restored export retains the original preflight-bound session runner', async () => {
  const f = fixture(), binding = (await f.ready()).binding, h = appHarness(f, { restored: true });
  await h.render('export', binding);
  assert.deepEqual(h.calls, [['timeline:render:export', 'timeline.render', { projectId, expectedRevision: 4, preflightSnapshotHash: hash, requestId: 'stable-test-request', purpose: 'export' }]]);
  assert.equal(h.submitOptions.length, 0); assert.deepEqual(h.exports, [true]);
});

test('actual export never auto-replays an unknown receipt or replaces an old binding with current revision', async () => {
  const f = fixture(), h = appHarness(f); let binding = (await f.ready()).binding;
  h.pending.push({ key: 'timeline:render:export', operation: 'timeline.render', input: { requestId: 'original-receipt' } });
  await h.render('export', binding); assert.equal(h.calls.length, 0); assert.deepEqual(h.jobs, [true]);
  assert.equal(f.state().attempted, false); h.pending.length = 0;
  h.env.dataRef.current.timeline.revision = 5; await h.render('export', binding);
  assert.equal(h.calls.length, 0); assert.equal(f.state().phase, 'stale');
  f.controller.setContext(context()); binding = (await f.ready()).binding; h.env.currentProject.current = id(99);
  await h.render('export', binding); assert.equal(h.calls.length, 0);
});

const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree ?? '';
const panelSource = readFileSync(new URL('../apps/web/src/TimelineExportPreflight.jsx', import.meta.url), 'utf8');
function renderPanel(props) {
  const module = { exports: {} }, react = { createElement: element }; react.default = react;
  Function('module', 'exports', 'require', transformSync(panelSource, { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, name => name === 'react' ? react : name.endsWith('export-preflight-state.js') ? { preflightIssueMessage } : name.endsWith('icons.jsx') ? { __esModule: true, default: 'Icon' } : { Button: 'Button' });
  return module.exports.default({ canCheck: true, onCheck() {}, onExport() {}, ...props });
}

test('accessible topbar export action opens recovery even when a candidate, baseline conflict or invalid name blocks Check', () => {
  const first = appSource.indexOf('  const canOpenExport ='), last = appSource.indexOf('  const pendingTimelineExport =', first);
  assert.ok(first >= 0 && last > first, 'Opening and checking must have explicit independent gates');
  const buttonSource = appSource.match(/<Button\b[^>]*data-testid="export-timeline"[^>]*>[\s\S]*?<\/Button>/)?.[0];
  assert.ok(buttonSource); assert.match(buttonSource, /disabled=\{!canOpenExport\}/); assert.match(buttonSource, /onClick=\{openTimelineExport\}/);
  const gate = patch => {
    const env = { data: { project: { id: projectId } }, timeline: { id: timelineId, revision: 4 }, loading: false,
      online: true, auth: true, deliveryName: { error: '' }, restored: false, localDelivery: { state: { candidate: null, baselineConflict: false } }, ...patch };
    return Function(...Object.keys(env), `${appSource.slice(first, last)};return { canOpenExport, canCheckExport };`)(...Object.values(env));
  };
  for (const patch of [{ localDelivery: { state: { candidate: { raw: { deliveryName: 'Saved draft' } }, baselineConflict: false } } },
    { localDelivery: { state: { candidate: null, baselineConflict: true } } }, { deliveryName: { error: 'Invalid name' } }, { online: false }]) {
    const flags = gate(patch); assert.deepEqual(flags, { canOpenExport: true, canCheckExport: false });
    const f = fixture(), h = appHarness(f), module = { exports: {} };
    Function('module', 'React', 'Button', 'Icon', 'canOpenExport', 'openTimelineExport', transformSync(`module.exports = (${buttonSource});`, { loader: 'jsx', format: 'cjs' }).code)(module, { createElement: element }, 'Button', 'Icon', flags.canOpenExport, h.open);
    const button = module.exports; assert.equal(button.type, 'Button'); assert.equal(button.props.disabled, false); assert.equal(textOf(button), '导出时间线');
    button.props.onClick(); assert.deepEqual(h.panels, [['tab', 'delivery'], ['inspector', true]]); assert.deepEqual(h.exports, [false]);
    assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  }
  for (const patch of [{ data: { project: null } }, { timeline: null }, { loading: true }]) assert.equal(gate(patch).canOpenExport, false);
});

test('blocked Check retains accessible recovery controls and pending copy points to the original request entry', () => {
  const recoverySource = readFileSync(new URL('../apps/web/src/DeliveryDraftRecovery.tsx', import.meta.url), 'utf8');
  const module = { exports: {} }, disclosure = { exports: {} };
  const react = { createElement: (type, props, ...children) => type === disclosure.exports.default ? type({ ...props, children }) : element(type, props, ...children) }; react.default = react;
  Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/RecoveryStorageDetails.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(disclosure, disclosure.exports, name => {
    assert.equal(name, 'react'); return react;
  });
  Function('module', 'exports', 'require', transformSync(recoverySource, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name === './RecoveryStorageDetails.tsx') return disclosure.exports;
    assert.equal(name, '@mioon/ui/components/button'); return { Button: 'Button' };
  });
  const events = [], recovery = module.exports.default({ state: { phase: 'ready', busy: false,
    candidate: { timelineId, baseRevision: 4, raw: { deliveryName: 'Saved draft' }, updatedAt: '2026-10-12T00:00:00.000Z' },
    intent: { intentId: id(40), timelineId, baseRevision: 4, input: { requestId: 'original-request', deliveryName: 'Original delivery' }, outcome: { status: 'pending' } } },
    controller: { restore: () => events.push('restore'), recover: () => events.push('recover') } });
  const tree = renderPanel({ recovery, canCheck: false, deliveryNameError: 'Invalid name', pendingExport: true });
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'delivery-draft-recovery').props['aria-label'], '本地交付草稿与原导出请求');
  const restore = nodes(tree).find(node => node.props['data-testid'] === 'restore-delivery-draft');
  const recover = nodes(tree).find(node => node.props['data-testid'] === 'recover-original-delivery');
  assert.equal(restore.type, 'Button'); assert.equal(restore.props.type, 'button'); assert.equal(restore.props.disabled, false);
  assert.equal(recover.type, 'Button'); assert.equal(recover.props.type, 'button'); assert.equal(recover.props.disabled, false);
  assert.equal(textOf(recover), '确认恢复同一原请求'); assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-check').props.disabled, true);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export').props.disabled, true);
  assert.match(textOf(tree), /请使用原请求旁的恢复入口核对同一请求；重新检查不会重发导出/);
  assert.doesNotMatch(textOf(tree), /请在任务面板恢复同一请求/); assert.deepEqual(events, []);
});

test('actual dock view names saved-only scope, excludes all drafts and never performs reads itself', async () => {
  const f = fixture(); await f.ready(); const tree = renderPanel({ state: f.state(), projectName: '片名', dirty: true });
  const text = textOf(tree); for (const expected of ['仅检查已保存', '镜头、片段和源范围', '未保存修改', '未进行完整解码', '实际导出仍会重新验证', '不是导出成功凭据', '720 × 1280', '30 fps']) assert.ok(text.includes(expected), expected);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export').props.disabled, false);
  assert.doesNotMatch(panelSource, /useEffect|useState|\bfetch\s*\(|\brpc\s*\(|localStorage|sessionStorage|role="dialog"/);
});

test('actual dock view separates ready, incomplete, stale, error, pending receipt and export-in-progress', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete' })); let tree = renderPanel({ state: f.state() });
  assert.match(textOf(tree), /检查未完成，仍尝试导出/); assert.match(textOf(tree), /不代表通过/);
  const exportButton = tree => nodes(tree).find(node => node.props['data-testid'] === 'preflight-export');
  assert.equal(exportButton(tree).props.disabled, false);
  for (const props of [{ exportBusy: true }, { pendingExport: true }, { state: { ...f.state(), phase: 'stale' } }, { state: { ...f.state(), phase: 'error' } }, { state: { ...f.state(), binding: null } }]) assert.equal(exportButton(renderPanel({ state: f.state(), ...props })).props.disabled, true);
});

test('third dock integrates with original keep-mounted/inert panes, existing mode guard, and no storage or selection switch', () => {
  assert.match(appSource, /data-testid="export-timeline"[^>]+onClick={openTimelineExport}/);
  for (const tab of ['properties', 'agent', 'delivery']) { assert.ok(appSource.includes(`data-testid="right-dock-tab-${tab}"`)); assert.ok(appSource.includes(`<AgentDockPane id="right-dock-${tab}"`)); }
  assert.match(appSource, /<CollapsibleContent keepMounted className="inspector-region-content">/);
  assert.match(appSource, /async function changeMode\(mode\)[\s\S]*?if \(!await guardNavigation\(\)\) return;/);
  const inspect = appSource.slice(appSource.indexOf('  async function inspect('), appSource.indexOf('  async function addShot(')); assert.doesNotMatch(inspect, /setRightDockTab/);
  const controllerSource = readFileSync(new URL('../apps/web/src/export-preflight-state.js', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../apps/web/src/use-export-preflight.js', import.meta.url), 'utf8');
  assert.doesNotMatch(controllerSource + hook, /localStorage|sessionStorage|setInterval|setTimeout|timeline\.render/);
  assert.doesNotMatch(hook, /\.check\(|takeExportBinding|visibilitychange/);
  assert.match(hook, /controller\.current\.setVisible\(visible\)/);
});

test('rpc optional signal preserves exact existing call shape and only attaches observer signal on request', async t => {
  const previous = globalThis.fetch, calls = []; globalThis.fetch = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: true, data: { ok: 1 } }) }; };
  t.after(() => { globalThis.fetch = previous; });
  await rpc('timeline.render', { purpose: 'preview' }); assert.equal(Object.hasOwn(calls[0][1], 'signal'), false);
  const controller = new AbortController(); await rpc('timeline.export.preflight', { projectId, expectedRevision: 4 }, { signal: controller.signal });
  assert.equal(calls[1][1].signal, controller.signal); assert.deepEqual(JSON.parse(calls[1][1].body), { operation: 'timeline.export.preflight', input: { projectId, expectedRevision: 4 } });
});

function hookHarness() {
  const slots = [], tasks = []; let cursor = 0, effects = [];
  const react = {
    useRef(value) { return slots[cursor++] ||= { current: value }; },
    useState(initial) { const i = cursor++; slots[i] ||= { value: initial }; return [slots[i].value, value => { slots[i].value = value; }]; },
    useLayoutEffect(callback, dependencies) { const i = cursor++, old = slots[i]; if (old && dependencies.length === old.dependencies.length && dependencies.every((value, j) => value === old.dependencies[j])) return; slots[i] = { dependencies, callback, cleanup: old?.cleanup }; effects.push(i); },
  };
  const module = { exports: {} }, source = readFileSync(new URL('../apps/web/src/use-export-preflight.js', import.meta.url), 'utf8');
  Function('module', 'exports', 'require', transformSync(source, { loader: 'js', format: 'cjs' }).code)(module, module.exports, name => name === 'react' ? react : { createExportPreflightController });
  return {
    tasks,
    render(patch = {}) { cursor = 0; effects = []; const props = { ...context(), projectId, visible: false, read: (input, options) => { const task = deferred(); tasks.push({ ...task, input, options }); return task.promise; }, ...patch }; const result = module.exports.useExportPreflight(props); for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } return result; },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

test('actual hook has no mount/visibility/reconnect request and detaches on unmount without late state', async () => {
  const h = hookHarness(); let state = h.render(); h.render({ visible: true }); h.render({ visible: false });
  h.render({ connected: false }); state = h.render({ connected: true, visible: true });
  assert.equal(h.tasks.length, 0); const pending = state.controller.check(); assert.equal(h.tasks.length, 1);
  h.unmount(); assert.equal(h.tasks[0].options.signal.aborted, true); h.tasks[0].resolve(report()); await pending;
  assert.equal(state.controller.getState().report, null);
  const recreated = hookHarness(); const restored = recreated.render({ visible: true }); assert.equal(recreated.tasks.length, 0); assert.equal(restored.controller.getState().report, null);
});

test('live project/revision refs fence responses before the next React context effect', async () => {
  for (const rejected of [false, true]) {
    let live = context(); const held = deferred(), auth = [];
    const controller = createExportPreflightController({ read: () => held.promise, getContext: () => live, onUnauthorized: () => auth.push(false) });
    controller.setContext(live); const waiting = controller.check();
    live = context({ projectId: id(99), scope: 'new-project:2' });
    // Deliberately do not call setContext: App navigation refs change first.
    if (rejected) held.reject(Object.assign(Error('Old authorization'), { code: 'UNAUTHORIZED' })); else held.resolve(report());
    await waiting; assert.equal(controller.getState().projectId, live.projectId); assert.equal(controller.getState().report, null); assert.equal(auth.length, 0);
  }
  let live = context(); const held = deferred(), controller = createExportPreflightController({ read: () => held.promise, getContext: () => live });
  controller.setContext(live); const waiting = controller.check(); live = context({ revision: 5 }); held.resolve(report()); await waiting;
  assert.equal(controller.getState().binding, null); assert.equal(controller.getState().revision, 5);
});

test('disposed live-context observer cannot reattach itself or publish late state', async () => {
  const held = deferred(), changes = [];
  const controller = createExportPreflightController({ read: () => held.promise, getContext: () => context(), onChange: state => changes.push(state) });
  controller.setContext(context()); const waiting = controller.check(), count = changes.length;
  controller.dispose(); held.resolve(report()); await waiting;
  assert.equal(changes.length, count); assert.equal(controller.getState().projectId, null); assert.equal(controller.getState().report, null);
});

test('owned issue source is identified compactly with Chinese known-code messages and safe unknown fallback', async () => {
  const f = fixture(); await f.ready(report({ status: 'blocked', issues: [{ code: 'PREFLIGHT_SOURCE_CHANGED', severity: 'error', message: 'A source changed.', assetId: id(20) }] }));
  const text = textOf(renderPanel({ state: f.state() })); assert.match(text, /源素材已变化/); assert.match(text, /素材 70000000/); assert.doesNotMatch(text, /A source changed/);
  assert.doesNotMatch(preflightIssueMessage({ code: 'UNKNOWN', severity: 'error', message: 'private bare secret' }), /private|bare|secret/);
});

test('snapshot-budget report stays incomplete with separate explicit unchecked export intent', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
    checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false },
    issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'The ownership graph exceeded the bounded read budget.' }] }));
  assert.equal(f.state().phase, 'incomplete'); assert.equal(f.state().error, ''); assert.equal(f.state().binding, null);
  const tree = renderPanel({ state: f.state() }); assert.match(textOf(tree), /关联资料超出本次安全检查上限/); assert.match(textOf(tree), /仍尝试导出会使用当前已保存的时间线版本/);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export'), undefined);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export-unchecked').props.disabled, false);
  assert.deepEqual(f.state().uncheckedIntent, { projectId, expectedRevision: 4 });
  assert.equal(f.controller.takeExportBinding(null), null);
});

for (const mismatch of [{ timelineId: id(99), timelineRevision: null }, { timelineId: null, timelineRevision: 5 }]) {
  test(`incomplete report rejects non-null mismatched context ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture(); await f.ready(report({ status: 'incomplete', snapshotHash: null, summary: null, ...mismatch }));
    assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null); assert.match(f.state().error, /不完整或与当前快照不匹配/);
  });
}

const uncheckedReport = patch => report({ status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
  checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false },
  issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'Ownership graph budget reached.' }], ...patch });

test('unchecked intent is distinct, one-use, cannot be forged, and never enters checked-binding path', async () => {
  const f = fixture(); await f.ready(uncheckedReport()); const intent = f.state().uncheckedIntent;
  assert.equal(f.state().binding, null); assert.equal(f.state().report.snapshotHash, null); assert.equal(Object.hasOwn(intent, 'preflightSnapshotHash'), false);
  assert.equal(f.controller.takeExportBinding(intent), null); assert.equal(f.controller.takeUncheckedExportIntent({ ...intent }), null);
  assert.equal(f.controller.takeUncheckedExportIntent(intent), intent); assert.equal(f.controller.takeUncheckedExportIntent(intent), null);
  assert.equal(f.state().attempted, true); assert.equal(f.state().binding, null);
});

test('actual unchecked export is explicit, uses current saved revision without hash, and dispatches only once', async () => {
  const f = fixture(), h = appHarness(f); h.open(); const pending = h.check(); f.reads.at(-1).resolve(uncheckedReport()); await pending;
  assert.equal(h.calls.length, 0); const intent = f.state().uncheckedIntent;
  const calls = [], tree = renderPanel({ state: f.state(), onExport: () => assert.fail('Unchecked action cannot use checked export callback'), onUncheckedExport: value => calls.push(value) });
  const button = nodes(tree).find(node => node.props['data-testid'] === 'preflight-export-unchecked');
  assert.match(textOf(button), /未完成快照核验，仍尝试导出/); button.props.onClick(); assert.deepEqual(calls, [intent]);
  await h.renderUnchecked(intent); await h.renderUnchecked(intent);
  assert.deepEqual(h.calls, [['local-delivery.submit', { projectId, expectedRevision: 4, requestId: 'stable-test-request', purpose: 'export' }]]);
  assert.equal(f.state().report.snapshotHash, null); assert.equal(f.state().binding, null);
});

test('unchecked intent expires on newer checks and cannot skip stale, blocked, known-error or ready outcomes', async () => {
  const f = fixture(); await f.ready(uncheckedReport()); const old = f.state().uncheckedIntent;
  await f.ready(uncheckedReport()); assert.equal(f.controller.takeUncheckedExportIntent(old), null);
  for (const value of [report(), report({ status: 'blocked' }), report({ status: 'stale' }), report({ status: 'incomplete' }), uncheckedReport({ issues: [{ code: 'PREFLIGHT_SOURCE_INVALID', severity: 'error', message: 'Known invalid source' }] })]) {
    await f.ready(value); assert.equal(f.state().uncheckedIntent, null); assert.equal(f.controller.takeUncheckedExportIntent(old), null);
    assert.equal(nodes(renderPanel({ state: f.state() })).some(node => node.props['data-testid'] === 'preflight-export-unchecked'), false);
  }
});

test('actual unchecked export rejects changed project/revision and protects original pending receipts', async () => {
  const f = fixture(), h = appHarness(f); await f.ready(uncheckedReport()); let intent = f.state().uncheckedIntent;
  h.pending.push({ key: 'timeline:render:export', operation: 'timeline.render', input: { requestId: 'original-receipt', expectedRevision: 2 } });
  await h.renderUnchecked(intent); assert.equal(h.calls.length, 0); assert.deepEqual(h.jobs, [true]); assert.equal(f.state().attempted, false);
  h.pending.length = 0; h.env.dataRef.current.timeline.revision = 5; await h.renderUnchecked(intent); assert.equal(h.calls.length, 0);
  f.controller.setContext(context()); await f.ready(uncheckedReport()); intent = f.state().uncheckedIntent;
  h.env.dataRef.current.timeline.revision = 4; h.env.currentProject.current = id(99); await h.renderUnchecked(intent); assert.equal(h.calls.length, 0);
});

test('unchecked intent rechecks live context before React effect and cannot revive after disconnect/dispose', async () => {
  let live = context(); const controller = createExportPreflightController({ read: async () => uncheckedReport(), getContext: () => live });
  controller.setContext(live); await controller.check(); let intent = controller.getState().uncheckedIntent;
  live = context({ revision: 5 }); assert.equal(controller.takeUncheckedExportIntent(intent), null);
  live = context(); controller.setContext(live); await controller.check(); intent = controller.getState().uncheckedIntent;
  controller.setContext(context({ connected: false })); assert.equal(controller.takeUncheckedExportIntent(intent), null);
  controller.setContext(live); await controller.check(); intent = controller.getState().uncheckedIntent;
  controller.dispose(); assert.equal(controller.takeUncheckedExportIntent(intent), null); assert.equal(controller.getState().projectId, null);
});

test('unchecked export control respects pending receipt and submission busy states without changing its warning', async () => {
  const f = fixture(); await f.ready(uncheckedReport());
  for (const props of [{ exportBusy: true }, { pendingExport: true }, { state: { ...f.state(), attempted: true } }]) {
    const tree = renderPanel({ state: f.state(), ...props }); assert.match(textOf(tree), /当前已保存的时间线版本/);
    assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export-unchecked').props.disabled, true);
  }
});

test('compact dock exposes saved-snapshot scope and dirty warning while showing blocking issues before statistics', async () => {
  const f = fixture(); await f.ready(report({ status: 'blocked', issues: [{ code: 'PREFLIGHT_SOURCE_INVALID', severity: 'error', message: 'Missing managed source', assetId: id(20) }] }));
  const tree = renderPanel({ state: f.state(), dirty: true, projectName: 'Missing media project' }), all = nodes(tree);
  const disclosure = all.find(node => node.props['data-testid'] === 'preflight-scope-details');
  assert.equal(disclosure.type, 'details'); assert.equal(disclosure.props.open, undefined);
  assert.match(textOf(nodes(disclosure).find(node => node.type === 'summary')), /仅检查已保存的时间线快照/);
  assert.match(textOf(disclosure), /镜头、片段和源范围/);
  const dirty = all.find(node => node.props['data-testid'] === 'preflight-unsaved'); assert.ok(dirty);
  assert.equal(nodes(disclosure).includes(dirty), false, 'Draft warning must remain visible while disclosure is closed');
  assert.match(textOf(dirty), /本次不包含/);
  const issues = all.findIndex(node => node.props['data-testid'] === 'preflight-issues');
  assert.ok(issues > 0); assert.ok(issues < all.findIndex(node => node.props.className === 'export-preflight-checked'));
  assert.ok(issues < all.findIndex(node => node.props.className === 'export-preflight-summary'));
  assert.match(textOf(all[issues]), /源素材缺失/);
  const body = all.find(node => node.props.className === 'export-preflight-body'), footer = all.find(node => node.type === 'footer');
  assert.equal(nodes(body).includes(footer), false, 'Actions stay outside report scroll');
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.export-preflight-actions\{display:flex;flex:none;/);
  assert.match(css, /\.export-preflight-body\{min-height:0;flex:1;overflow:auto;/);
});
