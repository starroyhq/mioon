import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {createProjectFile, openProjectStore, recoverProjectFile} from '../packages/business/src/project-file/index.ts';
import type {OpenProjectConnectionOptions, ProjectStore} from '../packages/business/src/project-file/index.ts';
import {projectAddressErrorDetailsSchemas} from '../packages/contracts/src/project-file.ts';
import type {ProjectInvalidReason} from '../packages/contracts/src/project-file.ts';
import type {RecentProject} from '../packages/contracts/src/project-registry.ts';
import {
  createMemoryBackgroundTaskIndex, createMemoryProjectRegistry, createProjectHostManager, projectLocation, serverAppDirectories, statProjectFileIdentity,
} from '../apps/server/src/project-host/index.ts';
import type {
  BackgroundTaskIndexPort, KernelMaintenancePort, ManagerClock, ProjectFileRecovery, ProjectHostContext, ProjectHostEvent, ProjectHostFactory,
  ProjectHostManagerOptions, ProjectHostRuntime, ProjectLease, ProjectRegistryPort, UnfinishedTask,
} from '../apps/server/src/project-host/index.ts';

// ---------------------------------------------------------------------------
// Test tools

interface ManualClock extends ManagerClock {
  /** Runs due timers in order of their due time, then sets the time. */
  advance(ms: number): void;
}
function manualClock(): ManualClock {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, {readonly at: number; readonly callback: () => void}>();
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++sequence;
      timers.set(id, {at: now + delayMs, callback});
      return id;
    },
    clearTimeout: handle => { timers.delete(handle as number); },
    advance: ms => {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
  };
}

type EventOf<Type extends ProjectHostEvent['type']> = Extract<ProjectHostEvent, {readonly type: Type}>;
function events() {
  const seen: ProjectHostEvent[] = [];
  const waiters = new Set<{readonly type: string; readonly projectId: string | undefined; readonly resolve: (event: ProjectHostEvent) => void}>();
  return {
    seen,
    onEvent: (event: ProjectHostEvent): void => {
      seen.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.type !== event.type || (waiter.projectId !== undefined && waiter.projectId !== event.projectId)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    },
    /** The first matching event after this call. */
    once: <Type extends ProjectHostEvent['type']>(type: Type, projectId?: string): Promise<EventOf<Type>> =>
      new Promise(resolve => { waiters.add({type, projectId, resolve: event => resolve(event as EventOf<Type>)}); }),
  };
}

interface FakeRuntime extends ProjectHostRuntime {
  busy: boolean;
  readonly context: ProjectHostContext;
}
interface FactoryState {
  calls: number;
  fail: Error | null;
  /** The factory waits for it before composing. */
  gate: Promise<void> | null;
  /** drain() waits for it. */
  drainGate: Promise<void> | null;
  onInterrupt: (() => void) | null;
  unfinished: readonly UnfinishedTask[];
  readonly runtimes: FakeRuntime[];
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function setup(t: TestContext, overrides: Partial<ProjectHostManagerOptions<FakeRuntime>> = {}) {
  const dataDir = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-s0-host-'));
  const directories = serverAppDirectories(dataDir);
  const log: string[] = [];
  const clock = manualClock();
  const ev = events();
  const memory = createMemoryProjectRegistry();
  const registry: ProjectRegistryPort = {...memory, upsert: entry => { log.push('registry.upsert'); memory.upsert(entry); }};
  const memoryIndex = createMemoryBackgroundTaskIndex();
  const taskIndex: BackgroundTaskIndexPort = {...memoryIndex, replace: (projectId, entries) => { log.push('taskIndex.replace'); memoryIndex.replace(projectId, entries); }};
  const opens = {count: 0};
  const openStore = (options: OpenProjectConnectionOptions): ProjectStore => {
    opens.count++;
    const store = openProjectStore(options);
    return {...store, close: () => { log.push('store.close'); store.close(); }};
  };
  const state: FactoryState = {calls: 0, fail: null, gate: null, drainGate: null, onInterrupt: null, unfinished: [], runtimes: []};
  const factory: ProjectHostFactory<FakeRuntime> = async context => {
    state.calls++;
    if (state.gate) await state.gate;
    if (state.fail) throw state.fail;
    const runtime: FakeRuntime = {
      busy: false,
      context,
      handle: async () => false,
      isBusy: () => runtime.busy,
      interrupt: () => { log.push('interrupt'); state.onInterrupt?.(); },
      drain: async () => {
        log.push('drain');
        if (state.drainGate) await state.drainGate;
      },
      dispose: () => { log.push('dispose'); },
      summarize: () => { log.push('summarize'); return null; },
      unfinishedTasks: () => { log.push('unfinishedTasks'); return state.unfinished; },
    };
    state.runtimes.push(runtime);
    return runtime;
  };
  const gates: (() => void)[] = [];
  /** A promise the test resolves; cleanup resolves it too, so a failed test never hangs. */
  const gate = (): {readonly promise: Promise<void>; readonly open: () => void} => {
    const {promise, resolve} = Promise.withResolvers<void>();
    gates.push(resolve);
    return {promise, open: resolve};
  };
  const manager = createProjectHostManager<FakeRuntime>({
    directories, registry, factory, taskIndex, clock, openStore, onEvent: ev.onEvent, idleCloseMs: 1000, drainTimeoutMs: 100, busyRecheckMs: 50, ...overrides,
  });
  t.after(async () => {
    state.gate = null;
    state.drainGate = null;
    for (const open of gates) open();
    let done = false;
    const closing = manager.closeAll().catch(() => {}).finally(() => { done = true; });
    for (let round = 0; round < 100 && !done; round++) {
      clock.advance(10_000);
      await tick();
    }
    await closing;
    rmSync(dataDir, {recursive: true, force: true});
  });
  return {dataDir, directories, log, clock, ev, registry, memory, taskIndex, opens, state, gate, manager};
}

const fields = (error: unknown) => error as {readonly code?: unknown; readonly status?: unknown; readonly details?: unknown; readonly cause?: unknown};
const registration = (projectFile: string, name: string): RecentProject => ({
  projectId: randomUUID(), projectFile, fileIdentity: statProjectFileIdentity(projectFile)!, name, lastOpenedAt: null, summary: null,
});

// ---------------------------------------------------------------------------
// Creating and opening

test('create makes the folder and the .mioon, registers it and opens nothing', async t => {
  const {dataDir, manager, registry, state} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const file = path.join(dataDir, 'projects', 'Film', 'Film.mioon');
  assert.deepEqual(registry.get(film.projectId), {
    projectId: film.projectId, projectFile: file, fileIdentity: statProjectFileIdentity(file), name: 'Film', lastOpenedAt: null, summary: null,
  });
  assert.deepEqual(readdirSync(path.dirname(file)), ['Film.mioon']);
  assert.equal(manager.status(film.projectId), null);
  assert.equal(state.calls, 0);
  assert.equal((await manager.create({name: 'Film'})).projectFile, path.join(dataDir, 'projects', 'Film 2', 'Film 2.mioon'));

  const chosenFolder = path.join(dataDir, 'chosen');
  mkdirSync(chosenFolder);
  const chosen = path.join(chosenFolder, 'X.mioon');
  assert.equal((await manager.create({name: 'Placed', projectFile: chosen})).projectFile, chosen);
  await assert.rejects(manager.create({name: 'Again', projectFile: chosen}), (error: unknown) => {
    assert.deepEqual([fields(error).code, fields(error).status, (fields(error).details as {projectFile?: unknown}).projectFile], ['PROJECT_FILE_EXISTS', 409, chosen]);
    return true;
  });
  await assert.rejects(manager.create({name: 'Nowhere', projectFile: path.join(dataDir, 'missing', 'Y.mioon')}), {code: 'PROJECT_LOCATION_INVALID', status: 400});
  await assert.rejects(manager.create({name: 'Wrong', projectFile: path.join(chosenFolder, 'Z.db')}), {code: 'VALIDATION_ERROR', status: 400});
  assert.deepEqual(readdirSync(chosenFolder), ['X.mioon']);
});

test('acquire opens a registered project, records the open and composes the runtime on its store', async t => {
  const {manager, registry, state, directories} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const lease = await manager.acquire(film.projectId, 'request');
  assert.equal(lease.host.store.historyState, 'fresh');
  assert.equal(lease.host.projectFile, film.projectFile);
  assert.ok(registry.get(film.projectId)?.lastOpenedAt);
  assert.deepEqual(manager.status(film.projectId), {projectId: film.projectId, state: 'open', paused: false, leases: {window: 0, task: 0, request: 1}});
  const [runtime] = state.runtimes;
  assert.equal(lease.host.runtime, runtime);
  assert.equal(runtime.context.projectId, film.projectId);
  assert.equal(runtime.context.store, lease.host.store);
  assert.equal(runtime.context.directories, directories);
  lease.release();
});

test('acquire maps every way a project cannot be opened', async t => {
  const {dataDir, directories, manager, memory, ev} = await setup(t);
  const unavailable = (projectId: string, reason: string, invalidReason?: ProjectInvalidReason) => (error: unknown): boolean => {
    assert.equal(fields(error).code, 'PROJECT_UNAVAILABLE');
    assert.equal(fields(error).status, 409);
    assert.deepEqual(projectAddressErrorDetailsSchemas.PROJECT_UNAVAILABLE.parse(fields(error).details),
      invalidReason === undefined ? {projectId, reason} : {projectId, reason, invalidReason});
    assert.equal(manager.status(projectId), null);
    assert.ok(ev.seen.some(event => event.type === 'open-failed' && event.projectId === projectId));
    return true;
  };

  const stranger = randomUUID();
  await assert.rejects(manager.acquire(stranger, 'request'), (error: unknown) => {
    assert.deepEqual([fields(error).code, fields(error).status], ['PROJECT_NOT_FOUND', 404]);
    assert.deepEqual(projectAddressErrorDetailsSchemas.PROJECT_NOT_FOUND.parse(fields(error).details), {projectId: stranger});
    return true;
  });

  const deleted = await manager.create({name: 'Deleted'});
  rmSync(deleted.projectFile);
  await assert.rejects(manager.acquire(deleted.projectId, 'request'),
    (error: unknown) => unavailable(deleted.projectId, 'PROJECT_MISSING')(error) && fields(fields(error).cause).code === 'PROJECT_MISSING');

  const textFile = path.join(dataDir, 'notes.mioon');
  writeFileSync(textFile, 'not a project');
  const text = registration(textFile, 'Notes');
  memory.upsert(text);
  await assert.rejects(manager.acquire(text.projectId, 'request'), unavailable(text.projectId, 'PROJECT_INVALID', 'not-a-project-file'));

  const locked = await manager.create({name: 'Locked'});
  const holder = openProjectStore({projectFile: locked.projectFile, locate: id => projectLocation(directories, id)});
  try {
    await assert.rejects(manager.acquire(locked.projectId, 'request'), unavailable(locked.projectId, 'PROJECT_LOCKED'));
  } finally {
    holder.close();
  }
  (await manager.acquire(locked.projectId, 'request')).release();

  // The registered path holds another project: no local records for that ID.
  mkdirSync(path.join(dataDir, 'other'));
  const otherFile = path.join(dataDir, 'other', 'Other.mioon');
  const otherId = createProjectFile(otherFile);
  const claimed = registration(otherFile, 'Claimed');
  memory.upsert(claimed);
  await assert.rejects(manager.acquire(claimed.projectId, 'request'), unavailable(claimed.projectId, 'PROJECT_MISSING'));
  assert.ok(!existsSync(path.join(dataDir, 'records', otherId)));

  await assert.rejects(manager.acquire('ABC', 'request'), TypeError);
});

test('a project moved while closed is found by file identity when it opens', async t => {
  const {dataDir, manager, registry} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const moved = path.join(dataDir, 'projects', 'Film moved');
  renameSync(path.dirname(film.projectFile), moved);
  const lease = await manager.acquire(film.projectId, 'window');
  const file = path.join(moved, 'Film.mioon');
  assert.equal(lease.host.store.projectFile, file);
  assert.equal(registry.get(film.projectId)?.projectFile, file);
  assert.deepEqual(registry.get(film.projectId)?.fileIdentity, film.fileIdentity);
  lease.release();
});

test('concurrent acquires open a project once and share its host', async t => {
  const {manager, state, opens, gate} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const composing = gate();
  state.gate = composing.promise;
  const pending = Promise.all([manager.acquire(film.projectId, 'request'), manager.acquire(film.projectId, 'window'), manager.acquire(film.projectId, 'task')]);
  await tick();
  assert.equal(state.calls, 1);
  assert.equal(opens.count, 1);
  assert.equal(manager.status(film.projectId)?.state, 'opening');
  composing.open();
  const leases = await pending;
  assert.equal(leases[0].host, leases[1].host);
  assert.equal(leases[1].host, leases[2].host);
  assert.deepEqual(manager.status(film.projectId)?.leases, {window: 1, task: 1, request: 1});
  for (const lease of leases) lease.release();
});

test('a failed composition closes the store and rejects every waiter with the same error', async t => {
  const {manager, state, log} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const failure = new Error('compose failed');
  state.fail = failure;
  const results = await Promise.allSettled([manager.acquire(film.projectId, 'request'), manager.acquire(film.projectId, 'window')]);
  assert.deepEqual(results.map(result => result.status === 'rejected' ? result.reason : result), [failure, failure]);
  assert.equal(manager.status(film.projectId), null);
  assert.ok(log.includes('store.close'));
  state.fail = null;
  const lease = await manager.acquire(film.projectId, 'request');
  assert.equal(manager.status(film.projectId)?.state, 'open');
  lease.release();
});

// ---------------------------------------------------------------------------
// Leases and the idle close

test('the last request starts the idle grace', async t => {
  const {manager, clock, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  (await manager.acquire(film.projectId, 'request')).release();
  clock.advance(999);
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closed = ev.once('closed', film.projectId);
  clock.advance(1);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.equal((await closed).reason, 'idle');
  assert.equal(manager.status(film.projectId), null);
});

test('releasing the window closes an idle project at once, a task lease keeps it open', async t => {
  const {manager, clock, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const closed = ev.once('closed', film.projectId);
  window.release();
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.equal((await closed).reason, 'idle');

  const again = await manager.acquire(film.projectId, 'window');
  const task = await manager.acquire(film.projectId, 'task');
  again.release();
  clock.advance(10_000);
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closedAgain = ev.once('closed', film.projectId);
  task.release();
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.equal((await closedAgain).reason, 'idle');
});

test('a request within the grace starts it again', async t => {
  const {manager, clock, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  (await manager.acquire(film.projectId, 'request')).release();
  clock.advance(600);
  (await manager.acquire(film.projectId, 'request')).release();
  clock.advance(600);
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closed = ev.once('closed', film.projectId);
  clock.advance(400);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  await closed;
  assert.equal(manager.status(film.projectId), null);
});

test('releasing the window ends the grace of requests that started before it', async t => {
  const {manager, clock, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const request = await manager.acquire(film.projectId, 'request');
  window.release();
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closed = ev.once('closed', film.projectId);
  request.release();
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  await closed;

  (await manager.acquire(film.projectId, 'request')).release();
  clock.advance(999);
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closedAgain = ev.once('closed', film.projectId);
  clock.advance(1);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  await closedAgain;
});

test('a busy runtime keeps an idle project open and is checked again', async t => {
  const {manager, clock, ev, state} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  state.runtimes[0].busy = true;
  window.release();
  assert.equal(manager.status(film.projectId)?.state, 'open');
  clock.advance(50);
  assert.equal(manager.status(film.projectId)?.state, 'open');
  state.runtimes[0].busy = false;
  const closed = ev.once('closed', film.projectId);
  clock.advance(50);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.equal((await closed).reason, 'idle');
});

test('releasing a lease twice counts once', async t => {
  const {manager} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const first = await manager.acquire(film.projectId, 'request');
  const second = await manager.acquire(film.projectId, 'request');
  first.release();
  first.release();
  assert.deepEqual(manager.status(film.projectId)?.leases, {window: 0, task: 0, request: 1});
  second.release();
  assert.deepEqual(manager.status(film.projectId)?.leases, {window: 0, task: 0, request: 0});
});

// ---------------------------------------------------------------------------
// Closing

test('close interrupts, waits for requests, revokes leases, drains, then closes the store and updates the registry', async t => {
  const {manager, state, log, ev} = await setup(t, {hooks: [{beforeClose: () => { log.push('beforeClose'); }}]});
  const film = await manager.create({name: 'Film'});
  const request = await manager.acquire(film.projectId, 'request');
  const window = await manager.acquire(film.projectId, 'window');
  window.signal.addEventListener('abort', () => { log.push('window.revoked'); });
  const seen = {abortedAtInterrupt: false};
  state.onInterrupt = () => {
    seen.abortedAtInterrupt = state.runtimes[0].context.signal.aborted;
    request.release();
    log.push('request.released');
  };
  log.length = 0;
  const closed = ev.once('closed', film.projectId);
  await manager.close(film.projectId);
  assert.deepEqual(log, [
    'interrupt', 'request.released', 'window.revoked', 'drain', 'beforeClose', 'summarize', 'unfinishedTasks', 'dispose', 'store.close',
    'registry.upsert', 'taskIndex.replace',
  ]);
  assert.equal(seen.abortedAtInterrupt, true);
  const event = await closed;
  assert.equal(event.reason, 'explicit');
  assert.deepEqual(event.errors, []);
  assert.equal(manager.status(film.projectId), null);
});

test('a forced close revokes requests that outlive the drain timeout', async t => {
  const {manager, clock} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const request = await manager.acquire(film.projectId, 'request');
  const closing = manager.close(film.projectId);
  assert.equal(request.signal.aborted, false);
  clock.advance(100);
  await closing;
  assert.equal(request.signal.aborted, true);
  request.release();
  assert.equal(manager.status(film.projectId), null);
});

test('a request during a close waits for it and reopens the project', async t => {
  const {manager, state, gate} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const draining = gate();
  state.drainGate = draining.promise;
  const closing = manager.close(film.projectId);
  const progress = {settled: false};
  const reopened = manager.acquire(film.projectId, 'request').finally(() => { progress.settled = true; });
  await tick();
  assert.equal(progress.settled, false);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  state.drainGate = null;
  draining.open();
  await closing;
  const lease = await reopened;
  assert.equal(state.calls, 2);
  assert.notEqual(lease.host, window.host);
  assert.equal(window.signal.aborted, true);
  lease.release();
});

test('a project moved while open is found by file identity when it closes', async t => {
  const {dataDir, manager, registry, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const {store} = window.host;
  store.tx(() => store.put('projects', {id: store.projectId, name: 'Film'}));
  const moved = path.join(dataDir, 'projects', 'Film moved');
  renameSync(path.dirname(film.projectFile), moved);
  // The journal moved with its folder: writes stay safe and the host stays open.
  assert.equal(manager.checkMoved(film.projectId), false);
  store.tx(() => store.put('projects', {id: store.projectId, name: 'Film, moved'}));
  assert.equal(manager.status(film.projectId)?.state, 'open');
  const closed = ev.once('closed', film.projectId);
  window.release();
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.deepEqual((await closed).errors, []);
  const file = path.join(moved, 'Film.mioon');
  assert.equal(registry.get(film.projectId)?.projectFile, file);
  assert.deepEqual(registry.get(film.projectId)?.fileIdentity, film.fileIdentity);
  const lease = await manager.acquire(film.projectId, 'request');
  assert.equal(lease.host.store.projectFile, file);
  assert.deepEqual(lease.host.store.get('projects', film.projectId), {id: film.projectId, name: 'Film, moved'});
  lease.release();
});

test('closeAll closes every host and refuses new work', async t => {
  const {manager} = await setup(t);
  const first = await manager.create({name: 'A'});
  const second = await manager.create({name: 'B'});
  await manager.acquire(first.projectId, 'window');
  await manager.acquire(second.projectId, 'task');
  await manager.closeAll();
  assert.equal(manager.status(first.projectId), null);
  assert.equal(manager.status(second.projectId), null);
  const stopped = {code: 'PROJECT_HOST_STOPPED', status: 503};
  await assert.rejects(manager.acquire(first.projectId, 'request'), stopped);
  await assert.rejects(manager.create({name: 'C'}), stopped);
  await assert.rejects(manager.withExclusive(first.projectId, () => 'x'), stopped);
  await assert.rejects(manager.openPath(first.projectFile, 'window'), stopped);
});

// ---------------------------------------------------------------------------
// Exclusive operations

test('withExclusive closes the host, holds new requests until it ends and reopens at the new path', async t => {
  const {manager, registry} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const renamed = path.join(path.dirname(film.projectFile), 'Renamed.mioon');
  const held: {lease?: Promise<ProjectLease<FakeRuntime>>; settled: boolean} = {settled: false};
  const result = await manager.withExclusive(film.projectId, async entry => {
    assert.equal(manager.status(film.projectId), null);
    assert.equal(window.signal.aborted, true);
    assert.equal(entry.projectFile, film.projectFile);
    held.lease = manager.acquire(film.projectId, 'request');
    held.lease.then(() => { held.settled = true; }, () => { held.settled = true; });
    await tick();
    assert.equal(held.settled, false);
    renameSync(film.projectFile, renamed);
    registry.upsert({...entry, projectFile: renamed, fileIdentity: statProjectFileIdentity(renamed)!});
    return 'done';
  });
  assert.equal(result, 'done');
  assert.ok(held.lease);
  const lease = await held.lease;
  assert.equal(lease.host.store.projectFile, renamed);
  assert.equal(lease.host.store.historyState, 'current');
  lease.release();
  await assert.rejects(manager.withExclusive(randomUUID(), () => 'x'), {code: 'PROJECT_NOT_FOUND', status: 404});
});

test('withExclusive reports PROJECT_HOST_BUSY when requests or work do not end, and cancels nothing', async t => {
  const {manager, clock, state} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const request = await manager.acquire(film.projectId, 'request');
  const ran = {count: 0};
  const exclusive = manager.withExclusive(film.projectId, () => { ran.count++; });
  // It awaits the previous exclusive operation first; the wait for requests starts after.
  await tick();
  assert.equal(manager.status(film.projectId)?.paused, true);
  clock.advance(100);
  await assert.rejects(exclusive, {code: 'PROJECT_HOST_BUSY', status: 409});
  assert.equal(ran.count, 0);
  assert.deepEqual(manager.status(film.projectId), {projectId: film.projectId, state: 'open', paused: false, leases: {window: 0, task: 0, request: 1}});
  assert.equal(request.signal.aborted, false);

  const window = await manager.acquire(film.projectId, 'window');
  request.release();
  state.runtimes[0].busy = true;
  await assert.rejects(manager.withExclusive(film.projectId, () => { ran.count++; }), {code: 'PROJECT_HOST_BUSY'});
  assert.equal(ran.count, 0);
  assert.equal(window.signal.aborted, false);
  state.runtimes[0].busy = false;
  window.release();
});

// ---------------------------------------------------------------------------
// Opening by path, inspection and startup

test('openPath registers a new file, reuses the open host and follows a moved file', async t => {
  const {dataDir, manager, registry, state, ev} = await setup(t);
  const looseFolder = path.join(dataDir, 'Loose');
  mkdirSync(looseFolder);
  const loose = path.join(looseFolder, 'Loose.mioon');
  const projectId = createProjectFile(loose);
  const window = await manager.openPath(loose, 'window');
  assert.equal(window.host.projectId, projectId);
  assert.deepEqual([registry.get(projectId)?.name, registry.get(projectId)?.projectFile], ['Loose', loose]);
  const again = await manager.openPath(loose, 'request');
  assert.equal(again.host, window.host);
  assert.equal(state.calls, 1);
  again.release();
  await manager.close(projectId);

  const moved = path.join(dataDir, 'Moved');
  renameSync(looseFolder, moved);
  const movedFile = path.join(moved, 'Loose.mioon');
  const reopened = await manager.openPath(movedFile, 'window');
  assert.equal(reopened.host.projectId, projectId);
  assert.deepEqual([registry.get(projectId)?.name, registry.get(projectId)?.projectFile], ['Loose', movedFile]);
  reopened.release();

  const textFile = path.join(dataDir, 'notes.mioon');
  writeFileSync(textFile, 'not a project');
  await assert.rejects(manager.openPath(textFile, 'window'), {code: 'PROJECT_INVALID', status: 422});
  assert.ok(ev.seen.some(event => event.type === 'open-failed' && event.projectId === null));
});

test('inspectProject runs synchronously on the open connection, or on the project opened alone', async t => {
  const {manager, state, gate} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const projectIdOf = (db: DatabaseSync): unknown => db.prepare('SELECT projectId FROM project.project_file').get()?.projectId;
  const lease = await manager.acquire(film.projectId, 'window');
  const seen = manager.inspectProject(film.projectId, db => ({db, projectId: projectIdOf(db)}));
  assert.equal(seen.db, lease.host.store.db);
  assert.equal(seen.projectId, film.projectId);
  assert.throws(() => manager.inspectProject(film.projectId, async () => 1), TypeError);
  assert.throws(() => manager.inspectProject(film.projectId, () => Promise.resolve(1)), TypeError);
  await manager.close(film.projectId);

  assert.equal(manager.inspectProject(film.projectId, projectIdOf), film.projectId);
  assert.equal(manager.status(film.projectId), null);
  (await manager.acquire(film.projectId, 'request')).release();
  await manager.close(film.projectId);
  assert.throws(() => manager.inspectProject(randomUUID(), () => 1), {code: 'PROJECT_NOT_FOUND'});

  const composing = gate();
  state.gate = composing.promise;
  const opening = manager.acquire(film.projectId, 'window');
  assert.equal(manager.status(film.projectId)?.state, 'opening');
  assert.throws(() => manager.inspectProject(film.projectId, () => 1), {code: 'PROJECT_HOST_TRANSITION', status: 409});
  state.gate = null;
  composing.open();
  (await opening).release();
});

/** The kernel's recoverProjectFile, recording each call: chosen results for some files, the kernel for the rest. */
function recoveryRecorder() {
  const results = new Map<string, ProjectFileRecovery>();
  const calls: string[] = [];
  const maintenance: KernelMaintenancePort = {
    recoverProjectFile: projectFile => {
      calls.push(projectFile);
      return results.get(projectFile) ?? recoverProjectFile(projectFile);
    },
  };
  return {results, calls, maintenance};
}

test('restore runs the recovery for every registered project, then reopens projects with unfinished tasks', async t => {
  const recovery = recoveryRecorder();
  const {manager, taskIndex, ev} = await setup(t, {maintenance: recovery.maintenance});
  const first = await manager.create({name: 'A'});
  const second = await manager.create({name: 'B'});
  recovery.results.set(first.projectFile, {state: 'recovered'});
  taskIndex.replace(second.projectId, [{projectId: second.projectId, projectFile: second.projectFile, kind: 'job', taskId: randomUUID(), indexedAt: new Date(0).toISOString()}]);
  const result = await manager.restore();
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.leases.map(lease => [lease.kind, lease.host.projectId]), [['task', second.projectId]]);
  assert.deepEqual(recovery.calls, [first.projectFile, second.projectFile]);
  assert.ok(ev.seen.some(event => event.type === 'recovered' && event.projectId === first.projectId));
  // Projects open here are not recovered again.
  assert.deepEqual(manager.list().map(({project, availability}) => [project.projectId, availability.state]), [[first.projectId, 'available'], [second.projectId, 'open']]);
  assert.deepEqual(recovery.calls, [first.projectFile, second.projectFile, first.projectFile]);
  assert.equal(manager.status(first.projectId), null);
  for (const lease of result.leases) lease.release();
});

test('list reports what the recovery found and moves a missing project found by file identity', async t => {
  const recovery = recoveryRecorder();
  const {dataDir, manager, registry} = await setup(t, {maintenance: recovery.maintenance});
  const open = await manager.create({name: 'Open'});
  const locked = await manager.create({name: 'Locked'});
  const readOnly = await manager.create({name: 'ReadOnly'});
  const gone = await manager.create({name: 'Gone'});
  const moved = await manager.create({name: 'Moved'});
  recovery.results.set(locked.projectFile, {state: 'locked'});
  recovery.results.set(readOnly.projectFile, {state: 'invalid', reason: 'read-only'});
  rmSync(gone.projectFile);
  const movedFolder = path.join(dataDir, 'projects', 'Moved elsewhere');
  renameSync(path.dirname(moved.projectFile), movedFolder);
  const lease = await manager.acquire(open.projectId, 'window');
  const listed = (): Record<string, unknown> => Object.fromEntries(manager.list().map(({project, availability}) => [project.name, availability]));
  assert.deepEqual(listed(), {
    Open: {state: 'open'}, Locked: {state: 'locked'}, ReadOnly: {state: 'invalid', reason: 'read-only'}, Gone: {state: 'missing'}, Moved: {state: 'missing'},
  });
  assert.ok(!recovery.calls.includes(open.projectFile));
  await tick();
  assert.equal(registry.get(moved.projectId)?.projectFile, path.join(movedFolder, 'Moved.mioon'));
  assert.equal(registry.get(gone.projectId)?.projectFile, gone.projectFile);
  assert.deepEqual(listed().Moved, {state: 'available'});
  assert.deepEqual(listed().Gone, {state: 'missing'});
  lease.release();
});

test('a .mioon renamed on its own while open is refused writes, closed and reopened where it is found', async t => {
  const {manager, registry, ev} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const {store} = window.host;
  // A write to the project file keeps its journal open under the opening path until the close.
  store.tx(() => store.put('projects', {id: store.projectId, name: 'Film'}));
  const journal = `${film.projectFile}-journal`;
  assert.ok(existsSync(journal));
  assert.equal(manager.checkMoved(film.projectId), false);
  const renamed = path.join(path.dirname(film.projectFile), 'Renamed.mioon');
  renameSync(film.projectFile, renamed);
  const closed = ev.once('closed', film.projectId);
  assert.equal(manager.checkMoved(film.projectId), true);
  assert.equal(manager.status(film.projectId)?.state, 'closing');
  assert.throws(() => store.tx(() => store.put('projects', {id: store.projectId, name: 'Again'})), {code: 'PROJECT_FILE_MOVED', status: 409});
  const event = await closed;
  assert.deepEqual([event.reason, event.errors], ['relocate', []]);
  assert.equal(window.signal.aborted, true);
  assert.equal(registry.get(film.projectId)?.projectFile, renamed);
  // SQLite removed the journal under the opening path when the store closed.
  assert.ok(!existsSync(journal));
  const lease = await manager.acquire(film.projectId, 'request');
  assert.equal(lease.host.store.projectFile, renamed);
  assert.deepEqual(lease.host.store.get('projects', film.projectId), {id: film.projectId, name: 'Film'});
  lease.release();
});

test('relocate, the way out of SQLITE_READONLY_DBMOVED, closes the host once and the next lease reopens it', async t => {
  const {manager, ev, state} = await setup(t);
  const film = await manager.create({name: 'Film'});
  const window = await manager.acquire(film.projectId, 'window');
  const closed = ev.once('closed', film.projectId);
  window.host.relocate();
  state.runtimes[0].context.relocate();
  assert.equal((await closed).reason, 'relocate');
  assert.equal(ev.seen.filter(event => event.type === 'closing').length, 1);
  const lease = await manager.acquire(film.projectId, 'request');
  assert.notEqual(lease.host, window.host);
  lease.release();
});
