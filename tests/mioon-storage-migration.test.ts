import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateBrowserStorage, migratePendingStorage } from '../apps/web/src/storage-migration.ts';
import { prepareSubmission, readPending, pendingForProject, reconcilePending } from '../apps/web/src/submissions.ts';

class Storage {
  declare values: Map<string, string>;
  constructor(entries: Iterable<readonly [string,string]> = []) { this.values = new Map(entries); }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
const entry = { projectId: 'project-1', key: 'generation:shot-1', operation: 'generation.submit', input: { shotId: 'shot-1', expectedRevision: 7, requestId: 'keep-exact-request-id', providerId: 'mock' } };
const raw = '\n  ' + JSON.stringify(entry, null, 2) + '\n';
const oldKey = 'frame.pending.v1:project-1:generation:shot-1', newKey = 'mioon.pending.v1:project-1:generation:shot-1';

test('migration copies all browser records exactly and removes old namespace only after verification', () => {
  const prefs = '{ "version":1,"canvas":{"viewport":{"x":12,"y":-18,"zoom":0.7}} }';
  const local = new Storage([['frame.project', 'project-1'], ['frame.workspace.v1:project-1', prefs], ['unrelated', 'keep']]);
  const session = new Storage([[oldKey, raw]]);
  assert.equal(migrateBrowserStorage({ local, session }).migrated, 3);
  assert.equal(local.getItem('mioon.project'), 'project-1');
  assert.equal(local.getItem('mioon.workspace.v1:project-1'), prefs);
  assert.equal(session.getItem(newKey), raw);
  assert.equal(local.getItem('frame.project'), null);
  assert.equal(session.getItem(oldKey), null);
  assert.equal(local.getItem('unrelated'), 'keep');
  assert.deepEqual(migrateBrowserStorage({ local, session }), { migrated: 0 });
});

test('conflicting destination preflight preserves every source and destination with no partial writes', () => {
  const local = new Storage([['frame.project', 'old-project']]);
  const session = new Storage([[oldKey, raw], [newKey, 'different']]);
  assert.throws(() => migrateBrowserStorage({ local, session }), { code: 'STORAGE_MIGRATION_BLOCKED' });
  assert.equal(local.getItem('frame.project'), 'old-project'); assert.equal(local.getItem('mioon.project'), null);
  assert.equal(session.getItem(oldKey), raw); assert.equal(session.getItem(newKey), 'different');
});

test('quota failure keeps originals; exact partially copied destination is resumable', () => {
  const local = new Storage([['frame.project', 'project-1']]); const session = new Storage([[oldKey, raw]]);
  session.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  assert.throws(() => migrateBrowserStorage({ local, session }), { code: 'STORAGE_MIGRATION_BLOCKED' });
  assert.equal(local.getItem('frame.project'), 'project-1'); assert.equal(session.getItem(oldKey), raw);
  session.setItem = Storage.prototype.setItem;
  assert.equal(migrateBrowserStorage({ local, session }).migrated, 2);
  assert.equal(session.getItem(newKey), raw); assert.equal(session.getItem(oldKey), null);
});

test('silent storage corruption fails verification and does not delete the original', () => {
  const session = new Storage([[oldKey, raw]]);
  session.setItem = function(key) { this.values.set(key, 'corrupted'); };
  assert.throws(() => migratePendingStorage(session), { code: 'STORAGE_MIGRATION_BLOCKED' });
  assert.equal(session.getItem(oldKey), raw);
});

test('failed removal leaves verified copy, blocks submission, and can safely retry', () => {
  const session = new Storage([[oldKey, raw]]);
  session.removeItem = () => {};
  assert.throws(() => migratePendingStorage(session), { code: 'STORAGE_MIGRATION_BLOCKED' });
  assert.equal(session.getItem(oldKey), raw); assert.equal(session.getItem(newKey), raw);
  session.removeItem = Storage.prototype.removeItem;
  assert.equal(migratePendingStorage(session).migrated, 1);
});

test('pending replay keeps the original request ID instead of creating a duplicate after migration', () => {
  const previous = globalThis.sessionStorage;
  const session = new Storage([[oldKey, raw]]); globalThis.sessionStorage = session as unknown as globalThis.Storage;
  try {
    const replacement = { ...entry, input: { ...entry.input, requestId: 'must-not-submit' } };
    assert.deepEqual(prepareSubmission(replacement), entry);
    assert.equal(session.getItem(newKey), raw);
    assert.equal(pendingForProject('project-1').length, 1);
    assert.equal((readPending('project-1', entry.key))!.input.requestId, entry.input.requestId);
    reconcilePending('project-1', { jobs: [{ requestId: entry.input.requestId }] });
    assert.equal(session.length, 0);
  } finally { if (previous === undefined) delete (globalThis as {sessionStorage?: unknown}).sessionStorage; else globalThis.sessionStorage = previous; }
});

test('conflicting pending destination blocks prepareSubmission without overwriting either request', () => {
  const previous = globalThis.sessionStorage;
  const session = new Storage([[oldKey, raw], [newKey, JSON.stringify({ ...entry, input: { ...entry.input, requestId: 'other' } })]]);
  globalThis.sessionStorage = session as unknown as globalThis.Storage;
  try { assert.throws(() => prepareSubmission(entry), { code: 'STORAGE_MIGRATION_BLOCKED' }); assert.equal(session.getItem(oldKey), raw); }
  finally { if (previous === undefined) delete (globalThis as {sessionStorage?: unknown}).sessionStorage; else globalThis.sessionStorage = previous; }
});

test('denied local view-cache getter does not prevent durable server preferences; denied request storage blocks', () => {
  const local = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const session = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
  try {
    assert.deepEqual(migrateBrowserStorage({ session: new Storage() }), { migrated: 0 });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    assert.throws(() => migrateBrowserStorage(), { code: 'STORAGE_MIGRATION_BLOCKED' });
  } finally {
    if (local) Object.defineProperty(globalThis, 'localStorage', local); else delete (globalThis as {localStorage?: unknown}).localStorage;
    if (session) Object.defineProperty(globalThis, 'sessionStorage', session); else delete (globalThis as {sessionStorage?: unknown}).sessionStorage;
  }
});


test('denied local cache enumeration or reads still permits durable preferences without touching either namespace', () => {
  for (const method of ['length', 'key', 'getItem'] as const) {
    const local = new Storage([['frame.project', 'project-1']]);
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    if (method === 'length') Object.defineProperty(local, 'length', { get: denied });
    else local[method] = denied;
    const session = new Storage([[oldKey, raw]]);
    assert.deepEqual(migrateBrowserStorage({ local, session }), { migrated: 1 });
    assert.equal(local.values.get('frame.project'), 'project-1');
    assert.equal(local.values.has('mioon.project'), false);
    assert.equal(session.getItem(newKey), raw);
  }
});
