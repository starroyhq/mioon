import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {isNormalizedAbsolutePath} from './media-reference.ts';
/** Records the app database keeps on this computer (project file v1,
 * docs/PROJECT-FILE.md). None of them is ever written into a project file. */

const id = z.string().uuid(), date = z.string().datetime();
const absolutePath = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u);

/** `projectFileIdentity` as decimal strings, so 64- and 128-bit file IDs
 * survive. It finds moved projects and spots copies; never a security check. */
export const projectFileIdentitySchema = z.object({dev: decimal, ino: decimal}).strict();
export type ProjectFileIdentity = z.infer<typeof projectFileIdentitySchema>;

/** The `project.summary.list` fields, cached because a closed project cannot
 * be read without taking its lock. The project host refreshes them while the
 * project is open and when it closes; the server builds the cover URL. */
export const recentProjectSummarySchema = z.object({
  description: z.string().max(2000), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), createdAt: date, updatedAt: date,
  fps: z.literal(30), width: z.number().int().positive(), height: z.number().int().positive(), presetId: z.string().min(1).max(100),
  shotCount: count, durationFrames: count,
  cover: z.object({assetId: id, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])}).strict().nullable(),
}).strict();
export type RecentProjectSummary = z.infer<typeof recentProjectSummarySchema>;
export const recentProjectSchema = z.object({
  projectId: projectIdSchema,
  projectFile: absolutePath,
  fileIdentity: projectFileIdentitySchema,
  name: z.string().min(1).max(150),
  lastOpenedAt: date.nullable(),
  summary: recentProjectSummarySchema.nullable(),
}).strict();
export type RecentProject = z.infer<typeof recentProjectSchema>;

/** Task kinds, named after their tables in the local records. */
export const BACKGROUND_TASK_KINDS = Object.freeze(['job', 'export', 'edit_task', 'image_task', 'frame_task', 'scene_task', 'subject_variant_batch'] as const);
export type BackgroundTaskKind = typeof BACKGROUND_TASK_KINDS[number];
/** An unfinished task. After a restart the backend reopens its project to
 * keep polling and reconciling. */
export const backgroundTaskIndexEntrySchema = z.object({
  projectId: projectIdSchema, projectFile: absolutePath, kind: z.enum(BACKGROUND_TASK_KINDS), taskId: id, indexedAt: date,
}).strict();
export type BackgroundTaskIndexEntry = z.infer<typeof backgroundTaskIndexEntrySchema>;
/** A result that arrived while its project could not be opened. Its media
 * waits in the app data staging area and is written into the project, under
 * the existing receipt and reconciliation rules, when the project next opens.
 * S3 adds the result fields it needs. */
export const projectInboxItemSchema = z.object({
  id, projectId: projectIdSchema, taskKind: z.enum(BACKGROUND_TASK_KINDS), taskId: id, receivedAt: date,
  stagedMedia: z.array(z.object({
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u), mimeType: z.string().min(1).max(100), sizeBytes: count, sha256,
  }).strict()).max(100),
}).strict();
export type ProjectInboxItem = z.infer<typeof projectInboxItemSchema>;

/** AGENTS.md goes to Mio only while this exact content is trusted here. */
export const projectRulesTrustSchema = z.object({projectId: projectIdSchema, sha256, trustedAt: date}).strict();
export type ProjectRulesTrust = z.infer<typeof projectRulesTrustSchema>;
/** The user allowed reading media in this folder outside the project directory. */
export const outsidePathConfirmationSchema = z.object({projectId: projectIdSchema, directory: absolutePath, confirmedAt: date}).strict();
export type OutsidePathConfirmation = z.infer<typeof outsidePathConfirmationSchema>;
/** One `records/<project ID>/` folder. Its size comes from the file system:
 * listing never opens history.db, which is opened only as the main database of
 * its project's connection. hasSuperJournal: a crash left a super-journal
 * (`*-mj*`) in the folder. Such a folder must not be deleted, or the project
 * file can no longer roll back the interrupted commit. */
export const localRecordsEntrySchema = z.object({projectId: projectIdSchema, sizeBytes: count, hasSuperJournal: z.boolean()}).strict();
export type LocalRecordsEntry = z.infer<typeof localRecordsEntrySchema>;
