/** Internal editor composition, never selected by a server payload or a stored
 * profile string. Default application mounts do not create this capability. */
import {createOpacityCandidateClipDraftClient, isOpacityCandidateClipDraftClient} from './clip-draft-client.ts';
import type {ClipDraftClient} from './clip-draft-state.ts';
import {validateOpacityEnvelope} from '../../../packages/contracts/src/timeline-opacity-envelope.ts';

const bindings = new WeakMap<object, Readonly<{client: ClipDraftClient}>>();
export type OpacityCandidateInspectorBinding = Readonly<{readonly kind: 'internal-opacity-inspector'}>;
export function createOpacityCandidateInspectorBinding(fetcher: typeof fetch = (...args) => fetch(...args)): OpacityCandidateInspectorBinding {
  const binding = Object.freeze({kind: 'internal-opacity-inspector'} as const);
  bindings.set(binding, Object.freeze({client: createOpacityCandidateClipDraftClient(fetcher)}));
  return binding;
}
export function readOpacityCandidateInspectorBinding(value: unknown): Readonly<{client: ClipDraftClient}> | null {
  if (!value || typeof value !== 'object') return null;
  const binding = bindings.get(value);
  return binding && isOpacityCandidateClipDraftClient(binding.client) ? binding : null;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validation-only projection of decoded HTTP data. The fixed legacy checker
 * in the current Inspector still checks every original old field/unknown key.
 * This function never returns data for persistence or confers backend access. */
export function opacityCandidateTimelineProjection(value: unknown, projectId: string): unknown | null {
  try {
    if (!object(value) || value.projectId !== projectId || !Array.isArray(value.tracks) || !Array.isArray(value.clips) ||
        value.tracks.length > 12 || value.clips.length > 100 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144) return null;
    const tracks = new Map<string, string>();
    for (const track of value.tracks as unknown[]) {
      if (!object(track) || typeof track.id !== 'string' || typeof track.kind !== 'string') return null;
      tracks.set(track.id, track.kind);
    }
    const clips: Record<string, unknown>[] = [];
    for (const clip of value.clips as unknown[]) {
      if (!object(clip)) return null;
      const projected = {...clip};
      if (Object.hasOwn(clip, 'opacityEnvelope')) {
        if (typeof clip.trackId !== 'string' || tracks.get(clip.trackId) !== 'video' || typeof clip.durationFrames !== 'number') return null;
        validateOpacityEnvelope(clip.opacityEnvelope, clip.durationFrames);
        delete projected.opacityEnvelope;
      }
      clips.push(projected);
    }
    return {...value, clips};
  } catch {return null;}
}
