import {z} from 'zod';

export const TIMELINE_RIPPLE_REMOVE_OPERATION = 'timeline.clip.rippleRemove' as const;
export const timelineRippleRemoveSchema = z.object({
  projectId: z.string().uuid(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(200),
  clipId: z.string().uuid(),
}).strict();
export type TimelineRippleRemoveInput = z.infer<typeof timelineRippleRemoveSchema>;

export function isTimelineRippleRemoveInput(value: unknown): value is TimelineRippleRemoveInput {
  return timelineRippleRemoveSchema.safeParse(value).success;
}
