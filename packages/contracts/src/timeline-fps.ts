import {z} from 'zod';

export const TIMELINE_FPS = Object.freeze([24, 25, 30, 60] as const);
export const timelineFpsSchema = z.union([
  z.literal(TIMELINE_FPS[0]), z.literal(TIMELINE_FPS[1]), z.literal(TIMELINE_FPS[2]), z.literal(TIMELINE_FPS[3]),
]);
export type TimelineFps = z.infer<typeof timelineFpsSchema>;

export function isTimelineFps(value: unknown): value is TimelineFps {
  return typeof value === 'number' && (TIMELINE_FPS as readonly number[]).includes(value);
}
