import {AppError} from '../../contracts/src/app-error.ts';
import type {Format5Clip, Format5Timeline} from '../../contracts/src/project-format5.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {compileClipTimeMap} from '../../contracts/src/timeline-clip-timing.ts';
import {
  clipTransitionOutputFits, clipTransitionPredecessor, clipTransitionSides, savedClipTransition,
} from '../../contracts/src/timeline-clip-transition.ts';
import {hasTimelineCrossfadeEnvelopes} from '../../contracts/src/timeline-crossfade.ts';
import {
  restoreTimeMap, timeMapSourceRangeForEdit, timeMapSourceWindowForOutput,
  type TimeMapSourceBoundary, type TimeMapSpeed, type TimeMapSpeedRate,
} from '../../contracts/src/timeline-time-map.ts';

type ReadAsset = (id: string) => {mimeType?: unknown; duration?: unknown} | undefined;
type HandleSide = 'before' | 'after';

function transitionFailure(ids: readonly string[]): never {
  throw new AppError('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', '片段长度或素材余量不足以保留转场或交叉淡化', 409, {ids});
}

function constantHandleFits(boundary: TimeMapSourceBoundary, rate: TimeMapSpeedRate,
  frames: number, sourceFrames: number, lower: boolean): boolean {
  const n = boundary.kind === 'q64' ? BigInt(boundary.ticks) : BigInt(boundary.numerator);
  const d = boundary.kind === 'q64' ? 1n << 64n : BigInt(boundary.denominator);
  const denominator = BigInt(rate.denominator);
  const base = n * denominator;
  const handle = BigInt(frames) * BigInt(rate.numerator) * d;
  return lower ? base >= handle : base + handle <= BigInt(sourceFrames) * d * denominator;
}

function constantRate(speed: TimeMapSpeed): TimeMapSpeedRate | undefined {
  if (speed.kind === 'constant') return speed.rate;
  const rate = speed.points[0]?.rate;
  return rate && speed.points.every(point => BigInt(point.rate.numerator) * BigInt(rate.denominator) ===
    BigInt(rate.numerator) * BigInt(point.rate.denominator)) ? rate : undefined;
}

function sourceHandleFits(clip: Format5Clip, timeline: Format5Timeline, source: ReturnType<ReadAsset>,
  side: HandleSide, frames: number): boolean {
  if (!source || !clip.assetId || clip.sourceState !== 'ready') return false;
  if (typeof source.mimeType === 'string' && source.mimeType.startsWith('image/')) return true;
  const sourceFrames = sourceFrameCount(source.duration, timeline.fps) ?? 0;
  const {timing} = clip;
  if (!timing) return side === 'before' ? clip.sourceInFrame >= frames : clip.sourceInFrame + clip.durationFrames + frames <= sourceFrames;
  if (timing.profile === 'timeline-freeze-v1') return timing.sourceFrame < sourceFrames;
  const plan = compileClipTimeMap(clip, timeline);
  if (!plan.ok) return false;
  const rate = constantRate(timing.basis.speed);
  if (rate) {
    const range = timeMapSourceRangeForEdit(plan.value);
    if (!range.ok) return false;
    const lower = timing.view.direction === 'forward' ? side === 'before' : side === 'after';
    return constantHandleFits(lower ? range.value.start : range.value.end, rate, frames, sourceFrames, lower);
  }
  // Preserve curve phase by extending only inside the compiled view. A curve
  // outside those bounds has no proven handle in this profile.
  const {fromFrame, toFrame} = timing.outputWindow;
  const extended = restoreTimeMap(plan.value.root, {...timing.view, outputWindow: side === 'before'
    ? {fromFrame: fromFrame - frames, toFrame} : {fromFrame, toFrame: toFrame + frames}});
  if (!extended.ok) return false;
  const window = timeMapSourceWindowForOutput(extended.value);
  return window.ok && window.value.endFrame <= sourceFrames;
}

const end = (clip: Format5Clip): number => clip.startFrame + clip.durationFrames;
const transitionContext = (clip: Format5Clip | undefined): string => clip === undefined ? '' : JSON.stringify([
  clip.id, clip.trackId, clip.startFrame, clip.durationFrames, clip.sourceInFrame, clip.sourceSpanFrames,
  clip.assetId, clip.timing, clip.transitionIn,
]);

function validateCrossfades(timeline: Format5Timeline, before: Format5Timeline): void {
  const nextById = new Map(timeline.clips.map(clip => [clip.id, clip]));
  const previous = before.clips.filter(clip => clip.volumeEnvelope != null);
  for (const outgoing of previous) {
    const nextOutgoing = nextById.get(outgoing.id);
    for (const incoming of previous) {
      const nextIncoming = nextById.get(incoming.id);
      if (nextOutgoing && nextIncoming && nextOutgoing.trackId === outgoing.trackId && nextIncoming.trackId === incoming.trackId &&
        nextIncoming.startFrame - nextOutgoing.startFrame === incoming.startFrame - outgoing.startFrame &&
        nextOutgoing.durationFrames === outgoing.durationFrames && nextIncoming.durationFrames === incoming.durationFrames) continue;
      if (!hasTimelineCrossfadeEnvelopes(outgoing, incoming)) continue;
      if (!nextIncoming || !nextOutgoing || !hasTimelineCrossfadeEnvelopes(nextOutgoing, nextIncoming)) {
        transitionFailure([outgoing.id, incoming.id]);
      }
    }
  }
}

/** Validate transitions affected by a native timeline edit. Ordinary source
 * rows use the shared output geometry, while a mapped source proves its
 * handles in the correct direction. */
export function validateSpeedTransitions(timeline: Format5Timeline, before: Format5Timeline, readAsset: ReadAsset): void {
  const previousById = new Map(before.clips.map(clip => [clip.id, clip]));
  // Placeholder clips are kept in the track geometry and fail source lookup.
  const previousClips = before.clips.map(clip => ({...clip, assetId: clip.assetId ?? ''}));
  const clips = timeline.clips.map(clip => ({...clip, assetId: clip.assetId ?? ''}));
  for (const incoming of clips) {
    const transition = savedClipTransition(incoming);
    if (!transition) continue;
    const previous = previousClips.find(clip => clip.id === incoming.id);
    const outgoing = clipTransitionPredecessor(clips, incoming);
    const previousOutgoing = previous ? clipTransitionPredecessor(previousClips, previous) : null;
    const next = clips.find(clip => clip.trackId === incoming.trackId && clip.startFrame === end(incoming) && savedClipTransition(clip) !== null);
    const previousNext = previous ? previousClips.find(clip => clip.trackId === previous.trackId && clip.startFrame === end(previous) && savedClipTransition(clip) !== null) : undefined;
    if (transitionContext(incoming) === transitionContext(previousById.get(incoming.id)) &&
      transitionContext(outgoing ?? undefined) === transitionContext(previousOutgoing ?? undefined) &&
      transitionContext(next) === transitionContext(previousNext)) continue;
    const {before: lead, after: tail} = clipTransitionSides(transition.durationFrames);
    if (!outgoing || !clipTransitionOutputFits(clips, outgoing, incoming, transition.durationFrames) ||
      !sourceHandleFits(incoming, timeline, readAsset(incoming.assetId), 'before', lead) ||
      !sourceHandleFits(outgoing, timeline, readAsset(outgoing.assetId), 'after', tail)) {
      transitionFailure(outgoing ? [outgoing.id, incoming.id] : [incoming.id]);
    }
  }
  validateCrossfades(timeline, before);
}
