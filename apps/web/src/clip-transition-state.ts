import { CLIP_TRANSITION_LIMITS, CLIP_TRANSITION_PROFILE, canonicalClipTransition, isClipTransition, type ClipTransition, type ClipTransitionKind } from '@mioon/contracts';

// Transition editing for the incoming clip of a cut. Each action produces the
// complete next transition for timeline.clip.setTransition; nothing is drafted.
/** Whether a clip on the same track ends where this one starts, and the longest
 * transition the cut takes beside the transitions on its neighbouring cuts. */
export interface TransitionContext { readonly hasCut: boolean; readonly maxFrames: number }
export interface TransitionFields { readonly kind: ClipTransitionKind; readonly frames: string }
export type TransitionIssue = 'clip.transition.noCut' | 'clip.transition.noRoom' | 'clip.transition.invalid' | '';
const DEFAULT_FRAMES = 15;

/** The saved transition, or null when the clip has none or an unreadable one. */
export function savedTransition(clip: { readonly transitionIn?: unknown }): ClipTransition | null {
  return Object.hasOwn(clip, 'transitionIn') && clip.transitionIn !== null && isClipTransition(clip.transitionIn) ? clip.transitionIn as ClipTransition : null;
}
/** The saved values, or a dissolve of half a second where it fits. */
export function transitionFields(clip: { readonly transitionIn?: unknown }, context: TransitionContext): TransitionFields {
  const saved = savedTransition(clip);
  if (saved) return { kind: saved.kind, frames: String(saved.durationFrames) };
  return { kind: 'dissolve', frames: String(Math.max(CLIP_TRANSITION_LIMITS.minFrames, Math.min(DEFAULT_FRAMES, context.maxFrames))) };
}
export function transitionIssue(fields: TransitionFields, context: TransitionContext): TransitionIssue {
  if (!context.hasCut) return 'clip.transition.noCut';
  if (context.maxFrames < CLIP_TRANSITION_LIMITS.minFrames) return 'clip.transition.noRoom';
  const frames = fields.frames.trim() === '' ? NaN : Number(fields.frames);
  return Number.isInteger(frames) && frames >= CLIP_TRANSITION_LIMITS.minFrames && frames <= context.maxFrames ? '' : 'clip.transition.invalid';
}
export function nextTransition(fields: TransitionFields): ClipTransition {
  return { profileId: CLIP_TRANSITION_PROFILE, kind: fields.kind, durationFrames: Number(fields.frames) };
}
/** Whether valid fields differ from the saved transition. */
export function transitionChanged(clip: { readonly transitionIn?: unknown }, fields: TransitionFields): boolean {
  return JSON.stringify(canonicalClipTransition(savedTransition(clip))) !== JSON.stringify(canonicalClipTransition(nextTransition(fields)));
}
