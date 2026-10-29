import type {PrevisCamera,PrevisScene} from './previs.ts';

// What a previs camera frames, without rendering. The editor, the inspector and
// Mio's previs reading tool share this math. Yaw 0 and pitch 0 look along -Z,
// positive yaw turns left (counter-clockwise seen from above) and positive
// pitch looks up, as the scene contract says. Focal lengths are for a 36 mm
// long frame edge (three.js filmGauge 36).
export type PrevisPoint = readonly [number, number, number];
export const PREVIS_FILM_GAUGE = 36;
const radians = (degrees: number): number => degrees * Math.PI / 180;
const degrees = (value: number): number => value * 180 / Math.PI;

/** Vertical field of view, in degrees, of a focal length on a frame of the given width/height ratio. */
export function previsVerticalFov(focalLength: number, aspect: number): number {
  const filmHeight = PREVIS_FILM_GAUGE / Math.max(aspect, 1);
  return degrees(2 * Math.atan(filmHeight / 2 / focalLength));
}
/** The unit vector a camera looks along. */
export function previsViewDirection(yaw: number, pitch: number): [number, number, number] {
  const y = radians(yaw), p = radians(pitch);
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}
/** Yaw and pitch, in degrees and not rounded, that look from one point at another. */
export function previsLookAt(from: PrevisPoint, to: PrevisPoint): {yaw: number; pitch: number} {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], flat = Math.hypot(dx, dz);
  if (flat < 1e-9 && Math.abs(dy) < 1e-9) return {yaw: 0, pitch: 0};
  return {yaw: degrees(Math.atan2(-dx, -dz)), pitch: degrees(Math.atan2(dy, flat))};
}
/** Output frame of the project: the timeline format, or portrait 1080×1920 without one. */
export function previsFrame(format: {width?: unknown; height?: unknown} | null | undefined): {width: number; height: number; aspect: number; ratio: string} {
  const width = typeof format?.width === 'number' && Number.isInteger(format.width) && format.width > 0 ? format.width : 1080;
  const height = typeof format?.height === 'number' && Number.isInteger(format.height) && format.height > 0 ? format.height : 1920;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a, divisor = gcd(width, height);
  return {width, height, aspect: width / height, ratio: `${width / divisor}:${height / divisor}`};
}
/** Whether a point shows inside the output frame of a camera. */
export function previsCameraSees(camera: PrevisCamera, aspect: number, point: PrevisPoint): boolean {
  const yaw = radians(camera.yaw), forward = previsViewDirection(camera.yaw, camera.pitch);
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)] as const;
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]] as const;
  const d = [point[0] - camera.position[0], point[1] - camera.position[1], point[2] - camera.position[2]] as const;
  const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
  if (depth <= 0.05) return false;
  const half = Math.tan(radians(previsVerticalFov(camera.focalLength, aspect)) / 2);
  const x = (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) / depth, y = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / depth;
  return Math.abs(x) <= half * aspect && Math.abs(y) <= half;
}
export interface PrevisFramed {readonly figures: string[]; readonly props: string[]}
/** IDs of the visible figures and props a camera shows in the output frame,
 * in scene order. A figure counts when its feet, middle or head is in frame
 * (a seated one is lower); a prop at its middle, a held prop at the hand. */
export function previsFramedElements(scene: PrevisScene, camera: PrevisCamera, aspect: number): PrevisFramed {
  const figures: string[] = [], props: string[] = [];
  for (const figure of scene.figures) {
    if (!figure.visible) continue;
    const [x, y, z] = figure.position, top = figure.pose === 'sit' ? 1.3 : 1.7;
    if ([0.15, 0.9, top].some(height => previsCameraSees(camera, aspect, [x, y + height, z]))) figures.push(figure.id);
  }
  for (const prop of scene.props) {
    const holder = scene.figures.find(item => item.held?.propId === prop.id);
    if (!prop.visible || holder && !holder.visible) continue;
    const base = holder ? holder.position : prop.position, height = holder ? 1.1 : prop.size[1] / 2;
    if (previsCameraSees(camera, aspect, [base[0], base[1] + height, base[2]])) props.push(prop.id);
  }
  return {figures, props};
}
