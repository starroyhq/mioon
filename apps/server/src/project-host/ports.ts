/** What the project host needs from other cards (docs/PROJECT-HOST.md,
 * "需要别的卡提供的端口"). Types only; stand-ins.ts has what S0 uses until
 * each card lands. All ports are synchronous except findMoved, and are plain
 * objects of closures, so callers may spread and wrap them. */
import type {AgentTaskPolicy} from '../../../../packages/contracts/src/agent-tasks-v2.ts';
import type {BackgroundTaskIndexEntry, ProjectFileIdentity, ProjectInboxItem, RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ProjectHostContext, ProjectRequest} from './host.ts';

// ---------------------------------------------------------------------------
// B1: app database

/** Recent-project registry. The host writes an entry when a project is
 * created or opened, and again when it closes (path by file identity, name
 * and summary). */
export interface ProjectRegistryPort {
  list(): readonly RecentProject[];
  get(projectId: string): RecentProject | null;
  /** Validates with recentProjectSchema; replaces the entry of this project ID. */
  upsert(entry: RecentProject): void;
  remove(projectId: string): void;
  /** Where a moved project file is now, found by fileIdentity with readdir and
   * lstat only (never opening a file); null when not found. */
  findMoved(entry: RecentProject): Promise<string | null>;
  /** The kernel's checkCopy hook, run on every open after the project ID is
   * read: throw to refuse a copy of a registered project. */
  checkCopy?(file: {readonly projectId: string; readonly projectFile: string}): void;
}

/** projectFileIdentity: lstat only; null when the path is not a regular file. */
export type ProjectFileIdentityPort = (projectFile: string) => ProjectFileIdentity | null;

/** Global Mio policy and its request receipts (two app database tables). The
 * revision and conflict rules stay in Mio; the caller passes this port in. */
export interface AgentPolicyStorePort {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  /** One transaction: the policy and, with a request, its receipt. */
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void;
}

export interface AppLibraryPort {
  readonly registry: ProjectRegistryPort;
  readonly agentPolicy: AgentPolicyStorePort;
  readonly projectFileIdentity: ProjectFileIdentityPort;
  /** The app database file. Mio authorizations, UI preferences and the other
   * app-level JSON stores are scoped by its identity instead of workbench.sqlite. */
  readonly databaseFile: string;
  close(): void;
}

// ---------------------------------------------------------------------------
// S3: background tasks

/** Projects with unfinished tasks. restore() reopens them at startup with a
 * task lease; each close replaces the project's entries. */
export interface BackgroundTaskIndexPort {
  list(): readonly BackgroundTaskIndexEntry[];
  /** Replaces this project's entries; an empty list removes them. */
  replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void;
}

/** Results that arrived while their project could not be opened. S3's
 * afterOpen hook writes them into the project and removes them. */
export interface ProjectInboxPort {
  add(item: ProjectInboxItem): void;
  list(projectId: string): readonly ProjectInboxItem[];
  remove(projectId: string, itemId: string): void;
}

// ---------------------------------------------------------------------------
// V1, V2 and S3: lifecycle hooks

export interface ProjectLifecycleHooks {
  /** After the runtime is composed, before the first lease (V2's open backup,
   * S3's inbox). Throwing fails the open. */
  afterOpen?(host: ProjectHostContext): void | Promise<void>;
  /** After requests and the runtime drained, store still open (V1's version
   * on close, V2's close backup). Errors are recorded; the close goes on.
   * Hooks run in reverse order of registration. */
  beforeClose?(host: ProjectHostContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// R1: Mio

/** App-level services a project's Mio runtime receives. Settings and send
 * authorizations stay app-level as well; the factory captures them. */
export interface MioAppServices {
  readonly policy: AgentPolicyStorePort;
  readonly selfPort: () => number;
}

/** One project's Mio: today's createAgentTaskRuntime with createAgentTaskHttp. */
export interface MioRuntimePort {
  /** `agent/tasks/v2/…` and `editing` under the project prefix. */
  handle(request: ProjectRequest): Promise<boolean>;
  isBusy(): boolean;
  /** Closes SSE clients and aborts turns. */
  interrupt(): void;
  drain(): Promise<void>;
  dispose(): void;
}
export type MioRuntimeFactory = (context: ProjectHostContext, app: MioAppServices) => MioRuntimePort;

// ---------------------------------------------------------------------------
// S8: drafts

/** One project's drafts. Before S8: today's three JSON modules with localDir
 * as their root; after S8: the draft tables of the local records. */
export interface ProjectDraftsPort {
  /** local-drafts, local-delivery and local-shot-text routes. */
  handle(request: ProjectRequest): Promise<boolean>;
  drain(): Promise<void>;
}
export type ProjectDraftsFactory = (context: ProjectHostContext) => ProjectDraftsPort;

// ---------------------------------------------------------------------------
// S0a: kernel maintenance

/** S0a's ProjectFileRecovery, mirrored until #106 lands; then imported from
 * the kernel, with ProjectInvalidReason for `reason`. */
export type ProjectFileRecovery =
  | {readonly state: 'clean' | 'recovered' | 'locked' | 'open-here' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: string};

/** S0a's kernel functions the host calls. Removing super-journals no journal
 * needs is part of every successful open in the kernel, so it is not here. */
export interface KernelMaintenancePort {
  /** S0a's recoverProjectFile: step 1 of an open and nothing else. Rolls back a
   * hot journal of a project that is not open here, so the file is complete
   * before anyone copies it. restore() and list() call it once for each
   * registered project this process does not have open. */
  recoverProjectFile(projectFile: string): ProjectFileRecovery;
}
