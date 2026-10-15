import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {TimelineVolumeEnvelope} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {compileVolumeEnvelopeFilterCandidate} from './timeline-volume-envelope-filter-candidate.ts';
import {deriveTimelineAudioSamples} from '@mioon/contracts/timeline-audio-preview';

export interface TimelineAudioFilterClip {
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly gain: number;
  readonly volumeEnvelope?: TimelineVolumeEnvelope|null;
  readonly fadeInFrames?: number;
  readonly fadeOutFrames?: number;
}

// The render graph is segmented at every clip edge, including other tracks.
// afade uses its input PTS as the sample position. Give it clip-relative integer
// sample timestamps, then let the caller reset PTS for the segment's mixer.
// Fixed 30 fps / 48 kHz output has exactly 1600 samples per timeline frame.
export function timelineAudioFadeFilters(clip: Pick<TimelineAudioFilterClip, 'startFrame' | 'durationFrames' | 'fadeInFrames' | 'fadeOutFrames'>,
  segmentStartFrame: number): string {
  const fadeIn = clip.fadeInFrames ?? 0, fadeOut = clip.fadeOutFrames ?? 0;
  if (fadeIn === 0 && fadeOut === 0) return '';
  const {offsetSamples,fadeInSamples,fadeOutSamples,fadeOutStartSample} = deriveTimelineAudioSamples({startFrame:clip.startFrame,durationFrames:clip.durationFrames,sourceInFrame:0,fadeInFrames:fadeIn,fadeOutFrames:fadeOut}, segmentStartFrame);
  const filters = ['asettb=1/48000', `asetpts=N+${offsetSamples}`];
  if (fadeIn > 0) filters.push(`afade=t=in:ss=0:ns=${fadeInSamples}:curve=tri`);
  if (fadeOut > 0) filters.push(`afade=t=out:ss=${fadeOutStartSample}:ns=${fadeOutSamples}:curve=tri`);
  return filters.join(',') + ',';
}

/** Pure trusted renderer primitives. Keep the precise strings and operation
 * order of the original renderer: gain before pad, clip-relative fade after
 * segment trim, silence first, unnormalized float mixing, then output trim.
 * These are not an interface for caller-supplied labels, filters or streams. */
export function timelineAudioSilenceFilter(samples: number): string {
  return `anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[silence]`;
}

export function timelineClipAudioFilter(clip: TimelineAudioFilterClip, begin: number,
  samples: number, input: number, streamIndex?: number): string {
  const fields = Object.hasOwn(clip, 'volumeEnvelope') ? volumeEnvelopeField(clip) : {};
  const envelope = fields.volumeEnvelope == null ? '' :
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aformat=sample_fmts=dblp:sample_rates=48000:channel_layouts=stereo,${compileVolumeEnvelopeFilterCandidate(clip, (begin-clip.startFrame)*1600, samples)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`;
  return `[${input}:${streamIndex ?? 'a:0'}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${clip.gain},apad,atrim=end_sample=${samples},${timelineAudioFadeFilters(clip, begin)}${envelope}asetpts=N/SR/TB[a${input}]`;
}

export function timelineMixedAudioFilter(sounds: readonly string[], samples: number,
  outputTrim = ''): string {
  return `${sounds.map(sound => `[${sound}]`).join('')}amix=inputs=${sounds.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${samples},${outputTrim}asetpts=N/SR/TB[outa]`;
}
