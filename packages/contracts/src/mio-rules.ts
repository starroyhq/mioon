import {z} from 'zod';
import {PROJECT_RULES_FILE} from './project-file.ts';

export const RULES_MAX_BYTES = 8192;
const encoder = new TextEncoder();
const invalidCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;
/** Hashing and publication use the original UTF-8 bytes, including CRLF.
 * With Unicode matching, surrogate pairs remain valid astral characters. */
export function rulesTextProblem(text: string, maxBytes = RULES_MAX_BYTES): 'tooLong' | 'invalid' | null {
  if (encoder.encode(text).byteLength > maxBytes) return 'tooLong';
  return invalidCharacters.test(text) ? 'invalid' : null;
}
export const rulesTextSchema = z.string().refine(text => rulesTextProblem(text) === null, {message: 'Rules must be plain text within 8192 UTF-8 bytes.'});
export const rulesHashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
export const rulesRequestIdSchema = z.string().min(8).max(200).refine(value => !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value), {message: 'Request identity must retain exact plain Unicode text.'});
const projectId = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const projectRulesSaveInputSchema = z.object({requestId: rulesRequestIdSchema, expectedHash: rulesHashSchema.nullable(), text: rulesTextSchema}).strict();
export const projectRulesEnableInputSchema = z.object({requestId: rulesRequestIdSchema, expectedHash: rulesHashSchema}).strict();
export const userRulesSaveInputSchema = z.object({requestId: rulesRequestIdSchema, expectedRevision: revision, text: rulesTextSchema}).strict();
/** A proposal has no approval, trust or path authority. */
export const projectRulesToolInputSchema = z.object({expectedHash: rulesHashSchema.nullable(), proposedText: rulesTextSchema}).strict();
export type ProjectRulesSaveInput = z.infer<typeof projectRulesSaveInputSchema>;
export type ProjectRulesEnableInput = z.infer<typeof projectRulesEnableInputSchema>;
export type UserRulesSaveInput = z.infer<typeof userRulesSaveInputSchema>;
export type ProjectRulesToolInput = z.infer<typeof projectRulesToolInputSchema>;

export const RULES_READ_ERRORS = ['too_large', 'invalid_utf8', 'invalid_text', 'unsafe_file', 'changed', 'io_error', 'trust_unavailable'] as const;
export const projectRulesSnapshotSchema = z.object({
  projectId, file: z.literal(PROJECT_RULES_FILE), exists: z.boolean(), text: rulesTextSchema.nullable(), hash: rulesHashSchema.nullable(),
  trust: z.enum(['trusted', 'untrusted', 'absent', 'unavailable', 'pending']), maxBytes: z.literal(RULES_MAX_BYTES),
  readError: z.enum(RULES_READ_ERRORS).nullable(), pendingWrites: z.boolean(),
}).strict().refine(value => {
  if (value.pendingWrites !== (value.trust === 'pending')) return false;
  if ((value.text === null) !== (value.hash === null)) return false;
  if (value.text !== null && (!value.exists || value.readError !== null)) return false;
  if (value.trust === 'trusted' || value.trust === 'untrusted') return value.exists && value.text !== null && value.readError === null;
  if (value.trust === 'absent') return !value.exists && value.text === null && value.readError === null;
  if (value.trust === 'unavailable') return value.text === null && value.readError !== null;
  return true;
}, {message: 'Rules visibility must agree with trust, read errors and pending writes.'});
export type ProjectRulesSnapshot = z.infer<typeof projectRulesSnapshotSchema>;
export const userRulesSnapshotSchema = z.object({text: rulesTextSchema, revision, updatedAt: z.string().datetime().nullable(), maxBytes: z.literal(RULES_MAX_BYTES)}).strict();
export type UserRulesSnapshot = z.infer<typeof userRulesSnapshotSchema>;

const lookupIdentity = {projectId, requestId: rulesRequestIdSchema};
export const projectRulesRequestLookupSchema = z.discriminatedUnion('status', [
  z.object({...lookupIdentity, status: z.literal('not_applied'), state: z.enum(['not_applied']).nullable(), result: z.null()}).strict(),
  z.object({...lookupIdentity, status: z.literal('applied'), state: z.literal('completed'), result: projectRulesSnapshotSchema}).strict(),
  z.object({...lookupIdentity, status: z.literal('uncertain'), state: z.enum(['prepared', 'publication_unknown', 'published', 'trust_pending']), result: z.null()}).strict(),
]).refine(value => value.status !== 'applied' || value.result.projectId === value.projectId, {message: 'Rules receipts belong to their addressed project.'});
export type ProjectRulesRequestLookup = z.infer<typeof projectRulesRequestLookupSchema>;
export const userRulesRequestLookupSchema = z.discriminatedUnion('status', [
  z.object({requestId: rulesRequestIdSchema, status: z.literal('not_applied'), result: z.null()}).strict(),
  z.object({requestId: rulesRequestIdSchema, status: z.literal('applied'), result: userRulesSnapshotSchema}).strict(),
]);
export type UserRulesRequestLookup = z.infer<typeof userRulesRequestLookupSchema>;

export const MIO_RULES_ERROR_STATUS = Object.freeze({
  MIO_RULES_INVALID: 400, MIO_RULES_TOO_LARGE: 413, MIO_RULES_CONFLICT: 409,
  MIO_RULES_REQUEST_CONFLICT: 409, MIO_RULES_PENDING: 409, MIO_RULES_NOT_FOUND: 404,
  MIO_RULES_UNAVAILABLE: 503, MIO_RULES_WRITE_UNCERTAIN: 409, MIO_RULES_READ_ONLY: 409,
} as const);
export type MioRulesErrorCode = keyof typeof MIO_RULES_ERROR_STATUS;
