import { clipTransitionPredecessor, clipTransitionRoom, clipTransitionSides, savedClipTransition, sourceFrameCount, type ClipTransitionKind, type TransitionClip, type TransitionSources } from '@mioon/contracts';

// The timeline's transition marks and the quick-add cuts beside the selected
// clip, read from the saved timeline by the fitting rules the backend applies.
export interface TimelineTransitionMark {
  readonly incomingId: string; readonly kind: ClipTransitionKind; readonly durationFrames: number;
  /** The span the transition covers: ⌊D/2⌋ frames before the cut, the rest after it. */
  readonly startFrame: number; readonly endFrame: number;
}
export interface TimelineTransitionCut { readonly incomingId: string; readonly cutFrame: number; readonly maxFrames: number }

/** Source handles as the fitting rules read them: a still repeats, a video offers its frames. */
export function timelineTransitionSources(assets: readonly { readonly id: string; readonly mimeType: string; readonly duration?: unknown }[]): TransitionSources {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return assetId => {
    const asset = byId.get(assetId);
    if (!asset) return null;
    const image = asset.mimeType.startsWith('image/');
    return { image, frames: image ? 0 : sourceFrameCount(asset.duration) ?? 0 };
  };
}
/** The saved transitions on one track. */
export function timelineTransitionMarks(clips: readonly TransitionClip[], trackId: string): TimelineTransitionMark[] {
  return clips.flatMap(clip => {
    const saved = clip.trackId === trackId ? savedClipTransition(clip) : null;
    if (!saved || !clipTransitionPredecessor(clips, clip)) return [];
    const { before, after } = clipTransitionSides(saved.durationFrames);
    return [{ incomingId: clip.id, kind: saved.kind, durationFrames: saved.durationFrames, startFrame: clip.startFrame - before, endFrame: clip.startFrame + after }];
  });
}
/** The cuts at the selected clip's start and end that have no transition yet,
 * each with the longest transition it takes beside its neighbours' (0 when none fits). */
export function selectedTransitionCuts(clips: readonly TransitionClip[], selectedClipId: string | null, trackId: string, sources: TransitionSources): TimelineTransitionCut[] {
  const selected = clips.find(clip => clip.id === selectedClipId);
  if (!selected || selected.trackId !== trackId) return [];
  const next = clips.find(clip => clip !== selected && clip.trackId === trackId && clip.startFrame === selected.startFrame + selected.durationFrames);
  return [selected, next].flatMap(incoming => incoming && clipTransitionPredecessor(clips, incoming) && !savedClipTransition(incoming)
    ? [{ incomingId: incoming.id, cutFrame: incoming.startFrame, maxFrames: clipTransitionRoom(clips, incoming, sources) }] : []);
}
