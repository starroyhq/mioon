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
import {PROJECT_NAME_MAX_LENGTH, projectNameProblem} from '../../../../packages/contracts/src/project-name.ts';
import type {ProjectFileIdentity, RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import {createProjectFile, FORMAT4_PROJECT_SCHEMA_VERSION, openProjectStore, PROJECT_FILE_SCHEMA_VERSION, recoverProjectFile, registerProjectTransactionFence} from '../../../../packages/business/src/project-file/index.ts';
import type {CreateProjectFileOptions, OpenProjectConnectionOptions, ProjectCopyCheck, ProjectLocation, ProjectStore} from '../../../../packages/business/src/project-file/index.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import {
  asProjectUnavailable, isDatabaseMovedError, projectFileExists, projectFileMoved, projectHostError, projectNotFound, projectUnavailable,
} from './errors.ts';
import {claimProjectFolder} from './folders.ts';
import type {
  InspectProject, ProjectHost, ProjectHostContext, ProjectHostFactory, ProjectHostRuntime, ProjectHostSummary, ProjectLease, UnfinishedTask,
} from './host.ts';
import {ProjectHostCleanupError} from './host.ts';
import {PROJECT_FOLDER_FALLBACK_NAME, projectFolderName} from './naming.ts';
import type {
  BackgroundTaskIndexPort, KernelMaintenancePort, ProjectFileIdentityPort, ProjectFileRecovery, ProjectLifecycleHooks, ProjectRegistryPort,
} from './ports.ts';
import {createMemoryBackgroundTaskIndex, sameProjectFileIdentity, statProjectFileIdentity} from './stand-ins.ts';
import {DEFAULT_BUSY_RECHECK_MS, DEFAULT_IDLE_CLOSE_MS, DEFAULT_REQUEST_DRAIN_MS, PROJECT_LEASE_KINDS} from './types.ts';
import type {ProjectAvailability, ProjectCloseReason, ProjectHostEvent, ProjectHostState, ProjectHostStatus, ProjectLeaseKind} from './types.ts';
import {createProjectHistorySession, projectHistoryRequired} from './history-session.ts';
import type {ProjectHistorySession} from './history-session.ts';
import {completedHistoryResolution, prepareHistorySwitch, recoverHistorySwitch} from '../../../../packages/business/src/project-file/history-switch.ts';
import type {HistorySwitchBoundary} from '../../../../packages/business/src/project-file/history-switch.ts';
import {projectHistoryResolveSchema} from '../../../../packages/contracts/src/project-history-recovery.ts';
import type {ProjectHistoryResolveInput, ProjectHistoryResolveResult} from '../../../../packages/contracts/src/project-history-recovery.ts';
import {archivedBackgroundHistorySource, currentBackgroundHistorySource} from './background-history.ts';

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
  /** Default: the kernel's recoverProjectFile (S0a). */
  readonly maintenance?: KernelMaintenancePort;
  /** One synchronous private-file snapshot for a recovery sweep. Later
   * asynchronous moved-file searches take a fresh snapshot themselves. */
  readonly recoverySnapshot?: (recover: () => void) => void;
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
  /** Captures the exact application owner and lifecycle signal. */
  readonly assertMutationAllowed?: () => void;
  /** Trusted crash injection, never configured from HTTP or environment. */
  readonly historySwitchBoundary?: (boundary: HistorySwitchBoundary) => void;
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

type RecoveryResult = ProjectFileRecovery | {readonly state: 'invalid'; readonly reason: 'format-newer'};
export type CatalogRecovery = {readonly result: RecoveryResult} | {readonly error: unknown} | {readonly pending: true};
type InspectCatalog = (projects: readonly RecentProject[], isCurrent: (project: RecentProject) => boolean) => Promise<ReadonlyMap<string, CatalogRecovery>>;

export interface ProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  /** Registered projects with what S0a's recovery found, opening none: every
   * registered project not open here goes through recoverProjectFile first. A
   * missing one is looked for by file identity in the background; once found
   * its registration moves, and the next list() shows the new path. */
  list(): readonly ListedProject[];
  /** Supplies closed-file observations asynchronously; open and exclusive
   * projects always use the live host state. */
  listForCatalog(inspect: InspectCatalog): Promise<readonly ListedProject[]>;
  /** Creates and registers a project file; does not open it. */
  create(input: CreateProjectInput): Promise<RecentProject>;
  /** Opens a file by path: the host of the same file (by file identity) if it
   * is open; otherwise the file is opened and registered, or its registration
   * moved to this path. Kernel errors pass through unchanged. */
  openPath(projectFile: string, kind: ProjectLeaseKind, options?: {readonly deferRecent?: true}): Promise<ProjectLease<Runtime>>;
  /** Resolves the registered file by identity using metadata only, before a
   * trusted desktop caller admits its current location. Opens no database. */
  prepareAcquire(projectId: string): Promise<RecentProject>;
  /** A lease on the project's host, opening a registered project that is not
   * open. PROJECT_NOT_FOUND when not registered, PROJECT_UNAVAILABLE when it
   * cannot be opened. */
  acquire(projectId: string, kind: ProjectLeaseKind, admission?: {readonly projectFile?: string; readonly deferRecent?: true}): Promise<ProjectLease<Runtime>>;
  markWindowOpened(lease: ProjectLease<Runtime>): string | null;
  /** Synchronously borrows only an already-open, unpaused host. Never waits
   * for an exclusive operation or opens a project for an application read. */
  tryAcquireOpen(projectId: string, kind: ProjectLeaseKind): ProjectLease<Runtime> | null;
  /** Closes the host now, revoking its leases; requests in flight get
   * DEFAULT_REQUEST_DRAIN_MS first. Rejects with the first failed step. */
  close(projectId: string): Promise<void>;
  /** Closes every host and refuses new work with PROJECT_HOST_STOPPED. */
  closeAll(): Promise<void>;
  /** Runs an app-level operation (delete, duplicate, rename, close, save as)
   * with the project closed in this process. New requests wait; requests in
   * flight get DEFAULT_REQUEST_DRAIN_MS, then PROJECT_HOST_BUSY and nothing is
   * cancelled. `run` must not acquire the same project. */
  withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>, options?: {readonly rejectWindowLeases?: boolean; readonly assertCanClose?: (host: ProjectHost<Runtime>) => void}): Promise<T>;
  /** At startup: S0a's recovery for every registered project (as list()),
   * waits for the search of missing ones, then reopens the projects in the
   * task index with a task lease. */
  restore(): Promise<RestoreResult<Runtime>>;
  readonly inspectProject: InspectProject;
  status(projectId: string): ProjectHostStatus | null;
  /** No request lease may be held by the caller: it closes the recovery
   * session under exclusivity before the staged history is attached. */
  resolveHistory(input: ProjectHistoryResolveInput): Promise<ProjectHistoryResolveResult>;
}

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
    if (result.length + character.length > PROJECT_NAME_MAX_LENGTH) break;
    result += character;
  }
  return result;
}
/** Name of a project first registered when opened by path. */
function nameFromFile(projectFile: string): string {
  const name = path.basename(projectFile, PROJECT_FILE_EXTENSION).trim();
  return registryName(name === '' ? PROJECT_FOLDER_FALLBACK_NAME : name);
}

const projectCreationOptions: Pick<CreateProjectFileOptions, 'format4'> = Object.freeze({});
export const newProjectFormatVersion = projectCreationOptions.format4 ? FORMAT4_PROJECT_SCHEMA_VERSION : PROJECT_FILE_SCHEMA_VERSION;

/** Creates the folder (unless a `.mioon` is chosen) and the project file, and
 * registers it with lastOpenedAt null; does not open it. Reused by the test
 * helper createServerProject. Without projectFile the folder is claimed by
 * claimProjectFolder; a chosen `.mioon` that exists is PROJECT_FILE_EXISTS.
 * Whatever this call created is removed again when a later step fails. */
export function createProjectFiles(input: CreateProjectInput, {directories, registry, identity}: CreateProjectPorts): RecentProject {
  const {name, projectId} = input;
  if (typeof name !== 'string' || projectNameProblem(name) !== null) throw invalid('项目名称无效');
  if (projectId !== undefined && registry.get(projectId)) throw invalid('项目 ID 已登记');
  registry.assertCanRegister?.();
  const create = (file: string): string => createProjectFile(file, {...projectCreationOptions, projectId});
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
  recovery: ProjectHistorySession | null;
  host: ProjectHost<Runtime> | null;
  /** Settles when the runtime is composed; rejects with the open failure. */
  ready: Promise<void>;
  /** Set when the close begins; resolves when it has finished. */
  closed: Promise<void> | null;
  closeFailure?: unknown;
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
  const maintenance: KernelMaintenancePort = options.maintenance ?? {recoverProjectFile};
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_REQUEST_DRAIN_MS;
  const busyRecheckMs = options.busyRecheckMs ?? DEFAULT_BUSY_RECHECK_MS;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const openStore = options.openStore ?? openProjectStore;

  const entries = new Map<string, HostEntry<Runtime>>();
  /** Tail of each project's queue of exclusive operations. */
  const exclusive = new Map<string, Promise<void>>();
  /** What the last recovery found for each project that is not open. */
  const recoveries = new Map<string, {registration: RecentProject; result: RecoveryResult | {readonly state: 'busy'}}>();
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
  const writeAllowed = (): void => {
    assertRunning();
    if (!options.assertMutationAllowed) throw new TypeError('History resolution requires application write admission');
    options.assertMutationAllowed();
  };
  const switchOptions = (projectFile: string, projectId: string) => ({projectFile, location: locate(projectId), assertMutationAllowed: writeAllowed, onBoundary: options.historySwitchBoundary});
  const openRegistered = (registration: RecentProject): ProjectStore => {
    recoverHistorySwitch(switchOptions(registration.projectFile, registration.projectId));
    return openStore({projectFile: registration.projectFile, locate, checkCopy: registeredCopyCheck(registration.projectId)});
  };

  // -------------------------------------------------------------------------
  // Opening

  /** Takes over a store the kernel just opened, synchronously: file identity,
   * registration, then the entry in `opening` while the runtime is composed.
   * (The kernel itself removes unused super-journals on every open, S0a.) */
  function adopt(store: ProjectStore, registered: RecentProject | null, deferRecent = false): HostEntry<Runtime> {
    let entry: HostEntry<Runtime>;
    try {
      const fileIdentity = identity(store.projectFile);
      if (!fileIdentity) throw new Error('The project file has no file identity');
      const registration: RecentProject = {
        projectId: store.projectId,
        projectFile: store.projectFile,
        fileIdentity,
        name: registered?.name ?? nameFromFile(store.projectFile),
        lastOpenedAt: registered?.lastOpenedAt ?? null,
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
        state: 'opening', paused: false, runtime: null, recovery: null, host: null, ready: Promise.resolve(), closed: null,
        graceUntil: 0, graceResetSeq: 0, timer: null, drainWaiters: new Set(), relocating: false,
      };
      self = entry;
    } catch (error) {
      try { store.close(); } catch {}
      throw error;
    }
    entries.set(entry.projectId, entry);
    recoveries.delete(entry.projectId);
    entry.ready = compose(entry, deferRecent);
    entry.ready.catch(() => {});
    return entry;
  }

  async function compose(entry: HostEntry<Runtime>, deferRecent: boolean): Promise<void> {
    try {
      // Admission precedes ensureProjectRow, service constructors, Mio
      // recovery, worker startup and every afterOpen hook (including daily).
      if (entry.store.historyState === 'diverged') entry.recovery = createProjectHistorySession(entry.context, options.assertMutationAllowed);
      else entry.runtime = await factory(entry.context);
      entry.host = Object.freeze({
        projectId: entry.projectId, projectFile: entry.store.projectFile, store: entry.store, signal: entry.controller.signal,
        get runtime(): Runtime { if (!entry.runtime) throw projectHistoryRequired(); return entry.runtime; },
        ...(entry.recovery ? {recovery: entry.recovery} : {}),
        relocate: entry.context.relocate,
      });
      // A recovery session has not normally opened the project yet. Preserve
      // its previous recency until resolution and successful runtime startup.
      if (!entry.recovery) {
        const readiness = Object.freeze({host: entry.host!, retainTask: (): ProjectLease<Runtime> => {
          if (entry.state !== 'opening' || entry.controller.signal.aborted || entries.get(entry.projectId) !== entry) {
            throw projectHostError('PROJECT_HOST_TRANSITION', {projectId: entry.projectId});
          }
          return grant(entry, 'task');
        }});
        for (const hook of hooks) await hook.afterOpen?.(entry.context, readiness);
        // Older embedders have no S3 hook. Activation is idempotent; production
        // performs it explicitly between the open backup and daily version.
        entry.runtime?.activateBackground?.();
        const summary = entry.runtime?.summarize?.() ?? null;
        // Identity registration is needed before composing, but a failed open
        // must not become the most recently opened project.
        const current = registry.get(entry.projectId);
        if (!current || current.projectFile !== entry.registration.projectFile
          || !sameProjectFileIdentity(current.fileIdentity, entry.identity)) throw projectFileMoved(entry.projectId);
        const registration: RecentProject = {
          ...entry.registration, ...(summary ? {name: summary.name, summary: summary.summary} : {}),
          lastOpenedAt: deferRecent ? current.lastOpenedAt : timestamp(),
        };
        registry.upsert(registration);
        entry.registration = registration;
      }
    } catch (error) {
      if (error instanceof ProjectHostCleanupError) {
        entry.closeFailure = error;
        entry.state = 'closing';
        entry.closed = Promise.resolve();
      } else await discard(entry, error);
      emit({type: 'open-failed', projectId: entry.projectId, error});
      throw error;
    }
    entry.state = 'open';
    emit({type: 'opened', projectId: entry.projectId});
  }

  /** Undoes a failed open; no lease was granted. The entry stays until the
   * store is closed, so a retry waits instead of meeting the lock. */
  async function discard(entry: HostEntry<Runtime>, openingError: unknown): Promise<void> {
    entry.controller.abort();
    const {runtime} = entry;
    if (runtime) {
      try { runtime.interrupt(); } catch {}
      try { await runtime.drain(); } catch (error) {
        const failure = new ProjectHostCleanupError([openingError, error], 'Failed project opening could not drain safely');
        entry.closeFailure = failure; entry.state = 'closing'; entry.closed = Promise.resolve();
        throw failure;
      }
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

  function markWindowOpened(lease: ProjectLease<Runtime>): string | null {
    assertRunning();
    const projectId = lease.host.projectId, entry = entries.get(projectId);
    if (!entry || entry.state !== 'open' || entry.paused || entry.relocating || entry.host !== lease.host ||
        ![...entry.leases].some(record => record.kind === 'window' && record.controller.signal === lease.signal && !record.released))
      throw projectHostError('PROJECT_HOST_TRANSITION', {projectId});
    if (entry.recovery) return null;
    const current = registry.get(projectId);
    const selectedIdentity = current && identityOrNull(current.projectFile);
    if (!current || current.projectFile !== entry.registration.projectFile ||
        !sameProjectFileIdentity(current.fileIdentity, entry.identity) ||
        !selectedIdentity || !sameProjectFileIdentity(selectedIdentity, entry.identity)) throw projectFileMoved(projectId);
    const updated = {...current, lastOpenedAt: timestamp()};
    registry.upsert(updated);
    entry.registration = updated;
    return updated.lastOpenedAt;
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
    const runtime = entry.runtime;
    entry.controller.abort();
    try { runtime?.interrupt(); } catch (error) { errors.push(error); }
    if (!(await waitForRequests(entry, drainTimeoutMs))) revoke(entry, 'request');
    revoke(entry);
    try { await runtime?.drain(); } catch (error) {
      // No verified drain means late publishers may still own this database.
      // Keep the closing slot and lock; subsequent work reports the failure.
      entry.closeFailure = error;
      errors.push(error); finish(); return errors;
    }
    for (const hook of entry.recovery ? [] : [...hooks].reverse()) {
      try { await hook.beforeClose?.(entry.context); } catch (error) { errors.push(error); }
    }
    let summary: ProjectHostSummary | null = null;
    try { summary = runtime?.summarize?.() ?? null; } catch (error) { errors.push(error); }
    let unfinished: readonly UnfinishedTask[] | null = null;
    try { unfinished = runtime?.unfinishedTasks?.() ?? null; } catch (error) { errors.push(error); }
    try { runtime?.dispose(); } catch (error) { errors.push(error); }
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
        const previous = taskIndex.listProject?.(entry.projectId) ?? taskIndex.list().filter(task => task.projectId === entry.projectId);
        taskIndex.replace(entry.projectId, unfinished.map(task => {
          const matching = previous.filter(value => value.kind === task.kind && value.taskId === task.taskId);
          const old = matching.find(value => value.sourceHistory === task.sourceHistory)
            ?? matching.find(value => value.sourceHistory == null && value.phase !== 'archived');
          const unavailable = reason === 'relocate';
          return {projectId: entry.projectId, projectFile, kind: task.kind, taskId: task.taskId, indexedAt: old?.indexedAt ?? indexedAt,
            ...(task.phase === undefined ? {} : {phase: unavailable ? 'blocked' as const : task.phase}),
            ...(task.reason === undefined ? {} : {reason: unavailable ? old?.reason ?? 'PROJECT_FILE_MOVED' : task.reason}),
            ...(task.sourceHistory === undefined ? {} : {sourceHistory: task.sourceHistory}),
            ...(task.taskRevision === undefined ? {} : {taskRevision: task.taskRevision}),
            ...(old?.revision === undefined ? {} : {revision: old.revision + 1})};
        }));
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
        return entry.closeFailure === undefined ? [] : [entry.closeFailure];
      }
      try { await entry.ready; } catch { return entry.closeFailure === undefined ? [] : [entry.closeFailure]; }
    }
  }

  // -------------------------------------------------------------------------
  // Recovery of projects that are not open (S0a)

  /** One recovery: `recovered` is reported, `missing` starts a search by file
   * identity; `locked`, `invalid` and the rest are kept for list(). */
  function recover(registration: RecentProject): void {
    let observed: CatalogRecovery;
    try { observed = {result: maintenance.recoverProjectFile(registration.projectFile)}; }
    catch (error) { observed = {error}; }
    recordRecovery(registration, observed);
  }

  function recordRecovery(registration: RecentProject, observed: CatalogRecovery | undefined, inspect?: InspectCatalog): void {
    const {projectId} = registration;
    const previous = recoveries.get(projectId);
    const wasLocked = previous?.result.state === 'locked' && sameRegistration(previous.registration, registration);
    if (!observed) {
      if (!wasLocked) recoveries.delete(projectId);
      return;
    }
    if ('pending' in observed) {
      if (!wasLocked) recoveries.set(projectId, {registration, result: {state: 'busy'}});
      return;
    }
    if ('error' in observed) {
      const {error} = observed;
      const code = errorCode(error);
      if (code === 'PROJECT_FORMAT_NEWER') {
        recoveries.set(projectId, {registration, result: {state: 'invalid', reason: 'format-newer'}});
        return;
      }
      if (code === 'PROJECT_ACCESS_DENIED' || code === 'EACCES' || code === 'EPERM') recoveries.set(projectId, {registration, result: {state: 'access-denied'}});
      else recoveries.delete(projectId);
      emit({type: 'maintenance-failed', projectId, error});
      return;
    }
    const {result} = observed;
    recoveries.set(projectId, {registration, result});
    if (result.state === 'recovered') emit({type: 'recovered', projectId});
    if (result.state === 'missing') void search(registration, inspect);
  }

  /** Every registered project this process does not have open, once. */
  function sweep(): void {
    const recoverAll = (): void => {
      for (const registration of registry.list()) {
        if (entries.has(registration.projectId) || exclusive.has(registration.projectId)) continue;
        recover(registration);
      }
    };
    if (options.recoverySnapshot) options.recoverySnapshot(recoverAll);
    else recoverAll();
  }

  /** Moves the registration of a missing project to where its file identity
   * is found, then recovers it there; one search per project at a time. */
  const closed = (projectId: string): boolean => !entries.has(projectId) && !exclusive.has(projectId);
  const sameRegistration = (left: RecentProject, right: RecentProject): boolean =>
    left.projectFile === right.projectFile && left.fileIdentity.dev === right.fileIdentity.dev && left.fileIdentity.ino === right.fileIdentity.ino;
  const isCurrent = (registration: RecentProject): boolean => {
    if (stopped || !closed(registration.projectId)) return false;
    const current = registry.get(registration.projectId);
    return current !== null && sameRegistration(current, registration);
  };

  function search(registration: RecentProject, inspect?: InspectCatalog): Promise<void> {
    const {projectId} = registration;
    const running = searches.get(projectId);
    if (running) return running;
    const task = (async (): Promise<void> => {
      try {
        const found = await registry.findMoved(registration);
        const current = registry.get(projectId);
        if (stopped || found === null || !current || !sameRegistration(current, registration) || !closed(projectId)) return;
        const moved: RecentProject = {...current, projectFile: path.resolve(found)};
        registry.upsert(moved);
        if (!inspect) recover(moved);
        else {
          const observed = (await inspect([moved], isCurrent)).get(projectId);
          const latest = registry.get(projectId);
          if (!stopped && latest && sameRegistration(latest, moved) && closed(projectId)) recordRecovery(latest, observed, inspect);
        }
      } catch (error) {
        emit({type: 'maintenance-failed', projectId, error});
      } finally {
        searches.delete(projectId);
      }
    })();
    searches.set(projectId, task);
    return task;
  }

  function availabilityOf(project: RecentProject): ProjectAvailability {
    const {projectId} = project;
    if (entries.has(projectId)) return {state: 'open'};
    if (exclusive.has(projectId)) return {state: 'busy'};
    const observation = recoveries.get(projectId);
    const result = observation && sameRegistration(observation.registration, project) ? observation.result : undefined;
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
      registerProjectTransactionFence(entry.store.db, () => { throw projectFileMoved(entry.projectId); });
    } catch {}
    if (entry.state === 'open') {
      void closeEntry(entry, 'relocate');
    } else if (entry.state === 'opening') {
      entry.ready.then(() => { if (stateOf(entry) === 'open') void closeEntry(entry, 'relocate'); }, () => {});
    }
  }

  // -------------------------------------------------------------------------
  // The manager

  async function prepareAcquire(projectId: string): Promise<RecentProject> {
    checkProjectId(projectId);
    const readIdentity = (projectFile: string): ProjectFileIdentity | null => {
      try {return identity(projectFile);}
      catch (error) {
        if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
          throw new AppError('PROJECT_ACCESS_DENIED', '没有权限访问项目位置，请检查系统权限后重试', 403, {projectId});
        }
        throw error;
      }
    };
    for (;;) {
      assertRunning();
      const pending = exclusive.get(projectId);
      if (pending) {await pending; continue;}
      const registration = registry.get(projectId);
      if (!registration) throw projectNotFound(projectId);
      if (sameProjectFileIdentity(readIdentity(registration.projectFile), registration.fileIdentity)) return registration;
      let found: string | null;
      try {found = await registry.findMoved(registration);}
      catch (error) {
        if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
          throw new AppError('PROJECT_ACCESS_DENIED', '没有权限访问项目位置，请检查系统权限后重试', 403, {projectId});
        }
        throw error;
      }
      assertRunning();
      const current = registry.get(projectId);
      if (exclusive.has(projectId) || !current || current.projectFile !== registration.projectFile
        || !sameProjectFileIdentity(current.fileIdentity, registration.fileIdentity)) continue;
      if (found === null) throw projectUnavailable(projectId, 'PROJECT_MISSING');
      const projectFile = path.resolve(found);
      if (!sameProjectFileIdentity(readIdentity(projectFile), current.fileIdentity)) throw projectUnavailable(projectId, 'PROJECT_MISSING');
      // Only the registry moves here. Recovery and project/history/cache opens
      // remain behind the desktop's location admission and acquire().
      const moved: RecentProject = {...current, projectFile};
      registry.upsert(moved);
      return moved;
    }
  }

  async function acquire(projectId: string, kind: ProjectLeaseKind, admission?: {readonly projectFile?: string; readonly deferRecent?: true}): Promise<ProjectLease<Runtime>> {
    checkProjectId(projectId);
    checkLeaseKind(kind);
    const pinned = admission?.projectFile;
    if (pinned !== undefined && (!path.isAbsolute(pinned) || path.resolve(pinned) !== pinned)) throw new TypeError('Invalid admitted project path');
    let searched = false;
    for (;;) {
      assertRunning();
      // Re-read after every asynchronous wait: a location approved for one
      // path never authorizes a moved registration or an old open host.
      if (pinned !== undefined && registry.get(projectId)?.projectFile !== pinned) throw projectFileMoved(projectId);
      const pending = exclusive.get(projectId);
      if (pending) {
        await pending;
        continue;
      }
      const entry = entries.get(projectId);
      if (entry) {
        if (pinned !== undefined && entry.store.projectFile !== pinned) throw projectFileMoved(projectId);
        if (entry.closeFailure !== undefined) throw entry.closeFailure;
        if (entry.state === 'open') return grant(entry, kind);
        await (entry.state === 'opening' ? entry.ready : entry.closed);
        continue;
      }
      const registration = registry.get(projectId);
      if (!registration) throw projectNotFound(projectId);
      try {
        adopt(openRegistered(registration), registration, kind === 'window' && admission?.deferRecent === true);
        continue;
      } catch (error) {
        // Not at its path, or moved while the kernel opened it (S0a: PROJECT_INVALID caused by 1032).
        if (pinned === undefined && !searched && (errorCode(error) === 'PROJECT_MISSING' || isDatabaseMovedError(error))) {
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

  function tryAcquireOpen(projectId: string, kind: ProjectLeaseKind): ProjectLease<Runtime> | null {
    checkProjectId(projectId);
    checkLeaseKind(kind);
    assertRunning();
    if (exclusive.has(projectId)) return null;
    const entry = entries.get(projectId);
    return entry?.state === 'open' && !entry.paused ? grant(entry, kind) : null;
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

  async function openPath(projectFile: string, kind: ProjectLeaseKind, options?: {readonly deferRecent?: true}): Promise<ProjectLease<Runtime>> {
    if (typeof projectFile !== 'string' || !path.isAbsolute(projectFile)) throw new TypeError('Project file must be an absolute path');
    checkLeaseKind(kind);
    const file = path.resolve(projectFile);
    for (;;) {
      assertRunning();
      const fileIdentity = identityOrNull(file);
      const held = fileIdentity ? [...entries.values()].find(entry => sameProjectFileIdentity(entry.identity, fileIdentity)) : undefined;
      if (held) return acquire(held.projectId, kind, options);
      const registered = fileIdentity ? registry.list().find(entry => sameProjectFileIdentity(entry.fileIdentity, fileIdentity)) : undefined;
      if (registered) recoverHistorySwitch(switchOptions(file, registered.projectId));
      let store: ProjectStore;
      try {
        store = openStore({
          projectFile: file, locate: projectId => {
            const location = locate(projectId);
            recoverHistorySwitch({...switchOptions(file, projectId), location});
            return location;
          },
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
        adopt(store, registry.get(store.projectId), kind === 'window' && options?.deferRecent === true);
      } catch (error) {
        emit({type: 'open-failed', projectId: store.projectId, error});
        throw error;
      }
      return acquire(store.projectId, kind, options);
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

  async function withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>, admission: {readonly rejectWindowLeases?: boolean; readonly assertCanClose?: (host: ProjectHost<Runtime>) => void} = {}): Promise<T> {
    checkProjectId(projectId);
    assertRunning();
    if (admission.assertCanClose !== undefined && (typeof admission.assertCanClose !== 'function' || isAsyncFunction(admission.assertCanClose))) {
      throw new TypeError('Close admission requires a synchronous callback');
    }
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
      if (entry?.closeFailure !== undefined) throw entry.closeFailure;
      if (entry?.state === 'open') {
        const paused = entry;
        if (admission.rejectWindowLeases && hasLease(paused, 'window')) throw projectHostError('PROJECT_HOST_BUSY', {projectId});
        paused.paused = true;
        clearTimer(paused);
        let admissionRefused = false;
        try {
          const drained = await waitForRequests(paused, drainTimeoutMs);
          if (stateOf(paused) === 'open') {
            if (!drained || hasLease(paused, 'request') || hasLease(paused, 'task') || isBusy(paused)
              || admission.rejectWindowLeases && hasLease(paused, 'window')) {
              throw projectHostError('PROJECT_HOST_BUSY', {projectId});
            }
            // Read the live host before interrupt() changes any waiting Mio
            // state. No acquire path can admit another lease while paused.
            if (admission.assertCanClose) {
              try { synchronousResult(admission.assertCanClose(paused.host!)); }
              catch (error) { admissionRefused = true; throw error; }
            }
            const errors = await closeEntry(paused, 'exclusive');
            if (errors.length > 0) throw errors[0];
          } else {
            // Closed meanwhile by close() or closeAll().
            await paused.closed;
            assertRunning();
          }
        } finally {
          paused.paused = false;
          if (stateOf(paused) === 'open') {
            // A slow rejected inspection must not synchronously turn its
            // refusal into an idle close/interrupt after the grace expires.
            if (admissionRefused && paused.graceUntil <= clock.now()) setTimer(paused, busyRecheckMs);
            else scheduleIdle(paused);
          }
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
    for (const projectId of new Set(taskIndex.list().filter(entry => entry.phase !== 'archived' && entry.phase !== 'done').map(entry => entry.projectId))) {
      try {
        const lease = await acquire(projectId, 'task');
        if (lease.host.recovery) {
          taskIndex.markProject?.(projectId, 'blocked', 'PROJECT_HISTORY_DIVERGED');
          lease.release();
        }
        else leases.push(lease);
      } catch (error) {
        failures.push({projectId, error});
      }
    }
    return {leases, failures};
  }

  function list(): readonly ListedProject[] {
    sweep();
    return registry.list().map(project => Object.freeze({project, availability: availabilityOf(project)}));
  }

  async function listForCatalog(inspect: InspectCatalog): Promise<readonly ListedProject[]> {
    assertRunning();
    const candidates = registry.list().filter(project => closed(project.projectId));
    const observed = candidates.length ? await inspect(candidates, isCurrent) : new Map<string, CatalogRecovery>();
    assertRunning();
    const current = registry.list();
    const before = new Map(candidates.map(project => [project.projectId, project]));
    for (const project of current) {
      const previous = before.get(project.projectId);
      if (previous && sameRegistration(previous, project) && closed(project.projectId)) {
        recordRecovery(project, observed.get(project.projectId), inspect);
      }
    }
    return current.map(project => Object.freeze({project, availability: availabilityOf(project)}));
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
    assertRunning();
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

  async function resolveHistory(raw: ProjectHistoryResolveInput): Promise<ProjectHistoryResolveResult> {
    const input = projectHistoryResolveSchema.parse(raw);
    writeAllowed();
    const registered = registry.get(input.projectId);
    if (!registered) throw projectNotFound(input.projectId);
    const receipt = completedHistoryResolution(switchOptions(registered.projectFile, input.projectId), input);
    if (receipt) { archiveTaskIndex(input, receipt); return receipt; }
    return withExclusive(input.projectId, registration => {
      writeAllowed();
      const config = switchOptions(registration.projectFile, input.projectId);
      const completed = completedHistoryResolution(config, input);
      if (completed) { archiveTaskIndex(input, completed); return completed; }
      const resumed = recoverHistorySwitch(config);
      if (resumed) {
        const receipt = completedHistoryResolution(config, input);
        if (receipt) { archiveTaskIndex(input, receipt); return receipt; }
      }
      const store = openStore({projectFile: registration.projectFile, locate, checkCopy: registeredCopyCheck(input.projectId)});
      try {
        const controller = new AbortController();
        const session = createProjectHistorySession({projectId: input.projectId, store, directories, signal: controller.signal, relocate: () => {}}, writeAllowed);
        if (session.status().confirmationDigest !== input.confirmationDigest) throw new AppError('PROJECT_HISTORY_BASELINE_CHANGED', '项目内容或本机记录已变化，请重新确认。', 409);
        prepareHistorySwitch(store, input, config);
      } finally {store.close();}
      const result = recoverHistorySwitch(config);
      if (!result) throw new AppError('PROJECT_HISTORY_SWITCH_PENDING', '本机记录处置尚未完成。', 409);
      archiveTaskIndex(input, result);
      return result;
    });
  }

  function archiveTaskIndex(input: ProjectHistoryResolveInput, result: ProjectHistoryResolveResult): void {
    writeAllowed();
    const projectId = input.projectId;
    const current = taskIndex.listProject?.(projectId) ?? taskIndex.list().filter(task => task.projectId === projectId);
    const pending = current.filter(task => task.phase !== 'archived' && task.phase !== 'done');
    if (pending.length === 0) return;
    const localDir = locate(projectId).localDir, currentSource = currentBackgroundHistorySource(localDir);
    // A replay after new work began must not require the already-retired old
    // archive, and must never archive tasks accepted by the replacement DB.
    if (pending.every(task => task.sourceHistory === currentSource)) return;
    const source = archivedBackgroundHistorySource(localDir, result.archive, input.historyIdentity);
    if (taskIndex.archive) taskIndex.archive(projectId, source);
    else taskIndex.replace(projectId, current.map(task => task.sourceHistory && task.sourceHistory !== source || task.phase === 'archived' ? task
      : {...task, phase: 'archived', reason: 'PROJECT_HISTORY_ARCHIVED', revision: (task.revision ?? 0) + 1}));
  }

  return Object.freeze({list, listForCatalog, create, openPath, prepareAcquire, acquire, markWindowOpened, tryAcquireOpen, close, closeAll, withExclusive, restore, inspectProject, status, resolveHistory});
}
