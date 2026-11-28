import {timelineAudioSampleSpan} from '../../contracts/src/timeline-audio-clock.ts';
import type {TimelineFps} from '../../contracts/src/timeline-fps.ts';
import {createVolumeEnvelopeEvaluator, volumeEnvelopeFieldsAfterEdit} from '../../contracts/src/timeline-volume-envelope.ts';
import type {VolumeEnvelopeClip} from '../../contracts/src/timeline-volume-envelope.ts';
import {compileVolumeEnvelopeFilterCandidate, VOLUME_ENVELOPE_FILTER_BYTE_CAP} from './timeline-volume-envelope-filter-candidate.ts';

type ClockedClip = VolumeEnvelopeClip & {startFrame: number};

function projectSampleEnvelope(clip: ClockedClip, fps: TimelineFps) {
  const {volumeEnvelope} = volumeEnvelopeFieldsAfterEdit(clip, {});
  const sampleAt = (frame: number) => timelineAudioSampleSpan(clip.startFrame, clip.startFrame + frame, fps);
  return {
    endSample: sampleAt(clip.durationFrames),
    points: volumeEnvelope?.points.map(({frame, multiplier}) => ({sample: sampleAt(frame), multiplier})),
  };
}

/** Playback and export use the same clip-relative sample anchors. Retain the
 * legacy sampler on its original clock so existing mixes keep their bytes. */
export function createTimelineVolumeEnvelopeSampler(clip: ClockedClip, fps: TimelineFps) {
  if (fps === 30) return createVolumeEnvelopeEvaluator(clip);
  const {endSample, points} = projectSampleEnvelope(clip, fps);
  return Object.freeze({atSample(sample: number): number {
    if (!Number.isSafeInteger(sample)) throw Object.assign(new Error('Invalid playback sample.'), {code: 'INVALID_VOLUME_ENVELOPE'});
    if (sample < 0 || sample >= endSample) return 0;
    if (!points) return 1;
    if (sample <= points[0]!.sample) return points[0]!.multiplier;
    for (let index = 1; index < points.length; index++) {
      const left = points[index - 1]!, right = points[index]!;
      if (sample === right.sample) return right.multiplier;
      if (sample < right.sample) {
        return left.multiplier + (right.multiplier - left.multiplier) * ((sample - left.sample) / (right.sample - left.sample));
      }
    }
    return points.at(-1)!.multiplier;
  }});
}

export function compileTimelineVolumeEnvelopeFilter(clip: ClockedClip, offsetSamples: number, sampleCount: number,
  fps: TimelineFps): string {
  if (fps === 30) return compileVolumeEnvelopeFilterCandidate(clip, offsetSamples, sampleCount);
  const {endSample, points} = projectSampleEnvelope(clip, fps);
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), {code: 'INVALID_VOLUME_ENVELOPE_FILTER'});
  };
  if (!Number.isSafeInteger(offsetSamples) || Object.is(offsetSamples, -0) || offsetSamples < 0 ||
      !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > endSample - offsetSamples)
    fail('Invalid local sample range.');
  if (!points) return '';
  const x = `(n+${offsetSamples})`;
  let expression = String(points.at(-1)!.multiplier);
  for (let index = points.length - 2; index >= 0; index--) {
    const left = points[index]!, right = points[index + 1]!;
    expression = `if(lt(${x},${right.sample}),${left.multiplier}+(${right.multiplier}-${left.multiplier})*((${x}-${left.sample})/${right.sample-left.sample}),${expression})`;
  }
  const first = points[0]!;
  expression = `if(lte(${x},${first.sample}),${first.multiplier},${expression})`;
  const filter = `aeval=exprs=val(ch)*(${expression.replaceAll(',', '\\,')}):c=same`;
  if (Buffer.byteLength(filter, 'utf8') > VOLUME_ENVELOPE_FILTER_BYTE_CAP) fail('Envelope expression exceeds its byte cap.');
  return filter;
}
