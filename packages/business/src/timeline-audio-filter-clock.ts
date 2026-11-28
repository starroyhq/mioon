import {deriveTimelineAudioSamples} from '../../contracts/src/timeline-audio-preview.ts';
import type {TimelineFps} from '../../contracts/src/timeline-fps.ts';
import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {TimelineAudioFilterClip} from './timeline-audio-filter-graph.ts';
import {compileTimelineVolumeEnvelopeFilter} from './timeline-volume-envelope-clock.ts';

/** New project clocks keep the same gain, fade and mixing order as the 30 fps
 * filter. Fade and automation positions are set from the original clip edges. */
export function timelineClipAudioFilterWithFps(clip: TimelineAudioFilterClip, begin: number,
  samples: number, input: number, streamIndex: number | undefined, fps: Exclude<TimelineFps, 30>): string {
  const fadeIn = clip.fadeInFrames ?? 0, fadeOut = clip.fadeOutFrames ?? 0;
  const {offsetSamples,fadeInSamples,fadeOutSamples,fadeOutStartSample} = deriveTimelineAudioSamples({
    startFrame:clip.startFrame,durationFrames:clip.durationFrames,sourceInFrame:0,fadeInFrames:fadeIn,fadeOutFrames:fadeOut,
  },begin,fps);
  const filters = [`[${input}:${streamIndex ?? 'a:0'}]asetpts=PTS-STARTPTS`,
    'aresample=48000','aformat=sample_fmts=fltp:channel_layouts=stereo',`volume=${clip.gain}`,'apad',`atrim=end_sample=${samples}`];
  if (fadeIn > 0 || fadeOut > 0) filters.push('asettb=1/48000',`asetpts=N+${offsetSamples}`);
  if (fadeIn > 0) filters.push(`afade=t=in:ss=0:ns=${fadeInSamples}:curve=tri`);
  if (fadeOut > 0) filters.push(`afade=t=out:ss=${fadeOutStartSample}:ns=${fadeOutSamples}:curve=tri`);
  if (volumeEnvelopeField(clip).volumeEnvelope != null) {
    filters.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      'aformat=sample_fmts=dblp:sample_rates=48000:channel_layouts=stereo',
      compileTimelineVolumeEnvelopeFilter(clip,offsetSamples,samples,fps),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
  }
  return filters.join(',')+`,asetpts=N/SR/TB[a${input}]`;
}
