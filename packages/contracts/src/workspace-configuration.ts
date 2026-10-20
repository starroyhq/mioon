import {z} from 'zod';

const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const workspaceSettingsSchema=z.object({
  formatVersion:z.literal(1),revision,liveGeneration:z.boolean(),automaticBackup:z.boolean(),
  backupIntervalHours:z.union([z.literal(1),z.literal(6),z.literal(24),z.literal(168)]),
  backupLocation:z.enum(['default','selected']),backupDirectory:z.string().min(1).max(4096),
}).strict();
export const workspaceSettingsUpdateSchema=z.object({
  expectedRevision:revision,liveGeneration:z.boolean().optional(),automaticBackup:z.boolean().optional(),
  backupIntervalHours:z.union([z.literal(1),z.literal(6),z.literal(24),z.literal(168)]).optional(),
  backupLocation:z.enum(['default','selected']).optional(),
}).strict().refine(value=>Object.keys(value).length>1,'At least one setting is required');
export const workspaceBackupRecordSchema=z.object({
  id:z.string().uuid(),createdAt:z.string().datetime(),fileCount:revision,payloadBytes:revision,
  trigger:z.enum(['manual','automatic','import']),requestId:z.string().uuid(),
}).strict();
export const workspaceBackupStatusSchema=z.object({
  phase:z.enum(['idle','creating','restoring','importing']),directory:z.string().min(1).max(4096),
  automatic:z.boolean(),intervalHours:z.number(),lastBackupAt:z.string().datetime().nullable(),
  nextBackupAt:z.string().datetime().nullable(),lastError:z.string().max(80).nullable(),
  backups:z.array(workspaceBackupRecordSchema).max(100),
  pendingRestore:z.object({requestId:z.string().uuid(),backupId:z.string().uuid(),state:z.enum(['pending','active']),restartRequired:z.boolean()}).strict().nullable(),
}).strict();
// Private runtime records; these schemas are never accepted as RPC input.
export const workspaceBackupIndexSchema=z.object({formatVersion:z.literal(1),entries:z.array(workspaceBackupRecordSchema.extend({directory:z.string().min(1).max(4096)}).strict()).max(100),nextBackupAt:z.string().datetime().nullable(),lastError:z.string().max(80).nullable()}).strict();
export const workspaceActivationSchema=z.object({formatVersion:z.literal(1),state:z.enum(['pending','active']),requestId:z.string().uuid(),backupId:z.string().uuid(),destination:z.string().min(1).max(4096),restorationId:z.string().uuid(),sourceBackupId:z.string().uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),sourceDbHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const workspaceConfigurationSchemas={
  'workspace.settings.get':z.object({}).strict(),
  'workspace.settings.set':workspaceSettingsUpdateSchema,
  'workspace.backup.status':z.object({}).strict(),
  'workspace.backup.list':z.object({}).strict(),
  'workspace.backup.create':z.object({requestId:z.string().uuid()}).strict(),
  'workspace.backup.restore.stage':z.object({requestId:z.string().uuid(),backupId:z.string().uuid(),confirmation:z.literal('RESTORE_BACKUP')}).strict(),
} as const;
export type WorkspaceSettings=z.infer<typeof workspaceSettingsSchema>;
export type WorkspaceSettingsUpdate=z.infer<typeof workspaceSettingsUpdateSchema>;
export type WorkspaceBackupEntry=z.infer<typeof workspaceBackupRecordSchema>;
export type WorkspaceBackupStatus=z.infer<typeof workspaceBackupStatusSchema>;
export type WorkspaceBackupIndex=z.infer<typeof workspaceBackupIndexSchema>;
