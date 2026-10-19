import {workspaceToolsRequestSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {MediaToolDiagnostics,ToolPaths} from '../../../packages/contracts/src/workspace-info.ts';
interface Options<E>{isTrusted(event:E):boolean;read():Promise<ToolPaths>;select(tool:'ffmpeg'|'ffprobe'):Promise<string|null>;check(paths:ToolPaths):Promise<MediaToolDiagnostics>;save(paths:ToolPaths):Promise<void>;revealWorkspace():Promise<boolean>}
/** No arbitrary path opening, channel forwarding, shell commands or file reads. */
export function createWorkspaceToolsHost<E>(options:Options<E>){
  return {async dispatch(event:E,raw:unknown):Promise<unknown>{
    const request=workspaceToolsRequestSchema.parse(raw);
    const checkpoint=()=>{if(!options.isTrusted(event))throw new Error('Native workspace tools are unavailable.');};
    checkpoint();
    if(request.action==='read'){const result=await options.read();checkpoint();return result;}
    if(request.action==='select'){const result=await options.select(request.tool);checkpoint();return result;}
    if(request.action==='revealWorkspace')return options.revealWorkspace();
    const result=await options.check(request.paths);checkpoint();
    if(request.action==='save'){
      if(!result.ffmpeg.available||!result.ffprobe.available||!result.capabilities.libx264||!result.capabilities.aac)throw new Error('FFmpeg / ffprobe are unavailable or lack required encoders.');
      await options.save({ffmpeg:result.ffmpeg.path,ffprobe:result.ffprobe.path});checkpoint();
    }
    return result;
  }};
}
