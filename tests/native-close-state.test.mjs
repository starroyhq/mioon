import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCloseAdmission, createNativeCloseRegistry, installNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';

const status = (version, patch = {}) => ({ dirty: false, busy: false, blocked: false, version, ...patch });
function fixture() {
  const registry = createNativeCloseRegistry(), settings = createSettingsNavigationRegistry();
  let time = 1000, serial = 0, scope = 'workspace-a:project-a:1', documentURL = 'http://127.0.0.1:8123/?project=a', legacy = false;
  const options = { registry, settings, readScope: () => scope, readLegacyDirty: () => legacy, readDocumentURL: () => documentURL, now: () => time, newToken: () => `document-token-${++serial}` };
  const admission = createNativeCloseAdmission(options);
  return { registry, settings, admission, options, setTime: value => time = value, setScope: value => scope = value, setLegacy: value => legacy = value, setURL: value => documentURL = value,
    arm: (ticket, discardDirty = false, expiresAt = time + 1000) => admission.commit(ticket.token, { discardDirty, allowDrainFailure: false, expiresAt }),
    unload() { let prevented = false; const event = { preventDefault() { prevented = true; }, returnValue: undefined }; const result = admission.beforeUnload(event); return { result, prevented }; },
  };
}
test('registry accepts only fixed sources and unreported owners fail closed', () => {
  const f = fixture(); assert.throws(() => f.registry.register('arbitrary'), TypeError);
  const owner = f.registry.register('agent-chat'); assert.equal(f.admission.inspect().disposition, 'blocked');
  owner.update(status(1)); assert.equal(f.admission.inspect().disposition, 'clean');
});
test('replacement and retired callbacks cannot erase or certify another owner', () => {
  const f = fixture(), first = f.registry.register('agent-chat'); first.update(status(1, { dirty: true }));
  const before = f.admission.inspect(), next = f.registry.register('agent-chat'); next.update(status(1, { blocked: true }));
  first.update(status(2)); first.release(); assert.equal(f.admission.inspect().disposition, 'blocked'); assert.equal(f.arm(before, true), false);
  next.update(status(2)); assert.equal(f.admission.inspect().disposition, 'clean');
});
test('malformed source report invalidates the previous clean snapshot', () => {
  const f = fixture(), owner = f.registry.register('image-generation'); owner.update(status(1)); const ticket = f.admission.inspect();
  owner.update({ ...status(2), blocked: 'false' }); assert.equal(f.arm(ticket), false); assert.equal(f.admission.inspect().disposition, 'blocked');
});
test('equal or older report versions never clear busy or unknown', () => {
  const f = fixture(), owner = f.registry.register('agent-edits'); owner.update(status(3, { busy: true }));
  owner.update(status(3)); owner.update(status(2)); assert.equal(f.admission.inspect().disposition, 'blocked');
  owner.update(status(4)); assert.equal(f.admission.inspect().disposition, 'clean');
});
for (const field of ['busy', 'blocked']) test(`${field} cannot be converted into discard permission`, () => {
  const f = fixture(), owner = f.registry.register('agent-chat'); owner.update(status(1, { [field]: true }));
  const ticket = f.admission.inspect(); assert.equal(ticket.disposition, 'blocked'); assert.equal(f.arm(ticket, true), false);
  assert.deepEqual(f.unload(), { result: false, prevented: true });
});
test('dirty confirmation is exact and consumed only once without changing source state', () => {
  const f = fixture(), owner = f.registry.register('image-generation'); owner.update(status(1, { dirty: true }));
  const ticket = f.admission.inspect(); assert.equal(ticket.disposition, 'dirty'); assert.equal(f.arm(ticket), false);
  assert.equal(f.arm(ticket, true), true); assert.deepEqual(f.unload(), { result: true, prevented: false });
  assert.deepEqual(f.unload(), { result: false, prevented: true }); assert.equal(f.admission.inspect().disposition, 'dirty');
});
test('new same-boolean input invalidates confirmation, including edit then clear', () => {
  for (const change of [owner => owner.update(status(2, { dirty: true })), owner => { owner.update(status(2, { dirty: true })); owner.update(status(3)); }]) {
    const f = fixture(), owner = f.registry.register('agent-chat'); owner.update(status(1, { dirty: true })); const ticket = f.admission.inspect();
    assert.equal(f.arm(ticket, true), true); change(owner); assert.deepEqual(f.unload(), { result: false, prevented: true });
  }
});
test('DOM interaction and project/workspace changes invalidate an already armed close', () => {
  for (const change of [f => f.admission.interacted(), f => f.setScope('workspace-a:project-b:2'), f => f.setScope('workspace-b:project-a:1')]) {
    const f = fixture(), ticket = f.admission.inspect(); assert.equal(f.arm(ticket), true); change(f);
    assert.deepEqual(f.unload(), { result: false, prevented: true });
  }
});
test('all settings owners participate even while hidden and blocked is never discardable', () => {
  for (const slot of ['home:agent', 'home:official', 'home:custom', 'home:comfy', 'workbench:agent', 'workbench:official', 'workbench:custom', 'workbench:comfy']) {
    const f = fixture(), owner = f.settings.register(slot); owner.update(status(1, { dirty: true })); const ticket = f.admission.inspect();
    assert.equal(ticket.disposition, 'dirty'); owner.update(status(2, { blocked: true })); assert.equal(f.arm(ticket, true), false);
    assert.equal(f.admission.inspect().disposition, 'blocked'); owner.update(status(3)); assert.equal(f.admission.inspect().disposition, 'clean');
  }
});
test('settings same-dirty new input or newer owner invalidates prior approval', () => {
  const f = fixture(), owner = f.settings.register('home:agent'); owner.update(status(1, { dirty: true })); const ticket = f.admission.inspect();
  assert.equal(f.arm(ticket, true), true); owner.update(status(2, { dirty: true })); assert.equal(f.unload().prevented, true);
  const next = f.admission.inspect(); f.settings.register('home:agent'); owner.release(); assert.equal(f.arm(next, true), false);
});
test('legacy dirty still needs explicit confirmation, and successful drain may remove it', () => {
  const f = fixture(); f.setLegacy(true); const ticket = f.admission.inspect(); assert.equal(f.arm(ticket), false);
  f.setLegacy(false); assert.equal(f.arm(ticket, true), true); assert.equal(f.unload().prevented, false);
  const clean = f.admission.inspect(); f.setLegacy(true); assert.equal(f.arm(clean, true), false);
});
test('expiry and cancellation cannot leave permission for a later unload', () => {
  const f = fixture(), ticket = f.admission.inspect(); assert.equal(f.arm(ticket), true); f.setTime(2000);
  assert.equal(f.unload().prevented, true); const next = f.admission.inspect(); assert.equal(f.arm(next), true);
  assert.equal(f.admission.cancel(next.token), true); assert.equal(f.unload().prevented, true);
});
test('late commit after cancellation and old cancel after replacement never authorize or revoke another attempt', () => {
  const f = fixture(), first = f.admission.inspect(); f.admission.cancel(first.token); assert.equal(f.arm(first, true), false);
  const next = f.admission.inspect(); assert.equal(f.admission.cancel(first.token), false); assert.equal(f.arm(next), true);
  assert.equal(f.unload().prevented, false);
});
test('malformed and excessive commit leases fail closed', () => {
  const f = fixture(), ticket = f.admission.inspect();
  for (const expiry of [NaN, Infinity, 1000, 3001, 1000.5]) assert.equal(f.arm(ticket, false, expiry), false);
  assert.equal(f.admission.commit(ticket.token, { discardDirty: 1, allowDrainFailure: true, expiresAt: 1500 }), false);
});
test('disposed renderer cannot grant or consume an outstanding native ticket', () => {
  const f = fixture(), ticket = f.admission.inspect(); assert.equal(f.arm(ticket), true); f.admission.dispose();
  assert.equal(f.arm(ticket), false); assert.equal(f.unload().prevented, true);
});
test('a failed synchronous owner read still vetoes unload rather than throwing past the browser guard', () => {
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => 'fixture', readLegacyDirty: () => { throw new Error('owner unavailable'); } });
  let blocked = false;
  assert.equal(admission.beforeUnload({ preventDefault() { blocked = true; }, returnValue: undefined }), false);
  assert.equal(blocked, true);
});
test('public inspection exposes only protocol token and disposition', () => {
  const f = fixture(), owner = f.registry.register('image-generation'); owner.update({ ...status(1, { dirty: true }), prompt: 'private', key: 'secret' });
  const result = f.admission.inspect(); assert.deepEqual(Object.keys(result).sort(), ['disposition', 'token', 'version']);
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(Object.keys(f.registry.capture()[0]).sort(), ['blocked', 'busy', 'dirty', 'owner', 'slot', 'version']);
});

test('reload ticket is bound to the exact current document and cannot authorize close or another navigation', () => {
  const f = fixture(), url = 'http://127.0.0.1:8123/?project=a';
  const reload = f.admission.inspect('reload', url);
  assert.equal(reload.disposition, 'clean');
  assert.equal(f.arm(reload), false);
  const options = { discardDirty: false, allowDrainFailure: false, expiresAt: 1500, action: 'reload', targetUrl: url };
  assert.equal(f.admission.commit(reload.token, { ...options, targetUrl: url + '&changed=1' }), false);
  assert.equal(f.admission.commit(reload.token, options), true);
  f.setURL(url + '&changed=1');
  assert.equal(f.unload().prevented, true);
  const close = f.admission.inspect();
  assert.equal(f.admission.commit(close.token, options), false);
});
test('reload rejects arbitrary target URLs and malformed actions; valid reload still requires exact dirty confirmation', () => {
  const f = fixture(), url = 'http://127.0.0.1:8123/?project=a';
  for (const target of [null, '', 'http://127.0.0.1:8123/?project=b', 'https://other.example/', 'x'.repeat(8193)]) {
    assert.equal(f.admission.inspect('reload', target).disposition, 'blocked');
  }
  assert.equal(f.admission.inspect('navigate', url).disposition, 'blocked');
  assert.equal(f.admission.inspect('close', url).disposition, 'blocked');
  const owner = f.registry.register('agent-chat'); owner.update(status(1, { dirty: true }));
  const ticket = f.admission.inspect('reload', url);
  const options = { discardDirty: false, allowDrainFailure: false, expiresAt: 1500, action: 'reload', targetUrl: url };
  assert.equal(f.admission.commit(ticket.token, options), false);
  assert.equal(f.admission.commit(ticket.token, { ...options, discardDirty: true }), true);
  assert.equal(f.unload().prevented, false);
});

test('actual delivery controller programmatic dirty-to-dirty edit cannot reuse native discard permission', async () => {
  const { createTimelineDeliveryNameController } = await import('../apps/web/src/export-delivery-state.ts');
  const { readNativeLegacyClose } = await import('../apps/web/src/native-close-legacy.ts');
  for (const afterCommit of [false, true]) {
    const f = fixture();
    let delivery = createTimelineDeliveryNameController();
    delivery.setContext({ scope: 'same', projectId: 'project-a', enabled: true }); delivery.choose('A', 'same');
    const admission = createNativeCloseAdmission({ ...f.options, readLegacySnapshot: () => readNativeLegacyClose({ delivery }) });
    const ticket = admission.inspect();
    const choice = { discardDirty: true, allowDrainFailure: false, expiresAt: 1500 };
    assert.equal(ticket.disposition, 'dirty');
    if (afterCommit) assert.equal(admission.commit(ticket.token, choice), true);
    delivery.choose('B', 'same', delivery.getState().version);
    assert.equal(delivery.getState().dirty, true);
    if (!afterCommit) assert.equal(admission.commit(ticket.token, choice), false);
    else {
      let prevented = false;
      assert.equal(admission.beforeUnload({ preventDefault() { prevented = true; }, returnValue: '' }), false);
      assert.equal(prevented, true);
    }
    const next = admission.inspect();
    const replacement = createTimelineDeliveryNameController();
    replacement.setContext({ scope: 'same', projectId: 'project-a', enabled: true }); replacement.choose('B', 'same');
    delivery = replacement;
    assert.equal(admission.commit(next.token, choice), false);
  }
});

test('commit and final unload use pure real shot getter without synchronizing, scheduling or transport', async t => {
  const { createLocalShotTextController } = await import('../apps/web/src/local-shot-text-state.ts');
  const { readNativeLegacyClose } = await import('../apps/web/src/native-close-legacy.ts');
  const context = { scope: 'same', projectId: null, shotId: null, revision: null, baseRevision: null,
    baseText: { title: '', prompt: '' }, savedText: { title: '', prompt: '' }, raw: { title: '', prompt: '' },
    restored: false, connected: false, visible: false, busy: false, textVersion: 0, formSerial: 0, textDirty: false, formDirty: false };
  let syncs = 0, writes = 0, timers = 0, changes = 0;
  const shot = createLocalShotTextController({ context, getContext: () => { syncs++; throw Error('Must not sync during close validation'); },
    client: new Proxy({}, { get() { writes++; throw Error('No transport'); } }), isShotUpdateInput: () => false, onChange() { changes++; } });
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { timers++; return timer(...args); });
  const f = fixture(), admission = createNativeCloseAdmission({ ...f.options, readLegacySnapshot: () => readNativeLegacyClose({ shot }) });
  const ticket = admission.inspect();
  assert.equal(admission.commit(ticket.token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1500 }), true);
  assert.equal(admission.beforeUnload({ preventDefault() { assert.fail('Unexpected veto'); }, returnValue: '' }), true);
  assert.deepEqual({ syncs, writes, timers, changes }, { syncs: 0, writes: 0, timers: 0, changes: 0 });
});
