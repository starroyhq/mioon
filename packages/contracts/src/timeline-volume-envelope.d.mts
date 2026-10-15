export const VOLUME_ENVELOPE_PROFILE: 'mioon-clip-linear-attenuation-v1';
export const VOLUME_ENVELOPE_LIMITS: Readonly<{points:16;frames:18000;samplesPerFrame:1600}>;
export interface VolumeEnvelope {profileId: typeof VOLUME_ENVELOPE_PROFILE; points: {frame:number;multiplier:number}[]}
export interface VolumeEnvelopeClip {durationFrames:number;volumeEnvelope?:VolumeEnvelope|null}
export function validateVolumeEnvelope(value:unknown,durationFrames:number): VolumeEnvelope|null;
export function createVolumeEnvelopeEvaluator(clip:VolumeEnvelopeClip): Readonly<{limitAtSample(sample:number):number;atSample(sample:number):number}>;
export function volumeEnvelopeFieldsAfterEdit(clip:VolumeEnvelopeClip,patch:Partial<VolumeEnvelopeClip>): {volumeEnvelope?:VolumeEnvelope|null};
export function splitVolumeEnvelopeFields(clip:VolumeEnvelopeClip,cutFrame:number): [{volumeEnvelope?:VolumeEnvelope|null},{volumeEnvelope?:VolumeEnvelope|null}];
