import {z} from 'zod';
import {parseProjectApiPath} from './project-file.ts';
import {speedProcessingReasonSchema} from './timeline-speed.ts';
import type {SpeedProcessingReason} from './timeline-speed.ts';
import {TIMELINE_TIME_MAP_LIMITS} from './timeline-time-map.ts';

export type PreviewMedia =
  | {mode: 'native'; rate: {numerator: number; denominator: number}}
  | {mode: 'proxy'; status: 'ready'; url: string; durationFrames: number}
  | {mode: 'proxy'; status: 'queued' | 'running' | 'failed'; taskId: string;
     progress?: number; reason?: SpeedProcessingReason};

export const timelinePreviewMediaInputSchema = z.object({
  projectId: z.string().uuid(), clipId: z.string().uuid(),
}).strict();

function projectMediaRoute(url: string) {
  if (!url.startsWith('/api/projects/') || !/^\/[-a-z0-9/]+(?:\?[a-zA-Z0-9_=&.-]+)?$/u.test(url)) return null;
  const route = parseProjectApiPath(url.split('?', 1)[0]!);
  return route?.kind === 'media' ? route : null;
}

export function isPreviewMediaForProject(media: PreviewMedia, projectId: string): boolean {
  return media.mode !== 'proxy' || media.status !== 'ready' || projectMediaRoute(media.url)?.projectId === projectId;
}

const rateTerm = z.number().int().positive().max(TIMELINE_TIME_MAP_LIMITS.maxRateTerm);
const rate = z.object({numerator: rateTerm, denominator: rateTerm}).strict()
  .refine(({numerator, denominator}) => numerator * 10 >= denominator && numerator <= denominator * 10);
export const timelinePreviewMediaResponseSchema = z.union([
  z.object({mode: z.literal('native'), rate}).strict(),
  z.object({mode: z.literal('proxy'), status: z.literal('ready'),
    url: z.string().max(512).refine(url => projectMediaRoute(url) !== null),
    durationFrames: z.number().int().positive().max(TIMELINE_TIME_MAP_LIMITS.maxOutputFrames)}).strict(),
  z.object({mode: z.literal('proxy'), status: z.enum(['queued', 'running', 'failed']),
    taskId: z.string().uuid(), progress: z.number().finite().min(0).max(100).optional(),
    reason: speedProcessingReasonSchema.optional()}).strict(),
]) satisfies z.ZodType<PreviewMedia>;
