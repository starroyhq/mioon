/** Versioned private JSON records. These are not written to history.db or a
 * project file; operation contracts remain in project-backups.ts. */
import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {projectIdSchema} from './project-file.ts';
import {recentProjectSchema} from './project-registry.ts';
import {projectBackupSummarySchema} from './project-backups.ts';

const absolute = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath);
export const projectBackupEntrySchema = projectBackupSummarySchema.extend({sourceProjectDir: absolute});
export const projectBackupIndexSchema = z.object({version: z.literal(2), projectId: projectIdSchema,
  backups: z.array(projectBackupEntrySchema).max(3)}).strict();
export type ProjectBackupEntry = z.infer<typeof projectBackupEntrySchema>;
/** Old indexes have no content-token evidence and never qualify for reuse. */
export const legacyProjectBackupIndexSchema = z.object({version:z.literal(1),projectId:projectIdSchema,
  backups:z.array(projectBackupEntrySchema.omit({contentToken:true})).max(3)}).strict();
const intentFields = {
  requestId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u), sourceProjectId: projectIdSchema,
  backupId: z.string().uuid(), projectFile: absolute, projectId: projectIdSchema,
  phase: z.enum(['prepared', 'published', 'registered']),
  fileIdentity: z.object({dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u)}).strict().nullable(),
  project: recentProjectSchema.nullable(),
};
export const legacyProjectBackupIntentSchema = z.object({version:z.literal(1),...intentFields}).strict();
/** The source pair and newly allocated target token are fixed before copy. */
export const projectBackupIntentSchema = z.object({version:z.literal(2),...intentFields,
  sourceContentSequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceContentToken:z.string().regex(/^[a-f0-9]{32}$/u),
  targetContentToken:z.string().regex(/^[a-f0-9]{32}$/u),
}).strict().refine(value=>value.sourceContentToken!==value.targetContentToken,'A restored project requires a new content token.');
