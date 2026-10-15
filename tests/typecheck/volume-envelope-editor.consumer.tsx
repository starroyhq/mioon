import React from 'react';
import ClipVolumeEnvelopeControls from '../../apps/web/src/ClipVolumeEnvelopeControls.tsx';
import { rawVolumeEnvelopeFields, volumeEnvelopeChange } from '../../apps/web/src/clip-volume-envelope-state.ts';
import type { RawVolumeEnvelopeFields, VolumeEnvelopeComposition } from '../../apps/web/src/clip-volume-envelope-state.ts';
let draft: RawVolumeEnvelopeFields = rawVolumeEnvelopeFields({ durationFrames: 10 });
let pending: VolumeEnvelopeComposition = { session: Symbol(), pending: false, dirty: false };
const editor = <ClipVolumeEnvelopeControls value={draft.volumeEnvelope} proposedDuration={10}
  onEdit={value => { draft = { volumeEnvelope: value }; }} onCompositionChange={value => { pending = value; }} />;
const patch = volumeEnvelopeChange(draft, { durationFrames: 10 }, 10);
void [editor, patch, pending];
// @ts-expect-error Pending composition guard is mandatory, not optional.
const unsafe = <ClipVolumeEnvelopeControls proposedDuration={10} onEdit={() => {}} />;
void unsafe;
