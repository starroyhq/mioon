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

export const SEQUENCE_SYNC_COMMANDS = Object.freeze([
  'sync-board', 'board-version', 'clip-version',
  'clip-remove', 'clip-add', 'clip-split', 'clip-trim', 'clip-move', 'clip-move-off-track',
  'insert-asset', 'paste-clip', 'clip-copy-as-new-shot',
] as const);
export type SequenceSyncCommandKind = (typeof SEQUENCE_SYNC_COMMANDS)[number];

export interface SequenceSyncAddClip {
  readonly id: string;
  readonly nodeId: string;
  readonly segmentGroupId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly versionId?: string | null;
  readonly locked?: boolean;
}

export type SequenceSyncCommand =
  /** Repair projection after a board fix; allocation supplies new main clip ids. */
  | {readonly kind: 'sync-board'; readonly newClipIds?: Readonly<Record<string, string>>}
  /** Board-side version selection; `null` keeps the applied clip (P5 D4). */
  | {readonly kind: 'board-version'; readonly nodeId: string; readonly versionId: string | null}
  /** Timeline-side version action: follow a selected version or lock this cut. */
  | {readonly kind: 'clip-version'; readonly clipId: string; readonly versionId: string | null;
    readonly mode: 'follow' | 'locked'}
  /** Remove one main-track segment; the chain is rewired and the track compacted. */
  | {readonly kind: 'clip-remove'; readonly clipId: string}
  /** Insert one existing free shot/media into the main track. */
  | {readonly kind: 'clip-add'; readonly clip: SequenceSyncAddClip; readonly beforeClipId: string | null;
    readonly nodeKind?: 'shot' | 'video' | 'image'; readonly nodeAssetId?: string; readonly nodeName?: string;
    readonly copyFromClipId?: string}
  | {readonly kind: 'insert-asset'; readonly assetId: string; readonly trackId: string | null; readonly startFrame: number}
  | {readonly kind: 'paste-clip'; readonly clipId: string; readonly startFrame: number}
  | {readonly kind: 'clip-copy-as-new-shot'; readonly clipId: string; readonly newClipId: string; readonly copyNodeId: string}
  /** Split one segment; left keeps its id, the right takes the allocated id. */
  | {readonly kind: 'clip-split'; readonly clipId: string; readonly offsetFrames: number;
    readonly rightClipId: string; readonly rightSourceInFrame?: number}
  /** Trim or extend one segment's cut length. */
  | {readonly kind: 'clip-trim'; readonly clipId: string; readonly durationFrames: number;
    readonly sourceInFrame?: number}
  /** Reorder one segment; reorder across a split group needs a copied node id. */
  | {readonly kind: 'clip-move'; readonly clipId: string; readonly beforeClipId: string | null;
    readonly copyNodeId?: string}
  /** Move one segment to another track at an absolute start; a split piece copy
   * needs `copyNodeId` and the server re-checks the whole allocation. */
  | {readonly kind: 'clip-move-off-track'; readonly clipId: string; readonly trackId: string;
    readonly startFrame: number; readonly copyNodeId?: string}
  /** FR-B2: split one clip at every current scene cut inside its source range. */
  | {readonly kind: 'clip-split-scenes'; readonly assetId: string; readonly resultId: string};

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
    case 'clip-remove':
      return {kind: 'track', edit: {kind: 'remove', clipId: command.clipId}};
    case 'clip-add':
      return {kind: 'track', edit: {kind: 'add', clip: {
        id: command.clip.id, nodeId: command.clip.nodeId,
        splitGroupId: command.clip.segmentGroupId, versionId: command.clip.versionId ?? null,
        versionLocked: command.clip.locked ?? false, startFrame: command.clip.startFrame,
        durationFrames: command.clip.durationFrames, sourceInFrame: command.clip.sourceInFrame,
      }, beforeClipId: command.beforeClipId, ...(command.nodeKind ? {nodeKind: command.nodeKind} : {}),
      ...(command.nodeAssetId ? {nodeAssetId: command.nodeAssetId} : {}),
      ...(command.nodeName ? {nodeName: command.nodeName} : {}),
      ...(command.copyFromClipId ? {copyFromClipId: command.copyFromClipId} : {})}};
    case 'insert-asset':
      return {kind: 'track', edit: {kind: 'insert-asset', assetId: command.assetId, trackId: command.trackId,
        startFrame: command.startFrame}};
    case 'paste-clip':
      return {kind: 'track', edit: {kind: 'paste-clip', clipId: command.clipId, startFrame: command.startFrame}};
    case 'clip-copy-as-new-shot':
      return {kind: 'track', edit: {kind: 'copy-as-new-shot', clipId: command.clipId,
        newClipId: command.newClipId, copyNodeId: command.copyNodeId}};
    case 'clip-split-scenes':
      return {kind: 'track', edit: {kind: 'split-at-scenes', assetId: command.assetId, resultId: command.resultId}};
    case 'clip-split':
      return {kind: 'track', edit: {kind: 'split', clipId: command.clipId, offsetFrames: command.offsetFrames,
        rightClipId: command.rightClipId, ...(command.rightSourceInFrame !== undefined ? {rightSourceInFrame: command.rightSourceInFrame} : {})}};
    case 'clip-trim':
      return {kind: 'track', edit: {kind: 'trim', clipId: command.clipId, durationFrames: command.durationFrames,
        ...(command.sourceInFrame !== undefined ? {sourceInFrame: command.sourceInFrame} : {})}};
    case 'clip-move':
      return {kind: 'track', edit: {kind: 'move', clipId: command.clipId, beforeClipId: command.beforeClipId,
        ...(command.copyNodeId ? {copyNodeId: command.copyNodeId} : {})}};
    case 'clip-move-off-track':
      return {kind: 'track', edit: {kind: 'move-off-track', clipId: command.clipId, trackId: command.trackId,
        startFrame: command.startFrame, ...(command.copyNodeId ? {copyNodeId: command.copyNodeId} : {})}};
  }
}

/** Same operation wrapped with its shared-contract side. */
export function sequenceSyncIntent(command: SequenceSyncCommand): SequenceEditIntent {
  const operation = sequenceSyncOperation(command);
  return {side: sequenceEditIntentSide(operation), operation};
}
