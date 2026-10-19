/** Explicit ordinary40 → ordinary42 offline copy. No restored profile,
 * automatic entrypoint or execution permission is described by this contract. */
import {z} from 'zod';

export const OPACITY_UPGRADE_SOURCE_VERSION = 40;
export const OPACITY_UPGRADE_TARGET_VERSION = 42;
export const OPACITY_UPGRADE_DRAFT_POLICY = 'excluded-empty-only';
export const OPACITY_UPGRADE_TASK_POLICY = 'settled-only';
export const OPACITY_UPGRADE_WARNINGS = Object.freeze(['SOURCE_LOCK_RELEASE_UNCONFIRMED', 'DESTINATION_LOCK_RELEASE_UNCONFIRMED'] as const);
export const OPACITY_UPGRADE_ERROR_CODES = Object.freeze([
  'WORKSPACE_UPGRADE_INVALID_PATH', 'WORKSPACE_UPGRADE_DESTINATION_EXISTS', 'WORKSPACE_UPGRADE_DESTINATION_WORKSPACE_ANCESTOR',
  'WORKSPACE_UPGRADE_SOURCE_INVALID', 'WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED', 'WORKSPACE_UPGRADE_UNRESOLVED_TASKS',
  'WORKSPACE_UPGRADE_UNSUPPORTED_ASSET', 'WORKSPACE_UPGRADE_UNSUPPORTED_EXPORT', 'WORKSPACE_UPGRADE_DRAFTS_UNSUPPORTED',
  'WORKSPACE_UPGRADE_COMPANION_INVALID', 'WORKSPACE_UPGRADE_SCOPE_MISMATCH', 'WORKSPACE_UPGRADE_INVENTORY_INCOMPLETE',
  'WORKSPACE_UPGRADE_CHANGED', 'WORKSPACE_UPGRADE_LOCKED', 'WORKSPACE_UPGRADE_LOCK_LOST', 'WORKSPACE_UPGRADE_NOT_COLD',
  'WORKSPACE_UPGRADE_LIMIT', 'WORKSPACE_UPGRADE_CANCELLED', 'WORKSPACE_UPGRADE_IO', 'WORKSPACE_UPGRADE_PRESERVATION_FAILED',
  'WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED',
] as const);
export type OpacityWorkspaceUpgradeErrorCode = typeof OPACITY_UPGRADE_ERROR_CODES[number];
export type OpacityUpgradeErrorCode = OpacityWorkspaceUpgradeErrorCode;
const hash = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const inputPath = z.string().min(1).max(4096).refine(value => !value.includes('\0'), {message: 'An explicit local path is required.'});

/** Canonical ancestry, private ownership, overlap and no-follow validation
 * belong to the offline filesystem operation, not this browser-safe DTO. */
export const opacityWorkspaceUpgradeInputSchema = z.object({
  source: inputPath, backup: inputPath, destination: inputPath,
  channel: z.enum(['web', 'development', 'production']),
}).strict();
export type OpacityWorkspaceUpgradeInput = z.infer<typeof opacityWorkspaceUpgradeInputSchema>;

export const opacityWorkspaceUpgradeResultSchema = z.object({
  sourceVersion: z.literal(40), targetVersion: z.literal(42), profile: z.literal('ordinary'),
  sourceBackupId: z.string().length(36).uuid(), manifestHash: hash, sourceDbHash: hash, targetDbHash: hash,
  fileCount: z.number().int().min(1).max(20_000), payloadBytes: z.number().int().min(1).max(64 * 1024 * 1024 * 1024),
  preferencePolicy: z.literal('preserved'), draftPolicy: z.literal(OPACITY_UPGRADE_DRAFT_POLICY),
  taskPolicy: z.literal(OPACITY_UPGRADE_TASK_POLICY), sourcePolicy: z.literal('unchanged'), publication: z.literal('confirmed'),
  warnings: z.array(z.enum(OPACITY_UPGRADE_WARNINGS)).min(1).max(OPACITY_UPGRADE_WARNINGS.length).optional(),
}).strict().superRefine((value, context) => {
  if (value.warnings && new Set(value.warnings).size !== value.warnings.length)
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Cleanup warnings must be unique.'});
});
export type OpacityWorkspaceUpgradeResult = z.infer<typeof opacityWorkspaceUpgradeResultSchema>;
