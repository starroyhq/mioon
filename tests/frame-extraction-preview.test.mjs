import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as ranges from '../apps/web/src/source-range-state.js';
import { createFrameExtractionController, frameCaptureBusy } from '../apps/web/src/frame-extraction.js';

// Execute Preview and its real capture control with controlled media properties.
// This tests component/event wiring, not browser decoder or native FFmpeg output.
const code = transformSync(readFileSync(new URL('../apps/web/src/Preview.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
function harness() {
  const components = new Map(), elements = new Map(); let active, cursor = 0, layouts = [], effects = [], tree, control, dirty = false, props;
  const h = { visible: true, readyState: 2, duration: 10 };
  const effect = (queue, fn, deps) => { const slots = active, index = cursor++, previous = slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; slots[index] = { deps, cleanup: previous?.cleanup, fn }; queue.push([slots, index]); };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: value => active[cursor++] ||= { current: value },
    useState: value => { const slots = active, index = cursor++; if (!slots[index]) slots[index] = { value: typeof value === 'function' ? value() : value }; return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
    useLayoutEffect: (fn, deps) => effect(layouts, fn, deps), useEffect: (fn, deps) => effect(effects, fn, deps),
  }; react.default = react;
  const module = { exports: {} };
  Function('require', 'module', 'exports', code)(id => id === 'react' ? react : id === './source-range-state.js' ? ranges : id === './api.js' ? { assetUrl: asset => asset?.url || '', statusText: String } : id === './Timeline.jsx' ? { assetKind: asset => asset?.mimeType.split('/')[0], framesLabel: String } : id === './workspace-visibility.jsx' ? { useWorkspaceVisibility: () => h.visible } : id === './Nodes.jsx' ? { disposeMedia: element => { element.pause(); element.removeAttribute('src'); element.load(); } } : id === './icons.jsx' ? { default: 'Icon', __esModule: true } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const renderComponent = (name, component, properties) => { if (!components.has(name)) components.set(name, []); active = components.get(name); cursor = 0; return component(properties); };
  const cleanup = name => { components.get(name)?.forEach(slot => slot.cleanup?.()); components.delete(name); };
  const flush = queue => { for (const [slots, index] of queue) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn(); } };
  h.render = next => {
    props = next; let count = 0;
    do {
      assert.ok(++count < 20, 'component settled'); dirty = false; layouts = []; effects = [];
      tree = renderComponent('Preview', module.exports.default, props);
      for (const node of nodes(tree)) if (node.props?.ref) {
        const key = node.props.key;
        if (!elements.has(key)) elements.set(key, { src: node.props.src, _currentTime: 0, get currentTime() { return this._currentTime; }, set currentTime(value) { this._currentTime = h.quantize ? h.quantize(value) : value; }, readyState: h.readyState, duration: h.duration, paused: true, seeking: false, isConnected: true,
          getAttribute(name) { return name === 'src' ? this.src : null; }, setAttribute(name, value) { if (name === 'src') this.src = value; }, removeAttribute(name) { if (name === 'src') this.src = null; }, pause() { this.paused = true; }, load() { this._currentTime = 0; this.readyState = 0; } });
        node.props.ref.current = elements.get(key);
      }
      const child = nodes(tree).find(node => node.type === module.exports.SourceFrameCaptureControl);
      if (child) control = renderComponent('Capture', child.type, child.props);
      else { cleanup('Capture'); control = null; }
      flush(layouts); flush(effects);
    } while (dirty);
    return tree;
  };
  h.media = () => nodes(tree).find(node => ['video', 'audio'].includes(node.type));
  h.button = () => nodes(control).find(node => node.props?.['data-testid'] === 'source-frame-capture');
  h.fire = name => { h.media().props[name]({ currentTarget: h.media().props.ref.current }); if (dirty) h.render(props); };
  h.unmount = () => { for (const name of [...components.keys()]) cleanup(name); for (const element of elements.values()) element.isConnected = false; };
  return h;
}
const props = (patch = {}) => ({ visible: true, kind: 'source', asset: { id: 'source-a', projectId: 'project-a', name: 'Source', url: '/media/a', duration: 10, mimeType: 'video/mp4', sha256: 'a'.repeat(64) }, playhead: 1000, onSeek: () => {}, sourceScope: 'project-a:source-a:1', sourcePosition: 0, onSourcePosition: () => {}, onCaptureFrame: () => {}, ...patch });

test('capture reads actual paused currentTime, freezes source/hash/frame and ignores controller and timeline playheads', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.render(p);
  const element = h.media().props.ref.current; element.currentTime = 2.499; h.fire('onPause');
  h.render({ ...p, sourcePosition: 200, playhead: 9000 }); assert.equal(h.button().props.disabled, false);
  await h.button().props.onClick();
  assert.deepEqual(calls, [{ sourceScope: p.sourceScope, sourceAssetId: 'source-a', sourceHash: 'a'.repeat(64), sourceFrame: 74 }]);
  assert.equal(Object.isFrozen(calls[0]), true); element.currentTime = 4; assert.equal(calls[0].sourceFrame, 74);
});

test('readiness events enable/disable capture and click revalidation denies stale-enabled media', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.readyState = 0; h.render(p);
  const element = h.media().props.ref.current; assert.equal(h.button().props.disabled, true);
  element.readyState = 1; h.fire('onLoadedMetadata'); assert.equal(h.button().props.disabled, true);
  element.readyState = 2; h.fire('onLoadedData'); assert.equal(h.button().props.disabled, false);
  for (const patch of [{ paused: false }, { seeking: true }, { readyState: 1 }, { _currentTime: NaN }, { _currentTime: Infinity }, { _currentTime: -1 }, { isConnected: false }]) {
    Object.assign(element, { paused: true, seeking: false, readyState: 2, _currentTime: 1, isConnected: true }, patch);
    await h.button().props.onClick();
  }
  assert.deepEqual(calls, []);
  Object.assign(element, { paused: false, seeking: false, readyState: 2, _currentTime: 1, isConnected: true }); h.fire('onPlay'); assert.equal(h.button().props.disabled, true);
  element.paused = true; h.fire('onPause'); assert.equal(h.button().props.disabled, false);
  element.seeking = true; h.fire('onSeeking'); assert.equal(h.button().props.disabled, true);
  element.seeking = false; h.fire('onSeeked'); assert.equal(h.button().props.disabled, false);
  element.readyState = 0; h.fire('onEmptied'); assert.equal(h.button().props.disabled, true);
  element.readyState = 2; h.fire('onCanPlay'); assert.equal(h.button().props.disabled, false);
});

test('a pending explicit seek is never capture fact; acknowledged quantized seek retains the intended editing mark', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.quantize = value => Math.floor(value * 1e6) / 1e6; h.render(p);
  const oldClick = h.button().props.onClick;
  const requested = { ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 56 } }; h.render(requested);
  assert.equal(h.media().props.ref.current.currentTime, 1.866666); assert.equal(h.button().props.disabled, true);
  await oldClick(); await h.button().props.onClick(); assert.deepEqual(calls, []);
  h.fire('onSeeked'); assert.equal(h.button().props.disabled, false); await h.button().props.onClick(); assert.equal(calls[0].sourceFrame, 56);
  const element = h.media().props.ref.current; element.currentTime = 1.95; h.fire('onSeeked'); element.currentTime = 1.866666; h.fire('onSeeked');
  await h.button().props.onClick(); assert.equal(calls[1].sourceFrame, 55, 'old intent does not relabel unrelated native position');
});

test('exclusive EOF and unknown source duration cannot be captured', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.render(p);
  const element = h.media().props.ref.current; element.currentTime = 10; h.fire('onSeeked'); assert.equal(h.button().props.disabled, true); await h.button().props.onClick();
  h.render({ ...p, sourceSeek: { scope: p.sourceScope, id: 1, frame: 300 } }); h.fire('onSeeked'); assert.equal(h.button().props.disabled, true); await h.button().props.onClick();
  h.render({ ...p, asset: { ...p.asset, duration: null } }); await h.button().props.onClick(); assert.deepEqual(calls, []);
});

test('old source/readiness handlers and hidden previews cannot submit against a new binding', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.render(p);
  const oldMedia = h.media(), oldElement = oldMedia.props.ref.current, oldClick = h.button().props.onClick;
  const next = { ...p, sourceScope: 'project-a:source-b:2', asset: { ...p.asset, id: 'source-b', url: '/media/b', sha256: 'b'.repeat(64) } }; h.readyState = 0; h.render(next);
  oldElement.readyState = 2; oldElement.paused = true;
  for (const name of ['onLoadedData', 'onCanPlay', 'onPause', 'onPlay', 'onSeeking', 'onSeeked', 'onEmptied']) oldMedia.props[name]({ currentTarget: oldElement });
  await oldClick(); assert.deepEqual(calls, []); assert.equal(h.button().props.disabled, true);
  h.media().props.ref.current.readyState = 2; h.fire('onLoadedData'); const currentClick = h.button().props.onClick;
  h.visible = false; h.render(next); await currentClick(); assert.deepEqual(calls, []);
  h.visible = true; h.render(next); await h.button().props.onClick(); assert.equal(calls[0].sourceAssetId, 'source-b');
  const retained = h.button().props.onClick; h.unmount(); await retained(); assert.equal(calls.length, 1);
});

test('capture is absent for audio/image/clip/timeline and requires an actual source hash', async () => {
  const h = harness(), p = props();
  for (const patch of [{ asset: { ...p.asset, mimeType: 'audio/wav' } }, { asset: { ...p.asset, mimeType: 'image/png' } }, { clip: { id: 'clip', startFrame: 0, durationFrames: 300 } }, { kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render', status: 'succeeded', timelineRevision: 1, url: '/render' } }]) { h.render({ ...p, ...patch }); assert.equal(h.button(), undefined); }
  h.render({ ...p, asset: { ...p.asset, sha256: null } }); assert.equal(h.button().props.disabled, true);
});

test('synchronous in-flight guard suppresses double click before parent busy render', async () => {
  let release, calls = 0; const work = new Promise(resolve => { release = resolve; });
  const h = harness(); h.render(props({ onCaptureFrame: () => { calls++; return work; } })); const click = h.button().props.onClick;
  const first = click(); await click(); assert.equal(calls, 1); release(); await first;
});


test('narrow Properties can recover a saved local result while retained hidden Preview capture is denied', async () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, projectId = id(1), sourceAssetId = id(2), taskId = id(3), sourceScope = 'narrow:source:1', hash = 'a'.repeat(64), calls = [];
  const asset = { ...props().asset, id: sourceAssetId, projectId, sha256: hash };
  let task = { id: taskId, projectId, requestId: 'original-narrow-capture', sourceAssetId, sourceHash: hash, sourceFrame: 56, fps: 30, profileId: 'local-png-1024-v1', state: 'local_result_error', revision: 3, started: true, result: null, errorCode: 'FRAME_LOCAL_RESULT', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
  const controller = createFrameExtractionController({ createRequestId: () => 'narrow-recover-key', rpc: async (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'frame.task.list') return { projectId, items: [task], nextCursor: null };
    if (operation === 'frame.task.recoverResult') return task = { ...task, state: 'persisting', revision: 4, errorCode: null };
    if (operation === 'frame.task.get') return task;
    assert.fail(`Unexpected hidden write: ${operation}`);
  } });
  controller.configure({ projectId, sourceScope, sourceAsset: asset, assets: [asset], visible: true }); await controller.refreshTasks();
  const h = harness(), p = props({ asset, sourceScope, onCaptureFrame: controller.capture, captureBusy: frameCaptureBusy(controller.getState()) });
  h.render(p); const retained = h.button().props.onClick;
  h.render({ ...p, visible: false }); await retained();
  assert.equal(controller.getState().visible, true, 'Properties keeps only the task controller available');
  await controller.recoverResult(controller.getState().tasks[0]);
  assert.equal(calls.filter(call => call.operation === 'frame.task.recoverResult').length, 1); assert.equal(calls.filter(call => call.operation === 'frame.extract').length, 0);
  controller.configure({ projectId, sourceScope, sourceAsset: asset, assets: [asset], visible: false });
  const before = calls.length; await controller.refreshTasks(); await controller.readTask(taskId); await retained(); assert.equal(calls.length, before);
  h.unmount(); controller.dispose();
});

test('hash-only source replacement remounts decoded media and requires fresh readiness before capturing the new hash', async () => {
  const calls = [], h = harness(), p = props({ onCaptureFrame: value => calls.push(value) }); h.render(p);
  const oldMedia = h.media(), oldElement = oldMedia.props.ref.current, retained = h.button().props.onClick;
  oldElement.currentTime = 2.499; h.fire('onPause'); assert.equal(h.button().props.disabled, false);
  h.readyState = 0;
  const next = { ...p, asset: { ...p.asset, sha256: 'c'.repeat(64) } }; h.render(next);
  const element = h.media().props.ref.current;
  assert.notEqual(element, oldElement, 'a new source digest cannot reuse old decoded pixels');
  assert.equal(element.src, p.asset.url, 'ID, URL and scope intentionally stay unchanged');
  assert.equal(oldElement.src, null); assert.equal(h.button().props.disabled, true);
  oldElement.readyState = 2; oldElement.currentTime = 7;
  for (const name of ['onLoadedMetadata', 'onLoadedData', 'onCanPlay', 'onPause', 'onSeeked']) oldMedia.props[name]({ currentTarget: oldElement });
  await retained(); await h.button().props.onClick(); assert.deepEqual(calls, []); assert.equal(h.button().props.disabled, true);
  element.readyState = 1; h.fire('onLoadedMetadata'); await h.button().props.onClick(); assert.deepEqual(calls, []); assert.equal(h.button().props.disabled, true);
  element.readyState = 2; element.currentTime = 1.25; h.fire('onLoadedData'); assert.equal(h.button().props.disabled, false);
  await h.button().props.onClick(); assert.deepEqual(calls, [{ sourceScope: p.sourceScope, sourceAssetId: p.asset.id, sourceHash: 'c'.repeat(64), sourceFrame: 37 }]);
  h.unmount();
});
