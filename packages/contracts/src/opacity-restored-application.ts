/** Fixed restored43 application disclosure. This browser-safe contract grants
 * no store, origin or execution capability and never widens legacy profiles. */
import {z} from 'zod';

export const OPACITY_RESTORED_APPLICATION_READ_OPERATIONS = Object.freeze([
  'project.list', 'project.get', 'asset.list', 'asset.get', 'export.list', 'export.get', 'provider.list', 'workspace.restore.inspect',
  'timeline.get', 'timeline.history.get',
]);
export const OPACITY_RESTORED_APPLICATION_LOCAL_OPERATIONS = Object.freeze(['timeline.clip.update', 'timeline.undo', 'timeline.redo', 'timeline.render']);
const advisory = ['timeline.export.preflight', 'timeline.export.capabilities'];
const denied = ['project.create', 'asset.import', 'timeline.format.get', 'timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.remove',
  'timeline.clip.split', 'timeline.clip.replaceSource', 'timeline.seed', 'timeline.format.set', 'workspace.backup.inspect', 'workspace.preferences.put',
  'generation.submit', 'job.retry', 'job.cancel', 'job.reconcile', 'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove',
  'timeline.audioPreview.plan', 'timeline.audioPreview.continuousPlan', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.clip.loudness',
  'timeline.loudness.apply', 'asset.waveform.request', 'frame.extract'];
const available = new Set([...OPACITY_RESTORED_APPLICATION_READ_OPERATIONS, ...OPACITY_RESTORED_APPLICATION_LOCAL_OPERATIONS, ...advisory]);
const operations = Object.freeze([...available, ...denied]);
const operationPolicy = Object.freeze(operations.map(operation => Object.freeze({operation, available: available.has(operation),
  reason: available.has(operation) ? 'AVAILABLE' as const : 'RESTORE_OPERATION_UNAVAILABLE' as const})));
const uuid = z.string().length(36).uuid(), hash = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const kind = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/u), count = z.number().int().min(0).max(20000);
const heldCounts = z.array(z.object({kind, count}).strict()).max(64);
export const opacityRestoredApplicationInspectionSchema = z.object({
  restored: z.literal(true), schemaVersion: z.literal(43), profile: z.literal('restored-local-v10'),
  workspaceOrigin: uuid, restorationId: uuid, createdAt: z.string().datetime(),
  source: z.object({backupId: uuid, schemaVersion: z.literal(42), manifestHash: hash, dbHash: hash}).strict(),
  heldCounts,
  operationPolicy: z.array(z.object({operation: z.string().min(1).max(80), available: z.boolean(),
    reason: z.enum(['AVAILABLE', 'RESTORE_OPERATION_UNAVAILABLE'])}).strict()).length(operations.length),
  backupCreate: z.object({available: z.literal(false), reason: z.literal('RESTORE_BACKUP_UNAVAILABLE')}).strict(),
  draftPolicy: z.literal('excluded'),
}).strict().superRefine((value, context) => {
  const entries = new Map(value.operationPolicy.map(entry => [entry.operation, entry]));
  if (entries.size !== operations.length || operationPolicy.some(expected => {
    const actual = entries.get(expected.operation);
    return !actual || actual.available !== expected.available || actual.reason !== expected.reason;
  })) context.addIssue({code: z.ZodIssueCode.custom, message: 'The restored43 application policy must match its fixed operation boundary.'});
  if (new Set(value.heldCounts.map(entry => entry.kind)).size !== value.heldCounts.length || value.heldCounts.reduce((total, entry) => total + entry.count, 0) > 20000)
    context.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid captured record totals.'});
});
export type OpacityRestoredApplicationInspection = z.infer<typeof opacityRestoredApplicationInspectionSchema>;
export function isOpacityRestoredApplicationInspection(value: unknown): value is OpacityRestoredApplicationInspection {
  return opacityRestoredApplicationInspectionSchema.safeParse(value).success;
}
const metadataSchema = z.object({schemaVersion: z.literal(43), sourceSchema: z.literal(42), profile: z.literal('restored-local-v10'),
  workspaceOrigin: uuid, restorationId: uuid, sourceBackupId: uuid, manifestHash: hash, sourceDbHash: hash, createdAt: z.string().datetime(),
  heldCounts: z.record(kind, count),
}).strict();
/** Metadata must already come from the exact43 constructor/validator. This
 * formatter cannot select a database profile or authorize any operation. */
export function createOpacityRestoredApplicationInspection(info: unknown): OpacityRestoredApplicationInspection {
  const value = metadataSchema.parse(info);
  return opacityRestoredApplicationInspectionSchema.parse({restored: true, schemaVersion: 43, profile: value.profile,
    workspaceOrigin: value.workspaceOrigin, restorationId: value.restorationId, createdAt: value.createdAt,
    source: {backupId: value.sourceBackupId, schemaVersion: 42, manifestHash: value.manifestHash, dbHash: value.sourceDbHash},
    heldCounts: Object.entries(value.heldCounts).sort(([left], [right]) => left.localeCompare(right)).map(([kind, count]) => ({kind, count})),
    operationPolicy, backupCreate: {available: false, reason: 'RESTORE_BACKUP_UNAVAILABLE'}, draftPolicy: 'excluded'});
}
