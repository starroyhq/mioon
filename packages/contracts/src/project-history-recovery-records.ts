/** Private local switch journal. Never accepted as an HTTP payload. */
import {z} from 'zod';
import {historyFileIdentitySchema, projectHistoryResolveResultSchema, projectHistoryResolveSchema} from './project-history-recovery.ts';

const fileId = z.object({dev: z.string(), ino: z.string()}).strict();
export const projectHistorySwitchIntentSchema = z.object({
  version: z.literal(1), input: projectHistoryResolveSchema, digest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectIdentity: fileId, sourceIdentity: historyFileIdentitySchema,
  archive: z.string().regex(/^history-\d{14}-[a-f0-9-]{36}\.db$/u),
  phase: z.enum(['prepared', 'staged', 'committed', 'archived', 'completed']),
  stagedIdentity: fileId.nullable(), result: projectHistoryResolveResultSchema.nullable(),
}).strict().refine(value => {
  if (value.input.historyIdentity.dev !== value.sourceIdentity.dev || value.input.historyIdentity.ino !== value.sourceIdentity.ino
    || value.input.historyIdentity.size !== value.sourceIdentity.size || value.input.historyIdentity.mtimeNs !== value.sourceIdentity.mtimeNs) return false;
  if (value.phase === 'prepared') return value.stagedIdentity === null && value.result === null;
  if (!value.stagedIdentity) return false;
  if (value.phase === 'staged') return value.result === null;
  const result = value.result;
  return result !== null && result.projectId === value.input.projectId && result.requestId === value.input.requestId
    && result.action === value.input.action && result.archive === value.archive;
}, 'Switch phases must bind the exact source and committed result.');
export type ProjectHistorySwitchIntent = z.infer<typeof projectHistorySwitchIntentSchema>;
export const projectHistorySwitchActiveSchema = z.object({requestId: z.string().uuid()}).strict();
