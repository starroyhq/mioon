import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {projectIdSchema} from './project-file.ts';
import {projectFileIdentitySchema} from './project-registry.ts';
import {projectCopyInputSchema, projectCopyResponseSchema} from './project-copies.ts';

const absolutePath = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath);
const stamp = z.object({contentSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), contentToken: z.string().regex(/^[a-f0-9]{32}$/u)}).strict();
/** Private recovery input, never a public operation or a project-file table. */
export const projectCopyIntentSchema = z.object({
  version: z.literal(1), operation: z.enum(['project.duplicate', 'project.save-as']), input: projectCopyInputSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u), projectId: projectIdSchema, contentToken: stamp.shape.contentToken,
  sourceFile: absolutePath, sourceIdentity: projectFileIdentitySchema, sourceStamp: stamp.nullable(),
  phase: z.enum(['prepared', 'captured', 'ready', 'records-published', 'project-published', 'completed']),
  stageDirectory: absolutePath.nullable(), stageDirectoryIdentity: projectFileIdentitySchema.nullable(),
  stageIdentity: projectFileIdentitySchema.nullable(), historyIdentity: projectFileIdentitySchema.nullable(),
  recordsIdentity: projectFileIdentitySchema.nullable(), placeholderIdentity: projectFileIdentitySchema.nullable(),
  fileIdentity: projectFileIdentitySchema.nullable(), response: projectCopyResponseSchema.nullable(),
}).strict().superRefine((value, context) => {
  const response = value.response;
  if (value.projectId === value.input.projectId || response && (response.requestId !== value.input.requestId
    || response.sourceProjectId !== value.input.projectId || response.project.projectId !== value.projectId
    || response.project.projectFile !== value.input.projectFile || response.contentToken !== value.contentToken
    || response.project.fileIdentity.dev !== value.stageIdentity?.dev || response.project.fileIdentity.ino !== value.stageIdentity?.ino)) {
    context.addIssue({code: 'custom', message: 'Copy recovery identity does not match its request and response.'});
  }
  if (['ready', 'records-published', 'project-published', 'completed'].includes(value.phase)
    && (!response || !value.stageDirectory || !value.stageDirectoryIdentity || !value.stageIdentity || !value.historyIdentity)) {
    context.addIssue({code: 'custom', message: 'A prepared copy outcome and its exact stages are required.'});
  }
});
export type ProjectCopyIntent = z.infer<typeof projectCopyIntentSchema>;
