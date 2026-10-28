import {roundPrevisNumber} from '@mioon/contracts';
import type {PrevisCamera} from '@mioon/contracts';

// Camera math shared by the editor, the canvas card and tests; no three.js.
// Yaw 0 and pitch 0 look along -Z, positive yaw turns left (counter-clockwise
// seen from above) and positive pitch looks up, as the scene contract says.
// Focal lengths are for a 36 mm long frame edge (three.js filmGauge 36).
export type Vector3 = [number, number, number];
export const PREVIS_FILM_GAUGE = 36;
export const PREVIS_FOCAL_PRESETS = Object.freeze([24, 35, 50, 85] as const);
export const PREVIS_FOCAL_RANGE = Object.freeze({min: 10, max: 300});
const radians = (degrees: number): number => degrees * Math.PI / 180;
const degrees = (value: number): number => value * 180 / Math.PI;

/** Vertical field of view, in degrees, of a focal length on a frame of the given width/height ratio. */
export function previsVerticalFov(focalLength: number, aspect: number): number {
  const filmHeight = PREVIS_FILM_GAUGE / Math.max(aspect, 1);
  return degrees(2 * Math.atan(filmHeight / 2 / focalLength));
}
/** The unit vector a camera looks along. */
export function previsViewDirection(yaw: number, pitch: number): Vector3 {
  const y = radians(yaw), p = radians(pitch);
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}
/** Horizontal forward and right vectors for walking with WASD. */
export function previsWalkAxes(yaw: number): {forward: Vector3; right: Vector3} {
  const y = radians(yaw);
  return {forward: [-Math.sin(y), 0, -Math.cos(y)], right: [Math.cos(y), 0, -Math.sin(y)]};
}
/** Wraps an angle into (-180, 180]. */
export function wrapPrevisAngle(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export const clampPrevisPitch = (pitch: number): number => clamp(pitch, -89, 89);
export const clampPrevisFocal = (focalLength: number): number => clamp(focalLength, PREVIS_FOCAL_RANGE.min, PREVIS_FOCAL_RANGE.max);
const clampCoordinate = (value: number): number => clamp(value, -100, 100);
/** Yaw and pitch that look from one point at another. */
export function previsLookAt(from: Vector3, to: Vector3): {yaw: number; pitch: number} {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], flat = Math.hypot(dx, dz);
  if (flat < 1e-9 && Math.abs(dy) < 1e-9) return {yaw: 0, pitch: 0};
  return {yaw: degrees(Math.atan2(-dx, -dz)), pitch: degrees(Math.atan2(dy, flat))};
}
/** A camera exactly as a scene stores it: rounded, in range, pitch kept off the poles. */
export function normalizePrevisCamera(camera: PrevisCamera): PrevisCamera {
  return {position: camera.position.map(value => roundPrevisNumber(clampCoordinate(value))) as Vector3,
    yaw: roundPrevisNumber(wrapPrevisAngle(camera.yaw)), pitch: roundPrevisNumber(clampPrevisPitch(camera.pitch)),
    focalLength: roundPrevisNumber(clampPrevisFocal(camera.focalLength))};
}
/** Moves a camera in its own horizontal frame: forward, right and up in metres. */
export function walkPrevisCamera(camera: PrevisCamera, forward: number, right: number, up: number): PrevisCamera {
  const axes = previsWalkAxes(camera.yaw), [x, y, z] = camera.position;
  return normalizePrevisCamera({...camera, position: [x + axes.forward[0] * forward + axes.right[0] * right, y + up, z + axes.forward[2] * forward + axes.right[2] * right]});
}
/** Turns a camera in place (free look). */
export function turnPrevisCamera(camera: PrevisCamera, yawDelta: number, pitchDelta: number): PrevisCamera {
  return normalizePrevisCamera({...camera, yaw: camera.yaw + yawDelta, pitch: camera.pitch + pitchDelta});
}
/** Orbits a camera around a pivot, keeping its distance and looking at the pivot. */
export function orbitPrevisCamera(camera: PrevisCamera, pivot: Vector3, yawDelta: number, pitchDelta: number): PrevisCamera {
  const [x, y, z] = camera.position, distance = Math.max(0.2, Math.hypot(x - pivot[0], y - pivot[1], z - pivot[2]));
  const look = previsLookAt(camera.position, pivot), yaw = look.yaw + yawDelta, pitch = clampPrevisPitch(look.pitch + pitchDelta);
  const direction = previsViewDirection(yaw, pitch);
  return normalizePrevisCamera({...camera, yaw, pitch, position: [pivot[0] - direction[0] * distance, pivot[1] - direction[1] * distance, pivot[2] - direction[2] * distance]});
}
// The viewport shows the scene camera itself, wider than the output frame: the
// frame guide sits centred between the top toolbar and the bottom hint bar.
export const PREVIS_FRAME_MARGINS = Object.freeze({top: 72, bottom: 72, side: 24});
export interface PrevisRect {left: number; top: number; width: number; height: number}
/** The output frame inside a viewport of the given size, centred and as large as the margins allow. */
export function previsFrameRect(width: number, height: number, aspect: number): PrevisRect {
  const availableWidth = Math.max(1, width - 2 * PREVIS_FRAME_MARGINS.side), availableHeight = Math.max(1, height - PREVIS_FRAME_MARGINS.top - PREVIS_FRAME_MARGINS.bottom);
  let frameHeight = availableHeight, frameWidth = frameHeight * aspect;
  if (frameWidth > availableWidth) { frameWidth = availableWidth; frameHeight = frameWidth / aspect; }
  return {left: (width - frameWidth) / 2, top: (height - frameHeight) / 2, width: frameWidth, height: frameHeight};
}
/** Vertical field of view of the whole viewport so that the frame guide shows exactly what the output frame shows. */
export function previsViewportFov(focalLength: number, aspect: number, viewportHeight: number, frameHeight: number): number {
  const half = radians(previsVerticalFov(focalLength, aspect)) / 2;
  return degrees(2 * Math.atan(Math.tan(half) * Math.max(1, viewportHeight) / Math.max(1, frameHeight)));
}
/** Unit vector from the scene towards the key light; azimuth turns like a figure's rotation, from +Z. */
export function previsLightDirection(azimuth: number, elevation: number): Vector3 {
  const a = radians(azimuth), e = radians(elevation);
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}
/** Which named shot size a focal length is closest to, for default keyframe names. */
export function previsShotSize(focalLength: number): 'wide' | 'medium' | 'mediumClose' | 'close' {
  if (focalLength < 29.5) return 'wide';
  if (focalLength < 42.5) return 'medium';
  if (focalLength < 67.5) return 'mediumClose';
  return 'close';
}
/** Output frame of the project: the timeline format, or portrait 1080×1920 without one. */
export function previsFrame(format: {width?: unknown; height?: unknown} | null | undefined): {width: number; height: number; aspect: number; ratio: string} {
  const width = typeof format?.width === 'number' && Number.isInteger(format.width) && format.width > 0 ? format.width : 1080;
  const height = typeof format?.height === 'number' && Number.isInteger(format.height) && format.height > 0 ? format.height : 1920;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a, divisor = gcd(width, height);
  return {width, height, aspect: width / height, ratio: `${width / divisor}:${height / divisor}`};
}
