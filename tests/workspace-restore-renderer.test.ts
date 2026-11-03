import test from 'node:test';
import assert from 'node:assert/strict';
import * as pending from '../apps/web/src/submissions.ts';
import { pendingStorageKey } from '../apps/web/src/pending-request.ts';
import { createEditTaskClient } from '../apps/web/src/edit-task-client.ts';
import { rpc } from '../apps/web/src/api.ts';
const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const projectId = id(3), taskId = id(4), trackId = id(5), instanceId = id(6);
const stamp = '2026-10-12T00:00:00.000Z', operation = 'timeline.track.update';
const input = { projectId, expectedRevision: 1, requestId: 'original-edit-identity', trackId, patch: { muted: true } };
const task = () => ({ id: taskId, projectId, operation, input: structuredClone(input), requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, acknowledged: false, origin: 'new', createdAt: stamp, updatedAt: stamp });
function memoryStorage() { const values = new Map<string,string>(); return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key), values }; }
function session(t: test.TestContext) { const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = memoryStorage(); Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage }); t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as unknown as Record<PropertyKey,unknown>).sessionStorage); return storage; }
const entry = () => ({ projectId, key: 'timeline:render:export', operation: 'timeline.render', input: { projectId, expectedRevision: 1, requestId: 'original-export-request', purpose: 'export' }, createdAt: stamp });

test('strict pending scans reject corrupt slot ownership without deleting original bytes', t => {
  const storage = session(t);
  for (const pinned of [entry()] as const) {
    const key = pendingStorageKey(projectId, 'damaged-slot');
    for (const value of [{ ...pinned, input: {} }, { ...pinned, projectId: id(99) }, { ...pinned, key: 'different-slot' }, null] as const) {
      const bytes = JSON.stringify(value); storage.setItem(key, bytes);
      assert.throws(() => pending.pendingForProject(projectId, { strict: true }), /记录损坏/);
      assert.equal(storage.getItem(key), bytes, 'Corrupted intent is retained for inspection, never repaired or adopted');
      storage.removeItem(key);
    }
  }
  const foreign = { ...entry(), projectId: id(99) };
  storage.setItem(pendingStorageKey(foreign.projectId, foreign.key), '{');
  assert.deepEqual(pending.pendingForProject(projectId, { strict: true }), [], 'Another project corruption does not claim the current lane');
  const retiredKey=`mioon.pending.restore.v1:${id(80)}:${projectId}:timeline:render:export`,retained='unavailable historical session bytes';
  storage.setItem(retiredKey,retained);
  assert.deepEqual(pending.pendingForProject(projectId,{strict:true}),[]);
  assert.equal(storage.getItem(retiredKey),retained,'Retired slots are neither adopted nor erased');
});

test('late pending acknowledgment cannot clear a newer key or another project', t => {
  const storage = session(t), old = entry(), foreign = { ...entry(), projectId: id(99), input: { ...entry().input, projectId: id(99) } };
  pending.writePending(old); pending.writePending(foreign);
  const replacement = { ...old, input: { ...old.input, requestId: 'newer-request-identity' } };
  pending.writePending(replacement);
  assert.equal(pending.clearPending(projectId, old.key, old), false);
  assert.deepEqual(pending.readPending(projectId, old.key), replacement);
  assert.deepEqual(pending.readPending(foreign.projectId, foreign.key), foreign);
  assert.equal(pending.clearPending(projectId, old.key, replacement), true);
  assert.equal(storage.length, 1);
});

test('formatted pending intents clear only after matching the complete original intent', t => {
  const storage = session(t);
  for (const retained of [entry()] as const) {
    const key = pendingStorageKey(projectId, (retained.key as unknown as Parameters<typeof pendingStorageKey>[1]));
    const raw = '\n  ' + JSON.stringify(Object.fromEntries(Object.entries(retained).reverse()), null, 2) + '\n';
    storage.setItem(key, raw);
    const read = pending.readPending(projectId, (retained.key as unknown as Parameters<typeof pending.readPending>[1]));
    assert.deepEqual(read, retained); assert.equal(storage.getItem(key), raw, 'Reading preserves original formatted bytes');
    for (const changed of [
      { ...retained, operation: 'timeline.undo' },
      { ...retained, input: { ...retained.input, requestId: 'changed-request-identity' } },
      { ...retained, input: { ...retained.input, purpose: 'preview' } },
      { ...retained, createdAt: '2026-10-12T00:00:01.000Z' },
      { ...retained, projectId: id(99) }, { ...retained, key: 'another-slot' },
    ] as const) {
      assert.equal(pending.clearPending(projectId, (retained.key as unknown as Parameters<typeof pending.clearPending>[1]), (changed as unknown as Parameters<typeof pending.clearPending>[2])), false);
      assert.equal(storage.getItem(key), raw, 'Different complete intent cannot erase the original bytes');
    }
    assert.equal(pending.clearPending(projectId, (retained.key as unknown as Parameters<typeof pending.clearPending>[1]), read), true);
    assert.equal(storage.getItem(key), null);
  }
});

test('raw pending CAS retains a replacement between semantic read and deletion in the current project', t => {
  const storage = session(t), get = storage.getItem.bind(storage);
  for (const retained of [entry()] as const) {
    const key = pendingStorageKey(projectId, (retained.key as unknown as Parameters<typeof pendingStorageKey>[1]));
    const raw = '\n' + JSON.stringify(retained, null, 2) + '\n';
    const replacement = JSON.stringify({ ...retained, input: { ...retained.input, requestId: 'replacement-after-read' } });
    storage.setItem(key, raw); let reads = 0;
    storage.getItem = selected => {
      if (selected === key && ++reads === 2) storage.setItem(key, replacement);
      return get(selected);
    };
    assert.equal(pending.clearPending(projectId, (retained.key as unknown as Parameters<typeof pending.clearPending>[1]), (retained as unknown as Parameters<typeof pending.clearPending>[2])), false);
    assert.equal(get(key), replacement, 'CAS must not erase a newly replaced request');
    storage.getItem = get; storage.removeItem(key);
  }
});

test('malformed and foreign-project formatted pending records remain byte-exact on acknowledgement', t => {
  const storage = session(t), retained = entry(), key = pendingStorageKey(projectId, retained.key);
  for (const raw of ['{', 'null', '[]', JSON.stringify({ ...retained, projectId: id(99) }), JSON.stringify({ ...retained, input: null })] as const) {
    storage.setItem(key, raw);
    assert.equal(pending.clearPending(projectId, (retained.key as unknown as Parameters<typeof pending.clearPending>[1]), (retained as unknown as Parameters<typeof pending.clearPending>[2])), false);
    assert.equal(storage.getItem(key), raw);
  }
});

test('pending acknowledgement preserves malformed equal records and missing receipt-field distinctions', t => {
  const storage = session(t), original = entry(), key = pendingStorageKey(projectId, original.key);
  const bytes = '\n' + JSON.stringify(original, null, 2);
  storage.setItem(key, bytes);
  assert.equal(pending.clearPending(projectId, original.key, { ...original, createdAt: undefined }), false);
  const inherited = Object.assign(Object.create({ projectId }), original); delete (inherited as unknown as Record<PropertyKey,unknown>).projectId;
  assert.equal(pending.clearPending(projectId, original.key, inherited), false);
  assert.equal(storage.getItem(key), bytes);
  for (const malformed of [{ ...original, operation: 'arbitrary.execute' }, { ...original, input: {} }, { ...original, input: { requestId: 42 } }] as const) {
    const raw = JSON.stringify(malformed); storage.setItem(key, raw);
    assert.equal(pending.clearPending(projectId, original.key, malformed), false);
    assert.equal(storage.getItem(key), raw);
  }
});

test('task HTTP and web RPC keep immutable intent exact and preserve transport failure ambiguity', async t => {
  const sent: unknown[] = [], raw = { projectId, operation, input, origin: 'new' };
  const client = createEditTaskClient({ fetcher: async (_url, options) => { sent.push(JSON.parse(String(options!.body))); return new Response(JSON.stringify({ ok: true, data: { task: task(), instanceId } }), { status: 200 }); } });
  await client.prepare(raw); assert.deepEqual(sent, [raw]); assert.deepEqual(input.patch, { muted: true });
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  for (const code of ['UPSTREAM_UNAVAILABLE', 'BACKEND_PROTOCOL_ERROR', 'NETWORK'] as const) {
    globalThis.fetch = async (_url, options) => { assert.deepEqual(JSON.parse(String(options!.body)), { operation, input }); return new Response(JSON.stringify({ ok: false, error: { code, message: 'Unavailable', details: {} } }), { status: 503 }); };
    await assert.rejects(rpc(operation, input), error => error instanceof Error && 'code' in error && error.code === code && 'definitive' in error && error.definitive === false && 'details' in error && !Object.hasOwn(error.details as object, 'mutationOutcome'));
  }
});
