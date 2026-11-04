/** Host-only recovery session. These are not business RPCs or model tools. */
import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.string().regex(/^[a-f0-9]{32}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const contentStampSchema = z.object({contentSequence: sequence, contentToken: token}).strict();
export type ContentStamp = z.infer<typeof contentStampSchema>;
export const historyFileIdentitySchema = z.object({dev: z.string(), ino: z.string(), size: z.string(), mtimeNs: z.string()}).strict();
export type HistoryFileIdentity = z.infer<typeof historyFileIdentitySchema>;
export const projectHistoryStatusSchema = z.object({
  projectId: projectIdSchema,
  state: z.enum(['fresh', 'current', 'diverged']),
  reason: z.enum(['file-sequence-smaller', 'file-sequence-larger', 'content-token-different', 'legacy-token-missing']).nullable(),
  file: contentStampSchema,
  seen: z.object({contentSequence: sequence, contentToken: token.nullable()}).strict(),
  historyIdentity: historyFileIdentitySchema,
  versionCount: sequence, recoverableVersionCount: sequence, unknownProviderTasks: sequence,
  confirmationDigest: digest,
}).strict().refine(value => value.recoverableVersionCount <= value.versionCount, 'Recoverable versions are a subset of all carried versions.');
export type ProjectHistoryStatus = z.infer<typeof projectHistoryStatusSchema>;
const confirmation = {
  projectId: projectIdSchema, requestId: z.string().uuid().regex(/^[a-f0-9-]{36}$/u), expected: contentStampSchema,
  historyIdentity: historyFileIdentitySchema, confirmationDigest: digest,
};
export const projectHistoryResolveSchema = z.discriminatedUnion('action', [
  z.object({...confirmation, action: z.literal('continue')}).strict(),
  z.object({...confirmation, action: z.literal('restore-version'), versionId: z.string().uuid(), previewDigest: digest}).strict(),
]);
export type ProjectHistoryResolveInput = z.infer<typeof projectHistoryResolveSchema>;
export const projectHistoryResolveResultSchema = z.object({
  projectId: projectIdSchema, requestId: z.string().uuid(), action: z.enum(['continue', 'restore-version']),
  archive: z.string().regex(/^history-\d{14}-[a-f0-9-]{36}\.db$/u),
  content: contentStampSchema,
  /** Activation is scheduled only after exclusive ownership has been released. */
  activation: z.literal('pending'),
}).strict();
export type ProjectHistoryResolveResult = z.infer<typeof projectHistoryResolveResultSchema>;
