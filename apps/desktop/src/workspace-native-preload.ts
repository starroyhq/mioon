import {WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema,projectPackageDestinationSchema,projectPackageSavedSchema,type WorkspaceBackupNativeBridge,type ExportFilesNativeBridge,type ProjectPackagesNativeBridge} from '../../../packages/contracts/src/workspace-native.ts';
import {workspaceSettingsSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
export function createWorkspaceNativeBridges(invoke:(channel:typeof WORKSPACE_NATIVE_CHANNEL,request:unknown)=>Promise<unknown>):{backups:WorkspaceBackupNativeBridge;exports:ExportFilesNativeBridge;projectPackages:ProjectPackagesNativeBridge} {
 const boolean=async(request:unknown)=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse(request));if(typeof value!=='boolean')throw new TypeError('Invalid native workspace response.');return value;};
 return Object.freeze({
  backups:Object.freeze({chooseLocation:async()=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,{action:'chooseBackupLocation'});return value===null?null:workspaceSettingsSchema.parse(value);},revealLocation:()=>boolean({action:'revealBackupLocation'}),restart:async()=>{await boolean({action:'restart'});}}),
  projectPackages:Object.freeze({
   chooseDestination:async(input:{suggestedName:string})=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse({action:'chooseProjectPackageDestination',suggestedName:input.suggestedName}));return value===null?null:projectPackageDestinationSchema.parse(value);},
   save:async(input:{token:string;exportId:string})=>projectPackageSavedSchema.parse(await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse({action:'saveProjectPackage',token:input.token,exportId:input.exportId}))),
   reveal:(input:{token:string})=>boolean({action:'revealProjectPackage',token:input.token}),
  }),
  exports:Object.freeze({open:(identity:Parameters<ExportFilesNativeBridge['open']>[0])=>boolean({action:'openExport',identity}),reveal:(identity:Parameters<ExportFilesNativeBridge['reveal']>[0])=>boolean({action:'revealExport',identity})}),
 });
}
