import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

const revision = z.number().int().safe().nonnegative();
const version = revision.positive();

/** K5a kernels only knew the 3 -> 4 upgrade; format 5 adds 3/4 -> 5. The
 * source/target pair is explicit so a confirmed preview cannot be replayed
 * against a different destination format. */
export const projectFormatUpgradePreviewSchema = z.object({
  projectId: projectIdSchema,
  contentSequence: revision,
  contentToken: z.string().regex(/^[0-9a-f]{32}$/u),
  projectVersion: z.union([z.literal(3), z.literal(4)]),
  historyVersion: version.nullable(),
  targetProjectVersion: z.union([z.literal(4), z.literal(5)]),
  targetHistoryVersion: version,
}).strict().superRefine((value, context) => {
  const expectedHistory = value.targetProjectVersion === 4 ? 12 : 13;
  if (value.targetHistoryVersion !== expectedHistory) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Target project and history versions must pair', path: ['targetHistoryVersion']});
  }
  if (value.projectVersion >= value.targetProjectVersion) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'An upgrade must advance the project format', path: ['targetProjectVersion']});
  }
  if (value.historyVersion !== null && value.historyVersion >= expectedHistory) {
    context.addIssue({code: z.ZodIssueCode.custom, message: 'An upgrade must advance the history format', path: ['historyVersion']});
  }
});
export type ProjectFormatUpgradePreview = z.infer<typeof projectFormatUpgradePreviewSchema>;
export function projectFormatUpgradeFromError(error: unknown): ProjectFormatUpgradePreview | null {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'PROJECT_FORMAT_UPGRADE_REQUIRED' || !('details' in error)) return null;
  const details = error.details;
  const result = projectFormatUpgradePreviewSchema.safeParse(details && typeof details === 'object' && 'formatUpgrade' in details ? details.formatUpgrade : details);
  return result.success ? result.data : null;
}
export const projectFormatUpgradeInputSchema = z.object({preview: projectFormatUpgradePreviewSchema}).strict();
export const projectFormatUpgradeResultSchema = z.object({projectId: projectIdSchema}).strict();

/** A bounded summary of the portable project. Local history and media paths do not cross this boundary. */
export const PROJECT_FORMAT_READ_ONLY_LIMITS = Object.freeze({items: 500, text: 256, bytes: 3 * 1024 * 1024});
const text = z.string().max(PROJECT_FORMAT_READ_ONLY_LIMITS.text);
const count = PROJECT_FORMAT_READ_ONLY_LIMITS.items;
export const projectFormatReadOnlyViewSchema = z.object({
  projectId: projectIdSchema,
  name: text,
  description: z.string().max(2000),
  projectVersion: z.literal(3),
  shots: z.array(z.object({id: projectIdSchema, title: text, orderIndex: revision, duration: z.number().nonnegative(), versionCount: revision}).strict()).max(count),
  nodes: z.array(z.object({id: projectIdSchema, label: text, type: z.enum(['text', 'image', 'video', 'audio', 'previs'])}).strict()).max(count),
  timeline: z.object({
    width: version, height: version, fps: z.number().positive(), durationFrames: revision,
    tracks: z.array(z.object({id: projectIdSchema, name: text, kind: z.enum(['video', 'audio', 'subtitle'])}).strict()).max(count),
    clips: z.array(z.object({id: projectIdSchema, name: text, trackId: projectIdSchema, startFrame: revision, durationFrames: revision}).strict()).max(count),
  }).strict().nullable(),
  truncated: z.boolean(),
}).strict();
export type ProjectFormatReadOnlyView = z.infer<typeof projectFormatReadOnlyViewSchema>;
