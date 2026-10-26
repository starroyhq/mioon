import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import type { ProjectWindowContext } from '../apps/web/src/desktop-window-client.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { createNativeCloseRegistry, installNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import type { createNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createSettingsWindowNavigation } from '../apps/web/src/settings-window-state.ts';
import type { SettingsRenderProps } from '../apps/web/src/SettingsRoot.tsx';

interface Node { type: unknown; key: unknown; props: Record<string, unknown> & { children?: unknown } }
interface Effect { deps: readonly unknown[]; cleanup?: void | (() => void) }
function hooks() {
  const slots: unknown[] = [], effects = new Map<number, Effect>(), pending: Array<() => void> = [];
  let cursor = 0;
  const useEffect = (callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = cursor++, previous = effects.get(index);
    if (previous && deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps[at]))) return;
    pending.push(() => { previous?.cleanup?.(); effects.set(index, { deps, cleanup: callback() }); });
  };
  const react = {
    Fragment: 'Fragment',
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node {
      return { type, key: props?.key ?? null, props: { ...props, children: children.length === 1 ? children[0] : children } };
    },
    useRef(value: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index]; },
    useState(value: unknown) {
      const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect, useLayoutEffect: useEffect,
  };
  return { react, begin() { cursor = 0; }, flush() { pending.splice(0).forEach(run => run()); }, dispose() { effects.forEach(effect => effect.cleanup?.()); effects.clear(); } };
}
function load(filename: string, react: ReturnType<typeof hooks>['react'], dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): (props: Record<string, unknown>) => Node {
  const module: { exports: { default?: (props: Record<string, unknown>) => Node } } = { exports: {} };
  Function('require', 'module', 'exports', ...Object.keys(globals), transformSync(readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)((name: string) => {
    if (name === 'react') return react;
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  assert.ok(module.exports.default); return module.exports.default;
}
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && 'props' in tree ? [tree as Node, ...nodes((tree as Node).props.children)] : [];
}
const find = (tree: Node, id: string): Node => { const node = nodes(tree).find(item => item.props['data-testid'] === id); assert.ok(node, id); return node; };
class Events {
  listeners = new Map<string, Array<{ listener: () => void; capture: boolean }>>();
  addEventListener(type: string, listener: () => void, capture = false) { const items = this.listeners.get(type) ?? []; items.push({ listener, capture }); this.listeners.set(type, items); }
  removeEventListener(type: string, listener: () => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item.listener !== listener)); }
  emit(type: string) { for (const { listener } of this.listeners.get(type) ?? []) listener(); }
}
class Element {
  parent: Element | null = null; isConnected = true; inert = false; hidden = false; disabled = false; focuses = 0; blurs = 0;
  readonly ownerDocument: Document;
  constructor(ownerDocument: Document) { this.ownerDocument = ownerDocument; }
  contains(other: Element | null): boolean { for (let item = other; item; item = item.parent) if (item === this) return true; return false; }
  closest() { for (let item: Element | null = this; item; item = item.parent) if (item.inert || item.hidden) return item; return null; }
  matches() { return this.disabled; }
  focus() { this.focuses++; this.ownerDocument.activeElement = this; }
  blur() { this.blurs++; this.ownerDocument.activeElement = this.ownerDocument.body; }
}
class Document extends Events {
  defaultView = new Events(); body = new Element(this); documentElement = new Element(this); activeElement: Element = this.body; focused = true;
  hasFocus() { return this.focused; }
}
function backdrop() {
  const h = hooks(), document = new Document(), surface = new Element(document), input = new Element(document), child = { type: 'editor-owner', key: 'editor', props: { draft: 'retained unsent draft' } };
  input.parent = surface; surface.parent = document.body;
  const Component = load('NativeSettingsBackdrop.tsx', h.react, {}, { HTMLElement: Element });
  let tree: Node;
  const render = (blocked: boolean) => {
    h.begin(); tree = Component({ blocked, children: child }); const root = find(tree, 'native-settings-parent-surface');
    (root.props.ref as { current: Element }).current = surface; surface.inert = root.props.inert === true;
    // The browser can blur a control as soon as React applies inert, before
    // layout effects. Focus capture must retain its original owner anyway.
    if (surface.inert && surface.contains(document.activeElement)) document.activeElement.blur();
    h.flush(); return tree;
  };
  const focus = () => { input.focus(); (find(tree, 'native-settings-parent-surface').props.onFocusCapture as (event: { target: Element }) => void)({ target: input }); };
  return { document, surface, input, child, render, focus, dispose: h.dispose };
}

test('native backdrop keeps the exact editor subtree and draft while blocking DOM and document shortcuts', () => {
  const f = backdrop(); let tree = f.render(false);
  assert.equal(find(tree, 'native-settings-parent-surface').props.children, f.child); assert.equal(f.input.focuses, 0);
  f.focus(); tree = f.render(true);
  const surface = find(tree, 'native-settings-parent-surface'); assert.equal(surface.props.children, f.child);
  assert.equal(surface.props.inert, true); assert.equal(surface.props['aria-hidden'], true); assert.ok(find(tree, 'native-settings-modal-backdrop'));
  const portal = new Element(f.document); portal.parent = f.document.body;
  assert.equal(f.document.body.inert, true); assert.equal(portal.closest(), f.document.body, 'portaled dialogs are inert in the parent document too');
  assert.equal(f.child.props.draft, 'retained unsent draft'); assert.equal(f.input.blurs, 1);
  const listener = f.document.listeners.get('keydown')![0]; assert.equal(listener.capture, true);
  let prevented = 0, stopped = 0;
  (listener.listener as (event: { preventDefault(): void; stopImmediatePropagation(): void }) => void)({ preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  f.render(true); assert.equal(f.document.listeners.get('keydown')!.length, 1, 'closing confirmation/repeated context cannot release the parent');
  tree = f.render(false); assert.equal(find(tree, 'native-settings-parent-surface').props.children, f.child);
  assert.equal(find(tree, 'native-settings-parent-surface').props.inert, false); assert.equal(f.document.listeners.get('keydown')!.length, 0); assert.equal(f.document.body.inert, false);
  assert.equal(f.input.focuses, 2, 'real modal close restores its former control once'); f.dispose();
});

test('focus restoration waits for its own window and obsolete callbacks cannot steal focus after reopen or disposal', () => {
  const f = backdrop(); f.render(false); f.focus(); f.render(true); f.document.focused = false; f.render(false);
  assert.equal(f.input.focuses, 1); const stale = f.document.defaultView.listeners.get('focus')![0].listener;
  f.render(true); f.document.focused = true; stale(); assert.equal(f.input.focuses, 1);
  f.document.focused = false; f.render(false); assert.equal(f.document.defaultView.listeners.get('focus')!.length, 1);
  f.document.focused = true; f.document.defaultView.emit('focus'); assert.equal(f.input.focuses, 2);
  f.render(true); f.document.focused = false; f.render(false); const disposed = f.document.defaultView.listeners.get('focus')![0].listener;
  f.dispose(); f.document.focused = true; disposed(); assert.equal(f.input.focuses, 2);
});

test('modal close never focuses a disconnected, hidden, disabled or superseded control', () => {
  for (const change of ['removed', 'hidden', 'disabled', 'new-choice'] as const) {
    const f = backdrop(); f.render(false); f.focus(); f.render(true);
    if (change === 'removed') f.input.isConnected = false;
    if (change === 'hidden') f.input.hidden = true;
    if (change === 'disabled') f.input.disabled = true;
    if (change === 'new-choice') f.document.activeElement = new Element(f.document);
    f.render(false); assert.equal(f.input.focuses, 1, change); f.dispose();
  }
});

test('portaled controls retain focus ownership and a prior body inert state is not cleared', () => {
  const f = backdrop(); f.render(false); f.input.parent = f.document.body; f.input.focus(); f.render(true);
  assert.equal(f.input.blurs, 1); assert.equal(f.document.body.inert, true);
  f.render(false); assert.equal(f.input.focuses, 2, 'a retained parent popup can regain its exact control'); f.dispose();
  const blocked = backdrop(); blocked.render(false); blocked.document.body.inert = true; blocked.render(true); blocked.render(false);
  assert.equal(blocked.document.body.inert, true, 'another owner already had the parent document inert'); blocked.dispose();
});

const id = (number: number) => `92000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const context = (patch: Partial<ProjectWindowContext> = {}): ProjectWindowContext => ({ version: 2, role: 'editor', windowId: id(1), contextId: id(2), backendId: id(3), initialProjectId: id(4), autoOpen: false,
  editorProjectId: id(4), editorPhase: 'ready', editorCount: 1, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0,
  selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch });

test('DesktopRoot applies only its verified modal flag without replacing its editor owner or accepting stale unlocks', async () => {
  const h = hooks(), initial = Promise.withResolvers<ProjectWindowContext>();
  let receive!: (context: unknown) => void;
  const native = { context: () => initial.promise, subscribe(listener: (context: unknown) => void) { receive = listener; return () => {}; },
    openProject() {}, publishLocatorStatus() {}, requestLocatorAction() {}, requestProjectEntry() {}, showProjects() {}, showSettings() {}, closeSettings() {}, editorStatus() {} };
  const Component = load('DesktopRoot.tsx', h.react, {
    './i18n/I18nProvider.tsx': i18nTestModule(), './desktop-window-client.ts': { readDesktopWindowBridge },
    './LauncherRoot.tsx': { __esModule: true, default: 'launcher' }, './SettingsRoot.tsx': { __esModule: true, default: 'settings' },
    './NativeEditorRoot.tsx': { __esModule: true, default: 'editor' }, './NativeSettingsBackdrop.tsx': { __esModule: true, default: 'backdrop' },
  }, { window: { __mioonProjectWindow: native } });
  const render = () => { h.begin(); const tree = Component({ rpc() {}, contractChecks: {}, renderWeb() {}, renderEditor() {}, renderSettings() {} }); h.flush(); return tree; };
  render(); receive(context()); const before = render(); assert.equal(before.type, 'backdrop'); assert.equal(before.props.blocked, false);
  receive(context({ settingsModalOpen: true })); const blocked = render(); assert.equal(blocked.key, before.key); assert.equal(blocked.props.blocked, true);
  assert.equal((blocked.props.children as Node).type, 'editor'); assert.equal((blocked.props.children as Node).key, (before.props.children as Node).key);
  for (const foreign of [{ contextId: id(8) }, { windowId: id(8) }, { backendId: id(8) }]) { receive(context({ ...foreign, settingsModalOpen: false })); assert.equal(render().props.blocked, true); }
  receive({ ...context(), settingsModalOpen: 'false' }); assert.equal(render().props.blocked, true);
  initial.resolve(context()); await new Promise(resolve => setImmediate(resolve)); assert.equal(render().props.blocked, true, 'late initial read cannot undo a newer modal context');
  receive(context({ settingsModalOpen: false })); assert.equal(render().props.blocked, false); h.dispose();
});

async function settingsPanel(onClose: (page: { __mioonNativeCloseAdmission?: ReturnType<typeof createNativeCloseAdmission> }) => Promise<boolean>) {
  class Page extends Events {
    location = { href: 'http://127.0.0.1:44123/' }; closeCalls = 0;
    __mioonNativeCloseAdmission?: ReturnType<typeof createNativeCloseAdmission>;
    close() { this.closeCalls++; assert.fail('Renderer window.close must not bypass main-side close admission'); }
  }
  const h = hooks(), page = new Page(), document = Object.assign(new Document(), { visibilityState: 'visible' });
  const observation: boolean[] = [], pauseObservation = (paused: boolean) => { observation.push(paused); };
  const marker = { type: 'retained-settings-form', key: 'settings', props: { draft: 'synthetic unsaved key draft' } };
  let props: SettingsRenderProps | undefined;
  let owner: ReturnType<ReturnType<typeof createSettingsNavigationRegistry>['register']> | undefined;
  const Component = load('SettingsRoot.tsx', h.react, {
    './i18n/I18nProvider.tsx': i18nTestModule(), '@mioon/ui/components/workbench-confirm': { useConfirmation: () => async () => false },
    './UiPreferencesProvider.tsx': { useUiPreferences: () => ({ pauseObservation }) },
    './settings-navigation-state.ts': { createSettingsNavigationRegistry }, './native-close-state.ts': { createNativeCloseRegistry, installNativeCloseAdmission },
    './settings-window-state.ts': { createSettingsWindowNavigation }, './launcher-state.ts': { createLauncherClient: () => ({ inspect: async () => ({ restored: false }) }) },
    './ProjectHomeConnections.tsx': { __esModule: true, default: 'connection-shell' }, './NativeLocatorStatus.tsx': { __esModule: true, default: 'locator-status' },
    '@mioon/ui/components/button': { Button: 'Button' }, '@mioon/ui/components/workbench-icons': { WorkbenchIcon: 'WorkbenchIcon' },
  }, { window: page, document });
  const settings = context({ role: 'settings', initialProjectId: null, editorProjectId: null, editorPhase: 'none', settingsSlot: 'agent', settingsVersion: 1 });
  let requests = 0;
  const bridge = { subscribe: () => () => {}, closeSettings: () => { requests++; return onClose(page); } };
  const render = () => {
    h.begin(); const tree = Component({ context: settings, bridge, rpc() {}, contractChecks: {}, renderSettings(next: SettingsRenderProps) {
      props = next; owner ??= next.registry.register('retained-form'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 }); return marker;
    } }); h.flush(); return tree;
  };
  render(); await new Promise(resolve => setImmediate(resolve)); const tree = render();
  assert.ok(props); assert.ok(nodes(tree).includes(marker));
  return { render, page, marker, props, observation, button: find(tree, 'native-settings-panel-close').props.onClick as () => void, dispose: h.dispose, get requests() { return requests; } };
}

test('SettingsRoot requests main-side closure before renderer unload and cancelled native admission retains dirty owners', async () => {
  const f = await settingsPanel(async page => {
    const admission = page.__mioonNativeCloseAdmission!;
    const inspected = admission.inspect(); assert.equal(inspected.disposition, 'dirty');
    assert.equal(admission.cancel(inspected.token), true);
    return true; // IPC accepted the request; the native discard was cancelled.
  });
  const before = f.props.registry.capture(); f.button(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests, 1); assert.equal(f.page.closeCalls, 0); assert.deepEqual(f.props.registry.capture(), before);
  assert.deepEqual(f.observation, [true, false], 'the real native cancellation releases only its own observation pause');
  assert.ok(nodes(f.render()).includes(f.marker)); assert.equal(nodes(f.render()).some(node => node.props['data-testid'] === 'native-settings-close-failed'), false);
  assert.equal(await f.props.beforeClose(), false); assert.equal(f.requests, 2); assert.deepEqual(f.props.registry.capture(), before);
  assert.equal(f.marker.props.draft, 'synthetic unsaved key draft'); f.dispose(); assert.equal(f.page.__mioonNativeCloseAdmission, undefined);
  assert.equal(f.observation.at(-1), false, 'effect cleanup releases observation on disposal too');
});

test('SettingsRoot releases an outstanding native observation pause when its document owner is disposed', async () => {
  const f = await settingsPanel(async page => {
    assert.equal(page.__mioonNativeCloseAdmission!.inspect().disposition, 'dirty');
    return true;
  });
  f.button(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.observation, [true]); const before = f.props.registry.capture();
  f.render(); assert.deepEqual(f.observation, [true], 'rerender keeps the current native admission and preference observer');
  assert.deepEqual(f.props.registry.capture(), before);
  f.dispose(); assert.deepEqual(f.observation, [true, false]);
  assert.equal(f.page.__mioonNativeCloseAdmission, undefined);
});

test('native close requests coalesce while pending and rejection keeps the same dirty settings form without fallback', async () => {
  for (const failure of [false, new Error('PRIVATE native IPC diagnostic')]) {
    const gate = Promise.withResolvers<boolean>(), f = await settingsPanel(() => gate.promise);
    const before = f.props.registry.capture(); f.button(); f.button(); const back = f.props.beforeClose();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests, 1);
    if (failure instanceof Error) gate.reject(failure); else gate.resolve(failure);
    assert.equal(await back, false); const failed = find(f.render(), 'native-settings-close-failed');
    assert.equal(failed.props.role, 'alert'); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
    assert.deepEqual(f.props.registry.capture(), before); assert.equal(f.page.closeCalls, 0); assert.ok(nodes(f.render()).includes(f.marker));
    f.dispose(); f.button(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests, 1, 'retired close callback cannot address a new native owner');
  }
});
