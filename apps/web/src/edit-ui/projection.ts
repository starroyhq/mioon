import {validChainClipFrames} from '../../../../packages/contracts/src/chain-main-track.ts';

/** Pure presentation projection for the editing surface. Inputs are assembled
 * from one timeline snapshot; no project store, command or format field is
 * written here. Field names follow the format 5 plan (§2.2/§2.3) so UI-E2 can
 * map the persisted shape one to one. */

export interface EditUiVersion {
  readonly id: string;
  readonly number: number;
}

interface EditUiSequenceSource {
  readonly nodeId: string;
  readonly segmentGroupId: string;
}

export interface EditUiShotSource extends EditUiSequenceSource {
  readonly kind: 'shot';
  readonly number: string;
  readonly name: string;
  readonly versionMode: 'follow' | 'locked';
  /** Version the board selects for a following clip. */
  readonly boardVersion: EditUiVersion | null;
  /** Version actually applied to this clip. */
  readonly appliedVersion: EditUiVersion | null;
}

export interface EditUiMediaSource extends EditUiSequenceSource {
  readonly kind: 'media';
}

export interface EditUiAnchor {
  readonly clipId: string;
  readonly offsetFrames: number;
}

export interface EditUiCue {
  readonly id: string;
  readonly startFrame: number;
  /** `null` keeps the cue visible where it is without a link to the main track. */
  readonly anchor?: EditUiAnchor | null;
}

export interface EditUiClip extends EditUiCue {
  readonly trackId: string;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly sourceState?: 'ready' | 'placeholder';
  readonly sequenceSource?: EditUiShotSource | EditUiMediaSource;
}

/** Presentation input assembled by callers from a single timeline snapshot. */
export interface EditUiTimeline {
  readonly fps: number;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  /** Persisted format 5 `mainTrack`; `null` before the explicit association exists. */
  readonly mainTrack: {readonly trackId: string; readonly sequenceNodeId: string} | null;
  readonly tracks: readonly {readonly id: string; readonly kind: 'video' | 'audio'}[];
  readonly clips: readonly EditUiClip[];
  readonly cues: readonly EditUiCue[];
}

export type EditUiAnchorProjection =
  | {readonly kind: 'attached'; readonly clipId: string; readonly startFrame: number}
  | {readonly kind: 'detached'};

export type EditUiClipStatus =
  | {readonly kind: 'follow' | 'locked'; readonly version: EditUiVersion}
  | {readonly kind: 'placeholder'; readonly durationSeconds: number};

export interface EditUiClipProjection {
  readonly status?: EditUiClipStatus;
  readonly shot?: EditUiShotSource;
  readonly anchor?: EditUiAnchorProjection;
}

export interface EditUiProjection {
  readonly mainTrackId: string | null;
  readonly sequenceNodeId: string | null;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  readonly clips: ReadonlyMap<string, EditUiClipProjection>;
  readonly cueAnchors: ReadonlyMap<string, EditUiAnchorProjection>;
}

/** One drawable link from a subtitle/overlay start down to a main-track segment. */
export interface EditUiAnchorEntry {
  readonly id: string;
  readonly kind: 'clip' | 'cue';
  readonly startFrame: number;
  readonly targetClipId: string;
}

function projectAnchor(item: EditUiCue, mainSegments: ReadonlyMap<string, EditUiClip>): EditUiAnchorProjection | undefined {
  if (item.anchor === null) return {kind: 'detached'};
  if (!item.anchor) return undefined;
  const {clipId, offsetFrames} = item.anchor;
  const segment = mainSegments.get(clipId);
  // The line can join only when both ends use the same frame in this snapshot.
  if (!segment || !Number.isSafeInteger(offsetFrames) || offsetFrames < 0 || offsetFrames >= segment.durationFrames
    || item.startFrame !== segment.startFrame + offsetFrames) return undefined;
  return {kind: 'attached', clipId, startFrame: item.startFrame};
}

function projectShotStatus(clip: EditUiClip, shot: EditUiShotSource, fps: number): EditUiClipStatus | undefined {
  if (clip.sourceState === 'placeholder') return {kind: 'placeholder', durationSeconds: clip.durationFrames / fps};
  if (clip.sourceState !== 'ready' || !shot.appliedVersion) return undefined;
  // A following clip shows the board version it follows; the applied media stays
  // separate evidence (clip.shot.appliedVersion). A locked clip shows its lock.
  if (shot.versionMode === 'locked') return {kind: 'locked', version: shot.appliedVersion};
  return {kind: 'follow', version: shot.boardVersion ?? shot.appliedVersion};
}

export function projectEditUi(input: EditUiTimeline): EditUiProjection {
  const {mainTrack, tracks, timelineRevision, syncRevision} = input;
  const mainTrackId = mainTrack && tracks.some(track => track.id === mainTrack.trackId && track.kind === 'video')
    ? mainTrack.trackId : null;
  const mainSegments = new Map<string, EditUiClip>();
  const clips = new Map<string, EditUiClipProjection>();
  const cueAnchors = new Map<string, EditUiAnchorProjection>();

  if (mainTrackId !== null) {
    for (const clip of input.clips) {
      const source = clip.sequenceSource;
      if (clip.trackId !== mainTrackId || !source) continue;
      const shot = source.kind === 'shot' ? source : undefined;
      if (!validChainClipFrames({...clip, nodeId: source.nodeId, versionId: shot?.appliedVersion?.id ?? null,
        versionLocked: shot?.versionMode === 'locked'})) continue;
      mainSegments.set(clip.id, clip);
      if (shot) clips.set(clip.id, {shot, status: projectShotStatus(clip, shot, input.fps)});
    }
    for (const clip of input.clips) {
      if (clip.trackId === mainTrackId) continue;
      const anchor = projectAnchor(clip, mainSegments);
      if (anchor) clips.set(clip.id, {anchor});
    }
    for (const cue of input.cues) {
      const anchor = projectAnchor(cue, mainSegments);
      if (anchor) cueAnchors.set(cue.id, anchor);
    }
  }

  return {mainTrackId, sequenceNodeId: mainTrackId === null ? null : mainTrack?.sequenceNodeId ?? null,
    timelineRevision, syncRevision, clips, cueAnchors};
}

/** Anchors that currently draw a link; detached items keep their label only. */
export function editUiAnchorEntries(projection: EditUiProjection): readonly EditUiAnchorEntry[] {
  const entries: EditUiAnchorEntry[] = [];
  for (const [id, item] of projection.clips) {
    if (item.anchor?.kind === 'attached') entries.push({id, kind: 'clip', startFrame: item.anchor.startFrame, targetClipId: item.anchor.clipId});
  }
  for (const [id, item] of projection.cueAnchors) {
    if (item.kind === 'attached') entries.push({id, kind: 'cue', startFrame: item.startFrame, targetClipId: item.clipId});
  }
  return entries;
}

export interface EditUiTimelineTrack {
  readonly id: string;
  readonly kind?: string;
  readonly orderIndex?: number;
}

/** Badge shown next to a track name, matching the timeline's own V/A numbering. */
export function editUiTrackBadge(tracks: readonly EditUiTimelineTrack[], trackId: string): string | null {
  const media = tracks.filter(track => track.kind === 'video')
    .sort((left, right) => Number(right.orderIndex ?? 0) - Number(left.orderIndex ?? 0));
  const index = media.findIndex(track => track.id === trackId);
  return index < 0 ? null : `V${media.length - index}`;
}
