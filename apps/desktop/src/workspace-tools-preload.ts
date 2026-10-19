import {WORKSPACE_TOOLS_CHANNEL,mediaToolDiagnosticsSchema,toolPathsSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {WorkspaceToolsBridge} from '../../../packages/contracts/src/workspace-info.ts';
export function createWorkspaceToolsBridge(invoke:(channel:typeof WORKSPACE_TOOLS_CHANNEL,request:unknown)=>Promise<unknown>):WorkspaceToolsBridge{
  return Object.freeze({
    read:async()=>toolPathsSchema.parse(await invoke(WORKSPACE_TOOLS_CHANNEL,{action:'read'})),
    select:async(tool:'ffmpeg'|'ffprobe')=>{if(tool!=='ffmpeg'&&tool!=='ffprobe')throw new TypeError('Invalid tool.');const result=await invoke(WORKSPACE_TOOLS_CHANNEL,{action:'select',tool});if(result!==null&&(typeof result!=='string'||result.length>4096))throw new TypeError('Invalid selected path.');return result;},
    check:async paths=>mediaToolDiagnosticsSchema.parse(await invoke(WORKSPACE_TOOLS_CHANNEL,{action:'check',paths:toolPathsSchema.parse(paths)})),
    save:async paths=>mediaToolDiagnosticsSchema.parse(await invoke(WORKSPACE_TOOLS_CHANNEL,{action:'save',paths:toolPathsSchema.parse(paths)})),
    revealWorkspace:async()=>{const result=await invoke(WORKSPACE_TOOLS_CHANNEL,{action:'revealWorkspace'});if(typeof result!=='boolean')throw new TypeError('Invalid location response.');return result;},
  } satisfies WorkspaceToolsBridge);
}
