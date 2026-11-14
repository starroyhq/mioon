import {testEnv} from './helpers/test-env.ts';

import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs, {existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DatabaseSync} from 'node:sqlite';
import {ownsStoreLock, assertProjectStore, registerStoreTransactionFence, registerStoreTransactionObserver} from '../packages/business/src/store-runtime.ts';
import type { Store as WorkspaceStore } from '../packages/business/src/store-contract.ts';
import {
  createProjectStore, isProjectStore, openProjectStore, openStore, registerProjectTransactionFence, registerProjectTransactionObserver,
} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {isProjectId, TEST_STORE_LAYOUT} from '../packages/contracts/src/project-file.ts';

import {sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';

const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));

function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-k1-store-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
/** sha256 of a file, read by another process: reading a file this process
 * holds open would drop SQLite's POSIX locks on it. */
function digestElsewhere(file: string): string {
  const script = "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))";
  const result = spawnSync(process.execPath, ['-e', script, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function openedStore(t: TestContext, root = scratch(t)): ProjectStore {
  const store = openStore(root);
  t.after(() => store.close());
  return store;
}
const count = (db: DatabaseSync, sql: string, ...values: string[]): number => Number(db.prepare(sql).get(...values)?.n);
const sequences = (db: DatabaseSync) => ({
  file: count(db, 'SELECT contentSequence AS n FROM project.project_file'),
  seen: count(db, 'SELECT seenContentSequence AS n FROM main.history_state'),
});
const receipts = (db: DatabaseSync, scope: string): number => count(db, 'SELECT count(*) AS n FROM idempotency WHERE scope=?', scope);
const addReceipt = (db: DatabaseSync, scope: string): void => {
  db.prepare("INSERT INTO idempotency VALUES(?,?,'hash','resource')").run(scope, randomUUID());
};

test('openStore(root) creates the test layout and reopens the same project', t => {
  const root = scratch(t);
  const store = openStore(root);
  const {projectId} = store;
  assert.ok(isProjectId(projectId));
  const local = path.join(root, ...TEST_STORE_LAYOUT.localDir), cache = path.join(root, ...TEST_STORE_LAYOUT.cacheDir), temp = path.join(root, ...TEST_STORE_LAYOUT.tempDir);
  assert.deepEqual({
    root: store.root, projectDir: store.projectDir, projectFile: store.projectFile,
    localDir: store.localDir, cacheDir: store.cacheDir, tempDir: store.tempDir, historyState: store.historyState,
  }, {
    root, projectDir: root, projectFile: path.join(root, 'project.mioon'),
    localDir: local, cacheDir: cache, tempDir: temp, historyState: 'fresh',
  });
  assert.equal(temp, path.join(root, '.mioon-store', 'tmp'));
  for (const directory of [root, path.join(root, '.mioon-store'), local, cache, temp, path.join(root, 'media')]) {
    assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  }
  assert.ok(existsSync(path.join(local, 'history.db')));
  assert.ok(existsSync(path.join(cache, 'cache.db')));
  const asWorkspaceStore: WorkspaceStore = store;
  assert.equal(asWorkspaceStore.root, root);
  store.close();
  const reopened = openStore(root);
  assert.equal(reopened.projectId, projectId);
  assert.equal(reopened.historyState, 'current');
  reopened.close();
});

test('get, list and put keep the workspace store contract on the nine tables', t => {
  const store = openedStore(t);
  const {projectId} = store;
  const project = {id: projectId, name: 'K1'};
  assert.equal(store.put('projects', project), project);
  assert.deepEqual(store.get('projects', projectId), project);
  assert.deepEqual(store.list('projects'), [project]);
  const rows: Readonly<Record<string, {readonly id: string; readonly projectId: string; readonly [key: string]: unknown}>> = {
    assets: {id: randomUUID(), projectId, kind: 'image'},
    shots: {id: randomUUID(), projectId, title: 'Shot'},
    nodes: {id: randomUUID(), projectId, type: 'note'},
    edges: {id: randomUUID(), projectId, from: 'a', to: 'b'},
    // An intended difference from format 72: versions.jobId no longer references
    // jobs, which are local records. A version made on another computer keeps its job ID.
    versions: {id: randomUUID(), projectId, jobId: randomUUID()},
    timelines: {id: randomUUID(), projectId, clips: []},
    jobs: {id: randomUUID(), projectId, state: 'queued'},
    exports: {id: randomUUID(), projectId, state: 'queued'},
  };
  for (const [table, row] of Object.entries(rows)) {
    assert.equal(store.put(table, row), row);
    assert.deepEqual(store.get(table, row.id), row, table);
    assert.deepEqual(store.list(table, projectId), [row], table);
    assert.deepEqual(store.list(table), [row], table);
    assert.deepEqual(store.list(table, randomUUID()), [], table);
    const schemas = ['main', 'project', 'cache'].filter(schema =>
      count(store.db, `SELECT count(*) AS n FROM ${schema}.sqlite_master WHERE type='table' AND name=?`, table) === 1
      && count(store.db, `SELECT count(*) AS n FROM ${schema}.${table} WHERE id=?`, row.id) === 1);
    assert.deepEqual(schemas, table === 'jobs' || table === 'exports' ? ['main'] : ['project'], table);
  }
  const renamed = {...rows.shots, title: 'Renamed'};
  store.put('shots', renamed);
  assert.deepEqual(store.list('shots'), [renamed]);
  assert.equal(store.get('shots', randomUUID()), null);
  for (const misuse of [() => store.get('agent_task_runs_v2', 'x'), () => store.list('history_state'), () => store.put('project_file', {id: 'x'})]) {
    assert.throws(misuse, {message: 'Unknown table'});
  }
});

test('a transaction commits and rolls back the project file and the local records together', t => {
  const root = scratch(t);
  const store = openStore(root);
  const {projectId} = store;
  store.put('projects', {id: projectId});
  const shot = {id: randomUUID(), projectId}, job = {id: randomUUID(), projectId};
  assert.equal(store.tx(() => {
    store.put('shots', shot);
    store.put('jobs', job);
    return 'done';
  }), 'done');
  const committed = sequences(store.db);
  assert.equal(committed.seen, committed.file);
  const lostShot = {id: randomUUID(), projectId}, lostJob = {id: randomUUID(), projectId};
  assert.throws(() => store.tx(() => {
    store.put('shots', lostShot);
    store.put('jobs', lostJob);
    throw new Error('stop');
  }), {message: 'stop'});
  assert.equal(store.db.isTransaction, false);
  assert.equal(store.get('shots', lostShot.id), null);
  assert.equal(store.get('jobs', lostJob.id), null);
  assert.deepEqual(sequences(store.db), committed);
  store.close();
  const reopened = openedStore(t, root);
  assert.equal(reopened.historyState, 'current');
  assert.deepEqual(reopened.get('shots', shot.id), shot);
  assert.deepEqual(reopened.get('jobs', job.id), job);
  assert.equal(reopened.get('shots', lostShot.id), null);
  assert.equal(reopened.get('jobs', lostJob.id), null);
});

// tx follows db.ts's tx statement for statement, with one intended difference:
// it begins with a plain (deferred) BEGIN, not BEGIN IMMEDIATE. The connection
// already holds every file's lock, so IMMEDIATE would only put all three
// databases in each write transaction; see the next test.
test('kernel misuse preserves the synchronous transaction and primitive-value errors', t => {
  const store = openedStore(t);
  const misuse = (target: WorkspaceStore): string[] => [
    () => target.tx(async () => 1),
    () => target.tx('callback' as unknown as () => number),
    () => target.tx(() => target.tx(() => 1)),
    () => target.tx(() => Promise.resolve(1)),
    () => target.tx(() => ({then() {}})),
    () => target.get('nope', 'x'),
    () => target.list('nope'),
    () => target.put('nope', {}),
    () => target.put('shots', {id: 'x', projectId: {}}),
  ].map(action => {
    try {
      action();
      return 'no error';
    } catch (error) {
      return `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
  });
  const expected = [
    'TypeError: Transactions require a synchronous callback',
    'TypeError: Transactions require a synchronous callback',
    'Error: Nested transactions are not supported',
    'TypeError: Transactions require a synchronous result',
    'TypeError: Transactions require a synchronous result',
    'Error: Unknown table',
    'Error: Unknown table',
    'Error: Unknown table',
    'TypeError: Workspace row values must be SQLite primitives',
  ];
  assert.deepEqual(misuse(store), expected);
  assert.equal(store.db.isTransaction, false);
});

test('a transaction of local records alone leaves the project file out of it and creates no super-journal (BEGIN, not BEGIN IMMEDIATE)', async t => {
  const store = openedStore(t);
  const {db, projectId, localDir} = store;
  store.put('projects', {id: projectId});
  addReceipt(db, 'k1-begin');
  // SQLite creates a super-journal beside history.db, the main database, when
  // a commit has more than one database in its write transaction, and deletes
  // it again: the folder's modification time records it.
  const folderStamp = (): string => {
    const info = statSync(localDir, {bigint: true});
    return `${info.mtimeNs}:${info.ctimeNs}`;
  };
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50));
  const fileBefore = digestElsewhere(store.projectFile), sequenceBefore = sequences(db);
  await settle();
  const before = folderStamp(), entries = readdirSync(localDir).sort();
  for (let index = 0; index < 20; index++) store.tx(() => addReceipt(db, 'k1-begin'));
  assert.equal(folderStamp(), before, 'no super-journal was created and deleted beside history.db');
  assert.deepEqual(readdirSync(localDir).sort(), entries);
  assert.deepEqual(sequences(db), sequenceBefore);
  assert.equal(receipts(db, 'k1-begin'), 21);
  assert.equal(digestElsewhere(store.projectFile), fileBefore, 'the project file is unchanged');
  // A transaction that writes both files still commits them with a super-journal.
  await settle();
  store.tx(() => {
    store.put('shots', {id: randomUUID(), projectId});
    addReceipt(db, 'k1-begin');
  });
  assert.notEqual(folderStamp(), before, 'a commit that spans both files used a super-journal');
  assert.deepEqual(readdirSync(localDir).sort(), entries);
  assert.ok(sequences(db).seen > sequenceBefore.seen);
});

test('fences run after BEGIN and before the callback, and their writes commit or roll back with it', t => {
  const store = openedStore(t);
  const events: string[] = [];
  const unregister = registerProjectTransactionFence(store.db, () => {
    events.push(`fence, in a transaction: ${String(store.db.isTransaction)}`);
    addReceipt(store.db, 'k1-fence');
  });
  store.tx(() => { events.push('callback'); });
  assert.deepEqual(events, ['fence, in a transaction: true', 'callback']);
  assert.equal(receipts(store.db, 'k1-fence'), 1);
  assert.throws(() => store.tx(() => { throw new Error('rolled back'); }), {message: 'rolled back'});
  assert.equal(receipts(store.db, 'k1-fence'), 1);
  unregister();
  store.tx(() => { events.push('callback'); });
  assert.deepEqual(events, ['fence, in a transaction: true', 'callback', 'fence, in a transaction: true', 'callback']);
  assert.equal(receipts(store.db, 'k1-fence'), 1);
});

test('observers get the result before COMMIT, and an observer failure rolls back the domain rows with its own writes', t => {
  const store = openedStore(t);
  const other = openedStore(t);
  const {projectId} = store;
  store.put('projects', {id: projectId});
  const seen: unknown[] = [];
  const unregister = registerProjectTransactionObserver(store.db, result => {
    seen.push(result);
    addReceipt(store.db, 'k1-observer');
    if (result === 'fail') throw new Error('observer failed');
  });
  const kept = {id: randomUUID(), projectId}, dropped = {id: randomUUID(), projectId};
  assert.equal(store.tx(() => {
    store.put('shots', kept);
    return 'ok';
  }), 'ok');
  assert.throws(() => store.tx(() => {
    store.put('shots', dropped);
    return 'fail';
  }), {message: 'observer failed'});
  assert.deepEqual(seen, ['ok', 'fail']);
  assert.deepEqual(store.get('shots', kept.id), kept);
  assert.equal(store.get('shots', dropped.id), null);
  assert.equal(receipts(store.db, 'k1-observer'), 1);
  other.tx(() => 'another connection');
  unregister();
  store.tx(() => 'later');
  assert.deepEqual(seen, ['ok', 'fail']);
});

test('close is idempotent and lets another process open the project', t => {
  const root = scratch(t);
  const store = openStore(root);
  store.close();
  store.close();
  assert.equal(store.db.isOpen, false);
  const env: NodeJS.ProcessEnv = {...testEnv(), MODE: 'open-report', ROOT: root};
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.deepEqual({...report, elapsedMs: 0}, {ok: true, projectId: store.projectId, historyState: 'current', elapsedMs: 0});
});

test('createProjectStore creates a project file with the given ID and never over an existing one', t => {
  const root = scratch(t);
  const projectFile = path.join(root, 'Film.mioon');
  const projectId = randomUUID();
  const locate = (id: string) => ({localDir: path.join(root, 'records', id), cacheDir: path.join(root, 'cache', id), tempDir: path.join(root, 'tmp')});
  const store = createProjectStore({projectFile, locate, projectId});
  assert.equal(store.projectId, projectId);
  assert.equal(store.root, root);
  assert.equal(store.localDir, path.join(root, 'records', projectId));
  assert.equal(store.historyState, 'fresh');
  store.close();
  assert.throws(() => createProjectStore({projectFile, locate}), {code: 'PROJECT_FILE_EXISTS'});
  const reopened = openProjectStore({projectFile, locate});
  assert.equal(reopened.projectId, projectId);
  assert.equal(reopened.historyState, 'current');
  reopened.close();
});

test('store ownership checks require the exact live kernel store, not copied fields', t => {
  const root = scratch(t), store = openedStore(t, root);
  assert.equal(isProjectStore(store), true);
  assert.equal(ownsStoreLock(store), true);
  // No legacy schema probe is needed to prove a kernel store's role.
  const prepare = store.db.prepare;
  store.db.prepare = () => { throw new Error('unexpected legacy schema scan'); };
  try {
    assert.doesNotThrow(() => assertProjectStore(store));
  } finally {
    store.db.prepare = prepare;
  }
  for (const copy of [{...store}, {db: store.db, root: store.root}]) {
    assert.equal(isProjectStore(copy), false);
    assert.equal(ownsStoreLock(copy), false);
    assert.throws(() => assertProjectStore(copy), {code: 'PROJECT_STORE_UNVERIFIED'});
  }
  const rootDescriptor = Object.getOwnPropertyDescriptor(store, 'root')!;
  Object.defineProperty(store, 'root', {value: path.join(root, 'other')});
  assert.equal(isProjectStore(store), false);
  assert.equal(ownsStoreLock(store), false);
  assert.throws(() => assertProjectStore(store), {code: 'PROJECT_STORE_UNVERIFIED'});
  Object.defineProperty(store, 'root', rootDescriptor);
  assert.equal(isProjectStore(store), true);
  store.close();
  assert.equal(isProjectStore(store), false);
  assert.equal(ownsStoreLock(store), false);
  assert.throws(() => assertProjectStore(store), {code: 'PROJECT_STORE_UNVERIFIED'});
  const reopened = openedStore(t, root);
  assert.equal(isProjectStore(reopened), true);
  assert.equal(ownsStoreLock(reopened), true);
  assert.doesNotThrow(() => assertProjectStore(reopened));
  assert.equal(ownsStoreLock(store), false);
  reopened.db.close();
  assert.throws(() => reopened.db.open(), {name: 'TypeError'});
  assert.equal(isProjectStore(reopened), false);
  assert.equal(ownsStoreLock(reopened), false);
  assert.throws(() => assertProjectStore(reopened), {code: 'PROJECT_STORE_UNVERIFIED'});
  assert.throws(() => reopened.close(), {code: 'ERR_INVALID_STATE'});
});

test('store transaction registrations join the real kernel transaction and preserve ordering, rollback and removal', t => {
  const store = openedStore(t), other = openedStore(t);
  store.put('projects', {id: store.projectId});
  const events: string[] = [];
  const removeFence = registerStoreTransactionFence(store.db, () => {
    assert.equal(store.db.isTransaction, true);
    events.push('workspace fence');
    addReceipt(store.db, 's0-workspace-fence');
  });
  const removeKernelFence = registerProjectTransactionFence(store.db, () => events.push('kernel fence'));
  const removeObserver = registerStoreTransactionObserver(store.db, result => {
    assert.equal(store.db.isTransaction, true);
    events.push(`workspace observer: ${String(result)}`);
    addReceipt(store.db, 's0-workspace-observer');
    if (result === 'fail') throw new Error('observer failed');
  });
  const removeKernelObserver = registerProjectTransactionObserver(store.db, () => events.push('kernel observer'));
  const kept = {id: randomUUID(), projectId: store.projectId}, dropped = {id: randomUUID(), projectId: store.projectId};
  store.tx(() => { events.push('callback'); store.put('shots', kept); return 'ok'; });
  assert.deepEqual(events, ['workspace fence', 'kernel fence', 'callback', 'workspace observer: ok', 'kernel observer']);
  assert.throws(() => store.tx(() => { store.put('shots', dropped); return 'fail'; }), {message: 'observer failed'});
  assert.deepEqual(store.get('shots', kept.id), kept);
  assert.equal(store.get('shots', dropped.id), null);
  assert.equal(receipts(store.db, 's0-workspace-fence'), 1);
  assert.equal(receipts(store.db, 's0-workspace-observer'), 1);
  const before = [...events];
  other.tx(() => 'other project');
  assert.deepEqual(events, before);
  for (const remove of [removeFence, removeKernelFence, removeObserver, removeKernelObserver]) remove();
  store.tx(() => 'unregistered');
  assert.deepEqual(events, before);
  const stop = registerStoreTransactionFence(store.db, () => {
    addReceipt(store.db, 's0-refused-fence');
    throw new Error('fence failed');
  });
  assert.throws(() => store.tx(() => assert.fail('callback must not run')), {message: 'fence failed'});
  assert.equal(receipts(store.db, 's0-refused-fence'), 0);
  assert.equal(store.db.isTransaction, false);
  stop();
});

test('explicit test fixture stores only a reference, samples the fixed ranges, and preserves a declared wrong full hash', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-fixture-'));
  const store = openStore(root); t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId});
  const bytes = Buffer.alloc(2 * 1024 * 1024, 43), id = randomUUID(), relativePath = `media/${id}.mp4`;
  writeFileSync(path.join(root, relativePath), bytes);
  const sha256 = 'a'.repeat(64), fixture = store.put('assets', {id, projectId: store.projectId, relativePath, sizeBytes: bytes.length, sha256});
  assert.equal(fixture.relativePath, relativePath);
  const record = store.get('assets', id) as Record<string, unknown>;
  assert.equal(record.relativePath, undefined); assert.equal(record.sha256, sha256);
  const reference = mediaReferenceSchema.parse(record.reference);
  const sample = createHash('sha256');for (const range of sampleRanges(bytes.length)) sample.update(bytes.subarray(range.start, range.start + range.length));
  assert.equal(reference.sampledSha256, sample.digest('hex')); assert.equal(reference.fullSha256, sha256);
  assert.notEqual(createHash('sha256').update(bytes).digest('hex'), sha256);
});

test('test fixture never opens a held project database and keeps missing fixtures unavailable', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-fixture-held-'));
  const store = openStore(root); t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId});
  const original = fs.openSync; let heldOpens = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === store.projectFile) {heldOpens++; throw new Error('Held database opened');}
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const id = randomUUID(); store.put('assets', {id, projectId: store.projectId, relativePath: 'project.mioon', sha256: null});
    const missing = randomUUID(); store.put('assets', {id: missing, projectId: store.projectId, relativePath: `media/${missing}.wav`, sha256: null});
    assert.equal(heldOpens, 0);
    for (const key of [id, missing]) {
      const asset = store.get('assets', key) as Record<string, unknown>, reference = mediaReferenceSchema.parse(asset.reference);
      assert.equal(reference.sampledSha256, '0'.repeat(64)); assert.equal(reference.fullSha256, null); assert.equal(reference.mtimeMs, 0);
    }
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
});
