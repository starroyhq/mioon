/** Two-clip picture transitions at the cut between adjacent clips on one video
 * track, and the pure fitting rules the timeline editor, the renderer and the
 * inspector share. It grants no workspace capability: persisted transitions are
 * admitted from schema72 on elsewhere. */
export const CLIP_TRANSITION_PROFILE = 'mioon-clip-transition-v1';
export const CLIP_TRANSITION_KINDS = Object.freeze(['dissolve', 'dipToBlack', 'wipeLeft', 'wipeRight', 'pushLeft', 'pushRight'] as const);
export type ClipTransitionKind = typeof CLIP_TRANSITION_KINDS[number];
/** Durations are timeline frames. Transition edges count towards the same
 * bound of 200 composition segments that 100 clips already reach. */
export const CLIP_TRANSITION_LIMITS = Object.freeze({minFrames: 2, maxFrames: 60, segments: 200});
/** Saved on the incoming clip of a cut, centred on the cut. */
export interface ClipTransition {
  readonly profileId: typeof CLIP_TRANSITION_PROFILE;
  readonly kind: ClipTransitionKind;
  readonly durationFrames: number;
}
export interface ClipTransitionSides {readonly before: number; readonly after: number}
export interface TransitionClip {
  readonly id: string; readonly trackId: string; readonly assetId: string;
  readonly startFrame: number; readonly durationFrames: number; readonly sourceInFrame: number;
  readonly transitionIn?: unknown;
}
/** What a source offers beyond a clip's range: a still repeats, a video has `frames`. */
export interface TransitionSource {readonly image: boolean; readonly frames: number}
export type TransitionSources = (assetId: string) => TransitionSource | null;
export interface TransitionTimeline {readonly durationFrames: number; readonly clips: readonly TransitionClip[]}
export interface ClipTransitionRegion {
  readonly trackId: string; readonly outgoingId: string; readonly incomingId: string;
  readonly kind: ClipTransitionKind; readonly durationFrames: number;
  /** startFrame = cutFrame − before; endFrame = cutFrame + after. */
  readonly startFrame: number; readonly cutFrame: number; readonly endFrame: number;
}

const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && !Object.is(value, -0) && (value as number) >= min && (value as number) <= max;
const fail: (message: string) => never = message => {throw Object.assign(new Error(message), {code: 'INVALID_CLIP_TRANSITION'});};
/** Own enumerable data properties exactly matching keys, on a plain object. */
function record<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => own(descriptors, key) && descriptors[key]!.enumerable && own(descriptors[key]!, 'value'));
}

/** Returns the original value; never normalizes, defaults or mutates it. */
export function validateClipTransition(value: unknown): ClipTransition | null {
  if (value === null) return null;
  if (!record(value, ['profileId', 'kind', 'durationFrames']) || value.profileId !== CLIP_TRANSITION_PROFILE ||
      !(CLIP_TRANSITION_KINDS as readonly unknown[]).includes(value.kind) ||
      !integer(value.durationFrames, CLIP_TRANSITION_LIMITS.minFrames, CLIP_TRANSITION_LIMITS.maxFrames)) fail('Invalid transition.');
  return value as unknown as ClipTransition;
}
export function isClipTransition(value: unknown): value is ClipTransition | null {
  try {validateClipTransition(value); return true;} catch {return false;}
}
/** A copy with keys in model order, so equal transitions serialize equally. */
export function canonicalClipTransition(value: ClipTransition | null): ClipTransition | null {
  return value === null ? null : {profileId: value.profileId, kind: value.kind, durationFrames: value.durationFrames};
}
/** Frames before the cut, taken from the incoming clip's lead-in, and after it,
 * from the outgoing clip's tail; an odd frame goes after the cut. */
export function clipTransitionSides(durationFrames: number): ClipTransitionSides {
  const before = Math.floor(durationFrames / 2);
  return {before, after: durationFrames - before};
}
/** The saved transition of a clip; null when it has none or an unreadable one. */
export function savedClipTransition(clip: TransitionClip): ClipTransition | null {
  return own(clip, 'transitionIn') && clip.transitionIn !== null && isClipTransition(clip.transitionIn) ? clip.transitionIn as ClipTransition : null;
}
/** The clip on the same track that ends where `clip` starts. */
export function clipTransitionPredecessor<C extends TransitionClip>(clips: readonly C[], clip: C): C | null {
  return clips.find(other => other !== clip && other.trackId === clip.trackId && other.startFrame + other.durationFrames === clip.startFrame) ?? null;
}
function successor<C extends TransitionClip>(clips: readonly C[], clip: C): C | null {
  return clips.find(other => other !== clip && other.trackId === clip.trackId && other.startFrame === clip.startFrame + clip.durationFrames) ?? null;
}
type Neighbour = (clip: TransitionClip) => ClipTransition | null;
/** Source handles on both sides, and room inside both clips beside the
 * transitions on their other cuts (`neighbour` says which of those count). */
function fits(clips: readonly TransitionClip[], outgoing: TransitionClip, incoming: TransitionClip, durationFrames: number, sources: TransitionSources, neighbour: Neighbour): boolean {
  const {before, after} = clipTransitionSides(durationFrames), from = sources(outgoing.assetId), to = sources(incoming.assetId);
  if (!from || !to) return false;
  if (!to.image && incoming.sourceInFrame < before) return false;
  if (!from.image && outgoing.sourceInFrame + outgoing.durationFrames + after > from.frames) return false;
  const left = neighbour(outgoing), next = successor(clips, incoming), right = next ? neighbour(next) : null;
  return outgoing.durationFrames - (left ? clipTransitionSides(left.durationFrames).after : 0) >= before &&
    incoming.durationFrames - (right ? clipTransitionSides(right.durationFrames).before : 0) >= after;
}
/** Whether this transition fits the cut before `incoming` beside the transitions
 * saved on the neighbouring cuts. False without a cut. */
export function clipTransitionFits(clips: readonly TransitionClip[], incoming: TransitionClip, durationFrames: number, sources: TransitionSources): boolean {
  const outgoing = clipTransitionPredecessor(clips, incoming);
  return !!outgoing && fits(clips, outgoing, incoming, durationFrames, sources, savedClipTransition);
}
/** The longest transition that fits the cut before `incoming`, or 0. */
export function clipTransitionRoom(clips: readonly TransitionClip[], incoming: TransitionClip, sources: TransitionSources): number {
  for (let frames = CLIP_TRANSITION_LIMITS.maxFrames; frames >= CLIP_TRANSITION_LIMITS.minFrames; frames--)
    if (clipTransitionFits(clips, incoming, frames, sources)) return frames;
  return 0;
}
function region(clips: readonly TransitionClip[], incoming: TransitionClip, transition: ClipTransition): ClipTransitionRegion {
  const outgoing = clipTransitionPredecessor(clips, incoming)!, {before, after} = clipTransitionSides(transition.durationFrames);
  return {trackId: incoming.trackId, outgoingId: outgoing.id, incomingId: incoming.id, kind: transition.kind, durationFrames: transition.durationFrames,
    startFrame: incoming.startFrame - before, cutFrame: incoming.startFrame, endFrame: incoming.startFrame + after};
}
/** Composition segments with these regions' edges added to the clip edges. */
export function clipTransitionSegmentCount(timeline: TransitionTimeline, regions: readonly ClipTransitionRegion[]): number {
  return new Set([0, timeline.durationFrames, ...timeline.clips.flatMap(clip => [clip.startFrame, clip.startFrame + clip.durationFrames]),
    ...regions.flatMap(item => [item.startFrame, item.endFrame])]).size - 1;
}
/** The incoming clips whose saved transitions no longer hold. Each track is
 * read left to right, and a transition stays when it fits beside the ones
 * already kept on its left. Over the segment bound, the latest cuts go. */
export function staleClipTransitions(timeline: TransitionTimeline, sources: TransitionSources): string[] {
  const kept = new Map<string, ClipTransitionRegion>(), stale: string[] = [], keptTransitions = new Map<string, ClipTransition>();
  const incoming = timeline.clips.filter(clip => own(clip, 'transitionIn')).sort((a, b) => a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : a.startFrame - b.startFrame);
  for (const clip of incoming) {
    const transition = savedClipTransition(clip), outgoing = clipTransitionPredecessor(timeline.clips, clip);
    if (transition && outgoing && fits(timeline.clips, outgoing, clip, transition.durationFrames, sources, other => keptTransitions.get(other.id) ?? null)) {
      kept.set(clip.id, region(timeline.clips, clip, transition)); keptTransitions.set(clip.id, transition);
    } else stale.push(clip.id);
  }
  const latest = [...kept.values()].sort((a, b) => b.cutFrame - a.cutFrame || (a.trackId < b.trackId ? 1 : -1));
  while (latest.length && clipTransitionSegmentCount(timeline, latest) > CLIP_TRANSITION_LIMITS.segments) stale.push(latest.shift()!.incomingId);
  return stale;
}
/** The saved transitions as render regions. Saved timelines are kept clean,
 * so a transition that no longer holds is invalid here, not dropped. */
export function clipTransitionRegions(timeline: TransitionTimeline, sources: TransitionSources): ClipTransitionRegion[] {
  if (staleClipTransitions(timeline, sources).length) fail('A saved transition does not fit its cut.');
  return timeline.clips.filter(clip => own(clip, 'transitionIn')).map(clip => region(timeline.clips, clip, savedClipTransition(clip)!))
    .sort((a, b) => a.cutFrame - b.cutFrame || (a.trackId < b.trackId ? -1 : 1));
}
