import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { prepareSubmission, readPending, writePending, clearPending, pendingForProject, reconcilePending } from '../apps/web/src/submissions.ts';
import type {PendingEntry} from '../apps/web/src/submissions.ts';

class MemorySessionStorage {
  values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: unknown): void { this.values.set(key, String(value)); }
  removeItem(key: string): void { this.values.delete(key); }
}
function fixture(t: TestContext, storage: MemorySessionStorage = new MemorySessionStorage()): MemorySessionStorage {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'sessionStorage', prior); else delete (globalThis as {sessionStorage?: unknown}).sessionStorage; });
  return storage;
}
function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return { projectId: 'project-a', key: 'generate:shot-a', operation: 'generation.submit', createdAt: '2026-10-09T09:00:00.000Z', input: { shotId: 'shot-a', expectedRevision: 3, requestId: 'original-request', providerId: 'mock', model: 'mock-motion-v1', parameters: { scenario: 'delay', delayMs: 1000 } }, ...overrides } as PendingEntry;
}

test('client persists the exact request before the caller can dispatch it', (t: TestContext) => {
  const storage = fixture(t); const original = entry(); let calls = 0;
  function dispatch(request: PendingEntry): PendingEntry { calls++; assert.equal(storage.length, 1); assert.deepEqual(readPending(original.projectId, original.key), original); return request; }
  const sent = dispatch(prepareSubmission(original));
  assert.equal(calls, 1); assert.deepEqual(sent, original);
});

test('lost-response replay keeps the original operation, requestId, revision, and full payload', (t: TestContext) => {
  fixture(t); const original = entry(); prepareSubmission(original);
  const replay = prepareSubmission(entry({ operation: 'job.retry', input: { shotId: 'shot-a', expectedRevision: 99, requestId: 'must-not-replace', providerId: 'runway', parameters: { seed: 456 } } }));
  assert.deepEqual(replay, original); assert.deepEqual(readPending(original.projectId, original.key), original);
});

test('an absent or unrelated server job does not prove rejection and never clears the pending request', (t: TestContext) => {
  fixture(t); const original = entry(); prepareSubmission(original);
  reconcilePending(original.projectId, { jobs: [], exports: [] });
  assert.equal(pendingForProject(original.projectId).length, 1);
  reconcilePending(original.projectId, { jobs: [{ requestId: 'different-request' }], exports: [] });
  assert.deepEqual(readPending(original.projectId, original.key), original);
});

test('matching durable request IDs reconcile only their corresponding project requests', (t: TestContext) => {
  fixture(t); const original = entry(); prepareSubmission(original);
  const other = entry({ projectId: 'project-b' }); prepareSubmission(other);
  reconcilePending(original.projectId, { jobs: [{ requestId: original.input.requestId }], exports: [] });
  assert.equal(readPending(original.projectId, original.key), null);
  assert.deepEqual(readPending(other.projectId, other.key), other);
});

test('generation, explicit failed-job retry, and export each have separate stable replay keys', (t: TestContext) => {
  fixture(t); const generation = entry();
  const retry = entry({ key: 'retry:job-a', operation: 'job.retry', input: { jobId: 'job-a', requestId: 'retry-request' } });
  const exported = entry({ key: 'export', operation: 'export.create', input: { projectId: 'project-a', requestId: 'export-request' } });
  for (const request of [generation, retry, exported]) prepareSubmission(request);
  assert.equal(pendingForProject('project-a').length, 3);
  assert.deepEqual(prepareSubmission({ ...retry, input: { ...retry.input, requestId: 'new-retry-must-not-dispatch' } }), retry);
  assert.deepEqual(prepareSubmission({ ...exported, input: { ...exported.input, requestId: 'new-export-must-not-dispatch' } }), exported);
  reconcilePending('project-a', { jobs: [], exports: [{ requestId: 'export-request' }] });
  assert.equal(pendingForProject('project-a').length, 2);
  assert.equal(readPending('project-a', 'export'), null);
  clearPending('project-a', retry.key); assert.deepEqual(pendingForProject('project-a'), [generation]);
});

test('unavailable storage prevents an unprotected submission before network dispatch', (t: TestContext) => {
  const storage = new MemorySessionStorage(); storage.setItem = () => { throw new Error('QuotaExceededError'); }; fixture(t, storage);
  let submissions = 0;
  function dispatch(request: PendingEntry): PendingEntry { submissions++; return request; }
  assert.throws(() => dispatch(prepareSubmission(entry())), /无法保存请求恢复记录/);
  assert.equal(submissions, 0);
});

test('silent storage write failure is detected before dispatch', (t: TestContext) => {
  const storage = new MemorySessionStorage(); storage.setItem = () => {}; fixture(t, storage);
  let submissions = 0;
  assert.throws(() => { const ready = prepareSubmission(entry()); submissions++; return ready; }, /未能保存/);
  assert.equal(submissions, 0);
});

test('corrupted pending record blocks replacement instead of generating a new request ID', (t: TestContext) => {
  const storage = fixture(t); const original = entry(); writePending(original);
  const key = storage.key(0)!; storage.setItem(key, JSON.stringify({ ...original, input: {} }));
  assert.throws(() => prepareSubmission(entry({ input: { requestId: 'replacement' } })), /记录损坏/);
  assert.deepEqual(JSON.parse(storage.getItem(key)!)!.input, {});
});
