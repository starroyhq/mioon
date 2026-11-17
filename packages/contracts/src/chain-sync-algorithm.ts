import { compareChainIds, compareSequenceEdges, deriveFilmChains, planBoardSequenceEdit } from './board-sequence.ts';
import type { BoardSequenceEdit, BoardSequenceIssue, ChainBoard, ChainNode, SequenceEdge } from './board-sequence.ts';
import {
  compareSyncClip, followChainSyncVersion, indexChainSyncTrack, packChainSyncTrack,
  planChainMainTrack, validChainClipFrames, validChainMedia,
} from './chain-main-track.ts';
import type { ChainSyncClip, ChainSyncMedia, ChainSyncVersion, ChainSyncWarning, MainTrackFailure } from './chain-main-track.ts';
import { planTrackAnchors } from './chain-sync-analysis.ts';
import type { TrackAnchoredItem, TrackAnchorSplit } from './chain-sync-analysis.ts';

export { planChainMainTrack } from './chain-main-track.ts';
export type { ChainSyncClip, ChainSyncMedia, ChainSyncVersion, ChainSyncWarning, MainTrackPlan } from './chain-main-track.ts';

/** One plan binds one film root to its own main track; the board may contain other films. */
export interface ChainSyncState {
  readonly board: ChainBoard;
  readonly filmId: string;
  readonly media: readonly ChainSyncMedia[];
  readonly clips: readonly ChainSyncClip[];
  /** IDs are unique across the main track and the mapped other-track items. */
  readonly anchored: readonly TrackAnchoredItem[];
}
export type TrackSyncEdit =
  | { readonly kind: 'move'; readonly clipId: string; readonly beforeClipId: string | null; readonly copyNodeId?: string }
  | { readonly kind: 'move-off-track'; readonly clipId: string; readonly trackId: string; readonly startFrame: number; readonly copyNodeId?: string }
  | { readonly kind: 'remove'; readonly clipId: string }
  | { readonly kind: 'add'; readonly clip: ChainSyncClip; readonly beforeClipId: string | null; readonly media?: ChainSyncMedia; readonly nodeKind?: 'shot' | 'video' | 'image' }
  | { readonly kind: 'split'; readonly clipId: string; readonly offsetFrames: number; readonly rightClipId: string; readonly rightSourceInFrame?: number }
  | { readonly kind: 'trim'; readonly clipId: string; readonly durationFrames: number; readonly sourceInFrame?: number }
  | { readonly kind: 'version'; readonly clipId: string; readonly version: ChainSyncVersion | null; readonly locked: boolean };
export type ChainSyncOperation =
  | { readonly kind: 'board'; readonly edit: BoardSequenceEdit; readonly newClipIds?: Readonly<Record<string, string>> }
  | { readonly kind: 'sync-board'; readonly newClipIds?: Readonly<Record<string, string>> }
  | { readonly kind: 'board-version'; readonly nodeId: string; readonly version: ChainSyncVersion | null }
  | { readonly kind: 'track'; readonly edit: TrackSyncEdit };

export interface ChainSyncChange<T> { readonly before: T | null; readonly after: T | null }
export interface ChainSyncChanges {
  readonly nodes: readonly ChainSyncChange<ChainNode>[];
  readonly edges: readonly ChainSyncChange<SequenceEdge>[];
  readonly media: readonly ChainSyncChange<ChainSyncMedia>[];
  readonly clips: readonly ChainSyncChange<ChainSyncClip>[];
  readonly anchored: readonly ChainSyncChange<TrackAnchoredItem>[];
}
type SyncFailure = { readonly ok: false; readonly code:
  | 'FILM_NOT_FOUND' | 'ACTIVE_FILM_REMOVED' | 'FILM_SCOPE_MISMATCH' | 'CHAIN_TRACK_MISMATCH'
  | 'CLIP_NOT_FOUND' | 'INVALID_SPLIT' | 'NODE_ALREADY_LINKED' | 'COPY_NODE_EXISTS' | 'INVALID_ANCHOR' | 'INVALID_TRACK_TARGET'; readonly id: string };
type GraphFailure = { readonly ok: false; readonly code: BoardSequenceIssue['code']; readonly issues: readonly BoardSequenceIssue[] };
type CopyRequired = { readonly ok: false; readonly code: 'COPY_NODE_REQUIRED'; readonly nodeId: string; readonly clipId: string };
export interface ChainSyncTransfer { readonly trackId: string; readonly clip: ChainSyncClip }
export interface ChainSyncNodeCopy { readonly fromNodeId: string; readonly toNodeId: string }
interface PlannedTrackDetails {
  readonly transfer?: ChainSyncTransfer;
  readonly copiedNode?: ChainSyncNodeCopy;
}
export type ChainSyncPlan =
  | ({ readonly ok: true; readonly after: ChainSyncState; readonly changes: ChainSyncChanges; readonly warnings: readonly ChainSyncWarning[] } & PlannedTrackDetails)
  | SyncFailure | MainTrackFailure | GraphFailure | CopyRequired;

const byId = <T extends { readonly id: string }>(a: T, b: T) => compareChainIds(a.id, b.id);
const byMedia = (a: ChainSyncMedia, b: ChainSyncMedia) => compareChainIds(a.nodeId, b.nodeId);
const edgeKey = ({fromId, toId}: SequenceEdge) => JSON.stringify([fromId, toId]);
const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);
const naturalFrame = (value: number) => Number.isSafeInteger(value) && value >= 0;
const playable = (node: ChainNode | undefined): node is ChainNode =>
  !!node && (node.kind === 'shot' || node.kind === 'video' || node.kind === 'image');
const versionEqual = (a: ChainSyncVersion | null, b: ChainSyncVersion | null) =>
  a === b || a !== null && b !== null && a.id === b.id && a.sourceFrames === b.sourceFrames;

function changes<T>(before: readonly T[], after: readonly T[], key: (item: T) => string, equal: (a: T, b: T) => boolean): ChainSyncChange<T>[] {
  const oldRecords = new Map(before.map(item => [key(item), item] as const));
  const newRecords = new Map(after.map(item => [key(item), item] as const));
  const ids = [...new Set([...oldRecords.keys(), ...newRecords.keys()])].sort(compareChainIds);
  const result: ChainSyncChange<T>[] = [];
  for (const id of ids) {
    const old = oldRecords.get(id) ?? null;
    const updated = newRecords.get(id) ?? null;
    if (old === updated || old !== null && updated !== null && equal(old, updated)) continue;
    result.push({before: old, after: updated});
  }
  return result;
}

function makePlan(
  before: ChainSyncState, board: ChainBoard, media: readonly ChainSyncMedia[], clips: readonly ChainSyncClip[],
  anchored: readonly TrackAnchoredItem[], warnings: readonly ChainSyncWarning[], details: PlannedTrackDetails = {},
): ChainSyncPlan {
  const invalidAnchor = [...anchored].sort(byId).find(item => !naturalFrame(item.startFrame));
  if (invalidAnchor) return {ok: false, code: 'INVALID_ANCHOR', id: invalidAnchor.id};
  const anchoredIds = new Set(anchored.map(item => item.id));
  const duplicate = clips.find(clip => anchoredIds.has(clip.id));
  if (duplicate) return {ok: false, code: 'DUPLICATE_CLIP', id: duplicate.id};
  const after = {board: {nodes: [...board.nodes].sort(byId), edges: [...board.edges].sort(compareSequenceEdges)},
    filmId: before.filmId, media: [...media].sort(byMedia), clips: [...clips].sort(compareSyncClip), anchored: [...anchored].sort(byId)};
  return {ok: true, after, ...details, warnings: [...warnings].sort((a, b) => compareChainIds(a.clipId, b.clipId)),
    changes: {
      nodes: changes(before.board.nodes, after.board.nodes, node => node.id, (a, b) => a.kind === b.kind),
      edges: changes(before.board.edges, after.board.edges, edgeKey, () => true),
      media: changes(before.media, after.media, item => item.nodeId, (a, b) =>
        a.durationFrames === b.durationFrames && versionEqual(a.selectedVersion, b.selectedVersion)),
      clips: changes(before.clips, after.clips, clip => clip.id, (a, b) =>
        a.nodeId === b.nodeId && a.versionId === b.versionId && a.versionLocked === b.versionLocked
        && a.startFrame === b.startFrame && a.durationFrames === b.durationFrames
        && a.sourceInFrame === b.sourceInFrame && a.splitGroupId === b.splitGroupId),
      anchored: changes(before.anchored, after.anchored, item => item.id, (a, b) =>
        a.startFrame === b.startFrame && a.anchorClipId === b.anchorClipId),
    }};
}

/** Deltas carry the exact old record on every modification. The transaction host
 * can apply them together and reverse them by exchanging before and after. */
export function planChainSync(state: ChainSyncState, operation: ChainSyncOperation): ChainSyncPlan {
  const graph = deriveFilmChains(state.board);
  if (graph.issues.length) return {ok: false, code: graph.issues[0]!.code, issues: graph.issues};
  const film = graph.chains.find(item => item.filmId === state.filmId);
  if (!film) return {ok: false, code: 'FILM_NOT_FOUND', id: state.filmId};
  const track = indexChainSyncTrack(state.clips);
  if (!track.ok) return track;
  const nodes = new Map(state.board.nodes.map(node => [node.id, node]));
  const media = new Map<string, ChainSyncMedia>();
  for (const item of [...state.media].sort(byMedia)) {
    if (media.has(item.nodeId)) return {ok: false, code: 'DUPLICATE_MEDIA', id: item.nodeId};
    media.set(item.nodeId, item);
  }
  const mainIds = new Set(track.clips.map(clip => clip.id));
  const anchorIds = new Set<string>();
  for (const item of [...state.anchored].sort(byId)) {
    if (!item.id || !naturalFrame(item.startFrame) || mainIds.has(item.id) || anchorIds.has(item.id)) return {ok: false, code: 'INVALID_ANCHOR', id: item.id};
    anchorIds.add(item.id);
  }
  const oldIds = [...track.groups.keys()];
  const previousChain = film.nodeIds;
  const inSync = sameOrder(oldIds, previousChain);
  if (operation.kind === 'track') {
    if (!inSync) return {ok: false, code: 'CHAIN_TRACK_MISMATCH', id: state.filmId};
    return planTrackEdit(state, operation.edit, track.clips, oldIds, nodes, media);
  }

  let board = state.board;
  let chain = previousChain;
  if (operation.kind === 'board') {
    const edit = planBoardSequenceEdit(board, operation.edit);
    if (!edit.ok) return edit;
    board = edit.board;
    const editedFilms = new Map(deriveFilmChains(board).chains.map(item => [item.filmId, item.nodeIds]));
    for (const other of graph.chains) {
      if (other.filmId === state.filmId) continue;
      const edited = editedFilms.get(other.filmId);
      if (!edited || !sameOrder(other.nodeIds, edited)) return {ok: false, code: 'FILM_SCOPE_MISMATCH', id: other.filmId};
    }
    const editedFilm = editedFilms.get(state.filmId);
    if (!editedFilm) return {ok: false, code: 'ACTIVE_FILM_REMOVED', id: state.filmId};
    chain = editedFilm;
    if (operation.edit.kind === 'delete') media.delete(operation.edit.nodeId);
    if (sameOrder(previousChain, chain)) return makePlan(state, board, [...media.values()], track.clips, state.anchored, []);
  } else if (operation.kind === 'board-version') {
    const item = media.get(operation.nodeId);
    if (!item) return {ok: false, code: 'MISSING_MEDIA', id: operation.nodeId};
    const candidate = {...item, selectedVersion: operation.version};
    const node = nodes.get(operation.nodeId);
    if (!playable(node) || !validChainMedia(candidate, node.kind)) return {ok: false, code: 'INVALID_MEDIA', id: operation.nodeId};
    media.set(operation.nodeId, candidate);
    const other = graph.chains.find(item => item.filmId !== state.filmId && item.nodeIds.includes(operation.nodeId));
    if (other) return {ok: false, code: 'FILM_SCOPE_MISMATCH', id: other.filmId};
    if (!chain.includes(operation.nodeId)) return makePlan(state, board, [...media.values()], track.clips, state.anchored, []);
    if (!inSync) return {ok: false, code: 'CHAIN_TRACK_MISMATCH', id: state.filmId};
    const warnings: ChainSyncWarning[] = [];
    const clips = track.clips.map(clip => clip.nodeId === operation.nodeId && !clip.versionLocked
      ? followChainSyncVersion(clip, operation.version, warnings) : clip);
    return makePlan(state, board, [...media.values()], clips, state.anchored, warnings);
  }
  if (operation.kind !== 'sync-board' && !inSync) return {ok: false, code: 'CHAIN_TRACK_MISMATCH', id: state.filmId};
  const items = [...media.values()];
  const next = planChainMainTrack(chain.map(id => nodes.get(id)!), items, track.clips, operation.newClipIds,
    {followVersions: operation.kind === 'sync-board'});
  if (!next.ok) return next;
  return makePlan(state, board, items, next.clips, planTrackAnchors(track.clips, next.clips, state.anchored), next.warnings);
}

function replaceFilmEdges(board: ChainBoard, filmId: string, previous: readonly string[], next: readonly string[]): SequenceEdge[] {
  const affected = new Set([filmId, ...previous]);
  const edges = board.edges.filter(edge => !affected.has(edge.fromId));
  let fromId = filmId;
  for (const toId of next) {
    edges.push({fromId, toId});
    fromId = toId;
  }
  return edges;
}

function copySplitPiece(
  clip: ChainSyncClip, nodeId: string | undefined,
  nodes: Map<string, ChainNode>, media: Map<string, ChainSyncMedia>,
): ChainSyncClip | SyncFailure | MainTrackFailure | CopyRequired {
  if (!nodeId) return {ok: false, code: 'COPY_NODE_REQUIRED', nodeId: clip.nodeId, clipId: clip.id};
  if (nodes.has(nodeId) || media.has(nodeId)) return {ok: false, code: 'COPY_NODE_EXISTS', id: nodeId};
  const source = media.get(clip.nodeId);
  if (!source) return {ok: false, code: 'MISSING_MEDIA', id: clip.nodeId};
  nodes.set(nodeId, {id: nodeId, kind: nodes.get(clip.nodeId)!.kind});
  media.set(nodeId, {...source, nodeId});
  const {splitGroupId: _, ...piece} = clip;
  return {...piece, nodeId};
}

function exceedsKnownSource(clip: ChainSyncClip, media: ChainSyncMedia | undefined): boolean {
  const version = media?.selectedVersion;
  return !!version && version.id === clip.versionId && version.sourceFrames !== null
    && version.sourceFrames < clip.sourceInFrame + clip.durationFrames;
}

function planTrackEdit(
  state: ChainSyncState, edit: TrackSyncEdit, previous: readonly ChainSyncClip[], oldIds: readonly string[],
  nodes: Map<string, ChainNode>, media: Map<string, ChainSyncMedia>,
): ChainSyncPlan {
  const next = [...previous];
  const splits: TrackAnchorSplit[] = [];
  const warnings: ChainSyncWarning[] = [];
  let transfer: ChainSyncTransfer | undefined;
  let copiedNode: ChainSyncNodeCopy | undefined;
  if (edit.kind === 'add') {
    const {clip} = edit;
    if (next.some(item => item.id === clip.id)) return {ok: false, code: 'DUPLICATE_CLIP', id: clip.id};
    if (state.board.edges.some(edge => edge.fromId === clip.nodeId || edge.toId === clip.nodeId)) return {ok: false, code: 'NODE_ALREADY_LINKED', id: clip.nodeId};
    const at = edit.beforeClipId === null ? next.length : next.findIndex(item => item.id === edit.beforeClipId);
    if (at < 0) return {ok: false, code: 'CLIP_NOT_FOUND', id: edit.beforeClipId!};
    const node = nodes.get(clip.nodeId) ?? {id: clip.nodeId, kind: edit.nodeKind ?? 'shot'};
    const source = edit.media ?? media.get(clip.nodeId);
    if (!source) return {ok: false, code: 'MISSING_MEDIA', id: clip.nodeId};
    if (!playable(node) || source.nodeId !== clip.nodeId || !validChainMedia(source, node.kind))
      return {ok: false, code: 'INVALID_MEDIA', id: clip.nodeId};
    if (!validChainClipFrames(clip)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: clip.id};
    if (!clip.versionLocked && clip.versionId !== (source.selectedVersion?.id ?? null))
      return {ok: false, code: 'INVALID_CLIP_VERSION', id: clip.id};
    if (exceedsKnownSource(clip, source)) return {ok: false, code: 'SOURCE_BOUNDS', id: clip.id};
    nodes.set(node.id, node);
    media.set(node.id, source);
    next.splice(at, 0, clip);
  } else {
    const at = next.findIndex(item => item.id === edit.clipId);
    if (at < 0) return {ok: false, code: 'CLIP_NOT_FOUND', id: edit.clipId};
    const clip = next[at]!;
    switch (edit.kind) {
      case 'remove':
        next.splice(at, 1);
        break;
      case 'move': {
        if (edit.beforeClipId === clip.id) break;
        next.splice(at, 1);
        const to = edit.beforeClipId === null ? next.length : next.findIndex(item => item.id === edit.beforeClipId);
        if (to < 0) return {ok: false, code: 'CLIP_NOT_FOUND', id: edit.beforeClipId!};
        const splitOff = clip.splitGroupId !== undefined && next.some(item => item.nodeId === clip.nodeId)
          && next[to - 1]?.nodeId !== clip.nodeId && next[to]?.nodeId !== clip.nodeId;
        if (!splitOff) {
          next.splice(to, 0, clip);
          break;
        }
        const copy = copySplitPiece(clip, edit.copyNodeId, nodes, media);
        if ('ok' in copy) return copy;
        copiedNode = {fromNodeId: clip.nodeId, toNodeId: copy.nodeId};
        next.splice(to, 0, copy);
        break;
      }
      case 'move-off-track': {
        if (!edit.trackId || !naturalFrame(edit.startFrame)) return {ok: false, code: 'INVALID_TRACK_TARGET', id: edit.trackId};
        next.splice(at, 1);
        const piece = next.some(item => item.nodeId === clip.nodeId) ? copySplitPiece(clip, edit.copyNodeId, nodes, media) : clip;
        if ('ok' in piece) return piece;
        if (piece.nodeId !== clip.nodeId) copiedNode = {fromNodeId: clip.nodeId, toNodeId: piece.nodeId};
        const moved = {...piece, startFrame: edit.startFrame};
        if (!validChainClipFrames(moved)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: moved.id};
        transfer = {trackId: edit.trackId, clip: moved};
        break;
      }
      case 'split': {
        const {offsetFrames, rightClipId} = edit;
        if (!Number.isSafeInteger(offsetFrames) || offsetFrames <= 0 || offsetFrames >= clip.durationFrames || !rightClipId)
          return {ok: false, code: 'INVALID_SPLIT', id: clip.id};
        if (next.some(item => item.id === rightClipId)) return {ok: false, code: 'DUPLICATE_CLIP', id: rightClipId};
        const splitGroupId = clip.splitGroupId ?? clip.id;
        const splitFrame = clip.startFrame + offsetFrames;
        const right = {...clip, id: rightClipId, startFrame: splitFrame, durationFrames: clip.durationFrames - offsetFrames,
          splitGroupId, sourceInFrame: edit.rightSourceInFrame ?? (clip.versionId === null ? 0 : clip.sourceInFrame + offsetFrames)};
        if (!validChainClipFrames(right)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: rightClipId};
        if (exceedsKnownSource(right, media.get(clip.nodeId))) return {ok: false, code: 'SOURCE_BOUNDS', id: rightClipId};
        next.splice(at, 1, {...clip, durationFrames: offsetFrames, splitGroupId}, right);
        splits.push({clipId: clip.id, rightClipId, atFrame: splitFrame});
        break;
      }
      case 'trim': {
        const trimmed = {...clip, durationFrames: edit.durationFrames, sourceInFrame: edit.sourceInFrame ?? clip.sourceInFrame};
        if (!validChainClipFrames(trimmed)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: clip.id};
        if (exceedsKnownSource(trimmed, media.get(clip.nodeId))) return {ok: false, code: 'SOURCE_BOUNDS', id: clip.id};
        next[at] = trimmed;
        break;
      }
      case 'version': {
        const source = media.get(clip.nodeId);
        if (!source) return {ok: false, code: 'MISSING_MEDIA', id: clip.nodeId};
        const updated = {...source, selectedVersion: edit.version};
        if (!validChainMedia(updated, nodes.get(clip.nodeId)!.kind) || edit.locked && edit.version === null)
          return {ok: false, code: 'INVALID_MEDIA', id: clip.nodeId};
        if (edit.locked) {
          next[at] = followChainSyncVersion(clip, edit.version, warnings, true);
        } else {
          media.set(clip.nodeId, updated);
          for (const [index, item] of next.entries()) {
            if (item.nodeId === clip.nodeId && (!item.versionLocked || index === at))
              next[index] = edit.version === null && item.versionLocked
                ? {...item, versionLocked: false} : followChainSyncVersion(item, edit.version, warnings, false);
          }
        }
        break;
      }
    }
  }

  for (const clip of next) if (!validChainClipFrames(clip)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: clip.id};
  const packed = packChainSyncTrack(next);
  if (!packed.ok) return packed;
  const index = indexChainSyncTrack(packed.clips);
  if (!index.ok) return index;
  const board = {nodes: [...nodes.values()], edges: replaceFilmEdges(state.board, state.filmId, oldIds, [...index.groups.keys()])};
  const anchored = planTrackAnchors(previous, packed.clips, state.anchored, splits);
  if (transfer) {
    const item = {id: transfer.clip.id, startFrame: transfer.clip.startFrame};
    const [attached] = planTrackAnchors(packed.clips, packed.clips, [item]);
    anchored.push(attached?.anchorClipId === undefined ? {...item, anchorClipId: null} : attached);
  }
  return makePlan(state, board, [...media.values()], packed.clips, anchored, warnings, {...(transfer ? {transfer} : {}), ...(copiedNode ? {copiedNode} : {})});
}
