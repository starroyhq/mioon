import {workspaceToolsRequestSchema} from '../../../packages/contracts/src/workspace-info.ts';
import type {MediaToolDiagnostics,MediaToolsInstallResult,MediaToolsStatus,ToolPaths} from '../../../packages/contracts/src/workspace-info.ts';
/** Mioon's pinned FFmpeg download; installation never accepts a URL, path or command from the renderer. */
interface MediaToolsService{status():Promise<MediaToolsStatus>;install():Promise<{readonly ok:true;readonly paths:ToolPaths}|{readonly ok:false;readonly code:string}>;cancel():boolean}
interface Options<E>{isTrusted(event:E):boolean;read():Promise<ToolPaths>;select(tool:'ffmpeg'|'ffprobe'):Promise<string|null>;check(paths:ToolPaths):Promise<MediaToolDiagnostics>;save(paths:ToolPaths):Promise<void>;revealWorkspace():Promise<boolean>;mediaTools?:MediaToolsService}
const usable=(result:MediaToolDiagnostics)=>result.ffmpeg.available&&result.ffprobe.available&&result.capabilities.libx264&&result.capabilities.aac;
const unavailable:MediaToolsStatus={offer:null,installed:null,progress:{phase:'idle',receivedBytes:0,totalBytes:0,code:null}};
/** No arbitrary path opening, channel forwarding, shell commands or file reads. */
export function createWorkspaceToolsHost<E>(options:Options<E>){
  return {async dispatch(event:E,raw:unknown):Promise<unknown>{
    const request=workspaceToolsRequestSchema.parse(raw);
    const checkpoint=()=>{if(!options.isTrusted(event))throw new Error('Native workspace tools are unavailable.');};
    checkpoint();
    if(request.action==='read'){const result=await options.read();checkpoint();return result;}
    if(request.action==='select'){const result=await options.select(request.tool);checkpoint();return result;}
    if(request.action==='revealWorkspace')return options.revealWorkspace();
    if(request.action==='mediaToolsStatus'){const result=options.mediaTools?await options.mediaTools.status():unavailable;checkpoint();return result;}
    if(request.action==='cancelMediaToolsInstall')return options.mediaTools?.cancel()??false;
    if(request.action==='installMediaTools'){
      if(!options.mediaTools)return {ok:false,code:'MEDIA_TOOLS_UNAVAILABLE'} satisfies MediaToolsInstallResult;
      const installed=await options.mediaTools.install();checkpoint();
      if(!installed.ok)return {ok:false,code:installed.code} satisfies MediaToolsInstallResult;
      // The same diagnostics and save rule as a user-selected pair; a window
      // that lost its trusted document never writes the configuration.
      const diagnostics=await options.check(installed.paths);checkpoint();
      if(!usable(diagnostics))return {ok:false,code:'MEDIA_TOOLS_CHECK_FAILED'} satisfies MediaToolsInstallResult;
      await options.save({ffmpeg:diagnostics.ffmpeg.path,ffprobe:diagnostics.ffprobe.path});checkpoint();
      return {ok:true,paths:{ffmpeg:diagnostics.ffmpeg.path,ffprobe:diagnostics.ffprobe.path},diagnostics} satisfies MediaToolsInstallResult;
    }
    const result=await options.check(request.paths);checkpoint();
    if(request.action==='save'){
      if(!usable(result))throw new Error('FFmpeg / ffprobe are unavailable or lack required encoders.');
      await options.save({ffmpeg:result.ffmpeg.path,ffprobe:result.ffprobe.path});checkpoint();
    }
    return result;
  }};
}
