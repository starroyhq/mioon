import {WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema,type WorkspaceBackupNativeBridge,type ExportFilesNativeBridge} from '../../../packages/contracts/src/workspace-native.ts';
import {workspaceSettingsSchema} from '../../../packages/contracts/src/workspace-configuration.ts';
export function createWorkspaceNativeBridges(invoke:(channel:typeof WORKSPACE_NATIVE_CHANNEL,request:unknown)=>Promise<unknown>):{backups:WorkspaceBackupNativeBridge;exports:ExportFilesNativeBridge} {
 const boolean=async(request:unknown)=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,workspaceNativeRequestSchema.parse(request));if(typeof value!=='boolean')throw new TypeError('Invalid native workspace response.');return value;};
 return Object.freeze({
  backups:Object.freeze({chooseLocation:async()=>{const value=await invoke(WORKSPACE_NATIVE_CHANNEL,{action:'chooseBackupLocation'});return value===null?null:workspaceSettingsSchema.parse(value);},revealLocation:()=>boolean({action:'revealBackupLocation'}),restart:async()=>{await boolean({action:'restart'});}}),
  exports:Object.freeze({open:(identity:Parameters<ExportFilesNativeBridge['open']>[0])=>boolean({action:'openExport',identity}),reveal:(identity:Parameters<ExportFilesNativeBridge['reveal']>[0])=>boolean({action:'revealExport',identity})}),
 });
}
