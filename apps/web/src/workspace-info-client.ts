import {applicationWorkspaceInfoSchema,applicationWorkspaceStorageInfoSchema,workspaceMetadataSchema,mediaToolDiagnosticsSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {WorkspaceToolsBridge,WorkspaceInfoView,ApplicationWorkspaceInfo,ApplicationWorkspaceStorageInfo,WorkspaceMetadata} from '../../../packages/contracts/src/workspace-info.ts';
const bridge=():WorkspaceToolsBridge|undefined=>(window as Window&{__mioonWorkspaceTools?:WorkspaceToolsBridge}).__mioonWorkspaceTools;
async function read(url:string,init?:RequestInit):Promise<unknown>{
  const response=await fetch(url,{credentials:'same-origin',...init});const value:unknown=await response.json();
  if(!response.ok||!value||typeof value!=='object'||!('ok' in value)||value.ok!==true||!('data' in value))throw new Error('Workspace information is unavailable.');
  return value.data;
}
export function readWorkspaceInfo(signal:AbortSignal|undefined,view:'metadata'):Promise<WorkspaceMetadata>;
export function readWorkspaceInfo(signal:AbortSignal|undefined,view:'storage'):Promise<ApplicationWorkspaceStorageInfo>;
export function readWorkspaceInfo(signal?:AbortSignal,view?:'full'):Promise<ApplicationWorkspaceInfo>;
export async function readWorkspaceInfo(signal?:AbortSignal,view:WorkspaceInfoView='full'):Promise<ApplicationWorkspaceInfo|WorkspaceMetadata|ApplicationWorkspaceStorageInfo>{
 const value=await read(view==='full'?'/api/workspace-info':`/api/workspace-info?view=${view}`,{signal});
 return view==='metadata'?workspaceMetadataSchema.parse(value):view==='storage'?applicationWorkspaceStorageInfoSchema.parse(value):applicationWorkspaceInfoSchema.parse(value);
}
export const checkConfiguredMediaTools=async()=>mediaToolDiagnosticsSchema.parse(await read('/api/media-tools/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
export const workspaceToolsBridge=bridge;
/** A browser presents the canonical path for copy; only the fixed native bridge
 * can open it. Neither path nor arbitrary shell operations are accepted by IPC. */
export async function revealWorkspaceLocation():Promise<string|null>{
  const native=bridge();if(native){if(!await native.revealWorkspace())throw new Error('Workspace location is unavailable.');return null;}
  return (await readWorkspaceInfo(undefined,'metadata')).dataDirectory;
}
