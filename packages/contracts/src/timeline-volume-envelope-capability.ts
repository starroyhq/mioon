import {z} from 'zod';
import {VOLUME_ENVELOPE_PROFILE} from './timeline-volume-envelope.ts';

/** Advisory feature disclosure, never a permission or execution credential. */
export const timelineVolumeEnvelopeCapabilitySchema=z.object({
 profileId:z.literal(VOLUME_ENVELOPE_PROFILE),editable:z.boolean(),
}).strict();
export type TimelineVolumeEnvelopeCapability=z.infer<typeof timelineVolumeEnvelopeCapabilitySchema>;
