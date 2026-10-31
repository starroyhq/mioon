/** One open project (docs/PROJECT-HOST.md, "单个项目宿主"). Types only. */
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import type {ProjectApiRoute} from '../../../../packages/contracts/src/project-file.ts';
import type {BackgroundTaskKind, RecentProjectSummary} from '../../../../packages/contracts/src/project-registry.ts';
import type {ProjectStore} from '../../../../packages/business/src/project-file/index.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectLeaseKind} from './types.ts';

/** A request under `/api/projects/<ID>/`, parsed with parseProjectApiPath. Its
 * request lease is released when the response ends. */
export interface ProjectRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly route: ProjectApiRoute;
  /** Aborted when the host closes by force while this request is in flight. */
  readonly signal: AbortSignal;
}

/** What the factory composes a project's runtime from. */
export interface ProjectHostContext {
  readonly projectId: string;
  /** The kernel's store: the project's only connection, open until the host closes. */
  readonly store: ProjectStore;
  readonly directories: AppDirectories;
  /** Aborted when the host starts closing. */
  readonly signal: AbortSignal;
  /** Call when a write failed with SQLITE_READONLY_DBMOVED (isDatabaseMovedError):
   * the host stops, closes, and the next lease reopens the project where its
   * file identity is found. The host's own moved-file check calls it too. */
  relocate(): void;
}

/** Home-page fields the registry caches, so a closed project is listed
 * without taking its lock. */
export interface ProjectHostSummary {
  readonly name: string;
  readonly summary: RecentProjectSummary | null;
}

export interface UnfinishedTask {
  readonly kind: BackgroundTaskKind;
  readonly taskId: string;
}

/** Everything one project runs: services, worker, edit tasks, Mio, drafts and
 * the project-level HTTP handlers. The manager owns the store and closes it
 * after dispose(). */
export interface ProjectHostRuntime {
  /** Project-level routes under /api/projects/<ID>/; false when none matches. */
  handle(request: ProjectRequest): Promise<boolean>;
  /** In-process work a close would interrupt: a Mio turn, a running edit
   * task, a held file publication, a provider call of the worker. A busy host
   * is neither closed when idle nor taken by an exclusive operation. */
  isBusy(): boolean;
  /** Ends long-lived streams (SSE) and aborts Mio turns; first step of a close. */
  interrupt(): void;
  /** Stops the worker and waits for services, edit tasks, Mio and file responses. */
  drain(): Promise<void>;
  /** Releases what is left (Mio tools, timers); the manager closes the store afterwards. */
  dispose(): void;
  /** Home-page fields, read on open and before close. */
  summarize?(): ProjectHostSummary | null;
  /** S3: unfinished background tasks, written to the task index on close. */
  unfinishedTasks?(): readonly UnfinishedTask[];
}

/** Composes one project's runtime on an open store. Called once per open; a
 * rejection fails the open, and the manager closes the store. */
export type ProjectHostFactory<Runtime extends ProjectHostRuntime = ProjectHostRuntime> = (context: ProjectHostContext) => Promise<Runtime>;

export interface ProjectHost<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly projectId: string;
  /** Path when the host opened; a move while open is noticed on close. */
  readonly projectFile: string;
  readonly store: ProjectStore;
  readonly runtime: Runtime;
  /** Aborted when the host starts closing. */
  readonly signal: AbortSignal;
  /** ProjectHostContext.relocate, for the dispatcher's error path. */
  relocate(): void;
}

/** Keeps a host open. A host closes only without leases (docs/PROJECT-HOST.md,
 * "自动打开的项目什么时候关"); a forced close revokes the remaining leases. */
export interface ProjectLease<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly kind: ProjectLeaseKind;
  readonly host: ProjectHost<Runtime>;
  /** Aborted when the lease is revoked by a forced close. */
  readonly signal: AbortSignal;
  /** Idempotent. */
  release(): void;
}

/** Trusted test-only access to a project's connection, synchronously: the
 * open host's own connection, or the project opened alone for the call. Never
 * reachable from HTTP or the environment. */
export type InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T) => T;
