import {z} from 'zod';
import {
  AGENT_TASK_LOCALES, AGENT_TASK_STATUSES, AGENT_TASK_STEP_STATUSES, AGENT_TASK_TIERS,
} from './agent-tasks-v2.ts';
import type {AgentTaskJson} from './agent-tasks-v2.ts';

const id = z.string().uuid();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.refine(value => value > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const date = z.string().datetime();
const requestId = z.string().min(8).max(200);
/** Scalars and persistence formats, imported by path rather than exposed as
 * public HTTP snapshots. Model requests and provider output remain private. */
export const mioIdentitySchemas = Object.freeze({id, count, hash, date, requestId});
export const mioJsonSchema: z.ZodType<AgentTaskJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(mioJsonSchema), z.record(mioJsonSchema),
]));

export const mioConversationSchema = z.object({id, projectId: id, createdAt: date, updatedAt: date}).strict();
export type MioConversation = z.infer<typeof mioConversationSchema>;

export const mioRunSchema = z.object({
  id, projectId: id, conversationId: id, requestId, digest: hash, status: z.enum(AGENT_TASK_STATUSES),
  revision: positive, stepLimit: positive, budget: positive, stepsUsed: count, locale: z.enum(AGENT_TASK_LOCALES),
  configurationBlobHash: hash.nullable(), settingsRevision: count.nullable(), rulesSnapshotHash: hash.nullable(),
  usageSummary: mioJsonSchema.nullable(), createdAt: date, updatedAt: date,
}).strict().refine(value => value.stepsUsed <= value.budget);
export type MioRun = z.infer<typeof mioRunSchema>;

export const MIO_ENTRY_KINDS = [
  'user_message', 'note', 'model_output', 'tool_result', 'answer', 'host_state', 'host_hint',
  'compaction', 'repair', 'model_summary', 'request_reassembled', 'partial_output', 'rules_snapshot',
] as const;
export const mioEntrySchema = z.object({
  id, projectId: id, conversationId: id, runId: id, sequence: positive, kind: z.enum(MIO_ENTRY_KINDS),
  payloadJson: mioJsonSchema.nullable(), payloadBlobHash: hash.nullable(), createdAt: date,
}).strict();
export type MioEntry = z.infer<typeof mioEntrySchema>;

/** Exact inputs of one assembly. Neither a body copy nor a live directory is
 * an acceptable substitute for the frozen source capabilities. */
export const mioInputManifestSchema = z.object({
  version: z.literal(1), entryIds: z.array(id).max(20000), noteEntryIds: z.array(id).max(20000),
  configurationBlobHash: hash, toolsBlobHash: hash, systemBlobHash: hash, baselineBlobHash: hash,
  rulesBlobHash: hash.nullable(), parameters: mioJsonSchema, viewVersion: positive,
}).strict().refine(value => new Set(value.entryIds).size === value.entryIds.length &&
  new Set(value.noteEntryIds).size === value.noteEntryIds.length && value.noteEntryIds.every(item => value.entryIds.includes(item)));
export type MioInputManifest = z.infer<typeof mioInputManifestSchema>;

export const mioStepSchema = z.object({
  id, runId: id, projectId: id, position: positive, kind: z.enum(['model', 'tool', 'wait']),
  status: z.enum(AGENT_TASK_STEP_STATUSES), tier: z.enum(AGENT_TASK_TIERS).nullable(),
  createdAt: date, updatedAt: date, currentRequestId: id.nullable(), sourceEntryId: id.nullable(),
  sourceCallIndex: count.nullable(), resultEntryId: id.nullable(), partialText: z.string().nullable(), data: mioJsonSchema,
}).strict();
export type MioStep = z.infer<typeof mioStepSchema>;

export const mioRequestSchema = z.object({
  id, stepId: id, assemblyNumber: positive, assemblerVersion: positive,
  protocol: z.enum(['chat_completions', 'responses', 'anthropic_messages']), bodySha256: hash, bodyBytes: positive,
  state: z.enum(['intent', 'dispatch_started', 'completed', 'failed', 'unknown', 'superseded']),
  originalBody: z.string().nullable(), inputManifest: mioInputManifestSchema,
  firstEntry: id.nullable(), lastEntry: id.nullable(), assembledAt: date,
  dispatchStartedAt: date.nullable(), completedAt: date.nullable(), previousRequestId: id.nullable(), assemblyReason: z.string().min(1).max(100),
}).strict();
export type MioRequest = z.infer<typeof mioRequestSchema>;

/** One canonical provider completion, without duplicate text/call projections. */
export const mioModelOutputSchema = z.object({
  protocol: z.enum(['chat_completions', 'responses', 'anthropic_messages']), providerOutput: mioJsonSchema,
  usage: z.object({inputTokens: count.optional(), outputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional()}).strict().optional(),
}).strict();
export type MioModelOutput = z.infer<typeof mioModelOutputSchema>;

export const mioImportSchema = z.object({
  id, projectId: id, requestId, name: z.string().min(1), mimeType: z.string().min(1).max(200),
  relativePath: z.string().min(1).max(512), sha256: hash, status: z.string().min(1).max(100),
  assetId: id.nullable(), resourceId: id.nullable(), createdAt: date,
}).strict();
export type MioImport = z.infer<typeof mioImportSchema>;

export const mioOriginSchema = z.object({
  kind: z.enum(['job', 'export', 'image', 'frame', 'scene']), jobId: id, runId: id, stepId: id,
  projectId: id, requestId, operation: z.string().min(1).max(100),
}).strict();
export type MioOrigin = z.infer<typeof mioOriginSchema>;

export const mioClaimSchema = z.object({
  id, projectId: id, ownerId: requestId, kind: z.string().min(1).max(80), targetId: z.string().min(1).max(200),
  revision: count, state: z.enum(['active', 'uncertain']), createdAt: date, updatedAt: date,
}).strict();
export type MioClaim = z.infer<typeof mioClaimSchema>;

export const mioEditOwnerSchema = z.object({ownerId: requestId, projectId: id, generation: count, sequence: count}).strict();
export type MioEditOwner = z.infer<typeof mioEditOwnerSchema>;

export const mioControlSchema = z.object({requestId, runId: id, projectId: id, digest: hash, data: mioJsonSchema}).strict();
export const mioEditReceiptSchema = z.object({requestId, ownerId: requestId, digest: hash, data: mioJsonSchema}).strict();
export const mioEventSchema = z.object({runId: id, sequence: positive, createdAt: date}).strict();
