import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeCloseAdmission, createNativeCloseRegistry, installNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import { combineNativeEntryClose } from '../apps/web/src/native-entry-close.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const flushStart = app.indexOf('  useEffect(() => {\n    const controller = preferencesRef.current;');
const flushEnd = app.indexOf('\n  }, []);', flushStart) + '\n  }, []);'.length;
const admissionStart = app.indexOf('  useEffect(() => installNativeCloseAdmission(');
const admissionEnd = app.indexOf('  useEffect(() => { if (showProjects)', admissionStart);
assert.ok(flushStart >= 0 && admissionStart > flushEnd && admissionEnd > admissionStart);
const flushEffect = app.slice(flushStart, flushEnd), admissionEffect = app.slice(admissionStart, admissionEnd);

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback, capture = false) {
      const entries = listeners.get(type) ?? []; entries.push({ callback, capture: Boolean(capture) }); listeners.set(type, entries);
    },
    removeEventListener(type, callback, capture = false) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry.callback !== callback || entry.capture !== Boolean(capture)));
    },
    async dispatch(type, afterListener) {
      const event = { type, defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } };
      // At a Window event target, capture listeners precede noncapture listeners
      // even when the noncapture listener was registered by an earlier effect.
      const entries = [...(listeners.get(type) ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
      const order = [];
      for (const { callback } of entries) {
        order.push(callback.name); callback(event);
        // A causal checkpoint deliberately permits promise continuations/late
        // ACKs between listeners, rather than validating a helper in isolation.
        await afterListener?.(callback.name, event);
      }
      return { event, order };
    },
  };
}
function fixture({ native = true, unknown = true, writesChangeState = false } = {}) {
  const window = target(), document = { ...target(), visibilityState: 'visible' }, global = {}, cleanups = [], calls = [], pauses = [];
  window.location = { href: 'http://127.0.0.1:45000/?project=a' };
  let additional = { dirty: false, busy: false, unknown, identity: [{}, 1, {}] };
  const record = { outcome: 'unknown', operation: 'original-operation', persisted: 'original-record' };
  const write = name => { calls.push(name); if (writesChangeState) additional = { ...additional, busy: true }; return Promise.resolve(true); };
  const clip = { hasPendingComposition: () => false, supportsRestoredPersistence: () => false,
    hasUnpersisted: () => { calls.push('clip-sync'); return true; }, flushForClose: () => write('clip-put'), capture: () => 1, isCurrent: () => true };
  const env = { combineNativeEntryClose, nativeProjectEntry: null,
    nativeWindow: native ? { role: 'editor', projectId: 'a' } : null,
    nativeSettingsScope: { pauseObservation(paused) { pauses.push(paused); } },
    window, document, globalThis: global, useEffect: callback => cleanups.push(callback()), installNativeCloseAdmission,
    nativeCloseRegistry: { current: createNativeCloseRegistry() }, settingsNavigation: { current: createSettingsNavigationRegistry() },
    readEditorWindowInputs: () => additional, readNativeLegacyClose: () => ({ dirty: false, identity: [] }),
    preferencesRef: { current: { flush: () => write('preferences-put'), hasUnsaved: () => false } },
    lastProjectRef: { current: { flush: () => write('locator-put') } },
    localDeliveryRef: { current: { controller: { hasUnsaved: () => { calls.push('title-sync'); return true; }, flush: () => write('title-put') } } },
    shotTextRef: { current: { hasUnpersisted: () => { calls.push('shot-sync'); return true; }, flush: () => write('shot-put') } },
    clipDraftRef: { current: clip }, shotCloseRef: { current: null }, timelineFormatRef: { current: null }, deliveryNameRef: { current: null },
    subtitlesRef: { current: null }, subjectsRef: { current: null }, dirtyRef: { current: false },
    importSession: { current: { active: true } }, currentProject: { current: 'a' }, projectEpoch: { current: 1 }, navigationEpoch: { current: 1 },
    workspaceRef: { current: { restored: false } }, workspaceOriginScope: () => 'normal',
  };
  Function('env', `with (env) { ${flushEffect}\n${admissionEffect} }`)(env);
  const admission = window.__mioonNativeCloseAdmission;
  return { window, document, global, cleanups, calls, pauses, admission, env, record,
    get state() { return additional; }, change(patch) { additional = { ...additional, ...patch }; },
    arm({ risk = unknown && native, action = 'close' } = {}) {
      const ticket = admission.inspect(action, action === 'reload' ? window.location.href : null);
      assert.equal(admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, ...(risk ? { allowUnknown: true } : {}),
        expiresAt: Date.now() + 1500, action, targetUrl: action === 'reload' ? window.location.href : null }), true);
      return ticket;
    },
    async hidden() { document.visibilityState = 'hidden'; return document.dispatch('visibilitychange'); },
  };
}

test('actual App causal counterexample: disabling only suppression writes before validation', async () => {
  // This isolates the reported mechanism in current App source; it is not a
  // claim that the entire old revision was executed.
  const f = fixture({ writesChangeState: true }); f.arm(); f.admission.suppressLifecycleFlush = () => false;
  const result = await f.window.dispatch('beforeunload');
  assert.deepEqual(result.order, ['prepare', 'flush', 'warn']);
  assert.equal(result.event.defaultPrevented, true);
  assert.ok(f.calls.includes('clip-put')); assert.ok(f.calls.includes('preferences-put'));
});

test('actual App risk close skips earlier flush then all exit lifecycle writes and controller synchronization', async () => {
  const f = fixture({ writesChangeState: true }), original = structuredClone(f.record); f.arm();
  const result = await f.window.dispatch('beforeunload');
  assert.deepEqual(result.order, ['prepare', 'flush', 'warn']); assert.equal(result.event.defaultPrevented, false);
  await f.hidden(); await f.window.dispatch('pagehide'); f.cleanups[0]();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.record, original); assert.equal(f.state.unknown, true);
  f.cleanups[1]();
});

for (const checkpoint of ['prepare', 'flush']) {
  for (const change of ['late ACK', 'new owner', 'new input', 'new busy']) {
    test(`actual ${change} after ${checkpoint} vetoes without a final write and restores subsequent lifecycle behavior`, async () => {
      const f = fixture(), ticket = f.arm();
      const result = await f.window.dispatch('beforeunload', async name => {
        if (name !== checkpoint) return;
        await Promise.resolve();
        if (change === 'late ACK') f.change({ unknown: false, identity: [f.state.identity[0], 2, f.state.identity[2]] });
        if (change === 'new owner') f.change({ identity: [{}, 1, f.state.identity[2]] });
        if (change === 'new input') f.admission.interacted();
        if (change === 'new busy') f.change({ busy: true });
      });
      assert.equal(result.event.defaultPrevented, true); assert.deepEqual(f.calls, []);
      assert.equal(f.admission.cancel(ticket.token), true);
      await f.hidden(); assert.ok(f.calls.includes('clip-put')); assert.equal(f.calls.includes('locator-put'), false, 'Native locator belongs only to the retained launcher');
    });
  }
}

test('expired risk admission reaches the final veto without flushing and does not suppress later pagehide', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(), ticket = f.arm();
  now += 1500;
  assert.equal((await f.window.dispatch('beforeunload')).event.defaultPrevented, true);
  assert.deepEqual(f.calls, []); f.admission.cancel(ticket.token);
  await f.window.dispatch('pagehide'); assert.ok(f.calls.includes('preferences-put'));
});

test('hidden/pagehide alone cannot consume an armed risk ticket or suppress existing lifecycle writes', async () => {
  for (const event of ['hidden', 'pagehide']) {
    const f = fixture(); f.arm();
    if (event === 'hidden') await f.hidden(); else await f.window.dispatch('pagehide');
    assert.ok(f.calls.includes('clip-put')); f.calls.length = 0;
    assert.equal((await f.window.dispatch('beforeunload')).event.defaultPrevented, false);
    assert.deepEqual(f.calls, []);
  }
});

test('a cancelled risk dialog preserves ordinary cleanup and explicit save behavior', async () => {
  const f = fixture(), ticket = f.admission.inspect(); f.admission.cancel(ticket.token);
  await f.global.__mioonFlushWorkspacePreferences();
  assert.ok(f.calls.includes('clip-put')); f.calls.length = 0;
  f.cleanups[0](); assert.ok(f.calls.includes('preferences-put')); f.cleanups[1]();
});

test('successful risk lifecycle suppression is revoked by exact cancel, new inspection, input or pageshow', async () => {
  for (const revoke of [async (f, ticket) => f.admission.cancel(ticket.token), async f => f.admission.inspect(),
    async f => f.window.dispatch('input'), async f => f.window.dispatch('pageshow')]) {
    const f = fixture(), ticket = f.arm(); await f.window.dispatch('beforeunload'); assert.deepEqual(f.calls, []);
    await revoke(f, ticket); await f.hidden(); assert.ok(f.calls.includes('preferences-put'));
  }
});

test('actual ordinary Web and native normal-close lifecycle paths retain their flushes', async () => {
  for (const native of [false, true]) {
    const f = fixture({ native, unknown: false }); f.arm({ risk: false });
    assert.equal((await f.window.dispatch('beforeunload')).event.defaultPrevented, false);
    assert.ok(f.calls.includes('clip-put')); f.calls.length = 0;
    await f.hidden(); assert.equal(f.calls.includes('locator-put'), !native); assert.ok(f.calls.includes('preferences-put')); f.calls.length = 0;
    await f.window.dispatch('pagehide'); assert.ok(f.calls.includes('preferences-put'));
  }
});

test('ordinary native reload still flushes and cannot borrow risk suppression', async () => {
  const f = fixture({ unknown: false }); f.arm({ risk: false, action: 'reload' });
  assert.equal((await f.window.dispatch('beforeunload')).event.defaultPrevented, false); assert.ok(f.calls.includes('clip-put'));
});

function observationFixture() {
  const effects = [], registry = createNativeCloseRegistry(), owner = registry.register('agent-chat');
  let serial = 0, version = 1;
  owner.update({ dirty: true, busy: false, blocked: false, version });
  const admission = createNativeCloseAdmission({ registry, settings: createSettingsNavigationRegistry(), readScope: () => 'same',
    now: () => 1000, newToken: () => `observation-${++serial}`,
    onObservationPause(paused) {
      effects.push(paused ? 'pause' : 'resume');
      // Models visibility clearing old observation synchronously, before capture.
      owner.update({ dirty: true, busy: false, blocked: false, version: ++version });
    },
    readLegacySnapshot() { effects.push('read'); return { dirty: false, identity: [] }; },
  });
  return { effects, admission, owner,
    arm(ticket) { return admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1500 }); },
    unload() { const event = { preventDefault() {}, returnValue: '' }; return admission.beforeUnload(event); },
  };
}

test('observation pauses before capture, allowing synchronous visibility changes to become the captured owner', () => {
  const f = observationFixture(), ticket = f.admission.inspect();
  assert.deepEqual(f.effects, ['pause', 'read']); assert.equal(ticket.disposition, 'dirty'); assert.equal(f.arm(ticket), true);
  assert.equal(f.unload(), true); assert.equal(f.effects.includes('resume'), false);
  f.admission.dispose(); assert.equal(f.effects.includes('resume'), false);
});

test('final veto is read-only; the exact later cancel resumes even after ticket consumption', t => {
  const f = observationFixture(), ticket = f.admission.inspect(); assert.equal(f.arm(ticket), true); f.admission.interacted();
  f.effects.length = 0;
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('Final validation cannot schedule'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Final validation cannot use transport'));
  assert.equal(f.unload(), false); assert.deepEqual(f.effects, ['read']);
  assert.equal(f.admission.cancel('foreign'), false); assert.deepEqual(f.effects, ['read']);
  assert.equal(f.admission.cancel(ticket.token), true); assert.deepEqual(f.effects, ['read', 'resume']);
  assert.equal(f.admission.cancel(ticket.token), false);
});

test('old cancellation cannot resume a newer inspection and disposal never resumes a destroyed owner', () => {
  const f = observationFixture(), first = f.admission.inspect(), second = f.admission.inspect();
  assert.equal(f.admission.cancel(first.token), false); assert.equal(f.effects.includes('resume'), false);
  assert.equal(f.admission.cancel(second.token), true); assert.equal(f.effects.filter(effect => effect === 'resume').length, 1);
  const last = f.admission.inspect(); f.admission.dispose();
  assert.equal(f.admission.cancel(last.token), false); assert.equal(f.effects.filter(effect => effect === 'resume').length, 1);
});

test('throwing capture retains an exact cancellation handle for observation recovery', () => {
  const effects = [];
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => 'same', newToken: () => 'reader-error-ticket', onObservationPause: paused => effects.push(paused),
    readLegacySnapshot() { throw Error('Unavailable owner'); } });
  const ticket = admission.inspect(); assert.equal(ticket.disposition, 'blocked'); assert.deepEqual(effects, [true]);
  assert.equal(admission.cancel('foreign'), false); assert.deepEqual(effects, [true]);
  assert.equal(admission.cancel(ticket.token), true); assert.deepEqual(effects, [true, false]);
});

test('cancelled armed risk ticket cannot suppress a later beforeunload flush', async () => {
  const f = fixture(), ticket = f.arm(); f.admission.cancel(ticket.token);
  assert.equal((await f.window.dispatch('beforeunload')).event.defaultPrevented, true);
  assert.ok(f.calls.includes('preferences-put')); assert.ok(f.calls.includes('clip-put'));
});
