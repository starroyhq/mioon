import {WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema,backupRestoreSelectionSchema,projectPackageDestinationSchema,projectPackageSavedSchema,type WorkspaceNativeBridge,type ExportFilesNativeBridge,type ProjectPackagesNativeBridge,type ProjectBackupsNativeBridge} from '../../../packages/contracts/src/workspace-native.ts';
import {projectBackupSchemas} from '../../../packages/contracts/src/project-backups.ts';
export function createWorkspaceNativeBridges(invoke:(channel:typeof WORKSPACE_NATIVE_CHANNEL,request:unknown)=>Promise<unknown>):{native:WorkspaceNativeBridge;exports:ExportFilesNativeBridge;projectPackages:ProjectPackagesNativeBridge;projectBackups:ProjectBackupsNativeBridge} {
 const boolean=async(request:unknown)=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse(request));if(typeof value!=='boolean')throw new TypeError('Invalid native workspace response.');return value;};
 return Object.freeze({
  native:Object.freeze({restart:async()=>{await boolean({action:'restart'});}}),
  projectPackages:Object.freeze({
   chooseDestination:async(input:{suggestedName:string})=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse({action:'chooseProjectPackageDestination',suggestedName:input.suggestedName}));return value===null?null:projectPackageDestinationSchema.parse(value);},
   save:async(input:{token:string;exportId:string})=>projectPackageSavedSchema.parse(await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse({action:'saveProjectPackage',token:input.token,exportId:input.exportId}))),
   reveal:(input:{token:string})=>boolean({action:'revealProjectPackage',token:input.token}),
  }),
  projectBackups:Object.freeze({
   chooseDestination:async(input:Parameters<ProjectBackupsNativeBridge['chooseDestination']>[0])=>{
    const selection=backupRestoreSelectionSchema.parse(input),value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse({action:'chooseBackupRestoreDestination',selection}));
    if(value===null)return null;const result=projectBackupSchemas['project.backup.restore'].parse(value);
    if(result.projectId!==selection.projectId||result.backupId!==selection.backupId||result.requestId!==selection.requestId)throw new TypeError('Invalid native backup destination.');return result;
   },
   reveal:(result:Parameters<ProjectBackupsNativeBridge['reveal']>[0])=>boolean({action:'revealRestoredBackup',result}),
  }),
  exports:Object.freeze({open:(identity:Parameters<ExportFilesNativeBridge['open']>[0])=>boolean({action:'openExport',identity}),reveal:(identity:Parameters<ExportFilesNativeBridge['reveal']>[0])=>boolean({action:'revealExport',identity})}),
 });
}
