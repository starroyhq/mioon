import type {UiPreferencesResponse, UiPreferencesPut, UiPreferences} from '../packages/contracts/src/ui-preferences.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
type UiState = ReturnType<typeof import('../apps/web/src/UiPreferencesProvider.tsx').useUiPreferences>;
type UiTree = {props: {value: UiState}};
type MessageListener = (event: {data: unknown}) => void;
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as contracts from '../packages/contracts/src/ui-preferences.ts';
import * as appearance from '../apps/web/src/ui-appearance.ts';
import * as preferenceSync from '../apps/web/src/ui-preferences-sync.ts';
import { UiPreferencesRequestError } from '../apps/web/src/ui-preferences-client.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { i18nTestModule } from './helpers/i18n.ts';

const source = readFileSync(new URL('../apps/web/src/UiPreferencesProvider.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const copy = <T>(value: T): T => structuredClone(value);
const snapshot = (theme: UiPreferences['theme'] = 'dark', patch: Partial<UiPreferencesResponse> = {}) => ({ revision: 4, preferences: { ...contracts.DEFAULT_UI_PREFERENCES, theme }, recentOpened: {}, recoveredDefaults: false, writable: true, ...patch });
const deferred = () => { let resolve!: (value?: unknown) => void, reject!: (reason?: unknown) => void; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function rootElement() {
  const classes = new Set(['dark', 'light', 'other-owner']);
  return { classes, classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); } },
    dataset: { projectLayout: 'unchanged' } as Record<string, string>, style: { properties: {} as Record<string, string>, setProperty(name: string, value: string) { this.properties[name] = value; } } as {properties: Record<string, string>; setProperty(name: string, value: string): void; colorScheme?: string; zoom?: string} };
}
function mediaQuery(matches: boolean = false) {
  const listeners = new Set<(event?: {matches: boolean}) => void>(), captured: ((event?: {matches: boolean}) => void)[] = [], removed: ((event?: {matches: boolean}) => void)[] = [];
  return { matches, listeners, captured, removed,
    addEventListener(type: unknown, listener: (event?: {matches: boolean}) => void) { assert.equal(type, 'change'); listeners.add(listener); captured.push(listener); },
    removeEventListener(type: unknown, listener: (event?: {matches: boolean}) => void) { assert.equal(type, 'change'); listeners.delete(listener); removed.push(listener); },
    change(value: boolean) { this.matches = value; for (const listener of listeners) listener({ matches: value }); },
  };
}
function broadcastHub({ echo = false, failPost = false } = {}) {
  const channels: BroadcastChannel[] = [], messages: {revision?: number; [key: string]: unknown}[] = [];
  const deliver = (channel: BroadcastChannel, data: unknown) => { queueMicrotask(() => { if (!channel.closed) for (const listener of channel.listeners) listener({ data: copy(data) }); }); };
  class BroadcastChannel {
    declare name: string; declare closed: boolean; declare listeners: Set<MessageListener>; declare captured: MessageListener[];
    constructor(name: string) { this.name = name; this.closed = false; this.listeners = new Set(); this.captured = []; channels.push(this); }
    addEventListener(type: string, listener: MessageListener) { assert.equal(type, 'message'); this.listeners.add(listener); this.captured.push(listener); }
    removeEventListener(type: string, listener: MessageListener) { assert.equal(type, 'message'); this.listeners.delete(listener); }
    postMessage(data: {revision?: number; [key: string]: unknown}) { if (failPost) throw Error('optional channel unavailable'); messages.push(copy(data)); for (const channel of channels) if (channel.name === this.name && (echo || channel !== this)) deliver(channel, data); }
    close() { this.closed = true; }
  }
  return { BroadcastChannel, channels, messages, emit(data: {}|null) { for (const channel of channels) deliver(channel, data); } };
}

// Execute the actual Provider's hooks and client callbacks. This deliberately
// does not stand in for the separate real-browser OS emulation acceptance.
function fixture({ saved = snapshot(), systemDark = false, read, write, opened, hasMatchMedia = true, hub }: {saved?: UiPreferencesResponse; systemDark?: boolean; read?(count: number): unknown; write?(input: UiPreferencesPut, count: number): unknown; opened?(projectId: string, count: number): unknown; hasMatchMedia?: boolean; hub?: {BroadcastChannel: unknown}} = {}) {
  const slots: RootHook[] = [], media = mediaQuery(systemDark), root = rootElement(), writes: UiPreferencesPut[] = [], reads: null[] = [], queries: string[] = [], opens: string[] = [];
  let cursor = 0, layout: number[] = [], passive: number[] = [], tree: UiTree;
  const sameDeps = (a?: readonly unknown[] | undefined, b?: readonly unknown[] | undefined) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  function effect(queue: number[], callback: () => void | (() => void), deps: readonly unknown[]) {
    const index = cursor++, previous = slots[index];
    if (previous && sameDeps(previous.deps, deps)) return;
    slots[index] = { deps, callback, cleanup: previous?.cleanup }; queue.push(index);
  }
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    createContext: (value: unknown) => ({ Provider: 'Context.Provider', value }),
    useContext: (context: {value: unknown}) => context.value,
    useState(initial: unknown) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }; return [slots[index].value, (value: unknown) => { slots[index].value = typeof value === 'function' ? (value as (prior: unknown) => unknown)(slots[index].value) : value; }]; },
    useRef(value: unknown) { return slots[cursor++] ||= { current: value } as RootHook; },
    useCallback(callback: unknown, deps: readonly unknown[]) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { deps, value: callback }; return slots[index].value; },
    useLayoutEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(layout, callback, deps),
    useEffect: (callback: () => void | (() => void), deps: readonly unknown[]) => effect(passive, callback, deps),
  };
  (react as typeof react & {default: typeof react}).default = react;
  const client = {
    async get() { reads.push(null); return read ? read(reads.length) : copy(saved); },
    async put(input: UiPreferencesPut) { writes.push(copy(input)); return write ? write(input, writes.length) : { ...copy(saved), revision: input.expectedRevision + 1, preferences: copy(input.preferences) }; },
    async opened(projectId: string) { opens.push(projectId); return opened ? opened(projectId, opens.length) : copy(saved); },
  };
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    ...(hasMatchMedia ? { matchMedia(query: string) { queries.push(query); return media; } } : {}),
    ...(hub ? { BroadcastChannel: hub.BroadcastChannel } : {}),
    addEventListener(type: string, listener: () => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
  };
  const module = { exports: {} as {UiPreferencesProvider(props: Record<string, unknown>): UiTree} };
  Function('require', 'module', 'exports', 'document', 'window', 'crypto', code)((name: string) => {
    if (name === 'react') return react;
    if (name.endsWith('/ui-preferences.ts')) return contracts;
    if (name === './ui-appearance.ts') return appearance;
    if (name === './ui-preferences-sync.ts') return preferenceSync;
    if (name === './ui-preferences-client.ts') return { UiPreferencesRequestError, createUiPreferencesClient: () => assert.fail('supplied client must be used') };
    assert.fail(`Unexpected provider import ${name}`);
  }, module, module.exports, { documentElement: root }, window, { randomUUID });
  const run = (queue: number[]) => { for (const index of queue) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback!(); } };
  const f = {
    root, media, reads, writes, queries, opens, client, window: window as typeof window & {__mioonUiPreferences?: unknown},
    listeners,
    focus() { for (const listener of listeners.get('focus') || []) listener(); },
    render() { cursor = 0; layout = []; passive = []; tree = module.exports.UiPreferencesProvider({ client, children: 'unchanged project' }); run(layout); run(passive); return tree.props.value; },
    get state() { return tree.props.value; },
    async ready() { this.render(); await flush(); this.render(); this.render(); return this.state; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
  return f;
}
function assertTheme(f: ReturnType<typeof fixture>, resolved: 'dark' | 'light', preference: UiPreferences['theme']) {
  assert.equal(f.root.classes.has(resolved), true);
  assert.equal(f.root.classes.has(resolved === 'dark' ? 'light' : 'dark'), false);
  assert.equal(f.root.classes.has('other-owner'), true);
  assert.equal(f.root.dataset.theme, resolved);
  assert.equal(f.root.dataset.appearance, preference);
  assert.equal(f.root.style.colorScheme, resolved);
  assert.equal(f.state.resolvedTheme, resolved);
}

/** Mount the actual appearance form alongside the actual Provider. A native
 * dialog's focus return must preserve its hidden, registered settings owner. */
function settingsCloseFixture(f: ReturnType<typeof fixture>, pause = true) {
  const settings = navigation.createSettingsNavigationRegistry(), appearanceOwner = settings.register('home:appearance'), agentOwner = settings.register('home:agent');
  agentOwner.update({ dirty: true, busy: false, blocked: false, version: 1 });
  const hooks: RootHook[] = []; let cursor = 0, effects: number[] = [], tree: RootTree;
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useRef(value: unknown) { return hooks[cursor++] ||= { current: value }; },
    useState(initial: unknown) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }; return [hooks[index].value, (value: unknown) => { hooks[index].value = value; }]; },
    useLayoutEffect(callback: () => void | (() => void), deps: readonly unknown[]) { const index = cursor++, previous = hooks[index]; if (previous && previous.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return; hooks[index] = { callback, deps, cleanup: previous?.cleanup }; effects.push(index); },
  }; (react as typeof react & { default?: unknown }).default = react;
  const module = { exports: {} as { default(props: { active: boolean; onNavigationStateChange: typeof appearanceOwner.update }): RootTree } };
  const appearanceCode = transformSync(readFileSync(new URL('../apps/web/src/SettingsAppearance.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  Function('require', 'module', 'exports', appearanceCode)((name: string) => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name === './UiPreferencesProvider.tsx') return { useUiPreferences: () => f.state };
    if (name === './settings-navigation-state.ts') return navigation;
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, { get: (_, key) => String(key) });
    assert.fail(`Unexpected appearance import ${name}`);
  }, module, module.exports);
  let serial = 0;
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings, readScope: () => 'settings-owner',
    readDocumentURL: () => 'http://localhost/?settings=1', now: () => 1000, newToken: () => `settings-close-${++serial}`,
    ...(pause ? { onObservationPause: (paused: boolean) => f.state.pauseObservation(paused) } : {}),
  });
  const nodes = (value: RootTree): RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props.children)] : [];
  return {
    admission, settings, agentOwner,
    render(active = false) { cursor = 0; effects = []; tree = module.exports.default({ active, onNavigationStateChange: appearanceOwner.update }); for (const index of effects) { const hook = hooks[index]; hook.cleanup?.(); hook.cleanup = hook.callback!(); } },
    chooseTheme(theme: string) { const select = nodes(tree).find(node => node.type === 'WorkbenchTabs' && node.props.value === f.state.preferences.theme); assert.ok(select); select.props.onValueChange(theme); },
    commit(token: string) { return admission.commit(token, { discardDirty: true, allowDrainFailure: false, expiresAt: 2000 }); },
    unload() { let prevented = false; const allowed = admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }); return { allowed, prevented }; },
    unmount() { admission.dispose(); f.state.pauseObservation(false); for (const hook of hooks) hook?.cleanup?.(); },
  };
}

for (const theme of ['dark', 'light'] as const) test(`saved ${theme} applies mutually exclusive root classes without an OS subscription`, async () => {
  const f = fixture({ saved: snapshot(theme), systemDark: theme === 'light' });
  await f.ready(); assertTheme(f, theme, theme);
  assert.equal(f.state.dirty, false); assert.equal(f.media.listeners.size, 0); assert.deepEqual((f.queries as unknown), []); assert.deepEqual((f.writes as unknown), []);
});

test('system follows both initial and live OS states without writes or project/layout changes', async () => {
  const f = fixture({ saved: snapshot('system') }); await f.ready();
  assertTheme(f, 'light', 'system'); assert.equal(f.media.listeners.size, 1);
  assert.deepEqual(f.queries, [appearance.SYSTEM_APPEARANCE_QUERY]);
  const preferences = f.state.preferences, saved = f.state.saved, style = copy(f.root.style.properties), zoom = f.root.style.zoom;
  f.media.change(true); f.render(); assertTheme(f, 'dark', 'system');
  f.media.change(false); f.render(); assertTheme(f, 'light', 'system');
  assert.equal(f.state.preferences, preferences); assert.equal(f.state.saved, saved); assert.equal(f.state.dirty, false);
  assert.deepEqual((f.writes as unknown), []); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.root.style.properties, style); assert.equal(f.root.style.zoom, zoom);
  assert.equal(f.root.dataset.projectLayout, 'unchanged');
});

test('a theme draft previews immediately and discard restores the saved system subscription', async () => {
  const f = fixture({ saved: snapshot('system') }); await f.ready();
  const oldListener = f.media.captured[0];
  f.state.edit({ theme: 'dark' });
  f.media.matches = true; oldListener(); // Changed preference already fences the old callback before commit.
  assert.equal(f.root.dataset.theme, 'light');
  f.render(); f.render(); assertTheme(f, 'dark', 'dark'); assert.equal(f.state.dirty, true); assert.equal(f.media.listeners.size, 0);
  f.media.matches = false; oldListener(); assertTheme(f, 'dark', 'dark');
  f.state.discard(); f.render(); f.render(); assertTheme(f, 'light', 'system');
  assert.equal(f.state.dirty, false); assert.equal(f.media.listeners.size, 1); assert.deepEqual((f.writes as unknown), []);
});

test('retired system callbacks cannot revive after system to manual to system transitions', async () => {
  const f = fixture({ saved: snapshot('system'), systemDark: true }); await f.ready(); const retired = f.media.captured[0];
  f.state.edit({ theme: 'light' }); f.render(); f.render(); assertTheme(f, 'light', 'light');
  f.state.edit({ theme: 'system' }); f.render(); f.render(); assertTheme(f, 'dark', 'system');
  const current = f.media.captured.at(-1); assert.notEqual(current, retired); assert.equal(f.media.listeners.size, 1);
  f.media.matches = false; retired(); assertTheme(f, 'dark', 'system');
  (current)!(); f.render(); assertTheme(f, 'light', 'system');
});

test('cleanup removes the media listener and queued callbacks cannot mutate the unmounted root', async () => {
  const f = fixture({ saved: snapshot('system') }); await f.ready(); const callback = f.media.captured[0];
  f.unmount(); assert.equal(f.media.listeners.size, 0); assert.deepEqual(f.media.removed, [callback]);
  f.media.matches = true; callback(); assertTheme(f, 'light', 'system');
  assert.deepEqual((f.writes as unknown), []); assert.equal(f.window.__mioonUiPreferences, undefined);
});

test('a late initial preference read after unmount cannot activate light or subscribe', async () => {
  const response = deferred(), f = fixture({ read: () => response.promise });
  f.render(); assert.equal(f.root.dataset.theme, 'dark'); f.unmount();
  (response.resolve)!(snapshot('system')); await flush();
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.media.listeners.size, 0); assert.equal(f.media.captured.length, 0);
});

test('saving a light draft retains the same CAS request after an unknown result and admits no intervening edits', async () => {
  const failed = deferred();
  const f = fixture({ write: (input: UiPreferencesPut, count: number) => count === 1 ? failed.promise : { ...snapshot(), revision: input.expectedRevision + 1, preferences: copy(input.preferences) } });
  await f.ready(); f.state.edit({ theme: 'light', density: 'compact' }); f.render(); f.render();
  const saving = f.state.save(); f.render(); assert.equal(f.state.pending, true);
  f.state.edit({ theme: 'system' }); f.render(); assertTheme(f, 'light', 'light'); assert.equal(f.writes.length, 1);
  (failed.reject)!(new Error('unknown local acknowledgement')); assert.equal(await saving, false); f.render();
  assert.equal(f.state.phase, 'error'); f.state.edit({ theme: 'dark' }); f.state.discard(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(await f.state.save(), true); f.render();
  assert.deepEqual(f.writes[1], f.writes[0]); assert.equal(f.writes[0].expectedRevision, 4);
  assert.equal((f.writes[0].preferences)!.theme, 'light'); assert.equal((f.writes[0].preferences)!.density, 'compact');
  assert.equal((f.state.saved)!.preferences.theme, 'light'); assert.equal(f.state.dirty, false); assert.equal(f.state.pending, false);
});

test('readonly preferences cannot be edited or saved but system still follows the OS', async () => {
  const f = fixture({ saved: snapshot('system', { writable: false }) }); await f.ready();
  f.state.edit({ theme: 'light' }); assert.equal(await f.state.save(), false); f.render();
  assert.equal(f.state.preferences.theme, 'system'); f.media.change(true); f.render(); assertTheme(f, 'dark', 'system');
  assert.equal(f.state.dirty, false); assert.deepEqual((f.writes as unknown), []);
});

test('a draft survives reloading a newer saved theme until explicit discard', async () => {
  const f = fixture({ read: (count: number) => snapshot(count === 1 ? 'dark' : 'system', { revision: count === 1 ? 4 : 5 }) }); await f.ready();
  f.state.edit({ theme: 'light' }); f.render(); f.render(); assert.equal(await f.state.reload(), true); f.render();
  assertTheme(f, 'light', 'light'); assert.equal((f.state.saved)!.preferences.theme, 'system'); assert.equal(f.state.dirty, true);
  f.state.discard(); f.render(); f.render(); assertTheme(f, 'light', 'system'); assert.equal(f.state.dirty, false);
});

test('an authoritative light reload wins over an older in-flight dark response', async () => {
  const older = deferred(), newer = deferred();
  const f = fixture({ read: (count: number) => count === 1 ? snapshot() : count === 2 ? older.promise : newer.promise }); await f.ready();
  const oldRead = f.state.reload(), newRead = f.state.reload();
  (newer.resolve)!(snapshot('light', { revision: 6 })); assert.equal(await newRead, true); f.render(); f.render(); assertTheme(f, 'light', 'light');
  (older.resolve)!(snapshot('dark', { revision: 5 })); assert.equal(await oldRead, false); f.render();
  assertTheme(f, 'light', 'light'); assert.equal((f.state.saved)!.revision, 6); assert.equal(f.state.dirty, false); assert.deepEqual((f.writes as unknown), []);
});

test('without matchMedia manual light works while system retains the deterministic dark fallback', async () => {
  const f = fixture({ saved: snapshot('light'), hasMatchMedia: false }); await f.ready(); assertTheme(f, 'light', 'light');
  f.state.edit({ theme: 'system' }); f.render(); f.render(); assertTheme(f, 'dark', 'system'); assert.deepEqual((f.writes as unknown), []);
});

test('two mounted Providers synchronize an accepted save using only a revision hint and no echo loop', async () => {
  const hub = broadcastHub({ echo: true }); let authoritative = snapshot();
  const first = fixture({ hub, read: () => copy(authoritative), write: (input: UiPreferencesPut) => {
    assert.equal(input.expectedRevision, authoritative.revision);
    authoritative = { ...authoritative, revision: authoritative.revision + 1, preferences: copy(input.preferences) }; return copy(authoritative);
  } });
  const second = fixture({ hub, read: () => copy(authoritative) });
  await first.ready(); await second.ready(); first.state.edit({ theme: 'light' }); first.render(); first.render();
  assert.equal(await first.state.save(), true); await flush(); first.render(); second.render(); second.render();
  assertTheme(first, 'light', 'light'); assertTheme(second, 'light', 'light');
  assert.equal(first.reads.length, 1); assert.equal(second.reads.length, 2);
  assert.equal(first.writes.length, 1); assert.equal(second.writes.length, 0);
  assert.deepEqual(hub.messages, [{ type: 'ui-preferences-saved', version: 1, revision: 5 }]);
  assert.ok(hub.channels.every(channel => channel.name === preferenceSync.UI_PREFERENCES_SYNC_CHANNEL));
});

test('cross-window hints preserve a different window draft and its original CAS base until discard', async () => {
  const hub = broadcastHub(); let authoritative = snapshot();
  const first = fixture({ hub, read: () => copy(authoritative), write: (input: UiPreferencesPut) => authoritative = { ...authoritative, revision: 5, preferences: copy(input.preferences) } });
  const second = fixture({ hub, read: () => copy(authoritative) }); await first.ready(); await second.ready();
  second.state.edit({ density: 'compact' }); second.render(); assert.equal(second.state.dirty, true);
  first.state.edit({ theme: 'light' }); first.render(); await first.state.save(); await flush(); second.render(); second.render();
  assertTheme(second, 'dark', 'dark'); assert.equal(second.state.preferences.density, 'compact');
  assert.equal((second.state.saved)!.preferences.theme, 'dark'); assert.equal((second.state.saved)!.revision, 4); assert.equal(second.state.dirty, true); assert.equal(second.reads.length, 1);
  second.state.discard(); await flush(); second.render(); second.render(); assertTheme(second, 'light', 'light');
  assert.equal((second.state.saved)!.revision, 5); assert.equal(second.reads.length, 2);
  assert.equal(second.state.preferences.density, 'standard'); assert.equal(second.state.dirty, false); assert.deepEqual((second.writes as unknown), []);
  assert.equal(hub.messages.length, 1);
});

test('invalid, stale and replayed channel payloads never replace preferences or issue repeated reads', async () => {
  const hub = broadcastHub(); const f = fixture({ hub, read: (count: number) => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }) }); await f.ready();
  const hint = (revision: string|number) => ({ type: 'ui-preferences-saved', version: 1, revision });
  for (const data of [null, [], {}, hint(-1), hint(0), hint(4), hint(4.5), hint(NaN), hint(Infinity), hint(Number.MAX_SAFE_INTEGER + 1), hint('5'), { ...hint(5), version: 2 }, { ...hint(5), type: 'other' }, { ...hint(5), preferences: { theme: 'light' } }]) hub.emit(data);
  await flush(); assert.equal(f.reads.length, 1); assertTheme(f, 'dark', 'dark');
  hub.emit(hint(5)); hub.emit(hint(5)); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(f.reads.length, 2); hub.emit(hint(5)); await flush(); assert.equal(f.reads.length, 2); assert.deepEqual((f.writes as unknown), []); assert.deepEqual((hub.messages as unknown), []);
});

test('a revision arriving during an in-flight read is drained once after that read releases ownership', async () => {
  const older = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: (count: number) => count === 1 ? snapshot() : count === 2 ? older.promise : snapshot('light', { revision: 5 }) }); await f.ready();
  const reading = f.state.reload(); hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 5 }); await flush();
  assert.equal(f.reads.length, 2); (older.resolve)!(snapshot()); assert.equal(await reading, true); await flush(); f.render(); f.render();
  assert.equal(f.reads.length, 3); assertTheme(f, 'light', 'light'); assert.deepEqual((f.writes as unknown), []);
});

test('an unknown accepted save keeps its frozen request despite notifications and drains after explicit same-request retry', async () => {
  const firstAck = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: (count: number) => count === 1 ? snapshot() : snapshot('dark', { revision: 6 }),
    write: (input: UiPreferencesPut, count: number) => count === 1 ? firstAck.promise : { ...snapshot(), revision: 5, preferences: copy(input.preferences) } }); await f.ready();
  f.state.edit({ theme: 'light' }); f.render(); const saving = f.state.save();
  hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 6 }); await flush(); f.focus();
  assert.equal(f.reads.length, 1); (firstAck.reject)!(new Error('unknown local acknowledgement')); assert.equal(await saving, false); f.render(); await flush();
  assert.equal(f.reads.length, 1); assert.equal(f.state.pending, true); assert.equal(f.state.phase, 'error');
  assert.equal(await f.state.save(), true); await flush(); f.render(); f.render();
  assert.deepEqual(f.writes[1], f.writes[0]); assert.equal(f.reads.length, 2); assert.equal((f.state.saved)!.revision, 6); assertTheme(f, 'dark', 'dark');
  assert.equal(f.state.pending, false); assert.equal(hub.messages.length, 1); assert.equal(hub.messages[0].revision, 5);
});

test('unmount closes the channel and focus listener and rejects captured late messages', async () => {
  const hub = broadcastHub(), f = fixture({ hub }); await f.ready(); const channel = hub.channels[0], oldMessage = channel.captured[0], oldFocus = [...f.listeners.get('focus')!][0];
  f.unmount(); assert.equal(channel.closed, true); assert.equal(channel.listeners.size, 0); assert.equal((f.listeners.get('focus'))!.size, 0);
  oldMessage({ data: { type: 'ui-preferences-saved', version: 1, revision: 5 } }); oldFocus(); await flush();
  assert.equal(f.reads.length, 1); assert.deepEqual((f.writes as unknown), []); assert.equal(f.root.dataset.theme, 'dark');
});

test('focus fallback defers for a draft and coalesces requests while an authority read is pending', async () => {
  const response = deferred(); const f = fixture({ read: (count: number) => count === 1 ? snapshot() : count === 2 ? response.promise : snapshot('light', { revision: 5 }) }); await f.ready();
  f.state.edit({ density: 'compact' }); f.render(); f.focus(); f.focus(); f.focus(); assert.equal(f.reads.length, 1);
  f.state.discard(); assert.equal(f.reads.length, 2); f.focus(); f.focus();
  (response.resolve)!(snapshot('light', { revision: 5 })); await flush(); f.render(); f.render();
  assertTheme(f, 'light', 'light'); assert.equal(f.state.preferences.density, 'standard'); assert.equal(f.state.dirty, false);
  assert.equal(f.reads.length, 3); assert.deepEqual((f.writes as unknown), []);
});

test('OS changes never broadcast, and optional channel failure cannot turn an accepted save into an error', async () => {
  const hub = broadcastHub({ failPost: true }), f = fixture({ hub, saved: snapshot('system') }); await f.ready();
  f.media.change(true); f.render(); f.media.change(false); f.render(); assert.deepEqual((hub.messages as unknown), []); assert.deepEqual((f.writes as unknown), []);
  f.state.edit({ theme: 'light' }); f.render(); assert.equal(await f.state.save(), true); f.render();
  assert.equal(f.state.phase, 'ready'); assert.equal(f.state.pending, false); assert.equal(f.state.dirty, false); assertTheme(f, 'light', 'light');
});

test('a dirty receiver saves against its original revision and exposes a real conflict instead of overwriting another window', async () => {
  const hub = broadcastHub(); let authoritative = snapshot();
  const write = (input: UiPreferencesPut) => {
    if (input.expectedRevision !== authoritative.revision) throw new UiPreferencesRequestError('UI_PREFERENCES_CONFLICT');
    authoritative = { ...authoritative, revision: authoritative.revision + 1, preferences: copy(input.preferences) }; return copy(authoritative);
  };
  const first = fixture({ hub, read: () => copy(authoritative), write }), second = fixture({ hub, read: () => copy(authoritative), write });
  await first.ready(); await second.ready(); second.state.edit({ density: 'compact' }); second.render();
  first.state.edit({ theme: 'light' }); first.render(); assert.equal(await first.state.save(), true); await flush();
  assert.equal(await second.state.save(), false); second.render();
  assert.equal(second.writes[0].expectedRevision, 4); assert.equal((second.state.saved)!.revision, 4); assert.equal(second.state.phase, 'conflict');
  assert.equal(second.state.preferences.density, 'compact'); assert.equal(second.state.preferences.theme, 'dark'); assert.equal(authoritative.preferences.theme, 'light');
  assert.equal(authoritative.preferences.density, 'standard'); assert.equal(hub.messages.length, 1); assert.equal(second.reads.length, 1);
  assert.equal(await second.state.reload(), true); second.render(); second.state.discard(); await flush(); second.render(); second.render();
  assertTheme(second, 'light', 'light'); assert.equal(second.state.dirty, false);
});

test('a clean navigation acknowledgement atomically applies a newer theme before the same-revision message arrives', async () => {
  const response = deferred(), hub = broadcastHub(), f = fixture({ hub, opened: () => response.promise }); await f.ready();
  const navigation = f.state.markOpened('11111111-1111-4111-8111-111111111111');
  (response.resolve)!(snapshot('light', { revision: 5 })); await navigation; f.render(); f.render();
  assertTheme(f, 'light', 'light'); assert.equal((f.state.saved)!.revision, 5); assert.equal(f.state.dirty, false); assert.equal(f.state.recentError, false);
  hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 5 }); await flush();
  assert.equal(f.reads.length, 1); assert.deepEqual((f.writes as unknown), []); assert.deepEqual((hub.messages as unknown), []);
});

for (const editing of ['before', 'during']) test(`a navigation acknowledgement defers newer preferences when a draft was edited ${editing} its request`, async () => {
  const response = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: (count: number) => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }), opened: () => response.promise }); await f.ready();
  if (editing === 'before') f.state.edit({ density: 'compact' });
  const navigation = f.state.markOpened('11111111-1111-4111-8111-111111111111');
  if (editing === 'during') f.state.edit({ density: 'compact' });
  f.render(); (response.resolve)!(snapshot('light', { revision: 5 })); await navigation; f.render(); f.render();
  assert.equal((f.state.saved)!.revision, 4); assertTheme(f, 'dark', 'dark'); assert.equal(f.state.preferences.density, 'compact'); assert.equal(f.state.dirty, true);
  assert.equal(f.state.recentError, false); assert.equal(f.reads.length, 1); assert.deepEqual((f.writes as unknown), []);
  f.state.discard(); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light'); assert.equal(f.state.dirty, false);
});

test('a restricted BroadcastChannel constructor still permits a guarded focus reread', async () => {
  const hub = { BroadcastChannel: class { constructor() { throw Error('channel restricted'); } } };
  const f = fixture({ hub, read: (count: number) => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }) });
  await f.ready(); f.focus(); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(f.reads.length, 2); assert.deepEqual((f.writes as unknown), []); f.unmount(); assert.equal((f.listeners.get('focus'))!.size, 0);
});

test('native dialog focus invalidates a hidden appearance capture without the observation pause', async () => {
  const f = fixture(); await f.ready(); const close = settingsCloseFixture(f, false); close.render();
  const ticket = close.admission.inspect(), before = close.settings.capture(); assert.equal(ticket.disposition, 'dirty');
  f.focus(); await flush(); f.render(); close.render();
  assert.equal(f.reads.length, 2);
  assert.ok(close.settings.capture().find(entry => entry.slot === 'home:appearance')!.version > before.find(entry => entry.slot === 'home:appearance')!.version);
  assert.equal(close.commit(ticket.token), false); close.unmount(); f.unmount();
});

test('native inspect to discard survives dialog focus without refreshing or changing registered owners', async () => {
  const f = fixture(); await f.ready(); const pause = f.state.pauseObservation, close = settingsCloseFixture(f); close.render();
  const ticket = close.admission.inspect(), before = close.settings.capture(); assert.equal(ticket.disposition, 'dirty');
  f.focus(); f.focus(); await flush(); f.render(); close.render();
  assert.equal(f.state.pauseObservation, pause); assert.equal(f.reads.length, 1); assert.deepEqual(close.settings.capture(), before);
  assert.equal(close.commit(ticket.token), true); assert.deepEqual(close.unload(), { allowed: true, prevented: false });
  assert.deepEqual(f.writes, []); close.unmount(); f.unmount();
});

test('native cancellation resumes coalesced focus and revision hints once without changing drafts', async () => {
  const hub = broadcastHub(), f = fixture({ hub, read: count => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 6 }) });
  await f.ready(); const close = settingsCloseFixture(f); close.render(); const ticket = close.admission.inspect();
  f.focus(); f.focus(); for (const revision of [5, 6, 6]) hub.emit({ type: 'ui-preferences-saved', version: 1, revision });
  await flush(); f.render(); close.render(); assert.equal(f.reads.length, 1);
  assert.equal(close.admission.cancel(ticket.token), true); await flush(); f.render(); close.render();
  assert.equal(f.reads.length, 2); assert.equal(f.state.preferences.theme, 'light');
  assert.equal(close.settings.capture().find(entry => entry.slot === 'home:agent')!.dirty, true);
  f.state.pauseObservation(false); await flush(); assert.equal(f.reads.length, 2); assert.deepEqual(f.writes, []);
  assert.equal(close.commit(ticket.token), false); close.unmount(); f.unmount();
});

test('observation pause preserves real input versions and explicit preference actions', async () => {
  const f = fixture(); await f.ready(); const close = settingsCloseFixture(f); close.render(true);
  const ticket = close.admission.inspect(), before = close.settings.capture();
  close.chooseTheme('light'); f.render(); close.render(true);
  assert.equal(f.state.dirty, true); assert.equal(f.state.preferences.theme, 'light');
  assert.ok(close.settings.capture().find(entry => entry.slot === 'home:appearance')!.version > before.find(entry => entry.slot === 'home:appearance')!.version);
  assert.equal(close.commit(ticket.token), false);
  assert.equal(await f.state.save(), true); f.render(); close.render(true); assert.equal(f.writes.length, 1);
  assert.equal(await f.state.reload(), true); f.render(); close.render(true); assert.equal(f.reads.length, 2);
  close.admission.cancel(ticket.token); close.unmount(); f.unmount();
});
