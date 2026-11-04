import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, renameSync, rmSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import type {ManagerClock} from '../apps/server/src/project-host/manager.ts';
import {serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import type {ProjectHostRuntime, ProjectHostContext} from '../apps/server/src/project-host/host.ts';
import {createBackgroundCoordinator} from '../apps/server/src/project-host/background-coordinator.ts';
import {backgroundHistorySource} from '../apps/server/src/project-host/background-history.ts';
import type {TaskProjection} from '../packages/business/src/background-task-state.ts';

function clock() {
  let now = Date.UTC(2026, 10, 4), sequence = 0;
  const timers = new Map<number, {at: number; callback: () => void}>();
  const port: ManagerClock = {now: () => now, setTimeout(callback, ms) {const key = ++sequence; timers.set(key, {at: now + ms, callback}); return key;},
    clearTimeout(key) {timers.delete(key as number);}};
  return {port, advance(ms: number) {now += ms; for (const [key, value] of [...timers]) if (value.at <= now && timers.delete(key)) value.callback();}};
}
const task = (classification: TaskProjection['classification'] = 'running', keepAlive = true): TaskProjection => ({kind: 'job', taskId: randomUUID(),
  classification, keepAlive, reason: keepAlive ? null : 'WAITING_USER', taskRevision: 1});
function projection(initial: readonly TaskProjection[] = []) {
  let snapshot = initial, busy = false, refreshes = 0;
  const listeners = new Set<(snapshot: readonly TaskProjection[]) => void>();
  return {state: {snapshot: () => snapshot, refresh() {refreshes++;}, subscribe(listener: (snapshot: readonly TaskProjection[]) => void) {listeners.add(listener); return () => {listeners.delete(listener);};}},
    set(next: readonly TaskProjection[]) {snapshot = next; for (const listener of listeners) listener(snapshot);},
    get busy() {return busy;}, set busy(value: boolean) {busy = value;}, get refreshes() {return refreshes;}};
}
async function settle() {for (let i = 0; i < 20; i++) await Promise.resolve();}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 's3-coordinator-')), directories = serverAppDirectories(root), time = clock();
  const library = openAppLibrary({dataDir: root});
  let failIndex = false, appOwner = true;
  const taskIndex = {...library.taskIndex,
    upsert: (entry: Parameters<typeof library.taskIndex.upsert>[0]) => {if (failIndex) throw new Error('Synthetic application index failure'); library.taskIndex.upsert(entry);},
    replace: (id: string, entries: Parameters<typeof library.taskIndex.replace>[1]) => {if (failIndex) throw new Error('Synthetic application index failure'); library.taskIndex.replace(id, entries);}};
  const states = new Map<string, ReturnType<typeof projection>>(), contexts = new Map<string, ProjectHostContext>(), log: string[] = [];
  const coordinator = createBackgroundCoordinator({index: taskIndex, inbox: library.inbox, clock: time.port,
    assertMutationAllowed: () => {assert.equal(library.db.isOpen, true); if (!appOwner) throw new Error('Synthetic app owner lost');}, checkIntervalMs: 10});
  const readyCallbacks = new Map<string, () => unknown>();
  const manager = createProjectHostManager<ProjectHostRuntime>({directories, registry: library.registry, taskIndex, clock: time.port,
    assertMutationAllowed: () => {assert.equal(library.db.isOpen, true);},
    hooks: [{afterOpen(context, ready) {log.push('backup'); readyCallbacks.set(context.projectId, ready!.retainTask);}}, coordinator.hooks, {afterOpen() {log.push('daily');}}],
    onEvent: event => coordinator.onHostEvent(event),
    factory: async context => {
      contexts.set(context.projectId, context);
      if (!context.store.get('projects', context.projectId)) context.store.put('projects', {id: context.projectId, name: 'S3', revision: 1,
        createdAt: new Date(time.port.now()).toISOString(), updatedAt: new Date(time.port.now()).toISOString()});
      const current = states.get(context.projectId) ?? projection(); states.set(context.projectId, current);
      const sourceHistory = backgroundHistorySource(context.store);
      let activated = false;
      return {handle: async () => false, isBusy: () => current.busy, interrupt() {log.push('interrupt');}, drain: async () => {log.push('drain');},
        dispose() {log.push('dispose');}, backgroundTasks: current.state,
        activateBackground() {if (!activated) {activated = true; log.push('activate');}},
        unfinishedTasks: () => current.state.snapshot().filter(item => item.classification !== 'terminal').map(item => ({kind: item.kind, taskId: item.taskId,
          sourceHistory, taskRevision: item.taskRevision, phase: item.keepAlive ? 'active' : 'blocked', reason: item.reason}))};
    }});
  coordinator.bindManager(manager);
  t.after(async () => {coordinator.stop(); await manager.closeAll(); library.close(); rmSync(root, {recursive: true, force: true});});
  const create = async (tasks: readonly TaskProjection[]) => {const entry = await manager.create({name: 'S3'}); states.set(entry.projectId, projection(tasks)); return entry;};
  return {root, directories, time, library, coordinator, manager, states, contexts, log, create, readyCallbacks,
    failIndexWrites(value: boolean) {failIndex = value;}, setAppOwner(value: boolean) {appOwner = value;}};
}

test('ready retains the opening task before activation; closing a window keeps work and its terminal finally alive', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  const window = await f.manager.acquire(project.projectId, 'window'), state = f.states.get(project.projectId)!;
  assert.deepEqual(f.log.slice(0, 3), ['backup', 'activate', 'daily']);
  assert.throws(() => f.readyCallbacks.get(project.projectId)!(), {code: 'PROJECT_HOST_TRANSITION'}, 'opening retention cannot become an escaped general lease API');
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1);
  window.release(); assert.equal(f.manager.status(project.projectId)!.leases.window, 0);
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.phase, 'active');
  state.busy = true;
  const context = f.contexts.get(project.projectId)!;
  context.store.put('projects', {...context.store.get('projects', project.projectId) as object, notes: 'background completed'});
  state.set([{...original, classification: 'terminal', keepAlive: false, taskRevision: 2}]);
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1, 'the task owns its complete finally tail');
  assert.equal(f.library.taskIndex.listProject(project.projectId).length, 0);
  state.busy = false; f.time.advance(100); await settle();
  assert.equal(f.manager.status(project.projectId), null);
  assert.equal(state.refreshes, 0, 'finally checks use the cached projection rather than a table rescan');
  assert.equal(f.manager.inspectProject(project.projectId, db => JSON.parse(String(db.prepare('SELECT data FROM project.projects').get()!.data)).notes), 'background completed');
});

test('prepared/waiting-user tasks persist a blocking reason without keeping the project open forever', async t => {
  const f = await fixture(t), project = await f.create([task('waiting_user', false)]);
  const window = await f.manager.acquire(project.projectId, 'window');
  assert.equal(f.manager.status(project.projectId)!.leases.task, 0);
  window.release(); await settle();
  assert.equal(f.manager.status(project.projectId), null);
  const indexed = f.library.taskIndex.listProject(project.projectId);
  assert.equal(indexed.length, 1); assert.equal(indexed[0]!.phase, 'blocked'); assert.equal(indexed[0]!.reason, 'WAITING_USER');
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, true);
});

test('due checks notice an unavailable project path, preserve its task, and resume only on a real reopen', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  const window = await f.manager.acquire(project.projectId, 'window'); window.release();
  const offline = path.join(f.root, 'offline.mioon'); renameSync(project.projectFile, offline);
  f.time.advance(10); await settle();
  assert.equal(f.manager.status(project.projectId)?.state, 'closing');
  await f.manager.close(project.projectId);
  assert.equal(f.manager.status(project.projectId), null);
  const blocked = f.library.taskIndex.listProject(project.projectId);
  assert.equal(blocked[0]!.phase, 'blocked'); assert.equal(blocked[0]!.reason, 'PROJECT_MISSING');
  assert.deepEqual(f.coordinator.listUnavailableProjects(), [{projectId: project.projectId, taskCount: 1, reasonCodes: ['PROJECT_MISSING']}]);
  const refreshes = f.states.get(project.projectId)!.refreshes;
  f.time.advance(1000); await settle(); assert.equal(f.states.get(project.projectId)!.refreshes, refreshes, 'no reopen/poll loop for an offline project');
  renameSync(offline, project.projectFile);
  const reopened = await f.manager.acquire(project.projectId, 'window');
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.phase, 'active');
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).certainty, 'known');
  f.states.get(project.projectId)!.set([{...original, classification: 'terminal', keepAlive: false}]);
  reopened.release(); await settle(); assert.equal(f.manager.status(project.projectId), null);
});

test('restore hands leases to S3 and exposes failures as durable blocked metadata', async t => {
  const f = await fixture(t), original = task(), good = await f.create([original]), missing = await f.create([task()]);
  for (const project of [good, missing]) f.library.taskIndex.upsert({projectId: project.projectId, projectFile: project.projectFile,
    kind: 'job', taskId: f.states.get(project.projectId)!.state.snapshot()[0]!.taskId, indexedAt: new Date(f.time.port.now()).toISOString()});
  renameSync(missing.projectFile, path.join(f.root, 'not-registered.mioon'));
  const restored = await f.manager.restore();
  assert.equal(restored.leases.length, 1); assert.equal(restored.failures.length, 1);
  assert.equal(f.manager.status(good.projectId)!.leases.task, 2);
  f.coordinator.acceptRestore(restored);
  assert.equal(f.manager.status(good.projectId)!.leases.task, 1);
  assert.equal(f.library.taskIndex.listProject(good.projectId).length, 1, 'legacy source was adopted rather than double counted');
  assert.equal(f.library.taskIndex.listProject(missing.projectId)[0]!.phase, 'blocked');
  assert.equal(f.coordinator.inspectProjectWork(missing.projectId).mayWriteBack, true);
  f.states.get(good.projectId)!.set([{...original, classification: 'terminal', keepAlive: false}]);
  await settle(); assert.equal(f.manager.status(good.projectId), null);
});

test('an archived source cannot hide current work or survive as a false busy failure', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  f.library.taskIndex.upsert({projectId: project.projectId, projectFile: project.projectFile, kind: original.kind, taskId: original.taskId,
    indexedAt: new Date(f.time.port.now()).toISOString(), phase: 'archived', reason: 'HISTORY_REPLACED', sourceHistory: 'a'.repeat(64), taskRevision: 1});
  const window = await f.manager.acquire(project.projectId, 'window');
  assert.equal(f.library.taskIndex.listProject(project.projectId).length, 2);
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1);
  f.states.get(project.projectId)!.set([{...original, classification: 'terminal', keepAlive: false}]);
  window.release(); await settle();
  assert.equal(f.library.taskIndex.listProject(project.projectId).length, 1);
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, false);
  f.coordinator.acceptRestore({leases: [], failures: [{projectId: project.projectId, error: {code: 'PROJECT_HISTORY_DIVERGED'}}]});
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, false);
});

test('V5 completion and its early receipt replay archive only the old history source', async t => {
  const f = await fixture(t), oldTask = task('waiting_user', false), project = await f.create([oldTask]);
  const window = await f.manager.acquire(project.projectId, 'window'); window.release(); await f.manager.close(project.projectId);
  const oldSource = f.library.taskIndex.listProject(project.projectId)[0]!.sourceHistory;
  const raw = new DatabaseSync(project.projectFile);
  try {raw.prepare("UPDATE projects SET data=json_set(data,'$.name','External edit') WHERE id=?").run(project.projectId);} finally {raw.close();}
  const recovery = await f.manager.acquire(project.projectId, 'window');
  assert.ok(recovery.host.recovery);
  const status = recovery.host.recovery.status(), input = {projectId: project.projectId, requestId: randomUUID(), action: 'continue' as const,
    expected: status.file, historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
  recovery.release(); await f.manager.close(project.projectId);
  const completed = await f.manager.resolveHistory(input);
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.phase, 'archived');
  const nextTask = {...task(), taskId: oldTask.taskId};
  f.states.set(project.projectId, projection([nextTask]));
  const current = await f.manager.acquire(project.projectId, 'window');
  const before = f.library.taskIndex.listProject(project.projectId);
  assert.equal(before.length, 2); assert.notEqual(before.find(entry => entry.phase === 'active')!.sourceHistory, oldSource);
  const changes = current.host.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(await f.manager.resolveHistory(input), completed);
  assert.deepEqual(f.library.taskIndex.listProject(project.projectId), before);
  assert.equal(current.host.store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1);
  unlinkSync(path.join(current.host.store.localDir, completed.archive));
  assert.deepEqual(await f.manager.resolveHistory(input), completed, 'a retired archive is not needed to keep a completed receipt idempotent for new work');
  assert.deepEqual(f.library.taskIndex.listProject(project.projectId), before);
  f.states.get(project.projectId)!.set([{...nextTask, classification: 'terminal', keepAlive: false}]);
  current.release(); await settle();
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, false);
});

test('S3 releases only its own task lease, leaving a separately retained audio owner intact', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  const window = await f.manager.acquire(project.projectId, 'window'), audio = await f.manager.acquire(project.projectId, 'task');
  window.release(); assert.equal(f.manager.status(project.projectId)!.leases.task, 2);
  f.states.get(project.projectId)!.set([{...original, classification: 'terminal', keepAlive: false}]);
  assert.equal(audio.signal.aborted, false); assert.equal(f.manager.status(project.projectId)!.leases.task, 1);
  audio.release(); await settle(); assert.equal(f.manager.status(project.projectId), null);
});

test('a domain read-only pause is durable and visible even when filesystem mode bits did not change', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  const window = await f.manager.acquire(project.projectId, 'window'); window.release();
  f.states.get(project.projectId)!.set([{...original, classification: 'waiting_user', keepAlive: false, reason: 'PROJECT_READONLY'}]);
  await f.manager.close(project.projectId);
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.phase, 'blocked');
  assert.deepEqual(f.coordinator.listUnavailableProjects(), [{projectId: project.projectId, taskCount: 1, reasonCodes: ['PROJECT_READONLY']}]);
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, true);
});

test('a committed task whose index write failed cannot become an empty query after closing', async t => {
  const f = await fixture(t), original = task(), project = await f.create([]);
  const window = await f.manager.acquire(project.projectId, 'window');
  f.failIndexWrites(true);
  assert.throws(() => f.states.get(project.projectId)!.set([original]), /Synthetic application index failure/u);
  assert.equal(f.library.taskIndex.listProject(project.projectId).length, 0);
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).certainty, 'unknown');
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, true);
  window.release(); await settle();
  assert.equal(f.manager.status(project.projectId), null);
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).mayWriteBack, true, 'an absent app row is not proof after a known index fault');
  f.failIndexWrites(false);
  const reopened = await f.manager.acquire(project.projectId, 'window');
  assert.equal(f.coordinator.inspectProjectWork(project.projectId).certainty, 'known');
  assert.equal(f.library.taskIndex.listProject(project.projectId).length, 1);
  f.states.get(project.projectId)!.set([{...original, classification: 'terminal', keepAlive: false}]);
  reopened.release(); await settle();
});

test('an application owner failure refuses lifecycle and home queries instead of claiming no work', async t => {
  const f = await fixture(t), project = await f.create([]);
  const before = f.library.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.setAppOwner(false);
  assert.throws(() => f.coordinator.inspectProjectWork(project.projectId), /Synthetic app owner lost/u);
  assert.throws(() => f.coordinator.listUnavailableProjects(), /Synthetic app owner lost/u);
  assert.equal(f.library.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  f.setAppOwner(true);
});

test('a post-COMMIT memory pause releases the executor lease despite persistent index failure without relocating the project', async t => {
  const f = await fixture(t), original = task(), project = await f.create([original]);
  const window = await f.manager.acquire(project.projectId, 'window'), state = f.states.get(project.projectId)!;
  state.busy = true; f.failIndexWrites(true);
  assert.throws(() => state.set([{...original, classification: 'waiting_user', keepAlive: false, reason: 'BACKGROUND_TASK_INDEX_UNCERTAIN'}]), /Synthetic application index failure/u);
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1, 'an in-flight executor still owns its finally tail');
  f.time.advance(100); await settle();
  assert.equal(f.manager.status(project.projectId)!.state, 'open');
  assert.equal(f.manager.status(project.projectId)!.leases.task, 1);
  assert.equal(f.log.includes('interrupt'), false, 'an index fault is not evidence of a moved project');
  state.busy = false; f.time.advance(100); await settle();
  assert.equal(f.manager.status(project.projectId)!.state, 'open');
  assert.equal(f.manager.status(project.projectId)!.leases.task, 0, 'a stopped executor cannot retain S3 forever');
  assert.equal(state.refreshes, 0, 'the finally tail needs no SQL refresh');
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.phase, 'active', 'the application write really remained unavailable');
  assert.equal(f.library.taskIndex.listProject(project.projectId)[0]!.reason, null);
  const inspection = f.coordinator.inspectProjectWork(project.projectId);
  assert.equal(inspection.certainty, 'unknown'); assert.equal(inspection.mayWriteBack, true);
  assert.deepEqual(inspection.reasons, ['BACKGROUND_TASK_INDEX_UNCERTAIN']);
  window.release(); await settle();
  assert.equal(f.manager.status(project.projectId), null);
  f.time.advance(1000); await settle();
  assert.equal(f.manager.status(project.projectId), null, 'confirmation failure cannot start a reopen loop');
  assert.equal(f.log.filter(item => item === 'activate').length, 1);
  assert.deepEqual(f.coordinator.inspectProjectWork(project.projectId).reasons, ['BACKGROUND_TASK_INDEX_UNCERTAIN']);
});
