import {z} from 'zod';
import {projectFormatUpgradePreviewSchema} from './project-format-upgrade.ts';

// Shared by the preload and broker. The privileged control commands and
// their file identities do not participate in renderer error validation.
export const projectEntryControlErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,90}$/u),
  status: z.number().int().min(400).max(599),
  details: z.object({
    projectId: z.string().uuid().optional(),
    requestId: z.string().min(8).max(200).optional(),
    operation: z.enum([
      'create', 'adoptCopy', 'saveAs', 'duplicate', 'copyTo', 'instantiateTemplate',
      'release', 'openPath', 'acquire', 'markOpened', 'prepareAcquire', 'listRecent',
      'updateActivity', 'inspectCopy', 'observeSource', 'observeFormat', 'readOnlyFormat',
      'capabilities', 'mediaRelinkCandidate', 'mediaRelinkPreview', 'mediaRelinkApply',
      'mediaRelinkDiscard', 'fcpChooseDestination', 'fcpCompletedBundle',
    ]).optional(),
    database: z.enum(['project', 'history', 'cache']).optional(),
    reason: z.string().max(100).optional(),
    invalidReason: z.string().max(100).optional(),
    formatVersion: z.number().int().positive().optional(),
    supportedFormatVersion: z.number().int().positive().optional(),
    formatUpgrade: projectFormatUpgradePreviewSchema.optional(),
  }).strict(),
}).strict();
