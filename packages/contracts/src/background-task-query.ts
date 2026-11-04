import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

/** Application metadata for the existing home screen. Reading this catalog
 * grants no project opening, task dispatch or result-discard authority. */
export const BACKGROUND_TASK_QUERY_LIMITS = Object.freeze({
  maxPageSize: 100, defaultPageSize: 50, responseBytes: 256 * 1024,
});
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/u);
export const backgroundTaskUnavailableProjectSchema = z.object({
  projectId: projectIdSchema,
  taskCount: z.number().int().min(1).max(512),
  reasonCodes: z.array(reason).min(1).max(32),
}).strict().refine(value => new Set(value.reasonCodes).size === value.reasonCodes.length,
  'Each safe background reason appears once.');
export const backgroundTaskQueryResponseSchema = z.object({
  version: z.literal(1),
  projects: z.array(backgroundTaskUnavailableProjectSchema).max(BACKGROUND_TASK_QUERY_LIMITS.maxPageSize),
  nextCursor: projectIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  const ids = value.projects.map(project => project.projectId);
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
    context.addIssue({code: 'custom', message: 'Background projects must be unique and ordered.'});
  if (value.nextCursor !== null && value.nextCursor !== ids.at(-1))
    context.addIssue({code: 'custom', message: 'The next cursor must name the last returned project.'});
});
export type BackgroundTaskQueryResponse = z.infer<typeof backgroundTaskQueryResponseSchema>;
