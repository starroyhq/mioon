/** TS-specific command payloads for format-5 timeline synchronization (TSa).
 *
 * The CS/TS shared action contract lives in `sequence-edit.ts`: envelope,
 * receipt, patch, history-13 row and the shared error table are imported from
 * there, never restated here. This file only keeps the bounded TS command
 * payloads used by UI-B/UI-E/MT before they are wrapped into one
 * `SequenceEditEnvelope` intent (`sequenceSyncIntent`).
 */
import type {ChainSyncOperation} from './chain-sync-algorithm.ts';
import type {SequenceEditIntent} from './sequence-edit.ts';
import {sequenceEditIntentSide} from './sequence-edit.ts';

export const SEQUENCE_SYNC_COMMANDS = Object.freeze(['sync-board', 'board-version', 'clip-version'] as const);
export type SequenceSyncCommandKind = (typeof SEQUENCE_SYNC_COMMANDS)[number];

export type SequenceSyncCommand =
  /** Repair projection after a board fix; allocation supplies new main clip ids. */
  | {readonly kind: 'sync-board'; readonly newClipIds?: Readonly<Record<string, string>>}
  /** Board-side version selection; `null` keeps the applied clip (P5 D4). */
  | {readonly kind: 'board-version'; readonly nodeId: string; readonly versionId: string | null}
  /** Timeline-side version action: follow a selected version or lock this cut. */
  | {readonly kind: 'clip-version'; readonly clipId: string; readonly versionId: string | null;
    readonly mode: 'follow' | 'locked'};

/** Convert a TS command payload into the SA operation carried by the shared
 * envelope intent. Ownership/hash validation still happens inside the service
 * transaction; this only preserves the semantic operation shape. */
export function sequenceSyncOperation(command: SequenceSyncCommand): ChainSyncOperation {
  switch (command.kind) {
    case 'sync-board':
      return {kind: 'sync-board', ...(command.newClipIds ? {newClipIds: command.newClipIds} : {})};
    case 'board-version':
      return {kind: 'board-version', nodeId: command.nodeId,
        version: command.versionId === null ? null : {id: command.versionId, sourceFrames: null}};
    case 'clip-version':
      return {kind: 'track', edit: {kind: 'version', clipId: command.clipId,
        version: command.versionId === null ? null : {id: command.versionId, sourceFrames: null},
        locked: command.mode === 'locked'}};
  }
}

/** Same operation wrapped with its shared-contract side. */
export function sequenceSyncIntent(command: SequenceSyncCommand): SequenceEditIntent {
  const operation = sequenceSyncOperation(command);
  return {side: sequenceEditIntentSide(operation), operation};
}
