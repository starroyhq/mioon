import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {projectIdSchema} from './project-file.ts';
import {projectFileIdentitySchema} from './project-registry.ts';
import {projectAdoptCopyInputSchema, projectCopyToInputSchema, projectTemplateInputSchema, projectCopyResponseSchema} from './project-copies.ts';

const file = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath);
const identity = projectFileIdentitySchema.nullable();
/** Private S5-B continuation, separate from the already shipped S5-A format.
 * This adds no application database tables or schema version. */
const common = {
  version: z.literal(1), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: projectIdSchema, contentToken: z.string().regex(/^[a-f0-9]{32}$/u),
  sourceFile: file, sourceProjectId: projectIdSchema, sourceIdentity: projectFileIdentitySchema,
  sourceStamp: z.object({contentSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), contentToken: z.string().regex(/^[a-f0-9]{32}$/u)}).strict().nullable(),
  targetFile: file, targetDirectory: file.nullable(),
  phase: z.enum(['prepared', 'captured', 'ready', 'records-published', 'project-published', 'completed', 'abandoned']),
  stageDirectory: file.nullable(), stageDirectoryIdentity: identity, stageIdentity: identity,
  historyIdentity: identity, recordsIdentity: identity, placeholderIdentity: identity,
  directoryPlaceholderIdentity: identity, response: projectCopyResponseSchema.nullable(),
};
export const projectCopyActionIntentSchema = z.discriminatedUnion('operation', [
  z.object({...common, operation: z.literal('project.adopt-copy'), input: projectAdoptCopyInputSchema}).strict(),
  z.object({...common, operation: z.literal('project.copy-to'), input: projectCopyToInputSchema}).strict(),
  z.object({...common, operation: z.literal('project.template.instantiate'), input: projectTemplateInputSchema}).strict(),
]).superRefine((value, ctx) => {
  const response = value.response;
  const expectedTarget = value.operation === 'project.adopt-copy' ? value.input.sourceFile
    : value.operation === 'project.copy-to' ? value.input.projectFile : null;
  if (value.projectId === value.sourceProjectId || expectedTarget && expectedTarget !== value.targetFile
    || value.operation !== 'project.template.instantiate' && (value.sourceFile !== value.input.sourceFile
      || value.sourceProjectId !== value.input.sourceProjectId
      || JSON.stringify(value.sourceIdentity) !== JSON.stringify(value.input.sourceIdentity)
      || value.sourceStamp?.contentSequence !== value.input.sourceStamp.contentSequence
      || value.sourceStamp?.contentToken !== value.input.sourceStamp.contentToken)
    || response && (response.requestId !== value.input.requestId || response.sourceProjectId !== value.sourceProjectId
      || response.project.projectId !== value.projectId || response.project.projectFile !== value.targetFile
      || response.contentToken !== value.contentToken || response.project.fileIdentity.dev !== value.stageIdentity?.dev
      || response.project.fileIdentity.ino !== value.stageIdentity?.ino)) {
    ctx.addIssue({code: 'custom', message: 'Copy action identity binding is invalid.'});
  }
  if (['ready', 'records-published', 'project-published', 'completed'].includes(value.phase)
    && (!response || !value.stageDirectory || !value.stageDirectoryIdentity || !value.stageIdentity || !value.historyIdentity)) {
    ctx.addIssue({code: 'custom', message: 'Copy action has no complete prepared outcome.'});
  }
});
export type ProjectCopyActionIntent = z.infer<typeof projectCopyActionIntentSchema>;
