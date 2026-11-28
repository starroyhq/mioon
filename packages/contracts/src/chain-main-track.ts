import { compareChainIds } from './board-sequence.ts';
import type { ChainNode } from './board-sequence.ts';
import {clipSourceEndFrame} from './timeline-clip-timing.ts';

export interface ChainSyncVersion {
  readonly id: string;
  /** Null denotes an untimed image source. */
  readonly sourceFrames: number | null;
}
export interface ChainSyncMedia {
  readonly nodeId: string;
  readonly selectedVersion: ChainSyncVersion | null;
  /** Placeholder length, or the default display length of an untimed image. */
  readonly durationFrames: number;
}
export interface ChainSyncClip {
  readonly id: string;
  readonly nodeId: string;
  readonly versionId: string | null;
  readonly versionLocked: boolean;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly sourceSpanFrames?: number;
  /** Adjacent clips must share this identity to count as one split node. */
  readonly splitGroupId?: string;
}

export type MainTrackErrorCode =
  | 'DUPLICATE_MEDIA' | 'INVALID_MEDIA' | 'MISSING_MEDIA'
  | 'DUPLICATE_CLIP' | 'INVALID_CLIP_FRAMES' | 'INVALID_CLIP_VERSION'
  | 'TRACK_OVERLAP' | 'DUPLICATE_TRACK_NODE' | 'INVALID_SPLIT_GROUP'
  | 'TRACK_FRAME_OVERFLOW' | 'NEW_CLIP_ID_REQUIRED' | 'SOURCE_BOUNDS';
export interface MainTrackFailure {
  readonly ok: false;
  readonly code: MainTrackErrorCode;
  readonly id: string;
}
export interface ChainSyncWarning {
  readonly code: 'SOURCE_TOO_SHORT';
  readonly clipId: string;
  readonly nodeId: string;
  readonly versionId: string;
  readonly shortByFrames: number;
}
export type MainTrackPlan =
  | { readonly ok: true; readonly clips: readonly ChainSyncClip[]; readonly warnings: readonly ChainSyncWarning[] }
  | MainTrackFailure;

export const compareSyncClip = (a: ChainSyncClip, b: ChainSyncClip) =>
  a.startFrame - b.startFrame || compareChainIds(a.id, b.id);
const frame = (value: number) => Number.isSafeInteger(value) && value >= 0;
const length = (value: number) => frame(value) && value > 0;
/** Resolve a shot version or a direct media asset. Native callers supply stored media facts. */
export type ChainSyncSourceIsStill = (sourceId: string, kind: ChainNode['kind']) => boolean;
export const stillByNodeKind: ChainSyncSourceIsStill = (_sourceId, kind) => kind === 'image';

export function validChainMedia(media: ChainSyncMedia, kind: ChainNode['kind'], isStill: ChainSyncSourceIsStill): boolean {
  const version = media.selectedVersion;
  return !!media.nodeId && length(media.durationFrames)
    && (version === null ? kind === 'shot' : !!version.id && (isStill(version.id, kind)
      ? version.sourceFrames === null : version.sourceFrames !== null && length(version.sourceFrames)));
}

export function validChainClipFrames(clip: ChainSyncClip): boolean {
  return frame(clip.startFrame) && length(clip.durationFrames) && frame(clip.sourceInFrame)
    && (clip.sourceSpanFrames === undefined || length(clip.sourceSpanFrames))
    && frame(clip.startFrame + clip.durationFrames) && frame(clipSourceEndFrame(clip));
}

/** Sort by timeline position. Measured overlap and split identity are independent
 * of the order in which records were read. Gaps are accepted for reconciliation. */
export function indexChainSyncTrack(input: readonly ChainSyncClip[]):
  { readonly ok: true; readonly clips: ChainSyncClip[]; readonly groups: Map<string, ChainSyncClip[]> } | MainTrackFailure {
  const clips = [...input].sort((a, b) => compareChainIds(a.id, b.id));
  const groups = new Map<string, ChainSyncClip[]>();
  const splitOwners = new Map<string, string>();
  for (let index = 1; index < clips.length; index++) {
    const id = clips[index]!.id;
    if (id === clips[index - 1]!.id) return {ok: false, code: 'DUPLICATE_CLIP', id};
  }
  for (const clip of clips) {
    const { id, nodeId } = clip;
    if (!id || !nodeId || !validChainClipFrames(clip)) return {ok: false, code: 'INVALID_CLIP_FRAMES', id};
    if (clip.versionId === '' || typeof clip.versionLocked !== 'boolean'
      || clip.versionId === null && (clip.versionLocked || clip.sourceInFrame !== 0)) return {ok: false, code: 'INVALID_CLIP_VERSION', id};
  }
  clips.sort(compareSyncClip);
  let previous: ChainSyncClip | undefined;
  for (const clip of clips) {
    const { id, nodeId, splitGroupId } = clip;
    if (previous && previous.startFrame + previous.durationFrames > clip.startFrame) return {ok: false, code: 'TRACK_OVERLAP', id};
    if (splitGroupId !== undefined) {
      const owner = splitOwners.get(splitGroupId);
      if (!splitGroupId || owner !== undefined && owner !== nodeId) return {ok: false, code: 'INVALID_SPLIT_GROUP', id};
      splitOwners.set(splitGroupId, nodeId);
    }
    const group = groups.get(nodeId);
    if (group) {
      if (previous?.nodeId !== nodeId || splitGroupId === undefined || splitGroupId !== previous.splitGroupId)
        return {ok: false, code: 'DUPLICATE_TRACK_NODE', id: nodeId};
      group.push(clip);
    } else groups.set(nodeId, [clip]);
    previous = clip;
  }
  return {ok: true, clips, groups};
}

export function packChainSyncTrack(clips: readonly ChainSyncClip[]): MainTrackPlan {
  let startFrame = 0;
  const packed: ChainSyncClip[] = [];
  for (const clip of clips) {
    const next = startFrame + clip.durationFrames;
    if (!frame(next)) return {ok: false, code: 'TRACK_FRAME_OVERFLOW', id: clip.id};
    packed.push(startFrame === clip.startFrame ? clip : {...clip, startFrame});
    startFrame = next;
  }
  return {ok: true, clips: packed, warnings: []};
}

function followChainSyncVersion(
  clip: ChainSyncClip, version: ChainSyncVersion, warnings: ChainSyncWarning[], locked: boolean,
): ChainSyncClip {
  const needed = clipSourceEndFrame(clip);
  if (clip.versionId !== version.id && version.sourceFrames !== null && version.sourceFrames < needed) {
    warnings.push({code: 'SOURCE_TOO_SHORT', clipId: clip.id, nodeId: clip.nodeId, versionId: version.id, shortByFrames: needed - version.sourceFrames});
    return clip;
  }
  const sourceInFrame = version.sourceFrames === null ? 0 : clip.sourceInFrame;
  return clip.versionId === version.id && clip.versionLocked === locked && clip.sourceInFrame === sourceInFrame
    ? clip : {...clip, versionId: version.id, versionLocked: locked, sourceInFrame};
}

/** Fit the full first source to the placeholder parts, keeping cuts that
 * still fall within the source. Real parts retain their individual windows. */
export function followChainSyncGroup(
  clips: readonly ChainSyncClip[], version: ChainSyncVersion | null, warnings: ChainSyncWarning[],
  defaultDurationFrames: number, shouldFollow: (clip: ChainSyncClip) => boolean, locked = false,
): readonly ChainSyncClip[] {
  if (!version) return clips;
  const fullDuration = version.sourceFrames ?? defaultDurationFrames;
  let placeholders = clips.filter(clip => clip.versionId === null && shouldFollow(clip)).length;
  let sourceOffset = 0;
  const updated: ChainSyncClip[] = [];
  for (const clip of clips) {
    if (!shouldFollow(clip)) {
      updated.push(clip);
    } else if (clip.versionId !== null) {
      updated.push(followChainSyncVersion(clip, version, warnings, locked));
    } else {
      placeholders--;
      const remaining = fullDuration - sourceOffset;
      if (remaining <= 0) continue;
      const durationFrames = placeholders === 0 ? remaining : Math.min(clip.durationFrames, remaining);
      updated.push({...clip, versionId: version.id, versionLocked: locked, durationFrames,
        sourceInFrame: version.sourceFrames === null ? 0 : sourceOffset});
      sourceOffset += durationFrames;
    }
  }
  return updated;
}

/** Reconcile an ordered chain against the mapped main track. Clip IDs for newly
 * visible nodes are supplied by the caller so retries yield identical plans. */
export function planChainMainTrack(
  chain: readonly ChainNode[], media: readonly ChainSyncMedia[], previous: readonly ChainSyncClip[],
  newClipIds?: Readonly<Record<string, string>>,
  {followVersions = true, isStill = stillByNodeKind}: {readonly followVersions?: boolean; readonly isStill?: ChainSyncSourceIsStill} = {},
): MainTrackPlan {
  const index = indexChainSyncTrack(previous);
  if (!index.ok) return index;
  const mediaById = new Map<string, ChainSyncMedia>();
  for (const item of [...media].sort((a, b) => compareChainIds(a.nodeId, b.nodeId))) {
    if (mediaById.has(item.nodeId)) return {ok: false, code: 'DUPLICATE_MEDIA', id: item.nodeId};
    mediaById.set(item.nodeId, item);
  }
  const seen = new Set<string>();
  const reserved = new Set(previous.map(clip => clip.id));
  const planned: ChainSyncClip[] = [];
  const warnings: ChainSyncWarning[] = [];
  for (const node of chain) {
    if (seen.has(node.id)) return {ok: false, code: 'DUPLICATE_TRACK_NODE', id: node.id};
    seen.add(node.id);
    const item = mediaById.get(node.id);
    if (!item) return {ok: false, code: 'MISSING_MEDIA', id: node.id};
    if (!['shot', 'video', 'image'].includes(node.kind) || !validChainMedia(item, node.kind, isStill)) return {ok: false, code: 'INVALID_MEDIA', id: node.id};
    const old = index.groups.get(node.id);
    if (old) {
      const followed = followVersions
        ? followChainSyncGroup(old, item.selectedVersion, warnings, item.durationFrames, clip => !clip.versionLocked) : old;
      for (const clip of followed) planned.push(clip);
      continue;
    }
    const id = newClipIds && Object.hasOwn(newClipIds, node.id) ? newClipIds[node.id] : undefined;
    if (!id) return {ok: false, code: 'NEW_CLIP_ID_REQUIRED', id: node.id};
    if (reserved.has(id)) return {ok: false, code: 'DUPLICATE_CLIP', id};
    reserved.add(id);
    planned.push({id, nodeId: node.id, versionId: item.selectedVersion?.id ?? null, versionLocked: false,
      startFrame: 0, durationFrames: item.selectedVersion?.sourceFrames ?? item.durationFrames, sourceInFrame: 0});
  }
  const packed = packChainSyncTrack(planned);
  return packed.ok ? {...packed, warnings} : packed;
}
