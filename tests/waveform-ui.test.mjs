import { i18nTestModule } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as waveform from '../apps/web/src/waveform-state.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import * as geometry from '../apps/web/src/timeline-view-geometry.ts';
import * as removalState from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';
import { WAVEFORM_ALGORITHM } from '../packages/contracts/src/waveforms.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const otherProject = '22222222-2222-4222-8222-222222222222';
const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idFor = number => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
const clip = (patch = {}) => ({ id: 'clip-one', trackId: 'audio', assetId, startFrame: 0, sourceInFrame: 0, durationFrames: 300, gain: 1, ...patch });
const asset = (patch = {}) => ({ id: assetId, projectId, mimeType: 'audio/wav', duration: 10, hasAudio: true, ...patch });
const timeline = (clips = [clip()], patch = {}) => ({ projectId, revision: 1, fps: 30, durationFrames: 300, tracks: [{ id: 'audio', kind: 'audio', name: 'Audio', orderIndex: 0 }], clips, ...patch });
const range = (patch = {}) => waveform.waveformWindow(clip(patch), 2, 0, 300);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function response(input, status, extra = {}) {
  return { projectId: input.projectId, assetId: input.assetId, algorithm: WAVEFORM_ALGORITHM, binsPerSecond: 100, status, ...(status === 'ready' ? { attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', duration: 10, sourceFrames: 300, decodedSampleFrames: 480000, clipped: false } : {}), ...(status === 'ready' && input.points ? { sourceStartFrame: input.sourceStartFrame, sourceEndFrame: input.sourceEndFrame, peaks: [0, 0.5, 1].slice(0, input.points) } : {}), ...extra };
}
function scheduler() {
  const calls = [], timers = new Map(), notices = [];
  let time = 0, timerId = 0;
  const controller = waveform.createWaveformController({ api(operation, input) { const pending = deferred(); calls.push({ operation, input, ...pending }); return pending.promise; }, now: () => time, setTimer(fn, delay) { timers.set(++timerId, { fn, at: time + delay }); return timerId; }, clearTimer: id => timers.delete(id), onChange: value => notices.push(value) });
  return { controller, calls, notices, timers,
    view(windows = [range()], patch = {}) { controller.setView({ projectId, active: true, windows, ...patch }); },
    async answer(status, extra, index = calls.length - 1) { const call = calls[index]; assert.ok(call, 'A request is pending'); call.resolve(response(call.input, status, extra)); await flush(); },
    async fail(index = calls.length - 1) { calls[index].reject(new Error('Network')); await flush(); },
    async advance(ms) { time += ms; const pending = [...timers.values()].filter(value => value.at <= time); for (const [id, value] of timers) if (value.at <= time) timers.delete(id); for (const value of pending) value.fn(); await flush(); },
  };
}

test('source in, trim, scroll, fractional edges and zoom map to exact 30fps source bounds', () => {
  const current = clip({ startFrame: 120, sourceInFrame: 300, durationFrames: 180 });
  assert.equal(waveform.waveformWindow(current, 2, 0, 120), null);
  assert.equal(waveform.waveformWindow(current, 2, 300, 400), null);
  const view = waveform.waveformWindow(current, 2, 150.25, 200.75);
  assert.deepEqual({ start: view.sourceStartFrame, end: view.sourceEndFrame, left: view.left, width: view.width, points: view.points }, { start: 330, end: 381, left: 60, width: 102, points: 102 });
  const zoom = waveform.waveformWindow(current, 6, 150.25, 200.75);
  assert.equal(zoom.sourceStartFrame, 330); assert.equal(zoom.sourceEndFrame, 381); assert.equal(zoom.left, 180); assert.equal(zoom.width, 306);
  const trimmed = waveform.waveformWindow({ ...current, durationFrames: 45 }, 6, 0, 1000);
  assert.equal(trimmed.sourceEndFrame, 345); assert.equal(trimmed.width, 270);
  assert.equal(waveform.waveformWindow(clip({ durationFrames: 18000 }), 220 / 30, 0, 18000).points, 2048);
});

test('visible candidates require a confirmed audio stream and visible intersecting timeline clips', () => {
  const assets = [asset(), asset({ id: idFor(2), hasAudio: false }), asset({ id: idFor(3), hasAudio: undefined }), asset({ id: idFor(4), mimeType: 'image/png' }), asset({ id: idFor(5), projectId: otherProject }), asset({ id: idFor(6), duration: 601 }), asset({ id: idFor(7) })];
  const clips = assets.map((source, i) => clip({ id: `clip-${i}`, assetId: source.id }));
  clips.push(clip({ id: 'hidden-track', trackId: 'hidden' }), clip({ id: 'offscreen', startFrame: 500 }));
  const actual = waveform.visibleWaveformWindows({ timeline: timeline(clips), assets: assets.slice(0, 6), pixelsPerFrame: 2, leftFrame: 0, rightFrame: 100, visibleTrackIds: new Set(['audio']) });
  assert.deepEqual(actual.map(value => value.clipId), ['clip-0', 'clip-5']);
  assert.equal(actual[1].unsupported, true);
  assert.equal(waveform.supportsWaveform(asset({ mimeType: 'video/mp4' })), true);
  assert.equal(waveform.supportsWaveform(asset({ hasAudio: 'true' })), false);
});

test('raw amplitude stays fixed full scale; null decoder coverage is a geometry-preserving gap', () => {
  assert.equal(waveform.waveformPath([0.25, null, 0.5]), 'M0.5,7.5v5M2.5,5v10');
  assert.equal(waveform.waveformPath([0, 1]), 'M0.5,10v0M1.5,0v20');
  assert.equal((waveform.waveformPath(Array(5000).fill(1)).match(/M/g) || []).length, 2048);
});

test('decoder-tail cropping preserves fixed source coordinates and never stretches the requested bins', () => {
  const full = waveform.waveformWindow(clip({ durationFrames: 30 }), 10, 0, 30);
  assert.equal(waveform.waveformCoverageWidth(full, 44650), 44650 / 48000 * 300);
  const afterCoverage = waveform.waveformWindow(clip({ sourceInFrame: 28, durationFrames: 1 }), 10, 0, 1);
  assert.equal(waveform.waveformCoverageWidth(afterCoverage, 44650), 0);
  const partial = waveform.waveformWindow(clip({ sourceInFrame: 27, durationFrames: 2 }), 10, 0, 2);
  assert.ok(Math.abs(waveform.waveformCoverageWidth(partial, 44650) - 9.0625) < 1e-9);
  assert.equal(waveform.waveformCoverageWidth(full, undefined), 0);
});

test('initial view and recreated session stay off without any status read or decode', async () => {
  for (let i = 0; i < 2; i++) { const h = scheduler(); h.view(); await flush(); assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); h.controller.disconnect(); }
});

test('opt-in performs read-only discovery, one request, bounded polling, then keeps source peaks', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush();
  assert.equal(h.calls[0].operation, 'asset.waveform.get');
  await h.answer('missing'); assert.equal(h.calls[1].operation, 'asset.waveform.request'); assert.equal(h.calls[1].input.retry, false);
  await h.answer('queued'); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 1);
  await h.advance(800); assert.equal(h.calls[2].operation, 'asset.waveform.get');
  await h.answer('ready', { clipped: true }); assert.deepEqual(h.controller.snapshot().entries.get(range().key).peaks, [0, 0.5, 1]); assert.equal(h.controller.snapshot().entries.get(range().key).clipped, true);
  await h.advance(10000); assert.equal(h.calls.length, 3); assert.equal(h.timers.size, 0);
});

test('client holds one transport request and at most four pending with a 32-entry visible cache', async () => {
  const h = scheduler(), windows = Array.from({ length: 100 }, (_, i) => range({ assetId: idFor(i), id: `clip-${i}` }));
  h.view(windows); h.controller.setEnabled(true); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.controller.snapshot().entries.size, 32);
  assert.ok(h.notices.every(value => value.pending <= 4));
  for (let i = 0; i < 32; i++) await h.answer('ready');
  assert.equal(h.calls.length, 32); assert.equal(h.controller.snapshot().inFlight, false);
  h.view(windows.slice(40, 80)); await flush(); assert.equal(h.calls.length, 33); assert.equal(h.controller.snapshot().entries.size, 32);
  h.controller.disconnect();
});

test('request receipts stay bounded across cache eviction and cannot be reset by toggling off/on', async () => {
  const h = scheduler();
  for (let i = 0; i < 64; i++) {
    h.view([range({ assetId: idFor(i), id: `clip-${i}` })]);
    if (i === 0) h.controller.setEnabled(true);
    await flush(); await h.answer('missing'); await h.answer('ready'); await h.answer('ready');
  }
  assert.equal(h.controller.snapshot().autoLimitReached, true);
  assert.equal(h.controller.snapshot().entries.size, 32);
  assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 64);
  h.view([range({ assetId: idFor(65), id: 'new' })]); await flush(); await h.answer('missing');
  h.controller.setEnabled(false); h.controller.setEnabled(true); await flush();
  assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 64);
  assert.equal(h.controller.snapshot().retryable, true);
  h.controller.retryVisible(); await flush(); await h.answer('missing');
  assert.equal(h.calls.at(-1).operation, 'asset.waveform.request'); assert.equal(h.calls.at(-1).input.retry, true);
  await h.answer('ready'); await h.answer('ready');
  h.view([range({ assetId: idFor(0), id: 'old-evicted' })]); await flush(); await h.answer('missing');
  assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 65);
  assert.equal(h.controller.snapshot().retryable, true); h.controller.disconnect();
});

test('two visible trims share one accepted decode and independently fetch their source windows', async () => {
  const h = scheduler();
  const first = range({ durationFrames: 120 });
  const second = range({ id: 'trim-two', sourceInFrame: 120, durationFrames: 180 });
  h.view([first, second]); h.controller.setEnabled(true); await flush(); await h.answer('missing'); await h.answer('queued');
  assert.equal(h.calls[2].input.sourceStartFrame, 120); await h.answer('running');
  await h.advance(800); await h.answer('ready'); await h.answer('ready');
  assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 1);
  assert.equal(h.controller.snapshot().entries.get(first.key).status, 'ready'); assert.equal(h.controller.snapshot().entries.get(second.key).status, 'ready'); h.controller.disconnect();
});

test('long source shows explicit unsupported copy without dispatching an out-of-contract window', async () => {
  const h = scheduler(); const item = { ...range({ sourceInFrame: 20000 }), unsupported: true };
  h.view([item]); h.controller.setEnabled(true); await flush();
  assert.equal(h.calls.length, 0); assert.equal(waveform.waveformStatusText(h.controller.snapshot().entries.get(item.key)), '超过10分钟暂不支持波形');
});

test('hide clears queue and polling; a late accepted local request cannot publish or launch more work', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); await h.answer('missing');
  h.view([], { active: false }); await h.answer('queued');
  assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0); assert.equal(h.controller.snapshot().pending, 0);
  h.view(); await flush(); assert.equal(h.calls[2].operation, 'asset.waveform.get');
  await h.answer('missing'); assert.equal(h.calls.length, 3); assert.equal(h.controller.snapshot().retryable, true);
});

test('synchronous hide before transport dispatch cannot start prepared work', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); h.view([], { active: false }); await flush();
  assert.equal(h.calls.length, 0);
});

test('project switch defaults off and fences both late responses and an old in-flight lock', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush();
  h.view([range()], { projectId: otherProject });
  assert.equal(h.controller.snapshot().enabled, false); assert.equal(h.controller.snapshot().entries.size, 0);
  h.controller.setEnabled(true); await flush(); assert.equal(h.calls.length, 1);
  await h.answer('ready', undefined, 0); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].input.projectId, otherProject);
  assert.equal(h.controller.snapshot().entries.get(range().key).status, 'loading');
  await h.answer('ready'); assert.equal(h.controller.snapshot().projectId, otherProject);
});

test('offscreen scrolling schedules only the new visible window and fences an old viewport response', async () => {
  const h = scheduler(); const first = range(), next = range({ assetId: idFor(2), id: 'new' });
  h.view([first]); h.controller.setEnabled(true); await flush(); h.view([next]);
  await h.answer('missing'); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].input.assetId, next.assetId);
  await h.answer('ready'); assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 0);
});

test('an unacknowledged request discovers once and requires explicit retry before another POST', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); await h.answer('missing'); await h.fail();
  assert.equal(h.calls[2].operation, 'asset.waveform.get'); await h.answer('missing');
  await h.advance(30000); assert.equal(h.calls.length, 3); assert.equal(h.controller.snapshot().retryable, true);
  h.controller.retryVisible(); await flush(); assert.equal(h.calls[3].operation, 'asset.waveform.get'); await h.answer('missing');
  assert.equal(h.calls[4].operation, 'asset.waveform.request'); assert.equal(h.calls[4].input.retry, true);
  await h.answer('running'); h.controller.disconnect();
});

test('explicit retry first discovers accepted running work and does not duplicate its request', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); await h.fail();
  assert.equal(h.controller.snapshot().retryable, true); h.controller.retryVisible(); await flush(); await h.answer('running');
  assert.equal(h.calls.filter(call => call.operation.endsWith('request')).length, 0); h.controller.disconnect();
});

test('read failures, interrupted and unsupported states do not silently retry', async () => {
  for (const status of ['error', 'interrupted', 'unsupported']) {
    const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); await h.answer(status, { reason: { code: 'SOURCE_UNSUPPORTED', message: '此素材暂不支持波形' } }); await h.advance(30000);
    assert.equal(h.calls.length, 1); assert.equal(h.controller.snapshot().entries.get(range().key).status, status); assert.equal(h.controller.snapshot().retryable, status !== 'unsupported');
  }
});

test('malformed, oversized, mismatched and foreign-project ready responses cannot drive SVG', async () => {
  for (const extra of [{ peaks: Array(2049).fill(1) }, { peaks: [1.5] }, { projectId: otherProject }, { sourceStartFrame: 1 }, { sourceEndFrame: 299 }, { sourceEndFrame: 301, sourceFrames: 301 }, { algorithm: 'unknown' }, { peaks: [] }, { decodedSampleFrames: undefined }, { decodedSampleFrames: -1 }]) {
    const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); await h.answer('ready', extra);
    const entry = h.controller.snapshot().entries.get(range().key); assert.equal(entry.status, 'error', JSON.stringify(extra).slice(0, 80)); assert.equal(entry.peaks, undefined); assert.equal(h.calls.length, 1);
  }
});

test('unmount ignores late results and retained toggle/retry handlers cannot send', async () => {
  const h = scheduler(); h.view(); h.controller.setEnabled(true); await flush(); h.controller.disconnect(); const count = h.notices.length;
  await h.answer('missing'); h.controller.setEnabled(true); h.controller.retryVisible(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.notices.length, count); assert.equal(h.timers.size, 0);
});

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const content = tree => Array.isArray(tree) ? tree.map(content).join('') : tree && typeof tree === 'object' ? content(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const equalDeps = (a, b) => Array.isArray(a) && a.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function componentHarness({ hook = false, waveformState } = {}) {
  const slots = [], modules = new Map(), docListeners = new Map(), scrollListeners = new Map(), requests = [], selections = [];
  let cursor = 0, effects = [], needsRender = false, output;
  const document = { visibilityState: 'visible', addEventListener: (name, callback) => docListeners.set(name, callback), removeEventListener: name => docListeners.delete(name) };
  const element = { scrollLeft: 0, scrollTop: 0, clientWidth: 460, clientHeight: 140, getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => [{ dataset: { waveformTrack: 'audio' }, getBoundingClientRect: () => ({ top: 126, bottom: 181 }) }, { dataset: { waveformTrack: 'offscreen' }, getBoundingClientRect: () => ({ top: 300, bottom: 355 }) }], addEventListener: (name, cb) => scrollListeners.set(name, cb), removeEventListener: name => scrollListeners.delete(name) };
  const react = {
    createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : ({ type, props: { ...props, children } }),
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; needsRender = true; } }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useLayoutEffect(callback, deps) { const index = cursor++, prior = slots[index]; if (prior && equalDeps(deps, prior.deps)) return; slots[index] = { deps, callback, cleanup: prior?.cleanup }; effects.push(index); },
  };
  react.useEffect = react.useLayoutEffect; react.default = react;
  class ResizeObserver { observe() {} disconnect() {} }
  const primitive = new Proxy({}, { get: (_, key) => String(key) });
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    Function('require', 'module', 'exports', 'document', 'ResizeObserver', 'window', transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'jsx', format: 'cjs' }).code)(id => {
      if (id === 'react') return react;
      if (id === './i18n/I18nProvider.tsx') return i18nTestModule();
      if (id === './UiPreferencesProvider.tsx') return {useUiPreferences: () => ({preferences:DEFAULT_UI_PREFERENCES})};
      if (id === './timeline-view-geometry.ts') return geometry;
      if (id === './timeline-removal.ts') return removalState;
      if (id === './ClipRemovalControls.tsx') return load('ClipRemovalControls.tsx');
      if (id === './TimelineToolbar.tsx') return load('TimelineToolbar.tsx');
      if (id === './workbench-modal-state.ts') return {hasOpenWorkbenchModal};
      if (id === './waveform-state.ts') return waveform;
      if (id === './api.ts') return { rpc: (operation, input) => { const pending = deferred(); requests.push({ operation, input, ...pending }); return pending.promise; }, assetUrl: () => '' };
      if (id === './use-timeline-waveforms.ts') return hook ? load('use-timeline-waveforms.ts') : { useTimelineWaveforms: () => waveformState };
      if (id === './TimelineWaveform.tsx') return load('TimelineWaveform.tsx');
      if (id === './timeline-keyboard.ts') return { rulerFrameForKey: () => null };
      if (id === './timeline-snapping.ts') return { timelineDropPreview: () => null };
      if (id.startsWith('@mioon/ui/')) return primitive;
      return { default: 'Control', __esModule: true };
    }, module, module.exports, document, ResizeObserver, { addEventListener() {}, removeEventListener() {} });
    modules.set(file, module.exports); return module.exports;
  }
  let props = hook ? { timeline: timeline(), assets: [asset()], viewport: { current: element }, pixelsPerFrame: 2, active: true } : { timeline: timeline(), assets: [asset()], playhead: 0, visible: true, collapsed: false, onSelectClip: id => selections.push(id) };
  const component = hook ? load('use-timeline-waveforms.ts').useTimelineWaveforms : load('Timeline.tsx').default;
  const h = { requests, selections, element,
    render(next = {}) { props = { ...props, ...next }; let attempts = 0; do { cursor = 0; effects = []; needsRender = false; output = component(props); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].callback(); } assert.ok(++attempts < 20, 'Hook effects stabilize'); } while (needsRender); return output; },
    get value() { return output; },
    find: id => nodes(output).find(node => node.props?.['data-testid'] === id),
    all: () => nodes(output),
    hideDocument() { document.visibilityState = 'hidden'; docListeners.get('visibilitychange')?.(); h.render(); },
    scroll(left) { element.scrollLeft = left; scrollListeners.get('scroll')?.(); h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
  h.render(); return h;
}

test('actual hook measures sticky labels, excludes vertically hidden tracks, and stops on tab hiding', async () => {
  const h = componentHarness({ hook: true });
  // 460 layout pixels minus the real 168px sticky track label leave 146 frames
  // at 2px/frame; the vertically offscreen track must still be excluded.
  assert.deepEqual(h.value.windows.map(window => window.clipId), ['clip-one']);
  assert.equal(h.value.enabled, false); assert.equal(h.value.windows[0].sourceEndFrame, 146); assert.equal(h.requests.length, 0);
  h.value.setEnabled(true); h.render(); await flush(); assert.equal(h.requests.length, 1);
  h.hideDocument(); h.requests[0].resolve(response(h.requests[0].input, 'missing')); await flush(); h.render();
  assert.equal(h.requests.length, 1); assert.equal(h.value.active, false); h.unmount();
});

test('actual hook scroll updates source bounds; collapse, mode hide and project switch are fenced', async () => {
  for (const visibility of [false]) {
    const h = componentHarness({ hook: true }); h.scroll(120); assert.equal(h.value.windows[0].sourceStartFrame, 60); assert.equal(h.value.windows[0].sourceEndFrame, 206);
    h.value.setEnabled(true); h.render(); await flush(); h.render({ active: visibility });
    h.requests[0].resolve(response(h.requests[0].input, 'missing')); await flush(); assert.equal(h.requests.length, 1);
    h.render({ active: true, timeline: timeline([clip()], { projectId: otherProject }), assets: [asset({ projectId: otherProject })] });
    assert.equal(h.value.enabled, false); await flush(); assert.equal(h.requests.length, 1); h.unmount();
  }
});

test('actual Timeline renders decorative bounded SVG inside existing clip button without changing its click/drag behavior', () => {
  const currentRange = range();
  const state = { enabled: true, windows: [currentRange], entries: new Map([[currentRange.key, { ...currentRange, status: 'ready', peaks: [0.25, null, 0.5], clipped: true, resultEndFrame: 300, decodedSampleFrames: 480000 }]]), retryable: false, setEnabled() {}, retry() {} };
  const h = componentHarness({ waveformState: state });
  const button = h.find('timeline-clip-clip-one');
  assert.equal(nodes(button).filter(node => node.type === 'Button').length, 1);
  const overlay = h.find('timeline-waveform-clip-one'); assert.equal(overlay.props['aria-hidden'], 'true'); assert.equal(overlay.props.style.left, 0); assert.equal(overlay.props.style.width, 600);
  assert.equal(nodes(overlay).find(node => node.type === 'path').props.d, 'M0.5,7.5v5M2.5,5v10');
  let stopped = false; button.props.onClick({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true); assert.deepEqual(h.selections, ['clip-one']); assert.equal(button.props.draggable, true);
  assert.equal(content(h.find('timeline-waveform-clipped')), '满刻度峰值'); assert.match(h.find('timeline-waveform-clipped').props.title, /原始源音轨.*不反映片段音量/);
  assert.equal(h.find('timeline-waveform-toggle').props['aria-pressed'], true); assert.match(content(h.find('timeline-waveform-status')), /原始源音轨.*固定满刻度/);
  h.render({ busy: true }); assert.equal(h.find('timeline-clip-clip-one').props.draggable, false);
  const source = readFileSync(new URL('../apps/web/src/Timeline.tsx', import.meta.url), 'utf8');
  assert.match(source, /session\.projectId === timeline\.projectId && session\.revision === timeline\.revision/);
  assert.match(source, /if \(!allowed \|\| !payloadMatches \|\| value\.unchanged\) return/);
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8'); assert.match(css, /\.timeline-waveform\{[^}]*pointer-events:none/); h.unmount();
});

test('actual overlay clips the decoder tail while the inner SVG retains full requested time spacing', () => {
  const currentRange = waveform.waveformWindow(clip({ durationFrames: 30 }), 10, 0, 30);
  const state = { enabled: true, windows: [currentRange], entries: new Map([[currentRange.key, { ...currentRange, status: 'ready', peaks: [0.25, 0.5, 1], resultEndFrame: 30, decodedSampleFrames: 44650 }]]), retryable: false, setEnabled() {}, retry() {} };
  const h = componentHarness({ waveformState: state });
  const overlay = h.find('timeline-waveform-clip-one');
  assert.equal(overlay.props.style.width, 44650 / 48000 * 300);
  assert.equal(nodes(overlay).find(node => node.type === 'svg').props.style.width, 300);
  h.unmount();
});
