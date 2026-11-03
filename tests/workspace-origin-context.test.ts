import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingStorageKey, samePendingIntent, removeExactPending } from '../apps/web/src/pending-request.ts';
const entry = { projectId: 'project', key: 'timeline:render', operation: 'timeline.render', input: { projectId: 'project', requestId: 'original-request-id', mode: 'preview' } };
function storage() { const items = new Map<string, string>(); return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) }; }

test('ordinary pending identity retains the complete original input through a storage round trip', () => {
  const records = storage(), key = pendingStorageKey(entry.projectId, entry.key), before = structuredClone(entry);
  records.setItem(key, JSON.stringify(entry));
  const read: unknown = JSON.parse(records.getItem(key)!);
  assert.deepEqual(read, before);
  assert.deepEqual(entry, before);
  assert.equal(samePendingIntent(entry, read), true);
  assert.equal((read as typeof entry).input.requestId, 'original-request-id');
});
test('project pending slots coexist, with compare-and-clear protecting reordered responses', () => {
  const records = storage(), original = JSON.stringify(entry);
  const key = pendingStorageKey(entry.projectId, entry.key), foreignKey = pendingStorageKey('another-project', entry.key), previewKey = pendingStorageKey(entry.projectId, 'timeline:render:export');
  assert.equal(new Set([key, foreignKey, previewKey]).size, 3);
  records.setItem(key, original); records.setItem(foreignKey, original); records.setItem(previewKey, original);
  assert.equal(removeExactPending(records, key, null), false);
  const replacement = JSON.stringify({ ...entry, input: { ...entry.input, requestId: 'another-request' } });
  records.setItem(key, replacement);
  assert.equal(removeExactPending(records, key, original), false);
  assert.equal(records.getItem(key), replacement);
  assert.equal(records.getItem(foreignKey), original);
  assert.equal(removeExactPending(records, key, replacement), true);
  assert.equal(records.getItem(foreignKey), original);
  assert.ok(records.getItem(previewKey));
});
test('complete intent identity distinguishes operation, missing fields and original input', () => {
  assert.equal(samePendingIntent(entry, structuredClone(entry)), true);
  for (const changed of [{ ...entry, operation: 'export.create' }, { ...entry, input: { ...entry.input, requestId: 'replacement' } },
    { ...entry, expectedRetrySnapshot: {} }, { ...entry, expectedRetrySnapshot: null }] as const) assert.equal(samePendingIntent(entry, changed), false);
  assert.equal(samePendingIntent({ ...entry, expectedRetrySnapshot: null }, entry), false);
});
