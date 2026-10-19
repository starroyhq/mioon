import { translate } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const start = app.indexOf('  useEffect(() => {\n    const controller = preferencesRef.current!;');
const end = app.indexOf('\n  }, []);', start);
assert.ok(start >= 0 && end > start, 'Actual App lifecycle effect must be uniquely extractable');
assert.equal(app.indexOf('  useEffect(() => {\n    const controller = preferencesRef.current;', start + 1), -1);
const effect = app.slice(start, end + '\n  }, []);'.length);
const deferred = () => Promise.withResolvers();

function fixture({ native = false, restored = false, restoredPersistence = false, pending = true, result = true, held = null, viewHeld = null, composing = false } = {}) {
  const origin = 'bc000000-0000-4000-8000-000000000001';
  const calls = [], listeners = new Map(), global = {}, workspaceRef = { current: { restored, ...(restored ? {workspaceOrigin: origin} : {}) } };
  let serial = 1, cleanup;
  const clip = {
    hasUnpersisted: () => pending,
    hasPendingComposition: () => composing,
    supportsRestoredPersistence: workspaceOrigin => restoredPersistence && (workspaceOrigin === undefined || workspaceOrigin === origin),
    capture: () => serial,
    isCurrent: value => value === serial,
    flushForClose: async () => { calls.push('clip'); const saved = held ? await held.promise : result; if (saved) pending = false; return saved; },
    save: () => assert.fail('Close must not save a timeline mutation'),
    discard: () => assert.fail('Close must not discard a draft'),
  };
  const clipDraftRef = { current: clip };
  const events = prefix => ({
    addEventListener: (name, callback) => listeners.set(prefix + name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(prefix + name) === callback) listeners.delete(prefix + name); },
  });
  const document = { ...events('document:'), visibilityState: 'visible' };
  const scope = { nativeWindow: native ? {} : null,
    useEffect: callback => { cleanup = callback(); }, globalThis: global, document, window: events('window:'),
    preferencesRef: { current: { flush: async () => { calls.push('view'); if (viewHeld) await viewHeld.promise; }, hasUnsaved: () => false } },
    lastProjectRef: { current: { flush: async () => { calls.push('locator'); return true; } } },
    localDeliveryRef: { current: null }, shotTextRef: { current: null }, clipDraftRef, workspaceRef,
  };
  Function(...Object.keys(scope), effect)(...Object.values(scope));
  return { calls, global, listeners, document, workspaceRef, clipDraftRef, clip, cleanup,
    changed: () => { serial++; }, setComposing: value => { composing = value; serial++; }, setUnpersisted: value => { pending = value; }, drain: () => global.__mioonFlushWorkspacePreferences() };
}

test('actual App close drain immediately waits for the registered clip draft instead of its debounce', async () => {
  const gate = deferred(), f = fixture({ held: gate }); let settled = false;
  const closing = f.drain().then(value => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['view', 'locator', 'clip']);
  assert.equal(settled, false, 'An unresolved local draft must not be reported saved');
  gate.resolve(true); assert.equal(await closing, true);
});

test('actual App close refusal remains false without retry, deletion or business submission', async () => {
  const f = fixture({ result: false });
  assert.equal(await f.drain(), false);
  assert.equal(f.calls.filter(value => value === 'clip').length, 1);
});

for (const change of ['replacement owner', 'new input', 'restored scope']) {
  test(`actual App late close ACK cannot approve ${change}`, async () => {
    const gate = deferred(), f = fixture({ held: gate }), closing = f.drain();
    await new Promise(setImmediate);
    if (change === 'replacement owner') f.clipDraftRef.current = { ...f.clip };
    if (change === 'new input') f.changed();
    if (change === 'restored scope') f.workspaceRef.current = { restored: true };
    gate.resolve(true); assert.equal(await closing, false);
    assert.equal(f.calls.filter(value => value === 'clip').length, 1);
  });
}

test('actual App restored branch skips local draft I/O and preserves the original view drain', async () => {
  const f = fixture({ restored: true });
  assert.equal(await f.drain(), true); assert.deepEqual(f.calls, ['view']);
});

test('actual App exact43 persistence drains only its clip and readonly view, then checks owner and origin after the ACK', async () => {
  const gate = deferred(), f = fixture({restored: true, restoredPersistence: true, held: gate});
  const closing = f.drain(); await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['view', 'clip']);
  gate.resolve(true); assert.equal(await closing, true);
  for (const change of ['origin', 'owner', 'input']) {
    const held = deferred(), next = fixture({restored: true, restoredPersistence: true, held});
    const pending = next.drain(); await new Promise(setImmediate);
    if (change === 'origin') next.workspaceRef.current = {...next.workspaceRef.current, workspaceOrigin: 'bc000000-0000-4000-8000-000000000002'};
    if (change === 'owner') next.clipDraftRef.current = {...next.clip};
    if (change === 'input') next.changed();
    held.resolve(true); assert.equal(await pending, false, change);
  }
});

test('actual43 browser beforeunload blocks unconfirmed input while pagehide remains best-effort', async () => {
  for (const pending of [false, true]) {
    const gate = deferred(), f = fixture({restored: true, restoredPersistence: true, pending, held: gate});
    let prevented = false; const event = {type: 'beforeunload', preventDefault() {prevented = true;}};
    f.listeners.get('window:beforeunload')(event);
    assert.equal(prevented, pending); assert.equal(event.returnValue, pending ? '' : undefined);
    assert.deepEqual(f.calls, pending ? ['view', 'clip'] : ['view']);
    gate.resolve(false); await new Promise(setImmediate);
  }
  const gate = deferred(), f = fixture({restored: true, restoredPersistence: true, held: gate});
  const event = {type: 'pagehide', preventDefault() {assert.fail('pagehide cannot be presented as cancellable');}};
  f.listeners.get('window:pagehide')(event); assert.deepEqual(f.calls, ['view', 'clip']);
  assert.equal(f.clip.hasUnpersisted(), true, 'dispatch alone is not a durable confirmation');
  gate.resolve(false); await new Promise(setImmediate); assert.equal(f.clip.hasUnpersisted(), true);
  const stale = fixture({restored: true, restoredPersistence: true});stale.workspaceRef.current.workspaceOrigin = 'bc000000-0000-4000-8000-000000000002';
  assert.equal(await stale.drain(), false);assert.deepEqual(stale.calls, [], 'a retained original controller cannot flush into a new origin');
  let blocked = false;stale.listeners.get('window:beforeunload')({type: 'beforeunload', preventDefault() {blocked = true;}});
  assert.equal(blocked, true);assert.deepEqual(stale.calls, ['view']);
});

test('actual App rechecks clip input after the slower unrelated view drain settles', async () => {
  const gate = deferred(), f = fixture({ viewHeld: gate, pending: false });
  const closing = f.drain(); await new Promise(setImmediate);
  assert.equal(f.calls.filter(value => value === 'clip').length, 1);
  f.changed(); gate.resolve(); assert.equal(await closing, false);
});

test('actual App initially missing clip cannot acknowledge a newly mounted owner', async () => {
  const gate = deferred(), f = fixture({ viewHeld: gate }); f.clipDraftRef.current = null;
  const closing = f.drain(); await new Promise(setImmediate);
  f.clipDraftRef.current = f.clip; gate.resolve(); assert.equal(await closing, false);
  assert.equal(f.calls.includes('clip'), false, 'Old close must not dispatch to the replacement');
});

test('actual App checks renewed persistence uncertainty after clip ACK while other drains wait', async () => {
  const gate = deferred(), f = fixture({ viewHeld: gate, pending: false });
  const token = f.clip.capture(), closing = f.drain(); await new Promise(setImmediate);
  assert.equal(f.clip.isCurrent(token), true);
  f.setUnpersisted(true); // Explicit reread/DELETE can change this without editing raw.
  assert.equal(f.clip.isCurrent(token), true);
  gate.resolve(); assert.equal(await closing, false);
  assert.equal(f.calls.filter(value => value === 'clip').length, 1);
});

test('actual App hidden/pagehide/beforeunload paths flush only unpersisted clip input', async () => {
  for (const event of ['window:beforeunload', 'window:pagehide', 'document:visibilitychange']) {
    const f = fixture(); f.document.visibilityState = 'hidden';
    f.listeners.get(event)(); await new Promise(setImmediate);
    assert.equal(f.calls.filter(value => value === 'clip').length, 1, event);
    const clean = fixture({ pending: false }); clean.document.visibilityState = 'hidden';
    clean.listeners.get(event)(); await new Promise(setImmediate);
    assert.equal(clean.calls.includes('clip'), false, event);
  }
  const visible = fixture(); visible.listeners.get('document:visibilitychange')();
  assert.deepEqual(visible.calls, []);
});

test('actual lifecycle cleanup retains a newer registered global close handler', () => {
  const f = fixture({ pending: false }), next = async () => false;
  f.global.__mioonFlushWorkspacePreferences = next; f.cleanup();
  assert.equal(f.global.__mioonFlushWorkspacePreferences, next);
  assert.equal(f.listeners.size, 0);
});

test('desktop close warning describes unconfirmed local drafts and view without promising cancellation', async () => {
  const main = readFileSync(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf("confirmClose: action => Boolean(smokeOutput) || dialog.showMessageBox");
  const until = main.indexOf('confirmUnknown:', at);
  assert.ok(at >= 0 && until > at);
  const source = main.slice(at, until);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    const nt = key => translate(locale, key), dialogs = [];
    let response = 1;
    const confirmClose = Function('smokeOutput', 'dialog', 'window', 'nt', `return ({${source}}).confirmClose;`)(false, { showMessageBox: async (_window, options) => { dialogs.push(options); return { response }; } }, {}, nt);
    for (const action of ['reload', 'quit']) {
      assert.equal(await confirmClose(action), false, 'Default keep-editing response cannot close');
      const warning = dialogs.at(-1);
      assert.equal(warning.title, nt('native.draftTitle'));
      assert.equal(warning.message, nt(action === 'reload' ? 'native.draftReloadMessage' : 'native.draftQuitMessage'));
      assert.equal(warning.detail, nt(action === 'reload' ? 'native.draftReloadDetail' : 'native.draftQuitDetail'));
      assert.deepEqual(warning.buttons, [nt(action === 'reload' ? 'native.reloadAnyway' : 'native.quitAnyway'), nt('native.keepEditing')]);
      assert.equal(warning.defaultId, 1); assert.equal(warning.cancelId, 1);
      if (locale === 'zh-Hans') {
        assert.match(warning.message, /本地草稿/); assert.match(warning.message, /视图/);
        assert.match(warning.message, /未确认/); assert.match(warning.detail, /不会取消/);
      }
      response = 0; assert.equal(await confirmClose(action), true, 'Only the explicit proceed response closes'); response = 1;
    }
  }
});


test('native editor close drains its own clip and view while the launcher exclusively drains the shared locator', async () => {
  const f=fixture({native:true});assert.equal(await f.drain(),true);assert.deepEqual(f.calls,['view','clip']);
  f.calls.length=0;await f.listeners.get('window:pagehide')();assert.equal(f.calls.includes('locator'),false);assert.equal(f.calls.includes('view'),true);
});

for (const restored of [false, true]) test(`actual App composition blocks close drain and beforeunload for restored=${restored}`, async () => {
 const f=fixture({restored,composing:true});
 assert.equal(await f.drain(),false);assert.deepEqual(f.calls,[]);
 let prevented=false;const event={type:'beforeunload',preventDefault(){prevented=true;}};
 f.listeners.get('window:beforeunload')(event);assert.equal(prevented,true);assert.equal(event.returnValue,'');assert.deepEqual(f.calls,[]);
 f.setComposing(false);assert.equal(await f.drain(),true);
});
test('actual App composition beginning during another drain rejects late close approval',async()=>{
 const gate=deferred(),f=fixture({viewHeld:gate,pending:false});const closing=f.drain();await Promise.resolve();f.setComposing(true);gate.resolve();assert.equal(await closing,false);
});
