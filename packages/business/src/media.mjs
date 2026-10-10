import {throwIfMediaAborted,interruptedMediaError} from './media-processes.mjs';
import {run} from './media-runtime.mjs';
import {parseProbeOutput,withProbePermit} from './media-probe.mjs';
import {stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
export {run};
function settledMediaValues(results,signal){const unconfirmed=results.find(result=>result.status==='rejected'&&result.reason?.terminationUnconfirmed);if(unconfirmed)throw unconfirmed.reason;throwIfMediaAborted(signal);const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;return results.map(result=>result.value);}
export async function probe(file,{signal,timeout}={}){return withProbePermit(signal,async()=>{const output=await run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{signal,timeout});throwIfMediaAborted(signal);return parseProbeOutput(output);});}
// Hash incrementally: long timeline exports must not be copied into JS memory.
export async function fileHash(file,{signal}={}){throwIfMediaAborted(signal);const hash=createHash('sha256'),stream=createReadStream(file);const abort=()=>stream.destroy(interruptedMediaError());signal?.addEventListener('abort',abort,{once:true});try{throwIfMediaAborted(signal);for await(const data of stream){throwIfMediaAborted(signal);hash.update(data);}throwIfMediaAborted(signal);return hash.digest('hex');}finally{signal?.removeEventListener('abort',abort);stream.destroy();}}
export async function fileInfo(file,{signal}={}){throwIfMediaAborted(signal);const s=await stat(file);throwIfMediaAborted(signal);const results=await Promise.allSettled([fileHash(file,{signal}),probe(file,{signal})]);const [sha256,p]=settledMediaValues(results,signal);return {sizeBytes:s.size,sha256,width:p.width,height:p.height,duration:p.duration,hasVideo:p.hasVideo,hasAudio:p.hasAudio};}
export async function safePath(root,relative){const base=await realpath(path.join(root,'media'));const target=await realpath(path.join(root,relative));if(!target.startsWith(base+path.sep))throw Error('Media path outside managed directory');return target;}
export async function stitch(files,destination,{signal}={}){
 throwIfMediaAborted(signal);
 const args=['-hide_banner','-loglevel','error','-y'];for(const f of files)args.push('-i',f);
 const results=await Promise.allSettled(files.map(file=>probe(file,{signal})));const metadata=settledMediaValues(results,signal),chains=[];
 files.forEach((_,i)=>{const duration=metadata[i].duration;if(!(duration>0))throw Error('Export input has no duration');chains.push(`[${i}:v]scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);const hasAudio=metadata[i].probe.streams.some(s=>s.codec_type==='audio');chains.push(hasAudio?`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`:`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`);});
 chains.push(files.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${files.length}:v=1:a=1[outv][outa]`);
 args.push('-filter_complex',chains.join(';'),'-map','[outv]','-map','[outa]','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',destination);await run('ffmpeg',args,{timeout:300000,signal});throwIfMediaAborted(signal);await probe(destination,{signal});throwIfMediaAborted(signal);
}
