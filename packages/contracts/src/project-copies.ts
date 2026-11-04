import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {PROJECT_FILE_EXTENSION, projectIdSchema} from './project-file.ts';
import {PROJECT_NAME_MAX_LENGTH, projectNameProblem} from './project-name.ts';
import {projectFileIdentitySchema, recentProjectSchema} from './project-registry.ts';

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

/** A selected, closed file is bound by both filesystem and content identity.
 * These values are observations to recheck, never permission to overwrite. */
export const projectCopySourceSchema = z.object({
  sourceProjectId: projectIdSchema,
  sourceFile: projectFile,
  sourceIdentity: projectFileIdentitySchema,
  sourceStamp: z.object({contentSequence: count, contentToken: z.string().regex(/^[a-f0-9]{32}$/u)}).strict(),
}).strict();
export const projectAdoptCopyInputSchema = projectCopySourceSchema.extend({requestId: projectIdSchema}).strict();
export const projectCopyToInputSchema = projectAdoptCopyInputSchema.extend({
  projectFile,
  name: projectCopyInputSchema.shape.name,
}).strict().refine(value => value.sourceFile !== value.projectFile, 'Choose a new target project file.');
export const projectTemplateInputSchema = z.object({
  templateId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/u),
  templateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  parentDir: z.string().min(1).max(4096).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.'),
  name: projectCopyInputSchema.shape.name.unwrap(),
  requestId: projectIdSchema,
}).strict();
export type ProjectAdoptCopyInput = z.infer<typeof projectAdoptCopyInputSchema>;
export type ProjectCopyToInput = z.infer<typeof projectCopyToInputSchema>;
export type ProjectTemplateInput = z.infer<typeof projectTemplateInputSchema>;
export type ProjectCopyActionInput = ProjectAdoptCopyInput | ProjectCopyToInput | ProjectTemplateInput;
export const projectCopyActionSchemas = Object.freeze({
  'project.adopt-copy': projectAdoptCopyInputSchema,
  'project.copy-to': projectCopyToInputSchema,
  'project.template.instantiate': projectTemplateInputSchema,
});
export type ProjectCopyActionOperation = keyof typeof projectCopyActionSchemas;
export const isProjectCopyActionOperation = (value: unknown): value is ProjectCopyActionOperation =>
  value === 'project.adopt-copy' || value === 'project.copy-to' || value === 'project.template.instantiate';

export const projectCopyResponseSchema = z.object({
  requestId: projectIdSchema,
  sourceProjectId: projectIdSchema,
  project: recentProjectSchema.refine(value => projectFile.safeParse(value.projectFile).success, 'The copied project must use a .mioon file.'),
  contentSequence: count,
  contentToken: z.string().regex(/^[a-f0-9]{32}$/u),
  versions: count,
}).strict().refine(value => value.sourceProjectId !== value.project.projectId, 'The copied project must have a new project ID.');
export type ProjectCopyResponse = z.infer<typeof projectCopyResponseSchema>;
