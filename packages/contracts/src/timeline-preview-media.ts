import {z} from 'zod';
import {isProjectId, parseProjectApiPath, projectMediaPath} from './project-file.ts';
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

export const TIMELINE_PREVIEW_MEDIA_QUERY = 'speedPreview';

interface PreviewMediaQuery {
  readonly clipId: string;
  readonly taskId: string;
  readonly digest: string;
}
type PreviewMediaAddress = PreviewMediaQuery & {readonly projectId: string; readonly assetId: string};
const validDigest = (value: string | null): value is string => value !== null && /^[a-f0-9]{64}$/u.test(value);

/** A proxy URL binds the clip's current task and the admitted cache result.
 * Authentication and ownership are checked again when the URL is read. */
export function timelinePreviewMediaPath({projectId, assetId, clipId, taskId, digest}: PreviewMediaAddress): string {
  if (!isProjectId(clipId) || !isProjectId(taskId) || !validDigest(digest)) throw new TypeError('Invalid timeline preview address');
  const params = new URLSearchParams({[TIMELINE_PREVIEW_MEDIA_QUERY]: clipId, taskId, digest});
  return projectMediaPath(projectId, assetId) + '?' + params;
}

export function parseTimelinePreviewMediaQuery(params: URLSearchParams): PreviewMediaQuery | null {
  const clipId = params.get(TIMELINE_PREVIEW_MEDIA_QUERY), taskId = params.get('taskId'), digest = params.get('digest');
  if (params.size !== 3 || !isProjectId(clipId) || !isProjectId(taskId) || !validDigest(digest)) return null;
  return {clipId, taskId, digest};
}

function previewMediaAddress(url: string): PreviewMediaAddress | null {
  if (!/^\/[-a-z0-9/]+\?[-a-zA-Z0-9=&]+$/u.test(url)) return null;
  const [path, query] = url.split('?', 2);
  const route = parseProjectApiPath(path!);
  const params = parseTimelinePreviewMediaQuery(new URLSearchParams(query));
  return route?.kind === 'media' && params ? {projectId: route.projectId, assetId: route.assetId, ...params} : null;
}

export function isPreviewMediaForClip(media: PreviewMedia, projectId: string, clipId: string): boolean {
  if (media.mode !== 'proxy' || media.status !== 'ready') return true;
  const address = previewMediaAddress(media.url);
  return address?.projectId === projectId && address.clipId === clipId;
}

const rateTerm = z.number().int().positive().max(TIMELINE_TIME_MAP_LIMITS.maxRateTerm);
const rate = z.object({numerator: rateTerm, denominator: rateTerm}).strict()
  .refine(({numerator, denominator}) => numerator * 10 >= denominator && numerator <= denominator * 10);
export const timelinePreviewMediaResponseSchema = z.union([
  z.object({mode: z.literal('native'), rate}).strict(),
  z.object({mode: z.literal('proxy'), status: z.literal('ready'),
    url: z.string().max(512).refine(url => previewMediaAddress(url) !== null),
    durationFrames: z.number().int().positive().max(TIMELINE_TIME_MAP_LIMITS.maxOutputFrames)}).strict(),
  z.object({mode: z.literal('proxy'), status: z.enum(['queued', 'running', 'failed']),
    taskId: z.string().uuid(), progress: z.number().finite().min(0).max(100).optional(),
    reason: speedProcessingReasonSchema.optional()}).strict(),
]) satisfies z.ZodType<PreviewMedia>;
