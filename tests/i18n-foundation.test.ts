import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocale, resolveLocale, LOCALES, LANGUAGE_LABELS } from '../packages/i18n/src/locale.ts';
import { parseLanguagePreference, serializeLanguagePreference, isLanguageRequest, isLanguageSnapshot } from '../packages/i18n/src/preference.ts';
import { translate, message, renderMessage, validateCatalogs, assertNoDuplicateMessageKeys, formatDate, formatNumber } from '../packages/i18n/src/index.ts';
import type { Locale, LanguagePreference } from '../packages/i18n/src/index.ts';
import type { LanguageIPCEvent } from '../apps/desktop/src/app-language-host.ts';
import type { LanguageBridge } from '../packages/i18n/src/preference.ts';
const translateAny = translate as (locale: Locale, key: string, ...args: unknown[]) => string;
import { foundationMessages } from '../packages/i18n/src/catalogs/foundation.ts';
import { nativeMessages } from '../packages/i18n/src/catalogs/native.ts';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { createAppLanguageBridge } from '../apps/desktop/src/app-language-preload.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';

for (const [input, expected] of Object.entries({ 'zh-Hant': 'zh-Hant', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', 'zh-MO': 'zh-Hant', 'zh-Hant-CN': 'zh-Hant', 'zh-Hans-TW': 'zh-Hans', zh: 'zh-Hans', 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans', 'en-GB': 'en', 'ja-JP': 'ja', 'ja_JP.UTF-8': 'ja' })) {
  test(`locale input ${input} resolves without a region-specific catalog`, () => assert.equal(normalizeLocale(input), expected));
}
test('invalid/unsupported system locale falls back to English and explicit choice wins', () => {
  for (const value of [null, '', 'C', 'fr-FR', 'zh-Latn', 'zh-Hans-Hant', {}, 'en<script>']) assert.equal(normalizeLocale(value), null);
  assert.equal(resolveLocale('system', ['fr-FR', 'ja-JP']), 'ja'); assert.equal(resolveLocale('system', ['fr-FR']), 'en');
  assert.equal(resolveLocale('zh-Hant', ['en']), 'zh-Hant'); assert.deepEqual(Object.keys(LANGUAGE_LABELS), [...LOCALES]); assert.equal(LANGUAGE_LABELS['zh-Hant'], '繁體中文');
});
test('foundation/native catalogs have complete four-language placeholders', () => {
  assert.deepEqual(validateCatalogs(foundationMessages), []); assert.deepEqual(validateCatalogs(nativeMessages), []);
  assert.equal(translate('en', 'common.cancel'), 'Cancel'); assert.equal(renderMessage('ja', message('common.cancel')), 'キャンセル');
  assert.throws(() => translateAny('en', 'missing.key')); assert.equal(renderMessage('en', { key: 'missing.key' } as never), 'This message cannot be displayed right now');
  assert.throws(() => translateAny('en', 'native.chooseExecutable'));
  assert.equal(translate('en', 'native.chooseExecutable', { name: '<FFmpeg>' }), 'Choose the <FFmpeg> executable');
  assert.equal(renderMessage('en', '用户内容' as never), '用户内容');
  assert.match(formatNumber('en', 1234), /1,234/u); assert.equal(formatDate('en', 'not a date'), 'Unknown time');
});
test('preference envelope and IPC are narrow, exact and data-only', () => {
  assert.equal(parseLanguagePreference(serializeLanguagePreference('zh-Hant')), 'zh-Hant');
  for (const value of [{ version: 1, preference: 'zh-TW' }, { version: 1, preference: 'ja', projectId: 'x' }, { version: 2, preference: 'ja' }]) assert.throws(() => parseLanguagePreference(JSON.stringify(value)));
  assert.throws(() => parseLanguagePreference(' '.repeat(4097))); assert.throws(() => parseLanguagePreference('{'));
  assert.equal(isLanguageRequest({ action: 'read' }), true); assert.equal(isLanguageRequest({ action: 'set', preference: 'en' }), true);
  assert.equal(isLanguageRequest({ action: 'set', preference: 'en', path: '/tmp/p' }), false); assert.equal(isLanguageRequest({ action: 'set', preference: 'zh-TW' }), false);
  const getter = { action: 'set' }; Object.defineProperty(getter, 'preference', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.equal(isLanguageRequest(getter), false);
  assert.equal(isLanguageSnapshot({ version: 1, revision: 0, preference: 'ja', locale: 'en', persistence: 'saved' }), false);
});
test('native preference authorizes before any read/write, broadcasts and survives a fresh host', () => {
  let raw: string | null = null; const events: unknown[][] = [], owner = {}; let reads = 0, writes = 0;
  const storage = { read: () => { reads++; return raw; }, write: (value: string | null) => { writes++; raw = value; } };
  const options = { systemLanguages: () => ['zh-HK'], storage, isTrusted: (event: unknown) => event === owner, broadcast: (...args: unknown[]) => { events.push(args); } };
  const host = createAppLanguageHost(options); assert.equal(reads, 1); assert.equal(host.snapshot().locale, 'zh-Hant');
  assert.throws(() => host.dispatch({} as unknown as LanguageIPCEvent, { action: 'set', preference: 'ja' })); assert.equal(writes, 0);
  const saved = host.dispatch(owner as unknown as LanguageIPCEvent, { action: 'set', preference: 'ja' }); assert.equal(saved.locale, 'ja'); assert.equal(saved.revision, 1); assert.equal(writes, 1); assert.equal(events.length, 1);
  assert.ok(typeof raw === 'string'); assert.deepEqual(JSON.parse(raw), { version: 1, preference: 'ja' }); assert.equal(createAppLanguageHost(options).snapshot().locale, 'ja');
  host.dispatch(owner as unknown as LanguageIPCEvent, { action: 'set', preference: 'system' }); assert.equal(host.snapshot().locale, 'zh-Hant');
});
test('corrupt/read-only preference never lies about persistence or overwrites on read', () => {
  let writes = 0; const host = createAppLanguageHost({ systemLanguages: () => ['ja'], isTrusted: () => true, broadcast() {}, storage: { read: () => '{', write() { writes++; throw new Error('read-only'); } } });
  assert.equal(host.snapshot().persistence, 'read-failed'); assert.equal(writes, 0);
  const next = host.dispatch({} as unknown as LanguageIPCEvent, { action: 'set', preference: 'en' }); assert.equal(next.locale, 'en'); assert.equal(next.persistence, 'session'); assert.equal(writes, 1);
});
test('preload exposes fixed typed methods and rejects arbitrary channels/fields', async () => {
  const calls: unknown[][] = [], listeners = new Set<(event: unknown, value: unknown) => void>(); const next = { version: 1 as const, revision: 0, preference: 'en' as LanguagePreference, locale: 'en' as Locale, persistence: 'saved' as const };
  const bridge = createAppLanguageBridge({ invoke: async (...args: unknown[]) => { calls.push(args); return next; }, on: (_channel: string, listener: (event: unknown, value: unknown) => void) => { listeners.add(listener); }, removeListener: (_channel: string, listener: (event: unknown, value: unknown) => void) => { listeners.delete(listener); } } as Parameters<typeof createAppLanguageBridge>[0]);
  assert.equal((await bridge.read()).locale, 'en'); await bridge.set('ja'); await assert.rejects(bridge.set('zh-TW' as never)); assert.equal(calls.length, 2); assert.equal(calls[0]?.[0], 'mioon:app-language:v1');
  let observed = 0; const release = bridge.subscribe(value => { assert.equal(value.locale, 'en'); observed++; });
  for (const listener of listeners) { listener({}, { ...next, secret: 'not allowed' }); listener({}, next); }
  assert.equal(observed, 1); release(); assert.equal(listeners.size, 0); assert.equal(Object.isFrozen(bridge), true);
});
test('web manual language persists independently and storage events do not write back', async () => {
  const records = new Map<string, string>(); let writes = 0; const storage = () => ({ getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { writes++; records.set(key, value); } });
  const store = createLanguageStore({ systemLanguages: ['en'], storage }); await store.setPreference('ja'); assert.equal(store.getSnapshot().locale, 'ja'); assert.equal(writes, 1);
  assert.deepEqual([...records.keys()], ['mioon.app-language.v1']); assert.equal(createLanguageStore({ systemLanguages: ['en'], storage }).getSnapshot().locale, 'ja');
  store.receiveStorage(serializeLanguagePreference('zh-Hant')); assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(writes, 1);
  store.receiveStorage('{'); assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(store.getSnapshot().persistence, 'read-failed');
});
test('web storage failure is session-only without changing other app state', async () => {
  const store = createLanguageStore({ systemLanguages: ['ja'], storage: () => { throw new Error('disabled'); } }); assert.equal(store.getSnapshot().persistence, 'read-failed');
  await store.setPreference('en'); assert.equal(store.getSnapshot().locale, 'en'); assert.equal(store.getSnapshot().persistence, 'session');
});
test('native stale reads cannot overwrite a newer broadcast and reconnect does not remount application state', async () => {
  let resolveRead: ((value: unknown) => void) | undefined; const listeners = new Set<(value: unknown) => void>(); let requests = 0;
  const snapshot = (revision: number, preference: LanguagePreference) => ({ version: 1 as const, revision, preference, locale: preference, persistence: 'saved' as const });
  const bridge = { read: () => new Promise<unknown>(resolve => { resolveRead = resolve; }), set: async (preference: LanguagePreference) => { requests++; return snapshot(2, preference); }, subscribe: (listener: (value: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as LanguageBridge;
  const store = createLanguageStore({ systemLanguages: ['en'], bridge }); const release = store.connect(); assert.equal(store.getSnapshot().ready, false);
  for (const listener of listeners) listener(snapshot(1, 'ja')); assert.ok(resolveRead); resolveRead(snapshot(0, 'en')); await Promise.resolve();
  assert.equal(store.getSnapshot().locale, 'ja'); await store.setPreference('zh-Hant'); assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(requests, 1);
  release(); assert.equal(listeners.size, 0); const again = store.connect(); assert.equal(listeners.size, 1); again(); assert.equal(listeners.size, 0);
});

test('catalog fragments cannot silently overwrite a duplicate semantic key', () => {
  assert.throws(() => assertNoDuplicateMessageKeys(foundationMessages, foundationMessages), /Duplicate message key/);
  assert.doesNotThrow(() => assertNoDuplicateMessageKeys(foundationMessages, nativeMessages));
});
test('plural selection keeps numeric counts while formatting only their display value', () => {
  assert.equal(translate('en', 'timeline.view.clipCount', { duration: '00:10', count: 1 }), '00:10 · 1 clip');
  assert.equal(translate('en', 'timeline.view.clipCount', { duration: '00:10', count: 1000 }), '00:10 · 1,000 clips');
  for (const locale of LOCALES) assert.ok(translate(locale, 'timeline.view.clipCount', { duration: '00:10', count: 1000 }).includes(formatNumber(locale, 1000)));
  let reads = 0; const params = { duration: '00:10' }; Object.defineProperty(params, 'count', { enumerable: true, get() { reads++; return 1; } });
  assert.equal(renderMessage('en', { key: 'timeline.view.clipCount', params }), 'This message cannot be displayed right now'); assert.equal(reads, 0);
});
test('system-language changes affect only system preference without saving or requests', async () => {
  let writes = 0; const store = createLanguageStore({ systemLanguages: ['en'], storage: () => ({ getItem: () => null, setItem: () => { writes++; } }) });
  await store.updateSystemLanguages(['zh-HK']); assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(writes, 0);
  await store.setPreference('ja'); await store.updateSystemLanguages(['en']); assert.equal(store.getSnapshot().locale, 'ja'); assert.equal(writes, 1);
});

test('unknown language requests reject accessors and unsupported prototypes without invoking them', () => {
  let reads = 0;
  const getter = {}; Object.defineProperty(getter, 'action', { enumerable: true, get() { reads++; throw new Error('not data'); } });
  assert.equal(isLanguageRequest(getter), false); assert.equal(reads, 0);
  const inherited = Object.create({ get action() { reads++; return 'read'; } });
  assert.equal(isLanguageRequest(inherited), false); assert.equal(reads, 0);
  const custom = Object.assign(Object.create({}), { action: 'read' });
  assert.equal(isLanguageRequest(custom), false);
  assert.equal(isLanguageRequest(Object.assign(Object.create(null), { action: 'read' })), true);
});

test('a native system-language refresh updates menus and every window without persisting project data', () => {
  let system = ['en'], writes = 0, menuUpdates = 0; const broadcasts: unknown[] = [];
  const host = createAppLanguageHost({ systemLanguages: () => system, isTrusted: () => true,
    storage: { read: () => null, write: () => { writes++; } }, onChanged: () => { menuUpdates++; }, broadcast: (_channel: string, value: unknown) => { broadcasts.push(value); } });
  system = ['ja']; const next = host.dispatch({} as unknown as LanguageIPCEvent, { action: 'read' });
  assert.equal(next.locale, 'ja'); assert.equal(next.revision, 1); assert.equal(menuUpdates, 1); assert.equal(broadcasts.length, 1); assert.equal(writes, 0);
  host.dispatch({} as unknown as LanguageIPCEvent, { action: 'read' }); assert.equal(broadcasts.length, 1);
  host.dispatch({} as unknown as LanguageIPCEvent, { action: 'set', preference: 'zh-Hant' }); system = ['en'];
  assert.equal(host.dispatch({} as unknown as LanguageIPCEvent, { action: 'read' }).locale, 'zh-Hant'); assert.equal(broadcasts.length, 2); assert.equal(writes, 1);
});
