import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as layout from '../apps/web/src/workspace-layout.js';

// Deterministic component-level lifecycle tests, not a substitute for browser
// keyboard, pointer-capture, or real Base UI portal acceptance.
const code = transformSync(readFileSync(new URL('../apps/web/src/WorkspacePanels.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
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
  const Component = name === 'usePanelGeometry' ? props => module.exports.usePanelGeometry(props.surface, props.preferred, props.mode, props.scope, props.ready) : module.exports[name];
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
  const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
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

test('narrow/wide header-height feedback settles within two measurements across 300–900px outer heights', () => {
  // This models the fixed outer CSS rows and the actual geometry hook. It is
  // not evidence about Chromium rendering, compositor, or extension crashes.
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  const wideHeader = Number(css.match(/\.workbench\.workbench-v2\.dock-workbench\{[^}]*grid-template-rows:(\d+)px minmax\(0,1fr\)/)?.[1]);
  const narrowRows = css.match(/\.workbench\.workbench-v2\.dock-workbench\.dock-narrow\{grid-template-rows:(\d+)px minmax\(0,1fr\) (\d+)px\}/);
  const narrowFixed = Number(narrowRows?.[1]) + Number(narrowRows?.[2]);
  assert.equal(wideHeader, 60); assert.equal(narrowFixed, 124);
  for (const mode of ['canvas', 'editing']) for (let outerHeight = 300; outerHeight <= 900; outerHeight++) {
    for (const [fromWidth, toWidth] of [[500, 1180], [1180, 500]]) {
      const h = harness('usePanelGeometry'), surface = { current: { clientWidth: fromWidth, clientHeight: outerHeight - wideHeader } };
      const props = { surface, preferred: layout.defaultWorkspaceLayout()[mode], mode, scope: `project:${mode}`, ready: true };
      h.render(props); let geometry = h.render(props);
      function settle(width) {
        for (let pass = 1; pass <= 2; pass++) {
          const previousNarrow = geometry.narrow;
          surface.current.clientWidth = width;
          surface.current.clientHeight = Math.max(0, outerHeight - (previousNarrow ? narrowFixed : wideHeader));
          h.resize(); geometry = h.render(props);
          assert.equal(h.observerCount(), 1); assert.equal(h.observerCreations(), 1);
          if (geometry.narrow === previousNarrow) return pass;
        }
        assert.fail(`Unsettled ${mode} ${fromWidth}→${width} at outer height ${outerHeight}`);
      }
      settle(fromWidth); settle(toWidth);
      assert.equal(geometry.narrow, toWidth === 500 || outerHeight < 460 + narrowFixed);
      // A redundant observer delivery must retain the same class and observer.
      const settled = geometry.narrow; h.resize(); geometry = h.render(props); assert.equal(geometry.narrow, settled);
      h.unmount(); assert.equal(h.observerCount(), 0);
    }
  }
});
