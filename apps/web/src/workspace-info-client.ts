import {workspaceInfoSchema,mediaToolDiagnosticsSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {WorkspaceToolsBridge} from '../../../packages/contracts/src/workspace-info.ts';
const bridge=():WorkspaceToolsBridge|undefined=>(window as Window&{__mioonWorkspaceTools?:WorkspaceToolsBridge}).__mioonWorkspaceTools;
async function read(url:string,init?:RequestInit):Promise<unknown>{
  const response=await fetch(url,{credentials:'same-origin',...init});const value:unknown=await response.json();
  if(!response.ok||!value||typeof value!=='object'||!('ok' in value)||value.ok!==true||!('data' in value))throw new Error('Workspace information is unavailable.');
  return value.data;
}
export const readWorkspaceInfo=async(signal?:AbortSignal)=>workspaceInfoSchema.parse(await read('/api/workspace-info',{signal}));
export const checkConfiguredMediaTools=async()=>mediaToolDiagnosticsSchema.parse(await read('/api/media-tools/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
export const workspaceToolsBridge=bridge;
/** A browser presents the canonical path for copy; only the fixed native bridge
 * can open it. Neither path nor arbitrary shell operations are accepted by IPC. */
export async function revealWorkspaceLocation():Promise<string|null>{
  const native=bridge();if(native){if(!await native.revealWorkspace())throw new Error('Workspace location is unavailable.');return null;}
  return (await readWorkspaceInfo()).dataDirectory;
}
