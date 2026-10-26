import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { APP_LANGUAGE_EVENT } from '../packages/i18n/src/preference.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import type {LanguageSnapshot} from '../packages/i18n/src/preference.ts';

// Execute the actual main-process language-host wiring, with only native window
// and storage boundaries faked. This does not claim native destruction timing.
const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
const start = main.indexOf('    languageHost = createAppLanguageHost({ systemLanguages,');
const end = main.indexOf('\n    installMenu();', start);
assert.ok(start >= 0 && end > start, 'The main-process language host must remain testable.');
const wiring = main.slice(start, end);

interface Delivery {name: string; channel: string; snapshot: unknown}
interface FakeLanguageHost {dispatch(event: unknown, request: {action: string; preference?: string}): {preference: string; persistence: string; revision: number}; snapshot(): {revision: number}}
type LanguageWindow = {name: string; webContents: {mainFrame: {url: string}; send(channel: string, snapshot: unknown): void}};
for (const failure of ['send', 'webContents']) test(`language broadcasts isolate a destroyed window's ${failure} failure`, async () => {
  const deliveries: Delivery[] = [], listeners = new Set<(snapshot: LanguageSnapshot) => void>();
  let persisted: string | null = null, writes = 0, menuUpdates = 0, trayUpdates = 0, failedAttempts = 0, untrustedDeliveries = 0;
  const makeWindow = (name: string): LanguageWindow => ({ name, webContents: { mainFrame: { url: `http://127.0.0.1:49152/?window=${name}` },
    send(channel, snapshot) {
      deliveries.push({ name, channel, snapshot });
      if (name === 'initiator') for (const listener of listeners) listener(snapshot as LanguageSnapshot);
    } } });
  const destroyed = makeWindow('destroyed'), untrusted = makeWindow('untrusted');
  const observer = makeWindow('observer'), initiator = makeWindow('initiator');
  const fail = () => { failedAttempts++; throw new Error('Object has been destroyed'); };
  if (failure === 'send') destroyed.webContents.send = fail;
  else Object.defineProperty(destroyed, 'webContents', { get: fail });
  untrusted.webContents.send = () => { untrustedDeliveries++; };
  const owner = { frame: initiator.webContents.mainFrame, url: initiator.webContents.mainFrame.url, isCurrent: () => true };
  const context = vm.createContext({ createAppLanguageHost, systemLanguages: () => ['en'], paths: {},
    readAppLanguagePreference: (): string | null => persisted,
    writeAppLanguagePreference: (_paths: unknown, text: string): void => { writes++; persisted = text; },
    windowContext: {}, ownsWindow: (window: unknown): boolean => window === initiator,
    windowHost: {
      windowForContents: (contents: unknown): LanguageWindow | null => contents === initiator.webContents ? initiator : null,
      ownerForContents: (contents: unknown): typeof owner | null => contents === initiator.webContents ? owner : null,
      windows: (): LanguageWindow[] => [destroyed, untrusted, observer, initiator],
      // A native window can disappear immediately after this trusted check.
      isTrustedDocument: (window: unknown): boolean => window !== untrusted,
    },
    installMenu: (): void => { menuUpdates++; },
    trayHost: {refresh: (): void => { trayUpdates++; }},
  });
  const host = vm.runInContext(`let languageHost; ${wiring}\nlanguageHost;`, context) as FakeLanguageHost;
  const event = { sender: initiator.webContents, senderFrame: owner.frame };
  const store = createLanguageStore({ systemLanguages: ['en'], bridge: {
    read: async () => host.dispatch(event, { action: 'read' }) as unknown as LanguageSnapshot,
    set: async preference => host.dispatch(event, { action: 'set', preference }) as unknown as LanguageSnapshot,
    subscribe: (listener: (snapshot: LanguageSnapshot) => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } });
  await store.initialize();
  const saved = host.dispatch(event, { action: 'set', preference: 'ja' });
  assert.equal(saved.preference, 'ja'); assert.equal(saved.persistence, 'saved'); assert.equal(saved.revision, 1);
  assert.equal(failedAttempts, 1); assert.equal(writes, 1); assert.equal(menuUpdates, 1); assert.equal(trayUpdates, 1); assert.equal(untrustedDeliveries, 0);
  assert.deepEqual(JSON.parse(persisted!), { version: 1, preference: 'ja' });
  assert.deepEqual(deliveries.map(({ name }) => name), ['observer', 'initiator']);
  for (const delivery of deliveries) { assert.equal(delivery.channel, APP_LANGUAGE_EVENT); assert.equal(delivery.snapshot, saved); }
  assert.equal(store.getSnapshot().locale, 'ja'); assert.equal(store.getSnapshot().persistence, 'saved');

  await store.setPreference('zh-Hant');
  assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(store.getSnapshot().persistence, 'saved');
  assert.equal(store.getSnapshot().saving, false); assert.equal(writes, 2); assert.equal(failedAttempts, 2); assert.equal(untrustedDeliveries, 0);
  assert.equal(menuUpdates, 2); assert.equal(trayUpdates, 2);
  assert.equal(host.snapshot().revision, 2); assert.equal(JSON.parse(persisted!).preference, 'zh-Hant');
  store.dispose(); assert.equal(listeners.size, 0);
});
