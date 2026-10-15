import {TIMELINE_CLIP_LOUDNESS_LIMITS} from '@mioon/contracts/timeline-clip-loudness';
import {createTimelineMixLoudnessDecoder, planTimelineMixLoudnessDecode} from './timeline-mix-loudness-decoder.ts';
import type {TimelineMixLoudnessClip, TimelineMixLoudnessTrack, TimelineMixLoudnessAsset,
  TimelineMixLoudnessDecoderRuntime, TimelineMixLoudnessDecodeOptions, TimelineMixLoudnessDecodedPcm} from './timeline-mix-loudness-decoder.ts';

export interface TimelineClipLoudnessSignal {
  readonly clip: TimelineMixLoudnessClip;
  readonly track: TimelineMixLoudnessTrack;
  readonly asset: TimelineMixLoudnessAsset;
}
const fail = (code: string): never => {throw Object.assign(new Error('The selected saved clip cannot be measured independently.'), {code});};
/** Private decode descriptor, not a saved timeline or a public full-mix report.
 * Rebasing both clip start and segment start preserves clip-local fade time.
 * Source offset/duration/gain/fades are unchanged. Other clips never enter it. */
function descriptor(signal: TimelineClipLoudnessSignal) {
  if (signal.clip.durationFrames > TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames) fail('TIMELINE_CLIP_LOUDNESS_DURATION_LIMIT');
  if (signal.track.muted) fail('TIMELINE_CLIP_LOUDNESS_MUTED');
  if (signal.clip.gain === 0) fail('TIMELINE_CLIP_LOUDNESS_ZERO_GAIN');
  if (signal.asset.mimeType.startsWith('image/')) fail('TIMELINE_CLIP_LOUDNESS_NO_AUDIO');
  return {timeline: {fps: 30 as const, durationFrames: signal.clip.durationFrames,
    tracks: [signal.track], clips: [{...signal.clip, startFrame: 0}]}, assets: new Map([[signal.clip.assetId, signal.asset]])};
}
export function planTimelineClipLoudnessDecode(signal: TimelineClipLoudnessSignal) {
  const {timeline, assets} = descriptor(signal);
  return planTimelineMixLoudnessDecode(timeline, assets);
}
export type TimelineClipLoudnessDecoder = (signal: TimelineClipLoudnessSignal,
  options: TimelineMixLoudnessDecodeOptions) => Promise<TimelineMixLoudnessDecodedPcm>;
export function createTimelineClipLoudnessDecoder(runtime: TimelineMixLoudnessDecoderRuntime): TimelineClipLoudnessDecoder {
  const decode = createTimelineMixLoudnessDecoder(runtime);
  return async (signal, options) => {
    const {timeline, assets} = descriptor(signal);
    // The existing decoder probes potentially audible video even when saved
    // hasAudio is false. A genuine no-audio source is not a silence measurement.
    const result = await decode(timeline, assets, {...options, onPcm: chunk => {
      if (!signal.asset.hasAudio) fail('TIMELINE_CLIP_LOUDNESS_NO_AUDIO');
      return options.onPcm(chunk);
    }});
    if (!signal.asset.hasAudio) fail('TIMELINE_CLIP_LOUDNESS_NO_AUDIO');
    return result;
  };
}
