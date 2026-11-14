import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import type { ProjectWindowContext } from '../apps/web/src/desktop-window-client.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { createNativeCloseRegistry, installNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import type { createNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import { installSettingsBootClose, retireSettingsBootClose } from '../apps/web/src/settings-boot-close.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createSettingsWindowNavigation } from '../apps/web/src/settings-window-state.ts';
import type { SettingsRenderProps } from '../apps/web/src/SettingsRoot.tsx';
import {createSettingsWorkspaceIdentityOwner} from '../apps/web/src/project-entry-identity.ts';
import type {SettingsWorkspaceIdentityOwner} from '../apps/web/src/project-entry-identity.ts';
import * as settingsLocale from '../packages/i18n/src/locale.ts';
import {settingsBootMessages} from '../packages/i18n/src/catalogs/settings-boot.ts';
import type {SettingsDiagnosticsBridge} from '../apps/desktop/src/settings-diagnostics-protocol.ts';
import {markSettingsClick, measureSettingsRead} from '../apps/web/src/settings-diagnostics.ts';

interface Node { type: unknown; key: unknown; props: Record<string, unknown> & { children?: unknown } }
interface Effect { deps: readonly unknown[]; cleanup?: void | (() => void) }
function hooks() {
  const slots: unknown[] = [], effects = new Map<number, Effect>(), pending: Array<() => void> = [];
  let cursor = 0, updates = 0;
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
      return [slots[index], (next: unknown) => {updates++; slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useEffect, useLayoutEffect: useEffect,
  };
  return { react, begin() { cursor = 0; }, flush() { pending.splice(0).forEach(run => run()); }, dispose() { effects.forEach(effect => effect.cleanup?.()); effects.clear(); }, get updates() {return updates;} };
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

function executeBoot(appearance: unknown, bridge?: SettingsDiagnosticsBridge, native = true) {
  const source = readFileSync(new URL('../apps/web/src/settings-boot.ts', import.meta.url), 'utf8');
  const bootstrap = Promise.withResolvers();
  const bootCalls: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const elements = new Map(['settings-boot', 'settings-boot-title', 'settings-boot-status', 'settings-boot-close'].map(id => [id, {
    textContent: '', hidden: true, addEventListener(type: string, callback: () => void) {
      assert.equal(id, 'settings-boot-close'); assert.equal(type, 'click'); closeHandlers.push(callback);
    },
  }]));
  const classes = new Set<string>();
  const root = {lang: 'en', dataset: {} as {theme?: string}, style: {} as {colorScheme?: string},
    classList: {toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); }}};
  let receive: ((next: ProjectWindowContext) => void) | undefined;
  const host = {
    __mioonSettingsBootAppearance: appearance,
    __mioonSettingsDiagnostics: bridge,
    ...(native ? {__mioonProjectWindow: {
      subscribe(callback: (next: ProjectWindowContext) => void) { receive = callback; return () => { bootCalls.push('unsubscribe'); }; },
      context() { assert.fail('An idle shell may not call describe'); },
      async closeSettings() { bootCalls.push('close-request'); return true; },
    }} : {}),
  };
  const code = transformSync(source.replace("import('./main.tsx')", 'loadMain()'), {loader: 'ts', format: 'cjs'}).code;
  Function('require', 'window', 'document', 'navigator', 'loadMain', code)((name: string) => {
    if (name.endsWith('/locale.ts')) return settingsLocale;
    if (name.endsWith('/settings-boot.ts')) return {settingsBootMessages};
    assert.equal(name, './settings-boot-close.ts');
    return {installSettingsBootClose(value: unknown) { assert.equal(value, host); bootCalls.push('close-installed'); }};
  }, host, {documentElement: root, getElementById: (name: string) => elements.get(name)}, {languages: ['en-US']},
  () => { bootCalls.push('import'); return bootstrap.promise; });
  return {root, classes, bootCalls, elements, bootstrap, closeHandlers, receive: (next: ProjectWindowContext) => receive?.(next)};
}

test('prewarmed settings paint the selected locale and theme and import only after the active document ACK', async () => {
  const ack = Promise.withResolvers<boolean>(), marks: string[] = [];
  const boot = executeBoot({locale: 'zh-Hant', theme: 'light'}, {
    markBoot(phase) { marks.push(phase); return phase === 'start' ? ack.promise : Promise.resolve(true); },
    markClick() { assert.fail('A settings document cannot mark a click'); },
    markRead() { assert.fail('An idle shell cannot read settings'); },
  });
  assert.equal(boot.root.lang, 'zh-Hant');
  assert.equal(boot.root.dataset.theme, 'light');
  assert.equal(boot.root.style.colorScheme, 'light');
  assert.deepEqual([...boot.classes], ['light']);
  assert.equal(boot.elements.get('settings-boot-title')?.textContent, '設定');
  assert.equal(boot.elements.get('settings-boot-status')?.textContent, '正在載入設定…');
  assert.equal(boot.elements.get('settings-boot')?.hidden, false);
  assert.equal(boot.elements.get('settings-boot-close')?.hidden, true);
  const html = readFileSync(new URL('../apps/web/settings.html', import.meta.url), 'utf8');
  assert.match(html, /<main id="settings-boot" hidden>/);
  assert.match(html, /#settings-boot\[hidden\]\s*\{\s*display:\s*none/);
  assert.deepEqual(boot.bootCalls, ['close-installed']);
  boot.receive(context({settingsSlot: 'general'}));
  boot.receive(context({role: 'settings', settingsSlot: 'general', quitting: true}));
  assert.deepEqual(marks, []);
  const active = context({role: 'settings', settingsSlot: 'general'});
  boot.receive(active); boot.receive(active);
  assert.deepEqual(marks, ['start']);
  assert.deepEqual(boot.bootCalls, ['close-installed']);
  ack.resolve(true);
  await new Promise(setImmediate);
  assert.deepEqual(boot.bootCalls, ['close-installed', 'unsubscribe', 'import']);
  assert.equal(boot.elements.get('settings-boot-close')?.textContent, '關閉設定視窗');
  boot.bootstrap.resolve(undefined);
  await new Promise(setImmediate);
  assert.deepEqual(marks, ['start', 'import', 'ready']);
});

test('a refused boot does not import and failures stay localized and closable', async () => {
  for (const admission of ['refused', 'unavailable', 'accepted'] as const) {
    const accepted = admission === 'accepted';
    const marks: string[] = [];
    const boot = executeBoot({locale: 'ja', theme: 'dark'}, {
      async markBoot(phase) {
        marks.push(phase);
        if (admission === 'unavailable') throw Error('synthetic activation transport failure');
        return accepted;
      },
      markClick() {}, markRead() {},
    });
    boot.receive(context({role: 'settings', settingsSlot: 'general'}));
    await new Promise(setImmediate);
    assert.equal(boot.bootCalls.includes('import'), accepted);
    if (accepted) {
      boot.bootstrap.reject(Error('synthetic import failure'));
      await new Promise(setImmediate);
    }
    assert.equal(boot.elements.get('settings-boot-status')?.textContent, '設定を読み込めませんでした。');
    assert.equal(boot.elements.get('settings-boot-close')?.hidden, false);
    assert.deepEqual(marks, accepted ? ['start', 'import', 'failed'] : ['start']);
  }
  const browser = executeBoot(undefined, undefined, false);
  assert.equal(browser.root.lang, 'en');
  assert.deepEqual(browser.bootCalls, ['import']);
  browser.bootstrap.resolve(undefined);
});

test('an ACK denied during quit retries once the active owner returns without duplicating the close listener', async () => {
  for (const resumeBeforeDenial of [true, false]) {
    const first = Promise.withResolvers<boolean>(), marks: string[] = [];
    let admissions = 0;
    const boot = executeBoot({locale: 'ja', theme: 'dark'}, {
      markBoot(phase) {
        marks.push(phase);
        if (phase === 'start' && admissions++ === 0) return first.promise;
        return Promise.resolve(true);
      },
      markClick() {}, markRead() {},
    });
    const active = context({role: 'settings', settingsSlot: 'general', settingsVersion: 1});
    boot.receive(active);
    boot.receive(active);
    boot.receive({...active, quitting: true});
    if (resumeBeforeDenial) boot.receive(active);
    assert.deepEqual(marks, ['start']);
    first.resolve(false);
    await new Promise(setImmediate);
    if (!resumeBeforeDenial) {
      assert.deepEqual(marks, ['start']);
      assert.equal(boot.elements.get('settings-boot-status')?.textContent, '設定を読み込めませんでした。');
      boot.receive(active);
      await new Promise(setImmediate);
    }
    assert.deepEqual(marks, ['start', 'start', 'import']);
    assert.equal(boot.elements.get('settings-boot-status')?.textContent, '設定を読み込んでいます…');
    assert.deepEqual(boot.bootCalls, ['close-installed', 'unsubscribe', 'import']);
    assert.equal(boot.closeHandlers.length, 1);
    boot.closeHandlers[0]!();
    assert.deepEqual(boot.bootCalls, ['close-installed', 'unsubscribe', 'import', 'close-request']);
    boot.bootstrap.resolve(undefined);
    await new Promise(setImmediate);
    assert.deepEqual(marks, ['start', 'start', 'import', 'ready']);
  }
});

test('trusted click uses the browser event timestamp and simultaneous reads pair their own terminal marks', async t => {
  const events: unknown[][] = [];
  const bridge = {
    markClick: at => { events.push(['click', at]); },
    async markBoot() { return true; },
    markRead: (page, phase, id, at) => { events.push([page, phase, id, at]); },
  } satisfies SettingsDiagnosticsBridge;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const host: {__mioonSettingsDiagnostics: SettingsDiagnosticsBridge; __mioonSettingsBootAppearance?: unknown} = {__mioonSettingsDiagnostics: bridge};
  Object.defineProperty(globalThis, 'window', {configurable: true, value: host});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const timeStamp = Math.max(1, performance.now() - 50);
  markSettingsClick({isTrusted: false, timeStamp});
  markSettingsClick({isTrusted: true, timeStamp: Number.NaN});
  markSettingsClick({isTrusted: true, timeStamp});
  assert.deepEqual(events, [['click', Math.floor(performance.timeOrigin + timeStamp)]]);
  assert.equal(await measureSettingsRead('appearance', async () => 'editor'), 'editor');
  assert.equal(events.length, 1, 'settings helpers used by an editor emit no read timing');
  host.__mioonSettingsBootAppearance = {locale: 'en', theme: 'dark'};

  const left = Promise.withResolvers<string>(), right = Promise.withResolvers<string>();
  const a = measureSettingsRead('appearance', () => left.promise);
  const b = measureSettingsRead('appearance', () => right.promise);
  assert.equal(events.length, 3);
  const first = events[1]!, second = events[2]!;
  assert.deepEqual(first.slice(0, 2), ['appearance', 'start']);
  assert.deepEqual(second.slice(0, 2), ['appearance', 'start']);
  assert.notEqual(first[2], second[2]);
  const failure = Error('synthetic read failure');
  right.reject(failure); await assert.rejects(b, error => error === failure);
  left.resolve('result'); assert.equal(await a, 'result');
  assert.deepEqual(events.slice(3).map(event => event.slice(0, 3)), [
    ['appearance', 'end', second[2]], ['appearance', 'end', first[2]],
  ]);
  assert.ok(Number(events[3]![3]) >= Number(second[3]));
  assert.ok(Number(events[4]![3]) >= Number(first[3]));
});

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

class SettingsPage extends EventTarget {
  location = { href: 'http://127.0.0.1:44123/settings.html' }; closeCalls = 0;
  __mioonNativeCloseAdmission?: ReturnType<typeof createNativeCloseAdmission>;
  __mioonFlushWorkspacePreferences?: () => Promise<boolean>;
  close() { this.closeCalls++; assert.fail('Renderer window.close must not bypass main-side close admission'); }
  beforeUnload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
    return this.dispatchEvent(event);
  }
}

async function settingsPanel(onClose: (page: SettingsPage) => Promise<boolean>, options: {
  initialSlot?: ProjectWindowContext['settingsSlot']; confirm?: () => Promise<boolean>; page?: SettingsPage;
  readIdentity?: (input: {readonly signal: AbortSignal}) => Promise<unknown>;
} = {}) {
  const h = hooks(), page = options.page ?? new SettingsPage(), document = Object.assign(new Document(), { visibilityState: 'visible' });
  const observation: boolean[] = [], pauseObservation = (paused: boolean) => { observation.push(paused); };
  const password = {value: 'SYNTHETIC_RETAINED_NATIVE_KEY'}, input = {type: 'input', key: 'key', props: {'data-testid': 'retained-native-key', ref: {current: password}}};
  const marker = { type: 'retained-settings-form', key: 'settings', props: { draft: 'synthetic unsaved key draft', children: [input] } };
  let locale: import('../packages/i18n/src/index.ts').Locale = 'zh-Hans';
  let props: SettingsRenderProps | undefined;
  let owner: ReturnType<ReturnType<typeof createSettingsNavigationRegistry>['register']> | undefined;
  let identity!: SettingsWorkspaceIdentityOwner, identityReads = 0;
  let workspaceIdentity: unknown = {appLibraryScope: 'a'.repeat(64), instanceId: id(900)};
  const Component = load('SettingsRoot.tsx', h.react, {
    './i18n/I18nProvider.tsx': {useI18n: () => i18nTestModule(locale).useI18n()}, '@mioon/ui/components/workbench-confirm': { useConfirmation: () => options.confirm ?? (async () => false) },
    './UiPreferencesProvider.tsx': { useUiPreferences: () => ({ pauseObservation }) },
    './settings-navigation-state.ts': { createSettingsNavigationRegistry }, './native-close-state.ts': { createNativeCloseRegistry, installNativeCloseAdmission },
    './settings-boot-close.ts': { retireSettingsBootClose },
    './settings-window-state.ts': { createSettingsWindowNavigation },
    './project-entry-identity.ts': {createSettingsWorkspaceIdentityOwner: (input: Parameters<typeof createSettingsWorkspaceIdentityOwner>[0]) => identity = createSettingsWorkspaceIdentityOwner(input)},
    './ProjectHomeConnections.tsx': { __esModule: true, default: 'connection-shell' }, './ProjectEntryIdentityStatus.tsx': { __esModule: true, default: 'identity-status' },
    '@mioon/ui/components/button': { Button: 'Button' }, '@mioon/ui/components/workbench-icons': { WorkbenchIcon: 'WorkbenchIcon' },
  }, { window: page, document });
  let settings = context({ role: 'settings', initialProjectId: null, editorProjectId: null, editorPhase: 'none', settingsSlot: options.initialSlot ?? 'agent', settingsVersion: 1 });
  let receive = (_next: ProjectWindowContext) => {};
  let requests = 0;
  const bridge = { subscribe: (listener: (next: ProjectWindowContext) => void) => {receive = listener; return () => {receive = () => {};};}, closeSettings: () => { requests++; return onClose(page); } };
  const render = () => {
    h.begin(); const tree = Component({ context: settings, bridge, contractChecks: {
      readDirectory: () => assert.fail('The desktop settings window does not read the project catalog'),
      readIdentity: async (input: {readonly signal: AbortSignal}) => {
        identityReads++;
        if (options.readIdentity) return options.readIdentity(input);
        if (workspaceIdentity instanceof Error) throw workspaceIdentity;
        return workspaceIdentity;
      },
    }, renderSettings(next: SettingsRenderProps) {
      props = next; owner ??= next.registry.register('retained-form'); owner.update({ dirty: true, busy: false, blocked: false, version: 1 }); return marker;
    } }); h.flush(); return tree;
  };
  const initial = render(); await new Promise(resolve => setImmediate(resolve)); const tree = render();
  if (!options.readIdentity) {assert.ok(props); assert.ok(nodes(tree).includes(marker));}
  return { render, page, marker, input, password, observation,
    identity, workspaceIdentity(value: unknown) {workspaceIdentity = value;},
    reportForm(state: Parameters<NonNullable<typeof owner>['update']>[0]) {assert.ok(owner); owner.update(state);},
    receive(next: ProjectWindowContext) {settings = next; receive(next);},
    setLocale(next: typeof locale) {locale = next;},
    get context() {return settings;}, get props() {assert.ok(props); return props;}, get stateUpdates() {return h.updates;},
    get identityReads() {return identityReads;}, initial,
    button: find(tree, 'native-settings-panel-close').props.onClick as () => void, dispose: h.dispose, get requests() { return requests; } };
}

test('the settings shell can close before app load and its admission cannot carry over to dirty forms', async () => {
  const page = new SettingsPage();
  installSettingsBootClose(page);
  const boot = page.__mioonNativeCloseAdmission;
  assert.ok(boot);
  assert.equal(await page.__mioonFlushWorkspacePreferences?.(), true);
  const choice = () => ({ discardDirty: false, allowDrainFailure: false, expiresAt: Date.now() + 1000 });
  const clean = boot.inspect('close');
  assert.equal(clean.disposition, 'clean');
  assert.equal(boot.commit(clean.token, choice()), true);
  assert.equal(page.beforeUnload(), true);

  const inFlight = boot.inspect('close');
  assert.equal(boot.commit(inFlight.token, choice()), true);
  const f = await settingsPanel(async () => false, { page });
  const forms = page.__mioonNativeCloseAdmission;
  assert.ok(forms);
  assert.notEqual(forms, boot);
  assert.equal(boot.commit(inFlight.token, choice()), false);
  const dirty = forms.inspect('close');
  assert.equal(dirty.disposition, 'dirty');
  assert.equal(forms.commit(inFlight.token, choice()), false);
  assert.equal(forms.commit(dirty.token, choice()), false);
  assert.equal(page.beforeUnload(), false);
  f.reportForm({ dirty: true, busy: true, blocked: false, version: 2 });
  assert.equal(await page.__mioonFlushWorkspacePreferences?.(), false);
  assert.equal(forms.inspect('close').disposition, 'blocked');
  f.dispose();
  assert.equal(page.__mioonNativeCloseAdmission, undefined);
  assert.equal(page.__mioonFlushWorkspacePreferences, undefined);
  assert.equal(page.beforeUnload(), true, 'the shell and form guards are both retired');
});

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

test('SettingsRoot identity failures retain the exact secret input and recovery owners while a changed instance stays inert', async () => {
  const f = await settingsPanel(async () => false), retained = f.props.registry.capture();
  f.workspaceIdentity(Error('private disconnected endpoint')); await f.identity.refresh(); let tree = f.render();
  assert.equal(find(tree, 'retained-native-key'), f.input); assert.equal(nodes(tree).find(node => nodes(node.props.children).includes(f.marker) && Object.hasOwn(node.props, 'inert'))?.props.inert, true);
  assert.deepEqual(f.props.registry.capture(), retained); assert.equal(f.password.value, 'SYNTHETIC_RETAINED_NATIVE_KEY');
  f.workspaceIdentity({appLibraryScope: 'a'.repeat(64), instanceId: id(900)}); await f.identity.refresh(); tree = f.render();
  assert.equal(nodes(tree).find(node => nodes(node.props.children).includes(f.marker) && Object.hasOwn(node.props, 'inert'))?.props.inert, false);
  const admission = f.page.__mioonNativeCloseAdmission!, ticket = admission.inspect();
  f.reportForm({dirty: true, busy: false, blocked: true, version: 2}); const unresolved = f.props.registry.capture();
  f.workspaceIdentity({appLibraryScope: 'a'.repeat(64), instanceId: id(901)}); await f.identity.refresh(); tree = f.render();
  assert.equal(f.identity.getState().identityBlocked, true); assert.equal(f.identity.getVerifiedScope(), null);
  assert.equal(find(tree, 'retained-native-key'), f.input); assert.equal(f.password.value, 'SYNTHETIC_RETAINED_NATIVE_KEY');
  assert.deepEqual(f.props.registry.capture(), unresolved); assert.equal(admission.commit(ticket.token, {discardDirty: true, allowDrainFailure: false, expiresAt: Date.now() + 1000}), false);
  assert.equal(admission.inspect('reload', f.page.location.href).disposition, 'blocked');
  f.workspaceIdentity({appLibraryScope: 'a'.repeat(64), instanceId: id(900)}); await f.identity.refresh();
  assert.equal(f.identity.getVerifiedScope(), null); assert.equal(find(f.render(), 'retained-native-key'), f.input); f.dispose();
});

test('native Settings starts and switches pages using only workspace identity', async () => {
  const received = Promise.withResolvers<unknown>();
  const f = await settingsPanel(async () => false, {initialSlot: 'general', readIdentity: () => received.promise});
  assert.equal(nodes(f.initial).includes(f.marker), false);
  assert.equal(f.identity.getState().phase, 'loading');
  assert.equal(f.identityReads, 1);
  received.resolve({appLibraryScope: 'a'.repeat(64), instanceId: id(900)});
  await f.identity.discover();
  assert.ok(nodes(f.render()).includes(f.marker));
  assert.equal(f.props.page, 'general');
  f.reportForm({dirty: false, busy: false, blocked: false, version: 2});
  f.props.onPage('workspace'); await new Promise(setImmediate);
  assert.ok(nodes(f.render()).includes(f.marker));
  assert.equal(f.props.page, 'workspace');
  assert.equal(f.identityReads, 1);
  f.dispose();
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

test('native accepted same-slot entries advance a renderer version without remounting the input or clearing it on cancelled close', async () => {
  const f = await settingsPanel(async () => false, {initialSlot: 'official'}), original = f.context, retained = f.props.registry.capture();
  assert.equal(f.props.entryVersion, 0);
  f.receive({...original, settingsVersion: 2}); await new Promise(setImmediate); let tree = f.render();
  assert.equal(f.props.entryVersion, 1); assert.equal(f.props.page, 'official'); assert.equal(find(tree, 'retained-native-key'), f.input);
  f.receive({...original, settingsVersion: 3}); await new Promise(setImmediate); tree = f.render();
  assert.equal(f.props.entryVersion, 2); assert.equal(find(tree, 'retained-native-key'), f.input);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {f.setLocale(locale); tree = f.render(); assert.equal(f.props.entryVersion, 2); assert.equal(find(tree, 'retained-native-key'), f.input);}
  f.button(); await new Promise(setImmediate); tree = f.render();
  assert.equal(f.props.entryVersion, 2); assert.equal(find(tree, 'retained-native-key'), f.input); assert.equal(f.password.value, 'SYNTHETIC_RETAINED_NATIVE_KEY'); assert.deepEqual(f.props.registry.capture(), retained);
  for (const next of [{...original, settingsVersion: 2}, {...original, settingsVersion: 3}, {...original, contextId: id(88), settingsVersion: 4}, {...original, windowId: id(89), settingsVersion: 4}, {...original, backendId: id(90), settingsVersion: 4}]) {
    f.receive(next); await new Promise(setImmediate); f.render(); assert.equal(f.props.entryVersion, 2);
  }
  f.dispose();
});

test('a cancelled native entry is never adopted by later manual navigation and a superseded or disposed entry cannot advance', async () => {
  let allow = false;
  const f = await settingsPanel(async () => false, {initialSlot: 'official', confirm: async () => allow}), original = f.context;
  f.receive({...original, settingsSlot: 'custom', settingsVersion: 2}); await new Promise(setImmediate); f.render();
  assert.equal(f.props.page, 'official'); assert.equal(f.props.entryVersion, 0);
  allow = true; f.props.onPage('custom'); await new Promise(setImmediate); let tree = f.render();
  assert.equal(f.props.page, 'custom'); assert.equal(f.props.entryVersion, 0); assert.equal(find(tree, 'retained-native-key'), f.input);
  f.receive({...original, settingsSlot: 'custom', settingsVersion: 3}); await new Promise(setImmediate); f.render(); assert.equal(f.props.entryVersion, 1);
  f.dispose();
  for (const transition of ['superseded', 'disposed'] as const) {
    const answer = Promise.withResolvers<boolean>(), g = await settingsPanel(async () => false, {initialSlot: 'official', confirm: () => answer.promise}), initial = g.context;
    g.receive({...initial, settingsSlot: 'custom', settingsVersion: 2});
    if (transition === 'superseded') g.receive({...initial, settingsSlot: 'official', settingsVersion: 3}); else g.dispose();
    await new Promise(setImmediate); tree = transition === 'disposed' ? tree : g.render();
    const version = g.props.entryVersion, updates = g.stateUpdates;
    answer.resolve(true); await new Promise(setImmediate);
    if (transition !== 'disposed') {g.render(); assert.equal(g.props.page, 'official'); g.dispose();}
    assert.equal(g.props.entryVersion, version);
    if (transition === 'disposed') assert.equal(g.stateUpdates, updates, 'A retired native owner cannot publish a late entry version');
  }
});
