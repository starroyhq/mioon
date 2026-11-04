import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {PROJECT_FILE_EXTENSION, projectIdSchema} from './project-file.ts';
import {PROJECT_NAME_MAX_LENGTH, projectNameProblem} from './project-name.ts';
import {recentProjectSchema} from './project-registry.ts';

/** Application-only lifecycle contracts. They are intentionally absent from
 * public operation discovery and the model tool catalog. */
const projectFile = z.string().min(1).max(4096).refine(value =>
  isNormalizedAbsolutePath(value) && value.endsWith(PROJECT_FILE_EXTENSION)
  && !value.split(/[\\/]/u).at(-1)!.startsWith('.'), 'Choose a normalized absolute .mioon file.');
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const projectCopyInputSchema = z.object({
  projectId: projectIdSchema,
  requestId: projectIdSchema,
  projectFile,
  name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).refine(value => projectNameProblem(value) === null, 'Invalid project name.').optional(),
}).strict();
export type ProjectCopyInput = z.infer<typeof projectCopyInputSchema>;
export type ProjectCopyOperation = 'project.duplicate' | 'project.save-as';
export const projectCopySchemas = Object.freeze({
  'project.duplicate': projectCopyInputSchema,
  'project.save-as': projectCopyInputSchema,
});
export const isProjectCopyOperation = (value: unknown): value is ProjectCopyOperation =>
  value === 'project.duplicate' || value === 'project.save-as';

export const projectCopyResponseSchema = z.object({
  requestId: projectIdSchema,
  sourceProjectId: projectIdSchema,
  project: recentProjectSchema.refine(value => projectFile.safeParse(value.projectFile).success, 'The copied project must use a .mioon file.'),
  contentSequence: count,
  contentToken: z.string().regex(/^[a-f0-9]{32}$/u),
  versions: count,
}).strict().refine(value => value.sourceProjectId !== value.project.projectId, 'The copied project must have a new project ID.');
export type ProjectCopyResponse = z.infer<typeof projectCopyResponseSchema>;
