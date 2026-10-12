import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workspaceOriginOptions, workspaceOriginScope, pinNewWorkspaceIntent,
  workspaceIntentDisposition, assertWorkspaceIntent, sameWorkspaceIntent,
  workspacePendingKey, removeExactWorkspacePending, createWorkspaceOriginReader,
} from '../apps/web/src/workspace-origin.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const normal = { restored: false }, restored = { restored: true, workspaceOrigin: a };
const entry = { projectId: 'project', key: 'timeline:render', operation: 'timeline.render', input: { projectId: 'project', requestId: 'original-request-id', mode: 'preview' } };
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function storage() { const items = new Map(); return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key), items }; }

test('origin is outer context and normal pending input stays unchanged', () => {
  const source = copy(entry), ordinary = pinNewWorkspaceIntent(source, normal), pinned = pinNewWorkspaceIntent(source, restored);
  assert.deepEqual(ordinary, source);
  assert.deepEqual(pinned, { ...source, expectedWorkspaceOrigin: a });
  assert.deepEqual(pinned.input, source.input);
  assert.deepEqual(source, entry);
  assert.ok(Object.isFrozen(pinned)); assert.ok(Object.isFrozen(pinned.input));
  assert.deepEqual(assertWorkspaceIntent(pinned, restored), { expectedWorkspaceOrigin: a });
  assert.deepEqual(assertWorkspaceIntent(ordinary, normal), {});
  assert.throws(() => pinNewWorkspaceIntent(pinned, restored), { code: 'WORKSPACE_INTENT_ALREADY_PINNED' });
  assert.throws(() => pinNewWorkspaceIntent(pinned, { restored: true, workspaceOrigin: b }), { code: 'WORKSPACE_INTENT_ALREADY_PINNED' });
});

test('missing, malformed and mismatched pins remain held without changing the original key', () => {
  for (const original of [entry, { ...entry, expectedWorkspaceOrigin: null }, { ...entry, expectedWorkspaceOrigin: 'bad' }, { ...entry, expectedWorkspaceOrigin: b }]) {
    const before = JSON.stringify(original);
    assert.deepEqual(workspaceIntentDisposition(original, restored), { held: true, code: 'RESTORED_RECORD_HELD', reason: workspaceIntentDisposition(original, restored).reason });
    assert.throws(() => assertWorkspaceIntent(original, restored), { code: 'RESTORED_RECORD_HELD' });
    assert.equal(JSON.stringify(original), before);
    assert.equal(original.input.requestId, 'original-request-id');
  }
  assert.throws(() => assertWorkspaceIntent({ ...entry, expectedWorkspaceOrigin: a }, normal), { code: 'RESTORED_RECORD_HELD' });
  for (const workspace of [null, {}, { restored: true }, { restored: true, workspaceOrigin: null }]) {
    assert.equal(workspaceOriginScope(workspace), null);
    assert.throws(() => pinNewWorkspaceIntent(entry, workspace), { code: 'WORKSPACE_ORIGIN_UNVERIFIED' });
    assert.equal(workspaceIntentDisposition(entry, workspace).held, true);
  }
});

test('transport context rejects coercion and never adds a missing field', () => {
  assert.deepEqual(workspaceOriginOptions(undefined), {});
  assert.deepEqual(workspaceOriginOptions(a), { expectedWorkspaceOrigin: a });
  for (const value of [null, false, 0, {}, '', ` ${a}`, a + '\n', 'not-a-uuid'])
    assert.throws(() => workspaceOriginOptions(value), { code: 'VALIDATION_ERROR' });
});

test('old and new branch pending slots coexist, with compare-and-clear protecting reordered responses', () => {
  const records = storage(), original = JSON.stringify(entry), aEntry = JSON.stringify({ ...entry, expectedWorkspaceOrigin: a });
  const oldKey = workspacePendingKey(entry.projectId, entry.key), aKey = workspacePendingKey(entry.projectId, entry.key, a), bKey = workspacePendingKey(entry.projectId, entry.key, b);
  assert.equal(new Set([oldKey, aKey, bKey]).size, 3);
  records.setItem(oldKey, original); records.setItem(aKey, aEntry); records.setItem(bKey, JSON.stringify({ ...entry, expectedWorkspaceOrigin: b }));
  assert.equal(removeExactWorkspacePending(records, aKey, original), false);
  const replacement = JSON.stringify({ ...entry, input: { ...entry.input, requestId: 'another-request' }, expectedWorkspaceOrigin: a });
  records.setItem(aKey, replacement);
  assert.equal(removeExactWorkspacePending(records, aKey, aEntry), false);
  assert.equal(records.getItem(aKey), replacement);
  assert.equal(records.getItem(oldKey), original);
  assert.equal(removeExactWorkspacePending(records, aKey, replacement), true);
  assert.equal(records.getItem(oldKey), original);
  assert.ok(records.getItem(bKey));
});

test('complete intent identity distinguishes origin, operation, missing fields and original input', () => {
  assert.equal(sameWorkspaceIntent(entry, copy(entry)), true);
  for (const changed of [{ ...entry, expectedWorkspaceOrigin: a }, { ...entry, expectedWorkspaceOrigin: null },
    { ...entry, operation: 'export.create' }, { ...entry, input: { ...entry.input, requestId: 'replacement' } },
    { ...entry, expectedRetrySnapshot: {} }]) assert.equal(sameWorkspaceIntent(entry, changed), false);
});

test('navigation, refresh and reordered inspection cannot restamp a retained intent', async () => {
  const reads = [deferred(), deferred(), deferred(), deferred()]; let index = 0;
  const reader = createWorkspaceOriginReader({ read: () => reads[index++].promise, validate: value => typeof value?.restored === 'boolean' });
  const first = reader.inspect(), second = reader.inspect();
  reads[1].resolve(restored); await second;
  const pending = reader.pin(entry), bytes = JSON.stringify(pending);
  reads[0].resolve({ restored: true, workspaceOrigin: b }); await first;
  assert.equal(reader.getState().workspace.workspaceOrigin, a);
  const reconnect = reader.inspect();
  assert.throws(() => reader.pin(entry), { code: 'WORKSPACE_ORIGIN_UNVERIFIED' });
  reads[2].resolve({ restored: true, workspaceOrigin: b }); await reconnect;
  assert.equal(JSON.stringify(pending), bytes);
  assert.equal(workspaceIntentDisposition(pending, reader.getState().workspace).held, true);
  const obsolete = reader.inspect(); reader.invalidate(); reads[3].resolve(restored); await obsolete;
  assert.equal(reader.getState().workspace, null);
  assert.equal(JSON.stringify(pending), bytes);
});

test('independent windows pin their own origin and a reload does not adopt old session values', () => {
  const windowA = pinNewWorkspaceIntent(entry, restored), windowB = pinNewWorkspaceIntent(entry, { restored: true, workspaceOrigin: b });
  const reloadedA = JSON.parse(JSON.stringify(windowA));
  assert.equal(workspaceIntentDisposition(reloadedA, restored).held, false);
  assert.equal(workspaceIntentDisposition(reloadedA, { restored: true, workspaceOrigin: b }).held, true);
  assert.equal(workspaceIntentDisposition(windowB, restored).held, true);
  assert.equal(workspaceIntentDisposition(copy(entry), restored).held, true);
});
