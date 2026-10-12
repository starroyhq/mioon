import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as exportSettings from '../apps/web/src/export-settings-state.js';
import * as format from '../apps/web/src/timeline-format-state.js';
import { createTimelineDeliveryNameController } from '../apps/web/src/export-delivery-state.ts';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import * as contracts from '@mioon/contracts';
import * as audio from '../apps/web/src/clip-audio-state.js';
import * as clipDraft from '../apps/web/src/clip-draft-state.ts';

const id = n => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2);
const context = patch => ({ scope: `${projectId}:1`, projectId, projectRevision: 2, timelineId: null, timelineRevision: 0, connected: true, pending: false, ...patch });
const metadata = patch => ({ projectId, projectRevision: 2, timelineId: null, timelineRevision: 0, presetId: 'portrait_720', fps: 30, width: 720, height: 1280, eligible: true, blockedReasons: [], ...patch });
const timeline = (presetId = 'landscape_720', revision = 1) => ({ id: timelineId, projectId, revision,
  ...Object.fromEntries(Object.entries(contracts.timelineOutputPreset(presetId)).filter(([key]) => ['fps', 'width', 'height'].includes(key))),
  tracks: [{ id: id(3), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }], clips: [], durationFrames: 0,
  createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let live = context(), server = metadata(), heldRead = null;
  const reads = [], submits = [], responses = [], auth = [];
  let sequence = 0;
  const controller = format.createTimelineFormatController({
    getContext: () => live,
    read: (input, options) => { reads.push({ input, options }); const held = heldRead; heldRead = null; return held ? held.promise : Promise.resolve(structuredClone(server)); },
    submit: intent => { submits.push(intent); const response = deferred(); responses.push(response); return response.promise; },
    createRequestId: () => `format-request-${++sequence}`, onUnauthorized: () => auth.push(true),
  });
  controller.setContext(live); controller.setVisible(true);
  return { controller, reads, submits, responses, auth, state: () => controller.getState(),
    async ready() { await controller.load(); return controller.getState(); },
    set(patch, commit = true) { live = { ...live, ...patch }; if (commit) controller.setContext(live); },
    server(patch) { server = { ...server, ...patch }; },
    holdRead() { heldRead = deferred(); return heldRead; },
    ack(index = 0, presetId = submits[index].input.presetId) { const value = timeline(presetId, submits[index].input.expectedRevision + 1); server = metadata({ timelineId, timelineRevision: value.revision, presetId, fps: value.fps, width: value.width, height: value.height }); live = { ...live, timelineId, timelineRevision: value.revision }; responses[index].resolve({ status: 'applied', timeline: value }); return value; },
  };
}

test('closed presets and noncreating read retain exact authoritative eligibility', async () => {
  const f = fixture(); await f.ready();
  assert.deepEqual(format.TIMELINE_OUTPUT_PRESETS.map(preset => [preset.id, preset.width, preset.height, preset.fps]), [
    ['portrait_720', 720, 1280, 30], ['landscape_720', 1280, 720, 30], ['square_720', 720, 720, 30],
  ]);
  assert.deepEqual(f.reads[0].input, { projectId }); assert.equal(f.submits.length, 0);
  assert.equal(f.state().saved.timelineId, null); assert.equal(f.state().saved.timelineRevision, 0);
  for (const reason of ['CLIPS_PRESENT', 'HISTORY_PRESENT', 'REQUEST_HISTORY', 'EXPORT_HISTORY', 'PENDING_EDIT']) {
    f.server({ eligible: false, blockedReasons: [reason] }); await f.ready();
    assert.equal(f.controller.choose('landscape_720'), false); assert.equal(format.timelineFormatCanSave(f.state()), false);
    assert.ok(format.timelineFormatReason(reason));
  }
});

test('polls, dock hiding, selection and mode changes preserve the independent format draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720');
  const base = structuredClone(f.state().base);
  f.controller.setVisible(false); f.set({ selectedClipId: 'next', activeMode: 'canvas', propertiesPage: 'inspector' }); await f.ready();
  assert.equal(f.state().draftPresetId, 'landscape_720'); assert.equal(f.state().dirty, true); assert.deepEqual(f.state().base, base);
  assert.equal(await f.controller.save(), null); assert.equal(f.controller.choose('square_720'), false); assert.equal(f.submits.length, 0);
  f.controller.setVisible(true); assert.equal(f.controller.choose('square_720'), true); assert.equal(f.state().dirty, true);
});

test('newer authoritative revision preserves dirty choice and prevents blind rebase', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_720');
  f.server({ projectRevision: 3 }); f.set({ projectRevision: 3 }); await f.ready();
  assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(f.state().base.projectRevision, 2); assert.equal(f.state().conflict, true);
  assert.equal(await f.controller.save(), null);
  f.controller.discardDraft(); assert.equal(f.state().dirty, false); assert.equal(f.state().base.projectRevision, 3);
  f.controller.choose('square_720'); assert.equal(format.timelineFormatCanSave(f.state()), true);
});

test('live owner change before React commit fences late read success and authentication error', async () => {
  for (const failure of [false, true]) {
    const f = fixture(), held = f.holdRead(), waiting = f.controller.load();
    f.set({ projectId: id(9), scope: 'other:2' }, false);
    if (failure) held.reject(Object.assign(Error('expired'), { code: 'UNAUTHORIZED' })); else held.resolve(metadata());
    await waiting;
    assert.equal(f.state().projectId, id(9)); assert.equal(f.state().saved, null); assert.equal(f.auth.length, 0);
  }
});

test('newer read wins; reconnect keeps draft but cannot revive an unverified save', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_720');
  const held = f.holdRead(), older = f.controller.load(); await f.ready(); held.resolve(metadata({ projectRevision: 1 })); await older;
  assert.equal(f.state().saved.projectRevision, 2);
  f.set({ connected: false }); assert.equal(format.timelineFormatCanSave(f.state()), false);
  f.set({ connected: true }); assert.equal(format.timelineFormatCanSave(f.state()), false);
  await f.ready(); assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(format.timelineFormatCanSave(f.state()), true);
});

test('save freezes both revisions and exact intent; double click never mints another request', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720');
  const saved = f.controller.save(); assert.equal(await f.controller.save(), null);
  assert.deepEqual(f.submits[0].input, { projectId, expectedProjectRevision: 2, expectedRevision: 0, requestId: 'format-request-1', presetId: 'landscape_720' });
  assert.ok(Object.isFrozen(f.submits[0].input)); assert.equal(f.submits.length, 1);
  f.ack(); await saved; assert.equal(f.state().dirty, false); assert.equal(f.state().saved.width, 1280);
  assert.equal(f.state().saved.timelineRevision, 1); assert.equal(f.controller.hasUnsaved(), false);
  f.controller.choose('square_720'); const second = f.controller.save(); assert.equal(f.submits[1].input.expectedRevision, 1); f.ack(1); await second;
});

for (const later of ['square_720', 'portrait_720']) test(`late ACK does not erase later ${later} draft while the panel is hidden`, async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720'); const saving = f.controller.save();
  f.controller.choose(later); f.controller.setVisible(false); f.ack(); await saving;
  assert.equal(f.state().draftPresetId, later); assert.equal(f.state().dirty, true); assert.equal(f.state().base.timelineRevision, 1);
  assert.equal(f.state().saved.presetId, 'landscape_720'); assert.equal(f.submits.length, 1);
});

test('same project revisited in a newer epoch cannot receive an old save ACK', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720'); const saving = f.controller.save();
  f.set({ scope: `${projectId}:3` }); f.ack(); await saving;
  assert.equal(f.state().scope, `${projectId}:3`); assert.equal(f.state().saved, null); assert.equal(f.state().dirty, false);
});

test('unknown exact intent remains fenced after reads, hiding and reconnect; only explicit matching recovery releases it', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720'); const saving = f.controller.save();
  f.responses[0].resolve({ status: 'unknown' }); await saving;
  const original = f.state().uncertain; assert.ok(original); assert.match(f.state().error, /同一请求/);
  f.controller.choose('square_720'); f.controller.setVisible(false); await f.ready(); f.set({ connected: false }); f.set({ connected: true }); f.controller.setVisible(true); await f.ready();
  assert.equal(await f.controller.save(), null); assert.equal(f.submits.length, 1); assert.equal(f.state().uncertain, original);
  const task = { projectId, operation: 'timeline.format.set', requestId: original.input.requestId, input: { ...original.input }, status: 'not_applied' };
  f.controller.recovered({ ...task, input: { ...task.input, presetId: 'square_720' } }); await tick(); assert.equal(f.state().uncertain, original);
  f.controller.recovered(task); await tick(); assert.equal(f.state().uncertain, null); assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(f.state().dirty, true);
  assert.equal(f.submits.length, 1);
});

test('historical applied recovery refreshes saved data without acknowledging or replacing the current draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_720');
  f.server({ timelineId, timelineRevision: 1, presetId: 'landscape_720', width: 1280, height: 720 });
  f.controller.recovered({ projectId, operation: 'timeline.format.set', requestId: 'historical-request', input: {}, status: 'applied' }); await tick();
  assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(f.state().dirty, true); assert.equal(f.state().conflict, true); assert.equal(f.submits.length, 0);
});

test('malformed or misbound ACK never clears the draft or releases unknown intent', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720'); const saving = f.controller.save();
  f.responses[0].resolve({ status: 'applied', timeline: timeline('square_720') }); await saving;
  assert.equal(f.state().dirty, true); assert.ok(f.state().uncertain); assert.equal(format.timelineFormatCanSave(f.state()), false);
});

for (const patch of [{ extra: true }, { projectId: id(9) }, { timelineId, timelineRevision: 0 }, { presetId: 'landscape_720', width: 1280, height: 720 }, { width: 1080 }, { blockedReasons: ['NEW_UNKNOWN_REASON'], eligible: false }, { blockedReasons: ['CLIPS_PRESENT'], eligible: true }]) {
  test(`format read fails closed: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); f.server(patch); await f.ready(); assert.equal(f.state().phase, 'error'); assert.equal(f.state().saved, null);
  });
}

const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const primitive = new Proxy({ __esModule: true, default: 'Component' }, { get: (target, name) => target[name] ?? String(name) });
function component(name, imports = {}) {
  const react = { createElement: element, useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useState: value => [typeof value === 'function' ? value() : value, () => {}] }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(read(name), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, key => key === 'react' ? react : key === '@mioon/contracts' ? contracts : key === './timeline-format-state.js' ? format : key === './export-settings-state.js' ? exportSettings : imports[key] || primitive);
  return module.exports;
}

test('actual format panel uses accessible shared controls and tells the truth about scope, fixed fps and blocked reasons', async () => {
  const f = fixture(); await f.ready(); const events = [];
  const Panel = component('TimelineFormatPanel.jsx').default;
  let tree = Panel({ state: f.state(), controller: f.controller, onBack: () => events.push('back'), onOpenTasks: () => events.push('tasks') });
  const text = textOf(tree);
  for (const label of ['时间线输出规格', '返回属性', '源素材、生成比例不会改变', '分镜导出固定 9:16', '30 fps', '不进入片段撤销历史', '服务器会再次核对资格']) assert.ok(text.includes(label), label);
  assert.match(text, /默认时间线规格（尚未创建）/); assert.doesNotMatch(text, /已保存的时间线规格/);
  const persisted = Panel({ state: { ...f.state(), saved: metadata({ timelineId, timelineRevision: 1 }) }, controller: f.controller });
  assert.match(textOf(persisted), /已保存的时间线规格/); assert.doesNotMatch(textOf(persisted), /默认时间线规格（尚未创建）/);
  assert.equal(tree.props['aria-labelledby'], 'timeline-format-title');
  assert.equal(nodes(tree).find(node => node.props.htmlFor === 'timeline-format-preset').type, 'Label');
  assert.equal(nodes(tree).find(node => node.props.id === 'timeline-format-preset').type, 'WorkbenchSelect');
  assert.equal(nodes(tree).filter(node => node.type === 'option').length, 3);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'timeline-format-save').props.disabled, true);
  nodes(tree).find(node => node.props['data-testid'] === 'timeline-format-back').props.onClick(); assert.deepEqual(events, ['back']);
  f.server({ eligible: false, blockedReasons: ['CLIPS_PRESENT', 'HISTORY_PRESENT', 'REQUEST_HISTORY', 'EXPORT_HISTORY', 'PENDING_EDIT'] }); await f.ready();
  tree = Panel({ state: f.state(), controller: f.controller });
  for (const reason of f.state().saved.blockedReasons) assert.ok(textOf(tree).includes(format.timelineFormatReason(reason)));
  assert.equal(nodes(tree).find(node => node.props.id === 'timeline-format-preset').props.disabled, true);
  assert.doesNotMatch(read('TimelineFormatPanel.jsx'), /<input|<select|<button|role="dialog"|\brpc\(|useEffect/);
});

test('retained format panel callbacks cannot edit, reset, read or submit a revisited project epoch', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720');
  const Panel = component('TimelineFormatPanel.jsx').default, old = Panel({ state: f.state(), controller: f.controller });
  f.set({ scope: `${projectId}:2` }); await f.ready(); f.controller.choose('square_720');
  const count = f.reads.length;
  nodes(old).find(node => node.props.id === 'timeline-format-preset').props.onChange({ target: { value: 'portrait_720' } });
  for (const label of ['保存输出规格', '重新核对', '载入已保存规格']) await nodes(old).find(node => node.type === 'Button' && textOf(node) === label).props.onClick();
  assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(f.state().dirty, true); assert.equal(f.submits.length, 0); assert.equal(f.reads.length, count);
});

test('actual preview labels the old job snapshot dimensions, never the current timeline', () => {
  const Preview = component('Preview.jsx', { './workspace-visibility.jsx': { useWorkspaceVisibility: () => true }, './api.js': { assetUrl: () => '', statusText: () => '成功' }, './Timeline.jsx': { assetKind: () => 'video', framesLabel: String } }).default;
  const tree = Preview({ kind: 'timeline', timeline: timeline('landscape_720', 9), job: { id: id(7), status: 'succeeded', url: '/media/old', timelineRevision: 1, snapshot: { timeline: timeline('square_720', 1) } }, playhead: 30 });
  const footer = nodes(tree).find(node => node.props.className === 'preview-footer');
  assert.match(textOf(footer), /720 × 720 · 30 fps/); assert.doesNotMatch(textOf(footer), /1280/);
  const missing = Preview({ kind: 'timeline', timeline: timeline('landscape_720', 9), job: { status: 'succeeded', url: '/media/old', timelineRevision: 1 }, playhead: 0 });
  assert.match(textOf(nodes(missing).find(node => node.props.className === 'preview-footer')), /快照规格不可用/);
});

test('actual timeline header and preflight summary use their own saved dimensions', () => {
  const Timeline = component('Timeline.jsx', { './use-timeline-waveforms.js': { useTimelineWaveforms: () => ({ windows: [], entries: new Map() }) }, './waveform-state.js': { WAVEFORM_LIMITS: { entries: 12 } } }).default;
  const tree = Timeline({ timeline: timeline('landscape_720'), assets: [], playhead: 0 });
  assert.equal(textOf(nodes(tree).find(node => node.props.className === 'timeline-spec')), '30 fps · 1280 × 720');
  const Panel = component('TimelineExportPreflight.jsx').default;
  const summary = { fps: 30, width: 720, height: 720, durationFrames: 90, trackCount: 1, clipCount: 1, assetCount: 1 };
  const report = Panel({ state: { phase: 'ready', report: { timelineRevision: 1, checkedAt: '2026-10-11T00:00:00Z', issues: [], summary, checks: { checkedAssets: 1, totalAssets: 1, bytesHashed: 0 } } } });
  assert.match(textOf(report), /720 × 720 · 30 fps/); assert.doesNotMatch(textOf(report), /1280/);
});

test('actual inspector bounds follow landscape and square timelines and reject odd or overflowing rectangles', () => {
  const Inspector = component('TimelineInspector.jsx', { './clip-audio-state.js': audio, './Timeline.jsx': { assetKind: () => 'image', framesLabel: String }, '@mioon/ui/components/workbench-confirm': { useConfirmation: () => async () => true }, './workspace-visibility.jsx': { useWorkspaceVisibility: () => true }, './clip-draft-state.ts': clipDraft,
    './clip-draft-hook.ts': { useClipDraft: ({ context }) => { const controller = clipDraft.createClipDraftController({ context, client: { get: () => assert.fail('Static bounds inspection does not load persistence') } }); return { state: controller.getState(), controller }; } },
  }).default;
  for (const preset of ['landscape_720', 'square_720']) {
    const saved = timeline(preset), rect = { x: 0, y: 0, width: saved.width, height: saved.height };
    const tree = Inspector({ clip: { id: id(4), trackId: id(3), name: 'Image', rect, startFrame: 0, durationFrames: 30, sourceInFrame: 0, gain: 1 }, timeline: saved, asset: { mimeType: 'image/png' } });
    for (const key of ['x', 'width', 'y', 'height']) assert.equal(nodes(tree).find(node => node.props.id === `clip-${key}`).props.max, ['x', 'width'].includes(key) ? saved.width : saved.height);
    assert.equal(format.timelineRectIssue(rect, saved), '');
    assert.match(format.timelineRectIssue({ ...rect, x: 2 }, saved), /超出/);
    assert.match(format.timelineRectIssue({ ...rect, width: 3 }, saved), /偶数/);
    assert.match(format.timelineRectIssue({ ...rect, height: 0 }, saved), /有效偶数/);
  }
});

const app = read('App.jsx');
function appFunction(name, end, env) {
  const start = app.indexOf(`  ${name}`), stop = app.indexOf(`  ${end}`, start);
  assert.ok(start >= 0 && stop > start, 'Actual App callback boundaries must remain present');
  assert.equal(app.indexOf(`  ${name}`, start + name.length + 2), -1, 'The extracted callback must have a unique owner');
  return Function(...Object.keys(env), `${app.slice(start, stop)}; return ${name.replace(/^async function |^function /, '').split('(')[0]};`)(...Object.values(env));
}
test('actual project-leave guard checks the independent draft and only discards after accepted current-owner navigation', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720');
  let approved = false; const checks = [];
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { timelineFormatRef: { current: f }, deliveryNameRef: { current: null }, localDeliveryRef: { current: null }, guardNavigation: async (message, dirty) => { checks.push({ message, dirty }); return approved; } });
  assert.equal(await guard('leave'), false); assert.equal(f.state().dirty, true); assert.equal(checks[0].dirty, true);
  approved = true; assert.equal(await guard('leave'), true); assert.equal(f.state().dirty, false);
  assert.match(app, /selectProject[\s\S]*?guardProjectNavigation\(draftMessage/);
  assert.match(app, /async function createProject[\s\S]*?guardProjectNavigation\(/);
  assert.match(app, /onPop = async[\s\S]*?selectProject\(id, false, true\)/);
  assert.match(app, /beforeunload[\s\S]*?timelineFormatRef\.current\?\.controller\.hasUnsaved\(\)/);
});

test('actual navigation epoch guard prevents late confirmation from discarding a newer project draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720');
  let epoch = 1; const confirmation = deferred();
  const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', {
    clipDraftRef: { current: null },
    subtitlesRef: { current: { controller: { getState: () => null, hasUnsaved: () => false, discardDraft() { assert.fail('Late confirmation must not discard subtitle drafts'); } } } }, setSubtitleDirty() { assert.fail('Late confirmation must not clear subtitle state'); },
    context: () => ({ projectId, epoch }), isCurrent: captured => captured.projectId === projectId && captured.epoch === epoch,
    dirtyRef: { current: false }, confirm: () => confirmation.promise,
  });
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { timelineFormatRef: { current: f }, deliveryNameRef: { current: null }, localDeliveryRef: { current: null }, guardNavigation });
  const leaving = guard('leave'); epoch++; f.set({ scope: `${projectId}:2` }); await f.ready(); f.controller.choose('square_720');
  confirmation.resolve(true); assert.equal(await leaving, false); assert.equal(f.state().draftPresetId, 'square_720'); assert.equal(f.state().dirty, true);
});

function deliveryNameController() {
  const live = { scope: context().scope, projectId, enabled: true };
  const controller = createTimelineDeliveryNameController({ getContext: () => live });
  controller.setContext(live);
  return controller;
}

for (const outcome of ['accepted unchanged', 'cancelled', 'newer name', 'name changed back', 'replacement controller', 'replacement local controller', 'newer project epoch', 'newer format', 'replacement format controller']) {
  test(`actual project guard preserves combined format and delivery-name drafts unless confirmation is current: ${outcome}`, async t => {
    const f = fixture(); await f.ready(); assert.equal(f.controller.choose('landscape_720'), true);
    const delivery = deliveryNameController(); assert.equal(delivery.choose('First delivery', context().scope), true);
    const deliveryNameRef = { current: { controller: delivery } }, confirmation = deferred(), checks = [];
    let epoch = 1;
    const getLocalContext = () => ({ scope: `${projectId}:${epoch}`, projectId, timelineId, timelineRevision: 1,
      restored: false, connected: true, visible: true, busy: false,
      deliveryName: deliveryNameRef.current.controller.getName(context().scope),
      nameVersion: deliveryNameRef.current.controller.getVersion(context().scope), dirty: deliveryNameRef.current.controller.hasUnsaved() });
    const makeLocalController = () => {
      const controller = createLocalDeliveryController({ context: getLocalContext(), getContext: getLocalContext,
        isRenderInput: value => contracts.schemas['timeline.render'].safeParse(value).success,
        validateResponse: (input, result) => contracts.isTimelineMutationResponse('timeline.render', input, result) });
      t.after(() => controller.dispose()); return controller;
    };
    const local = makeLocalController(), localDeliveryRef = { current: { controller: local } }, timelineFormatRef = { current: f };
    const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', {
      clipDraftRef: { current: null },
      context: () => ({ projectId, epoch }), isCurrent: captured => captured.projectId === projectId && captured.epoch === epoch,
      subtitlesRef: { current: null }, dirtyRef: { current: false },
      confirm: message => { checks.push(message); return confirmation.promise; },
    });
    const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', {
      timelineFormatRef, deliveryNameRef, localDeliveryRef, guardNavigation,
    });
    const leaving = guard('Discard both drafts?');
    assert.deepEqual(checks, ['Discard both drafts?']);
    assert.equal(f.controller.hasUnsaved(), true); assert.equal(delivery.hasUnsaved(), true);
    assert.equal(f.state().draftPresetId, 'landscape_720'); assert.equal(delivery.getState().value, 'First delivery');
    if (outcome === 'newer name' || outcome === 'name changed back') {
      assert.equal(delivery.choose('Newer delivery', context().scope), true);
      if (outcome === 'name changed back') assert.equal(delivery.choose('First delivery', context().scope), true);
    }
    if (outcome === 'replacement controller') {
      const replacement = deliveryNameController(); assert.equal(replacement.choose('First delivery', context().scope), true);
      assert.deepEqual(replacement.getState(), delivery.getState());
      deliveryNameRef.current = { controller: replacement };
    }
    if (outcome === 'replacement local controller') localDeliveryRef.current = { controller: makeLocalController() };
    if (outcome === 'newer project epoch') epoch++;
    if (outcome === 'newer format') assert.equal(f.controller.choose('square_720'), true);
    if (outcome === 'replacement format controller') {
      const replacement = fixture(); await replacement.ready(); assert.equal(replacement.controller.choose('landscape_720'), true);
      assert.deepEqual(replacement.state(), f.state()); timelineFormatRef.current = replacement;
    }
    localDeliveryRef.current.controller.setContext(getLocalContext());
    const localDraft = local.getState(), currentLocal = localDeliveryRef.current.controller, currentLocalDraft = currentLocal.getState();
    const currentFormat = timelineFormatRef.current, currentFormatDraft = currentFormat.state();
    const formatDraft = f.state(), originalNameDraft = delivery.getState(), currentDelivery = deliveryNameRef.current.controller, currentNameDraft = currentDelivery.getState();
    confirmation.resolve(outcome !== 'cancelled');
    const accepted = outcome === 'accepted unchanged';
    assert.equal(await leaving, accepted);
    assert.equal(f.controller.hasUnsaved(), !accepted); assert.equal(currentDelivery.hasUnsaved(), !accepted);
    if (accepted) {
      assert.equal(f.state().dirty, false); assert.equal(f.state().draftPresetId, 'portrait_720');
      assert.equal(currentDelivery.getState().dirty, false); assert.equal(currentDelivery.getState().value, '');
      assert.equal(currentLocal.getState().leaveWithoutSaving, true); assert.equal(currentLocal.getState().autosavePaused, true);
    } else {
      assert.equal(f.state(), formatDraft); assert.equal(f.state().dirty, true);
      assert.equal(currentFormat.state(), currentFormatDraft); assert.equal(currentFormat.state().dirty, true);
      assert.equal(delivery.getState(), originalNameDraft); assert.equal(delivery.hasUnsaved(), true);
      assert.equal(currentDelivery.getState(), currentNameDraft); assert.equal(currentDelivery.getState().dirty, true);
      assert.equal(local.getState().leaveWithoutSaving, localDraft.leaveWithoutSaving);
      assert.equal(local.getState().autosavePaused, localDraft.autosavePaused);
      assert.equal(currentLocal.getState().leaveWithoutSaving, currentLocalDraft.leaveWithoutSaving);
      assert.equal(currentLocal.getState().autosavePaused, currentLocalDraft.autosavePaused);
      assert.equal(currentLocal.getState().dirty, true);
    }
    assert.equal(f.submits.length, 0); assert.equal(currentFormat.submits.length, 0);
  });
}

test('newer delivery title during joint confirmation preserves dirty inspector, format and local draft together', async t => {
  const f = fixture(); await f.ready(); assert.equal(f.controller.choose('landscape_720'), true);
  const delivery = deliveryNameController(); assert.equal(delivery.choose('First delivery', context().scope), true);
  const getLocalContext = () => ({ scope: context().scope, projectId, timelineId, timelineRevision: 1,
    restored: false, connected: true, visible: true, busy: false, deliveryName: delivery.getName(context().scope),
    nameVersion: delivery.getVersion(context().scope), dirty: delivery.hasUnsaved() });
  const local = createLocalDeliveryController({ context: getLocalContext(), getContext: getLocalContext,
    isRenderInput: value => contracts.schemas['timeline.render'].safeParse(value).success,
    validateResponse: (input, result) => contracts.isTimelineMutationResponse('timeline.render', input, result) });
  t.after(() => local.dispose());
  const confirmation = deferred(), dirtyRef = { current: true }, resets = [], prompts = [];
  const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', {
    context: () => ({ projectId, epoch: 1 }), isCurrent: captured => captured.projectId === projectId && captured.epoch === 1,
    clipDraftRef: { current: null }, subtitlesRef: { current: null }, dirtyRef,
    subjectsRef: { current: { state: { scope: context().scope }, controller: { discardDrafts: () => resets.push('discard subjects') } } },
    confirm: message => { prompts.push(message); return confirmation.promise; },
    ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, () => resets.push(name)])),
  });
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', {
    timelineFormatRef: { current: f }, deliveryNameRef: { current: { controller: delivery } }, localDeliveryRef: { current: { controller: local } }, guardNavigation,
  });
  const leaving = guard('Discard all current drafts?'); assert.deepEqual(prompts, ['Discard all current drafts?']);
  assert.equal(delivery.choose('Newer delivery', context().scope), true); local.setContext(getLocalContext());
  const formatDraft = f.state(), nameDraft = delivery.getState(), localDraft = local.getState();
  confirmation.resolve(true); assert.equal(await leaving, false);
  assert.equal(dirtyRef.current, true); assert.deepEqual(resets, []);
  assert.equal(f.state(), formatDraft); assert.equal(f.controller.hasUnsaved(), true);
  assert.equal(delivery.getState(), nameDraft); assert.equal(delivery.hasUnsaved(), true);
  assert.equal(local.getState(), localDraft); assert.equal(local.hasUnsaved(), true);
  assert.equal(local.getState().leaveWithoutSaving, false); assert.equal(local.getState().autosavePaused, false);
  assert.equal(f.submits.length, 0);
});

test('actual format save callback uses only the existing durable timeline lane and exact frozen input', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_720'); const pending = f.controller.save(); const intent = f.submits[0];
  const calls = [];
  const save = appFunction('async function saveTimelineFormat(', 'const timelineFormat =', { timelineFormatContext: () => context(), isDurableEditOperation: value => contracts.DURABLE_EDIT_OPERATIONS.includes(value),
    runDurable: async (...args) => { calls.push(args); args[4].validateResponse(timeline()); return timeline(); }, timelineFormatAcknowledged: format.timelineFormatAcknowledged,
    tasksRef: { current: { blocked: () => false } } });
  assert.equal((await save(intent)).status, 'applied'); assert.equal(calls[0][0], 'timeline:mutation'); assert.equal(calls[0][1], 'timeline.format.set'); assert.equal(calls[0][2], intent.input);
  f.ack(); await pending;
});

test('App keeps both Properties subpages mounted and keeps format dirtiness outside inspector reset logic', () => {
  transformSync(app, { loader: 'jsx', format: 'esm' });
  for (const id of ['properties-inspector-pane', 'properties-format-pane', 'properties-subtitle-pane']) assert.ok(app.includes(`<AgentDockPane id="${id}"`));
  assert.equal((app.match(/data-testid="right-dock-tab-/g) || []).length, 4);
  assert.match(app, /const inspectorDirty = shotDirty \|\| clipDirty \|\| sourceDirty \|\| subjectDirty \|\| subtitleDirty;/);
  assert.match(app, /visible=\{propertiesPage === 'inspector' \|\| propertiesPage === 'subtitle' && workspaceMode === 'canvas'\}/); assert.match(app, /visible=\{propertiesPage === 'format'\}/);
  const open = app.slice(app.indexOf('  function openTimelineFormat()'), app.indexOf('  function subtitleContext()'));
  assert.doesNotMatch(open, /guardNavigation|setInspectorEpoch|setSelected|setQuickAsset|setSourceDirty|discardDraft/);
  const wrapper = read('AgentWorkspace.jsx'); assert.match(wrapper, /hidden=\{!shown\} inert=\{!shown\}/);
  const controls = read('WorkspaceControls.jsx'); assert.match(controls, /if \(!visible\) \{ setOpen\(false\)/); assert.match(controls, /inert=\{!popup.visible\}/);
  const task = read('TaskCenter.jsx'); assert.match(task, /DURABLE_EDIT_OPERATIONS\.length/); assert.equal(contracts.DURABLE_EDIT_OPERATIONS.length, 19);
});

test('actual dock pane retains child identity while hidden and removes it from focus and accessibility navigation', () => {
  const { AgentDockPane } = component('AgentWorkspace.jsx', { './workspace-visibility.jsx': { useWorkspaceVisibility: () => true, WorkspaceVisibilityProvider: 'VisibilityProvider' } });
  const draftChild = { type: 'Draft', props: { value: 'retained' } };
  for (const visible of [true, false, true]) {
    const tree = AgentDockPane({ visible, children: draftChild, id: 'format-pane', labelledBy: 'format-label', fallbackFocus: '#properties' });
    const pane = nodes(tree).find(node => node.props.id === 'format-pane');
    assert.equal(pane.props.hidden, !visible); assert.equal(pane.props.inert, !visible); assert.equal(pane.props['aria-hidden'], !visible || undefined);
    assert.equal(pane.props.role, 'tabpanel'); assert.equal(pane.props['aria-labelledby'], 'format-label'); assert.ok(pane.props.children.includes(draftChild));
  }
});

test('actual unload callback sees synchronous format edits and in-flight saves through its independent owner', async () => {
  const f = fixture(); await f.ready();
  const source = app.match(/const warn = e => \{ if \(!dirtyRef\.current[\s\S]*?e\.returnValue = ''; \};/)[0];
  const dirtyRef = { current: false }, warn = Function('dirtyRef', 'timelineFormatRef', 'deliveryNameRef', 'clipDraftRef', `${source}; return warn;`)(dirtyRef, { current: f }, { current: null }, { current: null });
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  let e = event(); warn(e); assert.equal(e.prevented, false);
  f.controller.choose('landscape_720'); e = event(); warn(e); assert.equal(e.prevented, true); assert.equal(e.returnValue, '');
  const saving = f.controller.save(); e = event(); warn(e); assert.equal(e.prevented, true);
  f.ack(); await saving; e = event(); warn(e); assert.equal(e.prevented, false);
  dirtyRef.current = true; e = event(); warn(e); assert.equal(e.prevented, true);
});

test('actual unload callback observes either current format or delivery-name controller without retaining replaced owners', async () => {
  const f = fixture(); await f.ready(); const delivery = deliveryNameController();
  const timelineFormatRef = { current: f }, deliveryNameRef = { current: { controller: delivery } };
  const source = app.match(/const warn = e => \{ if \(!dirtyRef\.current[\s\S]*?e\.returnValue = ''; \};/)[0];
  const warn = Function('dirtyRef', 'timelineFormatRef', 'deliveryNameRef', 'clipDraftRef', `${source}; return warn;`)({ current: false }, timelineFormatRef, deliveryNameRef, { current: null });
  const check = expected => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } }; warn(event);
    assert.equal(event.prevented, expected); assert.equal(event.returnValue, expected ? '' : undefined);
  };
  check(false);
  assert.equal(f.controller.choose('landscape_720'), true); check(true);
  f.controller.discardDraft(); check(false);
  assert.equal(delivery.choose('First delivery', context().scope), true); check(true);
  assert.equal(delivery.discardDraft(), true); check(false);
  assert.equal(f.controller.choose('square_720'), true); assert.equal(delivery.choose('Retained delivery', context().scope), true); check(true);
  const replacementFormat = fixture(); await replacementFormat.ready(); const replacementDelivery = deliveryNameController();
  timelineFormatRef.current = replacementFormat; deliveryNameRef.current = { controller: replacementDelivery };
  assert.equal(f.controller.hasUnsaved(), true); assert.equal(delivery.hasUnsaved(), true); check(false);
  assert.equal(replacementDelivery.choose('Current delivery', context().scope), true); check(true);
  assert.equal(replacementDelivery.discardDraft(), true); check(false);
  assert.equal(replacementFormat.controller.choose('landscape_720'), true); check(true);
  replacementFormat.controller.discardDraft(); check(false);
  assert.equal(f.submits.length, 0); assert.equal(replacementFormat.submits.length, 0);
});

test('actual hook keeps the project draft across visibility and polling without creating a mutation', async () => {
  const slots = [], reads = [], submits = [];
  let cursor = 0, effects = [], props = { ...context(), visible: false, refreshKey: 0 };
  const react = {
    useRef(value) { return slots[cursor++] ||= { current: value }; },
    useState(value) { const i = cursor++; slots[i] ||= { value }; return [slots[i].value, next => { slots[i].value = next; }]; },
    useLayoutEffect(callback, dependencies) { const i = cursor++, old = slots[i]; if (old && dependencies.every((value, index) => Object.is(value, old.dependencies[index]))) return; slots[i] = { dependencies, callback, cleanup: old?.cleanup }; effects.push(i); },
  };
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(read('use-timeline-format.js'), { loader: 'js', format: 'cjs' }).code)(module, module.exports, name => name === 'react' ? react : format);
  function render(patch = {}) {
    props = { ...props, ...patch }; cursor = 0; effects = [];
    const value = module.exports.useTimelineFormat({ ...props, getContext: () => props,
      read: async input => { reads.push(input); return metadata(); }, submit: async intent => { submits.push(intent); }, createRequestId: () => 'format-hook-request' });
    for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); }
    return value;
  }
  let value = render(); assert.equal(reads.length, 0);
  value = render({ visible: true }); await tick(); value = render(); assert.equal(value.state.saved.presetId, 'portrait_720');
  value.controller.choose('landscape_720'); value = render({ visible: false });
  assert.equal(value.state.draftPresetId, 'landscape_720'); assert.equal(value.state.dirty, true);
  const count = reads.length; value = render({ refreshKey: 1 }); await tick(); assert.equal(reads.length, count);
  value = render({ visible: true }); await tick(); value = render(); assert.equal(value.state.draftPresetId, 'landscape_720');
  assert.equal(value.state.dirty, true); assert.equal(submits.length, 0);
  for (const slot of slots) slot.cleanup?.(); assert.equal(value.controller.getState().saved, null);
});
