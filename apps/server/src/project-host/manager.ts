/** Project host manager (docs/PROJECT-HOST.md, "项目宿主的管理器" and "生命周期和并发").
 * It never reads a project file, history.db or cache.db with fs: only the
 * kernel opens them, and the manager uses lstat and readdir around them. */
import {lstatSync, mkdirSync, rmdirSync, rmSync, statSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {isAsyncFunction, isPromise} from 'node:util/types';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {isProjectId, PROJECT_FILE_EXISTS, PROJECT_FILE_EXTENSION} from '../../../../packages/contracts/src/project-file.ts';
import type {ProjectFileIdentity, RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import {createProjectFile, openProjectStore, registerProjectTransactionFence} from '../../../../packages/business/src/project-file/index.ts';
import type {OpenProjectConnectionOptions, ProjectCopyCheck, ProjectLocation, ProjectStore} from '../../../../packages/business/src/project-file/index.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import {asProjectUnavailable, isDatabaseMovedError, projectFileExists, projectHostError, projectNotFound, projectUnavailable} from './errors.ts';
import {claimProjectFolder} from './folders.ts';
import type {
  InspectProject, ProjectHost, ProjectHostContext, ProjectHostFactory, ProjectHostRuntime, ProjectHostSummary, ProjectLease, UnfinishedTask,
} from './host.ts';
import {PROJECT_FOLDER_FALLBACK_NAME, projectFolderName} from './naming.ts';
import type {
  BackgroundTaskIndexPort, KernelMaintenancePort, ProjectFileIdentityPort, ProjectFileRecovery, ProjectLifecycleHooks, ProjectRegistryPort,
} from './ports.ts';
import {createMemoryBackgroundTaskIndex, sameProjectFileIdentity, STAT_ONLY_MAINTENANCE, statProjectFileIdentity} from './stand-ins.ts';
import {DEFAULT_BUSY_RECHECK_MS, DEFAULT_IDLE_CLOSE_MS, DEFAULT_REQUEST_DRAIN_MS, PROJECT_LEASE_KINDS} from './types.ts';
import type {ProjectAvailability, ProjectCloseReason, ProjectHostEvent, ProjectHostState, ProjectHostStatus, ProjectLeaseKind} from './types.ts';

export interface ManagerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time; timers are unref'd like index.ts's forceDrain. */
export const SYSTEM_CLOCK: ManagerClock = Object.freeze({
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): unknown => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
});

export interface ProjectHostManagerOptions<Runtime extends ProjectHostRuntime> {
  readonly directories: AppDirectories;
  readonly registry: ProjectRegistryPort;
  readonly factory: ProjectHostFactory<Runtime>;
  /** Default statProjectFileIdentity; B1's projectFileIdentity after B1. */
  readonly identity?: ProjectFileIdentityPort;
  /** S3's index; default an empty memory index. */
  readonly taskIndex?: BackgroundTaskIndexPort;
  readonly hooks?: readonly ProjectLifecycleHooks[];
  /** S0a's recoverProjectFile; default STAT_ONLY_MAINTENANCE until #106 lands. */
  readonly maintenance?: KernelMaintenancePort;
  /** Idle grace after the last request; default DEFAULT_IDLE_CLOSE_MS. */
  readonly idleCloseMs?: number;
  /** Default DEFAULT_REQUEST_DRAIN_MS. */
  readonly drainTimeoutMs?: number;
  /** Default DEFAULT_BUSY_RECHECK_MS. */
  readonly busyRecheckMs?: number;
  /** Default SYSTEM_CLOCK. */
  readonly clock?: ManagerClock;
  /** The kernel's openProjectStore; tests wrap it. */
  readonly openStore?: (options: OpenProjectConnectionOptions) => ProjectStore;
  /** Exceptions from it are ignored. */
  readonly onEvent?: (event: ProjectHostEvent) => void;
}

export interface CreateProjectInput {
  /** project.create's name, 1–150 characters. */
  readonly name: string;
  /** A chosen `.mioon`: never replaced; its folder must exist. */
  readonly projectFile?: string;
  /** Parent of the new folder; default directories.projectsDir. Ignored with projectFile. */
  readonly parentDir?: string;
  /** Tests only; must not be registered yet. */
  readonly projectId?: string;
}

export interface CreateProjectPorts {
  readonly directories: AppDirectories;
  readonly registry: ProjectRegistryPort;
  readonly identity: ProjectFileIdentityPort;
}

export interface RestoreResult<Runtime extends ProjectHostRuntime> {
  /** Task leases of the reopened projects, for S3 to release when their tasks end. */
  readonly leases: readonly ProjectLease<Runtime>[];
  readonly failures: readonly {readonly projectId: string; readonly error: unknown}[];
}

export interface ListedProject {
  readonly project: RecentProject;
  readonly availability: ProjectAvailability;
}

export interface ProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  /** Registered projects with what S0a's recovery found, opening none: every
   * registered project not open here goes through recoverProjectFile first. A
   * missing one is looked for by file identity in the background; once found
   * its registration moves, and the next list() shows the new path. */
  list(): readonly ListedProject[];
  /** Creates and registers a project file; does not open it. */
  create(input: CreateProjectInput): Promise<RecentProject>;
  /** Opens a file by path: the host of the same file (by file identity) if it
   * is open; otherwise the file is opened and registered, or its registration
   * moved to this path. Kernel errors pass through unchanged. */
  openPath(projectFile: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  /** A lease on the project's host, opening a registered project that is not
   * open. PROJECT_NOT_FOUND when not registered, PROJECT_UNAVAILABLE when it
   * cannot be opened. */
  acquire(projectId: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  /** Closes the host now, revoking its leases; requests in flight get
   * DEFAULT_REQUEST_DRAIN_MS first. Rejects with the first failed step. */
  close(projectId: string): Promise<void>;
  /** Closes every host and refuses new work with PROJECT_HOST_STOPPED. */
  closeAll(): Promise<void>;
  /** Runs an app-level operation (delete, duplicate, rename, close, save as)
   * with the project closed in this process. New requests wait; requests in
   * flight get DEFAULT_REQUEST_DRAIN_MS, then PROJECT_HOST_BUSY and nothing is
   * cancelled. `run` must not acquire the same project. */
  withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>): Promise<T>;
  /** At startup: S0a's recovery for every registered project (as list()),
   * waits for the search of missing ones, then reopens the projects in the
   * task index with a task lease. */
  restore(): Promise<RestoreResult<Runtime>>;
  /** The slot for S0a's open question (docs/PROJECT-HOST.md, "要拍板的决定"):
   * true when the open project file is no longer at the path it was opened at
   * while the journal SQLite keeps under that path is still there, that is,
   * the `.mioon` was renamed or moved without its folder. Two lstats. The host
   * then refuses writes (a transaction fence), closes, finds the file by
   * identity, and the next lease reopens it there. False when the project is
   * not open, or its folder moved with the journal. */
  checkMoved(projectId: string): boolean;
  readonly inspectProject: InspectProject;
  status(projectId: string): ProjectHostStatus | null;
}

const MAX_PROJECT_NAME_LENGTH = 150;
const invalid = (message: string): AppError => new AppError('VALIDATION_ERROR', message, 400);
const errorCode = (error: unknown): unknown => (error as {code?: unknown} | null | undefined)?.code;
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {then?: unknown}).then === 'function';
function checkProjectId(projectId: string): void {
  if (!isProjectId(projectId)) throw new TypeError('Invalid project ID');
}
function checkLeaseKind(kind: ProjectLeaseKind): void {
  if (!(PROJECT_LEASE_KINDS as readonly string[]).includes(kind)) throw new TypeError('Invalid lease kind');
}
function isDirectory(directory: string): boolean {
  let info: Stats | undefined;
  try { info = statSync(directory, {throwIfNoEntry: false}); } catch { return false; }
  return info?.isDirectory() ?? false;
}
function removeEmptyFolder(folder: string): void {
  try { rmdirSync(folder); } catch {}
}
/** At most 150 UTF-16 code units (recentProjectSchema), no character split. */
function registryName(name: string): string {
  let result = '';
  for (const character of name) {
    if (result.length + character.length > MAX_PROJECT_NAME_LENGTH) break;
    result += character;
  }
  return result;
}
/** Name of a project first registered when opened by path. */
function nameFromFile(projectFile: string): string {
  const name = path.basename(projectFile, PROJECT_FILE_EXTENSION).trim();
  return registryName(name === '' ? PROJECT_FOLDER_FALLBACK_NAME : name);
}

/** Creates the folder (unless a `.mioon` is chosen) and the project file, and
 * registers it with lastOpenedAt null; does not open it. Reused by the test
 * helper createServerProject. Without projectFile the folder is claimed by
 * claimProjectFolder; a chosen `.mioon` that exists is PROJECT_FILE_EXISTS.
 * Whatever this call created is removed again when a later step fails. */
export function createProjectFiles(input: CreateProjectInput, {directories, registry, identity}: CreateProjectPorts): RecentProject {
  const {name, projectId} = input;
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_PROJECT_NAME_LENGTH) throw invalid('项目名称无效');
  if (projectId !== undefined && registry.get(projectId)) throw invalid('项目 ID 已登记');
  const create = (file: string): string => createProjectFile(file, projectId === undefined ? {} : {projectId});
  let projectFile: string;
  let folder: string | null = null;
  let id: string;
  if (input.projectFile !== undefined) {
    const chosen = input.projectFile;
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen) || !chosen.endsWith(PROJECT_FILE_EXTENSION) || path.basename(chosen).startsWith('.')) {
      throw invalid('项目文件的位置无效');
    }
    projectFile = path.resolve(chosen);
    if (!isDirectory(path.dirname(projectFile))) throw projectHostError('PROJECT_LOCATION_INVALID', {projectFile});
    try {
      id = create(projectFile);
    } catch (error) {
      throw errorCode(error) === PROJECT_FILE_EXISTS ? projectFileExists(projectFile) : error;
    }
  } else {
    const parent = input.parentDir ?? directories.projectsDir;
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw invalid('项目位置无效');
    mkdirSync(parent, {recursive: true});
    const claimed = claimProjectFolder(path.resolve(parent), projectFolderName(name));
    folder = claimed.folder;
    projectFile = claimed.projectFile;
    try {
      id = create(projectFile);
    } catch (error) {
      removeEmptyFolder(folder);
      throw error;
    }
  }
  try {
    const fileIdentity = identity(projectFile);
    if (!fileIdentity) throw new Error('The new project file has no file identity');
    const registration: RecentProject = {projectId: id, projectFile, fileIdentity, name, lastOpenedAt: null, summary: null};
    registry.upsert(registration);
    return registration;
  } catch (error) {
    rmSync(projectFile, {force: true});
    if (folder !== null) removeEmptyFolder(folder);
    throw error;
  }
}

interface LeaseRecord {
  readonly kind: ProjectLeaseKind;
  /** Order of grants across the manager. */
  readonly seq: number;
  readonly controller: AbortController;
  released: boolean;
}

interface HostEntry<Runtime extends ProjectHostRuntime> {
  readonly projectId: string;
  readonly store: ProjectStore;
  /** Identity of the project file when it opened; it stays with the file when moved. */
  readonly identity: ProjectFileIdentity;
  readonly controller: AbortController;
  readonly context: ProjectHostContext;
  readonly leases: Set<LeaseRecord>;
  registration: RecentProject;
  state: ProjectHostState;
  /** An exclusive operation is waiting for the requests in flight. */
  paused: boolean;
  runtime: Runtime | null;
  host: ProjectHost<Runtime> | null;
  /** Settles when the runtime is composed; rejects with the open failure. */
  ready: Promise<void>;
  /** Set when the close begins; resolves when it has finished. */
  closed: Promise<void> | null;
  /** End of the idle grace; 0 when no grace runs. */
  graceUntil: number;
  /** Request leases up to this grant started before the last window closed and
   * do not start a grace when they end. */
  graceResetSeq: number;
  timer: {readonly handle: unknown} | null;
  /** A close or an exclusive operation waiting for the last request lease. */
  readonly drainWaiters: Set<() => void>;
  /** The project file moved on its own: writes are refused and the host closes. */
  relocating: boolean;
}

/** Thrown from checkCopy when opening by path meets a project in transition. */
class RetryOpen extends Error {
  readonly wait: Promise<unknown>;
  constructor(wait: Promise<unknown>) {
    super('The project is opening, closing or held by an exclusive operation');
    this.wait = wait;
  }
}

export function createProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime>(options: ProjectHostManagerOptions<Runtime>): ProjectHostManager<Runtime> {
  const {directories, registry, factory, onEvent} = options;
  const identity = options.identity ?? statProjectFileIdentity;
  const taskIndex = options.taskIndex ?? createMemoryBackgroundTaskIndex();
  const hooks = options.hooks ?? [];
  const maintenance = options.maintenance ?? STAT_ONLY_MAINTENANCE;
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_REQUEST_DRAIN_MS;
  const busyRecheckMs = options.busyRecheckMs ?? DEFAULT_BUSY_RECHECK_MS;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const openStore = options.openStore ?? openProjectStore;

  const entries = new Map<string, HostEntry<Runtime>>();
  /** Tail of each project's queue of exclusive operations. */
  const exclusive = new Map<string, Promise<void>>();
  /** What the last recovery found for each project that is not open. */
  const recoveries = new Map<string, ProjectFileRecovery>();
  /** Searches by file identity for projects the recovery found missing. */
  const searches = new Map<string, Promise<void>>();
  let stopped = false;
  let grants = 0;

  const emit = (event: ProjectHostEvent): void => {
    try { onEvent?.(event); } catch {}
  };
  const timestamp = (): string => new Date(clock.now()).toISOString();
  const locate = (projectId: string): ProjectLocation => projectLocation(directories, projectId);
  const identityOrNull = (projectFile: string): ProjectFileIdentity | null => {
    try { return identity(projectFile); } catch { return null; }
  };
  const assertRunning = (): void => {
    if (stopped) throw projectHostError('PROJECT_HOST_STOPPED');
  };
  const hasLease = (entry: HostEntry<Runtime>, kind: ProjectLeaseKind): boolean => [...entry.leases].some(lease => lease.kind === kind);
  /** Read after an await, past the narrowing of an earlier check. */
  const stateOf = (entry: HostEntry<Runtime>): ProjectHostState => entry.state;
  const isBusy = (entry: HostEntry<Runtime>): boolean => {
    try { return entry.runtime?.isBusy() ?? false; } catch { return true; }
  };
  /** Opening by registration: the file must still hold this project, so a
   * replaced file never gets local records under another project's ID. */
  const registeredCopyCheck = (projectId: string): ProjectCopyCheck => file => {
    if (file.projectId !== projectId) throw projectUnavailable(projectId, 'PROJECT_MISSING');
    registry.checkCopy?.(file);
  };
  const openRegistered = (registration: RecentProject): ProjectStore =>
    openStore({projectFile: registration.projectFile, locate, checkCopy: registeredCopyCheck(registration.projectId)});

  // -------------------------------------------------------------------------
  // Opening

  /** Takes over a store the kernel just opened, synchronously: file identity,
   * registration, then the entry in `opening` while the runtime is composed.
   * (The kernel itself removes unused super-journals on every open, S0a.) */
  function adopt(store: ProjectStore, registered: RecentProject | null): HostEntry<Runtime> {
    let entry: HostEntry<Runtime>;
    try {
      const fileIdentity = identity(store.projectFile);
      if (!fileIdentity) throw new Error('The project file has no file identity');
      const registration: RecentProject = {
        projectId: store.projectId,
        projectFile: store.projectFile,
        fileIdentity,
        name: registered?.name ?? nameFromFile(store.projectFile),
        lastOpenedAt: timestamp(),
        summary: registered?.summary ?? null,
      };
      registry.upsert(registration);
      const controller = new AbortController();
      let self: HostEntry<Runtime> | null = null;
      const context: ProjectHostContext = Object.freeze({
        projectId: store.projectId, store, directories, signal: controller.signal,
        relocate: (): void => { if (self) relocate(self); },
      });
      entry = {
        projectId: store.projectId, store, identity: fileIdentity, controller, leases: new Set(), registration, context,
        state: 'opening', paused: false, runtime: null, host: null, ready: Promise.resolve(), closed: null,
        graceUntil: 0, graceResetSeq: 0, timer: null, drainWaiters: new Set(), relocating: false,
      };
      self = entry;
    } catch (error) {
      try { store.close(); } catch {}
      throw error;
    }
    entries.set(entry.projectId, entry);
    recoveries.delete(entry.projectId);
    entry.ready = compose(entry);
    entry.ready.catch(() => {});
    return entry;
  }

  async function compose(entry: HostEntry<Runtime>): Promise<void> {
    try {
      const runtime = await factory(entry.context);
      entry.runtime = runtime;
      entry.host = Object.freeze({
        projectId: entry.projectId, projectFile: entry.store.projectFile, store: entry.store, runtime, signal: entry.controller.signal,
        relocate: entry.context.relocate,
      });
      for (const hook of hooks) await hook.afterOpen?.(entry.context);
      const summary = runtime.summarize?.() ?? null;
      if (summary) {
        entry.registration = {...entry.registration, name: summary.name, summary: summary.summary};
        registry.upsert(entry.registration);
      }
    } catch (error) {
      await discard(entry);
      emit({type: 'open-failed', projectId: entry.projectId, error});
      throw error;
    }
    entry.state = 'open';
    emit({type: 'opened', projectId: entry.projectId});
  }

  /** Undoes a failed open; no lease was granted. The entry stays until the
   * store is closed, so a retry waits instead of meeting the lock. */
  async function discard(entry: HostEntry<Runtime>): Promise<void> {
    entry.controller.abort();
    const {runtime} = entry;
    if (runtime) {
      try { runtime.interrupt(); } catch {}
      try { await runtime.drain(); } catch {}
      try { runtime.dispose(); } catch {}
    }
    try { entry.store.close(); } catch {}
    if (entries.get(entry.projectId) === entry) entries.delete(entry.projectId);
  }

  // -------------------------------------------------------------------------
  // Leases and the idle close

  function grant(entry: HostEntry<Runtime>, kind: ProjectLeaseKind): ProjectLease<Runtime> {
    clearTimer(entry);
    const record: LeaseRecord = {kind, seq: ++grants, controller: new AbortController(), released: false};
    entry.leases.add(record);
    return Object.freeze({kind, host: entry.host!, signal: record.controller.signal, release: (): void => release(entry, record)});
  }

  function release(entry: HostEntry<Runtime>, record: LeaseRecord): void {
    if (record.released) return;
    record.released = true;
    entry.leases.delete(record);
    if (record.kind === 'request') {
      if (record.seq > entry.graceResetSeq) entry.graceUntil = clock.now() + idleCloseMs;
      notifyIfDrained(entry);
    } else if (record.kind === 'window') {
      entry.graceUntil = 0;
      entry.graceResetSeq = grants;
    }
    scheduleIdle(entry);
  }

  /** Forced end of the leases of one kind, or of all. */
  function revoke(entry: HostEntry<Runtime>, kind?: ProjectLeaseKind): void {
    for (const record of [...entry.leases]) {
      if (kind !== undefined && record.kind !== kind) continue;
      record.released = true;
      entry.leases.delete(record);
      record.controller.abort();
    }
    notifyIfDrained(entry);
  }

  function notifyIfDrained(entry: HostEntry<Runtime>): void {
    if (hasLease(entry, 'request')) return;
    for (const waiter of [...entry.drainWaiters]) waiter();
  }

  function setTimer(entry: HostEntry<Runtime>, delayMs: number): void {
    const timer = {
      handle: clock.setTimeout(() => {
        if (entry.timer !== timer) return;
        entry.timer = null;
        scheduleIdle(entry);
      }, delayMs),
    };
    entry.timer = timer;
  }

  function clearTimer(entry: HostEntry<Runtime>): void {
    if (!entry.timer) return;
    clock.clearTimeout(entry.timer.handle);
    entry.timer = null;
  }

  /** Closes an open host without leases once its runtime is not busy and its
   * grace has passed; otherwise checks again when either could change. */
  function scheduleIdle(entry: HostEntry<Runtime>): void {
    if (stopped || entry.state !== 'open' || entry.paused || entry.leases.size > 0) return;
    clearTimer(entry);
    if (isBusy(entry)) {
      setTimer(entry, busyRecheckMs);
      return;
    }
    const wait = entry.graceUntil - clock.now();
    if (wait > 0) {
      setTimer(entry, wait);
      return;
    }
    void closeEntry(entry, 'idle');
  }

  /** True once no request lease is left, false after timeoutMs. The timer is
   * registered before this returns. */
  function waitForRequests(entry: HostEntry<Runtime>, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      if (!hasLease(entry, 'request')) {
        resolve(true);
        return;
      }
      const waiter = (): void => {
        entry.drainWaiters.delete(waiter);
        clock.clearTimeout(handle);
        resolve(true);
      };
      const handle = clock.setTimeout(() => {
        entry.drainWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      entry.drainWaiters.add(waiter);
    });
  }

  // -------------------------------------------------------------------------
  // Closing

  /** The close of an open host. Up to the wait for requests it runs within
   * the caller's turn. Every step's error is collected and the close goes on,
   * so a host never stays half open. */
  function closeEntry(entry: HostEntry<Runtime>, reason: ProjectCloseReason): Promise<readonly unknown[]> {
    entry.state = 'closing';
    clearTimer(entry);
    let finish: () => void = () => {};
    entry.closed = new Promise<void>(resolve => { finish = resolve; });
    emit({type: 'closing', projectId: entry.projectId, reason});
    return finishClose(entry, reason, finish);
  }

  async function finishClose(entry: HostEntry<Runtime>, reason: ProjectCloseReason, finish: () => void): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    const runtime = entry.runtime!;
    entry.controller.abort();
    try { runtime.interrupt(); } catch (error) { errors.push(error); }
    if (!(await waitForRequests(entry, drainTimeoutMs))) revoke(entry, 'request');
    revoke(entry);
    try { await runtime.drain(); } catch (error) { errors.push(error); }
    for (const hook of [...hooks].reverse()) {
      try { await hook.beforeClose?.(entry.context); } catch (error) { errors.push(error); }
    }
    let summary: ProjectHostSummary | null = null;
    try { summary = runtime.summarize?.() ?? null; } catch (error) { errors.push(error); }
    let unfinished: readonly UnfinishedTask[] | null = null;
    try { unfinished = runtime.unfinishedTasks?.() ?? null; } catch (error) { errors.push(error); }
    try { runtime.dispose(); } catch (error) { errors.push(error); }
    try { entry.store.close(); } catch (error) { errors.push(error); }
    let projectFile = entry.store.projectFile;
    try {
      const registered = registry.get(entry.projectId);
      if (registered) {
        if (!sameProjectFileIdentity(identityOrNull(projectFile), entry.identity)) {
          const found = await registry.findMoved({...registered, projectFile, fileIdentity: entry.identity});
          if (found !== null) projectFile = path.resolve(found);
        }
        registry.upsert({...registered, projectFile, fileIdentity: entry.identity, ...(summary ? {name: summary.name, summary: summary.summary} : {})});
      }
    } catch (error) {
      errors.push(error);
    }
    if (unfinished) {
      try {
        const indexedAt = timestamp();
        taskIndex.replace(entry.projectId, unfinished.map(task => ({projectId: entry.projectId, projectFile, kind: task.kind, taskId: task.taskId, indexedAt})));
      } catch (error) {
        errors.push(error);
      }
    }
    if (entries.get(entry.projectId) === entry) entries.delete(entry.projectId);
    finish();
    emit({type: 'closed', projectId: entry.projectId, reason, errors});
    return errors;
  }

  /** Closes the project's host after an open in progress; joins a close in progress. */
  async function settleAndClose(projectId: string, reason: ProjectCloseReason): Promise<readonly unknown[]> {
    for (;;) {
      const entry = entries.get(projectId);
      if (!entry) return [];
      if (entry.state === 'open') return closeEntry(entry, reason);
      if (entry.state === 'closing') {
        await entry.closed;
        return [];
      }
      try { await entry.ready; } catch { return []; }
    }
  }

  // -------------------------------------------------------------------------
  // Recovery of projects that are not open (S0a)

  /** One recovery: `recovered` is reported, `missing` starts a search by file
   * identity; `locked`, `invalid` and the rest are kept for list(). */
  function recover(registration: RecentProject): void {
    const {projectId} = registration;
    let result: ProjectFileRecovery;
    try {
      result = maintenance.recoverProjectFile(registration.projectFile);
    } catch (error) {
      recoveries.delete(projectId);
      emit({type: 'maintenance-failed', projectId, error});
      return;
    }
    recoveries.set(projectId, result);
    if (result.state === 'recovered') emit({type: 'recovered', projectId});
    if (result.state === 'missing') void search(registration);
  }

  /** Every registered project this process does not have open, once. */
  function sweep(): void {
    for (const registration of registry.list()) {
      if (entries.has(registration.projectId) || exclusive.has(registration.projectId)) continue;
      recover(registration);
    }
  }

  /** Moves the registration of a missing project to where its file identity
   * is found, then recovers it there; one search per project at a time. */
  function search(registration: RecentProject): Promise<void> {
    const {projectId} = registration;
    const running = searches.get(projectId);
    if (running) return running;
    const task = (async (): Promise<void> => {
      try {
        const found = await registry.findMoved(registration);
        const current = registry.get(projectId);
        if (found === null || !current || current.projectFile !== registration.projectFile || entries.has(projectId) || exclusive.has(projectId)) return;
        const moved: RecentProject = {...current, projectFile: path.resolve(found)};
        registry.upsert(moved);
        recover(moved);
      } catch (error) {
        emit({type: 'maintenance-failed', projectId, error});
      } finally {
        searches.delete(projectId);
      }
    })();
    searches.set(projectId, task);
    return task;
  }

  function availabilityOf(projectId: string): ProjectAvailability {
    if (entries.has(projectId)) return {state: 'open'};
    if (exclusive.has(projectId)) return {state: 'busy'};
    const result = recoveries.get(projectId);
    if (!result || result.state === 'clean' || result.state === 'recovered') return {state: 'available'};
    if (result.state === 'open-here') return {state: 'open'};
    return result.state === 'invalid' ? {state: 'invalid', reason: result.reason} : {state: result.state};
  }

  // -------------------------------------------------------------------------
  // A project file moved on its own while open (S0a)

  /** Refuses further writes, then closes; the close finds the file by
   * identity and updates the registration, so the next lease reopens it there. */
  function relocate(entry: HostEntry<Runtime>): void {
    if (entry.relocating || entries.get(entry.projectId) !== entry) return;
    entry.relocating = true;
    try {
      registerProjectTransactionFence(entry.store.db, () => { throw projectHostError('PROJECT_FILE_MOVED', {projectId: entry.projectId}); });
    } catch {}
    if (entry.state === 'open') {
      void closeEntry(entry, 'relocate');
    } else if (entry.state === 'opening') {
      entry.ready.then(() => { if (stateOf(entry) === 'open') void closeEntry(entry, 'relocate'); }, () => {});
    }
  }

  function checkMoved(projectId: string): boolean {
    const entry = entries.get(projectId);
    if (!entry || entry.state === 'closing') return false;
    const projectFile = entry.store.projectFile;
    if (sameProjectFileIdentity(identityOrNull(projectFile), entry.identity)) return false;
    let journal: Stats | undefined;
    try { journal = lstatSync(`${projectFile}-journal`, {throwIfNoEntry: false}); } catch { journal = undefined; }
    // Without the journal at the old path the folder moved with it: writes stay safe.
    if (!journal) return false;
    relocate(entry);
    return true;
  }

  // -------------------------------------------------------------------------
  // The manager

  async function acquire(projectId: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>> {
    checkProjectId(projectId);
    checkLeaseKind(kind);
    let searched = false;
    for (;;) {
      assertRunning();
      const pending = exclusive.get(projectId);
      if (pending) {
        await pending;
        continue;
      }
      const entry = entries.get(projectId);
      if (entry) {
        if (entry.state === 'open') return grant(entry, kind);
        await (entry.state === 'opening' ? entry.ready : entry.closed);
        continue;
      }
      const registration = registry.get(projectId);
      if (!registration) throw projectNotFound(projectId);
      try {
        adopt(openRegistered(registration), registration);
        continue;
      } catch (error) {
        // Not at its path, or moved while the kernel opened it (S0a: PROJECT_INVALID caused by 1032).
        if (!searched && (errorCode(error) === 'PROJECT_MISSING' || isDatabaseMovedError(error))) {
          searched = true;
          const found = await registry.findMoved(registration);
          if (found !== null && path.resolve(found) !== registration.projectFile) {
            registry.upsert({...registration, projectFile: path.resolve(found)});
            continue;
          }
        }
        const failure = asProjectUnavailable(projectId, error);
        emit({type: 'open-failed', projectId, error: failure});
        throw failure;
      }
    }
  }

  /** What an open by path waits for: an exclusive operation, an open or a close of this project ID. */
  function transition(projectId: string): Promise<unknown> | null {
    const pending = exclusive.get(projectId);
    if (pending) return pending;
    const entry = entries.get(projectId);
    if (entry?.state === 'opening') return entry.ready.catch(() => {});
    if (entry?.state === 'closing') return entry.closed;
    return null;
  }

  async function openPath(projectFile: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>> {
    if (typeof projectFile !== 'string' || !path.isAbsolute(projectFile)) throw new TypeError('Project file must be an absolute path');
    checkLeaseKind(kind);
    const file = path.resolve(projectFile);
    for (;;) {
      assertRunning();
      const fileIdentity = identityOrNull(file);
      const held = fileIdentity ? [...entries.values()].find(entry => sameProjectFileIdentity(entry.identity, fileIdentity)) : undefined;
      if (held) return acquire(held.projectId, kind);
      let store: ProjectStore;
      try {
        store = openStore({
          projectFile: file, locate,
          checkCopy: candidate => {
            const wait = transition(candidate.projectId);
            if (wait) throw new RetryOpen(wait);
            registry.checkCopy?.(candidate);
          },
        });
      } catch (error) {
        if (error instanceof RetryOpen) {
          await error.wait;
          continue;
        }
        emit({type: 'open-failed', projectId: null, error});
        throw error;
      }
      try {
        adopt(store, registry.get(store.projectId));
      } catch (error) {
        emit({type: 'open-failed', projectId: store.projectId, error});
        throw error;
      }
      return acquire(store.projectId, kind);
    }
  }

  async function create(input: CreateProjectInput): Promise<RecentProject> {
    assertRunning();
    return createProjectFiles(input, {directories, registry, identity});
  }

  async function close(projectId: string): Promise<void> {
    const errors = await settleAndClose(projectId, 'explicit');
    if (errors.length > 0) throw errors[0];
  }

  async function closeAll(): Promise<void> {
    stopped = true;
    for (const entry of entries.values()) clearTimer(entry);
    const results = await Promise.all([...entries.keys()].map(projectId => settleAndClose(projectId, 'shutdown')));
    await Promise.all([...exclusive.values()]);
    const errors = results.flat();
    if (errors.length > 0) throw errors[0];
  }

  async function withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>): Promise<T> {
    checkProjectId(projectId);
    assertRunning();
    const previous = exclusive.get(projectId) ?? Promise.resolve();
    let finish: () => void = () => {};
    const mine = new Promise<void>(resolve => { finish = resolve; });
    const tail = previous.then(() => mine);
    exclusive.set(projectId, tail);
    try {
      await previous;
      assertRunning();
      let entry = entries.get(projectId);
      if (entry?.state === 'opening') {
        try { await entry.ready; } catch {}
        entry = entries.get(projectId);
      }
      if (entry?.state === 'closing') {
        await entry.closed;
        entry = entries.get(projectId);
      }
      if (entry?.state === 'open') {
        const paused = entry;
        paused.paused = true;
        clearTimer(paused);
        const drained = await waitForRequests(paused, drainTimeoutMs);
        paused.paused = false;
        if (stateOf(paused) === 'open') {
          if (!drained || hasLease(paused, 'request') || isBusy(paused)) {
            scheduleIdle(paused);
            throw projectHostError('PROJECT_HOST_BUSY', {projectId});
          }
          const errors = await closeEntry(paused, 'exclusive');
          if (errors.length > 0) throw errors[0];
        } else {
          // Closed meanwhile by close() or closeAll().
          await paused.closed;
          assertRunning();
        }
      }
      const registration = registry.get(projectId);
      if (!registration) throw projectNotFound(projectId);
      return await run(registration);
    } finally {
      finish();
      if (exclusive.get(projectId) === tail) exclusive.delete(projectId);
    }
  }

  async function restore(): Promise<RestoreResult<Runtime>> {
    sweep();
    await Promise.all([...searches.values()]);
    const leases: ProjectLease<Runtime>[] = [];
    const failures: {readonly projectId: string; readonly error: unknown}[] = [];
    for (const projectId of new Set(taskIndex.list().map(entry => entry.projectId))) {
      try {
        leases.push(await acquire(projectId, 'task'));
      } catch (error) {
        failures.push({projectId, error});
      }
    }
    return {leases, failures};
  }

  function list(): readonly ListedProject[] {
    sweep();
    return registry.list().map(project => Object.freeze({project, availability: availabilityOf(project.projectId)}));
  }

  /** A thenable result means the callback kept working past this call. */
  function synchronousResult<T>(result: T): T {
    if (isThenable(result)) {
      if (isPromise(result)) Promise.resolve(result).catch(() => {});
      throw new TypeError('Inspection requires a synchronous callback');
    }
    return result;
  }

  const inspectProject: InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T): T => {
    if (typeof inspect !== 'function' || isAsyncFunction(inspect)) throw new TypeError('Inspection requires a synchronous callback');
    checkProjectId(projectId);
    const entry = entries.get(projectId);
    if (exclusive.has(projectId) || (entry && entry.state !== 'open')) throw projectHostError('PROJECT_HOST_TRANSITION', {projectId});
    if (entry) return synchronousResult(inspect(entry.store.db));
    const registration = registry.get(projectId);
    if (!registration) throw projectNotFound(projectId);
    let store: ProjectStore;
    try {
      store = openRegistered(registration);
    } catch (error) {
      throw asProjectUnavailable(projectId, error);
    }
    try {
      return synchronousResult(inspect(store.db));
    } finally {
      store.close();
    }
  };

  function status(projectId: string): ProjectHostStatus | null {
    const entry = entries.get(projectId);
    if (!entry) return null;
    const leases: Record<ProjectLeaseKind, number> = {window: 0, task: 0, request: 0};
    for (const lease of entry.leases) leases[lease.kind]++;
    return Object.freeze({projectId, state: entry.state, paused: entry.paused, leases: Object.freeze(leases)});
  }

  return Object.freeze({list, create, openPath, acquire, close, closeAll, withExclusive, restore, checkMoved, inspectProject, status});
}
