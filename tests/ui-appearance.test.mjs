import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as contracts from '../packages/contracts/src/ui-preferences.ts';
import * as appearance from '../apps/web/src/ui-appearance.ts';
import * as preferenceSync from '../apps/web/src/ui-preferences-sync.ts';
import { UiPreferencesRequestError } from '../apps/web/src/ui-preferences-client.ts';

const source = readFileSync(new URL('../apps/web/src/UiPreferencesProvider.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const copy = value => structuredClone(value);
const snapshot = (theme = 'dark', patch = {}) => ({ revision: 4, preferences: { ...contracts.DEFAULT_UI_PREFERENCES, theme }, recentOpened: {}, recoveredDefaults: false, writable: true, ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function rootElement() {
  const classes = new Set(['dark', 'light', 'other-owner']);
  return { classes, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    dataset: { projectLayout: 'unchanged' }, style: { properties: {}, setProperty(name, value) { this.properties[name] = value; } } };
}
function mediaQuery(matches = false) {
  const listeners = new Set(), captured = [], removed = [];
  return { matches, listeners, captured, removed,
    addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); captured.push(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'change'); listeners.delete(listener); removed.push(listener); },
    change(value) { this.matches = value; for (const listener of listeners) listener({ matches: value }); },
  };
}
function broadcastHub({ echo = false, failPost = false } = {}) {
  const channels = [], messages = [];
  const deliver = (channel, data) => { queueMicrotask(() => { if (!channel.closed) for (const listener of channel.listeners) listener({ data: copy(data) }); }); };
  class BroadcastChannel {
    constructor(name) { this.name = name; this.closed = false; this.listeners = new Set(); this.captured = []; channels.push(this); }
    addEventListener(type, listener) { assert.equal(type, 'message'); this.listeners.add(listener); this.captured.push(listener); }
    removeEventListener(type, listener) { assert.equal(type, 'message'); this.listeners.delete(listener); }
    postMessage(data) { if (failPost) throw Error('optional channel unavailable'); messages.push(copy(data)); for (const channel of channels) if (channel.name === this.name && (echo || channel !== this)) deliver(channel, data); }
    close() { this.closed = true; }
  }
  return { BroadcastChannel, channels, messages, emit(data) { for (const channel of channels) deliver(channel, data); } };
}

// Execute the actual Provider's hooks and client callbacks. This deliberately
// does not stand in for the separate real-browser OS emulation acceptance.
function fixture({ saved = snapshot(), systemDark = false, read, write, opened, hasMatchMedia = true, hub } = {}) {
  const slots = [], media = mediaQuery(systemDark), root = rootElement(), writes = [], reads = [], queries = [], opens = [];
  let cursor = 0, layout = [], passive = [], tree;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  function effect(queue, callback, deps) {
    const index = cursor++, previous = slots[index];
    if (previous && sameDeps(previous.deps, deps)) return;
    slots[index] = { deps, callback, cleanup: previous?.cleanup }; queue.push(index);
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: value => ({ Provider: 'Context.Provider', value }),
    useContext: context => context.value,
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(value) { return slots[cursor++] ||= { current: value }; },
    useCallback(callback, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { deps, value: callback }; return slots[index].value; },
    useLayoutEffect: (callback, deps) => effect(layout, callback, deps),
    useEffect: (callback, deps) => effect(passive, callback, deps),
  };
  react.default = react;
  const client = {
    async get() { reads.push(null); return read ? read(reads.length) : copy(saved); },
    async put(input) { writes.push(copy(input)); return write ? write(input, writes.length) : { ...copy(saved), revision: input.expectedRevision + 1, preferences: copy(input.preferences) }; },
    async opened(projectId) { opens.push(projectId); return opened ? opened(projectId, opens.length) : copy(saved); },
  };
  const listeners = new Map();
  const window = {
    ...(hasMatchMedia ? { matchMedia(query) { queries.push(query); return media; } } : {}),
    ...(hub ? { BroadcastChannel: hub.BroadcastChannel } : {}),
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'document', 'window', 'crypto', code)(name => {
    if (name === 'react') return react;
    if (name.endsWith('/ui-preferences.ts')) return contracts;
    if (name === './ui-appearance.ts') return appearance;
    if (name === './ui-preferences-sync.ts') return preferenceSync;
    if (name === './ui-preferences-client.ts') return { UiPreferencesRequestError, createUiPreferencesClient: () => assert.fail('supplied client must be used') };
    assert.fail(`Unexpected provider import ${name}`);
  }, module, module.exports, { documentElement: root }, window, { randomUUID });
  const run = queue => { for (const index of queue) { const slot = slots[index]; slot.cleanup?.(); slot.cleanup = slot.callback(); } };
  const f = {
    root, media, reads, writes, queries, opens, client, window,
    listeners,
    focus() { for (const listener of listeners.get('focus') || []) listener(); },
    render() { cursor = 0; layout = []; passive = []; tree = module.exports.UiPreferencesProvider({ client, children: 'unchanged project' }); run(layout); run(passive); return tree.props.value; },
    get state() { return tree.props.value; },
    async ready() { this.render(); await flush(); this.render(); this.render(); return this.state; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
  return f;
}
function assertTheme(f, resolved, preference) {
  assert.equal(f.root.classes.has(resolved), true);
  assert.equal(f.root.classes.has(resolved === 'dark' ? 'light' : 'dark'), false);
  assert.equal(f.root.classes.has('other-owner'), true);
  assert.equal(f.root.dataset.theme, resolved);
  assert.equal(f.root.dataset.appearance, preference);
  assert.equal(f.root.style.colorScheme, resolved);
  assert.equal(f.state.resolvedTheme, resolved);
}

for (const theme of ['dark', 'light']) test(`saved ${theme} applies mutually exclusive root classes without an OS subscription`, async () => {
  const f = fixture({ saved: snapshot(theme), systemDark: theme === 'light' });
  await f.ready(); assertTheme(f, theme, theme);
  assert.equal(f.state.dirty, false); assert.equal(f.media.listeners.size, 0); assert.deepEqual(f.queries, []); assert.deepEqual(f.writes, []);
});

test('system follows both initial and live OS states without writes or project/layout changes', async () => {
  const f = fixture({ saved: snapshot('system') }); await f.ready();
  assertTheme(f, 'light', 'system'); assert.equal(f.media.listeners.size, 1);
  assert.deepEqual(f.queries, [appearance.SYSTEM_APPEARANCE_QUERY]);
  const preferences = f.state.preferences, saved = f.state.saved, style = copy(f.root.style.properties), zoom = f.root.style.zoom;
  f.media.change(true); f.render(); assertTheme(f, 'dark', 'system');
  f.media.change(false); f.render(); assertTheme(f, 'light', 'system');
  assert.equal(f.state.preferences, preferences); assert.equal(f.state.saved, saved); assert.equal(f.state.dirty, false);
  assert.deepEqual(f.writes, []); assert.equal(f.reads.length, 1);
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
  assert.equal(f.state.dirty, false); assert.equal(f.media.listeners.size, 1); assert.deepEqual(f.writes, []);
});

test('retired system callbacks cannot revive after system to manual to system transitions', async () => {
  const f = fixture({ saved: snapshot('system'), systemDark: true }); await f.ready(); const retired = f.media.captured[0];
  f.state.edit({ theme: 'light' }); f.render(); f.render(); assertTheme(f, 'light', 'light');
  f.state.edit({ theme: 'system' }); f.render(); f.render(); assertTheme(f, 'dark', 'system');
  const current = f.media.captured.at(-1); assert.notEqual(current, retired); assert.equal(f.media.listeners.size, 1);
  f.media.matches = false; retired(); assertTheme(f, 'dark', 'system');
  current(); f.render(); assertTheme(f, 'light', 'system');
});

test('cleanup removes the media listener and queued callbacks cannot mutate the unmounted root', async () => {
  const f = fixture({ saved: snapshot('system') }); await f.ready(); const callback = f.media.captured[0];
  f.unmount(); assert.equal(f.media.listeners.size, 0); assert.deepEqual(f.media.removed, [callback]);
  f.media.matches = true; callback(); assertTheme(f, 'light', 'system');
  assert.deepEqual(f.writes, []); assert.equal(f.window.__mioonUiPreferences, undefined);
});

test('a late initial preference read after unmount cannot activate light or subscribe', async () => {
  const response = deferred(), f = fixture({ read: () => response.promise });
  f.render(); assert.equal(f.root.dataset.theme, 'dark'); f.unmount();
  response.resolve(snapshot('system')); await flush();
  assert.equal(f.root.dataset.theme, 'dark'); assert.equal(f.media.listeners.size, 0); assert.equal(f.media.captured.length, 0);
});

test('saving a light draft retains the same CAS request after an unknown result and admits no intervening edits', async () => {
  const failed = deferred();
  const f = fixture({ write: (input, count) => count === 1 ? failed.promise : { ...snapshot(), revision: input.expectedRevision + 1, preferences: copy(input.preferences) } });
  await f.ready(); f.state.edit({ theme: 'light', density: 'compact' }); f.render(); f.render();
  const saving = f.state.save(); f.render(); assert.equal(f.state.pending, true);
  f.state.edit({ theme: 'system' }); f.render(); assertTheme(f, 'light', 'light'); assert.equal(f.writes.length, 1);
  failed.reject(new Error('unknown local acknowledgement')); assert.equal(await saving, false); f.render();
  assert.equal(f.state.phase, 'error'); f.state.edit({ theme: 'dark' }); f.state.discard(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(await f.state.save(), true); f.render();
  assert.deepEqual(f.writes[1], f.writes[0]); assert.equal(f.writes[0].expectedRevision, 4);
  assert.equal(f.writes[0].preferences.theme, 'light'); assert.equal(f.writes[0].preferences.density, 'compact');
  assert.equal(f.state.saved.preferences.theme, 'light'); assert.equal(f.state.dirty, false); assert.equal(f.state.pending, false);
});

test('readonly preferences cannot be edited or saved but system still follows the OS', async () => {
  const f = fixture({ saved: snapshot('system', { writable: false }) }); await f.ready();
  f.state.edit({ theme: 'light' }); assert.equal(await f.state.save(), false); f.render();
  assert.equal(f.state.preferences.theme, 'system'); f.media.change(true); f.render(); assertTheme(f, 'dark', 'system');
  assert.equal(f.state.dirty, false); assert.deepEqual(f.writes, []);
});

test('a draft survives reloading a newer saved theme until explicit discard', async () => {
  const f = fixture({ read: count => snapshot(count === 1 ? 'dark' : 'system', { revision: count === 1 ? 4 : 5 }) }); await f.ready();
  f.state.edit({ theme: 'light' }); f.render(); f.render(); assert.equal(await f.state.reload(), true); f.render();
  assertTheme(f, 'light', 'light'); assert.equal(f.state.saved.preferences.theme, 'system'); assert.equal(f.state.dirty, true);
  f.state.discard(); f.render(); f.render(); assertTheme(f, 'light', 'system'); assert.equal(f.state.dirty, false);
});

test('an authoritative light reload wins over an older in-flight dark response', async () => {
  const older = deferred(), newer = deferred();
  const f = fixture({ read: count => count === 1 ? snapshot() : count === 2 ? older.promise : newer.promise }); await f.ready();
  const oldRead = f.state.reload(), newRead = f.state.reload();
  newer.resolve(snapshot('light', { revision: 6 })); assert.equal(await newRead, true); f.render(); f.render(); assertTheme(f, 'light', 'light');
  older.resolve(snapshot('dark', { revision: 5 })); assert.equal(await oldRead, false); f.render();
  assertTheme(f, 'light', 'light'); assert.equal(f.state.saved.revision, 6); assert.equal(f.state.dirty, false); assert.deepEqual(f.writes, []);
});

test('without matchMedia manual light works while system retains the deterministic dark fallback', async () => {
  const f = fixture({ saved: snapshot('light'), hasMatchMedia: false }); await f.ready(); assertTheme(f, 'light', 'light');
  f.state.edit({ theme: 'system' }); f.render(); f.render(); assertTheme(f, 'dark', 'system'); assert.deepEqual(f.writes, []);
});

test('two mounted Providers synchronize an accepted save using only a revision hint and no echo loop', async () => {
  const hub = broadcastHub({ echo: true }); let authoritative = snapshot();
  const first = fixture({ hub, read: () => copy(authoritative), write: input => {
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
  const first = fixture({ hub, read: () => copy(authoritative), write: input => authoritative = { ...authoritative, revision: 5, preferences: copy(input.preferences) } });
  const second = fixture({ hub, read: () => copy(authoritative) }); await first.ready(); await second.ready();
  second.state.edit({ density: 'compact' }); second.render(); assert.equal(second.state.dirty, true);
  first.state.edit({ theme: 'light' }); first.render(); await first.state.save(); await flush(); second.render(); second.render();
  assertTheme(second, 'dark', 'dark'); assert.equal(second.state.preferences.density, 'compact');
  assert.equal(second.state.saved.preferences.theme, 'dark'); assert.equal(second.state.saved.revision, 4); assert.equal(second.state.dirty, true); assert.equal(second.reads.length, 1);
  second.state.discard(); await flush(); second.render(); second.render(); assertTheme(second, 'light', 'light');
  assert.equal(second.state.saved.revision, 5); assert.equal(second.reads.length, 2);
  assert.equal(second.state.preferences.density, 'standard'); assert.equal(second.state.dirty, false); assert.deepEqual(second.writes, []);
  assert.equal(hub.messages.length, 1);
});

test('invalid, stale and replayed channel payloads never replace preferences or issue repeated reads', async () => {
  const hub = broadcastHub(); const f = fixture({ hub, read: count => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }) }); await f.ready();
  const hint = revision => ({ type: 'ui-preferences-saved', version: 1, revision });
  for (const data of [null, [], {}, hint(-1), hint(0), hint(4), hint(4.5), hint(NaN), hint(Infinity), hint(Number.MAX_SAFE_INTEGER + 1), hint('5'), { ...hint(5), version: 2 }, { ...hint(5), type: 'other' }, { ...hint(5), preferences: { theme: 'light' } }]) hub.emit(data);
  await flush(); assert.equal(f.reads.length, 1); assertTheme(f, 'dark', 'dark');
  hub.emit(hint(5)); hub.emit(hint(5)); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(f.reads.length, 2); hub.emit(hint(5)); await flush(); assert.equal(f.reads.length, 2); assert.deepEqual(f.writes, []); assert.deepEqual(hub.messages, []);
});

test('a revision arriving during an in-flight read is drained once after that read releases ownership', async () => {
  const older = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: count => count === 1 ? snapshot() : count === 2 ? older.promise : snapshot('light', { revision: 5 }) }); await f.ready();
  const reading = f.state.reload(); hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 5 }); await flush();
  assert.equal(f.reads.length, 2); older.resolve(snapshot()); assert.equal(await reading, true); await flush(); f.render(); f.render();
  assert.equal(f.reads.length, 3); assertTheme(f, 'light', 'light'); assert.deepEqual(f.writes, []);
});

test('an unknown accepted save keeps its frozen request despite notifications and drains after explicit same-request retry', async () => {
  const firstAck = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: count => count === 1 ? snapshot() : snapshot('dark', { revision: 6 }),
    write: (input, count) => count === 1 ? firstAck.promise : { ...snapshot(), revision: 5, preferences: copy(input.preferences) } }); await f.ready();
  f.state.edit({ theme: 'light' }); f.render(); const saving = f.state.save();
  hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 6 }); await flush(); f.focus();
  assert.equal(f.reads.length, 1); firstAck.reject(new Error('unknown local acknowledgement')); assert.equal(await saving, false); f.render(); await flush();
  assert.equal(f.reads.length, 1); assert.equal(f.state.pending, true); assert.equal(f.state.phase, 'error');
  assert.equal(await f.state.save(), true); await flush(); f.render(); f.render();
  assert.deepEqual(f.writes[1], f.writes[0]); assert.equal(f.reads.length, 2); assert.equal(f.state.saved.revision, 6); assertTheme(f, 'dark', 'dark');
  assert.equal(f.state.pending, false); assert.equal(hub.messages.length, 1); assert.equal(hub.messages[0].revision, 5);
});

test('unmount closes the channel and focus listener and rejects captured late messages', async () => {
  const hub = broadcastHub(), f = fixture({ hub }); await f.ready(); const channel = hub.channels[0], oldMessage = channel.captured[0], oldFocus = [...f.listeners.get('focus')][0];
  f.unmount(); assert.equal(channel.closed, true); assert.equal(channel.listeners.size, 0); assert.equal(f.listeners.get('focus').size, 0);
  oldMessage({ data: { type: 'ui-preferences-saved', version: 1, revision: 5 } }); oldFocus(); await flush();
  assert.equal(f.reads.length, 1); assert.deepEqual(f.writes, []); assert.equal(f.root.dataset.theme, 'dark');
});

test('focus fallback defers for a draft and coalesces requests while an authority read is pending', async () => {
  const response = deferred(); const f = fixture({ read: count => count === 1 ? snapshot() : count === 2 ? response.promise : snapshot('light', { revision: 5 }) }); await f.ready();
  f.state.edit({ density: 'compact' }); f.render(); f.focus(); f.focus(); f.focus(); assert.equal(f.reads.length, 1);
  f.state.discard(); assert.equal(f.reads.length, 2); f.focus(); f.focus();
  response.resolve(snapshot('light', { revision: 5 })); await flush(); f.render(); f.render();
  assertTheme(f, 'light', 'light'); assert.equal(f.state.preferences.density, 'standard'); assert.equal(f.state.dirty, false);
  assert.equal(f.reads.length, 3); assert.deepEqual(f.writes, []);
});

test('OS changes never broadcast, and optional channel failure cannot turn an accepted save into an error', async () => {
  const hub = broadcastHub({ failPost: true }), f = fixture({ hub, saved: snapshot('system') }); await f.ready();
  f.media.change(true); f.render(); f.media.change(false); f.render(); assert.deepEqual(hub.messages, []); assert.deepEqual(f.writes, []);
  f.state.edit({ theme: 'light' }); f.render(); assert.equal(await f.state.save(), true); f.render();
  assert.equal(f.state.phase, 'ready'); assert.equal(f.state.pending, false); assert.equal(f.state.dirty, false); assertTheme(f, 'light', 'light');
});

test('a dirty receiver saves against its original revision and exposes a real conflict instead of overwriting another window', async () => {
  const hub = broadcastHub(); let authoritative = snapshot();
  const write = input => {
    if (input.expectedRevision !== authoritative.revision) throw new UiPreferencesRequestError('UI_PREFERENCES_CONFLICT');
    authoritative = { ...authoritative, revision: authoritative.revision + 1, preferences: copy(input.preferences) }; return copy(authoritative);
  };
  const first = fixture({ hub, read: () => copy(authoritative), write }), second = fixture({ hub, read: () => copy(authoritative), write });
  await first.ready(); await second.ready(); second.state.edit({ density: 'compact' }); second.render();
  first.state.edit({ theme: 'light' }); first.render(); assert.equal(await first.state.save(), true); await flush();
  assert.equal(await second.state.save(), false); second.render();
  assert.equal(second.writes[0].expectedRevision, 4); assert.equal(second.state.saved.revision, 4); assert.equal(second.state.phase, 'conflict');
  assert.equal(second.state.preferences.density, 'compact'); assert.equal(second.state.preferences.theme, 'dark'); assert.equal(authoritative.preferences.theme, 'light');
  assert.equal(authoritative.preferences.density, 'standard'); assert.equal(hub.messages.length, 1); assert.equal(second.reads.length, 1);
  assert.equal(await second.state.reload(), true); second.render(); second.state.discard(); await flush(); second.render(); second.render();
  assertTheme(second, 'light', 'light'); assert.equal(second.state.dirty, false);
});

test('a clean navigation acknowledgement atomically applies a newer theme before the same-revision message arrives', async () => {
  const response = deferred(), hub = broadcastHub(), f = fixture({ hub, opened: () => response.promise }); await f.ready();
  const navigation = f.state.markOpened('11111111-1111-4111-8111-111111111111');
  response.resolve(snapshot('light', { revision: 5 })); await navigation; f.render(); f.render();
  assertTheme(f, 'light', 'light'); assert.equal(f.state.saved.revision, 5); assert.equal(f.state.dirty, false); assert.equal(f.state.recentError, false);
  hub.emit({ type: 'ui-preferences-saved', version: 1, revision: 5 }); await flush();
  assert.equal(f.reads.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(hub.messages, []);
});

for (const editing of ['before', 'during']) test(`a navigation acknowledgement defers newer preferences when a draft was edited ${editing} its request`, async () => {
  const response = deferred(), hub = broadcastHub();
  const f = fixture({ hub, read: count => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }), opened: () => response.promise }); await f.ready();
  if (editing === 'before') f.state.edit({ density: 'compact' });
  const navigation = f.state.markOpened('11111111-1111-4111-8111-111111111111');
  if (editing === 'during') f.state.edit({ density: 'compact' });
  f.render(); response.resolve(snapshot('light', { revision: 5 })); await navigation; f.render(); f.render();
  assert.equal(f.state.saved.revision, 4); assertTheme(f, 'dark', 'dark'); assert.equal(f.state.preferences.density, 'compact'); assert.equal(f.state.dirty, true);
  assert.equal(f.state.recentError, false); assert.equal(f.reads.length, 1); assert.deepEqual(f.writes, []);
  f.state.discard(); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light'); assert.equal(f.state.dirty, false);
});

test('a restricted BroadcastChannel constructor still permits a guarded focus reread', async () => {
  const hub = { BroadcastChannel: class { constructor() { throw Error('channel restricted'); } } };
  const f = fixture({ hub, read: count => snapshot(count === 1 ? 'dark' : 'light', { revision: count === 1 ? 4 : 5 }) });
  await f.ready(); f.focus(); await flush(); f.render(); f.render(); assertTheme(f, 'light', 'light');
  assert.equal(f.reads.length, 2); assert.deepEqual(f.writes, []); f.unmount(); assert.equal(f.listeners.get('focus').size, 0);
});
