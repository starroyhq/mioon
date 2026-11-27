import {
  boardSequenceIssuesForComponent, compareChainIds, compareSequenceEdges, deriveFilmChains, planBoardSequenceEdit,
} from './board-sequence.ts';
import type { BoardSequenceEdit, BoardSequenceIssue, ChainBoard, ChainNode, SequenceEdge } from './board-sequence.ts';
import {
  compareSyncClip, followChainSyncGroup, indexChainSyncTrack, packChainSyncTrack,
  planChainMainTrack, validChainClipFrames, validChainMedia,
} from './chain-main-track.ts';
import type { ChainSyncClip, ChainSyncMedia, ChainSyncVersion, ChainSyncWarning, MainTrackFailure } from './chain-main-track.ts';
import { planTrackAnchors } from './chain-sync-analysis.ts';
import type { TrackAnchoredItem, TrackAnchorSplit } from './chain-sync-analysis.ts';
import type {SourceRange} from './source-range.ts';

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
type SourceProjection = Pick<ChainSyncClip, 'sourceInFrame' | 'sourceSpanFrames'>;
export type TrackSyncEdit =
  | { readonly kind: 'move'; readonly clipId: string; readonly beforeClipId: string | null; readonly copyNodeId?: string }
  | { readonly kind: 'move-off-track'; readonly clipId: string; readonly trackId: string; readonly startFrame: number; readonly copyNodeId?: string }
  | { readonly kind: 'remove'; readonly clipId: string }
  | { readonly kind: 'add'; readonly clip: ChainSyncClip; readonly beforeClipId: string | null; readonly media?: ChainSyncMedia;
    readonly nodeKind?: 'shot' | 'video' | 'image'; readonly nodeAssetId?: string; readonly nodeName?: string;
    readonly copyFromClipId?: string }
  /** ED: insert one asset or paste one copied clip. The minimal form carries the
   * user intent; the service expands it into `add`/`add-overlay` before planning
   * so the exact envelope (IDs and media) is what the UI confirms. */
  | { readonly kind: 'insert-asset'; readonly assetId: string; readonly trackId: string | null; readonly startFrame: number;
    readonly assetRange?: SourceRange }
  | { readonly kind: 'paste-clip'; readonly clipId: string; readonly startFrame: number }
  /** ED: add one clip to a non-main track, anchored below its owning main clip. */
  | { readonly kind: 'add-overlay'; readonly clipId: string; readonly trackId: string; readonly startFrame: number;
    readonly durationFrames: number; readonly sourceInFrame: number; readonly name: string;
    readonly assetId?: string; readonly copyFromClipId?: string }
  | { readonly kind: 'split'; readonly clipId: string; readonly offsetFrames: number; readonly rightClipId: string; readonly rightSourceInFrame?: number }
  | { readonly kind: 'trim'; readonly clipId: string; readonly durationFrames: number; readonly sourceInFrame?: number }
  | { readonly kind: 'version'; readonly clipId: string; readonly version: ChainSyncVersion | null; readonly locked: boolean }
  /** FR-B2: one clip split at every scene cut inside its source range. The TS
   * planner expands this into the ordinary sequential `split` commands. */
  | { readonly kind: 'split-at-scenes'; readonly assetId: string; readonly resultId: string };
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
  | 'CLIP_NOT_FOUND' | 'INVALID_SPLIT' | 'INSERT_BETWEEN_SPLIT_PARTS' | 'NODE_ALREADY_LINKED'
  | 'COPY_NODE_EXISTS' | 'INVALID_ANCHOR' | 'INVALID_TRACK_TARGET'; readonly id: string };
type GraphFailure = { readonly ok: false; readonly code: BoardSequenceIssue['code']; readonly issues: readonly BoardSequenceIssue[] };
type CopyRequired = { readonly ok: false; readonly code: 'COPY_NODE_REQUIRED'; readonly nodeId: string; readonly clipId: string };
export interface ChainSyncTransfer { readonly trackId: string; readonly clip: ChainSyncClip }
export interface ChainSyncNodeCopy { readonly fromNodeId: string; readonly toNodeId: string }
interface PlannedTrackDetails {
  readonly transfer?: ChainSyncTransfer;
  readonly copiedNode?: ChainSyncNodeCopy;
}
export type ChainSyncPlan =
  | ({
    readonly ok: true; readonly after: ChainSyncState; readonly changes: ChainSyncChanges;
    readonly warnings: readonly ChainSyncWarning[]; readonly issues: readonly BoardSequenceIssue[];
  } & PlannedTrackDetails)
  | SyncFailure | MainTrackFailure | GraphFailure | CopyRequired;

const byId = <T extends { readonly id: string }>(a: T, b: T) => compareChainIds(a.id, b.id);
const byMedia = (a: ChainSyncMedia, b: ChainSyncMedia) => compareChainIds(a.nodeId, b.nodeId);
const byMediaValue = (a: ChainSyncMedia, b: ChainSyncMedia) => byMedia(a, b)
  || a.durationFrames - b.durationFrames || compareChainIds(a.selectedVersion?.id ?? '', b.selectedVersion?.id ?? '')
  || (a.selectedVersion?.sourceFrames ?? -1) - (b.selectedVersion?.sourceFrames ?? -1);
const byNode = (a: ChainNode, b: ChainNode) => byId(a, b) || compareChainIds(a.kind, b.kind);
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

/** A repair can remove repeated rows. Pair equal occurrences in sorted order. */
function changesByValue<T>(before: readonly T[], after: readonly T[], compare: (a: T, b: T) => number): ChainSyncChange<T>[] {
  const previous = [...before].sort(compare);
  const result: ChainSyncChange<T>[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < previous.length && newIndex < after.length) {
    const old = previous[oldIndex]!;
    const added = after[newIndex]!;
    const order = compare(old, added);
    if (order < 0) result.push({before: old, after: null});
    if (order > 0) result.push({before: null, after: added});
    if (order <= 0) oldIndex++;
    if (order >= 0) newIndex++;
  }
  for (; oldIndex < previous.length; oldIndex++) result.push({before: previous[oldIndex]!, after: null});
  for (; newIndex < after.length; newIndex++) result.push({before: null, after: after[newIndex]!});
  return result;
}

function makePlan(
  before: ChainSyncState, board: ChainBoard, media: readonly ChainSyncMedia[], clips: readonly ChainSyncClip[],
  anchored: readonly TrackAnchoredItem[], warnings: readonly ChainSyncWarning[], issues: readonly BoardSequenceIssue[],
  details: PlannedTrackDetails = {},
): ChainSyncPlan {
  const boardOnly = clips === before.clips && anchored === before.anchored;
  if (!boardOnly) {
    const invalidAnchor = [...anchored].sort(byId).find(item => !naturalFrame(item.startFrame));
    if (invalidAnchor) return {ok: false, code: 'INVALID_ANCHOR', id: invalidAnchor.id};
    const anchoredIds = new Set(anchored.map(item => item.id));
    const duplicate = clips.find(clip => anchoredIds.has(clip.id));
    if (duplicate) return {ok: false, code: 'DUPLICATE_CLIP', id: duplicate.id};
  }
  const after = {board: {nodes: [...board.nodes].sort(byNode), edges: [...board.edges].sort(compareSequenceEdges)},
    filmId: before.filmId, media: [...media].sort(byMediaValue), clips: [...clips].sort(compareSyncClip), anchored: [...anchored].sort(byId)};
  const mediaChanges = boardOnly ? changesByValue(before.media, after.media, byMediaValue)
    : changes(before.media, after.media, item => item.nodeId, (a, b) =>
      a.durationFrames === b.durationFrames && versionEqual(a.selectedVersion, b.selectedVersion));
  return {ok: true, after, ...details, issues, warnings: [...warnings].sort((a, b) => compareChainIds(a.clipId, b.clipId)),
    changes: {
      nodes: changesByValue(before.board.nodes, after.board.nodes, byNode),
      edges: changesByValue(before.board.edges, after.board.edges, compareSequenceEdges),
      media: mediaChanges,
      clips: boardOnly ? [] : changes(before.clips, after.clips, clip => clip.id, (a, b) =>
        a.nodeId === b.nodeId && a.versionId === b.versionId && a.versionLocked === b.versionLocked
        && a.startFrame === b.startFrame && a.durationFrames === b.durationFrames
        && a.sourceInFrame === b.sourceInFrame && a.sourceSpanFrames === b.sourceSpanFrames && a.splitGroupId === b.splitGroupId),
      anchored: boardOnly ? [] : changes(before.anchored, after.anchored, item => item.id, (a, b) =>
        a.startFrame === b.startFrame && a.anchorClipId === b.anchorClipId),
    }};
}

/** Deltas carry the exact old record on every modification. The transaction host
 * can apply them together and reverse them by exchanging before and after. */
export function planChainSync(state: ChainSyncState, operation: ChainSyncOperation,
  sourceProjections?: ReadonlyMap<string, SourceProjection>): ChainSyncPlan {
  const graph = deriveFilmChains(state.board);
  const activeIssues = boardSequenceIssuesForComponent(state.board, graph.issues, [state.filmId]);
  let board = state.board;
  let issues = graph.issues;
  let editedChain: readonly string[] | undefined;
  if (operation.kind === 'board') {
    const edit = planBoardSequenceEdit(board, operation.edit);
    if (!edit.ok) return edit;
    board = edit.board;
    issues = edit.issues;
    const editedFilms = new Map(deriveFilmChains(board).chains.map(item => [item.filmId, item.nodeIds]));
    for (const other of graph.chains) {
      if (other.filmId === state.filmId) continue;
      const edited = editedFilms.get(other.filmId);
      if ((!edited || !sameOrder(other.nodeIds, edited))
        && !boardSequenceIssuesForComponent(state.board, graph.issues, [other.filmId]).length) {
        return {ok: false, code: 'FILM_SCOPE_MISMATCH', id: other.filmId};
      }
    }
    editedChain = editedFilms.get(state.filmId);
    const boardEdit = operation.edit;
    if (boardEdit.kind === 'delete' && boardEdit.nodeId === state.filmId
      && state.board.nodes.some(node => node.id === state.filmId && node.kind === 'film')) {
      return {ok: false, code: 'ACTIVE_FILM_REMOVED', id: state.filmId};
    }
    if (activeIssues.length) {
      // A partial derivation of a broken chain is unsafe as a track input, even
      // when this edit removes the final issue. A clean chain can be synced next.
      const media = boardEdit.kind === 'delete' ? state.media.filter(item => item.nodeId !== boardEdit.nodeId) : state.media;
      return makePlan(state, board, media, state.clips, state.anchored, [], issues);
    }
  } else if (activeIssues.length) {
    return {ok: false, code: activeIssues[0]!.code, issues: activeIssues};
  }
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
    // A non-main-track item (for example a sound-only audio clip) is removed by
    // the same one-clip remove command; the main-track list does not own it.
    if (operation.edit.kind === 'remove') {
      const removedClipId = operation.edit.clipId;
      if (!mainIds.has(removedClipId) && state.anchored.some(item => item.id === removedClipId)) {
        return makePlan(state, board, [...media.values()], track.clips,
          state.anchored.filter(item => item.id !== removedClipId), [], issues);
      }
    }
    return planTrackEdit(state, operation.edit, track.clips, oldIds, nodes, media, issues, sourceProjections);
  }

  let chain = previousChain;
  if (operation.kind === 'board') {
    if (!editedChain) return {ok: false, code: 'ACTIVE_FILM_REMOVED', id: state.filmId};
    chain = editedChain;
    if (operation.edit.kind === 'delete') media.delete(operation.edit.nodeId);
    if (sameOrder(previousChain, chain)) return makePlan(state, board, [...media.values()], track.clips, state.anchored, [], issues);
  } else if (operation.kind === 'board-version') {
    const touchedIssues = boardSequenceIssuesForComponent(board, issues, [operation.nodeId]);
    if (touchedIssues.length) return {ok: false, code: touchedIssues[0]!.code, issues: touchedIssues};
    const item = media.get(operation.nodeId);
    if (!item) return {ok: false, code: 'MISSING_MEDIA', id: operation.nodeId};
    const candidate = {...item, selectedVersion: operation.version};
    const node = nodes.get(operation.nodeId);
    if (!playable(node) || !validChainMedia(candidate, node.kind)) return {ok: false, code: 'INVALID_MEDIA', id: operation.nodeId};
    media.set(operation.nodeId, candidate);
    const other = graph.chains.find(item => item.filmId !== state.filmId && item.nodeIds.includes(operation.nodeId));
    if (other) return {ok: false, code: 'FILM_SCOPE_MISMATCH', id: other.filmId};
    if (!chain.includes(operation.nodeId)) return makePlan(state, board, [...media.values()], track.clips, state.anchored, [], issues);
    if (!inSync) return {ok: false, code: 'CHAIN_TRACK_MISMATCH', id: state.filmId};
    const warnings: ChainSyncWarning[] = [];
    const old = track.groups.get(operation.nodeId)!;
    const updated = followChainSyncGroup(old, operation.version, warnings, item.durationFrames, clip => !clip.versionLocked);
    const first = track.clips.indexOf(old[0]!);
    const clips = [...track.clips.slice(0, first), ...updated, ...track.clips.slice(first + old.length)];
    if (old.length === updated.length && old.every((clip, index) => clip.durationFrames === updated[index]!.durationFrames)) {
      return makePlan(state, board, [...media.values()], clips, state.anchored, warnings, issues);
    }
    const packed = packChainSyncTrack(clips);
    if (!packed.ok) return packed;
    return makePlan(state, board, [...media.values()], packed.clips,
      planTrackAnchors(track.clips, packed.clips, state.anchored), warnings, issues);
  }
  if (operation.kind !== 'sync-board' && !inSync) return {ok: false, code: 'CHAIN_TRACK_MISMATCH', id: state.filmId};
  const items = [...media.values()];
  const next = planChainMainTrack(chain.map(id => nodes.get(id)!), items, track.clips, operation.newClipIds,
    {followVersions: operation.kind === 'sync-board'});
  if (!next.ok) return next;
  return makePlan(state, board, items, next.clips, planTrackAnchors(track.clips, next.clips, state.anchored), next.warnings, issues);
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
  board: ChainBoard, nodes: Map<string, ChainNode>, media: Map<string, ChainSyncMedia>,
): ChainSyncClip | SyncFailure | MainTrackFailure | CopyRequired {
  if (!nodeId) return {ok: false, code: 'COPY_NODE_REQUIRED', nodeId: clip.nodeId, clipId: clip.id};
  if (nodes.has(nodeId) || media.has(nodeId)) return {ok: false, code: 'COPY_NODE_EXISTS', id: nodeId};
  // A dangling edge still reserves its endpoints until the board is repaired.
  if (board.edges.some(edge => edge.fromId === nodeId || edge.toId === nodeId))
    return {ok: false, code: 'NODE_ALREADY_LINKED', id: nodeId};
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
    && version.sourceFrames < clip.sourceInFrame + (clip.sourceSpanFrames ?? clip.durationFrames);
}

function betweenSplitParts(clips: readonly ChainSyncClip[], at: number, nodeId: string): boolean {
  const left = clips[at - 1];
  const right = clips[at];
  return left !== undefined && right !== undefined && left.nodeId !== nodeId
    && left.nodeId === right.nodeId && left.splitGroupId !== undefined && left.splitGroupId === right.splitGroupId;
}

function planTrackEdit(
  state: ChainSyncState, edit: TrackSyncEdit, previous: readonly ChainSyncClip[], oldIds: readonly string[],
  nodes: Map<string, ChainNode>, media: Map<string, ChainSyncMedia>, issues: readonly BoardSequenceIssue[],
  sourceProjections?: ReadonlyMap<string, SourceProjection>,
): ChainSyncPlan {
  // ED insert/paste/overlay actions are expanded by the format-5 service into
  // ordinary add edits before SA planning; they never reach this planner.
  if (edit.kind === 'insert-asset' || edit.kind === 'paste-clip' || edit.kind === 'add-overlay')
    return {ok: false, code: 'INVALID_TRACK_TARGET', id: ''};
  const next = [...previous];
  const splits: TrackAnchorSplit[] = [];
  const warnings: ChainSyncWarning[] = [];
  let transfer: ChainSyncTransfer | undefined;
  let copiedNode: ChainSyncNodeCopy | undefined;
  let addedNode: ChainNode | undefined;
  if (edit.kind === 'add') {
    const {clip} = edit;
    if (next.some(item => item.id === clip.id)) return {ok: false, code: 'DUPLICATE_CLIP', id: clip.id};
    if (state.board.edges.some(edge => edge.fromId === clip.nodeId || edge.toId === clip.nodeId)) return {ok: false, code: 'NODE_ALREADY_LINKED', id: clip.nodeId};
    const at = edit.beforeClipId === null ? next.length : next.findIndex(item => item.id === edit.beforeClipId);
    if (at < 0) return {ok: false, code: 'CLIP_NOT_FOUND', id: edit.beforeClipId!};
    if (betweenSplitParts(next, at, clip.nodeId)) return {ok: false, code: 'INSERT_BETWEEN_SPLIT_PARTS', id: clip.id};
    const touchedIssues = boardSequenceIssuesForComponent(state.board, issues, [clip.nodeId]);
    if (touchedIssues.length) return {ok: false, code: touchedIssues[0]!.code, issues: touchedIssues};
    if (!nodes.has(clip.nodeId)) addedNode = {id: clip.nodeId, kind: edit.nodeKind ?? 'shot'};
    const node = addedNode ?? nodes.get(clip.nodeId)!;
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
    if (edit.kind === 'split-at-scenes') return {ok: false, code: 'INVALID_TRACK_TARGET', id: ''};
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
        if (betweenSplitParts(next, to, clip.nodeId)) return {ok: false, code: 'INSERT_BETWEEN_SPLIT_PARTS', id: clip.id};
        const splitOff = clip.splitGroupId !== undefined && next.some(item => item.nodeId === clip.nodeId)
          && next[to - 1]?.nodeId !== clip.nodeId && next[to]?.nodeId !== clip.nodeId;
        if (!splitOff) {
          next.splice(to, 0, clip);
          break;
        }
        const copy = copySplitPiece(clip, edit.copyNodeId, state.board, nodes, media);
        if ('ok' in copy) return copy;
        copiedNode = {fromNodeId: clip.nodeId, toNodeId: copy.nodeId};
        next.splice(to, 0, copy);
        break;
      }
      case 'move-off-track': {
        if (!edit.trackId || !naturalFrame(edit.startFrame)) return {ok: false, code: 'INVALID_TRACK_TARGET', id: edit.trackId};
        next.splice(at, 1);
        const piece = next.some(item => item.nodeId === clip.nodeId) ? copySplitPiece(clip, edit.copyNodeId, state.board, nodes, media) : clip;
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
        const still = nodes.get(clip.nodeId)?.kind === 'image';
        if (still && (edit.rightSourceInFrame ?? 0) !== 0) return {ok: false, code: 'SOURCE_BOUNDS', id: clip.id};
        const splitGroupId = clip.splitGroupId ?? clip.id;
        const splitFrame = clip.startFrame + offsetFrames;
        const right = {...clip, id: rightClipId, startFrame: splitFrame, durationFrames: clip.durationFrames - offsetFrames,
          splitGroupId, sourceInFrame: edit.rightSourceInFrame ?? (still || clip.versionId === null ? 0 : clip.sourceInFrame + offsetFrames),
          ...sourceProjections?.get(rightClipId)};
        if (!validChainClipFrames(right)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id: rightClipId};
        if (exceedsKnownSource(right, media.get(clip.nodeId))) return {ok: false, code: 'SOURCE_BOUNDS', id: rightClipId};
        next.splice(at, 1, {...clip, durationFrames: offsetFrames, splitGroupId, ...sourceProjections?.get(clip.id)}, right);
        splits.push({clipId: clip.id, rightClipId, atFrame: splitFrame});
        break;
      }
      case 'trim': {
        const trimmed = {...clip, durationFrames: edit.durationFrames, sourceInFrame: edit.sourceInFrame ?? clip.sourceInFrame,
          ...sourceProjections?.get(clip.id)};
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
        if (!edit.locked) media.set(clip.nodeId, updated);
        if (edit.version === null) {
          if (clip.versionLocked) next[at] = {...clip, versionLocked: false};
        } else {
          const first = next.findIndex(item => item.nodeId === clip.nodeId);
          let end = first + 1;
          while (next[end]?.nodeId === clip.nodeId) end++;
          const followed = followChainSyncGroup(next.slice(first, end), edit.version, warnings,
            source.durationFrames, item => item === clip || !edit.locked && !item.versionLocked, edit.locked);
          next.splice(first, end - first, ...followed);
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
  const appended = copiedNode ? nodes.get(copiedNode.toNodeId)! : addedNode;
  const board = {
    nodes: appended ? [...state.board.nodes, appended] : state.board.nodes,
    edges: replaceFilmEdges(state.board, state.filmId, oldIds, [...index.groups.keys()]),
  };
  const anchored = planTrackAnchors(previous, packed.clips, state.anchored, splits);
  if (transfer) {
    const item = {id: transfer.clip.id, startFrame: transfer.clip.startFrame};
    const [attached] = planTrackAnchors(packed.clips, packed.clips, [item]);
    anchored.push(attached?.anchorClipId === undefined ? {...item, anchorClipId: null} : attached);
  }
  return makePlan(state, board, [...media.values()], packed.clips, anchored, warnings, issues, {...(transfer ? {transfer} : {}), ...(copiedNode ? {copiedNode} : {})});
}
