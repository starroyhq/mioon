import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

const url = 'http://127.0.0.1:45000/?project=a';
const status = (version: number, patch = {}) => ({ dirty: false, busy: false, blocked: false, version, ...patch });
function fixture(initial = {}) {
  const registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  const owner = {}, operation = {};
  let state = { dirty: false, busy: false, unknown: true, identity: [owner, 1, operation], ...initial };
  let time = 1000, sequence = 0, reads = 0, scope = 'workspace:project:epoch';
  const admission = createNativeCloseAdmission({ registry, settings, readScope: () => scope,
    readDocumentURL: () => url, now: () => time, newToken: () => `unknown-ticket-${++sequence}`,
    readAdditionalSnapshot: () => { reads++; return state; } });
  const approve = (ticket: { token: string; }, patch = {}) => admission.commit(ticket.token, {
    discardDirty: false, allowDrainFailure: false, allowUnknown: true, expiresAt: time + 500, action: 'close', targetUrl: null, ...patch,
  });
  return { registry, settings, admission, approve, get state() { return state; }, get reads() { return reads; },
    change(patch: Partial<typeof state>) { state = { ...state, ...patch }; }, setTime(value: number) { time = value; }, setScope(value: string) { scope = value; },
    unload() { let prevented = false; const result = admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }); return { result, prevented }; },
  };
}

test('unknown stays open by default; ordinary discard and drain-failure approval cannot waive it', () => {
  const f = fixture(), ticket = f.admission.inspect();
  assert.equal(ticket.disposition, 'unknown');
  assert.deepEqual(Object.keys(ticket).sort(), ['disposition', 'token', 'version']);
  assert.deepEqual(f.unload(), { result: false, prevented: true });
  for (const patch of [{ allowUnknown: undefined, discardDirty: true }, { allowUnknown: false, discardDirty: true }, { allowDrainFailure: true }, { allowUnknown: 'true' }]) {
    assert.equal(f.approve(ticket, patch), false);
  }
  assert.equal(f.state.unknown, true);
});

test('explicit unknown-risk permission is consumed by one close without clearing evidence', () => {
  const f = fixture(), original = f.state, ticket = f.admission.inspect();
  assert.equal(f.approve(ticket), true);
  assert.deepEqual(f.unload(), { result: true, prevented: false });
  assert.strictEqual(f.state, original); assert.equal(f.state.unknown, true);
  assert.deepEqual(f.unload(), { result: false, prevented: true });
  assert.equal(f.approve(ticket), false);
  assert.equal(f.admission.inspect().disposition, 'unknown');
});

test('unknown plus dirty needs both independent decisions', () => {
  for (const source of ['additional', 'registry', 'settings']) {
    const f = fixture(source === 'additional' ? { dirty: true } : {});
    if (source === 'registry') f.registry.register('agent-chat').update(status(1, { dirty: true }));
    if (source === 'settings') f.settings.register('home:agent').update(status(1, { dirty: true }));
    const ticket = f.admission.inspect(); assert.equal(ticket.disposition, 'unknown-dirty');
    assert.equal(f.approve(ticket), false);
    assert.equal(f.approve(ticket, { discardDirty: true, allowUnknown: false }), false);
    assert.equal(f.approve(ticket, { discardDirty: true }), true);
    assert.equal(f.unload().result, true); assert.equal(f.state.unknown, true);
  }
});

for (const source of ['additional', 'registry-busy', 'registry-blocked', 'settings-busy', 'settings-blocked']) {
  test(`${source} cannot be waived by either or both confirmations`, () => {
    const f = fixture(source === 'additional' ? { busy: true } : {});
    if (source.startsWith('registry')) f.registry.register('agent-chat').update(status(1, { [source.split('-')[1]]: true }));
    if (source.startsWith('settings')) f.settings.register('home:agent').update(status(1, { [source.split('-')[1]]: true }));
    const ticket = f.admission.inspect(); assert.equal(ticket.disposition, 'blocked');
    assert.equal(f.approve(ticket, { discardDirty: true }), false);
    assert.equal(f.unload().prevented, true);
  });
}

const changes = {
  'same-unknown new input': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ identity: [f.state.identity[0], 2, f.state.identity[2]] }),
  'new unknown operation': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ identity: [f.state.identity[0], 2, {}] }),
  'owner replacement': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ identity: [{}, 1, f.state.identity[2]] }),
  'late acknowledgement': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ unknown: false, identity: [f.state.identity[0], 2, f.state.identity[2]] }),
  'new busy work': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ busy: true }),
  'new dirty input': (f: Awaited<ReturnType<typeof fixture>>) => f.change({ dirty: true }),
  'DOM input': (f: Awaited<ReturnType<typeof fixture>>) => f.admission.interacted(),
  'scope replacement': (f: Awaited<ReturnType<typeof fixture>>) => f.setScope('workspace:another-project:epoch'),
  'mutable capture sequence': (f: Awaited<ReturnType<typeof fixture>>) => { f.state.identity[1] = 2; },
  'new legacy owner': (f: Awaited<ReturnType<typeof fixture>>) => f.registry.register('agent-edits'),
};
for (const [label, change] of Object.entries(changes)) {
  for (const afterCommit of [false, true]) test(`${label} invalidates unknown choice ${afterCommit ? 'after commit' : 'before commit'}`, () => {
    const f = fixture(), ticket = f.admission.inspect();
    if (afterCommit) assert.equal(f.approve(ticket), true);
    change(f);
    if (afterCommit) assert.equal(f.unload().prevented, true);
    else assert.equal(f.approve(ticket), false);
  });
}

test('unknown choice cannot authorize reload or an action-swapped commit', () => {
  const f = fixture(), ticket = f.admission.inspect();
  assert.equal(f.approve(ticket, { action: 'reload', targetUrl: url }), false);
  assert.equal(f.approve(ticket, { targetUrl: url }), false);
  const reload = f.admission.inspect('reload', url);
  assert.equal(reload.disposition, 'blocked');
  assert.equal(f.approve(reload, { action: 'reload', targetUrl: url, discardDirty: true }), false);
  assert.equal(f.unload().prevented, true);
});

test('foreign, stale, cancelled and expired unknown tickets fail closed', () => {
  const f = fixture(), first = f.admission.inspect(), second = f.admission.inspect();
  assert.equal(f.approve(first), false);
  assert.equal(f.approve({ token: 'foreign-ticket' }), false);
  assert.equal(f.admission.cancel(first.token), false);
  assert.equal(f.approve(second), true);
  assert.equal(f.admission.cancel(second.token), true);
  assert.equal(f.approve(second), false); assert.equal(f.unload().prevented, true);
  const third = f.admission.inspect();
  for (const expiresAt of [999, 1000, 1000.5, 3001, Infinity, NaN]) assert.equal(f.approve(third, { expiresAt }), false);
  assert.equal(f.approve(third), true); f.setTime(1500); assert.equal(f.unload().prevented, true);
  assert.equal(f.state.unknown, true);
});

test('new inspection and disposal revoke an already approved unknown choice', () => {
  for (const revoke of [(f: Awaited<ReturnType<typeof fixture>>) => f.admission.inspect(), (f: Awaited<ReturnType<typeof fixture>>) => f.admission.dispose()]) {
    const f = fixture(), ticket = f.admission.inspect(); assert.equal(f.approve(ticket), true);
    revoke(f); assert.equal(f.unload().prevented, true); assert.equal(f.state.unknown, true);
  }
});

test('unknown risk is never silently added to a clean or ordinary dirty ticket', () => {
  for (const dirty of [false, true]) {
    const f = fixture({ unknown: false, dirty }), ticket = f.admission.inspect();
    assert.equal(ticket.disposition, dirty ? 'dirty' : 'clean');
    assert.equal(f.approve(ticket, { discardDirty: dirty }), false);
    assert.equal(f.approve(ticket, { allowUnknown: false, discardDirty: dirty }), true);
    assert.equal(f.unload().result, true);
  }
});

test('missing, malformed, unidentifiable or throwing additional snapshots fail closed', () => {
  for (const state of [null, undefined, {}, { dirty: false, busy: false, unknown: true, identity: [] },
    { dirty: false, busy: 'false', unknown: true, identity: ['owner', 1, 'operation'] },
    { dirty: false, busy: false, unknown: 'true', identity: ['owner', 1, 'operation'] },
    { dirty: false, busy: false, unknown: true, identity: {} }]) {
    const admission = createNativeCloseAdmission(({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
      readScope: () => '', newToken: () => 'invalid-snapshot', readAdditionalSnapshot: () => state } as unknown as Parameters<typeof createNativeCloseAdmission>[0]));
    assert.equal(admission.inspect().disposition, 'blocked');
    assert.equal(admission.beforeUnload({ preventDefault() {}, returnValue: '' }), false);
  }
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => '', newToken: () => 'throwing-snapshot', readAdditionalSnapshot() { throw Error('Unavailable'); } });
  assert.equal(admission.inspect().disposition, 'blocked');
  assert.equal(admission.beforeUnload({ preventDefault() {}, returnValue: '' }), false);
});

test('unknown inspection, commit and final validation are pure and preserve evidence', t => {
  const f = fixture(), original = structuredClone(f.state), calls = { timers: 0, fetch: 0 };
  t.mock.method(globalThis, 'setTimeout', () => { calls.timers++; throw Error('No scheduling allowed'); });
  t.mock.method(globalThis, 'fetch', () => { calls.fetch++; throw Error('No transport allowed'); });
  const ticket = f.admission.inspect(); assert.equal(f.approve(ticket), true); assert.equal(f.unload().result, true);
  assert.deepEqual(calls, { timers: 0, fetch: 0 }); assert.equal(f.reads, 3); assert.deepEqual(f.state, original);
});

test('omitting the optional snapshot preserves ordinary Web clean and dirty guards', () => {
  let dirty = false;
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => '', readLegacyDirty: () => dirty, newToken: () => 'old-web-ticket' });
  assert.equal(admission.inspect().disposition, 'clean');
  assert.equal(admission.beforeUnload({ preventDefault() {}, returnValue: '' }), true);
  dirty = true; assert.equal(admission.inspect().disposition, 'dirty');
  assert.equal(admission.beforeUnload({ preventDefault() {}, returnValue: '' }), false);
});
