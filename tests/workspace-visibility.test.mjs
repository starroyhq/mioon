import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as exportSettings from '../apps/web/src/export-settings-state.js';
import * as sourceRanges from '../apps/web/src/source-range-state.js';

// Exercise the real component functions with deterministic hook, ref, media,
// and animation-frame boundaries. These tests intentionally do not claim DOM
// or browser playback coverage; browser acceptance covers the integrated UI.
const componentCode = new Map(['workspace-visibility.jsx', 'Nodes.jsx', 'Preview.jsx', 'Inspector.jsx'].map(file => [file,
  transformSync(readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', sourcefile: file }).code,
]));
const noop = () => {};
function makeElement(src = null) {
  return {
    src, currentTime: 0, duration: 20, paused: true, seeking: false, isConnected: true,
    pauses: 0, loads: 0, focuses: 0, scrolls: 0,
    getAttribute(name) { return name === 'src' ? this.src : null; },
    setAttribute(name, value) { if (name === 'src') this.src = value; },
    removeAttribute(name) { if (name === 'src') this.src = null; },
    pause() { this.paused = true; this.pauses++; },
    load() { this.loads++; this.currentTime = 0; },
    focus() { this.focuses++; },
    scrollIntoView() { this.scrolls++; },
  };
}
function treeNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...treeNodes(tree.props?.children)];
}
function createHarness(file, exportName = 'default') {
  const slots = [], frames = new Map(), elements = new Map(), modules = new Map();
  let cursor = 0, layouts = [], effects = [], nextFrame = 0, tree;
  const h = { ancestorVisible: undefined };
  function effect(kind, callback, dependencies) {
    const index = cursor++, previous = slots[index];
    if (previous && dependencies?.length === previous.dependencies?.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    slots[index] = { dependencies, cleanup: previous?.cleanup, callback, kind };
    (kind === 'layout' ? layouts : effects).push(index);
  }
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }; },
    createContext(value) { return { defaultValue: value, Provider: 'VisibilityProvider' }; },
    useContext(context) { return h.ancestorVisible ?? context.defaultValue; },
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value) { const index = cursor++; slots[index] ||= { value: typeof value === 'function' ? value() : value }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useEffect: (callback, dependencies) => effect('effect', callback, dependencies),
    useLayoutEffect: (callback, dependencies) => effect('layout', callback, dependencies),
    memo: component => component,
    Fragment: 'Fragment',
  };
  react.default = react;
  const ui = new Proxy({ useConfirmation: () => async () => true }, { get: (target, key) => target[key] ?? String(key) });
  const mocks = {
    react,
    './source-range-state.js': sourceRanges,
    './export-settings-state.js': exportSettings,
    '@xyflow/react': { Handle: 'Handle', Position: { Left: 'left', Right: 'right' } },
    './icons.jsx': { default: 'Icon', __esModule: true },
    './api.js': { assetUrl: asset => asset?.url || '', versionUrl: version => version?.url || '', activeJob: () => false, statusText: value => value, jobStatusText: value => value, outputReviewRequired: () => false },
    './Timeline.jsx': { assetKind: asset => asset?.mimeType?.split('/')[0], framesLabel: String, dragAsset: noop },
    './reference-connections.js': { referenceForShot: () => null },
    './generation-settings.js': { generationSelection: () => ({ provider: { id: 'mock', mock: true }, model: 'mock', capabilities: {}, inputMode: 'text', scenario: 'success' }), generationInputIssue: () => '', providerAvailabilityIssue: () => '', inputModeLabel: String },
    './VideoFrameControls.jsx': { default: 'VideoFrameControls', VideoFrameSummary: 'VideoFrameSummary', __esModule: true },
    './ProviderSettings.jsx': { default: 'ProviderSettings', __esModule: true },
    './ShotSubjectBindings.jsx': { default: 'ShotSubjectBindings', __esModule: true },
    './WorkspaceControls.jsx': { WorkbenchSelect: 'WorkbenchSelect', WorkbenchTooltip: 'WorkbenchTooltip' },
    './ReferenceConnections.jsx': { ReferenceSourcePanel: 'ReferenceSourcePanel', BoundReference: 'BoundReference' },
  };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const require = id => {
      if (mocks[id]) return mocks[id];
      if (id.startsWith('@mioon/ui/')) return ui;
      if (componentCode.has(id.replace('./', ''))) return load(id.replace('./', ''));
      throw Error(`Unexpected component dependency: ${id}`);
    };
    Function('require', 'module', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', componentCode.get(filename))(
      require, module, module.exports,
      callback => { frames.set(++nextFrame, callback); return nextFrame; },
      id => frames.delete(id),
    );
    return module.exports;
  }
  const Component = load(file)[exportName];
  function flush(queue) {
    for (const index of queue) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback(); }
  }
  Object.assign(h, {
    render(props, { passive = true } = {}) {
      cursor = 0; layouts = []; effects = [];
      tree = Component(props);
      for (const node of treeNodes(tree)) {
        if (node.props?.ref && typeof node.props.ref === 'object') {
          const key = `${node.type}:${node.props.key ?? node.props['data-testid'] ?? 'ref'}`;
          if (!elements.has(key)) elements.set(key, makeElement(node.props.src));
          node.props.ref.current = elements.get(key);
        }
      }
      flush(layouts); if (passive) this.flushPassive();
      return tree;
    },
    flushPassive() { const pending = effects; effects = []; flush(pending); },
    nodes: () => treeNodes(tree),
    find: testId => treeNodes(tree).find(node => node.props?.['data-testid'] === testId),
    mediaNode: () => treeNodes(tree).find(node => ['audio', 'video'].includes(node.type)),
    pendingFrames: () => [...frames.values()],
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); for (const element of elements.values()) element.isConnected = false; },
    replayEffects() { for (const slot of slots) if (slot?.callback) { slot.cleanup?.(); slot.cleanup = slot.callback(); } },
  });
  return h;
}
const asset = (kind = 'video', id = 'asset-one') => ({ id, url: `/media/${id}`, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}`, name: 'Fixture' });
const previewProps = patch => ({ visible: true, kind: 'source', asset: asset(), playhead: 0, onSeek: noop, ...patch });
const inspectorProps = patch => ({
  shot: { id: 'shot-one', title: 'Fixture shot', prompt: 'Original', revision: 1, orderIndex: 0 },
  project: { id: 'project-one' }, assets: [], versions: [{ id: 'version-one', shotId: 'shot-one', number: 1, createdAt: '2026-10-09T12:00:00Z' }],
  jobs: [], providers: [], busy: {}, tab: 'versions', highlightedVersionId: 'version-one', onDirtyChange: noop,
  ...patch,
});

test('visibility defaults to visible and nested visible panels cannot override a hidden ancestor', () => {
  const h = createHarness('workspace-visibility.jsx', 'WorkspaceVisibilityProvider');
  assert.equal(h.render({ children: 'content' }).props.value, true);
  assert.equal(h.render({ visible: false }).props.value, false);
  h.ancestorVisible = false;
  assert.equal(h.render({ visible: true }).props.value, false);
  h.ancestorVisible = true;
  assert.equal(h.render({ visible: true }).props.value, true);
});

for (const kind of ['video', 'audio']) {
  test(`${kind} Media pauses before passive effects; hide/reopen preserves element, source and time`, () => {
    const h = createHarness('Nodes.jsx', 'Media'), events = [];
    const props = { asset: asset(kind), controls: true, onPlay: () => events.push('play'), onTimeUpdate: () => events.push('time') };
    h.render(props);
    const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 4.125; element.paused = false;
    h.ancestorVisible = false; h.render(props, { passive: false });
    assert.equal(element.paused, true); assert.equal(element.currentTime, 4.125);
    assert.equal(element.src, props.asset.url); assert.equal(element.loads, 0);
    for (const callback of ['onPlay', 'onPlaying', 'onTimeUpdate']) {
      element.paused = false; node.props[callback]({ currentTarget: element });
      assert.equal(element.paused, true, `${callback} captured while visible must respect current hidden state`);
    }
    assert.deepEqual(events, []);
    h.ancestorVisible = true; h.render(props);
    assert.equal(h.mediaNode().props.ref.current, element); assert.equal(element.currentTime, 4.125);
    assert.equal(element.paused, true); assert.equal(element.loads, 0);
    h.unmount(); assert.equal(element.src, null); assert.equal(element.loads, 1);
  });

  test(`${kind} Preview ignores late hidden callbacks and does not seek or resume on reopen`, () => {
    const h = createHarness('Preview.jsx'), seeks = [], props = previewProps({ asset: asset(kind), onSeek: value => seeks.push(value) });
    h.render(props);
    const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 5.25; element.paused = false;
    h.render({ ...props, visible: false }, { passive: false });
    assert.equal(element.paused, true);
    for (const name of ['onPlay', 'onPlaying', 'onTimeUpdate', 'onSeeked', 'onLoadedMetadata']) {
      if (['onPlay', 'onPlaying', 'onTimeUpdate'].includes(name)) element.paused = false;
      node.props[name]({ currentTarget: element });
      assert.equal(element.currentTime, 5.25);
      assert.equal(element.paused, true, `${name} cannot continue hidden playback`);
    }
    assert.deepEqual(seeks, []);
    h.render(props);
    assert.equal(h.mediaNode().props.ref.current, element); assert.equal(element.currentTime, 5.25);
    assert.equal(element.paused, true); assert.equal(element.loads, 0); assert.equal(element.src, props.asset.url);
    h.unmount(); assert.equal(element.loads, 1); assert.equal(element.src, null);
  });
}

for (const kind of ['source', 'timeline']) {
  test(`${kind} Preview cannot publish late playback or native-seek events while hidden`, () => {
    const h = createHarness('Preview.jsx'), seeks = [], props = previewProps({
      kind, onSeek: value => seeks.push(value), timeline: { revision: 1 },
      clip: { id: 'clip-one', sourceInFrame: 0, startFrame: 0, durationFrames: 300 },
      job: { id: 'render-one', status: 'succeeded', url: '/render', timelineRevision: 1 },
    });
    h.render(props); const node = h.mediaNode(), element = node.props.ref.current;
    element.currentTime = 2; element.paused = false;
    node.props.onTimeUpdate({ currentTarget: element }); assert.deepEqual(seeks, [60]);
    h.render({ ...props, visible: false });
    element.currentTime = 3; element.paused = false;
    node.props.onTimeUpdate({ currentTarget: element }); node.props.onSeeked({ currentTarget: element });
    assert.deepEqual(seeks, [60]); assert.equal(element.paused, true);
  });
}

test('Preview applies a changed playhead deferred while hidden, without publishing that programmatic seek', () => {
  const h = createHarness('Preview.jsx'), seeks = [], props = previewProps({ clip: { id: 'clip-one', sourceInFrame: 30, startFrame: 60, durationFrames: 300 }, playhead: 90, onSeek: value => seeks.push(value) });
  h.render(props); const element = h.mediaNode().props.ref.current;
  assert.equal(element.currentTime, 2);
  h.ancestorVisible = false; h.render({ ...props, playhead: 180 });
  assert.equal(element.currentTime, 2); assert.equal(element.paused, true);
  h.ancestorVisible = true; h.render({ ...props, playhead: 180 });
  assert.equal(element.currentTime, 5);
  h.mediaNode().props.onSeeked({ currentTarget: element }); assert.deepEqual(seeks, []);
  element.currentTime = 6;
  h.mediaNode().props.onSeeked({ currentTarget: element }); assert.deepEqual(seeks, [210]);
});

test('replaced Preview sources reject old callbacks and Strict Mode disposal restores the current source', () => {
  const h = createHarness('Preview.jsx'), seeks = [], props = previewProps({ kind: 'timeline', timeline: { revision: 1 }, job: { id: 'render-one', status: 'succeeded', url: '/first', timelineRevision: 1 }, onSeek: value => seeks.push(value) });
  h.render(props); const old = h.mediaNode(), original = old.props.ref.current;
  h.render({ ...props, job: { ...props.job, id: 'render-two', url: '/second' } });
  const current = h.mediaNode().props.ref.current;
  assert.notEqual(original, current); assert.equal(original.loads, 1); assert.equal(original.src, null);
  original.currentTime = 4; original.paused = false;
  old.props.onTimeUpdate({ currentTarget: original }); old.props.onSeeked({ currentTarget: original }); old.props.onPlay({ currentTarget: original });
  assert.deepEqual(seeks, []); assert.equal(original.paused, true);
  h.replayEffects(); assert.equal(current.src, '/second'); assert.equal(current.paused, true);
});

test('Inspector cancels pending highlight focus when hidden and does not refocus on reopening or refresh', () => {
  const h = createHarness('Inspector.jsx'), props = inspectorProps();
  h.render(props); const element = h.find('version-card-version-one').props.ref.current;
  const [queued] = h.pendingFrames(); assert.ok(queued);
  h.ancestorVisible = false; h.render(props);
  assert.equal(h.pendingFrames().length, 0);
  queued(); assert.equal(element.focuses, 0); assert.equal(element.scrolls, 0);
  h.ancestorVisible = true; h.render(props); h.flushFrames();
  h.render({ ...props, shot: { ...props.shot, revision: 2 }, versions: [...props.versions] }); h.flushFrames();
  assert.equal(element.focuses, 0);
  h.render({ ...props, highlightedVersionId: null });
  h.render(props); h.flushFrames(); assert.equal(element.focuses, 1); assert.equal(element.scrolls, 1);
});

test('Inspector never schedules hidden focus, and an unmounted pending callback is inert', () => {
  const h = createHarness('Inspector.jsx'), props = inspectorProps();
  h.ancestorVisible = false; h.render(props); assert.equal(h.pendingFrames().length, 0);
  h.ancestorVisible = true; h.render({ ...props, tab: 'settings' }); h.render(props);
  const [queued] = h.pendingFrames(), element = h.find('version-card-version-one').props.ref.current;
  h.unmount(); queued(); assert.equal(element.focuses, 0); assert.equal(element.scrolls, 0);
});

test('collapsing Inspector preserves the draft and an already requested save-and-generate continuation', async () => {
  const h = createHarness('Inspector.jsx'), generated = [];
  let resolveSave;
  const props = inspectorProps({ tab: 'settings', highlightedVersionId: null, onSave: () => new Promise(resolve => { resolveSave = resolve; }), onGenerate: (...args) => generated.push(args) });
  h.render(props); h.find('shot-prompt').props.onChange({ target: { value: 'Edited while visible' } }); h.render(props);
  const work = h.find('generate-shot').props.onClick(); assert.ok(resolveSave);
  h.ancestorVisible = false; h.render(props);
  assert.equal(h.find('shot-prompt').props.value, 'Edited while visible');
  resolveSave({ ...props.shot, prompt: 'Edited while visible', revision: 2 }); await work;
  assert.equal(generated.length, 1); assert.equal(generated[0][0].prompt, 'Edited while visible');
  h.render(props); assert.equal(h.find('shot-prompt').props.value, 'Edited while visible');
});
