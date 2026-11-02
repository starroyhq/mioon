import type { OPACITY_ENVELOPE_PROFILE } from '../../../packages/contracts/src/timeline-opacity-envelope.ts';

/** Raw opacity keyframe draft text. Only clip-draft-state.ts uses these types,
 * to refuse editing or saving an opacity field; no editor writes one. */
export type RawOpacityEnvelope = { profileId: typeof OPACITY_ENVELOPE_PROFILE; points: { frame: string; opacity: string }[] };
export type RawOpacityEnvelopeFields = { opacityEnvelope?: RawOpacityEnvelope | null };
