/** Format-5 timeline/board synchronization: the shared action surface owned by
 * the timeline-sync service (TSa). The board editor (CS) and the Mio tools (MT)
 * call the same transaction entry and treat this receipt as the only result
 * projection; UI-E2 consumes it without inventing local state. */
import type {Format5SyncBaseline} from './project-format5.ts';

export const SEQUENCE_SYNC_OPERATIONS = Object.freeze([
  'sync-board', 'board-version', 'clip-version', 'undo',
] as const);
export type SequenceSyncOperation = (typeof SEQUENCE_SYNC_OPERATIONS)[number];

export const SEQUENCE_SYNC_ERROR_CODES = Object.freeze([
  'SEQUENCE_SYNC_FORMAT_REQUIRED',
  'SEQUENCE_SYNC_ROOT_NOT_BOUND',
  'SEQUENCE_SYNC_STALE_REVISION',
  'SEQUENCE_SYNC_REQUEST_CONFLICT',
  'SEQUENCE_SYNC_PLAN_REJECTED',
  'SEQUENCE_SYNC_UNDO_STALE',
  'SEQUENCE_SYNC_UNSUPPORTED_COMMAND',
] as const);
export type SequenceSyncErrorCode = (typeof SEQUENCE_SYNC_ERROR_CODES)[number];

/** Commands are explicit and bounded: the caller names the affected root, node
 * or clip and never supplies arbitrary project rows. */
export type SequenceSyncCommand =
  | {readonly kind: 'sync-board'; readonly newClipIds?: Readonly<Record<string, string>>}
  | {readonly kind: 'board-version'; readonly nodeId: string; readonly versionId: string | null}
  | {readonly kind: 'clip-version'; readonly clipId: string; readonly versionId: string | null;
    readonly mode: 'follow' | 'locked'}
  | {readonly kind: 'undo'; readonly actionId: string};

export interface SequenceSyncEnvelope {
  /** Stable replay key (8–200 characters); an exact retry returns the original receipt. */
  readonly requestId: string;
  /** Both values are the last seen `syncRevision`/`timelineRevision`. */
  readonly expected: {readonly syncRevision: number; readonly timelineRevision: number};
}

export interface SequenceSyncVersionWarning {
  readonly code: 'SOURCE_TOO_SHORT';
  readonly clipId: string;
  readonly nodeId: string;
  readonly versionId: string;
  readonly shortByFrames: number;
}

export interface SequenceSyncRoot {
  readonly timelineId: string;
  readonly rootNodeId: string;
  readonly mainTrackId: string;
}

export interface SequenceSyncEntitySummary {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

/** Receipt shared by CS/MT and consumed by UI-E2. `syncRevision` increases for
 * every applied command (never for an empty edit); the history block is absent
 * for no-ops and for the inverse of an already-recorded action. */
export interface SequenceSyncReceipt {
  readonly ok: true;
  readonly operation: SequenceSyncOperation;
  readonly requestId: string;
  readonly actionId: string;
  readonly changed: boolean;
  readonly root: SequenceSyncRoot;
  readonly syncRevision: number;
  readonly timelineRevision: number;
  readonly nodes: SequenceSyncEntitySummary;
  readonly edges: SequenceSyncEntitySummary;
  readonly shotSources: SequenceSyncEntitySummary;
  readonly clips: SequenceSyncEntitySummary;
  readonly tracks: SequenceSyncEntitySummary;
  readonly anchored: SequenceSyncEntitySummary;
  readonly warnings: readonly SequenceSyncVersionWarning[];
  readonly history: {readonly actionId: string; readonly undoable: boolean; readonly position: number} | null;
}

/** Persisted baseline is the same strict shape the kernel validates. */
export type SequenceSyncBaseline = Format5SyncBaseline;

export interface SequenceSyncHistoryEvidence {
  readonly formatVersion: 5;
  readonly epoch: string;
  readonly actionId: string;
  readonly operation: SequenceSyncOperation;
  readonly syncRevision: number;
  readonly timelineRevision: number;
}
