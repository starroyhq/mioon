import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {TimelineAudioPreviewSourceProbe} from './timeline-audio-preview-decoder.ts';
/** Call only with the existing trusted audio parser's result after managed
 * ownership/hash/identity verification. Cached metadata is never this proof. */
export function assertVolumeEnvelopeSource(clip: {durationFrames:number;sourceInFrame?:number;volumeEnvelope?:unknown},
  source: {mimeType:string;audio:TimelineAudioPreviewSourceProbe|null}): void {
  if (volumeEnvelopeField(clip).volumeEnvelope == null) return;
  const audio = source.audio;
  if (!['audio/wav','audio/mpeg','audio/mp4','video/mp4','video/webm'].includes(source.mimeType) || !audio ||
      !Number.isSafeInteger(audio.streamIndex) || audio.streamIndex < 0 || !audio.codecName ||
      !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate < 1 || audio.sampleRate > 999999 ||
      ![1,2].includes(audio.channels) || audio.channelLayout !== (audio.channels === 1 ? 'mono' : 'stereo') ||
      !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 ||
      (clip.sourceInFrame ?? 0) + clip.durationFrames > Math.floor(audio.durationSeconds * 30 + 1e-6))
    throw Object.assign(new Error('Volume automation requires a verified supported audio source.'), {code:'VOLUME_ENVELOPE_SOURCE_UNSUPPORTED'});
}
