import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { buildAudioPreviewPlan } from '../packages/contracts/src/timeline-audio-preview.ts';
import { workspaceOriginScope, pinNewWorkspaceIntent } from '../apps/web/src/workspace-origin.js';
import { createTimelineAudioPreviewController, timelineAudioPreviewSourceIdentity, timelineAudioPreviewPosition, seekTimelineAudioPreview } from '../apps/web/src/use-timeline-audio-preview.ts';
import * as i18n from '../packages/i18n/src/index.ts';

const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../apps/web/src/Preview.jsx', import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const start = app.indexOf('  function soundAuditionContext()');
const hookEnd = app.indexOf('  function readTimelineLoudnessRecoveryScope()', start);
const positionStart = app.indexOf('  const effectivePlayhead =', hookEnd);
const end = app.indexOf('  function exportSamplePeakContext()', positionStart);
assert.ok(start >= 0 && hookEnd > start && positionStart > hookEnd && end > positionStart,
  'Actual App sound hook and explicit-position blocks must be present, separately from loudness apply');
// Exercise both real audition blocks without constructing the independent apply
// controller. Its identity/intent lifecycle has its own actual-App contract tests.
const ownerStart = app.indexOf('  function beforeTimelineAudioPlay()'), ownerEnd = app.indexOf('  const registerExportPreviewPause', ownerStart);
assert.ok(ownerStart >= 0 && ownerEnd > ownerStart);
const block = app.slice(ownerStart, ownerEnd) + app.slice(start, hookEnd) + app.slice(positionStart, end);
assert.match(block, /const audioPreview = useTimelineAudioPreview/);
assert.match(block, /const effectivePlayhead = timelineAudioPreviewPosition/);
assert.match(block, /const seekTimelineSound = frame => seekTimelineAudioPreview/);
assert.doesNotMatch(block, /useTimelineLoudnessApply|readTimelineLoudnessRecoveryScope/);

function harness() {
  const timeline = { id: id(2), projectId: id(1), revision: 1, fps: 30, durationFrames: 900,
    tracks: [{ id: id(3), kind: 'audio', orderIndex: 0, muted: true, hidden: false }],
    clips: [{ id: id(5), trackId: id(3), assetId: id(4), startFrame: 0, durationFrames: 900, sourceInFrame: 0, gain: 1 }] };
  const asset = { id: id(4), projectId: id(1), sha256: 'a'.repeat(64), sizeBytes: 1024, mimeType: 'audio/wav', duration: 30, hasAudio: true };
  const calls = { rpc: [], positions: [], contexts: [], transports: [], order: [] };
  let controller, latestOptions;
  const env = {
    nativeAudioAdmission: null,
    workspaceOriginScope, pinNewWorkspaceIntent, timelineAudioPreviewSourceIdentity, timelineAudioPreviewPosition, seekTimelineAudioPreview,
    workspaceRef: { current: { restored: false } }, currentProject: { current: id(1) }, projectEpoch: { current: 1 }, navigationEpoch: { current: 0 },
    dataRef: { current: { project: { id: id(1) }, timeline, assets: [asset] } },
    viewRef: { current: { activeMode: 'editing', editing: { previewKind: 'timeline', selectedClipId: null, quickAssetId: null, playhead: 30 } } },
    projectSessionReady: () => true, workbenchReady: true, online: true, auth: true, loading: false,
    workspaceMode: 'editing', previewKind: 'timeline', previewAsset: null, comparisonIdRef: { current: null }, comparisonPreviewPause: { current: null }, clipDirty: false, subtitleDirty: false, formatDirty: false,
    clipDraftRef: { current: null },
    canvasVisible: true, panelVisible: name => name === 'canvas' && env.canvasVisible,
    exportPreviewPause: { current: () => calls.order.push('export-pause') }, nativePreviewPause: { current: () => calls.order.push('native-pause') }, playhead: 30,
    setPlayhead(frame) { calls.positions.push(frame); env.viewRef.current.editing.playhead = frame; }, setAuth(value) { env.auth = value; },
    async rpc(operation, input, options) {
      calls.rpc.push({ operation, input, options });
      assert.equal(operation, 'timeline.audioPreview.plan');
      return buildAudioPreviewPlan(input, { timeline: env.dataRef.current.timeline, assets: env.dataRef.current.assets.filter(value => value.id === id(4)) }, text => createHash('sha256').update(text).digest('hex'));
    },
    useTimelineAudioPreview(options) {
      latestOptions = options;
      if (!controller) controller = createTimelineAudioPreviewController({
        readPlan: (input, invocation) => latestOptions.readPlan(input, invocation), getContext: () => latestOptions.getContext(),
        getInvocation: () => latestOptions.getInvocation(), onExplicitPosition: frame => latestOptions.onExplicitPosition(frame),
        onBeforePlay: () => latestOptions.onBeforePlay(), onUnauthorized: () => latestOptions.onUnauthorized(),
        createContext() { const context = { sampleRate: 48000, state: 'running', closeCalls: 0, createBuffer() { assert.fail('Muted fixture has no source allocation'); },
          close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); } }; calls.contexts.push(context); return context; },
        createTransport(options) {
          let disposed = false, state = { status: 'ready', frame: options.plan.range.startFrame, sample: options.plan.range.startSample, reason: null };
          const emit = patch => { state = { ...state, ...patch }; options.onChange(state); };
          const transport = { play: async () => { calls.order.push('sound-play'); emit({ status: 'playing' }); return true; },
            pause: () => emit({ status: 'paused' }), seek: frame => { emit({ frame, sample: frame * 1600 }); return true; }, stop() {},
            async dispose() { disposed = true; await options.context.close(); }, getState: () => state,
            paint: frame => emit({ frame, sample: frame * 1600 }), get disposed() { return disposed; } };
          calls.transports.push(transport); return transport;
        },
      });
      controller.setContext(options.context);
      return { state: controller.getState(), controller };
    },
  };
  const render = () => {
    env.playhead = env.viewRef.current.editing.playhead;
    env.workspaceMode = env.viewRef.current.activeMode; env.previewKind = env.viewRef.current.editing.previewKind;
    return Function(...Object.keys(env), `${block};return {audioPreview,soundAuditionContext,effectivePlayhead,seekTimelineSound};`)(...Object.values(env));
  };
  const initial = render();
  return { env, calls, render, initial, get controller() { return controller; }, get options() { return latestOptions; } };
}

test('actual App hook reads the current saved snapshot, supplies exact RPC options, and never prepares on render', async () => {
  const f = harness();
  assert.equal(f.calls.rpc.length, 0); assert.equal(f.calls.contexts.length, 0);
  const context = f.initial.soundAuditionContext();
  assert.equal(context.scope, `${id(1)}:1:normal`); assert.equal(context.revision, 1); assert.equal(context.hasUnsavedDrafts, false);
  assert.equal(context.sourceIdentity, timelineAudioPreviewSourceIdentity(f.env.dataRef.current.timeline, f.env.dataRef.current.assets));
  assert.equal(await f.controller.prepare(30), true);
  assert.deepEqual(f.calls.rpc[0].input, { projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 30 });
  assert.deepEqual(Object.keys(f.calls.rpc[0].options), ['signal']);
  f.env.dataRef.current = { ...f.env.dataRef.current, timeline: structuredClone(f.env.dataRef.current.timeline), assets: [{ ...f.env.dataRef.current.assets[0] }, { id: id(99), sha256: 'b'.repeat(64) }] };
  f.render(); assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.contexts[0].closeCalls, 0);
  f.env.clipDirty = true; f.env.subtitleDirty = true; f.env.formatDirty = true; f.render();
  assert.equal(f.controller.getState().hasUnsavedDrafts, true); assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.rpc.length, 1);
  f.env.dataRef.current.assets[0] = { ...f.env.dataRef.current.assets[0], sha256: 'c'.repeat(64) };
  f.render(); assert.equal(f.calls.transports[0].disposed, true); assert.equal(f.controller.getState().plan, null); assert.equal(f.calls.rpc.length, 1);
});

test('an unapplied clip recovery candidate warns even with clean inputs without entering the saved mix or changing its owner', async () => {
  const f = harness(), saved = structuredClone(f.env.dataRef.current.timeline), before = f.initial.soundAuditionContext();
  const candidate = {raw: {gain: '2', sourceInFrame: '99'}, baseRevision: 1, clipId: id(5)}, original = structuredClone(candidate);
  const draft = {candidate}; let writes = 0;
  f.env.clipDraftRef.current = {getState: () => draft, save() {writes++;}, restore() {writes++;}, discard() {writes++;}};
  const current = f.render();
  assert.equal(f.env.clipDirty || f.env.subtitleDirty || f.env.formatDirty, false);
  assert.equal(current.soundAuditionContext().hasUnsavedDrafts, true);
  const binding = ({hasUnsavedDrafts: ignored, ...value}) => {void ignored; return value;};
  assert.deepEqual(binding(current.soundAuditionContext()), binding(before));
  assert.equal(f.calls.rpc.length, 0); assert.equal(f.calls.contexts.length, 0);
  await f.controller.prepare(30); await f.controller.play();
  assert.deepEqual(f.calls.rpc[0].input, {projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 30});
  assert.deepEqual(f.env.dataRef.current.timeline, saved); assert.deepEqual(candidate, original); assert.equal(writes, 0);
  draft.candidate = null; f.render();
  assert.equal(f.controller.getState().hasUnsavedDrafts, false); assert.equal(f.controller.getState().phase, 'playing');
  assert.equal(f.calls.transports[0].disposed, false); assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.rpc.length, 1);
  assert.deepEqual(f.calls.positions, []); assert.deepEqual(f.calls.order, ['export-pause', 'native-pause', 'sound-play']);
  f.controller.dispose();
});

for (const [name, change] of Object.entries({ hidden: f => { f.env.canvasVisible = false; }, sourceTab: f => { f.env.viewRef.current.editing.previewKind = 'source'; },
  canvasMode: f => { f.env.viewRef.current.activeMode = 'canvas'; }, modal: f => { f.env.previewAsset = { id: id(4) }; }, comparison: f => { f.env.comparisonIdRef.current = id(9); },
  clipSwitch: f => { f.env.viewRef.current.editing.selectedClipId = id(5); }, sourceSwitch: f => { f.env.viewRef.current.editing.quickAssetId = id(4); },
  logout: f => { f.env.auth = false; }, disconnected: f => { f.env.online = false; }, restored: f => { f.env.workspaceRef.current = { restored: true, workspaceOrigin: id(8) }; },
  projectReopen: f => { f.env.projectEpoch.current++; }, revision: f => { f.env.dataRef.current.timeline = { ...f.env.dataRef.current.timeline, revision: 2 }; } })) {
  test(`actual App ${name} signal retires sound and never prepares/resumes from a rerender`, async () => {
    const f = harness(); await f.controller.prepare(30); await f.controller.play(); change(f); f.render();
    assert.equal(f.controller.getState().plan, null); assert.equal(f.calls.transports[0].disposed, true); assert.equal(f.calls.contexts[0].closeCalls, 1);
    assert.equal(f.calls.rpc.length, 1); assert.deepEqual(f.calls.positions, []); await tick(); f.render(); assert.equal(f.calls.rpc.length, 1);
  });
}

test('unaccepted project data cannot start audition through actual App readiness guards', async () => {
  for (const patch of [{ projectSessionReady: () => false, workbenchReady: false }, { loading: true }, { auth: false }]) {
    const f = harness(); Object.assign(f.env, patch); f.render(); assert.equal(await f.controller.prepare(30), false);
    assert.equal(f.calls.rpc.length, 0); assert.equal(f.calls.contexts.length, 0);
  }
});

test('actual App clock display stays ephemeral while each explicit seek writes the saved view exactly once', async () => {
  const f = harness(); await f.controller.prepare(30); await f.controller.play();
  assert.deepEqual(f.calls.order, ['export-pause', 'native-pause', 'sound-play']);
  f.calls.transports[0].paint(44); f.calls.transports[0].paint(48); const current = f.render();
  assert.equal(current.effectivePlayhead, 48); assert.equal(f.env.viewRef.current.editing.playhead, 30); assert.deepEqual(f.calls.positions, []);
  current.seekTimelineSound(77); assert.deepEqual(f.calls.positions, [77]);
  f.controller.revoke(); await tick(); f.render().seekTimelineSound(88); assert.deepEqual(f.calls.positions, [77, 88]);
  const previewTag = app.slice(app.indexOf('<Preview '), app.indexOf('/>', app.indexOf('<Preview ')) + 2);
  assert.match(previewTag, /playhead=\{playhead\} onSeek=\{setPlayhead\}/); assert.doesNotMatch(previewTag, /effectivePlayhead|seekTimelineSound/);
  const timelineTag = app.slice(app.indexOf('<Timeline staleClips='), app.indexOf('/>', app.indexOf('<Timeline staleClips=')) + 2);
  assert.match(timelineTag, /onSeek=\{seekTimelineSound\} playhead=\{effectivePlayhead\}/);
});

test('actual native-player guard revokes current sound, while stale media can only pause itself', async () => {
  const f = harness(); await f.controller.prepare(30); await f.controller.play(); let observerCalls = 0;
  const valid = { seeking: false, pause() { assert.fail('Current player was not rejected'); } }, stale = { pauseCalls: 0, pause() { this.pauseCalls++; } };
  const env = { onBeforePlay: () => f.calls.order.push('export-pause'), isCurrentMedia: element => element === valid, audioPreview: { controller: f.controller }, activeMedia: { current: { programmaticSeek: 3 } }, captureObserver: { current: () => observerCalls++ } };
  const from = preview.indexOf('  function guardPlayback('), to = preview.indexOf('  function finishSeek(', from);
  const guard = Function(...Object.keys(env), `${preview.slice(from, to)};return guardPlayback;`)(...Object.values(env));
  guard({ currentTarget: stale }); assert.equal(stale.pauseCalls, 1); assert.equal(f.controller.getState().phase, 'playing');
  guard({ currentTarget: valid }); assert.equal(f.controller.getState().plan, null); assert.equal(f.calls.transports[0].disposed, true);
  assert.equal(env.activeMedia.current.programmaticSeek, null); assert.equal(observerCalls, 1); assert.deepEqual(f.calls.positions, []);
  assert.match(preview, /onPlay=\{guardPlayback\} onPlaying=\{guardPlayback\}/);
});

test('actual native pause registration cleanup cannot unregister a newer player owner', () => {
  const from = app.indexOf('  const registerNativePreviewPause ='), to = app.indexOf('\n', from);
  const nativePreviewPause = { current: null };
  const register = Function('useCallback', 'nativePreviewPause', `${app.slice(from, to)};return registerNativePreviewPause;`)(fn => fn, nativePreviewPause);
  const first = () => {}, second = () => {}, dropFirst = register(first), dropSecond = register(second);
  dropFirst(); assert.equal(nativePreviewPause.current, second); dropSecond(); assert.equal(nativePreviewPause.current, null);
});

test('actual TSX callbacks pass their rendered owner once; shared Slider seek remains an explicit action', () => {
  const source = readFileSync(new URL('../apps/web/src/TimelineAudioPreview.tsx', import.meta.url), 'utf8');
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === '@mioon/ui/components/slider') return { Slider: 'Slider' };
    if (name === '../../../packages/i18n/src/index.ts') return i18n;
    if (name === './i18n/I18nProvider.tsx') return {useI18n: () => ({t: (key, params) => i18n.translate('zh-Hans', key, params), renderMessage: value => i18n.renderMessage('zh-Hans', value)})};
    assert.fail(`Unexpected production component dependency: ${name}`);
  });
  const f = harness(), state = { ...f.controller.getState(), phase: 'ready', plan: { range: { startFrame: 30, endFrame: 630 }, sources: [] }, positionFrame: 30 };
  const calls = [], controller = Object.fromEntries(['prepare', 'play', 'pause', 'stop', 'cancel', 'seek'].map(name => [name, (...args) => { calls.push([name, ...args]); return Promise.resolve(); }]));
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
  const elements = flatten(module.exports.default({ audioPreview: { state, controller }, startFrame: 42 })); assert.deepEqual(calls, []);
  for (const name of ['prepare', 'play', 'pause', 'stop']) elements.find(value => value.props?.['data-testid'] === `timeline-audio-preview-${name}`).props.onClick();
  elements.find(value => value.type === 'Slider').props.onValueChange([99]);
  assert.deepEqual(calls, [['prepare', 42, state], ['play', state], ['pause', state], ['stop', state], ['seek', 99, state]]);
  const preparing = { ...state, phase: 'preparing', plan: null };
  flatten(module.exports.default({ audioPreview: { state: preparing, controller }, startFrame: 42 })).find(value => value.props?.['data-testid'] === 'timeline-audio-preview-cancel').props.onClick();
  assert.deepEqual(calls.at(-1), ['cancel', preparing]);
});


test('actual component never substitutes a last-frame prepare for an outside or empty saved range', () => {
  const source = readFileSync(new URL('../apps/web/src/TimelineAudioPreview.tsx', import.meta.url), 'utf8');
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === '@mioon/ui/components/slider') return { Slider: 'Slider' };
    if (name === '../../../packages/i18n/src/index.ts') return i18n;
    if (name === './i18n/I18nProvider.tsx') return {useI18n: () => ({t: (key, params) => i18n.translate('zh-Hans', key, params), renderMessage: value => i18n.renderMessage('zh-Hans', value)})};
    assert.fail(`Unexpected component dependency: ${name}`);
  });
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null ? '' : String(value);
  const f = harness(), calls = [], state = f.controller.getState(), controller = { prepare: (...args) => calls.push(args), play() {}, pause() {}, stop() {}, cancel() {}, seek() {} };
  const render = (current, frame) => flatten(module.exports.default({ audioPreview: { state: current, controller }, startFrame: frame }));
  for (const frame of [900, 1200, 18000, -1, NaN]) {
    const nodes = render(state, frame), button = nodes.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-prepare');
    assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(calls, []);
    const range = nodes.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-range');
    assert.match(text(range), /当前播放头不在已保存时间线内，暂无可准备区间/); assert.doesNotMatch(text(range), /899|NaN/);
  }
  const empty = render({ ...state, durationFrames: 0 }, 0);
  assert.match(text(empty.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-range')), /暂无可试听区间/);
  const prepared = render({ ...state, phase: 'ready', plan: { range: { startFrame: 30, endFrame: 630 }, sources: [] }, positionFrame: 30 }, 1200);
  assert.match(text(prepared.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-range')), /帧 30–630/);
  assert.equal(prepared.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-play').props.disabled, false);
  const valid = render(state, 899), prepare = valid.find(node => node.props?.['data-testid'] === 'timeline-audio-preview-prepare');
  assert.equal(prepare.props.disabled, false); prepare.props.onClick(); assert.deepEqual(calls, [[899, state]]);
});
