import {timelineFpsSchema} from './timeline-fps.ts';
import type {TimelineFps} from './timeline-fps.ts';

export const TIMELINE_AUDIO_SAMPLE_RATE = 48000;
export const timelineAudioFpsSchema = timelineFpsSchema.refine((fps): fps is Exclude<TimelineFps, 30> => fps !== 30).optional();

/** Return the sample position of an absolute, half-open project-frame edge.
 * All supported integer project clocks divide 48 kHz exactly. Divide first
 * to avoid overflowing the safe integer range before converting long seeks. */
export function timelineAudioSampleBoundary(frame: number, fps: TimelineFps = 30): number {
  return frame * (TIMELINE_AUDIO_SAMPLE_RATE / fps);
}

export function timelineAudioSampleSpan(startFrame: number, endFrame: number, fps: TimelineFps = 30): number {
  return timelineAudioSampleBoundary(endFrame, fps) - timelineAudioSampleBoundary(startFrame, fps);
}

/** Omit the legacy clock from protocol and digest material. */
export function timelineAudioFpsFields(fps: TimelineFps): {fps?: Exclude<TimelineFps, 30>} {
  return fps === 30 ? {} : {fps};
}
