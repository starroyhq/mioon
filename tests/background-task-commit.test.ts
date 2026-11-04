import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createProjectStore, openProjectStore, registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {subscribeBackgroundTaskChanges, markBackgroundTaskChanged} from '../packages/business/src/background-task-events.ts';
import {createProjectBackgroundState} from '../packages/business/src/background-task-state.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-background-commit-'));
  const options = {projectFile: path.join(root, 'Project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})};
  let store = createProjectStore(options);
  store.put('projects', {id: store.projectId, name: 'Background', description: '', revision: 1, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z'});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const job = () => ({id: randomUUID(), projectId: store.projectId, status: 'queued', revision: 1, providerId: 'mock', snapshot: {}});
  return {root, options, job, get store() {return store;}, reopen() {store.close(); store = openProjectStore(options); return store;}};
}

test('task changes are synchronous after the real COMMIT, with fixed IDs and no dirty read', t => {
  const f = fixture(t), first = f.job(), second = f.job(), seen: unknown[] = [];
  subscribeBackgroundTaskChanges(f.store.db, refs => {
    assert.equal(f.store.db.isTransaction, false);
    assert.deepEqual(f.store.get('jobs', first.id), {...first, revision: 2});
    assert.deepEqual(f.store.get('jobs', second.id), second);
    seen.push(refs);
  });
  f.store.tx(() => {
    f.store.put('jobs', first);
    f.store.put('jobs', {...first, revision: 2});
    f.store.put('jobs', second);
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, [[{kind: 'job', taskId: first.id}, {kind: 'job', taskId: second.id}]]);
});

test('rollback and pre-COMMIT observer failure discard task notifications without leaking the next transaction', t => {
  const f = fixture(t), row = f.job(), seen: unknown[] = [];
  subscribeBackgroundTaskChanges(f.store.db, refs => seen.push(refs));
  assert.throws(() => f.store.tx(() => {f.store.put('jobs', row); throw Error('transaction rollback');}), /transaction rollback/);
  assert.equal(f.store.get('jobs', row.id), null);
  assert.deepEqual(seen, []);
  f.store.tx(() => f.store.get('projects', f.store.projectId));
  assert.deepEqual(seen, []);
  const remove = registerProjectTransactionObserver(f.store.db, () => {throw Error('pre-COMMIT observer');});
  assert.throws(() => f.store.tx(() => f.store.put('jobs', row)), /pre-COMMIT observer/);
  assert.equal(f.store.get('jobs', row.id), null);
  assert.deepEqual(seen, []);
  remove();
  f.store.tx(() => f.store.put('jobs', row));
  assert.deepEqual(seen, [[{kind: 'job', taskId: row.id}]]);
});

test('a committed notification failure reports unknown, keeps the original row and does not roll it back', t => {
  const f = fixture(t), row = f.job();
  const remove = subscribeBackgroundTaskChanges(f.store.db, () => {throw Error('PRIVATE index failure');});
  assert.throws(() => f.store.tx(() => f.store.put('jobs', row)), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'status' in error && 'details' in error);
    assert.equal(error.code, 'BACKGROUND_TASK_INDEX_UNCERTAIN');
    assert.equal(error.status, 503);
    assert.deepEqual(error.details, {projectId: f.store.projectId, mutationOutcome: 'unknown'});
    assert.equal(error.message.includes('PRIVATE'), false);
    return true;
  });
  assert.equal(f.store.db.isTransaction, false);
  assert.deepEqual(f.store.get('jobs', row.id), row);
  remove();
  assert.deepEqual(f.reopen().get('jobs', row.id), row);
});

test('autocommit puts notify once and failure preserves an already committed export', t => {
  const f = fixture(t), row = {id: randomUUID(), projectId: f.store.projectId, status: 'queued'}, seen: unknown[] = [];
  subscribeBackgroundTaskChanges(f.store.db, refs => seen.push(refs));
  const remove = subscribeBackgroundTaskChanges(f.store.db, () => {throw Error('ack lost');});
  assert.throws(() => f.store.put('exports', row), {code: 'BACKGROUND_TASK_INDEX_UNCERTAIN'});
  assert.deepEqual(f.store.get('exports', row.id), row);
  assert.deepEqual(seen, [[{kind: 'export', taskId: row.id}]]);
  remove();
});

test('non-task puts and read-only transactions do not emit or alter task rows', t => {
  const f = fixture(t), seen: unknown[] = [];
  subscribeBackgroundTaskChanges(f.store.db, refs => seen.push(refs));
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.store.tx(() => f.store.list('jobs'));
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.deepEqual(seen, []);
  f.store.put('projects', {id: f.store.projectId, name: 'Renamed', description: '', revision: 2, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:01.000Z'});
  assert.deepEqual(seen, []);
});

test('explicit domain task notifications inside a failed transaction are discarded too', t => {
  const f = fixture(t), id = randomUUID(), seen: unknown[] = [];
  subscribeBackgroundTaskChanges(f.store.db, refs => seen.push(refs));
  assert.throws(() => f.store.tx(() => {markBackgroundTaskChanged(f.store.db, 'edit_task', id); throw Error('failed');}), /failed/);
  f.store.tx(() => {});
  assert.deepEqual(seen, []);
});

test('SIGKILL between project COMMIT and index callback leaves the exact task available for opening-time admission', {timeout: 30000}, async t => {
  const f = fixture(t), taskId = randomUUID(), projectId = f.store.projectId;
  f.store.close();
  const child = fork(new URL('./fixtures/background-task-commit-worker.ts', import.meta.url), [f.root, taskId], {execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  t.after(() => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');});
  const [message] = await once(child, 'message', {signal: AbortSignal.timeout(20000)});
  assert.deepEqual(message, {type: 'project-committed', taskId});
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, null); assert.equal(signal, 'SIGKILL');
  const store = f.reopen();
  assert.deepEqual(store.get('jobs', taskId), {id: taskId, projectId, status: 'queued', revision: 1, providerId: 'mock', snapshot: {}});
  const projection = createProjectBackgroundState(store).snapshot();
  assert.ok(projection.some(task => task.kind === 'job' && task.taskId === taskId && task.keepAlive));
});
