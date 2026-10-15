import type {VolumeEnvelopeClip} from '../../contracts/src/timeline-volume-envelope.mjs';
export const VOLUME_ENVELOPE_FILTER_BYTE_CAP: 4096;
export function compileVolumeEnvelopeFilterCandidate(clip:VolumeEnvelopeClip,offsetSamples:number,sampleCount:number):string;
