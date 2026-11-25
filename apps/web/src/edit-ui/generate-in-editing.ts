/** GE-b: pure placement/ intent helpers shared by the timeline blank menu and
 * the editing generation panel. Keeping the decision here lets the entry rules
 * be tested without a DOM. */
import type {SequenceEditGenerateIntent} from '../../../../packages/contracts/src/sequence-edit.ts';

export interface TimelineGenerateTarget {
  readonly trackId: string;
  readonly main: boolean;
  readonly startFrame: number;
  readonly beforeClipId: string | null;
}
interface BlankClip {readonly trackId: string; readonly startFrame: number; readonly durationFrames: number}
export interface TimelineBlankContext {
  readonly trackId: string;
  readonly trackKind: 'video' | 'audio';
  readonly mainTrackId: string | null;
  readonly frame: number;
  readonly clips: readonly BlankClip[];
}
const occupiedAt = (clip: BlankClip, frame: number): boolean =>
  frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames;

/** Which "generate shot" entry the blank timeline menu offers at one point.
 * Only the main track's end gets "at end"; other video tracks get "here" only
 * inside a main-track shot, so the anchored clip always has an owner. */
export function timelineGenerateTargetForBlank(context: TimelineBlankContext): TimelineGenerateTarget | null {
  const {trackId, trackKind, mainTrackId, frame, clips} = context;
  if (trackKind !== 'video' || !mainTrackId
    || clips.some(clip => clip.trackId === trackId && occupiedAt(clip, frame))) return null;
  const mainClips = clips.filter(clip => clip.trackId === mainTrackId).sort((left, right) => left.startFrame - right.startFrame);
  if (trackId === mainTrackId) {
    const last = mainClips.at(-1);
    const end = last ? last.startFrame + last.durationFrames : 0;
    return frame >= end ? {trackId, main: true, startFrame: end, beforeClipId: null} : null;
  }
  return mainClips.some(clip => occupiedAt(clip, frame))
    ? {trackId, main: false, startFrame: frame, beforeClipId: null} : null;
}
/** The shot a selected placeholder clip belongs to. Main-track placeholders
 * carry their source on `sequenceSource.nodeId`; other-track placeholders carry
 * `shotId`. Generated/ready clips are not placeholders and keep the normal clip
 * inspector, so the 21-09 panel only appears while the clip is still waiting to
 * be generated. */
export function placeholderShotIdForClip(clip: {readonly sourceState?: string;
  readonly sequenceSource?: {readonly kind?: string; readonly nodeId?: string} | null;
  readonly shotId?: string} | null | undefined): string | null {
  if (!clip || clip.sourceState !== 'placeholder') return null;
  if (clip.sequenceSource?.kind === 'shot' && clip.sequenceSource.nodeId) return clip.sequenceSource.nodeId;
  return typeof clip.shotId === 'string' && clip.shotId ? clip.shotId : null;
}

/** The shot whose 21-09 panel must open for a selected placeholder, including
 * when the placeholder is selected again later or lives on an overlay track.
 * Ready/generated clips and placeholders without a live shot keep the normal
 * clip inspector. */
export function editingPlaceholderPanelShotId(clip: Parameters<typeof placeholderShotIdForClip>[0],
  shotExists: (shotId: string) => boolean): string | null {
  const shotId = placeholderShotIdForClip(clip);
  return shotId && shotExists(shotId) ? shotId : null;
}

/** The clip a successful (or recovered unconfirmed) generate commit actually
 * placed. The UI selects and seeks to this row from the refreshed timeline, so
 * it can never present an older selected clip as the new placeholder. */
export function committedGenerateClip(clips: readonly {readonly id: string; readonly startFrame: number;
  readonly trackId: string}[] | undefined, clipId: string): {readonly id: string; readonly startFrame: number;
  readonly trackId: string} | null {
  return clips?.find(clip => clip.id === clipId) ?? null;
}

export interface GeneratePlaceholderInput {
  readonly target: TimelineGenerateTarget;
  readonly settings: Record<string, unknown>;
  readonly shotId: string;
  readonly clipId: string;
  readonly title: string;
}
export function generatePlaceholderIntent(input: GeneratePlaceholderInput): SequenceEditGenerateIntent {
  return {side: 'timeline', operation: {kind: 'generate-placeholder',
    placement: input.target.main ? {kind: 'main', beforeClipId: input.target.beforeClipId}
      : {kind: 'track', trackId: input.target.trackId, startFrame: input.target.startFrame},
    settings: input.settings as never, shotId: input.shotId, clipId: input.clipId, title: input.title}};
}
export function generateResizeIntent(shotId: string, duration: number): SequenceEditGenerateIntent {
  return {side: 'timeline', operation: {kind: 'generate-resize', shotId, duration}};
}

export interface MainTrackAroundContext {
  readonly clipId: string;
  readonly where: 'before' | 'after';
  readonly mainTrackId: string | null;
  readonly clips: readonly {readonly id: string; readonly trackId: string; readonly startFrame: number;
    readonly durationFrames: number; readonly sequenceSource?: {readonly kind?: string; readonly nodeId?: string}}[];
}
/** GE-b clip menu: place a generated shot before or after one packed main-track
 * shot. "After" names the next different shot's clip, so a split shot inserts
 * after all of its segments; the end of the track appends. */
export function mainTrackGenerateAroundPlacement(context: MainTrackAroundContext): TimelineGenerateTarget | null {
  const {clipId, where, mainTrackId, clips} = context;
  if (!mainTrackId) return null;
  const clip = clips.find(item => item.id === clipId);
  if (!clip || clip.trackId !== mainTrackId || clip.sequenceSource?.kind !== 'shot') return null;
  const nodeId = clip.sequenceSource.nodeId;
  // The service inserts before/after the whole shot, not one of its split
  // segments: "before" is the shot's first segment start, "after" its last end.
  const segments = clips.filter(item => item.trackId === mainTrackId
      && item.sequenceSource?.nodeId === nodeId)
    .sort((left, right) => left.startFrame - right.startFrame);
  const first = segments[0] ?? clip;
  const last = segments.at(-1) ?? clip;
  if (where === 'before') return {trackId: mainTrackId, main: true, startFrame: first.startFrame, beforeClipId: clip.id};
  const lastEnd = last.startFrame + last.durationFrames;
  const next = clips.filter(item => item.trackId === mainTrackId
      && item.startFrame >= lastEnd && item.sequenceSource?.nodeId !== nodeId)
    .sort((left, right) => left.startFrame - right.startFrame)[0];
  return {trackId: mainTrackId, main: true, startFrame: lastEnd, beforeClipId: next?.id ?? null};
}
