import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createAppLanguageHost } from '../apps/desktop/src/app-language-host.ts';
import { APP_LANGUAGE_EVENT } from '../packages/i18n/src/preference.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';

// Execute the actual main-process language-host wiring, with only native window
// and storage boundaries faked. This does not claim native destruction timing.
const main = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
const start = main.indexOf('    languageHost = createAppLanguageHost({ systemLanguages,');
const end = main.indexOf('\n    installMenu();', start);
assert.ok(start >= 0 && end > start, 'The main-process language host must remain testable.');
const wiring = main.slice(start, end);

for (const failure of ['send', 'webContents']) test(`language broadcasts isolate a destroyed window's ${failure} failure`, async () => {
  const deliveries = [], listeners = new Set();
  let persisted = null, writes = 0, menuUpdates = 0, failedAttempts = 0, untrustedDeliveries = 0;
  const makeWindow = name => ({ name, webContents: { mainFrame: { url: `http://127.0.0.1:49152/?window=${name}` },
    send(channel, snapshot) {
      deliveries.push({ name, channel, snapshot });
      if (name === 'initiator') for (const listener of listeners) listener(snapshot);
    } } });
  const destroyed = makeWindow('destroyed'), untrusted = makeWindow('untrusted');
  const observer = makeWindow('observer'), initiator = makeWindow('initiator');
  const fail = () => { failedAttempts++; throw new Error('Object has been destroyed'); };
  if (failure === 'send') destroyed.webContents.send = fail;
  else Object.defineProperty(destroyed, 'webContents', { get: fail });
  untrusted.webContents.send = () => { untrustedDeliveries++; };
  const owner = { frame: initiator.webContents.mainFrame, url: initiator.webContents.mainFrame.url, isCurrent: () => true };
  const context = vm.createContext({ createAppLanguageHost, systemLanguages: () => ['en'], paths: {},
    readAppLanguagePreference: () => persisted,
    writeAppLanguagePreference: (_paths, text) => { writes++; persisted = text; },
    windowContext: {}, ownsWindow: window => window === initiator,
    windowHost: {
      windowForContents: contents => contents === initiator.webContents ? initiator : null,
      ownerForContents: contents => contents === initiator.webContents ? owner : null,
      windows: () => [destroyed, untrusted, observer, initiator],
      // A native window can disappear immediately after this trusted check.
      isTrustedDocument: window => window !== untrusted,
    },
    installMenu: () => { menuUpdates++; },
  });
  const host = vm.runInContext(`let languageHost; ${wiring}\nlanguageHost;`, context);
  const event = { sender: initiator.webContents, senderFrame: owner.frame };
  const store = createLanguageStore({ systemLanguages: ['en'], bridge: {
    read: async () => host.dispatch(event, { action: 'read' }),
    set: async preference => host.dispatch(event, { action: 'set', preference }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  await store.initialize();
  const saved = host.dispatch(event, { action: 'set', preference: 'ja' });
  assert.equal(saved.preference, 'ja'); assert.equal(saved.persistence, 'saved'); assert.equal(saved.revision, 1);
  assert.equal(failedAttempts, 1); assert.equal(writes, 1); assert.equal(menuUpdates, 1); assert.equal(untrustedDeliveries, 0);
  assert.deepEqual(JSON.parse(persisted), { version: 1, preference: 'ja' });
  assert.deepEqual(deliveries.map(({ name }) => name), ['observer', 'initiator']);
  for (const delivery of deliveries) { assert.equal(delivery.channel, APP_LANGUAGE_EVENT); assert.equal(delivery.snapshot, saved); }
  assert.equal(store.getSnapshot().locale, 'ja'); assert.equal(store.getSnapshot().persistence, 'saved');

  await store.setPreference('zh-Hant');
  assert.equal(store.getSnapshot().locale, 'zh-Hant'); assert.equal(store.getSnapshot().persistence, 'saved');
  assert.equal(store.getSnapshot().saving, false); assert.equal(writes, 2); assert.equal(failedAttempts, 2); assert.equal(untrustedDeliveries, 0);
  assert.equal(host.snapshot().revision, 2); assert.equal(JSON.parse(persisted).preference, 'zh-Hant');
  store.dispose(); assert.equal(listeners.size, 0);
});
