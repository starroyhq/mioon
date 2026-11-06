import {z} from 'zod';
import {projectBackupSchemas, projectBackupRestoreResponseSchema} from './project-backups.ts';
import {projectIdSchema} from './project-file.ts';
export const WORKSPACE_NATIVE_CHANNEL='mioon:workspace-native';
const identity=z.object({projectId:z.string().uuid(),exportId:z.string().uuid()}).strict();
export const backupRestoreSelectionSchema=z.object({projectId:projectIdSchema,backupId:z.string().uuid(),requestId:z.string().uuid()}).strict();
export const workspaceNativeRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('restart')}).strict(),
 z.object({action:z.literal('openExport'),identity}).strict(),z.object({action:z.literal('revealExport'),identity}).strict(),
 // Project files: the chosen path stays in the main process behind a one-use token.
 z.object({action:z.literal('chooseProjectPackageDestination'),suggestedName:z.string().min(1).max(200)}).strict(),
 z.object({action:z.literal('saveProjectPackage'),token:z.string().uuid(),exportId:z.string().uuid()}).strict(),
 z.object({action:z.literal('revealProjectPackage'),token:z.string().uuid()}).strict(),
 z.object({action:z.literal('chooseBackupRestoreDestination'),selection:backupRestoreSelectionSchema}).strict(),
 z.object({action:z.literal('revealRestoredBackup'),result:projectBackupRestoreResponseSchema}).strict(),
]);
export const projectPackageDestinationSchema=z.object({token:z.string().uuid(),fileName:z.string().min(1).max(255)}).strict();
export const projectPackageSavedSchema=z.object({fileName:z.string().min(1).max(255)}).strict();
export interface WorkspaceNativeBridge {restart():Promise<void>}
export interface ExportFilesNativeBridge {open(identity:{projectId:string;exportId:string}):Promise<boolean>;reveal(identity:{projectId:string;exportId:string}):Promise<boolean>}
export interface ProjectPackagesNativeBridge {
 chooseDestination(input:{suggestedName:string}):Promise<{token:string;fileName:string}|null>;
 save(input:{token:string;exportId:string}):Promise<{fileName:string}>;
 reveal(input:{token:string}):Promise<boolean>;
}
/** Internal backup IPC/contextBridge replies carry codes as data: Electron
 * does not preserve custom Error properties across either boundary. */
export const PROJECT_BACKUP_NATIVE_ERROR_CODES = [
 'PROJECT_ACCESS_DENIED','PROJECT_BACKUP_CHANGED','PROJECT_BACKUP_RESTORE_CHANGED',
 'PROJECT_BACKUP_NOT_FOUND','PROJECT_BACKUP_INDEX_INVALID',
 'PROJECT_LOCATION_REJECTED','PROJECT_LOCATION_INVALID','WORKSPACE_NATIVE_UNAVAILABLE',
] as const;
export type ProjectBackupNativeErrorCode=typeof PROJECT_BACKUP_NATIVE_ERROR_CODES[number];
export type ProjectBackupNativeResult<T>={ok:true;value:T}|{ok:false;code:ProjectBackupNativeErrorCode};
const backupNativeFailureSchema=z.object({ok:z.literal(false),code:z.enum(PROJECT_BACKUP_NATIVE_ERROR_CODES)}).strict();
export const projectBackupNativeChooseResponseSchema=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),value:projectBackupSchemas['project.backup.restore'].nullable()}).strict(),backupNativeFailureSchema,
]);
export const projectBackupNativeRevealResponseSchema=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),value:z.boolean()}).strict(),backupNativeFailureSchema,
]);
export interface ProjectBackupsNativeBridge {
 chooseDestination(input:z.infer<typeof backupRestoreSelectionSchema>):Promise<ProjectBackupNativeResult<z.infer<typeof projectBackupSchemas['project.backup.restore']>|null>>;
 reveal(result:z.infer<typeof projectBackupRestoreResponseSchema>):Promise<ProjectBackupNativeResult<boolean>>;
}

