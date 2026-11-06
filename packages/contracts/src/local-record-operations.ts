import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';
import {localRecordsEntrySchema, recentProjectSchema} from './project-registry.ts';
import {projectEntryResponseSchema} from './project-entry.ts';
import type {OperationEffect} from './operation-effects.ts';

/** Application UI operations only: not model tools or public discovery. The
 * identity binds confirmation to the exact library and backend that listed it. */
export const LOCAL_RECORDS_LIMITS = Object.freeze({maxRecords: 8192, responseBytes: 64 * 1024 * 1024});
export const localRecordsIdentitySchema = z.object({
  appLibraryScope: projectEntryResponseSchema.shape.appLibraryScope,
  instanceId: projectEntryResponseSchema.shape.instanceId,
}).strict();
export type LocalRecordsIdentity = z.infer<typeof localRecordsIdentitySchema>;
export const localRecordItemSchema = localRecordsEntrySchema.extend({
  name: recentProjectSchema.shape.name.nullable(), projectFile: recentProjectSchema.shape.projectFile.nullable(),
  hasUnfinishedTasks: z.boolean(),
  automaticBackups: z.object({
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();
export type LocalRecordItem = z.infer<typeof localRecordItemSchema>;
export type LocalRecord = LocalRecordItem;
export const localRecordsListInputSchema = z.object({}).strict();
export const localRecordsListResponseSchema = localRecordsIdentitySchema.extend({
  version: z.literal(1), records: z.array(localRecordItemSchema).max(LOCAL_RECORDS_LIMITS.maxRecords),
}).strict().refine(value => new Set(value.records.map(record => record.projectId)).size === value.records.length,
  'Each local records project appears once.');
export type LocalRecordsListResponse = z.infer<typeof localRecordsListResponseSchema>;
export const localRecordsDeleteInputSchema = z.object({
  projectId: projectIdSchema,
  expectedAppLibraryScope: localRecordsIdentitySchema.shape.appLibraryScope,
  expectedInstanceId: localRecordsIdentitySchema.shape.instanceId,
}).strict();
export type LocalRecordsDeleteInput = z.infer<typeof localRecordsDeleteInputSchema>;
export const localRecordsDeleteResponseSchema = localRecordsIdentitySchema.extend({
  projectId: projectIdSchema, deleted: z.literal(true),
}).strict();
export type LocalRecordsDeleteResponse = z.infer<typeof localRecordsDeleteResponseSchema>;
export const localRecordSchemas = Object.freeze({
  'local.records.list': localRecordsListInputSchema,
  'local.records.delete': localRecordsDeleteInputSchema,
});
export type LocalRecordOperation = keyof typeof localRecordSchemas;
export const isLocalRecordOperation = (operation: unknown): operation is LocalRecordOperation =>
  typeof operation === 'string' && Object.hasOwn(localRecordSchemas, operation);
export const localRecordResponseSchemas = Object.freeze({
  'local.records.list': localRecordsListResponseSchema,
  'local.records.delete': localRecordsDeleteResponseSchema,
});
const removal: Readonly<OperationEffect> = Object.freeze({readOnly: false, idempotent: false, destructive: true,
  openWorld: false, databaseWrite: false, fileWrite: true, externalIO: false, localProcess: false, paidGeneration: false,
  notes: 'Deletes only confirmed orphan local records after rechecking the application owner, identity, project and work guards. No receipt: an unknown result must be reconciled by listing, never automatically retried.'});
export const localRecordEffects: Readonly<Record<LocalRecordOperation, Readonly<OperationEffect>>> = Object.freeze({
  'local.records.list': Object.freeze({...removal, idempotent: true,
    notes: 'Lists orphan local records without opening project/history databases. Continues removal of tombstones left by an already-confirmed deletion; normal records are not removed.'}),
  'local.records.delete': removal,
});

export function isLocalRecordResponse(operation: LocalRecordOperation, input: unknown, output: unknown): boolean {
  const parsed = localRecordSchemas[operation].safeParse(input);
  const response = localRecordResponseSchemas[operation].safeParse(output);
  if (!parsed.success || !response.success) return false;
  if (operation === 'local.records.list') return true;
  const wanted = parsed.data as LocalRecordsDeleteInput, actual = response.data as LocalRecordsDeleteResponse;
  return actual.projectId === wanted.projectId && actual.appLibraryScope === wanted.expectedAppLibraryScope
    && actual.instanceId === wanted.expectedInstanceId;
}
