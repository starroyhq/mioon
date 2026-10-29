import type {PrevisCamera,PrevisKeyframe} from '@mioon/contracts';
import {wrapPrevisAngle} from './previs-camera.ts';

// Keyframe playback (C8 v2): the camera moves from keyframe to keyframe in
// strip order, easing in and out at each one, then holds the last one briefly.
// It is a preview: nothing is saved, the scene camera stays where it was and
// it is not an undo step. Yaw turns the short way round; position, pitch and
// focal length move linearly along the eased segment.
export const PREVIS_PLAYBACK_SEGMENT_MS = 2000;
export const PREVIS_PLAYBACK_HOLD_MS = 600;
export const canPlayPrevisKeyframes = (keyframes: readonly unknown[]): boolean => keyframes.length >= 2;
/** Milliseconds from the first keyframe to the last, before the hold. */
export const previsPlaybackDuration = (count: number): number => Math.max(0, count - 1) * PREVIS_PLAYBACK_SEGMENT_MS;
const ease = (value: number): number => value * value * (3 - 2 * value);
const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
/** The camera `elapsed` milliseconds into playing the keyframes; the last keyframe's camera from the end on. */
export function previsPlaybackCamera(keyframes: readonly PrevisKeyframe[], elapsed: number): PrevisCamera | null {
  if (!keyframes.length) return null;
  const segments = keyframes.length - 1;
  if (segments === 0 || elapsed >= previsPlaybackDuration(keyframes.length)) return keyframes[segments]!.camera;
  const at = Math.max(0, elapsed) / PREVIS_PLAYBACK_SEGMENT_MS, index = Math.min(segments - 1, Math.floor(at)), amount = ease(at - index);
  const from = keyframes[index]!.camera, to = keyframes[index + 1]!.camera;
  return {
    position: [lerp(from.position[0], to.position[0], amount), lerp(from.position[1], to.position[1], amount), lerp(from.position[2], to.position[2], amount)],
    yaw: wrapPrevisAngle(from.yaw + wrapPrevisAngle(to.yaw - from.yaw) * amount),
    pitch: lerp(from.pitch, to.pitch, amount),
    focalLength: lerp(from.focalLength, to.focalLength, amount),
  };
}
