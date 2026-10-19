import type {MediaToolDiagnostics} from '../../contracts/src/workspace-info.ts';
interface Options {execute(command:string,args:string[],options:{timeout:number;maxStdoutBytes:number;maxStderrBytes:number;signal?:AbortSignal}):Promise<unknown>;signal?:AbortSignal}
/** Only the trusted launcher chooses executable paths. HTTP callers can check
 * the configured runtime, but cannot supply a program or command arguments. */
export async function inspectMediaTools(paths:{ffmpeg:string;ffprobe:string},{execute,signal}:Options):Promise<MediaToolDiagnostics>{
  const interrupted=(error:unknown)=>Boolean(signal?.aborted||error&&typeof error==='object'&&'terminationUnconfirmed' in error&&error.terminationUnconfirmed===true);
  const run=async(command:string,args:string[])=>{signal?.throwIfAborted();const value=await execute(command,args,{timeout:10000,maxStdoutBytes:4*1024*1024,maxStderrBytes:1024*1024,...(signal?{signal}:{})});signal?.throwIfAborted();return typeof value==='string'?value:'';};
  const version=async(name:'ffmpeg'|'ffprobe')=>{try{const text=await run(paths[name],['-version']);const first=text.split(/\r?\n/u)[0]??'';return first.startsWith(`${name} version `)?first.slice(0,1024):null;}catch(error){if(interrupted(error))throw error;return null;}};
  const ffmpegVersion=await version('ffmpeg'),ffprobeVersion=await version('ffprobe');
  let encoders='',filters='';
  if(ffmpegVersion){try{encoders=await run(paths.ffmpeg,['-hide_banner','-encoders']);filters=await run(paths.ffmpeg,['-hide_banner','-filters']);}catch(error){if(interrupted(error))throw error;}}
  return {ffmpeg:{path:paths.ffmpeg,version:ffmpegVersion,available:ffmpegVersion!==null},ffprobe:{path:paths.ffprobe,version:ffprobeVersion,available:ffprobeVersion!==null},
    capabilities:{libx264:/\blibx264\b/u.test(encoders),aac:/\baac\b/u.test(encoders),drawtext:/\bdrawtext\b/u.test(filters),subtitles:/\bsubtitles\b/u.test(filters)}};
}
