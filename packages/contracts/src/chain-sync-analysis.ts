const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export interface AnchorTrackSegment {
  readonly id: string;
  readonly startFrame: number;
  readonly durationFrames: number;
}

export interface TrackAnchoredItem {
  readonly id: string;
  readonly startFrame: number;
  /** An omitted anchor is inferred from the old main track. Null is explicitly detached. */
  readonly anchorClipId?: string | null;
}

export interface TrackAnchorSplit {
  /** The retained ID of the left part and the new ID of the right part. */
  readonly clipId: string;
  readonly rightClipId: string;
  /** The absolute pre-edit frame at which the right part starts. */
  readonly atFrame: number;
}

function segmentAt(segments: readonly AnchorTrackSegment[], frame: number): AnchorTrackSegment | undefined {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (segments[mid]!.startFrame <= frame) low = mid + 1;
    else high = mid;
  }
  const candidate = segments[low - 1];
  return candidate && frame < candidate.startFrame + candidate.durationFrames ? candidate : undefined;
}

/**
 * Preserve each item's offset from its original anchor. The main-track inputs
 * describe non-overlapping frame ranges with unique clip IDs. A trim keeps
 * the anchor's identity, even when the offset extends beyond its new length.
 */
export function planTrackAnchors(
  before: readonly AnchorTrackSegment[],
  after: readonly AnchorTrackSegment[],
  items: readonly TrackAnchoredItem[],
  splits: readonly TrackAnchorSplit[] = [],
): TrackAnchoredItem[] {
  const byPosition = [...before].sort((left, right) =>
    left.startFrame - right.startFrame || compareId(right.id, left.id));
  const oldClips = new Map(before.map(clip => [clip.id, clip]));
  const newClips = new Map(after.map(clip => [clip.id, clip]));
  const splitsByClip = new Map(splits.map(split => [split.clipId, split]));
  return [...items].sort((left, right) => compareId(left.id, right.id)).map(item => {
    if (item.anchorClipId === null) return item;
    const oldClip = item.anchorClipId === undefined
      ? segmentAt(byPosition, item.startFrame)
      : oldClips.get(item.anchorClipId);
    if (!oldClip) return item.anchorClipId === undefined ? item : { ...item, anchorClipId: null };
    const split = splitsByClip.get(oldClip.id);
    const right = split !== undefined && item.startFrame >= split.atFrame;
    const newClip = newClips.get(right ? split.rightClipId : oldClip.id);
    if (!newClip) return { ...item, anchorClipId: null };
    const oldStart = right ? split.atFrame : oldClip.startFrame;
    const startFrame = newClip.startFrame + (item.startFrame - oldStart);
    if (item.anchorClipId === newClip.id && item.startFrame === startFrame) return item;
    return { ...item, startFrame, anchorClipId: newClip.id };
  });
}

export interface ChainSyncBoardEntry {
  readonly nodeId: string;
  readonly versionId: string | null;
}

export interface ChainSyncTrackEntry extends ChainSyncBoardEntry {
  readonly locked?: boolean;
}

export interface ChainSyncBaseline {
  readonly board: readonly ChainSyncBoardEntry[];
  readonly track: readonly ChainSyncTrackEntry[];
}

export interface ChainSyncDifference {
  readonly nodeId: string;
  readonly change: 'unchanged' | 'board_only' | 'track_only' | 'both';
}

interface ChainMember {
  readonly versions: Set<string | null>;
  readonly followingVersions: Set<string | null>;
  runs: number;
}

interface ChainView {
  readonly order: string[];
  readonly members: Map<string, ChainMember>;
}

function chainView(entries: readonly ChainSyncTrackEntry[]): ChainView {
  const order: string[] = [];
  const members = new Map<string, ChainMember>();
  let previousId: string | undefined;
  for (const entry of entries) {
    let member = members.get(entry.nodeId);
    if (!member) {
      member = { versions: new Set(), followingVersions: new Set(), runs: 0 };
      members.set(entry.nodeId, member);
      order.push(entry.nodeId);
    }
    member.versions.add(entry.versionId);
    if (!entry.locked) member.followingVersions.add(entry.versionId);
    if (entry.nodeId !== previousId) member.runs++;
    previousId = entry.nodeId;
  }
  return { order, members };
}

/** Compare relative order among shared IDs, marking both sides of every crossing. */
function reorderedIds(before: ChainView, after: ChainView): Set<string> {
  const positions = new Map(before.order.map((id, index) => [id, index]));
  const shared = after.order.filter(id => positions.has(id));
  const changed = new Set<string>();
  let earlierMax = -1;
  for (const id of shared) {
    const position = positions.get(id)!;
    if (position < earlierMax) changed.add(id);
    earlierMax = Math.max(earlierMax, position);
  }
  let laterMin = before.order.length;
  for (let index = shared.length - 1; index >= 0; index--) {
    const id = shared[index]!;
    const position = positions.get(id)!;
    if (position > laterMin) changed.add(id);
    laterMin = Math.min(laterMin, position);
  }
  return changed;
}

function sameVersionSet(left: ReadonlySet<string | null>, right: ReadonlySet<string | null>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function changedMember(before: ChainMember | undefined, after: ChainMember | undefined): boolean {
  if (!before || !after) return before !== after;
  return before.runs !== after.runs || !sameVersionSet(before.versions, after.versions)
    || !sameVersionSet(before.followingVersions, after.followingVersions);
}

/**
 * Ordered inputs describe one film and its main track. Adjacent splits count as
 * one node. A locked segment may intentionally differ from the board version.
 * Only current disagreements are returned, with changes attributed to each
 * side's own previous projection.
 */
export function compareChainSync(
  baseline: ChainSyncBaseline,
  board: readonly ChainSyncBoardEntry[],
  track: readonly ChainSyncTrackEntry[],
): ChainSyncDifference[] {
  const previousBoard = chainView(baseline.board);
  const previousTrack = chainView(baseline.track);
  const currentBoard = chainView(board);
  const currentTrack = chainView(track);
  const movedOnBoard = reorderedIds(previousBoard, currentBoard);
  const movedOnTrack = reorderedIds(previousTrack, currentTrack);
  const orderDisagreements = reorderedIds(currentBoard, currentTrack);
  const ids = new Set([...currentBoard.order, ...currentTrack.order]);
  const differences: ChainSyncDifference[] = [];
  for (const nodeId of [...ids].sort(compareId)) {
    const onBoard = currentBoard.members.get(nodeId);
    const onTrack = currentTrack.members.get(nodeId);
    if (onBoard && onTrack && onBoard.runs === 1 && onTrack.runs === 1 && !orderDisagreements.has(nodeId)
      && [...onTrack.followingVersions].every(version => onBoard.versions.has(version))) continue;
    const boardChanged = movedOnBoard.has(nodeId) || changedMember(previousBoard.members.get(nodeId), onBoard);
    const trackChanged = movedOnTrack.has(nodeId) || changedMember(previousTrack.members.get(nodeId), onTrack);
    const change = boardChanged ? (trackChanged ? 'both' : 'board_only') : (trackChanged ? 'track_only' : 'unchanged');
    differences.push({ nodeId, change });
  }
  return differences;
}
