import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectBackgroundState, pauseUnavailableBackgroundTask,markBackgroundTaskInvalid} from '../packages/business/src/background-task-state.ts';
import {markBackgroundTaskChanged, subscribeBackgroundTaskChanges} from '../packages/business/src/background-task-events.ts';
import type {BackgroundTaskRef} from '../packages/business/src/background-task-events.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/domains/sequence.ts';
import {FCPXML_EXPORT_TASK_KIND, fcpxmlExportTaskSchema} from '../packages/contracts/src/project-registry.ts';
import {discloseFcpExportTask, isFcpExportTaskRecord} from '../packages/business/src/fcpxml-export-task.ts';

function fixture(t: TestContext, initialise = true, format6 = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-background-state-')), directory = path.join(root, 'project');
  mkdirSync(directory, {mode: 0o700});
  const store = createProjectStore({projectFile: path.join(directory, 'Film.mioon'),
    ...(format6 ? {targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION, allowFormat6: true as const} : {}),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  store.put('projects', {id: store.projectId, name: 'Background state', revision: 1});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const state = initialise ? createProjectBackgroundState(store) : undefined;
  const job = (patch: Record<string, unknown> = {}) => ({id: randomUUID(), projectId: store.projectId, revision: 1, status: 'queued', phase: 'waiting', providerId: 'mock', providerJobId: null, submissionCount: 0, error: null, ...patch});
  return {root, store, state, job};
}

test('a state uses the exact owner and snapshot is cached; ordinary due checks only read managed IDs', t => {
  const f = fixture(t), state = f.state!, job = f.job();
  assert.equal(createProjectBackgroundState(f.store), state);
  assert.throws(() => createProjectBackgroundState({...f.store}), {code: 'PROJECT_STORE_UNVERIFIED'});
  f.store.put('jobs', job);
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n, queries: string[] = [], prepare = f.store.db.prepare;
  f.store.db.prepare = sql => {queries.push(sql); return prepare.call(f.store.db, sql);};
  try {
    assert.equal(state.snapshot().find(task => task.taskId === job.id)?.keepAlive, true);
    assert.deepEqual(state.snapshot(), state.snapshot());
    assert.equal(queries.length, 0);
    state.refresh();
    assert.ok(queries.some(sql => sql.includes('FROM jobs WHERE id=?')));
    assert.equal(queries.some(sql => /FROM (?:jobs|exports|edit_tasks|image_tasks|frame_tasks|scene_tasks|subject_variant_batches) WHERE .*ORDER BY id LIMIT/u.test(sql)), false);
  } finally {f.store.db.prepare = prepare;}
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});

test('only successful task writes notify after COMMIT; rollback and unrelated/read-only transactions stay silent', t => {
  const f = fixture(t), calls: (readonly BackgroundTaskRef[])[] = [], job = f.job();
  const unsubscribe = subscribeBackgroundTaskChanges(f.store.db, refs => {assert.equal(f.store.db.isTransaction, false); calls.push(refs);});
  t.after(unsubscribe);
  assert.throws(() => f.store.tx(() => {f.store.put('jobs', job); assert.equal(calls.length, 0); assert.equal(f.state!.snapshot().length, 0); throw Error('rollback');}), /rollback/u);
  assert.equal(f.store.get('jobs', job.id), null); assert.equal(calls.length, 0); assert.deepEqual(f.state!.snapshot(), []);
  f.store.tx(() => f.store.db.prepare('SELECT 1').get());
  f.store.tx(() => f.store.put('projects', {id: f.store.projectId, name: 'Unrelated', revision: 2}));
  assert.equal(calls.length, 0);
  f.store.tx(() => {f.store.put('jobs', job); f.store.put('jobs', {...job, revision: 2}); assert.equal(calls.length, 0);});
  assert.deepEqual(calls, [[{kind: 'job', taskId: job.id}]]);
  assert.equal(f.state!.snapshot()[0]!.taskRevision, 2);
});

test('format-6 processing history is projected by stable ID and only unfinished work retains the host', t => {
  const {store} = fixture(t, false, true), taskId = randomUUID(), readyId = randomUUID();
  const first = '2026-11-27T00:00:00.000Z';
  const insert = store.db.prepare(`INSERT INTO timeline_processing_tasks
    (id,projectId,demandKey,kind,state,revision,requestId,input,updatedAt)
    VALUES (?,?,?,'reverse',?,1,?,'{}',?)`);
  store.tx(() => {
    insert.run(taskId, store.projectId, 'a'.repeat(64), 'queued', 'first-request', first);
    insert.run(readyId, store.projectId, 'b'.repeat(64), 'ready', 'second-request', first);
  });
  const state = createProjectBackgroundState(store);
  assert.deepEqual(state.snapshot(), [{kind: 'timeline-processing', taskId, classification: 'running', keepAlive: true, reason: null, taskRevision: 1}]);
  const observed: unknown[] = [];
  t.after(state.subscribe(tasks => observed.push(tasks)));
  store.tx(() => {
    store.db.prepare("UPDATE timeline_processing_tasks SET state='failed',revision=2,errorCode='DISK_FULL' WHERE id=?").run(taskId);
    markBackgroundTaskChanged(store.db, 'timeline-processing', taskId);
    assert.equal(state.snapshot()[0]?.keepAlive, true);
    assert.equal(observed.length, 0);
  });
  assert.deepEqual(state.snapshot(), [{kind: 'timeline-processing', taskId, classification: 'terminal', keepAlive: false, reason: null, taskRevision: 2}]);
  assert.equal(observed.length, 1);
});

test('post-COMMIT uncertainty pauses every affected live identity, survives due reads and never resurrects terminal work', t => {
  const f = fixture(t), first = f.job(), second = f.job();
  let unsubscribe = f.state!.subscribe(() => {throw Error('Synthetic app index unavailable');});
  assert.throws(() => f.store.tx(() => {f.store.put('jobs', first); f.store.put('jobs', second);}), {code: 'BACKGROUND_TASK_INDEX_UNCERTAIN'});
  for (const value of [first, second]) {
    assert.deepEqual(f.store.get('jobs', value.id), value);
    const task = f.state!.snapshot().find(item => item.taskId === value.id)!;
    assert.equal(task.keepAlive, false); assert.equal(task.reason, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
  }
  unsubscribe(); f.state!.refresh();
  assert.equal(f.state!.snapshot().every(task => task.keepAlive === false && task.reason === 'BACKGROUND_TASK_INDEX_UNCERTAIN'), true);
  f.store.tx(() => {for (const value of [first, second]) f.store.put('jobs', {...value, status: 'succeeded', revision: 2});});
  unsubscribe = f.state!.subscribe(() => {throw Error('Synthetic terminal-index failure');});
  try {assert.throws(() => f.store.put('jobs', f.job({status: 'failed'})), {code: 'BACKGROUND_TASK_INDEX_UNCERTAIN'});} finally {unsubscribe();}
  assert.equal(f.state!.snapshot().every(task => task.classification === 'terminal' && task.keepAlive === false && task.reason === null), true);
});

for (const [status, patch, classification, keepAlive] of [
  ['queued', {}, 'running', true], ['running', {}, 'running', true], ['downloading', {}, 'running', true],
  ['submission_unknown', {providerId: 'ark'}, 'remote_unknown', false],
  ['submission_unknown', {providerId: 'ark', nextPollAt: 0}, 'remote_unknown', true],
  ['submission_unknown', {providerId: 'ark', nextPollAt: 5000}, 'remote_unknown', false],
  ['submission_unknown', {providerId: 'ark', providerJobId: 'accepted-remote'}, 'remote_unknown', true],
  ['submission_unknown', {providerId: 'mock'}, 'remote_unknown', true],
  ['queued', {phase: 'connection_required', error: {code: 'VIDEO_CONNECTION_REQUIRED'}}, 'waiting_user', false],
  ['queued', {phase: 'connection_required', nextPollAt: 0, error: {code: 'VIDEO_CONNECTION_REQUIRED'}}, 'running', true],
  ['cancelled', {cancelScope: 'local_only', providerJobId: 'still-remote', submissionCount: 1}, 'remote_unknown', false],
  ['cancelled', {cancelScope: 'local_only', phase: 'output_review_required', providerJobId: 'finished-remote', submissionCount: 1}, 'waiting_user', false],
  ['cancelled', {cancelScope: 'local_only'}, 'terminal', false], ['failed', {}, 'terminal', false], ['succeeded', {}, 'terminal', false],
] as const) test(`job ${status}/${JSON.stringify(patch)} projects lifecycle without rewriting the original status`, t => {
  const f = fixture(t), value = f.job({status, ...patch});
  f.store.put('jobs', value);
  const result = f.state!.snapshot().find(task => task.taskId === value.id)!;
  assert.equal(result.classification, classification); assert.equal(result.keepAlive, keepAlive);
  assert.deepEqual(f.store.get('jobs', value.id), value);
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
});

test('initial admission does not let more than 513 ordinary cancelled rows hide a later unfinished job', t => {
  const f = fixture(t, false), active = f.job({id: 'ffffffff-ffff-4fff-8fff-ffffffffffff'});
  f.store.tx(() => {
    for (let index = 0; index < 514; index++) f.store.put('jobs', f.job({status: 'cancelled', cancelScope: 'local_only'}));
    f.store.put('jobs', active);
  });
  const state = createProjectBackgroundState(f.store);
  assert.deepEqual(state.snapshot().map(task => task.taskId), [active.id]);
});

test('FCPXML exports hold the existing export lease through running progress and release it on every terminal outcome', t => {
  const f = fixture(t);
  const kind = FCPXML_EXPORT_TASK_KIND, progress = {files: 0, totalFiles: 2, bytes: 0, totalBytes: 8};
  const states = ['done', 'failed', 'cancelled'] as const;
  for (const status of states) {
    const row = {id: randomUUID(), projectId: f.store.projectId, kind, mode: kind, revision: 1, status: 'running', progress};
    f.store.tx(() => {
      f.store.put('exports', row);
      assert.equal(f.state!.snapshot().some(item => item.taskId === row.id), false, 'running state appears after commit');
    });
    const projection = () => f.state!.snapshot().find(item => item.taskId === row.id);
    assert.deepEqual(projection(), {kind: 'export', taskId: row.id, classification: 'running', keepAlive: true, reason: null, taskRevision: 1});
    f.store.put('exports', {...row, revision: 2, progress: {...progress, files: 1, bytes: 4}});
    assert.equal(projection()?.taskRevision, 2);
    f.store.put('exports', {...row, revision: 3, status});
    assert.deepEqual(projection(), {kind: 'export', taskId: row.id, classification: 'terminal', keepAlive: false, reason: null, taskRevision: 3});
  }
});

test('FCPXML terminal rows do not occupy the bounded recoverable index on reopen', t => {
  const f = fixture(t, false), kind = FCPXML_EXPORT_TASK_KIND;
  const row = {projectId: f.store.projectId, kind, mode: kind, revision: 2, status: 'done'};
  const activeId = randomUUID(), brokenId = randomUUID();
  f.store.tx(() => {
    for (let index = 0; index < 513; index++) f.store.put('exports', {...row, id: randomUUID()});
    f.store.put('exports', {...row, id: activeId, status: 'running'});
    f.store.put('exports', {...row, id: brokenId, status: 'running', kind: undefined});
  });
  const snapshot = createProjectBackgroundState(f.store).snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot.find(task => task.taskId === activeId)?.keepAlive, true);
  assert.deepEqual(snapshot.find(task => task.taskId === brokenId), {kind: 'export', taskId: brokenId,
    classification: 'waiting_user', keepAlive: false, reason: 'BACKGROUND_TASK_INVALID', taskRevision: 2});
});

test('FCPXML task disclosure validates ownership and exposes only normalized task center fields', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const kind = FCPXML_EXPORT_TASK_KIND, projectId = randomUUID(), id = randomUUID();
  const visible = {kind, mode: kind, projectId, id, title: 'Final edit', requestId: randomUUID(), status: 'done',
    progress: {files: 2, totalFiles: 2, bytes: 8, totalBytes: 8}, revision: 3, createdAt: at, updatedAt: at};
  const stored = {...visible, requestHash: 'private-fingerprint', publication: {bundlePath: '/private/synthetic/test.fcpxmld'},
    result: {displayPath: '/private/synthetic'}, destination: {token: 'synthetic-private-token'}};
  const disclosed = discloseFcpExportTask(stored, {id, projectId});
  assert.deepEqual(disclosed, visible);
  assert.equal(fcpxmlExportTaskSchema.safeParse(disclosed).success, true);
  assert.equal(fcpxmlExportTaskSchema.safeParse(stored).success, false);
  assert.equal(discloseFcpExportTask({mode: 'timeline'}), null);
  assert.equal(isFcpExportTaskRecord({...stored, mode: 'timeline'}), true);
  assert.throws(() => discloseFcpExportTask({...stored, mode: 'timeline'}), {code: 'EXPORT_FAILED'});
  assert.throws(() => discloseFcpExportTask(stored, {id: randomUUID(), projectId}), {code: 'EXPORT_FAILED'});
  assert.throws(() => discloseFcpExportTask({...stored, progress: {...visible.progress, bytes: 9}}), {code: 'EXPORT_FAILED'});
});

test('initial excess unfinished identities refuse rather than silently presenting a partial or empty snapshot', t => {
  const f = fixture(t, false);
  f.store.tx(() => {for (let index = 0; index < 513; index++) f.store.put('jobs', f.job());});
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.throws(() => createProjectBackgroundState(f.store), {code: 'BACKGROUND_TASK_INDEX_LIMIT'});
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 513);
});

test('pre-COMMIT and autocommit capacity admission refuse the 513th task without creating an unopenable project', t => {
  const f = fixture(t), retained = Array.from({length: 512}, () => f.job()), overflow = f.job(), seen: unknown[] = [];
  f.store.tx(() => {for (const job of retained) f.store.put('jobs', job);});
  const unsubscribe = f.state!.subscribe(value => seen.push(value)); t.after(unsubscribe);
  assert.equal(f.state!.snapshot().filter(task => task.classification !== 'terminal').length, 512);
  assert.throws(() => f.store.tx(() => {
    f.store.put('jobs', overflow);
    assert.equal(f.state!.preview([{kind: 'job', taskId: overflow.id}]).filter(task => task.classification !== 'terminal').length, 513);
    assert.equal(f.state!.snapshot().length, 512); assert.equal(seen.length, 0);
  }), {code: 'BACKGROUND_TASK_INDEX_LIMIT'});
  assert.equal(f.store.get('jobs', overflow.id), null); assert.equal(f.state!.snapshot().length, 512); assert.equal(seen.length, 0);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.throws(() => f.store.put('jobs', overflow), {code: 'BACKGROUND_TASK_INDEX_LIMIT'});
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.store.get('jobs', overflow.id), null);
  assert.doesNotThrow(() => f.state!.refresh());
});

test('a completed task can yield its capacity to a new accepted identity in the same transaction', t => {
  const f = fixture(t), retained = Array.from({length: 512}, () => f.job()), next = f.job();
  f.store.tx(() => {for (const job of retained) f.store.put('jobs', job);});
  f.store.tx(() => {f.store.put('jobs', {...retained[0]!, status: 'succeeded', revision: 2}); f.store.put('jobs', next);});
  assert.equal(f.state!.snapshot().filter(task => task.classification !== 'terminal').length, 512);
  assert.deepEqual(f.store.get('jobs', next.id), next);
  assert.equal(f.state!.snapshot().find(task => task.taskId === retained[0]!.id)!.classification, 'terminal');
});

for (const failure of ['moved', 'readonly', 'source'] as const) test(`real ${failure} metadata pauses a task without replacing its status or granting another submit`, t => {
  const f = fixture(t), value = f.job({status: 'running', providerId: 'ark', providerJobId: 'accepted'}), ref = {kind: 'job' as const, taskId: value.id};
  f.store.put('jobs', value); const before = JSON.stringify(f.store.get('jobs', value.id)), changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  let error: unknown;
  if (failure === 'moved') {renameSync(f.store.projectFile, f.store.projectFile + '.moved'); error = Object.assign(Error('missing'), {code: 'ENOENT', path: f.store.projectFile});}
  else if (failure === 'readonly') {chmodSync(f.store.projectFile, 0o400); error = Object.assign(Error('readonly'), {code: 'EACCES', path: f.store.projectFile});}
  else {const source = path.join(f.store.projectDir, 'source.mp4'); writeFileSync(source, 'source'); rmSync(source); error = Object.assign(Error('missing source'), {code: 'MEDIA_MISSING'});}
  try {
    assert.equal(pauseUnavailableBackgroundTask(f.store.db, ref, error), true);
    const task = f.state!.snapshot().find(item => item.taskId === value.id)!;
    assert.equal(task.keepAlive, false); assert.equal(task.classification, 'waiting_user');
    assert.equal(task.reason, failure === 'moved' ? 'PROJECT_MISSING' : failure === 'readonly' ? 'PROJECT_READONLY' : 'SOURCE_UNAVAILABLE');
    assert.equal(JSON.stringify(f.store.get('jobs', value.id)), before);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    f.state!.refresh(); assert.equal(f.state!.snapshot().find(item => item.taskId === value.id)!.keepAlive, false);
  } finally {
    if (failure === 'moved') renameSync(f.store.projectFile + '.moved', f.store.projectFile);
    if (failure === 'readonly') chmodSync(f.store.projectFile, 0o600);
  }
  f.store.put('jobs', {...value, status: 'succeeded', revision: 2});
  assert.equal(f.state!.snapshot().find(item => item.taskId === value.id)!.classification, 'terminal');
  assert.equal(f.state!.snapshot().find(item => item.taskId === value.id)!.reason, null);
});

test('provider/network failures and private stage failures are not relabelled as a missing project or source', t => {
  const f = fixture(t), value = f.job(), ref = {kind: 'job' as const, taskId: value.id}; f.store.put('jobs', value);
  for (const error of [Object.assign(Error('network'), {code: 'PROVIDER_POLL_TIMEOUT'}), Object.assign(Error('private stage'), {code: 'ENOENT', path: path.join(f.store.tempDir, 'part.mp4')})])
    assert.equal(pauseUnavailableBackgroundTask(f.store.db, ref, error), false);
  assert.equal(f.state!.snapshot().find(item => item.taskId === value.id)!.keepAlive, true);
});

test('explicit dirty IDs can reconcile a native committed transition without a second all-table scan', t => {
  const f = fixture(t), value = f.job(); f.store.put('jobs', value);
  f.store.tx(() => {f.store.db.prepare("UPDATE jobs SET data=json_set(data,'$.status','succeeded','$.revision',2) WHERE id=?").run(value.id); markBackgroundTaskChanged(f.store.db, 'job', value.id);});
  assert.equal(f.state!.snapshot().find(item => item.taskId === value.id)!.classification, 'terminal');
});

test('a proven invalid identity blocks only admitted work outside transactions and stays quiet until committed recovery or a new owner', t => {
  const f = fixture(t), value = f.job(), ref = {kind: 'job' as const, taskId: value.id}; f.store.put('jobs', value);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before = f.state!.snapshot();
  assert.equal(markBackgroundTaskInvalid(f.store.db, {kind: 'job', taskId: randomUUID()}), false);
  assert.throws(() => f.store.tx(() => markBackgroundTaskInvalid(f.store.db, ref)), /requires a completed transaction/u);
  assert.deepEqual(f.state!.snapshot(), before);
  assert.equal(markBackgroundTaskInvalid(f.store.db, ref), true);
  f.state!.refresh();
  assert.equal(f.state!.snapshot()[0]!.reason, 'BACKGROUND_TASK_INVALID'); assert.equal(f.state!.snapshot()[0]!.keepAlive, false);
  assert.deepEqual(f.store.get('jobs', value.id), value); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  f.store.put('jobs', {...value, revision: 2}); assert.equal(f.state!.snapshot()[0]!.keepAlive, true);
  markBackgroundTaskInvalid(f.store.db, ref); f.state!.dispose();
  const reopened = createProjectBackgroundState(f.store); assert.equal(reopened.snapshot()[0]!.keepAlive, true); assert.equal(reopened.snapshot()[0]!.reason, null);
});
