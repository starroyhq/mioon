import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const start = app.indexOf('  useEffect(() => {\n    const controller = preferencesRef.current;');
const end = app.indexOf('\n  }, []);', start);
assert.ok(start >= 0 && end > start, 'Actual App lifecycle effect must be uniquely extractable');
assert.equal(app.indexOf('  useEffect(() => {\n    const controller = preferencesRef.current;', start + 1), -1);
const effect = app.slice(start, end + '\n  }, []);'.length);
const deferred = () => Promise.withResolvers();

function fixture({ restored = false, pending = true, result = true, held = null, viewHeld = null } = {}) {
  const calls = [], listeners = new Map(), global = {}, workspaceRef = { current: { restored } };
  let serial = 1, cleanup;
  const clip = {
    hasUnpersisted: () => pending,
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
  const scope = {
    useEffect: callback => { cleanup = callback(); }, globalThis: global, document, window: events('window:'),
    preferencesRef: { current: { flush: async () => { calls.push('view'); if (viewHeld) await viewHeld.promise; }, hasUnsaved: () => false } },
    lastProjectRef: { current: { flush: async () => { calls.push('locator'); return true; } } },
    localDeliveryRef: { current: null }, shotTextRef: { current: null }, clipDraftRef, workspaceRef,
  };
  Function(...Object.keys(scope), effect)(...Object.values(scope));
  return { calls, global, listeners, document, workspaceRef, clipDraftRef, clip, cleanup,
    changed: () => { serial++; }, setUnpersisted: value => { pending = value; }, drain: () => global.__mioonFlushWorkspacePreferences() };
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

test('desktop close warning describes unconfirmed local drafts and view without promising cancellation', () => {
  const main = readFileSync(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');
  const at = main.indexOf("confirmClose: () => !ownsWindow(window, context) || smokeOutput || dialog.showMessageBoxSync");
  const until = main.indexOf('onCancel:', at);
  assert.ok(at >= 0 && until > at);
  const warning = main.slice(at, until);
  assert.match(warning, /本地草稿/); assert.match(warning, /视图/);
  assert.match(warning, /未确认/); assert.match(warning, /不会取消/);
  assert.match(warning, /buttons: \['仍然退出', '继续编辑'\], defaultId: 1, cancelId: 1/);
});
