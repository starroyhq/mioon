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
export interface ProjectBackupsNativeBridge {
 chooseDestination(input:z.infer<typeof backupRestoreSelectionSchema>):Promise<z.infer<typeof projectBackupSchemas['project.backup.restore']>|null>;
 reveal(result:z.infer<typeof projectBackupRestoreResponseSchema>):Promise<boolean>;
}

