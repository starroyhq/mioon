/** Project host (docs/PROJECT-HOST.md): names shared with the web app. No
 * imports, so browser code can use them. */

/** Why a project stays open:
 * - `window`: an editor window shows it. Releasing one ends the idle grace,
 *   so closing the last window closes an idle project at once.
 * - `task`: S3 holds one while the project has unfinished background tasks.
 * - `request`: one HTTP request in flight, SSE and file streams included,
 *   released when its response ends. */
export const PROJECT_LEASE_KINDS = Object.freeze(['window', 'task', 'request'] as const);
export type ProjectLeaseKind = typeof PROJECT_LEASE_KINDS[number];

/** `opening`: the store is open and the runtime is being composed. `open`:
 * leases are granted. `closing`: no new lease until the close has finished. */
export const PROJECT_HOST_STATES = Object.freeze(['opening', 'open', 'closing'] as const);
export type ProjectHostState = typeof PROJECT_HOST_STATES[number];

/** `idle`: automatic close. `explicit`: close(projectId). `exclusive`: an
 * app-level operation (delete, duplicate, rename, close, save as) took the
 * project. `relocate`: the project file was renamed or moved on its own while
 * open; the next lease reopens it where its file identity is found.
 * `shutdown`: closeAll() when the backend stops. */
export const PROJECT_CLOSE_REASONS = Object.freeze(['idle', 'explicit', 'exclusive', 'relocate', 'shutdown'] as const);
export type ProjectCloseReason = typeof PROJECT_CLOSE_REASONS[number];

/** A registered project as the home page sees it, without opening it:
 * `open` here; `busy` under an app-level operation; `available` (no hot
 * journal, or rolled back here); `locked`: another process is writing it;
 * `missing`: not at its path and not found by file identity; `invalid` with
 * the PROJECT_INVALID reason an open would report (`read-only` and so on).
 * A hint only: opening the project decides. */
export type ProjectAvailability =
  | {readonly state: 'open' | 'busy' | 'available' | 'locked' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: string};

/** Idle grace after the last request ends: CLI, MCP and agents send requests
 * one after another and should not reopen the project for each. */
export const DEFAULT_IDLE_CLOSE_MS = 60_000;
/** How long a close or an exclusive operation waits for requests in flight. */
export const DEFAULT_REQUEST_DRAIN_MS = 3_000;
/** How often an idle host whose runtime is busy is checked again. */
export const DEFAULT_BUSY_RECHECK_MS = 1_000;

export interface ProjectHostStatus {
  readonly projectId: string;
  readonly state: ProjectHostState;
  /** An exclusive operation is waiting for this host's requests to end. */
  readonly paused: boolean;
  readonly leases: Readonly<Record<ProjectLeaseKind, number>>;
}

export type ProjectHostEvent =
  | {readonly type: 'opened'; readonly projectId: string}
  /** projectId is null when a file opened by path could not be read. */
  | {readonly type: 'open-failed'; readonly projectId: string | null; readonly error: unknown}
  | {readonly type: 'closing'; readonly projectId: string; readonly reason: ProjectCloseReason}
  /** errors: every step that failed; the close went on regardless. */
  | {readonly type: 'closed'; readonly projectId: string; readonly reason: ProjectCloseReason; readonly errors: readonly unknown[]}
  /** A hot journal of a project that is not open was rolled back here. */
  | {readonly type: 'recovered'; readonly projectId: string}
  /** Hot-journal recovery of a project that is not open threw. */
  | {readonly type: 'maintenance-failed'; readonly projectId: string; readonly error: unknown};
