import test from 'node:test';
import assert from 'node:assert/strict';
const { createNativeLocatorOwner } = await import(process.env.MIOON_NATIVE_LOCATOR_SOURCE || '../apps/web/src/native-locator-state.ts');
const uuid = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { role: 'launcher', windowId: uuid(1), contextId: uuid(2), backendId: uuid(3), quitting: false, locatorIntent: null, locatorStatus: null };
function fixture({ publish } = {}) {
  const publications = [], operations = [];
  let state = { phase: 'error', uncertain: true, identityBlocked: false, canRetry: true, canRecheck: true, reading: false,
    rechecked: null, pendingInput: { projectId: uuid(4), expectedRevision: 7, workspaceScope: 'private-scope', instanceId: uuid(5) } };
  const locator = { getState: () => structuredClone(state), recheck: async () => { operations.push(['recheck']); }, retry: async () => { operations.push(['retry', structuredClone(state.pendingInput)]); } };
  const owner = createNativeLocatorOwner({ context, locator, bridge: { publishLocatorStatus: async value => { publications.push(value); return publish ? publish(value) : true; } } });
  owner.activate();
  return { owner, publications, operations, state: () => state, change(patch) { state = { ...state, ...patch }; owner.publish(); } };
}
test('locator publication contains bounded flags only and never the CAS body', () => {
  const f = fixture(); assert.equal(f.publications.length, 1);
  assert.deepEqual(Object.keys(f.publications[0]).sort(), ['canRecheck', 'canRetry', 'identityBlocked', 'phase', 'reading', 'rechecked', 'statusVersion', 'uncertain', 'version']);
  assert.doesNotMatch(JSON.stringify(f.publications), /private-scope|expectedRevision|projectId|instanceId/);
  f.owner.publish(); assert.equal(f.publications.length, 1);
});
test('exact once recovery intent stays in original launcher and uses original pending body', () => {
  const f = fixture(), intent = { action: 'retry', expectedStatusVersion: 1, intentVersion: 1 };
  f.owner.receive({ ...context, locatorIntent: intent }); f.owner.receive({ ...context, locatorIntent: intent });
  assert.deepEqual(f.operations, [['retry', f.state().pendingInput]]);
});
test('stale version, foreign context, blocked retry or quit cannot dispatch recovery', () => {
  const f = fixture(); f.change({ canRetry: false });
  const action = { action: 'retry', expectedStatusVersion: 1, intentVersion: 1 };
  f.owner.receive({ ...context, locatorIntent: action });
  f.owner.receive({ ...context, contextId: uuid(99), locatorIntent: { ...action, expectedStatusVersion: 2, intentVersion: 2 } });
  f.owner.receive({ ...context, locatorIntent: { ...action, expectedStatusVersion: 2, intentVersion: 2 } });
  f.owner.receive({ ...context, quitting: true, locatorIntent: { action: 'recheck', expectedStatusVersion: 2, intentVersion: 3 } });
  assert.deepEqual(f.operations, []);
});
test('new explicit read-only recovery is not repeated by unrelated context updates', () => {
  const f = fixture(); const next = { ...context, locatorIntent: { action: 'recheck', expectedStatusVersion: 1, intentVersion: 1 } };
  f.owner.receive(next); f.owner.receive({ ...next, editorCount: 0 }); f.owner.receive({ ...next, editorCount: 2 });
  assert.deepEqual(f.operations, [['recheck']]);
  f.owner.dispose(); f.owner.receive({ ...next, locatorIntent: { ...next.locatorIntent, intentVersion: 2 } }); assert.equal(f.operations.length, 1);
});

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(setImmediate);

test('a dropped locator publication is repaired only by a same-owner host observation with the exact status identity', async () => {
  const dropped = deferred(); let count = 0;
  const f = fixture({ publish: () => ++count === 1 ? dropped.promise : Promise.resolve(true) });
  const original = f.owner.getStatus(); dropped.reject(Error('Publication never reached main')); await tick();
  assert.equal(f.publications.length, 1, 'A failed invoke cannot create a retry loop');
  f.owner.publish(); assert.equal(f.publications.length, 1, 'Unchanged local metadata is not a new status');
  f.owner.receive({ ...context, editorCount: 2 });
  assert.equal(f.publications.length, 2); assert.equal(f.publications[1], original);
  assert.equal(f.owner.getStatus(), original); assert.equal(original.statusVersion, 1);
  await tick(); f.owner.receive({ ...context, locatorStatus: original, editorCount: 1 });
  assert.equal(f.publications.length, 2); assert.deepEqual(f.operations, []);
});

test('a late older publication cannot replace or increment the newest status during bounded repair', async () => {
  const pending = [deferred(), deferred(), deferred()]; let count = 0;
  const f = fixture({ publish: () => pending[count++].promise });
  const old = f.owner.getStatus(); f.change({ reading: true, canRecheck: false }); const latest = f.owner.getStatus();
  assert.equal(latest.statusVersion, 2); assert.equal(f.publications.length, 2);
  pending[0].resolve(true); await tick();
  f.owner.receive({ ...context, locatorStatus: old }); assert.equal(f.publications.length, 2, 'The exact newest status is already in flight');
  pending[1].reject(Error('New publication lost')); await tick();
  f.owner.receive({ ...context, locatorStatus: old });
  assert.equal(f.publications.length, 3); assert.equal(f.publications[2], latest);
  f.owner.receive({ ...context, locatorStatus: old }); assert.equal(f.publications.length, 3, 'Duplicate events do not duplicate an in-flight repair');
  pending[2].resolve(true); await tick(); f.owner.receive({ ...context, locatorStatus: old });
  assert.equal(f.publications.length, 3, 'An older delayed event cannot revoke a known accepted publication');
  assert.equal(f.owner.getStatus(), latest); assert.equal(latest.statusVersion, 2); assert.deepEqual(f.operations, []);
});

test('an exact host status echo proves publication despite lost invoke ACK and prevents redundant repair', async () => {
  const held = deferred(), f = fixture({ publish: () => held.promise }), exact = f.owner.getStatus();
  f.owner.receive({ ...context, locatorStatus: { ...exact } });
  held.reject(Error('Only the invoke reply was lost')); await tick();
  f.owner.receive({ ...context, locatorStatus: null }); f.owner.receive({ ...context, locatorStatus: exact });
  assert.equal(f.publications.length, 1); assert.equal(f.owner.getStatus(), exact); assert.deepEqual(f.operations, []);
});

test('foreign or disposed owner observations cannot repair publication or inherit pending recovery', async () => {
  const f = fixture({ publish: async () => { throw Error('Lost publication'); } }); await tick();
  const intent = { action: 'retry', expectedStatusVersion: 1, intentVersion: 1 };
  for (const patch of [{ role: 'settings' }, { windowId: uuid(88) }, { contextId: uuid(88) }, { backendId: uuid(88) }]) {
    f.owner.receive({ ...context, ...patch, locatorIntent: intent });
  }
  assert.equal(f.publications.length, 1); assert.deepEqual(f.operations, []);
  f.owner.dispose(); f.owner.receive({ ...context, locatorIntent: intent }); f.owner.publish();
  assert.equal(f.publications.length, 1); assert.deepEqual(f.operations, []);
  const replacement = fixture(); assert.equal(replacement.owner.getStatus().statusVersion, 1);
  assert.deepEqual(replacement.operations, []);
});

test('repairing exact metadata never repeats recovery, changes CAS input, or increments the status owner version', async () => {
  const f = fixture({ publish: async () => { throw Error('Publication unavailable'); } });
  await tick(); const exact = f.owner.getStatus(), body = structuredClone(f.state().pendingInput);
  const intent = { action: 'retry', expectedStatusVersion: exact.statusVersion, intentVersion: 1 };
  f.owner.receive({ ...context, locatorIntent: intent }); await tick();
  f.owner.receive({ ...context, locatorIntent: intent, editorCount: 2 }); await tick();
  assert.equal(f.publications.length, 3, 'Each fresh host observation may repair one failed metadata delivery; no timers are involved');
  assert.equal(f.publications.every(value => value === exact), true); assert.equal(f.owner.getStatus(), exact);
  assert.deepEqual(f.operations, [['retry', body]]); assert.deepEqual(f.state().pendingInput, body);
});
