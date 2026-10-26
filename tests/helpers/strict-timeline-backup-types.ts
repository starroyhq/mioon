import type {workspaceBackupResultSchema} from '../../packages/contracts/src/workspace-backup.ts';
import type {workspaceRestoreOfflineResultSchema,workspaceRestorePublicationStatusSchema} from '../../packages/contracts/src/workspace-restore-offline.ts';
export type BackupResult=ReturnType<typeof workspaceBackupResultSchema.parse>;
export type RestoreResult=Omit<ReturnType<typeof workspaceRestoreOfflineResultSchema.parse>,'profile'|'sourceSchema'|'databaseSchemaVersion'> & {profile:string;sourceSchema:number;databaseSchemaVersion:number};
export type RestorePublication=ReturnType<typeof workspaceRestorePublicationStatusSchema.parse>;
