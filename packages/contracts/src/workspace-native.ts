import {z} from 'zod';
import {workspaceSettingsSchema,type WorkspaceSettings} from './workspace-configuration.ts';
export const WORKSPACE_NATIVE_CHANNEL='mioon:workspace-native';
const identity=z.object({projectId:z.string().uuid(),exportId:z.string().uuid()}).strict();
export const workspaceNativeRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('chooseBackupLocation')}).strict(),z.object({action:z.literal('revealBackupLocation')}).strict(),z.object({action:z.literal('restart')}).strict(),
 z.object({action:z.literal('openExport'),identity}).strict(),z.object({action:z.literal('revealExport'),identity}).strict(),
]);
export const workspaceNativeUtilityRequestSchema=z.object({type:z.literal('workspace-native:setBackupDirectory'),requestId:z.string().uuid(),directory:z.string().min(1).max(4096)}).strict();
export const workspaceNativeUtilityReplySchema=z.discriminatedUnion('ok',[
 z.object({type:z.literal('workspace-native:reply'),requestId:z.string().uuid(),ok:z.literal(true),settings:workspaceSettingsSchema}).strict(),
 z.object({type:z.literal('workspace-native:reply'),requestId:z.string().uuid(),ok:z.literal(false),code:z.literal('WORKSPACE_NATIVE_UNAVAILABLE')}).strict(),
]);
export interface WorkspaceBackupNativeBridge {chooseLocation():Promise<WorkspaceSettings|null>;revealLocation():Promise<boolean>;restart():Promise<void>}
export interface ExportFilesNativeBridge {open(identity:{projectId:string;exportId:string}):Promise<boolean>;reveal(identity:{projectId:string;exportId:string}):Promise<boolean>}
export type WorkspaceNativeUtilityRequest=z.infer<typeof workspaceNativeUtilityRequestSchema>;

