import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as layout from '../apps/web/src/workspace-layout.ts';

// Deterministic component-level lifecycle tests, not a substitute for browser
// keyboard, pointer-capture, or real Base UI portal acceptance.
const code = transformSync(readFileSync(new URL('../apps/web/src/WorkspacePanels.tsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const noop = () => {};
class Element {
  constructor() { this.isConnected = true; this.scrollLeft = 0; this.scrollTop = 0; this.focuses = 0; this.children = new Set(); this.captures = new Set(); this.dataset = {}; this.selectors = new Map(); }
  contains(element) { return this === element || this.children.has(element); }
  focus() { this.focuses++; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  querySelector(selector) { return this.selectors.get(selector) || null; }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function harness(name) {
  const slots = [], frames = new Map(), listeners = new Map(), refs = new Map(), observers = new Set();
  let cursor = 0, pendingLayout = [], pendingEffect = [], frameId = 0, observerCreations = 0, tree;
  const fallback = new Element();
  const body = new Element(), byId = new Map();
  const document = { body, activeElement: body, byId, getElementById: id => byId.get(id) || null, querySelector: selector => selector === '#recall' ? fallback : null };
  function effect(kind, callback, deps) {
    const index = cursor++, old = slots[index];
    if (old && deps && deps.length === old.deps?.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
    slots[index] = { deps, callback, cleanup: old?.cleanup };
    (kind === 'layout' ? pendingLayout : pendingEffect).push(index);
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value) { const index = cursor++; slots[index] ||= { value: typeof value === 'function' ? value() : value }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useMemo(callback, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) slots[index] = { deps, value: callback() }; return slots[index].value; },
    useLayoutEffect: (callback, deps) => effect('layout', callback, deps),
    useEffect: (callback, deps) => effect('passive', callback, deps),
  };
  react.default = react;
  const ui = new Proxy({}, { get: (_, key) => String(key) });
  const window = {
    innerWidth: 1200, innerHeight: 960,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observerCreations++; }
    observe(element) { this.element = element; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const require = id => {
    if (id === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (id === 'react') return react;
    if (id.startsWith('@mioon/ui/')) return ui;
    if (id === './workspace-layout.js') return layout;
    if (id === './workspace-visibility.jsx') return { WorkspaceVisibilityProvider: 'WorkspaceVisibilityProvider' };
    if (id === './icons.jsx') return { __esModule: true, default: 'Icon' };
    throw Error(`Unexpected panel dependency ${id}`);
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', code)(
    require, module, module.exports, window, document, Element,
    callback => { frames.set(++frameId, callback); return frameId; }, id => frames.delete(id),
    ResizeObserver,
  );
  const Component = name === 'usePanelGeometry' ? props => module.exports.usePanelGeometry(props.surface, props.preferred, props.mode, props.scope, props.ready, props.presentationScope) : module.exports[name];
  function flush(queue) { for (const index of queue) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback(); } }
  return {
    fallback, document,
    render(props, { passive = true } = {}) {
      cursor = 0; pendingLayout = []; pendingEffect = []; tree = Component(props);
      for (const node of nodes(tree)) if (node.props?.ref) {
        const key = node.props['data-testid'] || node.type;
        if (!refs.has(key)) refs.set(key, new Element());
        node.props.ref.current = refs.get(key);
      }
      flush(pendingLayout); if (passive) this.flushPassive(); return tree;
    },
    flushPassive() { const pending = pendingEffect; pendingEffect = []; flush(pending); },
    node: testId => nodes(tree).find(node => node.props?.['data-testid'] === testId),
    nodes: () => nodes(tree),
    dispatch(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    observerCount: () => observers.size,
    observerCreations: () => observerCreations,
    resize() { for (const observer of observers) observer.callback(); },
    pendingFrames: () => [...frames.values()],
    flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); for (const element of refs.values()) element.isConnected = false; },
  };
}
const event = patch => ({ button: 0, pointerId: 1, clientX: 100, clientY: 100, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...patch });
function resizeFixture(name = 'assets', overrides = {}) {
  const field = { assets: 'assetsWidth', inspector: 'inspectorWidth', timeline: 'timelineHeight' }[name];
  const h = harness('PanelResizeHandle'), previews = [], commits = [];
  const props = { name, field, value: 300, max: layout.PANEL_BOUNDS[field].max, scope: 'project-one:canvas', onPreview: (...args) => previews.push(args), onCommit: (...args) => commits.push(args), ...overrides };
  const render = patch => h.render({ ...props, ...patch });
  render();
  const node = () => h.node(`resize-${name}`), element = () => node().props.ref.current;
  const fire = (type, patch = {}, target = node()) => { const e = event({ currentTarget: element(), ...patch }); target.props[type](e); return e; };
  return { h, props, previews, commits, render, node, element, fire, start: () => fire('onPointerDown') };
}

for (const [name, coordinate, moved, expected] of [['assets', 'clientX', 150, 350], ['inspector', 'clientX', 50, 350], ['timeline', 'clientY', 50, 350]]) {
  test(`${name} drag previews immediately and commits exactly once only on matching pointer release`, () => {
    const f = resizeFixture(name), down = f.start();
    assert.equal(down.prevented, true); assert.equal(f.element().focuses, 1); assert.equal(f.element().hasPointerCapture(1), true);
    f.fire('onPointerMove', { [coordinate]: moved, pointerId: 2 }); assert.deepEqual(f.previews, []);
    f.fire('onPointerMove', { [coordinate]: moved }); assert.deepEqual(f.previews, [[f.props.field, expected]]); assert.deepEqual(f.commits, []);
    f.fire('onPointerUp', { pointerId: 2 }); assert.deepEqual(f.commits, []);
    f.fire('onPointerUp'); assert.deepEqual(f.commits, [[f.props.field, expected]]); assert.deepEqual(f.previews.at(-1), [f.props.field, null]);
    assert.equal(f.element().hasPointerCapture(1), false);
    f.fire('onLostPointerCapture'); f.fire('onPointerUp'); assert.equal(f.commits.length, 1);
  });
}

test('panel pointer resize converts physical deltas at 90% and 125% into logical preferred sizes', () => {
  for (const scale of [0.9, 1.25]) for (const name of ['assets', 'inspector', 'timeline']) {
    const f = resizeFixture(name), element = f.element();
    element.offsetWidth = 8; element.getBoundingClientRect = () => ({ width: 8 * scale });
    f.start();
    f.fire('onPointerMove', name === 'assets' ? { clientX: 100 + 40 * scale } : name === 'inspector' ? { clientX: 100 - 40 * scale } : { clientY: 100 - 40 * scale });
    f.fire('onPointerUp');
    assert.deepEqual(f.commits, [[f.props.field, 340]]);
    f.h.unmount();
  }
});

test('resize is inert for disabled handles, secondary buttons, clicks without motion, and unrelated keys', () => {
  for (const overrides of [{ enabled: false }, {}]) {
    const f = resizeFixture('assets', overrides);
    f.fire('onPointerDown', { button: overrides.enabled === false ? 0 : 2 }); f.fire('onPointerMove', { clientX: 500 }); f.fire('onPointerUp');
    assert.deepEqual(f.previews, []); assert.deepEqual(f.commits, []); assert.equal(f.element().hasPointerCapture(1), false);
  }
  const f = resizeFixture(); f.start(); f.fire('onPointerUp');
  assert.deepEqual(f.commits, []);
  const key = f.fire('onKeyDown', { key: 'a' }); assert.equal(key.prevented, false); assert.deepEqual(f.commits, []);
});

for (const reason of ['Escape', 'onPointerCancel', 'onLostPointerCapture', 'blur', 'pagehide', 'disabled']) {
  test(`resize ${reason} cancels the preview without persisting a value`, () => {
    const f = resizeFixture(); f.start(); f.fire('onPointerMove', { clientX: 170 });
    if (reason === 'Escape') {
      const key = event({ key: 'Escape' }); f.h.dispatch('keydown', key); assert.equal(key.prevented, true); assert.equal(key.stopped, true);
    } else if (reason === 'disabled') f.render({ enabled: false });
    else if (reason.startsWith('on')) f.fire(reason);
    else f.h.dispatch(reason);
    assert.deepEqual(f.previews.at(-1), ['assetsWidth', null]); assert.equal(f.element().hasPointerCapture(1), false);
    f.fire('onPointerUp'); assert.deepEqual(f.commits, []);
  });
}

test('scope changes reject stale pointer release before passive cleanup and use only the latest callbacks', () => {
  const f = resizeFixture(), newerPreviews = [], newerCommits = [];
  f.start(); f.fire('onPointerMove', { clientX: 190 }); const oldNode = f.node();
  f.h.render({ ...f.props, scope: 'project-two:editing', onPreview: (...args) => newerPreviews.push(args), onCommit: (...args) => newerCommits.push(args) }, { passive: false });
  f.fire('onPointerMove', { clientX: 230 }, oldNode); f.fire('onPointerUp', {}, oldNode); f.h.flushPassive();
  assert.deepEqual(f.commits, []); assert.deepEqual(newerCommits, []);
  assert.deepEqual(newerPreviews, [['assetsWidth', null]]);
});

test('rerenders during a long drag retain its original pointer origin and do not persist intermediate sizes', () => {
  const f = resizeFixture(); f.start();
  f.fire('onPointerMove', { clientX: 150 }); f.render({ value: 350 });
  f.fire('onPointerMove', { clientX: 170 }); f.render({ value: 370 });
  f.fire('onPointerMove', { clientX: 180 });
  assert.deepEqual(f.previews.map(item => item[1]), [350, 370, 380]); assert.deepEqual(f.commits, []);
  f.fire('onPointerUp'); assert.deepEqual(f.commits, [['assetsWidth', 380]]);
});

test('unmount removes global resize listeners and makes the old gesture unable to commit', () => {
  const f = resizeFixture(); assert.equal(f.h.listenerCount(), 3);
  f.start(); f.fire('onPointerMove', { clientX: 200 }); f.h.unmount();
  assert.equal(f.h.listenerCount(), 0);
  f.fire('onPointerUp'); assert.deepEqual(f.commits, []);
});

for (const [name, increase, decrease] of [['assets', 'ArrowRight', 'ArrowLeft'], ['inspector', 'ArrowLeft', 'ArrowRight'], ['timeline', 'ArrowUp', 'ArrowDown']]) {
  test(`${name} separator has bounded accessible values and directional keyboard sizing`, () => {
    const f = resizeFixture(name, { max: 400 }), p = f.node().props, bounds = layout.PANEL_BOUNDS[f.props.field];
    assert.equal(p.role, 'separator'); assert.equal(p['aria-orientation'], name === 'timeline' ? 'horizontal' : 'vertical');
    assert.equal(p['aria-controls'], `dock-${name}`); assert.equal(p['aria-valuemin'], bounds.min); assert.equal(p['aria-valuemax'], 400);
    assert.equal(p['aria-valuenow'], 300); assert.equal(p['aria-valuetext'], '300 像素'); assert.equal(p.tabIndex, 0); assert.equal(p.hidden, false);
    const key = f.fire('onKeyDown', { key: increase }); assert.equal(key.prevented, true); assert.equal(key.stopped, true);
    f.fire('onKeyDown', { key: decrease, shiftKey: true }); f.fire('onKeyDown', { key: 'Home' }); f.fire('onKeyDown', { key: 'End' });
    f.fire('onDoubleClick');
    assert.deepEqual(f.commits.map(item => item[1]), [310, 250, bounds.min, 400, bounds.default]);
    f.render({ value: 400 }); f.fire('onKeyDown', { key: increase, shiftKey: true }); assert.equal(f.commits.at(-1)[1], 400);
    f.render({ value: bounds.min }); f.fire('onKeyDown', { key: decrease }); assert.equal(f.commits.at(-1)[1], bounds.min);
    f.render({ enabled: false }); assert.equal(f.node().props.tabIndex, -1); assert.equal(f.node().props.hidden, true);
    const previous = f.commits.length; f.fire('onKeyDown', { key: increase }); f.fire('onDoubleClick'); assert.equal(f.commits.length, previous);
  });
}

for (const action of ['onKeyDown', 'onDoubleClick']) {
  test(`${action} during a pointer gesture cannot be overwritten by a stale pointer release`, () => {
    const f = resizeFixture(); f.start(); f.fire('onPointerMove', { clientX: 190 });
    f.fire(action, { key: 'Home' }); const committed = [...f.commits];
    f.fire('onPointerUp'); assert.deepEqual(f.commits, committed);
    assert.equal(f.element().hasPointerCapture(1), false);
  });
}

const boundaryProps = patch => ({ name: 'inspector', visible: true, scope: 'project-one:canvas', fallbackFocus: '#recall', children: { type: 'form', props: { children: 'Persistent draft' } }, ...patch });
test('PanelBoundary preserves its children and propagates effective visibility through inert semantic markup', () => {
  const h = harness('PanelBoundary'), props = boundaryProps(), visible = h.render(props), root = h.node('dock-inspector').props.ref.current;
  assert.equal(visible.type, 'WorkspaceVisibilityProvider'); assert.equal(visible.props.visible, true);
  assert.equal(h.node('dock-inspector').props.inert, false); assert.equal(h.node('dock-inspector').props['aria-hidden'], undefined);
  const hidden = h.render({ ...props, visible: false }), node = h.node('dock-inspector');
  assert.equal(hidden.props.visible, false); assert.equal(node.props.inert, true); assert.equal(node.props['aria-hidden'], true);
  assert.equal(node.props['data-visible'], 'false'); assert.equal(node.props.children, props.children); assert.equal(node.props.ref.current, root);
  h.render(props); assert.equal(h.node('dock-inspector').props.children, props.children); assert.equal(h.node('dock-inspector').props.ref.current, root);
});

test('PanelBoundary returns contained focus on hide but never steals focus after an outside blur', () => {
  const h = harness('PanelBoundary'), props = boundaryProps(); h.render(props);
  h.node('dock-inspector').props.onFocusCapture(); h.render({ ...props, visible: false }); assert.equal(h.fallback.focuses, 1);
  h.render(props); const root = h.node('dock-inspector').props.ref.current;
  h.node('dock-inspector').props.onFocusCapture(); h.node('dock-inspector').props.onBlurCapture({ currentTarget: root, relatedTarget: new Element() });
  h.render({ ...props, visible: false }); assert.equal(h.fallback.focuses, 1);
});

test('PanelBoundary restores retained scroll only when visible in the same scope; hidden and stale callbacks are inert', () => {
  const h = harness('PanelBoundary'), props = boundaryProps(); h.render(props); h.flushFrames();
  const root = h.node('dock-inspector').props.ref.current, scroll = new Element(); root.children.add(scroll);
  scroll.scrollLeft = 29; scroll.scrollTop = 173; h.node('dock-inspector').props.onScrollCapture({ target: scroll });
  h.render({ ...props, visible: false }); scroll.scrollLeft = 0; scroll.scrollTop = 0;
  h.node('dock-inspector').props.onScrollCapture({ target: scroll });
  h.render(props); const [stale] = h.pendingFrames(); h.flushFrames();
  assert.equal(scroll.scrollLeft, 29); assert.equal(scroll.scrollTop, 173);
  h.render({ ...props, visible: false }); scroll.scrollTop = 1; stale(); assert.equal(scroll.scrollTop, 1);
  h.render({ ...props, scope: 'project-two:canvas' }); h.flushFrames(); assert.equal(scroll.scrollTop, 1);
  h.unmount(); assert.equal(h.pendingFrames().length, 0);
});

for (const mode of ['canvas', 'editing']) {
  test(`${mode} PanelsMenu uses labelled checkbox primitives and a distinct current-layout reset`, () => {
    const h = harness('PanelsMenu'), changes = []; let resets = 0;
    const props = { mode, assetsCollapsed: true, inspectorCollapsed: false, timelineCollapsed: true, storyboardOpen: true, onPanel: (...args) => changes.push(args), onReset: () => resets++, disabled: true };
    h.render(props);
    const trigger = h.nodes().find(node => node.type === 'DropdownMenuTrigger');
    assert.equal(trigger.props.render.type, 'Button'); assert.equal(trigger.props.render.props.disabled, true);
    const group = h.nodes().find(node => node.type === 'DropdownMenuGroup');
    assert.ok(nodes(group).some(node => node.type === 'DropdownMenuLabel' && node.props.children === (mode === 'canvas' ? '画板面板' : '剪辑面板')));
    for (const [name, checked] of [['assets', false], ['inspector', true], mode === 'canvas' ? ['storyboard', true] : ['timeline', false]]) {
      const item = h.node(`menu-panel-${name}`); assert.equal(item.type, 'DropdownMenuCheckboxItem'); assert.equal(item.props.checked, checked);
      item.props.onCheckedChange(!checked); assert.deepEqual(changes.at(-1), [name, !checked]);
    }
    assert.equal(h.node(`menu-panel-${mode === 'canvas' ? 'timeline' : 'storyboard'}`), undefined);
    const reset = h.node('reset-panel-layout'); assert.equal(reset.type, 'DropdownMenuItem');
    assert.ok(reset.props.children.includes('重置当前工作区布局')); reset.props.onClick(); assert.equal(resets, 1);
  });
}

test('PanelRecall is a labelled button tied to its collapsed panel', () => {
  const h = harness('PanelRecall'); let recalls = 0;
  h.render({ name: 'assets', label: '素材库', icon: 'image', onClick: () => recalls++ });
  const node = h.node('reopen-assets'); assert.equal(node.type, 'Button'); assert.equal(node.props['aria-label'], '展开素材库');
  assert.equal(node.props['aria-controls'], 'dock-assets'); assert.equal(node.props['aria-expanded'], false);
  node.props.onClick({ currentTarget: new Element() }); assert.equal(recalls, 1);
});

test('viewport resize cancels an active gesture through the changed measured-size scope', () => {
  const f = resizeFixture('assets', { scope: 'project-one:canvas:1200:900' });
  f.start(); f.fire('onPointerMove', { clientX: 180 });
  f.render({ scope: 'project-one:canvas:1000:700' });
  f.fire('onPointerUp'); assert.deepEqual(f.commits, []); assert.deepEqual(f.previews.at(-1), ['assetsWidth', null]);
  const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /scope=\{`\$\{panelScope\}:\$\{geometry\.size\.width\}:\$\{geometry\.size\.height\}`\}/);
});

test('geometry previews are local, viewport-derived sizes never mutate preferences, and returning to an old scope cannot resurrect a canceled drag', () => {
  const h = harness('usePanelGeometry'), preferred = layout.defaultWorkspaceLayout().editing, before = structuredClone(preferred);
  const surface = { current: { clientWidth: 1400, clientHeight: 900 } }, props = { surface, preferred, mode: 'editing', scope: 'project-one:editing' };
  h.render(props); let geometry = h.render(props);
  assert.equal(h.observerCount(), 1); assert.equal(geometry.narrow, false);
  assert.equal(geometry.effective.assetsWidth, preferred.assetsWidth);
  geometry.preview('assetsWidth', 430); geometry = h.render(props);
  assert.equal(geometry.effective.assetsWidth, 430); assert.deepEqual(preferred, before);
  geometry = h.render({ ...props, scope: 'project-two:editing' }); assert.equal(geometry.effective.assetsWidth, preferred.assetsWidth);
  geometry = h.render(props); assert.equal(geometry.effective.assetsWidth, preferred.assetsWidth);
  surface.current.clientWidth = 740; surface.current.clientHeight = 440; h.resize(); geometry = h.render(props);
  assert.equal(geometry.narrow, true); assert.ok(geometry.effective.assetsWidth < preferred.assetsWidth); assert.ok(geometry.effective.timelineHeight < preferred.timelineHeight);
  assert.deepEqual(preferred, before);
  surface.current.clientWidth = 1400; surface.current.clientHeight = 900; h.resize(); geometry = h.render(props);
  assert.equal(geometry.narrow, false); assert.equal(geometry.effective.assetsWidth, preferred.assetsWidth); assert.equal(geometry.effective.timelineHeight, preferred.timelineHeight);
  geometry = h.render({ ...props, mode: 'canvas' }); assert.equal(geometry.style['--dock-timeline'], '0px');
  h.unmount(); assert.equal(h.observerCount(), 0);
});

test('the preview keeps a comfortable height while the timeline keeps one track, and the resize maximum matches the effective cap', () => {
  const h = harness('usePanelGeometry'), preferred = layout.defaultWorkspaceLayout().editing;
  const surface = { current: { clientWidth: 1400, clientHeight: 620 } }, props = { surface, preferred, mode: 'editing', scope: 'project-one:editing' };
  h.render(props); let geometry = h.render(props);
  // Reserve 240px of stage plus 84px of preview controls; keep the 300px preference untouched.
  assert.equal(geometry.effective.timelineHeight, 278); assert.equal(geometry.maxima.timelineHeight, 278); assert.equal(preferred.timelineHeight, 300);
  surface.current.clientHeight = 900; h.resize(); geometry = h.render(props);
  assert.equal(geometry.effective.timelineHeight, 300); assert.equal(geometry.maxima.timelineHeight, 558);
  // A short window lets the preview give way before the timeline drops below one track.
  surface.current.clientHeight = 470; h.resize(); geometry = h.render(props);
  assert.equal(geometry.narrow, false); assert.equal(geometry.effective.timelineHeight, 160); assert.equal(geometry.maxima.timelineHeight, 160);
  h.unmount();
});

test('double-click restores the durable default even when the viewport maximum is smaller, while keyboard sizing stays constrained', () => {
  for (const name of ['assets', 'inspector', 'timeline']) {
    const field = { assets: 'assetsWidth', inspector: 'inspectorWidth', timeline: 'timelineHeight' }[name], bounds = layout.PANEL_BOUNDS[field];
    const f = resizeFixture(name, { max: bounds.min + 10, value: bounds.max });
    assert.equal(f.node().props['aria-valuenow'], bounds.min + 10);
    assert.equal(f.node().props['aria-valuetext'], `${bounds.min + 10} 像素`);
    f.fire('onKeyDown', { key: 'End' }); assert.deepEqual(f.commits.at(-1), [field, bounds.min + 10]);
    f.fire('onDoubleClick'); assert.deepEqual(f.commits.at(-1), [field, bounds.default]);
    f.render({ max: bounds.min + 10, value: 0, enabled: false }); assert.equal(f.node().props['aria-valuenow'], bounds.min);
  }
});

test('geometry starts measuring after readiness and disconnects its observer on logout or unmount', () => {
  const h = harness('usePanelGeometry'), surface = { current: null }, props = { surface, preferred: layout.defaultWorkspaceLayout().canvas, mode: 'canvas', scope: 'project-one:canvas', ready: false };
  h.render(props); assert.equal(h.observerCount(), 0);
  surface.current = { clientWidth: 750, clientHeight: 600 };
  h.render({ ...props, ready: true }); const measured = h.render({ ...props, ready: true });
  assert.equal(measured.size.width, 750); assert.equal(measured.narrow, true); assert.equal(h.observerCount(), 1);
  h.render({ ...props, ready: false }); assert.equal(h.observerCount(), 0);
  h.render({ ...props, ready: true }); assert.equal(h.observerCount(), 1);
  h.unmount(); assert.equal(h.observerCount(), 0);
});

test('real React and Base UI render separator, inert boundary, recall button, and closed menu semantics', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)), resolveDir = fileURLToPath(new URL('../apps/web', import.meta.url));
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { PanelBoundary, PanelRecall, PanelResizeHandle, PanelsMenu } from './src/WorkspacePanels.jsx';
    const noop = () => {};
    export const html = renderToStaticMarkup(<>
      <PanelBoundary name="inspector" visible={false} scope="project:canvas"><input defaultValue="Retained draft" /></PanelBoundary>
      <PanelRecall name="inspector" label="属性" icon="settings" onClick={noop} />
      <PanelResizeHandle name="assets" field="assetsWidth" value={242} max={400} scope="project:canvas" onPreview={noop} onCommit={noop} />
      <PanelsMenu mode="canvas" assetsCollapsed inspectorCollapsed={false} storyboardOpen onPanel={noop} onReset={noop} disabled />
    </>);
  `;
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(resolveDir)} }, bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '\"production\"' }, logLevel: 'silent' });
    const { html } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(html); process.exit(0);
  `;
  const html = execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 });
  assert.match(html, /id="dock-inspector"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.match(html, /value="Retained draft"/);
  assert.match(html, /aria-label="展开属性"[^>]*aria-controls="dock-inspector"[^>]*aria-expanded="false"/);
  assert.match(html, /role="separator"[^>]*aria-label="调整素材库宽度"[^>]*aria-orientation="vertical"[^>]*aria-controls="dock-assets"[^>]*aria-valuemin="180"[^>]*aria-valuemax="400"[^>]*aria-valuenow="242"/);
  assert.match(html, /aria-haspopup="menu"/); assert.match(html, /data-testid="panels-menu"/);
  assert.match(html, /disabled=""/); assert.match(html, /data-slot="dropdown-menu-trigger"/);
});

for (const active of ['body', 'trigger']) {
  test(`PanelRecall hands focus to the revealed panel when focus is still on ${active}`, () => {
    const h = harness('PanelRecall'), panel = new Element(), toggle = new Element(), trigger = new Element();
    panel.dataset = { panelScope: 'project-one:canvas', visible: 'false' }; panel.selectors.set('[data-testid=toggle-assets]', toggle);
    h.document.byId.set('dock-assets', panel); h.document.activeElement = active === 'body' ? h.document.body : trigger;
    h.render({ name: 'assets', label: '素材库', icon: 'image', onClick: () => { panel.dataset.visible = 'true'; } });
    h.node('reopen-assets').props.onClick({ currentTarget: trigger }); assert.equal(toggle.focuses, 0);
    h.flushFrames(); assert.equal(toggle.focuses, 1);
  });
}

for (const reason of ['changed scope', 'detached panel', 'still hidden', 'newer focus', 'missing panel']) {
  test(`PanelRecall does not steal focus after ${reason}`, () => {
    const h = harness('PanelRecall'), panel = new Element(), toggle = new Element(), trigger = new Element();
    panel.dataset = { panelScope: 'project-one:canvas', visible: 'false' }; panel.selectors.set('[data-testid=toggle-assets]', toggle);
    if (reason !== 'missing panel') h.document.byId.set('dock-assets', panel);
    h.render({ name: 'assets', label: '素材库', icon: 'image', onClick: () => { panel.dataset.visible = 'true'; } });
    h.node('reopen-assets').props.onClick({ currentTarget: trigger });
    if (reason === 'changed scope') panel.dataset.panelScope = 'project-two:editing';
    if (reason === 'detached panel') panel.isConnected = false;
    if (reason === 'still hidden') panel.dataset.visible = 'false';
    if (reason === 'newer focus') h.document.activeElement = new Element();
    h.flushFrames(); assert.equal(toggle.focuses, 0);
  });
}

test('the supported 1050×680 and larger shell keeps a fixed 44px header without geometry feedback writes', () => {
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../packages/ui/src/styles/globals.css', import.meta.url), 'utf8');
  assert.match(tokens, /--wb-topbar: 44px;/);
  assert.match(css, /\.workbench\.workbench-v2\.dock-workbench\.shell-redesign \{ grid-template-rows: var\(--wb-topbar\) minmax\(0, 1fr\)/);
  for (const mode of ['canvas', 'editing']) for (const width of [1050, 1180, 1440]) for (const height of [680, 814, 900]) {
    const h = harness('usePanelGeometry'), surface = { current: { clientWidth: width, clientHeight: height - 44 } };
    const preferred = layout.defaultWorkspaceLayout()[mode], before = structuredClone(preferred);
    const props = { surface, preferred, mode, scope: `project:${mode}`, ready: true };
    h.render(props); let geometry = h.render(props);
    assert.equal(geometry.narrow, false);
    assert.equal(h.observerCount(), 1);
    const first = geometry.effective;
    h.resize(); geometry = h.render(props);
    assert.deepEqual(geometry.effective, first);
    assert.deepEqual(preferred, before);
    assert.equal(h.observerCreations(), 1);
    h.unmount(); assert.equal(h.observerCount(), 0);
  }
});

test('supported scaled editing windows reserve a 240px physical preview stage without changing saved heights', () => {
  for (const scale of [0.9, 1, 1.25]) for (const [width, height] of [[1050, 680], [1440, 900]]) {
    const h = harness('usePanelGeometry'), preferred = layout.defaultWorkspaceLayout().editing, before = structuredClone(preferred);
    const surface = { current: { clientWidth: width / scale, clientHeight: height / scale - 44 } };
    const props = { surface, preferred, mode: 'editing', scope: `scaled:${scale}`, ready: true };
    h.render(props); const geometry = h.render(props);
    const previewHeight = surface.current.clientHeight - 12 - 6 - geometry.effective.timelineHeight;
    assert.ok((previewHeight - 84) * scale >= 240, `${width}×${height} at ${scale}: stage budget`);
    assert.deepEqual(preferred, before); h.unmount();
  }
});

test('1050px desktop uses two 44px rails at every supported scale, independently of the very narrow fallback', () => {
  for (const scale of [0.9, 1, 1.25]) {
    const h = harness('usePanelGeometry'), preferred = layout.defaultWorkspaceLayout().editing, before = structuredClone(preferred);
    const surface = {current:{clientWidth:1050 / scale, clientHeight:680 / scale - 44, getBoundingClientRect:()=>({width:1050})}};
    const props = {surface, preferred, mode:'editing', scope:'project:editing:gesture', presentationScope:'project:editing'};
    h.render(props); const geometry = h.render(props);
    assert.equal(geometry.narrow,false); assert.equal(geometry.compact,true);
    assert.deepEqual([geometry.effective.assetsWidth,geometry.effective.inspectorWidth],[44,44]);
    assert.deepEqual([geometry.effective.assetsCollapsed,geometry.effective.inspectorCollapsed],[true,true]);
    assert.deepEqual(preferred,before);h.unmount();
  }
  const h=harness('usePanelGeometry'),preferred=layout.defaultWorkspaceLayout().canvas,surface={current:{clientWidth:740,clientHeight:500,getBoundingClientRect:()=>({width:740})}},props={surface,preferred,mode:'canvas',scope:'small'};
  h.render(props);const geometry=h.render(props);assert.equal(geometry.narrow,true);assert.equal(geometry.compact,false);h.unmount();
});

test('compact pinning is transient, survives panel intents, and restores the original wide-window preference', () => {
  const h=harness('usePanelGeometry'),preferred={...layout.defaultWorkspaceLayout().canvas,assetsWidth:360,inspectorWidth:420},before=structuredClone(preferred);
  const surface={current:{clientWidth:1050,clientHeight:636,getBoundingClientRect:()=>({width:surface.current.clientWidth})}},props={surface,preferred,mode:'canvas',scope:'p:canvas:0',presentationScope:'p:canvas'};
  h.render(props);let geometry=h.render(props);const retained=geometry.pinPanel;
  assert.equal(geometry.pinPanel('assets',true),true);geometry=h.render({...props,scope:'p:canvas:1'});
  assert.equal(geometry.effective.assetsCollapsed,false);assert.equal(geometry.effective.assetsWidth,360);assert.equal(geometry.effective.inspectorWidth,44);
  assert.equal(geometry.style['--dock-inspector-preferred'],'420px');assert.deepEqual(preferred,before);
  surface.current.clientWidth=1440;h.resize();geometry=h.render(props);
  assert.equal(geometry.compact,false);assert.deepEqual([geometry.effective.assetsCollapsed,geometry.effective.inspectorCollapsed],[false,false]);
  assert.deepEqual([geometry.effective.assetsWidth,geometry.effective.inspectorWidth],[360,420]);assert.equal(retained('inspector',true),false);
  surface.current.clientWidth=1050;h.resize();geometry=h.render(props);
  assert.deepEqual([geometry.effective.assetsWidth,geometry.effective.inspectorWidth],[44,44],'Returning to compact must not resurrect an old transient pin');
  assert.equal(geometry.pinPanel('inspector',true),true);geometry=h.render({...props,presentationScope:'other-project:canvas'});
  assert.deepEqual([geometry.effective.assetsWidth,geometry.effective.inspectorWidth],[44,44]);assert.deepEqual(preferred,before);h.unmount();
});

test('actual App rail overlay and pin callbacks use presentation state without persisting an automatic collapse', () => {
  const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8'),css=readFileSync(new URL('../apps/web/src/styles.css',import.meta.url),'utf8');
  const start=source.indexOf('  function setPanelOpen('),end=source.indexOf('  const setSelectedId =',start);assert.ok(start>=0&&end>start);
  const h=harness('usePanelGeometry'),preferred=layout.defaultWorkspaceLayout().canvas,before=structuredClone(preferred),surface={current:{clientWidth:1050,clientHeight:636}},props={surface,preferred,mode:'canvas',scope:'p:canvas:0',presentationScope:'p:canvas'};
  h.render(props);let geometry=h.render(props),overlay=null,marks=0;const persisted=[];
  const invoke=()=>{const env={clipDraftRef:{current:null},layoutOwner:'p',layoutOwnerEpoch:1,currentProject:{current:'p'},projectEpoch:{current:1},viewRef:{current:{activeMode:'canvas'}},geometry,
    markPanelIntent(){marks++;},setPanelOverlay(value){overlay=typeof value==='function'?value(overlay):value;},updateView:(...args)=>persisted.push(args),updateModeLayout:(...args)=>persisted.push(args),
    mobilePanel:'canvas',setMobilePanel(){assert.fail('Compact desktop must not enter the old mobile single-panel flow');},workspaceMode:'canvas',data:{project:{id:'p'}},useEffect(){},assetsCollapsed:geometry.effective.assetsCollapsed,inspectorCollapsed:geometry.effective.inspectorCollapsed,timelineCollapsed:false,panelOverlay:overlay,loading:false,
    PanelResizeHandle:'Resize',React:{createElement(){}},panelScope:'p:canvas',defaultWorkspaceLayout:layout.defaultWorkspaceLayout};
    return Function('env',`with(env){${transformSync(source.slice(start,end),{loader:'jsx'}).code};return{setPanelOpen,togglePanelOverlay,panelVisible};}`)(env);};
  let actions=invoke();assert.equal(actions.panelVisible('assets'),false);assert.equal(actions.panelVisible('inspector'),false);assert.equal(actions.panelVisible('canvas'),true);
  actions.togglePanelOverlay('assets');actions=invoke();assert.equal(actions.panelVisible('assets'),true);assert.equal(overlay,'assets');assert.deepEqual(persisted,[]);
  actions.setPanelOpen('assets',true);geometry=h.render({...props,scope:'p:canvas:1'});actions=invoke();assert.equal(overlay,null);assert.equal(actions.panelVisible('assets'),true);assert.equal(actions.panelVisible('inspector'),false);assert.deepEqual(persisted,[]);
  actions.setPanelOpen('assets',false);geometry=h.render(props);assert.equal(geometry.effective.assetsWidth,44);assert.deepEqual(preferred,before);assert.deepEqual(persisted,[]);assert.equal(marks,3);
  assert.match(source,/\{assetsCollapsed && <PanelRecall name="assets"/);assert.match(source,/\{inspectorCollapsed && <PanelRecall name="inspector"/);
  assert.match(source,/const \{ assetsCollapsed, inspectorCollapsed \} = geometry\.effective/);
  assert.match(css,/\.shell-redesign\.dock-compact \.dock-recall:not\(\.recall-timeline\) > span/);h.unmount();
});

test('actual App desktop collapse retains the toolbar container, hides body and resize, and restores the current timeline view', () => {
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  function setPanelOpen('), end = source.indexOf('  const setSelectedId =', start);
  assert.ok(start >= 0 && end > start);
  const viewRef = {current:{activeMode:'editing',editing:{timelineCollapsed:true,selectedClipId:'clip-one'}}};
  const currentProject = {current:'project-one'}, projectEpoch = {current:1};
  const composing = {current:false}, writes = [], sizes = []; let marks = 0;
  function render({narrow = false, mode = 'editing'} = {}) {
    const env = {viewRef,currentProject,projectEpoch,layoutOwner:'project-one',layoutOwnerEpoch:1,workspaceMode:mode,
      clipDraftRef:{current:{hasPendingComposition:()=>composing.current}},
      geometry:{narrow,effective:{timelineHeight:160},maxima:{timelineHeight:500},size:{width:narrow?740:1050,height:636},preview(){}},
      timelineCollapsed:viewRef.current.editing.timelineCollapsed,assetsCollapsed:true,inspectorCollapsed:true,panelOverlay:null,mobilePanel:'canvas',loading:false,data:{project:{id:'project-one'}},
      markPanelIntent(){marks++;},setPanelOverlay(){},updateView(section,patch){writes.push([section,patch]);Object.assign(viewRef.current[section],patch);},updateModeLayout(...args){sizes.push(args);},
      setMobilePanel(){},defaultWorkspaceLayout:layout.defaultWorkspaceLayout,useEffect(){},PanelResizeHandle:'Resize',panelScope:'project-one:editing',
      React:{createElement:(type,props)=>({type,props})}};
    return Function('env',`with(env){${transformSync(source.slice(start,end),{loader:'jsx'}).code};return{toggleTimelinePanel,panelVisible,timelineContainerVisible,resizeHandle};}`)(env);
  }
  const collapsed = render(), retainedToggle = collapsed.toggleTimelinePanel;
  assert.equal(collapsed.timelineContainerVisible,true,'Desktop toolbar remains in its existing PanelBoundary');
  assert.equal(collapsed.panelVisible('timeline'),false,'Hidden body does not become visible merely to expose the toolbar');
  assert.equal(collapsed.resizeHandle('timeline','timelineHeight').props.enabled,false);
  retainedToggle();
  assert.deepEqual(writes,[['editing',{timelineCollapsed:false}]]);
  assert.equal(viewRef.current.editing.selectedClipId,'clip-one');assert.deepEqual(sizes,[]);
  const expanded = render();assert.equal(expanded.timelineContainerVisible,true);assert.equal(expanded.panelVisible('timeline'),true);
  assert.equal(expanded.resizeHandle('timeline','timelineHeight').props.enabled,true);
  // A retained event callback reads the current state instead of replaying its
  // captured collapsed value over a newer panel intent.
  retainedToggle();assert.equal(viewRef.current.editing.timelineCollapsed,true);assert.equal(marks,2);
  const before = writes.length;
  composing.current=true;render().toggleTimelinePanel();assert.equal(writes.length,before);composing.current=false;
  currentProject.current='project-two';retainedToggle();assert.equal(writes.length,before);currentProject.current='project-one';
  projectEpoch.current=2;retainedToggle();assert.equal(writes.length,before);projectEpoch.current=1;
  viewRef.current.activeMode='canvas';retainedToggle();assert.equal(writes.length,before);viewRef.current.activeMode='editing';
  const narrow = render({narrow:true});assert.equal(narrow.timelineContainerVisible,false);assert.equal(narrow.panelVisible('timeline'),false);
  assert.equal(narrow.resizeHandle('timeline','timelineHeight').props.enabled,false);
  assert.match(source, /<PanelBoundary name="timeline" visible=\{timelineContainerVisible\}/);
  assert.match(source, /presentationVisible=\{timelineContainerVisible\} visible=\{panelVisible\('timeline'\)\} collapsed=\{timelineCollapsed\} onCollapse=\{toggleTimelinePanel\}/);
  assert.match(source, /\{timelineCollapsed && geometry\.narrow && <PanelRecall name="timeline"/);
  assert.doesNotMatch(source, /timelineCollapsed\s*\?[^\n]*<Timeline/,'Collapse keeps one Timeline instance rather than replacing it');
});
